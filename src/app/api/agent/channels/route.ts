/**
 * GET /api/agent/channels?from=&to=
 *
 * Funnel and spend split by channel and by platform, for efficiency and
 * budget-allocation reads. Sourced from MetricSnapshot, which is the same
 * table the dashboard cards use — so these numbers reconcile with the UI.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkAgentAuth, dateRange, ratio } from "@/lib/agent-auth";

export const dynamic = "force-dynamic";

interface Agg {
  key: string;
  impressions: number; clicks: number; sessions: number;
  leads: number; mqls: number; sqos: number; closedWon: number;
  spend: number; revenue: number; pipeline: number;
}

function blank(key: string): Agg {
  return { key, impressions: 0, clicks: 0, sessions: 0, leads: 0, mqls: 0, sqos: 0, closedWon: 0, spend: 0, revenue: 0, pipeline: 0 };
}

export async function GET(req: NextRequest) {
  const denied = checkAgentAuth(req);
  if (denied) return denied;

  const { from, to, fromStr, toStr } = dateRange(req.nextUrl.searchParams, 90);

  const rows = await prisma.metricSnapshot.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: { date: "asc" },
  });

  const byChannel = new Map<string, Agg>();
  const byPlatform = new Map<string, Agg>();

  for (const r of rows) {
    // channel="all" and platform="all" rows are pre-aggregated totals living in
    // the same table. Skip them entirely so nothing is counted twice.
    if (r.channel === "all" || r.platform === "all") continue;

    const targets: Agg[] = [];

    const c = byChannel.get(r.channel) ?? blank(r.channel);
    byChannel.set(r.channel, c);
    targets.push(c);

    const p = byPlatform.get(r.platform) ?? blank(r.platform);
    byPlatform.set(r.platform, p);
    targets.push(p);

    for (const a of targets) {
      a.impressions += r.impressions ?? 0;
      a.clicks += r.clicks ?? 0;
      a.sessions += r.sessions ?? 0;
      a.leads += r.leads ?? 0;
      a.mqls += r.mqls ?? 0;
      a.sqos += r.sqos ?? 0;
      a.closedWon += r.closedWon ?? 0;
      a.spend += r.spend ?? 0;
      a.revenue += r.revenue ?? 0;
      a.pipeline += r.pipeline ?? 0;
    }
  }

  const decorate = (a: Agg) => ({
    ...a,
    rates: {
      ctr: ratio(a.clicks, a.impressions),
      leadToMql: ratio(a.mqls, a.leads),
      mqlToSqo: ratio(a.sqos, a.mqls),
      sqoToClosedWon: ratio(a.closedWon, a.sqos),
    },
    efficiency: {
      cpc: ratio(a.spend, a.clicks),
      costPerLead: ratio(a.spend, a.leads),
      costPerMql: ratio(a.spend, a.mqls),
      costPerSqo: ratio(a.spend, a.sqos),
      cac: ratio(a.spend, a.closedWon),
      returnPerDollar: ratio(a.revenue, a.spend),
      pipelinePerDollar: ratio(a.pipeline, a.spend),
    },
  });

  const channels = [...byChannel.values()].map(decorate).sort((a, b) => b.spend - a.spend);
  const platforms = [...byPlatform.values()].map(decorate).sort((a, b) => b.spend - a.spend);

  const totalSpend = channels.reduce((s, c) => s + c.spend, 0);
  const totalRevenue = channels.reduce((s, c) => s + c.revenue, 0);

  return NextResponse.json({
    ok: true,
    query: { from: fromStr, to: toStr },
    channels: channels.map((c) => ({ ...c, shareOfSpend: ratio(c.spend, totalSpend) })),
    platforms,
    totals: { spend: totalSpend, revenue: totalRevenue, returnPerDollar: ratio(totalRevenue, totalSpend) },
    notes: [
      "Channel rows exclude channel='all' and platform rows exclude platform='all' — those are pre-aggregated totals in the same table.",
      "returnPerDollar here is revenue booked in the window over spend in the window; it is not the attribution-weighted GTM efficiency figure (see /api/agent/pacing).",
    ],
  });
}
