import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const BASE = "https://api.hubapi.com";

const LIFECYCLE_MQL_STAGES = ["marketingqualifiedlead", "salesqualifiedlead", "opportunity", "customer"];
const CLOSED_WON_STAGE = "closedwon";

// All meeting types that count as SQOs (must stay in sync with hubspot.ts constants)
const SQO_MEETING_TYPES = [
  // Events → organic
  "Zeni Overview - Events",
  "Zeni Overview - Events BDR",
  "Zeni Overview - Events AE",
  "Zeni Overview - Events Partnerships",
  // Referral
  "Zeni Overview - Customer Referral",
  "Zeni Overview - Employee Referral",
  "Zeni Overview - Inbound VC Referral",
  // Inbound / Outbound / Partnerships (channel from deal attribution)
  "Zeni Overview - Inbound",
  "Zeni Overview - Inbound Partnerships",
  "Partner: Inbound Consultation",
  "Partner: Consultation",
  "Inbound Follow Up",
  "Inbound Product Tour",
  "Zeni Overview - Outbound BDR",
  "Zeni Overview - Outbound AE",
  "Zeni Overview - Enterprise Outbound BDR",
  "Zeni Overview - AE Self Set BDR Spiff",
  "Zeni Overview - Partnerships",
  "Zeni Overview - Partnerships AE Self Set",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hsFetch(token: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const metric = searchParams.get("metric"); // mqls | sqos | closedwon
  const from   = searchParams.get("from");   // YYYY-MM-DD
  const to     = searchParams.get("to");     // YYYY-MM-DD

  if (!metric || !from || !to) {
    return NextResponse.json({ error: "metric, from, to required" }, { status: 400 });
  }

  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return NextResponse.json({ error: "HubSpot not connected" }, { status: 503 });
  }

  const token    = decrypt(row.accessToken);
  const portalId = row.accountId ?? "";

  const fromTs = new Date(from + "T00:00:00Z").getTime();
  const toTs   = new Date(to   + "T23:59:59Z").getTime();

  try {
    // ── MQLs: contacts created in range with lifecycle stage >= MQL ─────────
    if (metric === "mqls") {
      const res = await hsFetch(token, "/crm/v3/objects/contacts/search", {
        filterGroups: LIFECYCLE_MQL_STAGES.map(stage => ({
          filters: [
            { propertyName: "createdate",     operator: "GTE", value: String(fromTs) },
            { propertyName: "createdate",     operator: "LTE", value: String(toTs)   },
            { propertyName: "lifecyclestage", operator: "EQ",  value: stage          },
          ],
        })),
        properties: ["firstname", "lastname", "email"],
        sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
        limit: 100,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contacts = (res.results ?? []).map((c: any) => {
        const p = c.properties ?? {};
        const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || "Unknown";
        return { name, url: `https://app.hubspot.com/contacts/${portalId}/contact/${c.id}` };
      });

      return NextResponse.json({ contacts });
    }

    // ── SQOs: completed demo meetings in range → show associated contacts ─────
    if (metric === "sqos") {
      // 1. Fetch completed meetings of any SQO type in the date range
      const meetingRes = await hsFetch(token, "/crm/v3/objects/meetings/search", {
        filterGroups: [{
          filters: [
            { propertyName: "hs_timestamp",      operator: "GTE", value: String(fromTs)    },
            { propertyName: "hs_timestamp",      operator: "LTE", value: String(toTs)      },
            { propertyName: "hs_meeting_outcome", operator: "EQ",  value: "COMPLETED"      },
            { propertyName: "hs_activity_type",   operator: "IN",  values: SQO_MEETING_TYPES },
          ],
        }],
        properties: ["hs_activity_type", "hs_timestamp"],
        sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
        limit: 100,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meetings: any[] = meetingRes.results ?? [];
      if (meetings.length === 0) return NextResponse.json({ contacts: [] });

      const meetingIds: string[] = meetings.map((m: { id: string }) => m.id);

      // 2. Batch-read meeting → contact associations
      const assocRes = await hsFetch(
        token,
        "/crm/v3/associations/meetings/contacts/batch/read",
        { inputs: meetingIds.map((id) => ({ id })) }
      );

      // Build meetingId → first contactId map
      const meetingToContact = new Map<string, string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const item of assocRes.results ?? [] as any[]) {
        const toIds: string[] = (item.to ?? []).map((t: { id: string }) => t.id);
        if (toIds.length > 0) meetingToContact.set(String(item.from.id), toIds[0]);
      }

      const uniqueContactIds = [...new Set(meetingToContact.values())];

      // 3. Batch-read contact names
      const contactMap = new Map<string, { name: string }>();
      if (uniqueContactIds.length > 0) {
        const contactRes = await hsFetch(token, "/crm/v3/objects/contacts/batch/read", {
          inputs:     uniqueContactIds.map((id) => ({ id })),
          properties: ["firstname", "lastname", "email"],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const c of contactRes.results ?? [] as any[]) {
          const p = c.properties ?? {};
          const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || "Unknown";
          contactMap.set(String(c.id), { name });
        }
      }

      // 4. Build output — one entry per meeting
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contacts = meetings.map((m: any) => {
        const contactId = meetingToContact.get(m.id);
        const contact   = contactId ? contactMap.get(contactId) : undefined;
        const name      = contact?.name ?? "(No contact linked)";
        const type      = m.properties?.hs_activity_type ?? "";
        const label     = type ? `${name} · ${type}` : name;
        const url       = contactId
          ? `https://app.hubspot.com/contacts/${portalId}/contact/${contactId}`
          : `https://app.hubspot.com/contacts/${portalId}/objects/0-47/views/all/list`;
        return { name: label, url };
      });

      return NextResponse.json({ contacts });
    }

    // ── Closed Won: deals closed in range ───────────────────────────────────
    if (metric === "closedwon") {
      const res = await hsFetch(token, "/crm/v3/objects/deals/search", {
        filterGroups: [{
          filters: [
            { propertyName: "closedate",  operator: "GTE", value: String(fromTs)       },
            { propertyName: "closedate",  operator: "LTE", value: String(toTs)         },
            { propertyName: "dealstage",  operator: "EQ",  value: CLOSED_WON_STAGE     },
          ],
        }],
        properties: ["dealname", "amount"],
        sorts: [{ propertyName: "closedate", direction: "ASCENDING" }],
        limit: 100,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contacts = (res.results ?? []).map((d: any) => {
        const p = d.properties ?? {};
        const amt = p.amount
          ? ` — $${parseFloat(p.amount).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
          : "";
        return {
          name: (p.dealname || "Unnamed Deal") + amt,
          url: `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`,
        };
      });

      return NextResponse.json({ contacts });
    }

    return NextResponse.json({ error: "Invalid metric" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "HubSpot fetch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
