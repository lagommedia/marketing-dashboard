/**
 * Discovery endpoint — NOT for production use.
 *
 * Finds the 5 most recent closed-won Paid Search deals, fetches their
 * associated contacts, then returns every contact property whose internal
 * name or value looks UTM / campaign related.
 *
 * Visit: GET /api/debug/hubspot-contact-utms
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

const BASE = "https://api.hubapi.com";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hs(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HubSpot ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

// Keywords used to filter which properties to surface
const UTM_KEYWORDS = [
  "utm", "campaign", "source", "medium", "term", "content",
  "gclid", "fbclid", "touch", "converting", "adgroup", "ad_group",
  "landing", "keyword", "extension",
];

function isUtmRelated(key: string): boolean {
  const lower = key.toLowerCase();
  return UTM_KEYWORDS.some((kw) => lower.includes(kw));
}

export async function GET() {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.accessToken) {
    return NextResponse.json({ error: "HubSpot not connected" }, { status: 400 });
  }
  const token = decrypt(row.accessToken);

  // ── Step 1: Find 5 recent closed-won Inbound / Paid Search deals ──────────
  const dealSearch = await hs(token, "POST", "/crm/v3/objects/deals/search", {
    filterGroups: [{
      filters: [
        { propertyName: "dealstage",         operator: "EQ", value: "closedwon"  },
        { propertyName: "deal_source",       operator: "EQ", value: "Inbound"    },
        { propertyName: "deal_source_detail_1", operator: "EQ", value: "Paid Search" },
      ],
    }],
    properties: ["dealname", "amount", "closedate", "deal_source_detail_1"],
    sorts: [{ propertyName: "closedate", direction: "DESCENDING" }],
    limit: 5,
  });

  const deals = dealSearch.results ?? [];
  if (deals.length === 0) {
    return NextResponse.json({
      message: "No closed-won Paid Search deals found — try broadening the filter",
      deals: [],
    });
  }

  // ── Step 2: Get associated contact IDs for each deal ─────────────────────
  const dealIds: string[] = deals.map((d: { id: string }) => d.id);

  const assocRes = await hs(token, "POST", "/crm/v4/associations/deal/contact/batch/read", {
    inputs: dealIds.map((id) => ({ id })),
  });

  const contactIdSet = new Set<string>();
  for (const result of assocRes.results ?? []) {
    for (const assoc of result.to ?? []) {
      contactIdSet.add(String(assoc.toObjectId ?? assoc.id));
    }
  }

  const contactIds = [...contactIdSet].slice(0, 10); // cap at 10 contacts

  if (contactIds.length === 0) {
    return NextResponse.json({
      message: "Deals found but no associated contacts — check HubSpot deal-contact associations",
      deals: deals.map((d: { id: string; properties: Record<string, string> }) => ({
        id: d.id,
        name: d.properties.dealname,
        amount: d.properties.amount,
        closedate: d.properties.closedate,
      })),
      contacts: [],
    });
  }

  // ── Step 3: Batch-read contacts with ALL properties ───────────────────────
  // First fetch the full property list so we know every internal name
  const propsRes = await hs(token, "GET", "/crm/v3/properties/contacts?limit=1000");
  const allPropNames: string[] = (propsRes.results ?? []).map(
    (p: { name: string }) => p.name
  );

  // Filter to UTM/campaign-related properties only for the contact read
  const utmPropNames = allPropNames.filter(isUtmRelated);

  // Batch-read contact records
  const contactRes = await hs(token, "POST", "/crm/v3/objects/contacts/batch/read", {
    inputs: contactIds.map((id) => ({ id })),
    properties: utmPropNames.length > 0 ? utmPropNames : ["email", "firstname", "lastname"],
  });

  // ── Step 4: Shape the response ────────────────────────────────────────────
  const contacts = (contactRes.results ?? []).map((c: {
    id: string;
    properties: Record<string, string | null>;
  }) => {
    // Only include properties that have a non-null, non-empty value
    const populated: Record<string, string> = {};
    for (const [key, val] of Object.entries(c.properties)) {
      if (val && val !== "") populated[key] = val;
    }
    return { contactId: c.id, populatedUtmProperties: populated };
  });

  return NextResponse.json({
    summary: {
      dealsFound: deals.length,
      contactsFound: contacts.length,
      totalUtmPropertiesChecked: utmPropNames.length,
      utmPropertyNames: utmPropNames, // full list of UTM-related property internal names
    },
    contacts,
  });
}
