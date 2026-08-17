/**
 * GET /api/seo/organic-traffic?days=90
 *
 * Returns organic traffic summary from GA4 for the SEO page:
 *   - totals: sessions, users, engagedSessions, avgBounceRate, avgSessionSec, conversions
 *   - topPages: top 20 landing pages by sessions
 *   - hasData: boolean
 *   - lastSyncedAt: ISO string or null
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp   = req.nextUrl.searchParams;
    const days = parseInt(sp.get("days") ?? "90", 10);

    const from = new Date();
    from.setDate(from.getDate() - days);
    from.setHours(0, 0, 0, 0);

    // Check integration status
    const integration = await prisma.integration.findUnique({
      where: { platform: "google_analytics" },
      select: { connected: true, lastSyncedAt: true },
    });

    const rows = await prisma.gaOrganicSnapshot.findMany({
      where: { date: { gte: from } },
      orderBy: { date: "desc" },
    });

    if (rows.length === 0) {
      return NextResponse.json({
        hasData:     false,
        connected:   integration?.connected ?? false,
        lastSyncedAt: integration?.lastSyncedAt?.toISOString() ?? null,
        totals:      { sessions: 0, users: 0, engagedSessions: 0, avgBounceRate: null, avgSessionSec: null, conversions: 0 },
        topPages:    [],
      });
    }

    // Aggregate totals
    const totals = rows.reduce(
      (acc, r) => ({
        sessions:        acc.sessions        + r.sessions,
        users:           acc.users           + r.users,
        engagedSessions: acc.engagedSessions + r.engagedSessions,
        conversions:     acc.conversions     + r.conversions,
        bounceSum:       acc.bounceSum       + (r.bounceRate ?? 0) * r.sessions,
        sessionSecSum:   acc.sessionSecSum   + (r.avgSessionSec ?? 0) * r.sessions,
      }),
      { sessions: 0, users: 0, engagedSessions: 0, conversions: 0, bounceSum: 0, sessionSecSum: 0 }
    );

    // Per-page aggregation for top pages table
    const pageMap = new Map<string, {
      sessions: number; users: number; engagedSessions: number;
      conversions: number; bounceSum: number; sessionSecSum: number;
    }>();

    for (const r of rows) {
      const prev = pageMap.get(r.pagePath) ?? { sessions: 0, users: 0, engagedSessions: 0, conversions: 0, bounceSum: 0, sessionSecSum: 0 };
      pageMap.set(r.pagePath, {
        sessions:        prev.sessions        + r.sessions,
        users:           prev.users           + r.users,
        engagedSessions: prev.engagedSessions + r.engagedSessions,
        conversions:     prev.conversions     + r.conversions,
        bounceSum:       prev.bounceSum       + (r.bounceRate ?? 0) * r.sessions,
        sessionSecSum:   prev.sessionSecSum   + (r.avgSessionSec ?? 0) * r.sessions,
      });
    }

    const topPages = [...pageMap.entries()]
      .map(([pagePath, agg]) => ({
        pagePath,
        sessions:        agg.sessions,
        users:           agg.users,
        engagedSessions: agg.engagedSessions,
        conversions:     agg.conversions,
        bounceRate:      agg.sessions > 0 ? agg.bounceSum / agg.sessions : null,
        avgSessionSec:   agg.sessions > 0 ? agg.sessionSecSum / agg.sessions : null,
      }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 20);

    // Daily series for sparklines — aggregate rows by date
    const dayMap = new Map<string, { sessions: number; users: number; engagedSessions: number; conversions: number; bounceSum: number; sessionSecSum: number }>();
    for (const r of rows) {
      const key  = r.date.toISOString().slice(0, 10);
      const prev = dayMap.get(key) ?? { sessions: 0, users: 0, engagedSessions: 0, conversions: 0, bounceSum: 0, sessionSecSum: 0 };
      prev.sessions        += r.sessions;
      prev.users           += r.users;
      prev.engagedSessions += r.engagedSessions;
      prev.conversions     += r.conversions;
      prev.bounceSum       += (r.bounceRate   ?? 0) * r.sessions;
      prev.sessionSecSum   += (r.avgSessionSec ?? 0) * r.sessions;
      dayMap.set(key, prev);
    }
    const dailySeries = [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({
        date,
        sessions:        d.sessions,
        users:           d.users,
        engagedSessions: d.engagedSessions,
        conversions:     d.conversions,
        avgBounceRate:   d.sessions > 0 ? d.bounceSum      / d.sessions : null,
        avgSessionSec:   d.sessions > 0 ? d.sessionSecSum  / d.sessions : null,
      }));

    return NextResponse.json({
      hasData:     true,
      connected:   integration?.connected ?? false,
      lastSyncedAt: integration?.lastSyncedAt?.toISOString() ?? null,
      totals: {
        sessions:        totals.sessions,
        users:           totals.users,
        engagedSessions: totals.engagedSessions,
        conversions:     totals.conversions,
        avgBounceRate:   totals.sessions > 0 ? totals.bounceSum / totals.sessions : null,
        avgSessionSec:   totals.sessions > 0 ? totals.sessionSecSum / totals.sessions : null,
      },
      dailySeries,
      topPages,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[seo:organic-traffic]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
