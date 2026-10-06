/**
 * GET /api/funnel/channel-funnel
 *
 * Returns HubSpot funnel-stage counts (Leads, MQLs, SQOs, Closed Won)
 * broken down by channel (hs_analytics_source on contacts, deal_source on deals).
 *
 * Leads / MQLs / SQOs — contacts created in [from, to]:
 *   - Leads: any lifecycle stage
 *   - MQLs:  lifecyclestage = marketingqualifiedlead
 *   - SQOs:  lifecyclestage = opportunity
 *   All three carry hs_analytics_source directly on the contact record.
 *
 * Closed Won — deals with closedate in [from, to] and dealstage = closedwon.
 *   Attributed via deal_source + deal_source_detail_1 (same mapping as the sync).
 *
 * Note: SQO counts here are contact-lifecycle-based, not meeting-based, so they
 * may differ slightly from the main funnel table (which counts completed demo meetings).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const BASE = "https://api.hubapi.com";

// hs_analytics_source → display label
const SOURCE_LABEL: Record<string, string> = {
  ORGANIC_SEARCH:   "Organic Search",
  PAID_SEARCH:      "Paid Search",
  DIRECT_TRAFFIC:   "Direct",
  SOCIAL_MEDIA:     "Organic Social",
  PAID_SOCIAL:      "Paid Social",
  EMAIL_MARKETING:  "Email",
  REFERRALS:        "Referral",
  OTHER_CAMPAIGNS:  "Other Campaigns",
  AI_REFERRALS:     "AI Assistant",
  OFFLINE:          "Offline",
};

const LIFECYCLE_OPPORTUNITY = "opportunity";
const LIFECYCLE_MQL         = "marketingqualifiedlead";
const CLOSED_WON_STAGE      = "closedwon";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hsFetch(token: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function labelSource(raw: string | null | undefined): string {
  if (!raw) return "(not set)";
  return SOURCE_LABEL[raw] ?? raw.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Paginate HubSpot contacts search, accumulating hs_analytics_source counts.
 * stageValues = null → all contacts; otherwise OR across provided lifecycle stages.
 */
async function contactSourceCounts(
  token: string,
  fromTs: number,
  toTs: number,
  stageValues: string[] | null,
): Promise<Record<string, number>> {
  const dateFilters = [
    { propertyName: "createdate", operator: "GTE", value: String(fromTs) },
    { propertyName: "createdate", operator: "LTE", value: String(toTs)   },
  ];

  const filterGroups = stageValues
    ? stageValues.map(v => ({
        filters: [...dateFilters, { propertyName: "lifecyclestage", operator: "EQ", value: v }],
      }))
    : [{ filters: dateFilters }];

  const counts: Record<string, number> = {};
  let after: string | undefined;

  for (let page = 0; page < 100; page++) {
    const body: Record<string, unknown> = {
      filterGroups,
      properties: ["hs_analytics_source"],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hsFetch(token, "/crm/v3/objects/contacts/search", body);
    for (const c of (res.results ?? [])) {
      const label = labelSource(c.properties?.hs_analytics_source);
      counts[label] = (counts[label] ?? 0) + 1;
    }

    after = res.paging?.next?.after;
    if (!after) break;
  }

  return counts;
}

/**
 * Paginate HubSpot deals (Closed Won in date range), accumulating channel counts
 * from deal_source + deal_source_detail_1.
 */
async function dealSourceCounts(
  token: string,
  fromTs: number,
  toTs: number,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let after: string | undefined;

  for (let page = 0; page < 100; page++) {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "closedate", operator: "GTE", value: String(fromTs)   },
          { propertyName: "closedate", operator: "LTE", value: String(toTs)     },
          { propertyName: "dealstage", operator: "EQ",  value: CLOSED_WON_STAGE },
        ],
      }],
      properties: ["deal_source", "deal_source_detail_1"],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hsFetch(token, "/crm/v3/objects/deals/search", body);
    for (const d of (res.results ?? [])) {
      const src    = (d.properties?.deal_source ?? "") as string;
      const detail = (d.properties?.deal_source_detail_1 ?? "") as string;

      let label: string;
      if (src === "Inbound") {
        const lc = detail.toLowerCase();
        if (lc.includes("paid search"))  label = "Paid Search";
        else if (lc.includes("paid social")) label = "Paid Social";
        else if (lc.includes("paid"))    label = "Paid Search/Social";
        else if (lc === "direct traffic") label = "Direct";
        else if (detail)                 label = detail;
        else                             label = "Inbound";
      } else if (src === "Events") {
        label = "Events";
      } else if (src === "Referral") {
        label = "Referral";
      } else if (src) {
        label = src;
      } else {
        label = "(not set)";
      }

      counts[label] = (counts[label] ?? 0) + 1;
    }

    after = res.paging?.next?.after;
    if (!after) break;
  }

  return counts;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to   = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  const hsRow = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!hsRow?.connected || !hsRow.accessToken) {
    return NextResponse.json({ error: "HubSpot not connected" }, { status: 409 });
  }

  const token  = decrypt(hsRow.accessToken);
  const fromTs = new Date(from).getTime();
  const toTs   = new Date(`${to}T23:59:59.999Z`).getTime();

  try {
    const [leadSrcs, mqlSrcs, sqoSrcs, cwSrcs] = await Promise.all([
      contactSourceCounts(token, fromTs, toTs, null),
      contactSourceCounts(token, fromTs, toTs, [LIFECYCLE_MQL]),
      contactSourceCounts(token, fromTs, toTs, [LIFECYCLE_OPPORTUNITY]),
      dealSourceCounts(token, fromTs, toTs),
    ]);

    return NextResponse.json({
      leads:     leadSrcs,
      mqls:      mqlSrcs,
      sqos:      sqoSrcs,
      closedWon: cwSrcs,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 502 }
    );
  }
}
