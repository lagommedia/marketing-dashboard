/**
 * GET /api/paid-media/rolling?view=daily|weekly&campaignId=all|{id}
 *
 * Returns 12 rolling periods of Google Ads campaign data with per-period
 * campaign breakdowns for accordion expansion.
 *
 * daily   — last 12 occurrences of the anchor day-of-week (defaults to yesterday)
 * weekly  — last 12 ISO weeks ending on or before the anchor date
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MetricBucket {
  impressions:       number;
  clicks:            number;
  spend:             number;
  searchImprShare:   number | null;
  searchTopIS:       number | null;
  searchAbsTopIS:    number | null;
  searchLostISRank:  number | null;
  searchLostISBudget: number | null;
}

interface RollingRow extends MetricBucket {
  label:      string;
  startDate:  string;
  endDate:    string;
  ctr:        number | null;
  cpc:        number | null;
  // Per-period campaign breakdown for accordion
  campaigns?: CampaignBreakdown[];
}

interface CampaignBreakdown extends MetricBucket {
  campaignId:   string;
  campaignName: string;
  ctr:          number | null;
  cpc:          number | null;
}

interface Delta {
  impressions:       number | null;
  clicks:            number | null;
  spend:             number | null;
  ctr:               number | null;
  cpc:               number | null;
  searchImprShare:   number | null;
  searchTopIS:       number | null;
  searchAbsTopIS:    number | null;
  searchLostISRank:  number | null;
  searchLostISBudget: number | null;
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
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + diff);
  return r;
}

function nullableAvg(vals: (number | null)[]): number | null {
  const valid = vals.filter((v): v is number => v != null);
  return valid.length > 0 ? valid.reduce((s, v) => s + v, 0) / valid.length : null;
}

function derivedCtrCpc(impressions: number, clicks: number, spend: number) {
  return {
    ctr: impressions > 0 ? clicks / impressions : null,
    cpc: clicks      > 0 ? spend  / clicks      : null,
  };
}

type DbRow = {
  campaignId: string;
  campaignName: string | null;
  date: Date;
  impressions: number;
  clicks: number;
  spend: number;
  searchImprShare: number | null;
  searchTopIS: number | null;
  searchAbsTopIS: number | null;
  searchLostISRank: number | null;
  searchLostISBudget: number | null;
};

function aggregateDbRows(
  dbRows: DbRow[],
  label: string,
  startDate: string,
  endDate: string,
  includeCampaigns = false,
): RollingRow {
  const impressions = dbRows.reduce((s, r) => s + r.impressions, 0);
  const clicks      = dbRows.reduce((s, r) => s + r.clicks, 0);
  const spend       = dbRows.reduce((s, r) => s + r.spend, 0);

  // IS metrics: weighted by impressions where available, else simple avg
  const searchImprShare    = nullableAvg(dbRows.map(r => r.searchImprShare));
  const searchTopIS        = nullableAvg(dbRows.map(r => r.searchTopIS));
  const searchAbsTopIS     = nullableAvg(dbRows.map(r => r.searchAbsTopIS));
  const searchLostISRank   = nullableAvg(dbRows.map(r => r.searchLostISRank));
  const searchLostISBudget = nullableAvg(dbRows.map(r => r.searchLostISBudget));

  const row: RollingRow = {
    label, startDate, endDate,
    impressions, clicks, spend,
    searchImprShare, searchTopIS, searchAbsTopIS, searchLostISRank, searchLostISBudget,
    ...derivedCtrCpc(impressions, clicks, spend),
  };

  if (includeCampaigns) {
    // Group by campaign
    const byCampaign = new Map<string, { name: string; rows: DbRow[] }>();
    for (const r of dbRows) {
      const entry = byCampaign.get(r.campaignId) ?? { name: r.campaignName ?? r.campaignId, rows: [] };
      entry.rows.push(r);
      byCampaign.set(r.campaignId, entry);
    }

    row.campaigns = Array.from(byCampaign.entries()).map(([id, { name, rows }]) => {
      const ci = rows.reduce((s, r) => s + r.impressions, 0);
      const cc = rows.reduce((s, r) => s + r.clicks, 0);
      const cs = rows.reduce((s, r) => s + r.spend, 0);
      return {
        campaignId:   id,
        campaignName: name,
        impressions:  ci,
        clicks:       cc,
        spend:        cs,
        searchImprShare:    nullableAvg(rows.map(r => r.searchImprShare)),
        searchTopIS:        nullableAvg(rows.map(r => r.searchTopIS)),
        searchAbsTopIS:     nullableAvg(rows.map(r => r.searchAbsTopIS)),
        searchLostISRank:   nullableAvg(rows.map(r => r.searchLostISRank)),
        searchLostISBudget: nullableAvg(rows.map(r => r.searchLostISBudget)),
        ...derivedCtrCpc(ci, cc, cs),
      };
    }).sort((a, b) => b.spend - a.spend);
  }

  return row;
}

function avgRow(rows: RollingRow[]): RollingRow {
  const n = rows.length;
  if (n === 0) {
    return { label: "12-period avg", startDate: "", endDate: "", impressions: 0, clicks: 0, spend: 0, ctr: null, cpc: null, searchImprShare: null, searchTopIS: null, searchAbsTopIS: null, searchLostISRank: null, searchLostISBudget: null };
  }
  const impressions = rows.reduce((s, r) => s + r.impressions, 0) / n;
  const clicks      = rows.reduce((s, r) => s + r.clicks, 0) / n;
  const spend       = rows.reduce((s, r) => s + r.spend, 0) / n;
  return {
    label: "12-period avg", startDate: "", endDate: "",
    impressions, clicks, spend,
    searchImprShare:    nullableAvg(rows.map(r => r.searchImprShare)),
    searchTopIS:        nullableAvg(rows.map(r => r.searchTopIS)),
    searchAbsTopIS:     nullableAvg(rows.map(r => r.searchAbsTopIS)),
    searchLostISRank:   nullableAvg(rows.map(r => r.searchLostISRank)),
    searchLostISBudget: nullableAvg(rows.map(r => r.searchLostISBudget)),
    ...derivedCtrCpc(impressions, clicks, spend),
  };
}

function deltaRow(a: RollingRow, b: RollingRow): Delta {
  function d(av: number | null, bv: number | null) { return av != null && bv != null ? av - bv : null; }
  return {
    impressions:       d(a.impressions, b.impressions),
    clicks:            d(a.clicks, b.clicks),
    spend:             d(a.spend, b.spend),
    ctr:               d(a.ctr, b.ctr),
    cpc:               d(a.cpc, b.cpc),
    searchImprShare:   d(a.searchImprShare, b.searchImprShare),
    searchTopIS:       d(a.searchTopIS, b.searchTopIS),
    searchAbsTopIS:    d(a.searchAbsTopIS, b.searchAbsTopIS),
    searchLostISRank:  d(a.searchLostISRank, b.searchLostISRank),
    searchLostISBudget: d(a.searchLostISBudget, b.searchLostISBudget),
  };
}

function pctDeltaRow(a: RollingRow, b: RollingRow): Delta {
  function pd(av: number | null, bv: number | null) {
    return av != null && bv != null && bv !== 0 ? (av - bv) / Math.abs(bv) : null;
  }
  return {
    impressions:       pd(a.impressions, b.impressions),
    clicks:            pd(a.clicks, b.clicks),
    spend:             pd(a.spend, b.spend),
    ctr:               pd(a.ctr, b.ctr),
    cpc:               pd(a.cpc, b.cpc),
    searchImprShare:   pd(a.searchImprShare, b.searchImprShare),
    searchTopIS:       pd(a.searchTopIS, b.searchTopIS),
    searchAbsTopIS:    pd(a.searchAbsTopIS, b.searchAbsTopIS),
    searchLostISRank:  pd(a.searchLostISRank, b.searchLostISRank),
    searchLostISBudget: pd(a.searchLostISBudget, b.searchLostISBudget),
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const view       = (searchParams.get("view") ?? "daily") as "daily" | "weekly";
  const campaignId = searchParams.get("campaignId") ?? "all";

  const anchorStr = searchParams.get("date");
  const anchor    = anchorStr ? parseDate(anchorStr) : addDays(new Date(), -1);
  anchor.setUTCHours(0, 0, 0, 0);

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
      searchImprShare: true,
      searchTopIS: true,
      searchAbsTopIS: true,
      searchLostISRank: true,
      searchLostISBudget: true,
    },
  });

  // Build date-keyed map for fast lookup
  const byDate = new Map<string, DbRow[]>();
  for (const row of dbRows) {
    const key = isoDate(row.date);
    const arr = byDate.get(key) ?? [];
    arr.push(row);
    byDate.set(key, arr);
  }

  // Campaign list for selector UI
  const campaignMap = new Map<string, string>();
  for (const row of dbRows) {
    campaignMap.set(row.campaignId, row.campaignName ?? row.campaignId);
  }
  const campaigns = Array.from(campaignMap.entries())
    .map(([id, name]) => ({ campaignId: id, campaignName: name }))
    .sort((a, b) => a.campaignName.localeCompare(b.campaignName));

  const rows: RollingRow[] = [];

  if (view === "daily") {
    const anchorDow = anchor.getUTCDay();
    let cur = new Date(anchor);
    while (rows.length < 12) {
      if (cur < lookback) break;
      if (cur.getUTCDay() === anchorDow) {
        const key   = isoDate(cur);
        const data  = byDate.get(key) ?? [];
        const d     = new Date(cur);
        const label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
        rows.push(aggregateDbRows(data, label, key, key, true));
      }
      cur = addDays(cur, -1);
    }
  } else {
    let weekEnd = new Date(anchor);
    const dow = anchor.getUTCDay();
    weekEnd = addDays(anchor, dow === 0 ? 0 : 7 - dow);
    if (weekEnd > anchor) weekEnd = new Date(anchor);

    while (rows.length < 12) {
      const weekStart = startOfISOWeek(weekEnd);
      if (weekStart < lookback) break;

      const bucket: DbRow[] = [];
      let d = new Date(weekStart);
      while (d <= weekEnd) {
        const data = byDate.get(isoDate(d));
        if (data) bucket.push(...data);
        d = addDays(d, 1);
      }

      const startStr = isoDate(weekStart);
      const endStr   = isoDate(weekEnd);
      const ws = new Date(weekStart);
      const we = new Date(weekEnd);
      const label = `${ws.getUTCMonth() + 1}/${ws.getUTCDate()} – ${we.getUTCMonth() + 1}/${we.getUTCDate()}`;
      rows.push(aggregateDbRows(bucket, label, startStr, endStr, true));

      weekEnd = addDays(weekStart, -1);
    }
  }

  const avg12      = avgRow(rows);
  const wowDelta   = rows.length >= 2 ? deltaRow(rows[0], rows[1]) : null;
  const wowPct     = rows.length >= 2 ? pctDeltaRow(rows[0], rows[1]) : null;
  const avg12Delta = rows.length >= 1 ? deltaRow(rows[0], avg12) : null;
  const avg12Pct   = rows.length >= 1 ? pctDeltaRow(rows[0], avg12) : null;

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return NextResponse.json({
    view,
    dayName:    dayNames[anchor.getUTCDay()],
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
