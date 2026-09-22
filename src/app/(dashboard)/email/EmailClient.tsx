"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Mail, Send, Eye, MousePointerClick, UserMinus,
  TrendingUp, AlertCircle, RefreshCw, ChevronLeft, ChevronRight,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

interface EmailCampaign {
  id:          string;
  name:        string;
  subject:     string;
  publishDate: string;
  sent:        number;
  opens:       number;
  clicks:      number;
  unsubs:      number;
  bounces:     number;
  openRate:    number;
  clickRate:   number;
  ctor:        number;
  unsubRate:   number;
}

interface Summary {
  campaigns:  number;
  sent:       number;
  opens:      number;
  clicks:     number;
  unsubs:     number;
  bounces:    number;
  openRate:   number;
  clickRate:  number;
  ctor:       number;
  unsubRate:  number;
}

interface EmailData {
  year:      number;
  month:     number;
  summary:   Summary;
  campaigns: EmailCampaign[];
}

// ── Formatters ───────────────────────────────────────────────────────────────

const fmtN = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000   ? `${(n / 1_000).toFixed(1)}k`
  : n.toLocaleString("en-US");

const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

// ── Benchmark thresholds (industry-ish for B2B SaaS) ────────────────────────
// Green if above, amber if close, red if below
const BENCHMARKS = {
  openRate:  { good: 0.25, ok: 0.18 },
  clickRate: { good: 0.03, ok: 0.015 },
  ctor:      { good: 0.12, ok: 0.07 },
  unsubRate: { good: 0.001, ok: 0.003 }, // lower is better for unsub
};

function rateColor(metric: keyof typeof BENCHMARKS, value: number) {
  const b = BENCHMARKS[metric];
  if (metric === "unsubRate") {
    if (value <= b.good) return "text-emerald-600";
    if (value <= b.ok)   return "text-amber-600";
    return "text-red-600";
  }
  if (value >= b.good) return "text-emerald-600";
  if (value >= b.ok)   return "text-amber-600";
  return "text-red-600";
}

// ── Summary card ─────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  colorClass,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  colorClass?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
      <div className="flex items-center gap-2 text-slate-500 mb-3">
        <Icon className="w-4 h-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className={cn("text-2xl font-bold text-slate-900", colorClass)}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

// ── Rate pill for table cells ─────────────────────────────────────────────────

