import { Suspense } from "react";
import { prisma } from "@/lib/db";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { TrendableMetricCard } from "@/components/dashboard/TrendableMetricCard";
import { ActivePipelineCard } from "@/components/dashboard/ActivePipelineCard";
import { NewPipelineCard } from "@/components/dashboard/NewPipelineCard";
import { FunnelChart } from "@/components/dashboard/FunnelChart";
import { ChannelFilter } from "@/components/dashboard/ChannelFilter";
import { DateRangePicker } from "@/components/dashboard/DateRangePicker";
import { AlertCircle } from "lucide-react";
import { GtmEfficiencyCard } from "@/components/dashboard/GtmEfficiencyCard";
import { CacCard } from "@/components/dashboard/CacCard";
import { LtvCard } from "@/components/dashboard/LtvCard";
import { LtvCacRatioCard } from "@/components/dashboard/LtvCacRatioCard";
import type { Channel } from "@/types";
import { getCachedSheetMonths, normMonth } from "@/lib/sheets-cache";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const DEFAULT_FROM = () => {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3);
  return new Date(now.getFullYear(), q * 3, 1).toISOString().slice(0, 10);
};
const DEFAULT_TO = todayIso;

function parseDate(raw: string | undefined, fallback: () => string): Date {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(fallback() + "T00:00:00");
  return new Date(raw + "T00:00:00");
}

