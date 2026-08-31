/**
 * GET /api/paid-media/funnel/campaign?campaignId=xxx&campaignName=xxx
 *
 * Returns QTD HubSpot funnel metrics (Leads, MQLs, SQOs, Closed Won)
 * for a specific campaign, identified via utm_campaign on HubSpot contacts.
 *
 * We search for contacts whose utm_campaign property matches either the
 * campaign ID (raw Google Ads ID) or the campaign name (resolved name).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const BASE = "https://api.hubapi.com";

// Lifecycle stages that count as MQL-or-above
const MQL_STAGES = ["marketingqualifiedlead", "salesqualifiedlead", "114184284", "161312014", "opportunity", "customer"];
// Deal stage for Closed Won
const CLOSED_WON_STAGE = "closedwon";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hubFetch(token: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`HubSpot ${res.status}: ${t.slice(0, 200)}`); }
  return res.json();
}

async function countContacts(
  token: string,
  lifecycleStage: string,
  sinceTs: number,
  utmValues: string[]
): Promise<number> {
  if (utmValues.length === 0) return 0;
  try {
    const res = await hubFetch(token, "/crm/v3/objects/contacts/search", {
      filterGroups: utmValues.map(utm => ({
        filters: [
          { propertyName: "lifecyclestage", operator: "EQ",  value: lifecycleStage },
          { propertyName: "createdate",     operator: "GTE", value: String(sinceTs) },
          { propertyName: "utm_campaign",   operator: "EQ",  value: utm },
        ],
      })),
      properties: ["lifecyclestage"],
      limit: 1,
    });
    return res.total ?? 0;
  } catch {
    return 0;
  }
}

async function countMqls(token: string, sinceTs: number, utmValues: string[]): Promise<number> {
  if (utmValues.length === 0) return 0;
  try {
    const res = await hubFetch(token, "/crm/v3/objects/contacts/search", {
      filterGroups: utmValues.flatMap(utm =>
        MQL_STAGES.map(stage => ({
          filters: [
            { propertyName: "lifecyclestage", operator: "EQ",  value: stage },
            { propertyName: "createdate",     operator: "GTE", value: String(sinceTs) },
            { propertyName: "utm_campaign",   operator: "EQ",  value: utm },
          ],
        }))
      ),
      properties: ["lifecyclestage"],
      limit: 1,
    });
    return res.total ?? 0;
  } catch {
    return 0;
  }
}

async function countClosedWon(token: string, sinceTs: number, utmValues: string[]): Promise<number> {
  if (utmValues.length === 0) return 0;
  // We fetch closed won deals and join to contacts via associations, then filter by utm_campaign.
  // For simplicity, query contacts with utm_campaign who are also customers and joined recently.
  try {
    const res = await hubFetch(token, "/crm/v3/objects/contacts/search", {
      filterGroups: utmValues.map(utm => ({
        filters: [
          { propertyName: "lifecyclestage", operator: "EQ",  value: "customer" },
          { propertyName: "createdate",     operator: "GTE", value: String(sinceTs) },
          { propertyName: "utm_campaign",   operator: "EQ",  value: utm },
        ],
      })),
      properties: ["lifecyclestage"],
      limit: 1,
    });
    return res.total ?? 0;
  } catch {
    return 0;
  }
}

// Separately query closed-won deals (more accurate for closedWon count)
async function countClosedWonDeals(token: string, sinceTs: number): Promise<number> {
  try {
    const res = await hubFetch(token, "/crm/v3/objects/deals/search", {
      filterGroups: [{
        filters: [
          { propertyName: "dealstage", operator: "EQ",  value: CLOSED_WON_STAGE },
          { propertyName: "closedate", operator: "GTE", value: String(sinceTs) },
        ],
      }],
      limit: 1,
    });
    return res.total ?? 0;
  } catch {
    return 0;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const campaignId   = searchParams.get("campaignId")   ?? "";
  const campaignName = searchParams.get("campaignName") ?? "";

  if (!campaignId && !campaignName) {
    return NextResponse.json({ error: "campaignId or campaignName required" }, { status: 400 });
  }

  // Get HubSpot token
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return NextResponse.json({ connected: false, leads: null, mqls: null, sqos: null, closedWon: null });
  }

  let token: string;
  try { token = decrypt(row.accessToken); }
  catch { return NextResponse.json({ connected: false, leads: null, mqls: null, sqos: null, closedWon: null }); }

  // QTD start
  const now     = new Date();
  const year    = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3);
  const qtdStart = new Date(Date.UTC(year, quarter * 3, 1));
  const sinceTs  = qtdStart.getTime();

  // Build list of UTM values to search (deduplicated — could be ID or name)
  const utmValues = [...new Set([campaignId, campaignName].filter(Boolean))];

  // Parallel queries
  const [leads, mqls, sqos, closedWon] = await Promise.all([
    countContacts(token, "lead", sinceTs, utmValues),
    countMqls(token, sinceTs, utmValues),
    // SQOs: contacts in opportunity stage
    countContacts(token, "opportunity", sinceTs, utmValues),
    countClosedWon(token, sinceTs, utmValues),
  ]);

  return NextResponse.json({
    connected: true,
    qtdLabel:  `Q${quarter + 1} ${year}`,
    qtdStart:  qtdStart.toISOString().slice(0, 10),
    leads,
    mqls,
    sqos,
    closedWon,
    leadToMql:  leads > 0 ? mqls / leads : null,
    mqlToSqo:   mqls  > 0 ? sqos / mqls  : null,
    sqoToClose: sqos  > 0 ? closedWon / sqos : null,
  });
}