function RatePill({ metric, value }: { metric: keyof typeof BENCHMARKS; value: number }) {
  const b = BENCHMARKS[metric];
  let bg = "bg-emerald-50 text-emerald-700";
  if (metric === "unsubRate") {
    if (value > b.ok)       bg = "bg-red-50 text-red-700";
    else if (value > b.good) bg = "bg-amber-50 text-amber-700";
  } else {
    if (value < b.ok)       bg = "bg-red-50 text-red-700";
    else if (value < b.good) bg = "bg-amber-50 text-amber-700";
  }
  return (
    <span className={cn("inline-flex px-2 py-0.5 rounded-full text-xs font-semibold", bg)}>
      {fmtPct(value)}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function EmailClient() {
  const now   = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [data,  setData]  = useState<EmailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const fetchData = useCallback(async (y: number, m: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/email/stats?year=${y}&month=${m}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}` + (body.detail ? `: ${body.detail}` : ""));
      }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(year, month); }, [fetchData, year, month]);

  function prevMonth() {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
    if (isCurrentMonth) return;
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  }

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const s = data?.summary;

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Mail className="w-5 h-5 text-indigo-500" />
            Email Marketing
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">HubSpot Marketing Email performance</p>
        </div>

        <div className="flex items-center gap-2">
          {/* Month navigator */}
          <div className="flex items-center gap-1 bg-white rounded-lg border border-slate-200 shadow-sm px-1 py-1">
            <button
              onClick={prevMonth}
              className="p-1.5 rounded hover:bg-slate-100 transition-colors text-slate-500"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-medium text-slate-700 w-32 text-center">
              {MONTHS[month - 1]} {year}
            </span>
            <button
              onClick={nextMonth}
              disabled={isCurrentMonth}
              className={cn(
                "p-1.5 rounded transition-colors text-slate-500",
                isCurrentMonth ? "opacity-30 cursor-not-allowed" : "hover:bg-slate-100"
              )}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={() => fetchData(year, month)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 shadow-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 h-24 animate-pulse" />
          ))}
        </div>
      )}

      {/* Summary cards */}
      {s && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              icon={Send}
              label="Emails Sent"
              value={fmtN(s.sent)}
              sub={`${s.campaigns} campaign${s.campaigns !== 1 ? "s" : ""}`}
            />
            <StatCard
              icon={Eye}
              label="Open Rate"
              value={fmtPct(s.openRate)}
              sub={`${fmtN(s.opens)} opens`}
              colorClass={rateColor("openRate", s.openRate)}
            />
            <StatCard
              icon={MousePointerClick}
              label="Click Rate"
              value={fmtPct(s.clickRate)}
              sub={`${fmtN(s.clicks)} clicks`}
              colorClass={rateColor("clickRate", s.clickRate)}
            />
            <StatCard
              icon={TrendingUp}
              label="CTOR"
              value={fmtPct(s.ctor)}
              sub="Click-to-open rate"
              colorClass={rateColor("ctor", s.ctor)}
            />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              icon={UserMinus}
              label="Unsubscribes"
              value={fmtN(s.unsubs)}
              sub={fmtPct(s.unsubRate) + " unsub rate"}
              colorClass={rateColor("unsubRate", s.unsubRate)}
            />
            <StatCard
              icon={Mail}
              label="Bounces"
              value={fmtN(s.bounces)}
              sub={s.sent > 0 ? fmtPct(s.bounces / s.sent) + " bounce rate" : undefined}
            />
            <StatCard
              icon={Eye}
              label="Total Opens"
              value={fmtN(s.opens)}
              sub="Unique opens across all campaigns"
            />
            <StatCard
              icon={MousePointerClick}
              label="Total Clicks"
              value={fmtN(s.clicks)}
              sub="Unique clicks across all campaigns"
            />
          </div>
        </>
      )}

      {/* Empty state */}
      {!loading && data && data.campaigns.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
          <Mail className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-600 font-medium">No emails sent in {MONTHS[month - 1]} {year}</p>
          <p className="text-sm text-slate-400 mt-1">Try a different month or check your HubSpot connection.</p>
        </div>
      )}

      {/* Campaign table */}
      {data && data.campaigns.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">
              Campaigns — {MONTHS[month - 1]} {year}
            </h2>
            <span className="text-xs text-slate-400">{data.campaigns.length} email{data.campaigns.length !== 1 ? "s" : ""}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Campaign</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Date</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Sent</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Opens</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Open Rate</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Clicks</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Click Rate</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">CTOR</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Unsubs</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Unsub %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {data.campaigns.map((c, i) => (
                  <tr
                    key={c.id}
                    className={cn(
                      "hover:bg-slate-50 transition-colors",
                      i % 2 === 0 ? "" : "bg-slate-50/50"
                    )}
                  >
                    <td className="px-5 py-3.5">
                      <a
                        href={`https://app.hubspot.com/email/${c.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group"
                      >
                        <p className="font-medium text-slate-800 group-hover:text-indigo-600 transition-colors flex items-center gap-1">
                          {c.name}
                          <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </p>
                        {c.subject && c.subject !== c.name && (
                          <p className="text-xs text-slate-400 mt-0.5 truncate max-w-xs">{c.subject}</p>
                        )}
                      </a>
                    </td>
                    <td className="px-4 py-3.5 text-right text-slate-500 tabular-nums text-xs">
                      {fmtDate(c.publishDate)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-medium text-slate-700 tabular-nums">
                      {fmtN(c.sent)}
                    </td>
                    <td className="px-4 py-3.5 text-right text-slate-600 tabular-nums">
                      {fmtN(c.opens)}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <RatePill metric="openRate" value={c.openRate} />
                    </td>
                    <td className="px-4 py-3.5 text-right text-slate-600 tabular-nums">
                      {fmtN(c.clicks)}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <RatePill metric="clickRate" value={c.clickRate} />
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <RatePill metric="ctor" value={c.ctor} />
                    </td>
                    <td className="px-4 py-3.5 text-right text-slate-600 tabular-nums">
                      {fmtN(c.unsubs)}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <RatePill metric="unsubRate" value={c.unsubRate} />
                    </td>
                  </tr>
                ))}
              </tbody>

              {/* Totals row */}
              {s && (
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50">
                    <td className="px-5 py-3 text-xs font-bold text-slate-600 uppercase tracking-wide">Total</td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 text-right font-bold text-slate-800 tabular-nums">{fmtN(s.sent)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtN(s.opens)}</td>
                    <td className="px-4 py-3 text-right">
                      <RatePill metric="openRate" value={s.openRate} />
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtN(s.clicks)}</td>
                    <td className="px-4 py-3 text-right">
                      <RatePill metric="clickRate" value={s.clickRate} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RatePill metric="ctor" value={s.ctor} />
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtN(s.unsubs)}</td>
                    <td className="px-4 py-3 text-right">
                      <RatePill metric="unsubRate" value={s.unsubRate} />
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Benchmark legend */}
          <div className="px-5 py-3 border-t border-slate-100 flex items-center gap-4 text-xs text-slate-400">
            <span className="font-medium text-slate-500">Rate benchmarks:</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> Good</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Below avg</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> Needs attention</span>
          </div>
        </div>
      )}
    </div>
  );
}
