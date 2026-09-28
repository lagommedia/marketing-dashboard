import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const HS_BASE = "https://api.hubapi.com";

interface HsContact {
  id: string;
  properties: Record<string, string | null>;
}

// Custom properties discovered for this HubSpot portal — replace the standard
// hs_analytics_source / hs_lifecyclestage_* fields entirely.
const SEARCH_PROPERTIES = [
  "became_an_mql_date",                    // custom "MQL Date" (type: date)
  "mql_source",                            // custom "MQL Source" (enumeration)
  "mql_source_details_1",                  // custom "MQL Source Details 1" — keyword
  "mql_source_details_2",                  // custom "MQL Source Details 2" — network/detail
  "hs_v2_date_entered_salesqualifiedlead", // pipeline "Date entered Sales Qualified Lead"
];

function classifySource(src: string): "paid" | "organic" | "other" {
  const s = src.toLowerCase();
  if (/paid|cpc|ppc|sem|adwords|google ads|bing ads/.test(s)) return "paid";
  if (/organic|seo|search(?! ad)|content|blog|referral|social(?! paid)/.test(s)) return "organic";
  return "other";
}

async function fetchMqlContacts(token: string, from: string, to: string): Promise<HsContact[]> {
  const toMs   = new Date(to   + "T23:59:59").getTime();
  const fromMs = new Date(from + "T00:00:00").getTime();

  const all: HsContact[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "became_an_mql_date", operator: "GTE", value: String(fromMs) },
          { propertyName: "became_an_mql_date", operator: "LTE", value: String(toMs) },
        ],
      }],
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
      // If became_an_mql_date is not filterable, fall back to createdate + client filter
      if (res.status === 400 && text.includes("became_an_mql_date")) {
        return fetchMqlContactsViaCreatedate(token, from, to);
      }
      throw new Error(`HubSpot contacts ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    all.push(...(data.results ?? []));
    after = data.paging?.next?.after ?? undefined;

  } while (after && all.length < 5000);

  return all;
}

// Fallback: filter by createdate with 18-month lookback, then filter client-side
// on became_an_mql_date if the property isn't filterable via search.
async function fetchMqlContactsViaCreatedate(
  token: string, from: string, to: string,
): Promise<HsContact[]> {
  const toMs      = new Date(to   + "T23:59:59").getTime();
  const fromMs    = new Date(from + "T00:00:00").getTime();
  const lookbackMs = fromMs - 18 * 30 * 24 * 60 * 60 * 1000;

  const all: HsContact[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "createdate", operator: "GTE", value: String(lookbackMs) },
          { propertyName: "createdate", operator: "LTE", value: String(toMs) },
        ],
      }],
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
      throw new Error(`HubSpot contacts ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    all.push(...(data.results ?? []));
    after = data.paging?.next?.after ?? undefined;

  } while (after && all.length < 5000);

  // Client-side filter: only contacts whose MQL date is in [from, to]
  return all.filter(c => {
    const d = c.properties.became_an_mql_date;
    if (!d) return false;
    const ms = new Date(d).getTime();
    return ms >= fromMs && ms <= toMs;
  });
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

    type SourceGroup = {
      source:  string;
      label:   string;
      type:    "paid" | "organic" | "other";
      mqls:    number;
      sqos:    number;
      detail:  Map<string, number>;
    };

    const groups   = new Map<string, SourceGroup>();
    type KwGroup   = { keyword: string; network: string | null; mqls: number; sqos: number };
    const kwGroups = new Map<string, KwGroup>();

    for (const c of contacts) {
      const p       = c.properties;
      const src     = p.mql_source ?? "UNKNOWN";
      const srcType = classifySource(src);
      const mqlDate = p.became_an_mql_date;
      const sqoDate = p.hs_v2_date_entered_salesqualifiedlead;
      const isSqo   = sqoDate != null && mqlDate != null && new Date(sqoDate) > new Date(mqlDate);

      if (!groups.has(src)) {
        groups.set(src, { source: src, label: src || "Unknown", type: srcType, mqls: 0, sqos: 0, detail: new Map() });
      }
      const g = groups.get(src)!;
      g.mqls++;
      if (isSqo) g.sqos++;

      // topDetail: keyword (details_1) per source
      const detailKey = p.mql_source_details_1?.trim() || null;
      if (detailKey) g.detail.set(detailKey, (g.detail.get(detailKey) ?? 0) + 1);

      // Keyword-level breakdown for paid contacts
      if (srcType === "paid") {
        const raw     = p.mql_source_details_1?.trim() || null;
        const keyword = raw && raw !== "(not provided)" && raw !== "not provided" ? raw : "(unknown keyword)";
        const network = p.mql_source_details_2?.trim() || null;
        if (!kwGroups.has(keyword)) {
          kwGroups.set(keyword, { keyword, network, mqls: 0, sqos: 0 });
        }
        const kw = kwGroups.get(keyword)!;
        kw.mqls++;
        if (isSqo) kw.sqos++;
      }
    }

    const rows = [...groups.values()]
      .sort((a, b) => b.mqls - a.mqls)
      .map(g => ({
        source:    g.source,
        label:     g.label,
        type:      g.type,
        mqls:      g.mqls,
        sqos:      g.sqos,
        convRate:  g.mqls > 0 ? g.sqos / g.mqls : 0,
        topDetail: [...g.detail.entries()]
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
