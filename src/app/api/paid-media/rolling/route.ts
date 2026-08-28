/**
 * GET /api/paid-media/rolling?view=daily|weekly&campaignId=all|{id}
 *
 * Returns 12 rolling periods of Google Ads campaign data.
 *
 * daily   — last 12 occurrences of the anchor day-of-week (defaults to yesterday)
 * weekly  — last 12 ISO weeks ending on or before the anchor date
 *
 * Each response includes:
 *   rows        — the 12 periods, newest first
 *   avg12       — average across all 12 rows
 *   wowDelta    — most-recent minus the period before it (raw + pct)
 *   avg12Delta  — most-recent minus avg12 (raw + pct)
 *   campaigns   — list of all campaigns available (for the selector UI)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RollingRow {
  label:          string; // "8/27/2026" or "8/24 – 8/30"
  startDate:      string; // ISO date YYYY-MM-DD
  endDate:        string;
  impressions:    number;
  clicks:         number;
  spend:          number;
  ctr:            number | null;
  cpc:            number | null;
  conversions:    number;
  conversionValue: number;
  roas:           number | null;
}

interface Delta {
  impressions:    number | null;
  clicks:         number | null;
  spend:          number | null;
  ctr:            number | null;
  cpc:            number | null;
  conversions:    number | null;
  conversionValue: number | null;
  roas:           number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDate(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function startOfISOWeek(d: Date): Date {
  // ISO week starts Monday
  const dow = d.getUTCDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + diff);
  return r;
}

function deriveMetrics(
  impressions: number,
  clicks: number,
  spend: number,
  conversions: number,
  conversionValue: number,
): Pick<RollingRow, "ctr" | "cpc" | "roas"> {
  return {
    ctr:  impressions > 0 ? clicks / impressions : null,
    cpc:  clicks      > 0 ? spend  / clicks      : null,
    roas: spend       > 0 && conversionValue > 0 ? conversionValue / spend : null,
  };
}

function avgRow(rows: RollingRow[]): RollingRow {
  const n = rows.length;
  if (n === 0) return { label: "12-period avg", startDate: "", endDate: "", impressions: 0, clicks: 0, spend: 0, ctr: null, cpc: null, conversions: 0, conversionValue: 0, roas: null };
  const imp  = rows.reduce((s, r) => s + r.impressions, 0) / n;
  const clk  = rows.reduce((s, r) => s + r.clicks, 0) / n;
  const spd  = rows.reduce((s, r) => s + r.spend, 0) / n;
  const conv = rows.reduce((s, r) => s + r.conversions, 0) / n;
  const cv   = rows.reduce((s, r) => s + r.conversionValue, 0) / n;
  return { label: "12-period avg", startDate: "", endDate: "", impressions: imp, clicks: clk, spend: spd, conversions: conv, conversionValue: cv, ...deriveMetrics(imp, clk, spd, conv, cv) };
}

function deltaRow(a: RollingRow, b: RollingRow): Delta {
  function d(av: number | null, bv: number | null): number | null {
    if (av == null || bv == null) return null;
    return av - bv;
  }
  return {
    impressions:    d(a.impressions, b.impressions),
    clicks:         d(a.clicks, b.clicks),
    spend:          d(a.spend, b.spend),
    ctr:            d(a.ctr, b.ctr),
    cpc:            d(a.cpc, b.cpc),
    conversions:    d(a.conversions, b.conversions),
    conversionValue: d(a.conversionValue, b.conversionValue),
    roas:           d(a.roas, b.roas),
  };
}

function pctDeltaRow(a: RollingRow, b: RollingRow): Delta {
  function pd(av: number | null, bv: number | null): number | null {
    if (av == null || bv == null || bv === 0) return null;
    return (av - bv) / Math.abs(bv);
  }
  return {
    impressions:    pd(a.impressions, b.impressions),
    clicks:         pd(a.clicks, b.clicks),
    spend:          pd(a.spend, b.spend),
    ctr:            pd(a.ctr, b.ctr),
    cpc:            pd(a.cpc, b.cpc),
    conversions:    pd(a.conversions, b.conversions),
    conversionValue: pd(a.conversionValue, b.conversionValue),
    roas:           pd(a.roas, b.roas),
  };
}

// Aggregate raw DB rows into a single RollingRow
function aggregateRows(
  dbRows: { impressions: number; clicks: number; spend: number; conversions: number; conversionValue: number }[],
  label: string,
  startDate: string,
  endDate: string,
): RollingRow {
  const impressions    = dbRows.reduce((s, r) => s + r.impressions, 0);
  const clicks         = dbRows.reduce((s, r) => s + r.clicks, 0);
  const spend          = dbRows.reduce((s, r) => s + r.spend, 0);
  const conversions    = dbRows.reduce((s, r) => s + r.conversions, 0);
  const conversionValue = dbRows.reduce((s, r) => s + r.conversionValue, 0);
  return { label, startDate, endDate, impressions, clicks, spend, conversions, conversionValue, ...deriveMetrics(impressions, clicks, spend, conversions, conversionValue) };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const view       = (searchParams.get("view") ?? "daily") as "daily" | "weekly";
  const campaignId = searchParams.get("campaignId") ?? "all";

  // Anchor date — defaults to yesterday (most recent complete day)
  const anchorStr = searchParams.get("date");
  const anchor    = anchorStr ? parseDate(anchorStr) : addDays(new Date(), -1);
  // Normalise to UTC midnight
  anchor.setUTCHours(0, 0, 0, 0);

  // Fetch raw data for the last ~90 days so we have enough to fill 12 periods
  const lookback = new Date(anchor);
  lookback.setUTCDate(lookback.getUTCDate() - (view === "daily" ? 12 * 7 + 7 : 12 * 7 + 14));

  const where: Record<string, unknown> = { date: { gte: lookback, lte: anchor } };
  if (campaignId !== "all") where.campaignId = campaignId;

  const dbRows = await prisma.campaignDailySpend.findMany({
    where,
    orderBy: { date: "asc" },
    select: {
      campaignId: true,
      campaignName: true,
      date: true,
      impressions: true,
      clicks: true,
      spend: true,
      conversions: true,
      conversionValue: true,
    },
  });

  // Build a map: YYYY-MM-DD → aggregated metrics
  const byDate = new Map<string, { impressions: number; clicks: number; spend: number; conversions: number; conversionValue: number }>();
  for (const row of dbRows) {
    const key = isoDate(row.date);
    const cur = byDate.get(key) ?? { impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 };
    cur.impressions    += row.impressions;
    cur.clicks         += row.clicks;
    cur.spend          += row.spend;
    cur.conversions    += row.conversions;
    cur.conversionValue += row.conversionValue;
    byDate.set(key, cur);
  }

  // Unique campaign list (for selector)
  const campaignMap = new Map<string, string>();
  for (const row of dbRows) {
    campaignMap.set(row.campaignId, row.campaignName ?? row.campaignId);
  }
  const campaigns = Array.from(campaignMap.entries())
    .map(([id, name]) => ({ campaignId: id, campaignName: name }))
    .sort((a, b) => a.campaignName.localeCompare(b.campaignName));

  let rows: RollingRow[] = [];

  if (view === "daily") {
    // Walk back through dates that match the anchor's day-of-week
    const anchorDow = anchor.getUTCDay();
    let cur = new Date(anchor);
    while (rows.length < 12) {
      if (cur < lookback) break;
      if (cur.getUTCDay() === anchorDow) {
        const key  = isoDate(cur);
        const data = byDate.get(key) ?? { impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 };
        const d    = new Date(cur);
        const label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
        rows.push(aggregateRows([data], label, key, key));
      }
      cur = addDays(cur, -1);
    }
  } else {
    // Weekly: 12 full ISO weeks ending on or before anchor
    let weekEnd = new Date(anchor);
    // snap to the end of the ISO week that contains anchor (Sunday)
    const dow = anchor.getUTCDay();
    weekEnd = addDays(anchor, dow === 0 ? 0 : 7 - dow);
    // if that overshoots anchor, pull back to anchor
    if (weekEnd > anchor) weekEnd = new Date(anchor);

    while (rows.length < 12) {
      const weekStart = startOfISOWeek(weekEnd);
      if (weekStart < lookback) break;

      // Collect all days in [weekStart, weekEnd]
      const bucket: { impressions: number; clicks: number; spend: number; conversions: number; conversionValue: number }[] = [];
      let d = new Date(weekStart);
      while (d <= weekEnd) {
        const data = byDate.get(isoDate(d));
        if (data) bucket.push(data);
        d = addDays(d, 1);
      }

      const startStr = isoDate(weekStart);
      const endStr   = isoDate(weekEnd);
      const ws = new Date(weekStart);
      const we = new Date(weekEnd);
      const label = `${ws.getUTCMonth() + 1}/${ws.getUTCDate()} – ${we.getUTCMonth() + 1}/${we.getUTCDate()}`;
      rows.push(aggregateRows(bucket, label, startStr, endStr));

      // Move to previous week
      weekEnd = addDays(weekStart, -1);
    }
  }

  // Summary statistics
  const avg12      = avgRow(rows);
  const wowDelta   = rows.length >= 2 ? deltaRow(rows[0], rows[1]) : null;
  const wowPct     = rows.length >= 2 ? pctDeltaRow(rows[0], rows[1]) : null;
  const avg12Delta = rows.length >= 1 ? deltaRow(rows[0], avg12) : null;
  const avg12Pct   = rows.length >= 1 ? pctDeltaRow(rows[0], avg12) : null;

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName  = dayNames[anchor.getUTCDay()];

  return NextResponse.json({
    view,
    dayName,
    anchorDate: isoDate(anchor),
    campaigns,
    rows,
    avg12,
    wowDelta,
    wowPct,
    avg12Delta,
    avg12Pct,
  });
}
