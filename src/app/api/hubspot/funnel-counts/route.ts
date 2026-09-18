import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from    = searchParams.get("from");
  const to      = searchParams.get("to");
  const channel = (searchParams.get("channel") ?? "all") as "all" | "paid" | "organic";

  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  try {
    const fromDate = new Date(from);
    const toEnd    = new Date(to);
    toEnd.setHours(23, 59, 59, 999);

    // ── Site visits ──────────────────────────────────────────────────────────
    // Paid: Google Ads clicks (each click = one paid site visit)
    // Organic: GA4 sessions (organic search channel)
    let paidVisits    = 0;
    let organicVisits = 0;

    if (channel === "all" || channel === "paid") {
      const paidRows = await prisma.campaignDailySpend.findMany({
        where:  { date: { gte: fromDate, lte: toEnd } },
        select: { clicks: true },
      });
      paidVisits = paidRows.reduce((s, r) => s + r.clicks, 0);
    }

    if (channel === "all" || channel === "organic") {
      const gaRows = await prisma.gaOrganicSnapshot.findMany({
        where:  { date: { gte: fromDate, lte: toEnd } },
        select: { sessions: true },
      });
      organicVisits = gaRows.reduce((s, r) => s + r.sessions, 0);
    }

    const siteVisits = paidVisits + organicVisits;

    // ── Funnel counts (channel-filtered) ─────────────────────────────────────
    // Mirror the logic in /api/metrics/trend: filter by channel only (no platform
    // restriction) so HubSpot rows tagged paid_media / organic are included.
    const channelValue =
      channel === "paid"    ? "paid_media" :
      channel === "organic" ? "organic"    : "all";

    const rows = await prisma.metricSnapshot.findMany({
      where: {
        date:    { gte: fromDate, lte: toEnd },
        channel: channelValue,
      },
    });

    const sum = (key: "leads" | "mqls" | "sqos" | "closedWon") =>
      rows.reduce((acc, r) => acc + ((r[key] as number | null) ?? 0), 0);

    return NextResponse.json({
      siteVisits,
      paidVisits,
      organicVisits,
      leads:     sum("leads"),
      mqls:      sum("mqls"),
      sqls:      0,
      sqos:      sum("sqos"),
      sqds:      0,
      closedWon: sum("closedWon"),
    });
  } catch (e) {
    console.error("[funnel-counts]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
