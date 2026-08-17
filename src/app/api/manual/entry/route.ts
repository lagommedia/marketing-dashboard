/**
 * POST /api/manual/entry
 *
 * Saves manually-entered metric totals for a date range, distributing them
 * evenly across each day. Writes platform="manual" snapshots so they can
 * be cleared independently of API-synced data.
 *
 * Body:
 *   from                  YYYY-MM-DD
 *   to                    YYYY-MM-DD
 *   paid_impressions?     number  (total for period)
 *   paid_clicks?          number
 *   paid_spend?           number
 *   organic_impressions?  number
 *   organic_clicks?       number
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      from: fromStr,
      to:   toStr,
      paid_impressions,
      paid_clicks,
      paid_spend,
      organic_impressions,
      organic_clicks,
    } = body as Record<string, string | number | undefined>;

    if (!fromStr || !toStr) {
      return NextResponse.json({ error: "from and to dates are required" }, { status: 400 });
    }

    // Build list of days in range (inclusive)
    const days: Date[] = [];
    const cursor = new Date(`${fromStr}T00:00:00`);
    const end    = new Date(`${toStr}T00:00:00`);
    while (cursor <= end) {
      days.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }

    if (days.length === 0) {
      return NextResponse.json({ error: "Date range produced no days" }, { status: 400 });
    }

    const n = days.length;

    // Helper: parse numeric input, return null if not provided / zero
    const num = (v: string | number | undefined) => {
      const parsed = v !== undefined && v !== "" ? Number(v) : NaN;
      return isNaN(parsed) ? null : parsed;
    };

    const paidImpressions = num(paid_impressions);
    const paidClicks      = num(paid_clicks);
    const paidSpend       = num(paid_spend);
    const orgImpressions  = num(organic_impressions);
    const orgClicks       = num(organic_clicks);

    // Daily slices (floor each day, add remainder to last day)
    const slice = (total: number | null, i: number) => {
      if (total === null) return null;
      const daily = total / n;
      // Give the last day any leftover from rounding
      if (i === n - 1) {
        return total - Math.floor(daily) * (n - 1);
      }
      return Math.floor(daily);
    };

    let snapshots = 0;

    for (let i = 0; i < days.length; i++) {
      const dateKey = days[i];

      // ── Paid Media ──────────────────────────────────────────────────────────
      const dPaidImp   = slice(paidImpressions, i);
      const dPaidClk   = slice(paidClicks, i);
      const dPaidSpend = paidSpend !== null ? parseFloat((paidSpend / n).toFixed(2)) : null;
      // Last day: absorb rounding residual for spend
      const dPaidSpendFinal = i === n - 1 && paidSpend !== null
        ? parseFloat((paidSpend - parseFloat((paidSpend / n).toFixed(2)) * (n - 1)).toFixed(2))
        : dPaidSpend;

      const hasPaid = dPaidImp !== null || dPaidClk !== null || dPaidSpendFinal !== null;
      if (hasPaid) {
        const ctr = dPaidImp && dPaidClk ? dPaidClk / dPaidImp : null;
        const cpc = dPaidClk && dPaidSpendFinal ? dPaidSpendFinal / dPaidClk : null;
        const data = {
          impressions: dPaidImp,
          clicks:      dPaidClk,
          spend:       dPaidSpendFinal,
          ctr,
          cpc,
        };
        await prisma.metricSnapshot.upsert({
          where: { date_platform_channel: { date: dateKey, platform: "manual", channel: "paid_media" } },
          create: { date: dateKey, platform: "manual", channel: "paid_media", ...data },
          update: data,
        });
        snapshots++;
      }

      // ── Organic ─────────────────────────────────────────────────────────────
      const dOrgImp = slice(orgImpressions, i);
      const dOrgClk = slice(orgClicks, i);

      const hasOrganic = dOrgImp !== null || dOrgClk !== null;
      if (hasOrganic) {
        const ctr = dOrgImp && dOrgClk ? dOrgClk / dOrgImp : null;
        const data = { impressions: dOrgImp, clicks: dOrgClk, ctr };
        await prisma.metricSnapshot.upsert({
          where: { date_platform_channel: { date: dateKey, platform: "manual", channel: "organic" } },
          create: { date: dateKey, platform: "manual", channel: "organic", ...data },
          update: data,
        });
        snapshots++;
      }
    }

    return NextResponse.json({ ok: true, days: days.length, snapshots });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/manual/entry?from=YYYY-MM-DD&to=YYYY-MM-DD&channel=paid_media|organic|all */
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const fromStr  = searchParams.get("from");
    const toStr    = searchParams.get("to");
    const channel  = searchParams.get("channel") ?? "all";

    if (!fromStr || !toStr) {
      return NextResponse.json({ error: "from and to are required query params" }, { status: 400 });
    }

    const from = new Date(`${fromStr}T00:00:00`);
    const to   = new Date(`${toStr}T23:59:59`);

    const channelFilter = channel === "all"
      ? {}
      : { channel };

    const { count } = await prisma.metricSnapshot.deleteMany({
      where: {
        platform: "manual",
        date: { gte: from, lte: to },
        ...channelFilter,
      },
    });

    return NextResponse.json({ ok: true, deleted: count });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
