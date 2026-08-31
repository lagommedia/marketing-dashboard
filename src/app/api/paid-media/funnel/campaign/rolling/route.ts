/**
 * GET /api/paid-media/funnel/campaign/rolling
 *
 * Returns per-period HubSpot funnel counts (Leads, MQLs, SQOs, Closed Won)
 * for a specific campaign, bucketed into caller-supplied date ranges.
 *
 * Query params:
 *   campaignId   – Google Ads campaign ID
 *   campaignName – Google Ads campaign name (OR-matched with campaignId)
 *   ranges       – comma-separated "startDate~endDate" pairs (ISO dates), newest first
 *
 * Response:
 *   { connected: bool, data: { [startDate]: { leads, mqls, sqos, closedWon } } }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const BASE = "https://api.hubapi.com";

const STAGE_RANK: Record<string, number> = {
  lead:                    1,
  marketingqualifiedlead:  2,
  salesqualifiedlead:      3,
  "114184284":             3,
  "161312014":             3,
  opportunity:             4,
  customer:                5,
};

async function fetchAllContacts(
  token: string,
  utmValues: string[],
  sinceTs: number,
  untilTs: number,
): Promise<Array<{ lifecyclestage: string; createdate: number }>> {
  const contacts: Array<{ lifecyclestage: string; createdate: number }> = [];
  let after: string | undefined;

  for (let page = 0; page < 10; page++) {
    const body: Record<string, unknown> = {
      filterGroups: utmValues.map(utm => ({
        filters: [
          { propertyName: "utm_campaign", operator: "EQ",  value: utm },
          { propertyName: "createdate",   operator: "GTE", value: String(sinceTs) },
          { propertyName: "createdate",   operator: "LTE", value: String(untilTs) },
        ],
      })),
      properties: ["lifecyclestage", "createdate"],
      limit: 200,
    };
    if (after) body.after = after;

    const res = await fetch(`${BASE}/crm/v3/objects/contacts/search`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    if (!res.ok) break;
    const json = await res.json();

    for (const c of json.results ?? []) {
      const ts = parseInt(c.properties?.createdate ?? "0", 10);
      if (ts > 0) {
        contacts.push({
          lifecyclestage: c.properties?.lifecyclestage ?? "lead",
          createdate:     ts,
        });
      }
    }

    if (!json.paging?.next?.after) break;
    after = json.paging.next.after;
  }

  return contacts;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const campaignId   = searchParams.get("campaignId")   ?? "";
  const campaignName = searchParams.get("campaignName") ?? "";
  const rangesParam  = searchParams.get("ranges")       ?? "";

  if (!campaignId && !campaignName) {
    return NextResponse.json({ error: "campaignId or campaignName required" }, { status: 400 });
  }

  const ranges = rangesParam.split(",")
    .map(r => { const [start, end] = r.split("~"); return { start, end }; })
    .filter(r => r.start && r.end);

  if (ranges.length === 0) {
    return NextResponse.json({ connected: false, data: {} });
  }

  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return NextResponse.json({ connected: false, data: {} });
  }

  let token: string;
  try { token = decrypt(row.accessToken); }
  catch { return NextResponse.json({ connected: false, data: {} }); }

  const utmValues = [...new Set([campaignId, campaignName].filter(Boolean))];

  // Determine overall date bounds (ranges are newest-first)
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  const sinceTs = new Date(sorted[0].start + "T00:00:00Z").getTime();
  const untilTs = new Date(sorted[sorted.length - 1].end + "T23:59:59Z").getTime();

  const contacts = await fetchAllContacts(token, utmValues, sinceTs, untilTs);

  const data: Record<string, { leads: number; mqls: number; sqos: number; closedWon: number }> = {};

  for (const contact of contacts) {
    const contactDateStr = new Date(contact.createdate).toISOString().slice(0, 10);
    const match = sorted.find(r => contactDateStr >= r.start && contactDateStr <= r.end);
    if (!match) continue;

    const key = match.start;
    if (!data[key]) data[key] = { leads: 0, mqls: 0, sqos: 0, closedWon: 0 };

    const rank = STAGE_RANK[contact.lifecyclestage] ?? 1;
    data[key].leads++;
    if (rank >= 2) data[key].mqls++;
    if (rank >= 4) data[key].sqos++;
    if (rank >= 5) data[key].closedWon++;
  }

  return NextResponse.json({ connected: true, data });
}
