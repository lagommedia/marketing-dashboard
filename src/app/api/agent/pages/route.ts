/**
 * GET /api/agent/pages?from=&to=&limit=100
 *
 * Landing-page performance: organic sessions, engagement, and conversions per
 * page from the GA4 sync, alongside the top Search Console queries for the
 * same window. Used for the website / landing-page audit.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkAgentAuth, dateRange, ratio } from "@/lib/agent-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = checkAgentAuth(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const { from, to, fromStr, toStr } = dateRange(sp, 90);
  const limit = Math.min(parseInt(sp.get("limit") ?? "100", 10) || 100, 1000);

  // Previous window of equal length, for period-over-period on every page
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86_400_000);

  const [cur, prev, queries] = await Promise.all([
    prisma.gaOrganicSnapshot.findMany({ where: { date: { gte: from, lte: to } } }),
    prisma.gaOrganicSnapshot.findMany({ where: { date: { gte: prevFrom, lte: prevTo } } }),
    prisma.gscQuerySnapshot.findMany({ where: { date: { gte: from, lte: to } } }),
  ]);

  interface P { pagePath: string; sessions: number; users: number; engagedSessions: number; conversions: number; bounceSum: number; durSum: number }
  const roll = (rows: typeof cur) => {
    const m = new Map<string, P>();
    for (const r of rows) {
      const p = m.get(r.pagePath) ?? { pagePath: r.pagePath, sessions: 0, users: 0, engagedSessions: 0, conversions: 0, bounceSum: 0, durSum: 0 };
      p.sessions += r.sessions;
      p.users += r.users;
      p.engagedSessions += r.engagedSessions;
      p.conversions += r.conversions;
      p.bounceSum += (r.bounceRate ?? 0) * r.sessions;
      p.durSum += (r.avgSessionSec ?? 0) * r.sessions;
      m.set(r.pagePath, p);
    }
    return m;
  };

  const curMap = roll(cur);
  const prevMap = roll(prev);

  const pages = [...curMap.values()]
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, limit)
    .map((p) => {
      const before = prevMap.get(p.pagePath);
      return {
        pagePath: p.pagePath,
        sessions: p.sessions,
        users: p.users,
        engagedSessions: p.engagedSessions,
        conversions: p.conversions,
        engagementRate: ratio(p.engagedSessions, p.sessions),
        conversionRate: ratio(p.conversions, p.sessions),
        avgBounceRate: p.sessions > 0 ? p.bounceSum / p.sessions : null,
        avgSessionSec: p.sessions > 0 ? p.durSum / p.sessions : null,
        prevSessions: before?.sessions ?? 0,
        sessionsDeltaPct: before && before.sessions > 0 ? (p.sessions - before.sessions) / before.sessions : null,
        prevConversions: before?.conversions ?? 0,
      };
    });

  const qMap = new Map<string, { query: string; clicks: number; impressions: number; posSum: number; n: number }>();
  for (const q of queries) {
    const e = qMap.get(q.query) ?? { query: q.query, clicks: 0, impressions: 0, posSum: 0, n: 0 };
    e.clicks += q.clicks;
    e.impressions += q.impressions;
    e.posSum += (q.position ?? 0) * q.impressions;
    e.n += q.impressions;
    qMap.set(q.query, e);
  }

  const topQueries = [...qMap.values()]
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, limit)
    .map((q) => ({
      query: q.query,
      clicks: q.clicks,
      impressions: q.impressions,
      ctr: ratio(q.clicks, q.impressions),
      avgPosition: q.n > 0 ? q.posSum / q.n : null,
    }));

  return NextResponse.json({
    ok: true,
    query: { from: fromStr, to: toStr, limit },
    comparedTo: { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) },
    pages,
    topQueries,
    notes: [
      "Pages are ORGANIC SEARCH sessions only — the GA4 sync filters to that channel. For paid landing pages use /api/agent/ga4 with dimensions=landingPagePlusQueryString,sessionDefaultChannelGroup.",
      "GSC data lags 2-3 days; the tail of the window will look artificially low.",
    ],
  });
}
