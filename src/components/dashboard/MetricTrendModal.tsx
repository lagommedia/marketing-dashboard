"use client";

import { useState, useEffect } from "react";
import { X, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { AiInsightPanel } from "@/components/dashboard/AiInsightPanel";
import { ForecastLines, CandleForecast } from "@/components/dashboard/ForecastCandlestick";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Cell,
  Legend,
} from "recharts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrendPeriod {
  label:      string;
  from:       string;
  to:         string;
  periodEnd:  string;   // actual end of the full period (= quarter end, not clamped to today)
  value:      number | null;
  isCurrent:  boolean;
}

interface BreakdownPeriod {
  label:      string;
  from:       string;
  to:         string;
  periodEnd:  string;
  isCurrent:  boolean;
  paid_media: number;
  organic:    number;
  referral:   number;
}

const CHANNEL_COLORS = {
  paid_media: "#7c3aed",
  organic:    "#10b981",
  referral:   "#f59e0b",
} as const;

const CHANNEL_LABELS = {
  paid_media: "Paid Media",
  organic:    "Organic",
  referral:   "Referral",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(v: number | null, format: "currency" | "number"): string {
  if (v == null) return "—";
  if (format === "currency") {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
    return `$${v.toLocaleString()}`;
  }
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`;
  return v.toLocaleString();
}

/** Full-precision formatter used in tooltips — no K/M abbreviation */
function fmtFull(v: number | null, format: "currency" | "number"): string {
  if (v == null) return "—";
  if (format === "currency") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.floor(v));
  }
  return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

function CustomTooltip({
  active, payload, label, format,
}: {
  active?:  boolean;
  payload?: { value: number | null }[];
  label?:   string;
  format:   "currency" | "number";
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg p-3 text-xs min-w-[140px]">
      <p className="font-semibold text-slate-700 mb-1">{label}</p>
      <p className="text-slate-800 font-medium">{fmtFull(payload[0].value, format)}</p>
    </div>
  );
}

function BreakdownTooltip({
  active, payload, label, format,
}: {
  active?:  boolean;
  payload?: { name: string; value: number; color: string }[];
  label?:   string;
  format:   "currency" | "number";
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg p-3 text-xs min-w-[160px]">
      <p className="font-semibold text-slate-700 mb-2">{label}</p>
      {[...payload].reverse().map((p) =>
        p.value > 0 ? (
          <div key={p.name} className="flex items-center justify-between gap-4 mb-1">
            <span className="flex items-center gap-1.5 text-slate-500">
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: p.color }} />
              {CHANNEL_LABELS[p.name as keyof typeof CHANNEL_LABELS] ?? p.name}
            </span>
            <span className="font-medium text-slate-800">{fmtFull(p.value, format)}</span>
          </div>
        ) : null
      )}
      <div className="border-t border-slate-100 mt-2 pt-2 flex justify-between font-semibold text-slate-700">
        <span>Total</span>
        <span>{fmtFull(total, format)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forecast helpers
// ---------------------------------------------------------------------------

interface TrendForecastResult {
  forecast:      CandleForecast;
  daysRemaining: number;   // calendar days left until period end
  daysElapsed:   number;   // calendar days elapsed since period start
  totalDays:     number;   // total days in the full period
  elapsedPct:    number;   // 0-100
}

function computeTrendForecast(period: TrendPeriod | BreakdownPeriod): TrendForecastResult {
  const total =
    "value" in period
      ? (period.value ?? 0)
      : (period as BreakdownPeriod).paid_media + (period as BreakdownPeriod).organic + (period as BreakdownPeriod).referral;

  // Use periodEnd (true quarter / period end) as the denominator, NOT period.to (which is clamped to today)
  const from      = new Date(period.from      + "T00:00:00");
  const periodEnd = new Date(period.periodEnd + "T00:00:00");
  const today     = new Date();

  const totalMs  = periodEnd.getTime() - from.getTime() + 86_400_000;
  const totalDays = Math.round(totalMs / 86_400_000);

  // Elapsed: days since period start, clamped to [1 day, totalDays - 1]
  const elapsedMs   = Math.min(Math.max(today.getTime() - from.getTime(), 86_400_000), totalMs - 86_400_000);
  const daysElapsed = Math.round(elapsedMs / 86_400_000);
  const fraction    = elapsedMs / totalMs;

  // Days remaining until true period end
  const daysRemaining = Math.max(0, Math.ceil((periodEnd.getTime() - today.getTime()) / 86_400_000));

  const projected = total / fraction;
  return {
    forecast: {
      low:  Math.round(projected * 0.80),
      base: Math.round(projected),
      high: Math.round(projected * 1.20),
    },
    daysRemaining,
    daysElapsed,
    totalDays,
    elapsedPct: Math.round(fraction * 100),
  };
}

function fmtShort(v: number, format: "currency" | "number"): string {
  if (format === "currency") {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
    return `$${v}`;
  }
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

// ---------------------------------------------------------------------------
// Source breakdown types (Paid Media Revenue — Paid Search / Paid Social)
// ---------------------------------------------------------------------------

interface SourceTrendPeriod {
  label:       string;
  from:        string;
  to:          string;
  periodEnd:   string;
  isCurrent:   boolean;
  paid_search: number;
  paid_social: number;
  total:       number;
}

const SOURCE_COLORS = {
  paid_search: "#6366f1",
  paid_social: "#7c3aed",
} as const;

const SOURCE_LABELS = {
  paid_search: "Paid Search",
  paid_social: "Paid Social",
} as const;

const SOURCE_ROWS: { key: keyof typeof SOURCE_COLORS; label: string; color: string }[] = [
  { key: "paid_search", label: "Paid Search", color: SOURCE_COLORS.paid_search },
  { key: "paid_social", label: "Paid Social", color: SOURCE_COLORS.paid_social },
];

interface CampaignRevenue { name: string; amount: number; spend?: number; roas?: number; }
interface CampaignData {
  paid_search: CampaignRevenue[];
  paid_social: CampaignRevenue[];
}

// ---------------------------------------------------------------------------
// Module-level AI forecast cache — persists across modal opens within a session
// ---------------------------------------------------------------------------

interface AiForecastCache {
  forecast:  CandleForecast;
  reasoning: string;
}

const aiCache = new Map<string, AiForecastCache>();

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

interface Props {
  open:       boolean;
  onClose:    () => void;
  metric:     string;
  label:      string;
  from:       string;
  to:         string;
  channel:    string;
  format:     "currency" | "number";
  /** When true, fetches paid_media/organic/referral breakdown and shows stacked bars */
  breakdown?: boolean;
}

export function MetricTrendModal({ open, onClose, metric, label, from, to, channel, format, breakdown }: Props) {
  const [data, setData]             = useState<TrendPeriod[] | null>(null);
  const [bdData, setBdData]         = useState<BreakdownPeriod[] | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);

  // Revenue-by-source stacked trend (Paid Media Revenue only)
  const [srcData, setSrcData]               = useState<SourceTrendPeriod[] | null>(null);
  // Which period is selected in the chart / tile grid (null = use isCurrent)
  const [selectedPeriodIdx, setSelectedPeriodIdx] = useState<number | null>(null);
  // Campaign breakdown for accordion (selected period)
  const [campaignData, setCampaignData]     = useState<CampaignData | null>(null);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

  // AI forecast state — layered on top of the math forecast
  const [aiForecast, setAiForecast]               = useState<CandleForecast | null>(null);
  const [aiForecastLoading, setAiForecastLoading] = useState(false);
  const [aiForecastReasoning, setAiForecastReasoning] = useState<string | null>(null);

  // True when this modal should show the Paid Media source-stacked view (Paid Search / Paid Social)
  const SOURCE_MODE_METRICS = new Set(["revenue", "pipeline", "closedWon", "leads", "mqls", "sqos"]);
  const isSourceMode = SOURCE_MODE_METRICS.has(metric) && channel === "paid_media" && !breakdown;

  useEffect(() => {
    if (!open) {
      setData(null); setBdData(null); setSrcData(null); setError(null);
      setAiForecast(null); setAiForecastLoading(false); setAiForecastReasoning(null);
      setCampaignData(null); setExpandedSources(new Set()); setSelectedPeriodIdx(null);
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    setBdData(null);
    setSrcData(null);
    setAiForecast(null);
    setAiForecastReasoning(null);
    setCampaignData(null);
    setExpandedSources(new Set());
    setSelectedPeriodIdx(null);

    if (isSourceMode) {
      // Paid Media Revenue — fetch stacked source trend (Paid Search / Paid Social per period)
      fetch(`/api/metrics/revenue-source-trend?metric=${metric}&from=${from}&to=${to}`)
        .then((r) => r.json())
        .then((d: { periods: SourceTrendPeriod[]; error?: string }) => {
          if (d.error) throw new Error(d.error);
          setSrcData(d.periods);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    } else {
      const url = breakdown
        ? `/api/metrics/trend?metric=${metric}&from=${from}&to=${to}&breakdown=true`
        : `/api/metrics/trend?metric=${metric}&from=${from}&to=${to}&channel=${channel}`;

      fetch(url)
        .then((r) => r.json())
        .then((d: { periods: (TrendPeriod | BreakdownPeriod)[]; breakdown?: boolean; error?: string }) => {
          if (d.error) throw new Error(d.error);
          if (d.breakdown) {
            setBdData(d.periods as BreakdownPeriod[]);
          } else {
            setData(d.periods as TrendPeriod[]);
          }
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    }
  }, [open, metric, from, to, channel, breakdown, isSourceMode]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);


  // Fetch campaign breakdown for the selected (or current) period
  useEffect(() => {
    if (!isSourceMode || !srcData) return;
    const period = selectedPeriodIdx !== null
      ? srcData[selectedPeriodIdx]
      : srcData.find((p) => p.isCurrent);
    if (!period) return;
    setCampaignLoading(true);
    setCampaignData(null);
    setExpandedSources(new Set());
    fetch(`/api/metrics/revenue-source?metric=${metric}&from=${period.from}&to=${period.to}`)
      .then((r) => r.json())
      .then((d: { campaigns?: CampaignData; error?: string }) => {
        if (d.error) throw new Error(d.error);
        if (d.campaigns) setCampaignData(d.campaigns);
      })
      .catch(() => setCampaignData(null))
      .finally(() => setCampaignLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSourceMode, srcData, selectedPeriodIdx]);

  // Restore cached AI forecast when chart data arrives (no API call)
  const cacheKey = `${metric}|${from}|${to}|${channel}|${breakdown ? "bd" : "single"}`;
  useEffect(() => {
    const periods = data ?? bdData ?? srcData;
    if (!periods) return;
    const cached = aiCache.get(cacheKey);
    if (cached) {
      setAiForecast(cached.forecast);
      setAiForecastReasoning(cached.reasoning);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, bdData, srcData]);

  // Manually triggered AI forecast — called by the "Run AI Analysis" button
  function runAiAnalysis() {
    const periods = data ?? bdData ?? srcData;
    if (!periods || aiForecastLoading) return;

    const curPeriod = periods.find((p) => p.isCurrent);
    if (!curPeriod) return;

    const currentTotal =
      "total" in curPeriod
        ? (curPeriod as SourceTrendPeriod).total
        : "value" in curPeriod
        ? (curPeriod.value ?? 0)
        : (curPeriod as BreakdownPeriod).paid_media +
          (curPeriod as BreakdownPeriod).organic +
          (curPeriod as BreakdownPeriod).referral;

    // Adapt srcData to the TrendPeriod shape expected by computeTrendForecast
    const forecastPeriod: TrendPeriod = "total" in curPeriod
      ? { ...(curPeriod as SourceTrendPeriod), value: (curPeriod as SourceTrendPeriod).total }
      : (curPeriod as TrendPeriod);
    const pacing = computeTrendForecast(forecastPeriod);

    const historicalData = periods.map((p) => ({
      label:     p.label,
      value:     "total" in p
        ? (p as SourceTrendPeriod).total
        : "value" in p
        ? (p.value ?? 0)
        : (p as BreakdownPeriod).paid_media + (p as BreakdownPeriod).organic + (p as BreakdownPeriod).referral,
      isCurrent: p.isCurrent,
    }));

    setAiForecastLoading(true);
    setAiForecast(null);
    setAiForecastReasoning(null);

    fetch("/api/ai/forecast", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        metric:        label,
        format,
        historicalData,
        currentTotal,
        daysElapsed:   pacing.daysElapsed,
        totalDays:     pacing.totalDays,
        daysRemaining: pacing.daysRemaining,
        periodLabel:   curPeriod.label,
      }),
    })
      .then((r) => r.json())
      .then((d: { conservative: number; base: number; optimistic: number; reasoning: string; error?: string }) => {
        if (d.error) throw new Error(d.error);
        const result = { forecast: { low: d.conservative, base: d.base, high: d.optimistic }, reasoning: d.reasoning };
        aiCache.set(cacheKey, result);
        setAiForecast(result.forecast);
        setAiForecastReasoning(result.reasoning);
      })
      .catch(() => { /* silently fall back to math forecast */ })
      .finally(() => setAiForecastLoading(false));
  }

  if (!open) return null;

  // Angle labels when they're long (date ranges) OR quarterly (12 × "Q3 2023" = ~50 px each)
  const firstLabel = (data ?? bdData)?.[0]?.label ?? "";
  const needsAngle = firstLabel.includes("–") || /^Q\d /.test(firstLabel);

  const commonAxisProps = {
    axisLine: false as const,
    tickLine: false as const,
    tick: { fontSize: 11, fill: "#94a3b8" },
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-3xl flex flex-col max-h-[90vh]">
        {/* Header — stays pinned while content scrolls */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">{label} — Trend</h3>
            <p className="text-xs text-slate-400 mt-0.5">12 periods · selected range highlighted</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="p-6 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-64 gap-2 text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-64 text-red-500 text-sm">
              {error}
            </div>
          )}

          {/* ── Source stacked mode (Paid Media Revenue) ── */}
          {srcData && !loading && (() => {
            // The "real" current period is always isCurrent — used for forecasting
            const currentIdx   = srcData.findIndex((p) => p.isCurrent);
            const effectiveIdx = selectedPeriodIdx ?? (currentIdx >= 0 ? currentIdx : srcData.length - 1);
            const displayPeriod = srcData[effectiveIdx];
            const curPeriod     = srcData[currentIdx]; // always the real current period
            const isCurrentSelected = effectiveIdx === currentIdx;

            const trendPeriod: TrendPeriod | undefined = curPeriod
              ? { ...curPeriod, value: curPeriod.total }
              : undefined;
            const result     = trendPeriod ? computeTrendForecast(trendPeriod) : null;
            const fc         = aiForecast ?? result?.forecast ?? null;
            const yDomainMax = fc ? (v: number) => Math.max(v, fc.high * 1.08) : "auto";

            return (
            <>
              <ResponsiveContainer width="100%" height={290}>
                <BarChart
                  data={srcData}
                  margin={{ top: 12, right: 80, left: 8, bottom: needsAngle ? 44 : 4 }}
                  barCategoryGap="30%"
                  style={{ cursor: "pointer" }}
                  onClick={(state) => {
                    if (state?.activeTooltipIndex != null) {
                      setSelectedPeriodIdx(Number(state.activeTooltipIndex));
                    }
                  }}
                >
                  <CartesianGrid vertical={false} stroke="#f1f5f9" />
                  <XAxis
                    dataKey="label"
                    {...commonAxisProps}
                    interval={0}
                    angle={needsAngle ? -35 : 0}
                    textAnchor={needsAngle ? "end" : "middle"}
                    height={needsAngle ? 54 : 28}
                  />
                  <YAxis
                    tickFormatter={(v) => fmt(v, format)}
                    {...commonAxisProps}
                    width={64}
                    domain={[0, yDomainMax]}
                  />
                  <Tooltip
                    content={
                      <BreakdownTooltip format={format} />
                    }
                    cursor={{ fill: "#f8fafc" }}
                  />
                  <Legend
                    iconType="square"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                    formatter={(value) => SOURCE_LABELS[value as keyof typeof SOURCE_LABELS] ?? value}
                  />
                  {(["paid_search", "paid_social"] as const).map((key, i, arr) => (
                    <Bar
                      key={key}
                      dataKey={key}
                      stackId="a"
                      fill={SOURCE_COLORS[key]}
                      radius={i === arr.length - 1 ? [3, 3, 0, 0] : undefined}
                    >
                      {srcData.map((p, idx) => (
                        <Cell
                          key={p.label}
                          fill={idx === effectiveIdx ? SOURCE_COLORS[key] : `${SOURCE_COLORS[key]}55`}
                        />
                      ))}
                    </Bar>
                  ))}

                  {fc && trendPeriod && (
                    <ForecastLines
                      periodLabel={trendPeriod.label}
                      forecast={fc}
                      format={format}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>

              {/* Period grid — clickable tiles */}
              <div className="grid grid-cols-6 gap-1.5 mt-4">
                {srcData.map((p, idx) => {
                  const isSelected = idx === effectiveIdx;
                  return (
                    <button
                      key={p.label}
                      onClick={() => setSelectedPeriodIdx(idx)}
                      className={`text-center rounded-lg py-2 px-1.5 transition-colors ${
                        isSelected
                          ? "bg-indigo-50 border border-indigo-200 ring-1 ring-indigo-300"
                          : "bg-slate-50 hover:bg-slate-100 border border-transparent"
                      }`}
                    >
                      <p className="text-[9px] text-slate-400 truncate leading-tight">{p.label}</p>
                      <p className={`text-[11px] font-semibold mt-0.5 ${isSelected ? "text-indigo-700" : "text-slate-700"}`}>
                        {fmt(p.total, format)}
                      </p>
                      {p.isCurrent && fc && (
                        <p className="text-[9px] text-indigo-400 mt-0.5">→ {fmtShort(fc.base, format)}</p>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Revenue by Source — selected period with campaign accordion */}
              {displayPeriod && (
                <div className="mt-3 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                      {label.replace(" (Closed Won)", "").replace(" Generated", "")} by Source — {displayPeriod.label}
                    </p>
                    {campaignLoading && (
                      <span className="flex items-center gap-1 text-[9px] text-slate-400">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" /> Loading campaigns…
                      </span>
                    )}
                  </div>
                  <div className="space-y-3">
                    {SOURCE_ROWS.map(({ key, label: srcLabel, color }) => {
                      const value    = displayPeriod[key];
                      const pct      = displayPeriod.total > 0 ? (value / displayPeriod.total) * 100 : 0;
                      const campaigns = campaignData?.[key] ?? [];
                      const isExpanded = expandedSources.has(key);
                      // Always allow expanding — show spinner inside if still loading
                      const canExpand  = campaigns.length > 0 || campaignLoading;

                      return (
                        <div key={key}>
                          {/* Source row — always clickable; shows spinner while campaigns load */}
                          <button
                            onClick={() => {
                              setExpandedSources((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key); else next.add(key);
                                return next;
                              });
                            }}
                            className="w-full text-left cursor-pointer"
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="flex items-center gap-1.5 text-[11px] text-slate-600">
                                {canExpand ? (
                                  isExpanded
                                    ? <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
                                    : <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />
                                ) : (
                                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
                                )}
                                {canExpand && (
                                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
                                )}
                                {srcLabel}
                              </span>
                              <span className="text-[11px] font-semibold text-slate-800">
                                {fmtFull(value, format)}
                                <span className="ml-1.5 text-[9px] font-normal text-slate-400">
                                  {pct.toFixed(0)}%
                                </span>
                              </span>
                            </div>
                            <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all duration-500"
                                style={{ width: `${pct}%`, background: color }}
                              />
                            </div>
                          </button>

                          {/* Campaign accordion */}
                          {isExpanded && (campaignLoading || campaigns.length > 0) && (
                            <div className="mt-2 ml-5 space-y-1.5 border-l-2 pl-3" style={{ borderColor: `${color}40` }}>
                              {campaignLoading && campaigns.length === 0 && (
                                <div className="flex items-center gap-1.5 text-[10px] text-slate-400 py-1">
                                  <Loader2 className="w-3 h-3 animate-spin" /> Loading campaigns…
                                </div>
                              )}
                              {campaigns.map((c) => {
                                const cPct = value > 0 ? (c.amount / value) * 100 : 0;
                                return (
                                  <div key={c.name} className="flex items-center justify-between gap-2">
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center justify-between mb-0.5">
                                        <span className="text-[10px] text-slate-600 truncate max-w-[160px]" title={c.name}>
                                          {c.name}
                                        </span>
                                        <div className="flex items-center gap-2 ml-2 shrink-0">
                                          {c.roas != null && (
                                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                                              {c.roas.toFixed(1)}x ROAS
                                            </span>
                                          )}
                                          {c.spend != null && (
                                            <span className="text-[9px] text-slate-400">
                                              {fmtFull(c.spend, "currency")} spend
                                            </span>
                                          )}
                                          <span className="text-[10px] font-semibold text-slate-700">
                                            {fmtFull(c.amount, format)}
                                            <span className="ml-1 text-[9px] font-normal text-slate-400">{cPct.toFixed(0)}%</span>
                                          </span>
                                        </div>
                                      </div>
                                      <div className="h-1 rounded-full bg-slate-200 overflow-hidden">
                                        <div
                                          className="h-full rounded-full"
                                          style={{ width: `${cPct}%`, background: `${color}99` }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div className="flex justify-between border-t border-slate-200 pt-2 mt-1">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Total</span>
                      <span className="text-[11px] font-bold text-slate-800">{fmtFull(displayPeriod.total, format)}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Pacing footer — only for the real current period */}
              {isCurrentSelected && result && fc && (
                <div className="mt-3 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                      {trendPeriod?.label} End-of-Quarter Forecast
                      {aiForecast && !aiForecastLoading && (
                        <span className="inline-flex items-center gap-1 bg-indigo-100 text-indigo-600 rounded-full px-1.5 py-0.5 text-[9px] font-semibold normal-case tracking-normal">
                          ✦ AI-powered
                        </span>
                      )}
                      {aiForecastLoading && (
                        <span className="flex items-center gap-1 text-slate-400 font-normal normal-case tracking-normal">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" /> Analyzing…
                        </span>
                      )}
                      {!aiForecast && !aiForecastLoading && (
                        <button
                          onClick={runAiAnalysis}
                          className="inline-flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-full px-2 py-0.5 text-[9px] font-semibold normal-case tracking-normal transition-colors"
                        >
                          ✦ Run AI Analysis
                        </button>
                      )}
                      {aiForecast && !aiForecastLoading && (
                        <button
                          onClick={runAiAnalysis}
                          className="text-[9px] text-slate-400 hover:text-indigo-500 font-normal normal-case tracking-normal transition-colors"
                        >
                          ↺ Refresh
                        </button>
                      )}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {result.daysElapsed} / {result.totalDays} days elapsed ({result.elapsedPct}%)
                      &nbsp;·&nbsp;
                      <span className="font-semibold text-indigo-500">{result.daysRemaining} days remaining</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-5">
                    <span className="flex items-center gap-1.5 text-[11px] text-amber-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-dashed border-amber-500" /></span>
                      Conservative &nbsp;<span className="font-bold">{fmtShort(fc.low, format)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-indigo-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-indigo-600" /></span>
                      Base &nbsp;<span className="font-bold">{fmtShort(fc.base, format)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-emerald-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-dashed border-emerald-500" /></span>
                      Optimistic &nbsp;<span className="font-bold">{fmtShort(fc.high, format)}</span>
                    </span>
                  </div>
                  {aiForecastReasoning && (
                    <p className="mt-2 text-[10px] text-slate-500 leading-relaxed border-t border-slate-200 pt-2">
                      {aiForecastReasoning}
                    </p>
                  )}
                </div>
              )}
            </>
            );
          })()}

          {/* ── Breakdown (stacked) mode ── */}
          {bdData && !loading && (() => {
            const curPeriod = bdData.find((p) => p.isCurrent);
            const result    = curPeriod ? computeTrendForecast(curPeriod) : null;
            // Overlay AI forecast when available; fall back to math forecast
            const fc        = aiForecast ?? result?.forecast ?? null;
            // Ensure the Y-axis always reaches at least the Optimistic forecast so the notches are visible
            const yDomainMax = fc
              ? (v: number) => Math.max(v, fc.high * 1.08)
              : "auto";

            return (
            <>
              <ResponsiveContainer width="100%" height={290}>
                <BarChart
                  data={bdData}
                  margin={{ top: 12, right: 80, left: 8, bottom: needsAngle ? 44 : 4 }}
                  barCategoryGap="30%"
                >
                  <CartesianGrid vertical={false} stroke="#f1f5f9" />
                  <XAxis
                    dataKey="label"
                    {...commonAxisProps}
                    interval={0}
                    angle={needsAngle ? -35 : 0}
                    textAnchor={needsAngle ? "end" : "middle"}
                    height={needsAngle ? 54 : 28}
                  />
                  <YAxis
                    tickFormatter={(v) => fmt(v, format)}
                    {...commonAxisProps}
                    width={64}
                    domain={[0, yDomainMax]}
                  />
                  <Tooltip content={<BreakdownTooltip format={format} />} cursor={{ fill: "#f8fafc" }} />
                  <Legend
                    iconType="square"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                    formatter={(value) => CHANNEL_LABELS[value as keyof typeof CHANNEL_LABELS] ?? value}
                  />
                  {(["paid_media", "organic", "referral"] as const).map((ch, i, arr) => (
                    <Bar
                      key={ch}
                      dataKey={ch}
                      stackId="a"
                      fill={CHANNEL_COLORS[ch]}
                      radius={i === arr.length - 1 ? [3, 3, 0, 0] : undefined}
                    >
                      {bdData.map((p) => (
                        <Cell
                          key={p.label}
                          fill={p.isCurrent ? CHANNEL_COLORS[ch] : `${CHANNEL_COLORS[ch]}99`}
                        />
                      ))}
                    </Bar>
                  ))}

                  {/* Forecast lines — direct child, v3 hooks pull axis scales */}
                  {fc && curPeriod && (
                    <ForecastLines
                      periodLabel={curPeriod.label}
                      forecast={fc}
                      format={format}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>

              {/* Period grid */}
              <div className="grid grid-cols-6 gap-1.5 mt-4">
                {bdData.map((p) => {
                  const total = p.paid_media + p.organic + p.referral;
                  return (
                    <div
                      key={p.label}
                      className={`text-center rounded-lg py-2 px-1.5 ${
                        p.isCurrent ? "bg-indigo-50 border border-indigo-100" : "bg-slate-50"
                      }`}
                    >
                      <p className="text-[9px] text-slate-400 truncate leading-tight">{p.label}</p>
                      <p className={`text-[11px] font-semibold mt-0.5 ${p.isCurrent ? "text-indigo-700" : "text-slate-700"}`}>
                        {fmt(total, format)}
                      </p>
                      {p.isCurrent && fc && (
                        <p className="text-[9px] text-indigo-400 mt-0.5">→ {fmtShort(fc.base, format)}</p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Pacing footer */}
              {result && fc && (
                <div className="mt-3 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                      {curPeriod?.label} End-of-Quarter Forecast
                      {aiForecast && !aiForecastLoading && (
                        <span className="inline-flex items-center gap-1 bg-indigo-100 text-indigo-600 rounded-full px-1.5 py-0.5 text-[9px] font-semibold normal-case tracking-normal">
                          ✦ AI-powered
                        </span>
                      )}
                      {aiForecastLoading && (
                        <span className="flex items-center gap-1 text-slate-400 font-normal normal-case tracking-normal">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" /> Analyzing…
                        </span>
                      )}
                      {!aiForecast && !aiForecastLoading && (
                        <button
                          onClick={runAiAnalysis}
                          className="inline-flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-full px-2 py-0.5 text-[9px] font-semibold normal-case tracking-normal transition-colors"
                        >
                          ✦ Run AI Analysis
                        </button>
                      )}
                      {aiForecast && !aiForecastLoading && (
                        <button
                          onClick={runAiAnalysis}
                          className="text-[9px] text-slate-400 hover:text-indigo-500 font-normal normal-case tracking-normal transition-colors"
                        >
                          ↺ Refresh
                        </button>
                      )}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {result.daysElapsed} / {result.totalDays} days elapsed ({result.elapsedPct}%)
                      &nbsp;·&nbsp;
                      <span className="font-semibold text-indigo-500">{result.daysRemaining} days remaining</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-5">
                    <span className="flex items-center gap-1.5 text-[11px] text-amber-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-dashed border-amber-500" /></span>
                      Conservative &nbsp;<span className="font-bold">{fmtShort(fc.low, format)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-indigo-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-indigo-600" /></span>
                      Base &nbsp;<span className="font-bold">{fmtShort(fc.base, format)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-emerald-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-dashed border-emerald-500" /></span>
                      Optimistic &nbsp;<span className="font-bold">{fmtShort(fc.high, format)}</span>
                    </span>
                  </div>
                  {aiForecastReasoning && (
                    <p className="mt-2 text-[10px] text-slate-500 leading-relaxed border-t border-slate-200 pt-2">
                      {aiForecastReasoning}
                    </p>
                  )}
                </div>
              )}
            </>
            );
          })()}

          {/* ── Single-series mode ── */}
          {data && !loading && (() => {
            const curPeriod = data.find((p) => p.isCurrent);
            const result    = curPeriod && curPeriod.value != null ? computeTrendForecast(curPeriod) : null;
            // Overlay AI forecast when available; fall back to math forecast
            const fc        = aiForecast ?? result?.forecast ?? null;
            const yDomainMax = fc
              ? (v: number) => Math.max(v, fc.high * 1.08)
              : "auto";

            return (
            <>
              <ResponsiveContainer width="100%" height={290}>
                <BarChart
                  data={data}
                  margin={{ top: 12, right: 80, left: 8, bottom: needsAngle ? 44 : 4 }}
                  barCategoryGap="30%"
                >
                  <CartesianGrid vertical={false} stroke="#f1f5f9" />
                  <XAxis
                    dataKey="label"
                    {...commonAxisProps}
                    interval={0}
                    angle={needsAngle ? -35 : 0}
                    textAnchor={needsAngle ? "end" : "middle"}
                    height={needsAngle ? 54 : 28}
                  />
                  <YAxis
                    tickFormatter={(v) => fmt(v, format)}
                    {...commonAxisProps}
                    width={64}
                    domain={[0, yDomainMax]}
                  />
                  <Tooltip
                    content={<CustomTooltip format={format} />}
                    cursor={{ fill: "#f8fafc" }}
                  />
                  <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                    {data.map((p) => (
                      <Cell key={p.label} fill={p.isCurrent ? "#6366f1" : "#c7d2fe"} />
                    ))}
                  </Bar>

                  {/* Forecast lines — direct child, v3 hooks pull axis scales */}
                  {fc && curPeriod && (
                    <ForecastLines
                      periodLabel={curPeriod.label}
                      forecast={fc}
                      format={format}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>

              {/* Period grid — 6 columns × 2 rows */}
              <div className="grid grid-cols-6 gap-1.5 mt-4">
                {data.map((p) => (
                  <div
                    key={p.label}
                    className={`text-center rounded-lg py-2 px-1.5 ${
                      p.isCurrent ? "bg-indigo-50 border border-indigo-100" : "bg-slate-50"
                    }`}
                  >
                    <p className="text-[9px] text-slate-400 truncate leading-tight">{p.label}</p>
                    <p className={`text-[11px] font-semibold mt-0.5 ${p.isCurrent ? "text-indigo-700" : "text-slate-700"}`}>
                      {fmt(p.value, format)}
                    </p>
                    {p.isCurrent && fc && (
                      <p className="text-[9px] text-indigo-400 mt-0.5">→ {fmtShort(fc.base, format)}</p>
                    )}
                  </div>
                ))}
              </div>

              {/* Pacing footer */}
              {result && fc && (
                <div className="mt-3 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                      {curPeriod?.label} End-of-Quarter Forecast
                      {aiForecast && !aiForecastLoading && (
                        <span className="inline-flex items-center gap-1 bg-indigo-100 text-indigo-600 rounded-full px-1.5 py-0.5 text-[9px] font-semibold normal-case tracking-normal">
                          ✦ AI-powered
                        </span>
                      )}
                      {aiForecastLoading && (
                        <span className="flex items-center gap-1 text-slate-400 font-normal normal-case tracking-normal">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" /> Analyzing…
                        </span>
                      )}
                      {!aiForecast && !aiForecastLoading && (
                        <button
                          onClick={runAiAnalysis}
                          className="inline-flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-full px-2 py-0.5 text-[9px] font-semibold normal-case tracking-normal transition-colors"
                        >
                          ✦ Run AI Analysis
                        </button>
                      )}
                      {aiForecast && !aiForecastLoading && (
                        <button
                          onClick={runAiAnalysis}
                          className="text-[9px] text-slate-400 hover:text-indigo-500 font-normal normal-case tracking-normal transition-colors"
                        >
                          ↺ Refresh
                        </button>
                      )}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {result.daysElapsed} / {result.totalDays} days elapsed ({result.elapsedPct}%)
                      &nbsp;·&nbsp;
                      <span className="font-semibold text-indigo-500">{result.daysRemaining} days remaining</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-5">
                    <span className="flex items-center gap-1.5 text-[11px] text-amber-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-dashed border-amber-500" /></span>
                      Conservative &nbsp;<span className="font-bold">{fmtShort(fc.low, format)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-indigo-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-indigo-600" /></span>
                      Base &nbsp;<span className="font-bold">{fmtShort(fc.base, format)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-emerald-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-dashed border-emerald-500" /></span>
                      Optimistic &nbsp;<span className="font-bold">{fmtShort(fc.high, format)}</span>
                    </span>
                  </div>
                  {aiForecastReasoning && (
                    <p className="mt-2 text-[10px] text-slate-500 leading-relaxed border-t border-slate-200 pt-2">
                      {aiForecastReasoning}
                    </p>
                  )}
                </div>
              )}
            </>
            );
          })()}
        </div>

        {/* AI Insight Panel — only shown once data is loaded */}
        {(data || bdData || srcData) && !loading && (
          <AiInsightPanel
            payload={{
              cardLabel: label,
              metric,
              format,
              channel,
              periods: (bdData ?? srcData ?? data) as unknown[],
            }}
          />
        )}
      </div>
    </div>
  );
}
