import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const HS_BASE = "https://api.hubapi.com";

interface HsContact {
  id: string;
  properties: Record<string, string | null>;
}

// Custom properties for this HubSpot portal.
const SEARCH_PROPERTIES = [
  "became_an_mql_date",
  "mql_source",
  "mql_source_details_1",
  "mql_source_details_2",
  "hs_v2_date_entered_salesqualifiedlead",
  "hs_v2_date_entered_customer",
];

function classifySource(src: string): "paid" | "organic" | "other" {
  const s = src.toLowerCase();
  if (/paid|cpc|ppc|sem|adwords|google ads|bing ads/.test(s)) return "paid";
  if (/organic|seo|search(?! ad)|content|blog|referral|social(?! paid)/.test(s)) return "organic";
  return "other";
}

// Known source/platform names that appear in details fields but are not search keywords.
const PLATFORM_NAMES = new Set([
  "linkedin", "facebook", "instagram", "twitter", "x", "youtube",
  "tiktok", "pinterest", "snapchat", "reddit", "quora", "google",
  "bing", "yelp", "direct", "email", "offline",
]);

// Returns true if the string looks like a campaign/tracking identifier or
// system label rather than a human search query.
function isTrackingIdentifier(s: string): boolean {
  if (!s) return true;
  if (/^https?:\/\/|^www\./i.test(s)) return true;                           // URL
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return true;                    // UUID
  if (/^\d+$/.test(s)) return true;                                           // pure number
  if (/_/.test(s) && !/ /.test(s)) return true;                              // snake_case
  if (/auto.?tagged/i.test(s)) return true;                                   // HubSpot label
  if (/^unknown\b/i.test(s)) return true;                                     // "Unknown keywords (SSL)" etc.
  if (/^[a-z0-9]+(-[a-z0-9]+){3,}$/i.test(s) && s.length > 20) return true; // long kebab-case ID
  if (PLATFORM_NAMES.has(s.toLowerCase())) return true;                       // source/platform name
  return false;
}