function rangeLabel(from: string, to: string): string {
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${fmt(f)} – ${fmt(t)}`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * Build a Prisma OR filter that combines every platform/channel pair
 * that contributes to the requested channel view.
 *
 * Platform responsibilities (fields never overlap):
 *   hubspot              → leads, mqls, sqos, closedWon, pipeline, revenue, activePipeline
 *   google_ads           → impressions, clicks, spend, cpc, ctr  (paid_media only)
 *   google_search_console→ impressions, clicks, ctr              (organic only)
 *
 * channel = "all"       : HubSpot "all"  + Google Ads "paid_media" + GSC "organic"
 * channel = "paid_media": HubSpot "paid_media" + Google Ads "paid_media"
 * channel = "organic"   : HubSpot "organic"    + GSC "organic"
 * channel = "referral"  : HubSpot "referral"   only (no ad platform for referral)
 */
function buildChannelWhere(channel: Channel) {
  if (channel === "all") {
    return {
      OR: [
        { platform: "hubspot",               channel: "all"        },
        { platform: "google_ads",            channel: "paid_media" },
        { platform: "google_search_console", channel: "organic"    },
        { platform: "manual",                channel: "paid_media" },
        { platform: "manual",                channel: "organic"    },
      ],
    };
  }
  if (channel === "paid_media") {
    return {
      OR: [
        { platform: "hubspot",    channel: "paid_media" },
        { platform: "google_ads", channel: "paid_media" },
        { platform: "manual",     channel: "paid_media" },
      ],
    };
  }
  if (channel === "organic") {
    return {
      OR: [
        { platform: "hubspot",               channel: "organic" },
        { platform: "google_search_console", channel: "organic" },
        { platform: "manual",                channel: "organic" },
      ],
    };
  }
  // referral (and any future channels) — HubSpot only
  return { channel };
}

async function getMetrics(channel: Channel, fromDate: Date, toDate: Date) {
  // End of the "to" day
  const toEnd = new Date(toDate);
  toEnd.setHours(23, 59, 59, 999);

  const rows = await prisma.metricSnapshot.findMany({
    where: {
      date: { gte: fromDate, lte: toEnd },
      ...buildChannelWhere(channel),
    },
    orderBy: { date: "desc" },
  });

  const sum = <K extends keyof (typeof rows)[0]>(key: K) =>
    rows.reduce((acc, r) => acc + ((r[key] as number) ?? 0), 0) || null;

  // activePipeline is a point-in-time snapshot written daily (not a delta).
  // Summing snapshots across days inflates the number proportionally to the
  // date range. Instead, use the most-recent non-null value in the window.
  const latestActivePipeline = (() => {
    for (const r of rows) {
      const v = r.activePipeline as number | null;
      if (v != null && v > 0) return v;
    }
    return null;
  })();

  const impressions  = sum("impressions");
  const clicks       = sum("clicks");
  const leads        = sum("leads");
  const mqls         = sum("mqls");
  const sqos         = sum("sqos");
  const closedWon    = sum("closedWon");
  const spend        = sum("spend");

  return {
    impressions,
    clicks,
    leads,
    mqls,
    sqos,
    closedWon,
    spend,
    revenue:        sum("revenue"),
    pipeline:       sum("pipeline"),
    activePipeline: latestActivePipeline,
    // Conversion rates derived from summed counts — accurate across the full date range
    ctr:        clicks    != null && impressions != null && impressions > 0 ? clicks    / impressions : null,
    leadToMql:  mqls      != null && leads       != null && leads       > 0 ? mqls      / leads       : null,
    mqlToSqo:   sqos      != null && mqls        != null && mqls        > 0 ? sqos      / mqls        : null,
    sqoToClose: closedWon != null && sqos        != null && sqos        > 0 ? closedWon / sqos        : null,
    // Cost metrics derived from summed spend ÷ summed activity counts
    cpc:     spend != null && clicks    != null && clicks    > 0 ? spend / clicks    : null,
    cpl:     spend != null && leads     != null && leads     > 0 ? spend / leads     : null,
    cpMql:   spend != null && mqls      != null && mqls      > 0 ? spend / mqls      : null,
    cpSqo:   spend != null && sqos      != null && sqos      > 0 ? spend / sqos      : null,
    paidCac: spend != null && closedWon != null && closedWon > 0 ? spend / closedWon : null,
    mktgCac: spend != null && closedWon != null && closedWon > 0 ? spend / closedWon : null,
    hasData: rows.length > 0,
  };
}

async function getConnectedCount() {
  return prisma.integration.count({ where: { connected: true } });
}

// ---------------------------------------------------------------------------
// Estimated Marketing Spend
// Formula: Marketing Gross Costs + Shared Allocation × % of Period Elapsed
// Source: ReferenceSheetMonth cache (populated by Google Sheets sync)
// ---------------------------------------------------------------------------

const SHORT_MONTHS_PAGE = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

async function getEstimatedMarketingSpend(from: Date, to: Date): Promise<number | null> {
  // Always use the full quarter's months so crossing a month boundary mid-quarter
  // doesn't cause a step-jump in the estimate. pctElapsed handles the "how much
  // have we spent so far" portion — the cost base should always be the full quarter.
  const q = Math.floor(from.getMonth() / 3);
  const qLastMonth = new Date(from.getFullYear(), q * 3 + 2, 1); // last month of quarter
  const months: string[] = [];
  const cur = new Date(from.getFullYear(), q * 3, 1); // first month of quarter
  while (cur <= qLastMonth) {
    months.push(`${SHORT_MONTHS_PAGE[cur.getMonth()]} ${cur.getFullYear()}`);
    cur.setMonth(cur.getMonth() + 1);
  }

  const cached = await getCachedSheetMonths(months);
  if (!cached) return null;

  let grossCosts = 0, sharedAllocation = 0;
  let lastDataMonth: string | null = null;
  for (const m of months) {
    const row = cached.get(normMonth(m));
    if (row) {
      grossCosts       += row.grossCosts;
      sharedAllocation += row.sharedAllocation;
      if (row.grossCosts > 0 || row.sharedAllocation > 0) lastDataMonth = m;
    }
  }
  if (grossCosts === 0 && sharedAllocation === 0) return null;

  // Cap elapsed at min(today, first-day-of-next-month-after-last-data) so:
  //   - Past quarters resolve to 100% (first of next month > qEnd)
  //   - Current quarter is capped at today so WIP/future months don't inflate %
  let lastDataDate = new Date();
  if (lastDataMonth) {
    const [mon, yr] = lastDataMonth.split(" ");
    const mIdx = SHORT_MONTHS_PAGE.indexOf(mon);
    lastDataDate = new Date(Number(yr), mIdx + 1, 1); // first day of NEXT month
  }
  // Also cap at the selected `to` date so historical ranges (e.g. "July only")
  // show the spend proportional to that period, not the spend through today.
  const toEndOfDay = new Date(to.getTime() + 86_400_000); // include full last day
  const asOf = new Date(Math.min(new Date().getTime(), lastDataDate.getTime(), toEndOfDay.getTime()));

  const qStart  = new Date(from.getFullYear(), q * 3,     1);
  const qEnd    = new Date(from.getFullYear(), q * 3 + 3, 0);
  const totalMs = qEnd.getTime() - qStart.getTime() + 86_400_000;
  const pct     = Math.min(Math.max(asOf.getTime() - qStart.getTime(), 0), totalMs) / totalMs;

  return (grossCosts + sharedAllocation) * pct;
}

// ---------------------------------------------------------------------------
// QTD pacing
// ---------------------------------------------------------------------------

/** Returns quarter bounds, elapsed fraction, and period string for today. */
function getCurrentQuarter() {
  const now   = new Date();
  const year  = now.getFullYear();
  const q     = Math.floor(now.getMonth() / 3);          // 0-indexed (0=Q1…3=Q4)
  const start = new Date(year, q * 3, 1);                // first day of quarter
  const end   = new Date(year, q * 3 + 3, 0);            // last day of quarter
  // Elapsed = days elapsed / total days (include end day fully)
  const totalMs   = end.getTime() + 86_400_000 - start.getTime();
  const elapsedMs = Math.min(now.getTime() - start.getTime(), totalMs);
  return {
    start,
    end,
    elapsed: elapsedMs / totalMs,
    period:  `${year}-Q${q + 1}`,
    label:   `Q${q + 1}`,
  };
}

import type { MetricPace } from "@/components/dashboard/MetricCard";
import type { SparkPoint } from "@/components/dashboard/MiniSparkline";

// ---------------------------------------------------------------------------
// Sparkline periods
// ---------------------------------------------------------------------------

type RawSparkPeriod = { label: string; from: string; to: string; isCurrent: boolean };

/** Return 5 periods (4 previous + current, oldest→current) for sparklines. */
function computeSparkPeriods(fromStr: string, toStr: string): RawSparkPeriod[] {
  const from = new Date(fromStr + "T00:00:00");
  const to   = new Date(toStr   + "T00:00:00");

  const isQStart    = from.getDate() === 1 && from.getMonth() % 3 === 0;
  const fromQ       = Math.floor(from.getMonth() / 3);
  const toQ         = Math.floor(to.getMonth()   / 3);
  const isQuarterly = isQStart && from.getFullYear() === to.getFullYear() && fromQ === toQ;

  const raw: RawSparkPeriod[] = [];

  if (isQuarterly) {
    for (let i = 4; i >= 1; i--) {
      let q = fromQ - i, yr = from.getFullYear();
      while (q < 0) { q += 4; yr--; }
      raw.push({
        label:     `Q${q + 1} ${yr}`,
        from:      new Date(yr, q * 3, 1).toISOString().slice(0, 10),
        to:        new Date(yr, q * 3 + 3, 0).toISOString().slice(0, 10),
        isCurrent: false,
      });
    }
    raw.push({ label: `Q${fromQ + 1} ${from.getFullYear()}`, from: fromStr, to: toStr, isCurrent: true });
  } else {
    const SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const durMs = to.getTime() - from.getTime();
    const lbl   = (t: string) => { const d = new Date(t + "T00:00:00"); return `${SHORT[d.getMonth()]} ${d.getFullYear()}`; };
    const windows: { from: string; to: string }[] = [{ from: fromStr, to: toStr }];
    let prevTo = new Date(from.getTime() - 86_400_000);
    for (let i = 0; i < 4; i++) {
      const prevFrom = new Date(prevTo.getTime() - durMs);
      windows.unshift({ from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) });
      prevTo = new Date(prevFrom.getTime() - 86_400_000);
    }
    windows.forEach((w, i) =>
      raw.push({ label: lbl(w.to), from: w.from, to: w.to, isCurrent: i === windows.length - 1 })
    );
  }

  return raw;
}

/**
 * Reads Google Sheets ONCE and queries the DB per period to compute GTM, CAC,
 * LTV, and LTV:CAC sparkline data for all periods in a single batch.
 * Returns null if Sheets is unavailable (sparklines will simply not render).
 */
async function getEfficiencySparklines(
  channel: Channel,
  rawPeriods: RawSparkPeriod[],
): Promise<{ gtm: SparkPoint[]; cac: SparkPoint[]; ltv: SparkPoint[]; ltvCac: SparkPoint[] } | null> {
  try {
    // 1. DB — revenue + closedWon per period (parallel aggregates)
    const dbRows = await Promise.all(
      rawPeriods.map(async (p) => {
        const agg = await prisma.metricSnapshot.aggregate({
          where: {
            date: { gte: new Date(p.from + "T00:00:00"), lte: new Date(p.to + "T23:59:59") },
            ...buildChannelWhere(channel),
          },
          _sum: { closedWon: true, revenue: true },
        });
        return { ...p, closedWon: agg._sum.closedWon ?? null, revenue: agg._sum.revenue ?? null };
      })
    );

    // 2. Collect every unique month across all periods, then load from DB cache
    const SHORT  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const norm   = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
    const pNum   = (v: unknown): number => {
      if (v == null || v === "") return 0;
      if (typeof v === "number") return isNaN(v) ? 0 : v;
      const n = parseFloat(String(v).replace(/[$,%\s]/g, ""));
      return isNaN(n) ? 0 : n;
    };
    const toDec  = (v: unknown) => { const n = pNum(v); return n > 1 ? n / 100 : n; };
    const monthsInRange = (from: Date, to: Date) => {
      const out: string[] = [];
      const cur = new Date(from.getFullYear(), from.getMonth(), 1);
      while (cur <= new Date(to.getFullYear(), to.getMonth(), 1)) {
        out.push(`${SHORT[cur.getMonth()]} ${cur.getFullYear()}`);
        cur.setMonth(cur.getMonth() + 1);
      }
      return out;
    };
    const pctElapsed = (from: Date, asOf?: Date) => {
      const q   = Math.floor(from.getMonth() / 3);
      const qs  = new Date(from.getFullYear(), q * 3, 1);
      const qe  = new Date(from.getFullYear(), q * 3 + 3, 0);
      const now = asOf ?? new Date();
      const total   = qe.getTime() - qs.getTime() + 86_400_000;
      const elapsed = Math.min(Math.max(now.getTime() - qs.getTime(), 0), total);
      return elapsed / total;
    };
    // Returns first day of NEXT month after the last month with cost data.
    // Combined with Math.min(today, ...) this ensures:
    //   - Past quarters → asOf > qEnd → pctElapsed = 100%
    //   - Current quarter → asOf capped at today, never inflated by future WIP months
    const lastCachedDateFor = (periodMonths: string[]): Date => {
      for (let i = periodMonths.length - 1; i >= 0; i--) {
        const row = sheetCache.get(norm(periodMonths[i]));
        if (row && (row.grossCosts > 0 || row.sharedAllocation > 0)) {
          const [mon, yr] = periodMonths[i].split(" ");
          const mIdx = SHORT.indexOf(mon);
          return new Date(Number(yr), mIdx + 1, 1); // first day of NEXT month
        }
      }
      return new Date();
    };

    // Gather all month labels needed across every spark period.
    // Use the full quarter (not just elapsed months) so cost totals don't
    // step-jump when a new month starts mid-quarter.
    const quarterMonthsFor = (from: Date): string[] => {
      const q = Math.floor(from.getMonth() / 3);
      const out: string[] = [];
      for (let i = 0; i < 3; i++) {
        const d = new Date(from.getFullYear(), q * 3 + i, 1);
        out.push(`${SHORT[d.getMonth()]} ${d.getFullYear()}`);
      }
      return out;
    };
    const allMonthLabels = new Set<string>();
    for (const p of rawPeriods) {
      for (const m of quarterMonthsFor(new Date(p.from + "T00:00:00"))) {
        allMonthLabels.add(norm(m));
      }
    }

    // Load from ReferenceSheetMonth cache
    const sheetRows = await prisma.referenceSheetMonth.findMany({
      where: { month: { in: [...allMonthLabels] } },
    });
    if (sheetRows.length === 0) return null; // cache not yet seeded — sync first

    type CacheRow = { grossCosts: number; sharedAllocation: number; arpu: number; grossMargin: number; churnRate: number };
    const sheetCache = new Map<string, CacheRow>(
      sheetRows.map(r => [r.month, { grossCosts: r.grossCosts, sharedAllocation: r.sharedAllocation,
                                     arpu: r.arpu, grossMargin: r.grossMargin, churnRate: r.churnRate }])
    );

    // 3. Compute per period
    const gtmPts: SparkPoint[] = [], cacPts: SparkPoint[] = [],
          ltvPts: SparkPoint[] = [], ltvCacPts: SparkPoint[] = [];

    for (const p of dbRows) {
      const from = new Date(p.from + "T00:00:00");
      const to   = new Date(p.to   + "T00:00:00");

      // GTM + CAC: sum across the full quarter so crossing a month boundary
      // mid-quarter doesn't cause a step-jump in the cost denominator.
      const periodMonths = quarterMonthsFor(from);
      let gross = 0, shared = 0, anyMonth = false;
      for (const m of periodMonths) {
        const cached = sheetCache.get(norm(m));
        if (cached) { gross += cached.grossCosts; shared += cached.sharedAllocation; anyMonth = true; }
      }

      let gtmVal: number | null = null, cacVal: number | null = null, ltvVal: number | null = null;

      if (anyMonth) {
        const lastData = lastCachedDateFor(periodMonths);
        const asOf     = new Date(Math.min(new Date().getTime(), lastData.getTime()));
        const denom = (gross + shared) * pctElapsed(from, asOf);
        if (denom > 0) {
          if (p.revenue   != null && p.revenue   > 0) gtmVal = p.revenue / denom;
          if (p.closedWon != null && p.closedWon > 0) cacVal = denom / p.closedWon;
        }
      }

      // LTV: snapshot of the last month in the period
      const ltvKey = norm(`${SHORT[to.getMonth()]} ${to.getFullYear()}`);
      const ltvRow = sheetCache.get(ltvKey);
      if (ltvRow) {
        const { arpu, grossMargin: gm, churnRate: ch } = ltvRow;
        if (arpu > 0 && gm > 0 && ch > 0) ltvVal = (arpu * gm) / (ch * 12);
      }

      gtmPts.push(   { label: p.label, value: gtmVal, isCurrent: p.isCurrent });
      cacPts.push(   { label: p.label, value: cacVal, isCurrent: p.isCurrent });
      ltvPts.push(   { label: p.label, value: ltvVal, isCurrent: p.isCurrent });
      ltvCacPts.push({ label: p.label, isCurrent: p.isCurrent,
        value: cacVal != null && ltvVal != null && cacVal > 0 ? ltvVal / cacVal : null });
    }

    return { gtm: gtmPts, cac: cacPts, ltv: ltvPts, ltvCac: ltvCacPts };
  } catch (err) {
    console.error("[efficiency-sparklines]", err);
    return null;
  }
}

type PacingMap = {
  mqls:      MetricPace | null;
  sqos:      MetricPace | null;
  pipeline:  MetricPace | null;
  closedWon: MetricPace | null;
  revenue:   MetricPace | null;
  spend:     MetricPace | null;
};

async function getQtdPacing(channel: Channel): Promise<PacingMap> {
  const none: PacingMap = { mqls: null, sqos: null, pipeline: null, closedWon: null, revenue: null, spend: null };

  const { start, elapsed, period, label } = getCurrentQuarter();
  if (elapsed <= 0) return none;

  const toEnd = new Date();
  toEnd.setHours(23, 59, 59, 999);

  // QTD actuals — same multi-platform filter as the main metrics query
  const qtd = await prisma.metricSnapshot.aggregate({
    where: {
      date: { gte: start, lte: toEnd },
      ...buildChannelWhere(channel),
    },
    _sum: { mqls: true, sqos: true, pipeline: true, closedWon: true, revenue: true, spend: true },
  });
  const actual = qtd._sum;

  // Quarterly targets for this channel
  let tgt: Record<string, number | null> | null = null;
  if (channel === "all") {
    // Sum targets across the three marketing channels
    const rows = await prisma.pacingTarget.findMany({
      where: { period, channel: { in: ["paid_media", "organic", "referral"] } },
    });
    if (rows.length > 0) {
      tgt = {
        targetMqls:      rows.reduce((s, r) => s + (r.targetMqls      ?? 0), 0) || null,
        targetSqos:      rows.reduce((s, r) => s + (r.targetSqos      ?? 0), 0) || null,
        targetPipeline:  rows.reduce((s, r) => s + (r.targetPipeline  ?? 0), 0) || null,
        targetClosedWon: rows.reduce((s, r) => s + (r.targetClosedWon ?? 0), 0) || null,
        targetRevenue:   rows.reduce((s, r) => s + (r.targetRevenue   ?? 0), 0) || null,
        targetSpend:     rows.reduce((s, r) => s + (r.targetSpend     ?? 0), 0) || null,
      };
    }
  } else {
    const row = await prisma.pacingTarget.findUnique({
      where: { period_channel: { period, channel } },
    });
    if (row) {
      tgt = {
        targetMqls:      row.targetMqls,
        targetSqos:      row.targetSqos,
        targetPipeline:  row.targetPipeline,
        targetClosedWon: row.targetClosedWon,
        targetRevenue:   row.targetRevenue,
        targetSpend:     row.targetSpend,
      };
    }
  }

  if (!tgt) return none;

  /** Compute pacing status for a single metric. */
  function pace(
    actualVal: number | null | undefined,
    targetVal: number | null | undefined,
    format: "number" | "currency",
  ): MetricPace | null {
    if (actualVal == null || targetVal == null || targetVal <= 0) return null;
    const expected = targetVal * elapsed;
    const diff = actualVal - expected;
    const pct = (diff / expected) * 100;
    return {
      status:  pct >= 5 ? "ahead" : pct >= -15 ? "on-track" : "behind",
      pct,
      quarter: label,
      expected,
      diff,
      format,
    };
  }

  return {
    mqls:      pace(actual.mqls,      tgt.targetMqls,      "number"),
    sqos:      pace(actual.sqos,      tgt.targetSqos,      "number"),
    pipeline:  pace(actual.pipeline,  tgt.targetPipeline,  "currency"),
    closedWon: pace(actual.closedWon, tgt.targetClosedWon, "number"),
    revenue:   pace(actual.revenue,   tgt.targetRevenue,   "currency"),
    spend:     pace(actual.spend,     tgt.targetSpend,     "currency"),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface PageProps {
  searchParams: Promise<{ channel?: string; from?: string; to?: string }>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const channel = (sp.channel as Channel) ?? "all";

  const fromStr = sp.from ?? DEFAULT_FROM();
  const toStr = sp.to ?? DEFAULT_TO();
  const fromDate = parseDate(fromStr, DEFAULT_FROM);
  const toDate = parseDate(toStr, DEFAULT_TO);

  const rawSparkPeriods = computeSparkPeriods(fromStr, toStr);
  const [metrics, connectedCount, pacing, effSparklines, estimatedSpend] = await Promise.all([
    getMetrics(channel, fromDate, toDate),
    getConnectedCount(),
    getQtdPacing(channel),
    getEfficiencySparklines(channel, rawSparkPeriods),
    getEstimatedMarketingSpend(fromDate, toDate),
  ]);

  const funnelData = [
    { name: "Leads",      value: metrics.leads      ?? 0, color: "#a5b4fc" },
    { name: "MQLs",       value: metrics.mqls       ?? 0, color: "#818cf8" },
    { name: "SQOs",       value: metrics.sqos       ?? 0, color: "#6366f1" },
    { name: "Closed Won", value: metrics.closedWon  ?? 0, color: "#4338ca" },
  ];

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Overview</h1>
          <p className="text-sm text-slate-500 mt-1">{rangeLabel(fromStr, toStr)}</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Suspense>
            <DateRangePicker from={fromStr} to={toStr} />
          </Suspense>
          <Suspense>
            <ChannelFilter active={channel} />
          </Suspense>
        </div>
      </div>

      {/* No integrations banner */}
      {connectedCount === 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>
            No integrations connected.{" "}
            <a href="/integrations" className="font-semibold underline underline-offset-2">
              Set them up
            </a>{" "}
            to start seeing real data.
          </span>
        </div>
      )}

      {/* Revenue & pipeline headline */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <TrendableMetricCard
          label="Revenue (Closed Won)"
          value={formatCurrency(metrics.revenue)}
          metric="revenue"
          from={fromStr}
          to={toStr}
          channel={channel}
          format="currency"
          highlight
          pace={pacing.revenue}
          breakdown={channel === "all"}
        />
        <ActivePipelineCard channel={channel} />
        <NewPipelineCard
          value={formatCurrency(metrics.pipeline)}
          from={fromStr}
          to={toStr}
          channel={channel}
          pace={pacing.pipeline}
        />
        <TrendableMetricCard
          label="Estimated Marketing Cost"
          value={estimatedSpend != null ? formatCurrency(estimatedSpend) : "—"}
          metric="spend"
          from={fromStr}
          to={toStr}
          channel={channel}
          format="currency"
          subValue={estimatedSpend == null ? "Run a Google Sheets sync" : "Marketing Opex + Shared Costs + Headcount"}
        />
      </div>

      {/* Efficiency metrics (all-channel view only) */}
      {channel === "all" && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <GtmEfficiencyCard
            from={fromStr}
            to={toStr}
            revenue={metrics.revenue}
            sparkData={effSparklines?.gtm}
          />
          <CacCard
            from={fromStr}
            to={toStr}
            closedWon={metrics.closedWon}
            sparkData={effSparklines?.cac}
          />
          <LtvCard
            from={fromStr}
            to={toStr}
            sparkData={effSparklines?.ltv}
          />
          <LtvCacRatioCard
            from={fromStr}
            to={toStr}
            closedWon={metrics.closedWon}
            sparkData={effSparklines?.ltvCac}
          />
        </div>
      )}

      {/* Funnel metrics grid */}
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Funnel Performance</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <TrendableMetricCard label="Impressions" value={formatNumber(metrics.impressions, true)} metric="impressions" from={fromStr} to={toStr} channel={channel} format="number" />
          <TrendableMetricCard label="Clicks"      value={formatNumber(metrics.clicks, true)}      metric="clicks"      from={fromStr} to={toStr} channel={channel} format="number" />
          <TrendableMetricCard label="Leads"       value={formatNumber(metrics.leads, true)}       metric="leads"       from={fromStr} to={toStr} channel={channel} format="number" />
          <TrendableMetricCard label="MQLs"        value={formatNumber(metrics.mqls, true)}        metric="mqls"        from={fromStr} to={toStr} channel={channel} format="number" pace={pacing.mqls} />
          <TrendableMetricCard label="SQOs"        value={formatNumber(metrics.sqos, true)}        metric="sqos"        from={fromStr} to={toStr} channel={channel} format="number" pace={pacing.sqos} />
          <TrendableMetricCard label="Closed Won"  value={formatNumber(metrics.closedWon, true)}   metric="closedWon"   from={fromStr} to={toStr} channel={channel} format="number" pace={pacing.closedWon} />
        </div>
      </div>

      {/* Funnel chart + conversion rates */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4">Funnel Volume</h2>
          {metrics.hasData ? (
            <FunnelChart data={funnelData} />
          ) : (
            <EmptyState message="No funnel data yet — connect your integrations and run a sync." />
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4">Conversion Rates</h2>
          <div className="space-y-3">
            <ConversionRow
              label="Click-through Rate"
              value={formatPercent(metrics.ctr)}
              from="Impressions"
              to="Clicks"
            />
            <ConversionRow
              label="Lead → MQL"
              value={formatPercent(metrics.leadToMql)}
              from="Lead"
              to="MQL"
            />
            <ConversionRow
              label="MQL → SQO"
              value={formatPercent(metrics.mqlToSqo)}
              from="MQL"
              to="SQO"
            />
            <ConversionRow
              label="SQO → Close"
              value={formatPercent(metrics.sqoToClose)}
              from="SQO"
              to="Closed Won"
            />
          </div>
        </div>
      </div>

      {/* Cost metrics */}
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Cost Metrics</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <TrendableMetricCard label="CPC"          value={formatCurrency(metrics.cpc)}     metric="cpc"     from={fromStr} to={toStr} channel={channel} format="currency" subValue="per click" />
          <TrendableMetricCard label="CPL"          value={formatCurrency(metrics.cpl)}     metric="cpl"     from={fromStr} to={toStr} channel={channel} format="currency" subValue="per lead" />
          <TrendableMetricCard label="Cost per MQL" value={formatCurrency(metrics.cpMql)}   metric="cpMql"   from={fromStr} to={toStr} channel={channel} format="currency" />
          <TrendableMetricCard label="Cost per SQO" value={formatCurrency(metrics.cpSqo)}   metric="cpSqo"   from={fromStr} to={toStr} channel={channel} format="currency" />
          <TrendableMetricCard label="Paid CAC"     value={formatCurrency(metrics.paidCac)} metric="paidCac" from={fromStr} to={toStr} channel={channel} format="currency" />
        </div>
      </div>
    </div>
  );
}

function ConversionRow({
  label,
  value,
  from,
  to,
}: {
  label: string;
  value: string;
  from: string;
  to: string;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-slate-100 last:border-0">
      <div>
        <p className="text-sm font-medium text-slate-700">{label}</p>
        <p className="text-xs text-slate-400">
          {from} → {to}
        </p>
      </div>
      <span className="text-sm font-semibold text-slate-900">{value}</span>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-40 text-center">
      <p className="text-sm text-slate-400 max-w-xs">{message}</p>
    </div>
  );
}
