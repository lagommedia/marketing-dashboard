import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const HS_BASE = "https://api.hubapi.com";

// HubSpot source → human-readable label + paid/organic classification
const SOURCE_META: Record<string, { label: string; type: "paid" | "organic" | "other" }> = {
  PAID_SEARCH:       { label: "Paid Search",       type: "paid"    },
  PAID_SOCIAL:       { label: "Paid Social",        type: "paid"    },
  OTHER_CAMPAIGNS:   { label: "Other Paid",         type: "paid"    },
  ORGANIC_SEARCH:    { label: "Organic Search",     type: "organic" },
  SOCIAL_MEDIA:      { label: "Social (Organic)",   type: "organic" },
  BLOG:              { label: "Blog",               type: "organic" },
  REFERRALS:         { label: "Referral",           type: "organic" },
  EMAIL_MARKETING:   { label: "Email",              type: "other"   },
  DIRECT_TRAFFIC:    { label: "Direct",             type: "other"   },
  OFFLINE:           { label: "Offline",            type: "other"   },
};

interface HsContact {
  id: string;
  properties: Record<string, string | null>;
}

// Search-safe properties (no hs_analytics_source_data_* — those are not
// indexable on this portal and cause a 400 in the search endpoint).
const SEARCH_PROPERTIES = [
  "hs_analytics_source",
  "hs_lifecyclestage_marketingqualifiedlead_date",
  "hs_lifecyclestage_salesqualifiedlead_date",
];

// Extra properties fetched via batch-read for PAID_SEARCH contacts only.
const KEYWORD_PROPERTIES = ["hs_analytics_source_data_1", "hs_analytics_source_data_2"];

// Probe the contacts search API with a minimal known-good request to confirm
// API access works, then return a diagnostic string if it also fails.
async function probeContactsSearch(token: string): Promise<string> {
  const body = {
    filterGroups: [
      { filters: [{ propertyName: "createdate", operator: "GTE", value: "0" }] },
    ],
    properties: ["createdate"],
    limit: 1,
  };
  const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return "probe:OK";
  const txt = await res.text();
  return `probe:${res.status} ${txt.slice(0, 200)}`;
}

async function fetchMqlContacts(token: string, from: string, to: string): Promise<HsContact[]> {
  const all: HsContact[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            { propertyName: "hs_lifecyclestage_marketingqualifiedlead_date", operator: "GTE", value: from },
            { propertyName: "hs_lifecyclestage_marketingqualifiedlead_date", operator: "LTE", value: to   },
          ],
        },
      ],
      properties: SEARCH_PROPERTIES,
      limit: 100,
    };
    if (after) body.after = after;

    const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      const probe = await probeContactsSearch(token);
      throw new Error(
        `HubSpot contacts ${res.status}: ${text.slice(0, 500)} | sent: ${JSON.stringify(body).slice(0, 400)} | ${probe}`,
      );
    }

    const data = await res.json();
    all.push(...(data.results ?? []));
    after = data.paging?.next?.after ?? undefined;

  } while (after && all.length < 1000);

  return all;
}

