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
  properties: Record<string, string | null>;
}

async function fetchMqlContacts(token: string, fromMs: number, toMs: number): Promise<HsContact[]> {
  const all: HsContact[] = [];
  let after: string | undefined;

  const properties = [
    "hs_analytics_source",
    "hs_analytics_source_data_1",
    "hs_analytics_source_data_2",
    "hs_lifecyclestage_marketingqualifiedlead_date",
    "hs_lifecyclestage_salesqualifiedlead_date",
  ];

  do {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            { propertyName: "hs_lifecyclestage_marketingqualifiedlead_date", operator: "GTE", value: String(fromMs) },
            { propertyName: "hs_lifecyclestage_marketingqualifiedlead_date", operator: "LTE", value: String(toMs)   },
          ],
        },
      ],
      properties,
      limit: 200,
      sorts: [{ propertyName: "hs_lifecyclestage_marketingqualifiedlead_date", direction: "DESCENDING" }],
    };
    if (after) body.after = after;

    const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      // Include full body so 400 validation errors are debuggable
      throw new Error(`HubSpot contacts ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    all.push(...(data.results ?? []));
    after = data.paging?.next?.after ?? undefined;

    // Cap at 1 000 contacts to stay within reasonable API usage
  } while (after && all.length < 1000);

  return all;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to   = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  const fromMs = new Date(from + "T00:00:00").getTime();
  const toMs   = new Date(to   + "T23:59:59").getTime();

  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return NextResponse.json({ error: "HubSpot not connected" }, { status: 503 });
  }
  const token = decrypt(row.accessToken);

  try {
    const contacts = await fetchMqlContacts(token, fromMs, toMs);

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
        // top 5 detail values
        topDetail:   [...g.detail.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([label, count]) => ({ label, count })),
      }));

    return NextResponse.json({ from, to, total: contacts.length, rows });
  } catch (err) {
    console.error("[funnel/attribution]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
