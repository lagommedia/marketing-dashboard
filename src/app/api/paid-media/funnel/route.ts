/**
 * GET /api/paid-media/funnel
 *
 * Returns QTD HubSpot funnel metrics (Leads, MQLs, SQOs, Closed Won)
 * for the paid_media channel, along with prior-quarter comparison.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function quarterBounds(year: number, q: number) {
  const start = new Date(Date.UTC(year, q * 3, 1));
  const end   = new Date(Date.UTC(year, q * 3 + 3, 0, 23, 59, 59, 999));
  return { start, end };
}

export async function GET() {
  const now     = new Date();
  const year    = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3);

  const cur  = quarterBounds(year, quarter);
  const prevQ = quarter === 0 ? 3 : quarter - 1;
  const prevY = quarter === 0 ? year - 1 : year;
  const prev = quarterBounds(prevY, prevQ);

  const [curRows, prevRows] = await Promise.all([
    prisma.metricSnapshot.findMany({
      where: { platform: "hubspot", channel: "paid_media", date: { gte: cur.start, lte: now } },
      select: { leads: true, mqls: true, sqos: true, closedWon: true },
    }),
    prisma.metricSnapshot.findMany({
      where: { platform: "hubspot", channel: "paid_media", date: { gte: prev.start, lte: prev.end } },
      select: { leads: true, mqls: true, sqos: true, closedWon: true },
    }),
  ]);

  function sum(rows: typeof curRows, field: "leads" | "mqls" | "sqos" | "closedWon") {
    const vals = rows.map(r => r[field]).filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) : null;
  }

  function rates(leads: number | null, mqls: number | null, sqos: number | null, closedWon: number | null) {
    return {
      leadToMql:  leads != null && mqls      != null && leads > 0 ? mqls      / leads : null,
      mqlToSqo:   mqls  != null && sqos      != null && mqls  > 0 ? sqos      / mqls  : null,
      sqoToClose: sqos  != null && closedWon != null && sqos  > 0 ? closedWon / sqos  : null,
    };
  }

  const curLeads     = sum(curRows, "leads");
  const curMqls      = sum(curRows, "mqls");
  const curSqos      = sum(curRows, "sqos");
  const curClosedWon = sum(curRows, "closedWon");

  const prevLeads     = sum(prevRows, "leads");
  const prevMqls      = sum(prevRows, "mqls");
  const prevSqos      = sum(prevRows, "sqos");
  const prevClosedWon = sum(prevRows, "closedWon");

  return NextResponse.json({
    qtdStart:  cur.start.toISOString().slice(0, 10),
    qtdLabel:  `Q${quarter + 1} ${year}`,
    prevLabel: `Q${prevQ + 1} ${prevY}`,
    current: {
      leads: curLeads, mqls: curMqls, sqos: curSqos, closedWon: curClosedWon,
      ...rates(curLeads, curMqls, curSqos, curClosedWon),
    },
    prior: {
      leads: prevLeads, mqls: prevMqls, sqos: prevSqos, closedWon: prevClosedWon,
      ...rates(prevLeads, prevMqls, prevSqos, prevClosedWon),
    },
  });
}
