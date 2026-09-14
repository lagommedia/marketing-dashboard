import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const BASE = "https://api.hubapi.com";

async function hubspotFetch(token: string, path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * GET /api/debug/sqo-meeting-types
 *
 * Queries HubSpot for ALL completed meetings in the current quarter
 * (no activity-type filter) and returns a tally of hs_activity_type values.
 * Use this to discover which meeting types exist so you can update the SQO lists.
 */
export async function GET() {
  try {
    const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
    if (!row?.accessToken) {
      return NextResponse.json({ error: "HubSpot not connected" }, { status: 400 });
    }
    const token = decrypt(row.accessToken);

    // Current quarter start
    const now   = new Date();
    const q     = Math.floor(now.getMonth() / 3);
    const qStart = new Date(now.getFullYear(), q * 3, 1);
    const fromTs = qStart.getTime();

    const typeCounts: Record<string, number> = {};
    let after: string | undefined;
    let total = 0;
    let pages = 0;

    do {
      const body: Record<string, unknown> = {
        filterGroups: [{
          filters: [
            { propertyName: "hs_timestamp",      operator: "GTE", value: String(fromTs) },
            { propertyName: "hs_meeting_outcome", operator: "EQ",  value: "COMPLETED"   },
          ],
        }],
        properties: ["hs_activity_type", "hs_meeting_outcome", "hs_timestamp"],
        limit: 100,
      };
      if (after) body.after = after;

      const res = await hubspotFetch(token, "/crm/v3/objects/meetings/search", body);
      pages++;

      for (const m of res.results ?? []) {
        const type = m.properties?.hs_activity_type ?? "(none)";
        typeCounts[type] = (typeCounts[type] ?? 0) + 1;
        total++;
      }

      after = res.paging?.next?.after;
      if (after) await new Promise(r => setTimeout(r, 250));

      // Safety cap — avoid runaway loops
      if (pages >= 50) break;
    } while (after);

    const sorted = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));

    return NextResponse.json({
      quarterStart:  qStart.toISOString().slice(0, 10),
      totalMeetings: total,
      pages,
      types: sorted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
