/**
 * GET  /api/paid-media/annotations?from=YYYY-MM-DD&to=YYYY-MM-DD&campaignId=...
 *   Returns stored change events, grouped by date, optionally filtered to a campaign.
 *
 * POST /api/paid-media/annotations
 *   Creates a manual change-log entry.
 *   Body: { date, campaignId?, campaignName?, description, expectedOutcome? }
 *
 * DELETE /api/paid-media/annotations?id=...
 *   Deletes a change-log entry by its DB id.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET — fetch stored annotations
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fromStr    = searchParams.get("from");
  const toStr      = searchParams.get("to");
  const campaignId = searchParams.get("campaignId") ?? null;

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
      expectedOutcome: true,
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
// POST — create a manual change-log entry
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { date, campaignId, campaignName, description, expectedOutcome } = body as {
      date:            string;
      campaignId?:     string | null;
      campaignName?:   string | null;
      description:     string;
      expectedOutcome?: string | null;
    };

    if (!date || !description?.trim()) {
      return NextResponse.json({ ok: false, error: "date and description are required" }, { status: 400 });
    }

    // Store at noon UTC so timezone display is stable
    const changedAt = new Date(date + "T12:00:00Z");

    const entry = await prisma.campaignChangeEvent.create({
      data: {
        googleResourceName: `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        changedAt,
        changeResourceType: "MANUAL",
        operation:          "UPDATE",
        campaignId:         campaignId   ?? null,
        campaignName:       campaignName ?? null,
        userEmail:          "manual",
        description:        description.trim(),
        expectedOutcome:    expectedOutcome?.trim() ?? null,
      },
    });

    return NextResponse.json({ ok: true, id: entry.id });
  } catch (err) {
    console.error("[annotations] create failed:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE — remove a manual entry
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  try {
    await prisma.campaignChangeEvent.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
