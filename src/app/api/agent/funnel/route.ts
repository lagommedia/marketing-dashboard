/**
 * GET /api/agent/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD&channel=all|paid|organic&granularity=week|month|total
 *
 * The core marketing-ops read: the full funnel per period, with stage-to-stage
 * conversion rates and spend-efficiency metrics already computed so the caller
 * cannot derive them inconsistently.
 *
 * Site visits: paid = Google Ads clicks, organic = GA4 organic sessions.
 * These are different units and are reported separately as well as combined.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkAgentAuth, dateRange, sum, ratio } from "@/lib/agent-auth";

export const dynamic = "force-dynamic";

type Grain = "week" | "month" | "total";

function bucketKey(d: Date, grain: Grain): string {
  if (grain === "total") return "total";
  if (grain === "month") return d.toISOString().slice(0, 7);
  // ISO week start (Monday), in UTC
  const x = new Date(d);
  const day = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - day);
  return x.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const denied = checkAgentAuth(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const { from, to, fromStr, toStr } = dateRange(sp, 90);
  const channel = (sp.get("channel") ?? "all") as "all" | "paid" | "organic";
  const grain = (sp.get("granularity") ?? "week") as Grain;

  const channelValue =
    channel === "paid" ? "paid_media" : channel === "organic" ? "organic" : "all";

  const [snapshots, gaRows, adRows] = await Promise.all([
    prisma.metricSnapshot.findMany({
      where: { date: { gte: from, lte: to }, channel: channelValue },
      orderBy: { date: "asc" },
    }),
    channel === "paid"
      ? Promise.resolve([])
      : prisma.gaOrganicSnapshot.findMany({
          where: { date: { gte: from, lte: to } },
          select: { date: true, sessions: true, conversions: true },
        }),
    channel === "organic"
      ? Promise.resolve([])
      : prisma.campaignDailySpend.findMany({
          where: { date: { gte: from, lte: to } },
          select: { date: true, clicks: true, impressions: true, spend: true },
        }),
  ]);

  interface Bucket {
    period: string;
    organicSessions: number;
    paidClicks: number;
    impressions: number;
    spend: number;
    leads: number;
    mqls: number;
    sqos: number;
    closedWon: number;
    revenue: number;
    pipeline: number;
  }

  const buckets = new Map<string, Bucket>();
  const get = (d: Date): Bucket => {
    const k = bucketKey(d, grain);
    let b = buckets.get(k);
    if (!b) {
      b = {
        period: k, organicSessions: 0, paidClicks: 0, impressions: 0, spend: 0,
        leads: 0, mqls: 0, sqos: 0, closedWon: 0, revenue: 0, pipeline: 0,
      };
      buckets.set(k, b);
    }
    return b;
  };

  for (const r of snapshots) {
    const b = get(r.date);
    b.leads += r.leads ?? 0;
    b.mqls += r.mqls ?? 0;
    b.sqos += r.sqos ?? 0;
    b.closedWon += r.closedWon ?? 0;
    b.revenue += r.revenue ?? 0;
    b.pipeline += r.pipeline ?? 0;
  }
  for (const r of gaRows) get(r.date).organicSessions += r.sessions;
  for (const r of adRows) {
    const b = get(r.date);
    b.paidClicks += r.clicks;
    b.impressions += r.impressions;
    b.spend += r.spend;
  }

  const periods = [...buckets.values()]
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((b) => {
      const visits = b.organicSessions + b.paidClicks;
      return {
        ...b,
        siteVisits: visits,
        rates: {
          visitToLead: ratio(b.leads, visits),
          leadToMql: ratio(b.mqls, b.leads),
          mqlToSqo: ratio(b.sqos, b.mqls),
          sqoToClosedWon: ratio(b.closedWon, b.sqos),
          visitToClosedWon: ratio(b.closedWon, visits),
        },
        efficiency: {
          costPerVisit: ratio(b.spend, visits),
          costPerLead: ratio(b.spend, b.leads),
          costPerMql: ratio(b.spend, b.mqls),
          costPerSqo: ratio(b.spend, b.sqos),
          costPerClosedWon: ratio(b.spend, b.closedWon),
          returnPerDollar: ratio(b.revenue, b.spend),
        },
      };
    });

  const t = {
    organicSessions: sum(periods.map((p) => p.organicSessions)),
    paidClicks: sum(periods.map((p) => p.paidClicks)),
    impressions: sum(periods.map((p) => p.impressions)),
    spend: sum(periods.map((p) => p.spend)),
    leads: sum(periods.map((p) => p.leads)),
    mqls: sum(periods.map((p) => p.mqls)),
    sqos: sum(periods.map((p) => p.sqos)),
    closedWon: sum(periods.map((p) => p.closedWon)),
    revenue: sum(periods.map((p) => p.revenue)),
    pipeline: sum(periods.map((p) => p.pipeline)),
  };
  const totalVisits = t.organicSessions + t.paidClicks;

  return NextResponse.json({
    ok: true,
    query: { from: fromStr, to: toStr, channel, granularity: grain },
    totals: {
      ...t,
      siteVisits: totalVisits,
      rates: {
        visitToLead: ratio(t.leads, totalVisits),
        leadToMql: ratio(t.mqls, t.leads),
        mqlToSqo: ratio(t.sqos, t.mqls),
        sqoToClosedWon: ratio(t.closedWon, t.sqos),
        visitToClosedWon: ratio(t.closedWon, totalVisits),
      },
      efficiency: {
        costPerLead: ratio(t.spend, t.leads),
        costPerMql: ratio(t.spend, t.mqls),
        costPerSqo: ratio(t.spend, t.sqos),
        costPerClosedWon: ratio(t.spend, t.closedWon),
        returnPerDollar: ratio(t.revenue, t.spend),
      },
    },
    periods,
    notes: [
      "siteVisits = GA4 organic sessions + Google Ads clicks. Different units, combined for a funnel top only.",
      "Stage counts reflect contacts' CURRENT lifecycle stage, so the most recent 2-3 weeks are provisional and will rise as records progress.",
      "spend covers Google Ads only; other paid platforms land in /api/agent/channels via MetricSnapshot.",
    ],
  });
}