// Batch-read keyword properties for a subset of contact IDs.
// Uses the CRM v3 batch read endpoint which supports all properties.
async function enrichWithKeywordProps(
  token: string,
  contacts: HsContact[],
): Promise<void> {
  if (contacts.length === 0) return;

  // Process in chunks of 100 (API limit)
  const ids = contacts.map((c) => c.id);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/batch/read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: KEYWORD_PROPERTIES,
        inputs: chunk.map((id) => ({ id })),
      }),
    });

    if (!res.ok) continue; // best-effort — don't fail the whole request

    const data = await res.json();
    const byId = new Map<string, Record<string, string | null>>(
      (data.results ?? []).map((r: { id: string; properties: Record<string, string | null> }) => [r.id, r.properties]),
    );

    for (let j = i; j < Math.min(i + 100, contacts.length); j++) {
      const c = contacts[j];
      const extra = byId.get(c.id);
      if (extra) {
        c.properties.hs_analytics_source_data_1 = extra.hs_analytics_source_data_1 ?? null;
        c.properties.hs_analytics_source_data_2 = extra.hs_analytics_source_data_2 ?? null;
      }
    }
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to   = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return NextResponse.json({ error: "HubSpot not connected" }, { status: 503 });
  }
  const token = decrypt(row.accessToken);

  try {
    const contacts = await fetchMqlContacts(token, from, to);

    // Enrich PAID_SEARCH contacts with keyword properties via batch read
    const paidContacts = contacts.filter(c => c.properties.hs_analytics_source === "PAID_SEARCH");
    await enrichWithKeywordProps(token, paidContacts);

    // Aggregate by source
    type SourceGroup = {
      source:     string;
      label:      string;
      type:       "paid" | "organic" | "other";
      mqls:       number;
      sqos:       number;
      // campaign/keyword detail: label → count
      detail:     Map<string, number>;
    };

    const groups = new Map<string, SourceGroup>();

    // Paid keyword breakdown: data_2 = search keyword, data_1 = network (google/bing)
    type KwGroup = { keyword: string; network: string | null; mqls: number; sqos: number };
    const kwGroups = new Map<string, KwGroup>();

    for (const c of contacts) {
      const p      = c.properties;
      const src    = p.hs_analytics_source ?? "UNKNOWN";
      const meta   = SOURCE_META[src] ?? { label: src || "Unknown", type: "other" as const };
      const detail = [p.hs_analytics_source_data_1, p.hs_analytics_source_data_2]
        .filter(Boolean)
        .join(" / ") || null;

      const mqlDate = p.hs_lifecyclestage_marketingqualifiedlead_date;
      const sqoDate = p.hs_lifecyclestage_salesqualifiedlead_date;
      const isSqo   = sqoDate != null && mqlDate != null && new Date(sqoDate) > new Date(mqlDate);

      if (!groups.has(src)) {
        groups.set(src, { source: src, label: meta.label, type: meta.type, mqls: 0, sqos: 0, detail: new Map() });
      }
      const g = groups.get(src)!;
      g.mqls++;
      if (isSqo) g.sqos++;
      if (detail) g.detail.set(detail, (g.detail.get(detail) ?? 0) + 1);

      // Keyword-level breakdown for paid search contacts
      if (src === "PAID_SEARCH") {
        const raw     = p.hs_analytics_source_data_2?.trim() || null;
        const keyword = raw && raw !== "(not provided)" && raw !== "not provided" ? raw : "(unknown keyword)";
        const network = p.hs_analytics_source_data_1?.trim() || null;
        if (!kwGroups.has(keyword)) {
          kwGroups.set(keyword, { keyword, network, mqls: 0, sqos: 0 });
        }
        const kw = kwGroups.get(keyword)!;
        kw.mqls++;
        if (isSqo) kw.sqos++;
      }
    }

    // Serialize — sort by MQL count desc
    const rows = [...groups.values()]
      .sort((a, b) => b.mqls - a.mqls)
      .map(g => ({
        source:      g.source,
        label:       g.label,
        type:        g.type,
        mqls:        g.mqls,
        sqos:        g.sqos,
        convRate:    g.mqls > 0 ? g.sqos / g.mqls : 0,
        topDetail:   [...g.detail.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([label, count]) => ({ label, count })),
      }));

    const paidKeywords = [...kwGroups.values()]
      .sort((a, b) => b.mqls - a.mqls)
      .map(kw => ({
        keyword:  kw.keyword,
        network:  kw.network,
        mqls:     kw.mqls,
        sqos:     kw.sqos,
        mqlToSqo: kw.mqls > 0 ? kw.sqos / kw.mqls : 0,
      }));

    return NextResponse.json({ from, to, total: contacts.length, rows, paidKeywords });
  } catch (err) {
    console.error("[funnel/attribution]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
