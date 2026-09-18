import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") ?? new Date(new Date().getFullYear(), Math.floor(new Date().getMonth() / 3) * 3, 1).toISOString().slice(0, 10);
  const to   = searchParams.get("to")   ?? new Date().toISOString().slice(0, 10);

  const fromDate = new Date(from);
  const toEnd    = new Date(to);
  toEnd.setHours(23, 59, 59, 999);

  // Count rows per channel + platform
  const breakdown = await prisma.metricSnapshot.groupBy({
    by:    ["channel", "platform"],
    where: { date: { gte: fromDate, lte: toEnd } },
    _count: { _all: true },
    _sum:   { leads: true, mqls: true, sqos: true, closedWon: true },
  });

  // Sample the most recent row for each channel to see raw values
  const channels = ["all", "paid_media", "organic", "referral"];
  const samples = await Promise.all(
    channels.map(ch =>
      prisma.metricSnapshot.findFirst({
        where:   { date: { gte: fromDate, lte: toEnd }, channel: ch, platform: "hubspot" },
        orderBy: { date: "desc" },
        select:  { date: true, channel: true, platform: true, leads: true, mqls: true, sqos: true, closedWon: true },
      })
    )
  );

  return NextResponse.json({
    dateRange:  { from, to },
    breakdown:  breakdown.map(r => ({
      channel:  r.channel,
      platform: r.platform,
      rows:     r._count._all,
      totals: { leads: r._sum.leads, mqls: r._sum.mqls, sqos: r._sum.sqos, closedWon: r._sum.closedWon },
    })),
    latestHubspotRows: samples.filter(Boolean),
  });
}
