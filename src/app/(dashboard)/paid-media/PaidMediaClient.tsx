"use client";

import { useState, useEffect, useCallback } from "react";
import {
  AreaChart, Area,
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from "recharts";
import {
  RefreshCw, Megaphone, TrendingUp, MousePointerClick, Eye,
  DollarSign, BarChart2, Zap, ArrowUpDown, ChevronUp, ChevronDown,
  CalendarDays,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RollingRow {
  label:           string;
  startDate:       string;
  endDate:         string;
  impressions:     number;
  clicks:          number;
  spend:           number;
  ctr:             number | null;
  cpc:             number | null;
  conversions:     number;
  conversionValue: number;
  roas:            number | null;
}

interface RollingDelta {
  impressions:     number | null;
  clicks:          number | null;
  spend:           number | null;
  ctr:             number | null;
  cpc:             number | null;
  conversions:     number | null;
  conversionValue: number | null;
  roas:            number | null;
}

interface RollingData {
  view:       "daily" | "weekly";
  dayName:    string;
  anchorDate: string;
  campaigns:  { campaignId: string; campaignName: string }[];
  rows:       RollingRow[];
  avg12:      RollingRow;
  wowDelta:   RollingDelta | null;
  wowPct:     RollingDelta | null;
  avg12Delta: RollingDelta | null;
  avg12Pct:   RollingDelta | null;
}

interface Campaign {
  campaignId:      string;
  campaignName:    string;
  spend:           number;
  clicks:          number;
  impressions:     number;
  conversions:     number;
  conversionValue: number;
  ctr:             number | null;
  cpc:             number | null;
  roas:            number | null;
}

interface DayPoint {
  date:        string;
  spend:       number;
  clicks:      number;
  impressions: number;
}

interface Summary {
  spend:           number;
  clicks:          number;
  impressions:     number;
  conversions:     number;
  conversionValue: number;
  ctr:             number | null;
  cpc:             number | null;
  roas:            number | null;
}

interface PaidMediaData {
  hasData:     boolean;
  days:        number;
  summary:     Summary;
  dailySeries: DayPoint[];
  campaigns:   Campaign[];
}

type SortKey = "spend" | "clicks" | "impressions" | "ctr" | "cpc" | "roas" | "conversions";
type SortDir = "asc" | "desc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$$(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function fmtN(n: number | null | undefined, decimals = 0): string {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: decimals });
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return (n * 100).toFixed(2) + "%";
}

function fmtRoas(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(2)}×`;
}

function fmtCpc(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);
}

function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtDelta(v: number | null, fmt: (n: number) => string): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return sign + fmt(v);
}

function fmtPctDelta(v: number | null): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return sign + (v * 100).toFixed(1) + "%";
}

function deltaClass(v: number | null, lowerIsBetter = false): string {
  if (v == null || v === 0) return "text-slate-400";
  const positive = lowerIsBetter ? v < 0 : v > 0;
  return positive ? "text-emerald-600 font-semibold" : "text-red-500 font-semibold";
}

// ---------------------------------------------------------------------------
// Rolling Average Table
// ---------------------------------------------------------------------------

const ROLLING_COLS = [
  { key: "impressions",     label: "Impressions",   fmt: (v: number) => fmtN(v),              isDelta: false },
  { key: "clicks",          label: "Clicks",        fmt: (v: number) => fmtN(v),              isDelta: false },
  { key: "ctr",             label: "CTR",           fmt: (v: number) => fmtPct(v),            isDelta: false },
  { key: "spend",           label: "Cost",          fmt: (v: number) => fmt$$(v),             isDelta: false },
  { key: "cpc",             label: "Cost Per Click",fmt: (v: number) => fmtCpc(v),            isDelta: false },
  { key: "conversions",     label: "Conversions",   fmt: (v: number) => fmtN(v, 1),           isDelta: false },
  { key: "conversionValue", label: "Conv. Value",   fmt: (v: number) => fmt$$(v),             isDelta: false },
  { key: "roas",            label: "ROAS",          fmt: (v: number) => fmtRoas(v),           isDelta: false },
] as const;

type RollingColKey = typeof ROLLING_COLS[number]["key"];

function rollingVal(row: RollingRow | RollingDelta, key: RollingColKey): number | null {
  const v = (row as unknown as Record<string, unknown>)[key];
  return typeof v === "number" ? v : null;
}

function RollingTable({ data }: { data: RollingData }) {
  const { rows, avg12, wowDelta, wowPct, avg12Delta, avg12Pct, view, dayName } = data;

  const subLabel = view === "daily"
    ? `Last 12 ${dayName}s`
    : "Last 12 Weeks";

  const wowLabel  = view === "daily" ? "WoW Δ" : "Week-over-Week Δ";

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-900">12-Period Rolling Average</h2>
        <p className="text-xs text-slate-400 mt-0.5">{subLabel} · newest first</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100">
              <th className="sticky left-0 z-10 bg-slate-50 text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                {view === "daily" ? "Date" : "Week"}
              </th>
              {ROLLING_COLS.map(col => (
                <th key={col.key} className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, i) => (
              <tr key={row.startDate} className={cn("hover:bg-slate-50/60 transition-colors", i === 0 ? "bg-indigo-50/30" : i % 2 === 1 ? "bg-slate-50/40" : "")}>
                <td className={cn("sticky left-0 z-10 px-6 py-3 font-medium whitespace-nowrap", i === 0 ? "bg-indigo-50/30 text-indigo-700" : "bg-white text-slate-900")}>
                  {row.label}
                  {i === 0 && <span className="ml-2 text-xs text-indigo-400 font-normal">most recent</span>}
                </td>
                {ROLLING_COLS.map(col => (
                  <td key={col.key} className="px-4 py-3 text-right tabular-nums text-slate-600 whitespace-nowrap">
                    {(() => {
                      const v = rollingVal(row, col.key);
                      return v != null ? col.fmt(v) : <span className="text-slate-300">—</span>;
                    })()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-slate-200">
            {/* 12-period average */}
            <tr className="bg-slate-800 text-white">
              <td className="sticky left-0 z-10 bg-slate-800 px-6 py-3 text-xs font-bold uppercase tracking-wide whitespace-nowrap">
                12-Period Avg
              </td>
              {ROLLING_COLS.map(col => (
                <td key={col.key} className="px-4 py-3 text-right tabular-nums text-slate-200 font-semibold whitespace-nowrap">
                  {(() => {
                    const v = rollingVal(avg12, col.key);
                    return v != null ? col.fmt(v) : "—";
                  })()}
                </td>
              ))}
            </tr>

            {/* WoW delta */}
            {wowDelta && wowPct && (
              <tr className="bg-slate-100 border-t border-slate-200">
                <td className="sticky left-0 z-10 bg-slate-100 px-6 py-2.5 text-xs font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap">
                  {wowLabel}
                </td>
                {ROLLING_COLS.map(col => {
                  const raw = rollingVal(wowDelta, col.key);
                  const pct = rollingVal(wowPct, col.key);
                  const lowerBetter = col.key === "cpc" || col.key === "spend";
                  return (
                    <td key={col.key} className={cn("px-4 py-2.5 text-right tabular-nums text-xs whitespace-nowrap", deltaClass(raw, lowerBetter))}>
                      {raw != null ? (
                        <>
                          <div>{fmtDelta(raw, col.fmt)}</div>
                          <div className="text-[10px] opacity-70">{fmtPctDelta(pct)}</div>
                        </>
                      ) : "—"}
                    </td>
                  );
                })}
              </tr>
            )}

            {/* 12-period average delta */}
            {avg12Delta && avg12Pct && (
              <tr className="bg-slate-50 border-t border-slate-200">
                <td className="sticky left-0 z-10 bg-slate-50 px-6 py-2.5 text-xs font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap">
                  vs 12-Period Avg
                </td>
                {ROLLING_COLS.map(col => {
                  const raw = rollingVal(avg12Delta, col.key);
                  const pct = rollingVal(avg12Pct, col.key);
                  const lowerBetter = col.key === "cpc" || col.key === "spend";
                  return (
                    <td key={col.key} className={cn("px-4 py-2.5 text-right tabular-nums text-xs whitespace-nowrap", deltaClass(raw, lowerBetter))}>
                      {raw != null ? (
                        <>
                          <div>{fmtDelta(raw, col.fmt)}</div>
                          <div className="text-[10px] opacity-70">{fmtPctDelta(pct)}</div>
                        </>
                      ) : "—"}
                    </td>
                  );
                })}
              </tr>
            )}
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function KpiCard({
  label, value, sub, icon: Icon, accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
        <span className={cn("rounded-lg p-1.5", accent ? "bg-indigo-50" : "bg-slate-50")}>
          <Icon className={cn("w-4 h-4", accent ? "text-indigo-500" : "text-slate-400")} />
        </span>
      </div>
      <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function SortIcon({ col, active, dir }: { col: string; active: string; dir: SortDir }) {
  if (col !== active) return <ArrowUpDown className="w-3 h-3 text-slate-300" />;
  return dir === "desc"
    ? <ChevronDown className="w-3 h-3 text-indigo-500" />
    : <ChevronUp   className="w-3 h-3 text-indigo-500" />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function PaidMediaClient() {
  const [days,         setDays]        = useState<30 | 90>(30);
  const [data,         setData]        = useState<PaidMediaData | null>(null);
  const [loading,      setLoading]     = useState(true);
  const [syncing,      setSyncing]     = useState(false);
  const [syncMsg,      setSyncMsg]     = useState<string | null>(null);
  const [sortKey,      setSortKey]     = useState<SortKey>("spend");
  const [sortDir,      setSortDir]     = useState<SortDir>("desc");
  const [chartView,    setChartView]   = useState<"spend" | "clicks">("spend");

  // Rolling average state
  const [rollingView,  setRollingView] = useState<"daily" | "weekly">("daily");
  const [rollingCampaign, setRollingCampaign] = useState<string>("all");
  const [rollingData,  setRollingData] = useState<RollingData | null>(null);
  const [rollingLoading, setRollingLoading] = useState(false);

  const load = useCallback(async (d: 30 | 90) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/paid-media/campaigns?days=${d}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRolling = useCallback(async (view: "daily" | "weekly", campaignId: string) => {
    setRollingLoading(true);
    try {
      const res = await fetch(`/api/paid-media/rolling?view=${view}&campaignId=${encodeURIComponent(campaignId)}`);
      if (res.ok) setRollingData(await res.json());
    } finally {
      setRollingLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [days, load]);
  useEffect(() => { loadRolling(rollingView, rollingCampaign); }, [rollingView, rollingCampaign, loadRolling]);

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const from = new Date();
      from.setDate(from.getDate() - days);
      const res  = await fetch("/api/integrations/google_ads/campaign-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ from: from.toISOString().slice(0, 10) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      setSyncMsg(`Synced ${json.rows} rows across campaigns.`);
      await load(days);
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => d === "desc" ? "asc" : "desc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sortedCampaigns = data?.campaigns
    ? [...data.campaigns].sort((a, b) => {
        const av = a[sortKey] ?? -Infinity;
        const bv = b[sortKey] ?? -Infinity;
        return sortDir === "desc" ? (bv as number) - (av as number) : (av as number) - (bv as number);
      })
    : [];

  const summary = data?.summary;
  const hasRoas = (summary?.roas ?? null) !== null && (summary?.roas ?? 0) > 0;

  return (
    <div className="p-8 space-y-8">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Megaphone className="w-6 h-6 text-indigo-500" />
            <h1 className="text-2xl font-bold text-slate-900">Paid Media</h1>
          </div>
          <p className="text-sm text-slate-500">Campaign performance, ad spend &amp; ROAS</p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Date range toggle */}
          <div className="flex rounded-lg border border-slate-200 bg-slate-50 overflow-hidden text-sm">
            {([30, 90] as const).map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={cn(
                  "px-3 py-1.5 font-medium transition-colors",
                  days === d
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-700",
                )}
              >
                {d}d
              </button>
            ))}
          </div>

          {/* Sync button */}
          <button
            onClick={handleSync}
            disabled={syncing}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors",
              syncing
                ? "border-slate-200 text-slate-400 cursor-not-allowed"
                : "border-indigo-200 text-indigo-600 hover:bg-indigo-50",
            )}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", syncing && "animate-spin")} />
            {syncing ? "Syncing…" : "Sync Campaigns"}
          </button>
        </div>
      </div>

      {syncMsg && (
        <div className={cn(
          "rounded-lg px-4 py-3 text-sm",
          syncMsg.toLowerCase().includes("fail") || syncMsg.toLowerCase().includes("error")
            ? "bg-red-50 text-red-700 border border-red-200"
            : "bg-green-50 text-green-700 border border-green-200",
        )}>
          {syncMsg}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Loading / empty state                                               */}
      {/* ------------------------------------------------------------------ */}
      {loading && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-12 text-center text-slate-400">
          <RefreshCw className="w-8 h-8 mx-auto mb-3 animate-spin text-slate-300" />
          <p className="text-sm">Loading campaign data…</p>
        </div>
      )}

      {!loading && !data?.hasData && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-12 text-center text-slate-400">
          <Megaphone className="w-10 h-10 mx-auto mb-3 text-slate-300" />
          <p className="font-medium text-slate-600">No campaign data yet</p>
          <p className="text-sm mt-1 mb-4">
            Click <strong>Sync Campaigns</strong> above to pull your Google Ads campaign data.
          </p>
          <p className="text-xs text-slate-400">
            Requires Google Ads connection in Integrations settings.
          </p>
        </div>
      )}

      {!loading && data?.hasData && (
        <>
          {/* -------------------------------------------------------------- */}
          {/* KPI Cards                                                        */}
          {/* -------------------------------------------------------------- */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <KpiCard label="Total Spend"   value={fmt$$(summary?.spend)}       sub={`Last ${days} days`}  icon={DollarSign}         accent />
            <KpiCard label="Impressions"   value={fmtN(summary?.impressions)}  sub="Ad views"             icon={Eye} />
            <KpiCard label="Clicks"        value={fmtN(summary?.clicks)}       sub="Link clicks"          icon={MousePointerClick} />
            <KpiCard label="Avg CTR"       value={fmtPct(summary?.ctr)}        sub="Click-through rate"   icon={TrendingUp} />
            <KpiCard label="Avg CPC"       value={fmtCpc(summary?.cpc)}        sub="Cost per click"       icon={BarChart2} />
            <KpiCard
              label="ROAS"
              value={hasRoas ? fmtRoas(summary?.roas) : "—"}
              sub={hasRoas ? "Conv. value / spend" : "Set up conversion tracking"}
              icon={Zap}
              accent={hasRoas}
            />
          </div>

          {/* -------------------------------------------------------------- */}
          {/* Trend Chart                                                      */}
          {/* -------------------------------------------------------------- */}
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Daily Performance</h2>
                <p className="text-xs text-slate-400 mt-0.5">Last {days} days</p>
              </div>
              <div className="flex rounded-lg border border-slate-200 bg-slate-50 overflow-hidden text-xs">
                {(["spend", "clicks"] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => setChartView(v)}
                    className={cn(
                      "px-3 py-1.5 font-medium transition-colors capitalize",
                      chartView === v
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-500 hover:text-slate-700",
                    )}
                  >
                    {v === "spend" ? "Spend ($)" : "Clicks"}
                  </button>
                ))}
              </div>
            </div>

            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={data.dailySeries} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="clicksGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#0ea5e9" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={shortDate}
                  tick={{ fontSize: 11, fill: "#94a3b8" }}
                  axisLine={false}
                  tickLine={false}
                  interval={Math.floor(data.dailySeries.length / 8)}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#94a3b8" }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                  tickFormatter={v =>
                    chartView === "spend"
                      ? "$" + (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)
                      : fmtN(v)
                  }
                />
                <Tooltip
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any) =>
                    chartView === "spend"
                      ? [fmt$$(value ?? 0), "Spend"]
                      : [fmtN(value ?? 0), "Clicks"]
                  }
                  labelFormatter={l => {
                    const d = new Date(String(l) + "T00:00:00");
                    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  }}
                  contentStyle={{ border: "1px solid #e2e8f0", borderRadius: "8px", fontSize: "12px" }}
                />
                {chartView === "spend" ? (
                  <Area
                    type="monotone"
                    dataKey="spend"
                    stroke="#6366f1"
                    strokeWidth={2}
                    fill="url(#spendGrad)"
                    dot={false}
                    activeDot={{ r: 4, fill: "#6366f1" }}
                  />
                ) : (
                  <Area
                    type="monotone"
                    dataKey="clicks"
                    stroke="#0ea5e9"
                    strokeWidth={2}
                    fill="url(#clicksGrad)"
                    dot={false}
                    activeDot={{ r: 4, fill: "#0ea5e9" }}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* -------------------------------------------------------------- */}
          {/* Campaign Table                                                   */}
          {/* -------------------------------------------------------------- */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Campaign Breakdown</h2>
                <p className="text-xs text-slate-400 mt-0.5">{sortedCampaigns.length} campaigns · last {days} days</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Campaign</th>
                    {(
                      [
                        { key: "spend",       label: "Spend" },
                        { key: "impressions", label: "Impressions" },
                        { key: "clicks",      label: "Clicks" },
                        { key: "ctr",         label: "CTR" },
                        { key: "cpc",         label: "CPC" },
                        { key: "conversions", label: "Conversions" },
                        { key: "roas",        label: "ROAS" },
                      ] as { key: SortKey; label: string }[]
                    ).map(col => (
                      <th
                        key={col.key}
                        onClick={() => toggleSort(col.key)}
                        className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide cursor-pointer hover:text-slate-700 select-none whitespace-nowrap"
                      >
                        <span className="inline-flex items-center gap-1 justify-end">
                          {col.label}
                          <SortIcon col={col.key} active={sortKey} dir={sortDir} />
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sortedCampaigns.map((c, i) => (
                    <tr key={c.campaignId} className={cn("hover:bg-slate-50 transition-colors", i % 2 === 0 ? "" : "bg-slate-50/40")}>
                      <td className="px-6 py-3.5 font-medium text-slate-900 max-w-[220px]">
                        <span className="block truncate" title={c.campaignName}>{c.campaignName || c.campaignId}</span>
                      </td>
                      <td className="px-4 py-3.5 text-right text-slate-700 tabular-nums font-medium">{fmt$$(c.spend)}</td>
                      <td className="px-4 py-3.5 text-right text-slate-500 tabular-nums">{fmtN(c.impressions)}</td>
                      <td className="px-4 py-3.5 text-right text-slate-500 tabular-nums">{fmtN(c.clicks)}</td>
                      <td className="px-4 py-3.5 text-right text-slate-500 tabular-nums">{fmtPct(c.ctr)}</td>
                      <td className="px-4 py-3.5 text-right text-slate-500 tabular-nums">{fmtCpc(c.cpc)}</td>
                      <td className="px-4 py-3.5 text-right text-slate-500 tabular-nums">{fmtN(c.conversions, 1)}</td>
                      <td className="px-4 py-3.5 text-right tabular-nums">
                        {c.roas != null && c.roas > 0 ? (
                          <span className={cn(
                            "inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold",
                            c.roas >= 3 ? "bg-green-50 text-green-700" :
                            c.roas >= 1 ? "bg-amber-50 text-amber-700" :
                                         "bg-red-50 text-red-700",
                          )}>
                            {fmtRoas(c.roas)}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/* Summary row */}
                <tfoot>
                  <tr className="bg-slate-50 border-t-2 border-slate-200">
                    <td className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Total</td>
                    <td className="px-4 py-3 text-right font-bold text-slate-900 tabular-nums">{fmt$$(summary?.spend)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtN(summary?.impressions)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtN(summary?.clicks)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtPct(summary?.ctr)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtCpc(summary?.cpc)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtN(summary?.conversions, 1)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">
                      {hasRoas ? fmtRoas(summary?.roas) : "—"}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* -------------------------------------------------------------- */}
          {/* Rolling Average Section                                          */}
          {/* -------------------------------------------------------------- */}
          <div className="space-y-4">
            {/* Controls */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-semibold text-slate-900">Rolling Averages</span>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {/* View toggle */}
                <div className="flex rounded-lg border border-slate-200 bg-slate-50 overflow-hidden text-sm">
                  {(["daily", "weekly"] as const).map(v => (
                    <button
                      key={v}
                      onClick={() => setRollingView(v)}
                      className={cn(
                        "px-3 py-1.5 font-medium transition-colors capitalize",
                        rollingView === v
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700",
                      )}
                    >
                      {v === "daily" ? "Daily (by weekday)" : "Weekly"}
                    </button>
                  ))}
                </div>

                {/* Campaign selector */}
                {(rollingData?.campaigns?.length ?? 0) > 0 && (
                  <select
                    value={rollingCampaign}
                    onChange={e => setRollingCampaign(e.target.value)}
                    className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  >
                    <option value="all">All Campaigns</option>
                    {rollingData!.campaigns.map(c => (
                      <option key={c.campaignId} value={c.campaignId}>{c.campaignName}</option>
                    ))}
                  </select>
                )}

                <button
                  onClick={() => loadRolling(rollingView, rollingCampaign)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", rollingLoading && "animate-spin")} />
                  Refresh
                </button>
              </div>
            </div>

            {rollingLoading && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-10 text-center">
                <RefreshCw className="w-6 h-6 mx-auto mb-2 animate-spin text-slate-300" />
                <p className="text-sm text-slate-400">Building rolling averages…</p>
              </div>
            )}

            {!rollingLoading && rollingData && (
              rollingData.rows.length > 0 ? (
                <RollingTable data={rollingData} />
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-10 text-center">
                  <CalendarDays className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                  <p className="text-sm text-slate-500">No data yet for this period.</p>
                  <p className="text-xs text-slate-400 mt-1">Run a campaign sync or backfill to populate historical data.</p>
                </div>
              )
            )}
          </div>

          {/* -------------------------------------------------------------- */}
          {/* Bottom-of-Funnel note                                           */}
          {/* -------------------------------------------------------------- */}
          {!hasRoas && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-6 py-4">
              <div className="flex items-start gap-3">
                <Zap className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-amber-900">Set up conversion tracking to see ROAS</p>
                  <p className="text-xs text-amber-700 mt-1">
                    ROAS is calculated from <strong>Google Ads conversion value</strong>. Enable conversion tracking in Google Ads
                    (Tools → Conversions) and tag revenue events to see return-on-ad-spend per campaign.
                    Alternatively, HubSpot UTM attribution will be added in a future update to tie closed-won ARR to each campaign.
                  </p>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
