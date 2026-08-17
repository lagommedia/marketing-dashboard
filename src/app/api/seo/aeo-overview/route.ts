/**
 * GET /api/seo/aeo-overview
 *
 * Returns daily AI Overview impression/click totals from GSC.
 * GSC API constraint: searchAppearance cannot be combined with other dimensions,
 * so we can only provide aggregate daily counts — no per-query or per-pillar breakdown.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const from = new Date();
  from.setDate(from.getDate() - 90);
  from.setHours(0, 0, 0, 0);

  const rows = await prisma.gscAiOverviewDay.findMany({
    where:   { date: { gte: from } },
    orderBy: { date: "asc" },
    select:  { date: true, clicks: true, impressions: true, ctr: true },
  });

  const lastSyncedAt = await prisma.gscAiOverviewDay.findFirst({
    orderBy: { createdAt: "desc" },
    select:  { createdAt: true },
  });

  const totalImpressions = rows.reduce((s, r) => s + r.impressions, 0);
  const totalClicks      = rows.reduce((s, r) => s + r.clicks, 0);

  const weeklySeries = rows.map(r => ({
    date:        r.date.toISOString().slice(0, 10),
    impressions: r.impressions,
    clicks:      r.clicks,
    ctr:         r.ctr,
  }));

  return NextResponse.json({
    hasData:      rows.length > 0,
    lastSyncedAt: lastSyncedAt?.createdAt ?? null,
    totals:       { impressions: totalImpressions, clicks: totalClicks },
    weeklySeries,
    // keep legacy key for backward compat
    dailySeries:  weeklySeries,
  });
}