// Resolves the "real" search keyword and campaign name from the two detail fields.
// details_1 can be either a campaign name (snake_case) or the keyword itself;
// details_2 is the complementary field. We prefer the natural-language value as
// the keyword and the tracking-identifier value as the campaign label.
function resolveKeywordAndCampaign(
  d1: string | null,
  d2: string | null,
): { keyword: string; campaign: string | null } {
  const s1 = d1?.trim() || null;
  const s2 = d2?.trim() || null;

  const s1IsTracking = !s1 || isTrackingIdentifier(s1);
  const s2IsTracking = !s2 || isTrackingIdentifier(s2);

  if (s1IsTracking && s2IsTracking) return { keyword: "(unknown keyword)", campaign: s1 };
  if (s1IsTracking && !s2IsTracking) return { keyword: s2!, campaign: s1 };
  if (!s1IsTracking && s2IsTracking) return { keyword: s1!, campaign: null };
  // Both look like natural language — prefer d1, include d2 only if different
  return { keyword: s1!, campaign: s2 !== s1 ? s2 : null };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Wraps a single HubSpot search page with retry-on-429 and a pacing delay.
// HubSpot's OAuth CRM search limit is 5 req/sec; 220ms between pages keeps
// us safely under that when paginating through large contact sets.
async function hsSearchPage(
  token: string,
  body: Record<string, unknown>,
  attempt = 0,
): Promise<{ results: HsContact[]; paging?: { next?: { after: string } } }> {
  const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const wait = Math.min(1500 * 2 ** attempt, 12000);
    await sleep(wait);
    return hsSearchPage(token, body, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot contacts ${res.status}: ${text.slice(0, 500)}`);
  }

  return res.json();
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

    let data: Awaited<ReturnType<typeof hsSearchPage>>;
    try {
      data = await hsSearchPage(token, body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("HubSpot contacts 400") && msg.includes("became_an_mql_date")) {
        return fetchMqlContactsViaCreatedate(token, from, to);
      }
      throw err;
    }

    all.push(...(data.results ?? []));
    after = data.paging?.next?.after ?? undefined;
    if (after) await sleep(220); // pace to ~4.5 pages/sec, well under the 5/sec limit

  } while (after && all.length < 5000);

  return all;
}

async function fetchMqlContactsViaCreatedate(
  token: string, from: string, to: string,
): Promise<HsContact[]> {
  const toMs       = new Date(to   + "T23:59:59").getTime();
  const fromMs     = new Date(from + "T00:00:00").getTime();
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

    const data = await hsSearchPage(token, body);
    all.push(...(data.results ?? []));
    after = data.paging?.next?.after ?? undefined;
    if (after) await sleep(220);

  } while (after && all.length < 5000);

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
      source:     string;
      label:      string;
      type:       "paid" | "organic" | "other";
      mqls:       number;
      sqos:       number;
      closedWon:  number;
      detail:     Map<string, number>;
    };

    const groups   = new Map<string, SourceGroup>();

    type KwGroup = {
      keyword:   string;
      campaign:  string | null;
      mqls:      number;
      sqos:      number;
      closedWon: number;
    };
    const kwGroups    = new Map<string, KwGroup>(); // paid
    const orgKwGroups = new Map<string, KwGroup>(); // organic

    for (const c of contacts) {
      const p        = c.properties;
      const src      = p.mql_source ?? "UNKNOWN";
      const srcType  = classifySource(src);
      const mqlDate  = p.became_an_mql_date;
      const sqoDate  = p.hs_v2_date_entered_salesqualifiedlead;
      const cwDate   = p.hs_v2_date_entered_customer;
      const isSqo    = sqoDate != null && mqlDate != null && new Date(sqoDate) >= new Date(mqlDate);
      const isCw     = cwDate  != null && mqlDate != null && new Date(cwDate)  >= new Date(mqlDate);

      if (!groups.has(src)) {
        groups.set(src, {
          source: src, label: src || "Unknown", type: srcType,
          mqls: 0, sqos: 0, closedWon: 0, detail: new Map(),
        });
      }
      const g = groups.get(src)!;
      g.mqls++;
      if (isSqo) g.sqos++;
      if (isCw)  g.closedWon++;

      const { keyword, campaign } = resolveKeywordAndCampaign(
        p.mql_source_details_1 ?? null,
        p.mql_source_details_2 ?? null,
      );
      const detailKey = keyword !== "(unknown keyword)" ? keyword : null;
      if (detailKey) g.detail.set(detailKey, (g.detail.get(detailKey) ?? 0) + 1);

      const targetMap = srcType === "paid" ? kwGroups : srcType === "organic" ? orgKwGroups : null;
      if (targetMap) {
        // Normalize to lowercase so "zeni" and "Zeni" are the same bucket.
        const kwKey = keyword.toLowerCase();
        if (!targetMap.has(kwKey)) {
          targetMap.set(kwKey, { keyword: kwKey, campaign, mqls: 0, sqos: 0, closedWon: 0 });
        }
        const kw = targetMap.get(kwKey)!;
        kw.mqls++;
        if (isSqo) kw.sqos++;
        if (isCw)  kw.closedWon++;
      }
    }

    const rows = [...groups.values()]
      .sort((a, b) => b.mqls - a.mqls)
      .map(g => ({
        source:        g.source,
        label:         g.label,
        type:          g.type,
        mqls:          g.mqls,
        sqos:          g.sqos,
        closedWon:     g.closedWon,
        convRate:      g.mqls > 0 ? g.sqos / g.mqls : 0,
        closedWonRate: g.mqls > 0 ? g.closedWon / g.mqls : 0,
        topDetail:     [...g.detail.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([label, count]) => ({ label, count })),
      }));

    const serializeKw = (map: Map<string, KwGroup>) =>
      [...map.values()]
        .sort((a, b) => {
          const aUnk = a.keyword === "(unknown keyword)";
          const bUnk = b.keyword === "(unknown keyword)";
          if (aUnk !== bUnk) return aUnk ? 1 : -1;
          return b.mqls - a.mqls;
        })
        .map(kw => ({
          keyword:   kw.keyword,
          campaign:  kw.campaign,
          mqls:      kw.mqls,
          sqos:      kw.sqos,
          closedWon: kw.closedWon,
          mqlToSqo:  kw.mqls > 0 ? kw.sqos       / kw.mqls : 0,
          mqlToCw:   kw.mqls > 0 ? kw.closedWon   / kw.mqls : 0,
        }));

    const paidKeywords    = serializeKw(kwGroups);
    const organicKeywords = serializeKw(orgKwGroups);

    return NextResponse.json({ from, to, total: contacts.length, rows, paidKeywords, organicKeywords });
  } catch (err) {
    console.error("[funnel/attribution]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
