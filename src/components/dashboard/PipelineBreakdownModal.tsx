"use client";

import { useState, useEffect, useRef } from "react";
import { X, Loader2 } from "lucide-react";
import { AiInsightPanel } from "@/components/dashboard/AiInsightPanel";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import type { PipelineBreakdownResult } from "@/lib/integrations/hubspot";
import { ForecastLines, CandleForecast } from "@/components/dashboard/ForecastCandlestick";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

/** Full-precision formatter for tooltips — no K/M abbreviation */
function fmtFull(v: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.floor(v));
}

function fmtShort(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v}`;
}

const SEGMENT_CONFIG = [
  { key: "Starter",    color: "#a5b4fc" },
  { key: "Discovery",  color: "#818cf8" },
  { key: "Growth",     color: "#6366f1" },
  { key: "Enterprise", color: "#4338ca" },
  { key: "Other",      color: "#cbd5e1" },
] as const;

const CHANNEL_TABS = [
  { key: "all",        label: "All" },
  { key: "paid_media", label: "Paid Media" },
  { key: "organic",    label: "Organic" },
  { key: "referral",   label: "Referral" },
] as const;

type ChannelKey = (typeof CHANNEL_TABS)[number]["key"];

// ---------------------------------------------------------------------------
// Forecast helpers
// ---------------------------------------------------------------------------

function currentQuarterLabel(): string {
  const now = new Date();
  return `Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`;
}

interface ForecastResult {
  forecast:      CandleForecast;
  daysRemaining: number;
  daysElapsed:   number;
  totalDays:     number;
  elapsedPct:    number;
}

function computeForecast(currentTotal: number): ForecastResult {
  const now   = new Date();
  const year  = now.getFullYear();
  const q     = Math.floor(now.getMonth() / 3);
  const start = new Date(year, q * 3, 1);
  const end   = new Date(year, q * 3 + 3, 0);  // last day of quarter

  const totalMs      = end.getTime() - start.getTime() + 86_400_000;
  const totalDays    = Math.round(totalMs / 86_400_000);
  const elapsedMs    = Math.min(Math.max(now.getTime() - start.getTime(), 86_400_000), totalMs - 86_400_000);
  const daysElapsed  = Math.round(elapsedMs / 86_400_000);
  const fraction     = elapsedMs / totalMs;
  const daysRemaining = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));

  const projected = currentTotal / fraction;
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

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function CustomTooltip({ active, payload, label }: {
  active?:  boolean;
  payload?: { name: string; value: number; color: string }[];
  label?:   string;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg p-3 text-xs min-w-[160px]">
      <p className="font-semibold text-slate-700 mb-2">{label}</p>
      {[...payload].reverse().map((p) => (
        p.value > 0 && (
          <div key={p.name} className="flex items-center justify-between gap-4 mb-1">
            <span className="flex items-center gap-1.5 text-slate-500">
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: p.color }} />
              {p.name}
            </span>
            <span className="font-medium text-slate-800">{fmtFull(p.value)}</span>
          </div>
        )
      ))}
      <div className="border-t border-slate-100 mt-2 pt-2 flex justify-between font-semibold text-slate-700">
        <span>Total</span>
        <span>{fmtFull(total)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

interface Props {
  open:            boolean;
  onClose:         () => void;
  url:             string;
  title:           string;
  subtitle:        string;
  /** Pre-select a channel tab when the modal opens. Defaults to "all". */
  initialChannel?: ChannelKey;
}

// Module-level AI forecast cache for pipeline breakdown — keyed by url+channel
const pipelineAiCache = new Map<string, { forecast: CandleForecast; reasoning: string }>();

export function PipelineBreakdownModal({ open, onClose, url, title, subtitle, initialChannel = "all" }: Props) {
  const [channel, setChannel] = useState<ChannelKey>(initialChannel);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [data, setData]       = useState<PipelineBreakdownResult | null>(null);

  // AI forecast state
  const [aiForecast, setAiForecast]               = useState<CandleForecast | null>(null);
  const [aiForecastLoading, setAiForecastLoading] = useState(false);
  const [aiForecastReasoning, setAiForecastReasoning] = useState<string | null>(null);

  const cache = useRef<Partial<Record<ChannelKey, PipelineBreakdownResult>>>({});

  useEffect(() => {
    if (!open) {
      setChannel(initialChannel);
      cache.current = {};
      setData(null);
      setError(null);
      setAiForecast(null);
      setAiForecastLoading(false);
      setAiForecastReasoning(null);
    }
  }, [open, initialChannel]);

  useEffect(() => {
    if (!open) return;
    // Restore cached AI forecast (or clear stale one) when channel changes
    const aiKey = `${url}|${channel}`;
    const cached = pipelineAiCache.get(aiKey);
    if (cached) {
      setAiForecast(cached.forecast);
      setAiForecastReasoning(cached.reasoning);
    } else {
      setAiForecast(null);
      setAiForecastReasoning(null);
    }
    if (cache.current[channel]) { setData(cache.current[channel]!); return; }
    setLoading(true);
    setError(null);
    const fetchUrl = channel === "all" ? url : `${url}&channel=${channel}`;
    fetch(fetchUrl)
      .then((r) => r.json())
      .then((d: PipelineBreakdownResult & { error?: string }) => {
        if (d.error) throw new Error(d.error);
        cache.current[channel] = d;
        setData(d);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open, url, channel]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);

  // Manually triggered AI forecast
  function runAiAnalysis() {
    if (!data || aiForecastLoading) return;

    const curLabel = currentQuarterLabel();
    const curRow   = data.byQuarter.find((r) => r.quarter === curLabel);
    if (!curRow) return;

    const currentTotal    = curRow.total;
    const { daysElapsed, totalDays, daysRemaining } = computeForecast(currentTotal);

    const historicalData = data.byQuarter.map((row) => ({
      label:     row.quarter,
      value:     row.total,
      isCurrent: row.quarter === curLabel,
    }));

    const CHANNEL_LABEL_MAP: Record<ChannelKey, string> = {
      all:        "",
      paid_media: " — Paid Media",
      organic:    " — Organic",
      referral:   " — Referral",
    };
    const metricLabel = `${title}${CHANNEL_LABEL_MAP[channel]}`;

    setAiForecastLoading(true);
    setAiForecast(null);
    setAiForecastReasoning(null);

    fetch("/api/ai/forecast", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        metric:        metricLabel,
        format:        "currency",
        historicalData,
        currentTotal,
        daysElapsed,
        totalDays,
        daysRemaining,
        periodLabel:   curLabel,
      }),
    })
      .then((r) => r.json())
      .then((d: { conservative: number; base: number; optimistic: number; reasoning: string; error?: string }) => {
        if (d.error) throw new Error(d.error);
        const result = { forecast: { low: d.conservative, base: d.base, high: d.optimistic }, reasoning: d.reasoning };
        pipelineAiCache.set(`${url}|${channel}`, result);
        setAiForecast(result.forecast);
        setAiForecastReasoning(result.reasoning);
      })
      .catch(() => { /* silently fall back to math forecast */ })
      .finally(() => setAiForecastLoading(false));
  }

  if (!open) return null;

  // Compute forecast for current quarter (if present in data)
  const curLabel    = currentQuarterLabel();
  const curRow      = data?.byQuarter.find((r) => r.quarter === curLabel);
  const forecastResult = curRow ? computeForecast(curRow.total) : null;
  // Overlay AI forecast when available; fall back to math forecast
  const fc          = aiForecast ?? forecastResult?.forecast ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
            <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        {/* Channel toggle tabs — pinned below header */}
        <div className="flex items-center gap-1 px-6 pt-4 shrink-0">
          {CHANNEL_TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setChannel(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                channel === key
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "bg-slate-100 text-slate-500 hover:bg-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body — scrollable */}
        <div className="p-6 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-56 gap-2 text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-56 text-red-500 text-sm">{error}</div>
          )}

          {data && !loading && (
            <>
              {/* Segment summary pills */}
              <div className="flex flex-wrap gap-2 mb-6">
                {data.bySegment.filter((s) => s.total > 0).map(({ segment, total }) => {
                  const cfg = SEGMENT_CONFIG.find((c) => c.key === segment);
                  return (
                    <div key={segment} className="flex items-center gap-2 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: cfg?.color ?? "#94a3b8" }} />
                      <span className="text-xs text-slate-500">{segment}</span>
                      <span className="text-xs font-semibold text-slate-800">{fmt(total)}</span>
                    </div>
                  );
                })}
                <div className="flex items-center gap-2 bg-slate-900 rounded-lg px-3 py-2 ml-auto">
                  <span className="text-xs text-slate-400">Total</span>
                  <span className="text-xs font-bold text-white">{fmt(data.grandTotal)}</span>
                </div>
              </div>

              {/* Stacked bar chart + forecast candlestick */}
              <ResponsiveContainer width="100%" height={290}>
                <BarChart
                  data={data.byQuarter}
                  margin={{ top: 12, right: 80, left: 8, bottom: 44 }}
                  barCategoryGap="35%"
                >
                  <CartesianGrid vertical={false} stroke="#f1f5f9" />
                  <XAxis
                    dataKey="quarter"
                    tick={{ fontSize: 11, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    interval={0}
                    angle={-35}
                    textAnchor="end"
                    height={54}
                  />
                  <YAxis
                    tickFormatter={fmt}
                    tick={{ fontSize: 11, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                    domain={[0, fc ? (v: number) => Math.max(v, fc.high * 1.08) : "auto"]}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "#f8fafc" }} />
                  <Legend
                    iconType="square"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                  />
                  {(() => {
                    const visible = SEGMENT_CONFIG.filter(({ key }) =>
                      data.bySegment.find((s) => s.segment === key && s.total > 0)
                    );
                    return visible.map(({ key, color }, i) => (
                      <Bar
                        key={key}
                        dataKey={key}
                        name={key}
                        stackId="a"
                        fill={color}
                        radius={i === visible.length - 1 ? [3, 3, 0, 0] : undefined}
                      />
                    ));
                  })()}

                  {/* Forecast lines — direct child, v3 hooks pull axis scales */}
                  {fc && (
                    <ForecastLines
                      periodLabel={curLabel}
                      forecast={fc}
                      format="currency"
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>

              {/* Quarter totals grid — current quarter highlighted */}
              <div className="grid grid-cols-6 gap-2 mt-4">
                {data.byQuarter.map((row) => {
                  const isCur = row.quarter === curLabel;
                  return (
                    <div
                      key={row.quarter}
                      className={`text-center rounded-lg py-2 px-3 ${
                        isCur
                          ? "bg-indigo-50 border border-indigo-100"
                          : "bg-slate-50"
                      }`}
                    >
                      <p className={`text-[11px] ${isCur ? "text-indigo-400" : "text-slate-400"}`}>
                        {row.quarter}
                      </p>
                      <p className={`text-sm font-semibold mt-0.5 ${isCur ? "text-indigo-700" : "text-slate-700"}`}>
                        {fmt(row.total)}
                      </p>
                      {isCur && fc && (
                        <p className="text-[10px] text-indigo-400 mt-0.5">
                          → {fmtShort(fc.base)}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Pacing footer */}
              {forecastResult && fc && (
                <div className="mt-3 rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide">
                      {curLabel} End-of-Quarter Forecast
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
                      {forecastResult.daysElapsed} / {forecastResult.totalDays} days elapsed ({forecastResult.elapsedPct}%)
                      &nbsp;·&nbsp;
                      <span className="font-semibold text-indigo-500">{forecastResult.daysRemaining} days remaining</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-5">
                    <span className="flex items-center gap-1.5 text-[11px] text-amber-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-dashed border-amber-500" /></span>
                      Conservative &nbsp;<span className="font-bold">{fmtShort(fc.low)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-indigo-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-indigo-600" /></span>
                      Base &nbsp;<span className="font-bold">{fmtShort(fc.base)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-emerald-700">
                      <span className="inline-flex w-6 items-center"><span className="w-full h-0 border-t-2 border-dashed border-emerald-500" /></span>
                      Optimistic &nbsp;<span className="font-bold">{fmtShort(fc.high)}</span>
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
          )}
        </div>

        {/* AI Insight Panel */}
        {data && !loading && (
          <AiInsightPanel
            payload={{
              cardLabel:  title,
              channel:    channel,
              bySegment:  data.bySegment as unknown[],
              byQuarter:  data.byQuarter as unknown[],
              grandTotal: data.grandTotal,
            }}
          />
        )}
      </div>
    </div>
  );
}
