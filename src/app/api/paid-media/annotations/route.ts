/**
 * GET  /api/paid-media/annotations?from=YYYY-MM-DD&to=YYYY-MM-DD&campaignId=...
 *   Returns stored change events, grouped by date, optionally filtered to a campaign.
 *
 * POST /api/paid-media/annotations/sync
 *   Triggers a fresh pull from the Google Ads change history API.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { syncChangeHistory } from "@/lib/integrations/google-ads";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET — fetch stored annotations
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fromStr      = searchParams.get("from");
  const toStr        = searchParams.get("to");
  const campaignId   = searchParams.get("campaignId") ?? null;

  const from = fromStr ? new Date(fromStr + "T00:00:00Z") : new Date(Date.now() - 31 * 86400_000);
  const to   = toStr   ? new Date(toStr   + "T23:59:59Z") : new Date();

  const where: Record<string, unknown> = {
    changedAt: { gte: from, lte: to },
  };
  if (campaignId) {
    where.OR = [
      { campaignId },
      { campaignId: null }, // account-wide events have no campaign
    ];
  }

  const events = await prisma.campaignChangeEvent.findMany({
    where,
    orderBy: { changedAt: "asc" },
    select: {
      id: true,
      changedAt: true,
      changeResourceType: true,
      operation: true,
      campaignId: true,
      campaignName: true,
      userEmail: true,
      description: true,
    },
  });

  // Group by calendar date (YYYY-MM-DD)
  const byDate: Record<string, {
    date: string;
    events: typeof events;
    campaignIds: string[];
  }> = {};

  for (const ev of events) {
    const dateKey = ev.changedAt.toISOString().slice(0, 10);
    if (!byDate[dateKey]) byDate[dateKey] = { date: dateKey, events: [], campaignIds: [] };
    byDate[dateKey].events.push(ev);
    if (ev.campaignId && !byDate[dateKey].campaignIds.includes(ev.campaignId)) {
      byDate[dateKey].campaignIds.push(ev.campaignId);
    }
  }

  return NextResponse.json({
    annotations: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
    total: events.length,
  });
}

// ---------------------------------------------------------------------------
// POST — trigger sync
// ---------------------------------------------------------------------------

export async function POST() {
  try {
    const result = await syncChangeHistory();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[annotations] sync failed:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
