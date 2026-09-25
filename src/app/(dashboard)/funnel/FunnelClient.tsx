"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ExternalLink, X, Bell, ChevronRight, ChevronLeft, Loader2, AlertTriangle, Globe, Bot, Send, Sparkles, RefreshCw, Clock, Trash2, ChevronDown, Search, MousePointerClick } from "lucide-react";
import { useChatHistory, relativeTime, type ChatSession } from "@/lib/use-chat-history";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Channel = "all" | "paid" | "organic";

interface FunnelCounts {
  siteVisits:    number;
  paidVisits:    number;
  organicVisits: number;
  adSpend:       number;
  leads:         number;
  mqls:          number;
  sqos:          number;
  closedWon:     number;
}

interface FunnelRecord {
  id:    string;
  name:  string;
  url:   string;
  extra?: string;
}

interface Notification {
  id:         string;
  detectedAt: string;
  objectName: string;
  fromStage:  string;
  toStage:    string;
  changedAt:  string | null;
  changedBy:  string | null;
  profileUrl: string;
}

type Stage = "leads" | "mqls" | "sqos" | "closedwon";

const STAGES: { key: Stage; label: string; color: string; bg: string; barColor: string }[] = [
  { key: "leads",     label: "Leads",      color: "text-slate-700",  bg: "bg-slate-100",   barColor: "bg-slate-400"  },
  { key: "mqls",      label: "MQLs",       color: "text-blue-700",   bg: "bg-blue-50",     barColor: "bg-blue-400"   },
  { key: "sqos",      label: "SQOs",       color: "text-violet-700", bg: "bg-violet-50",   barColor: "bg-violet-500" },
  { key: "closedwon", label: "Closed Won", color: "text-emerald-700",bg: "bg-emerald-50",  barColor: "bg-emerald-500"},
];

function fmtCurrency(n: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function fmtPct(a: number, b: number) {
  if (b === 0) return "—";
  return ((a / b) * 100).toFixed(1) + "%";
}

function getCount(counts: FunnelCounts, stage: Stage): number {
  return stage === "leads"     ? counts.leads     :
         stage === "mqls"      ? counts.mqls      :
         stage === "sqos"      ? counts.sqos      :
                                 counts.closedWon;
}

// ---------------------------------------------------------------------------
// Attribution Panel — HubSpot first-touch source breakdown for MQL contacts
// ---------------------------------------------------------------------------

interface AttributionRow {
  source:    string;
  label:     string;
  type:      "paid" | "organic" | "other";
  mqls:      number;
  sqos:      number;
  convRate:  number;
  topDetail: { label: string; count: number }[];
}

interface AttributionData {
  total: number;
  rows:  AttributionRow[];
}

const TYPE_COLOR: Record<string, string> = {
  paid:    "bg-violet-50 text-violet-700 border-violet-200",
  organic: "bg-emerald-50 text-emerald-700 border-emerald-200",
  other:   "bg-slate-100 text-slate-600 border-slate-200",
};

function AttributionPanel({ from, to }: { from: string; to: string }) {
  const [open,    setOpen]    = useState(false);
  const [data,    setData]    = useState<AttributionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open || data) return;
    setLoading(true);
    setError(null);
    fetch(`/api/funnel/attribution?from=${from}&to=${to}`)
      .then(r => r.json())
      .then((d: AttributionData & { error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setData(d);
      })
      .catch(() => setError("Failed to load attribution data"))
      .finally(() => setLoading(false));
  }, [open, from, to, data]);

  // Reset when date range changes
  useEffect(() => { setData(null); }, [from, to]);

  const paid    = data?.rows.filter(r => r.type === "paid")    ?? [];
  const organic = data?.rows.filter(r => r.type === "organic") ?? [];
  const other   = data?.rows.filter(r => r.type === "other")   ?? [];

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-indigo-500" />
          <span className="text-sm font-semibold text-slate-700">MQL Source Attribution</span>
          {data && (
            <span className="text-xs text-slate-400 font-normal ml-1">
              {data.total} MQLs across {data.rows.length} sources
            </span>
          )}
        </div>
        <ChevronDown className={cn("w-4 h-4 text-slate-400 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="border-t border-slate-100 px-5 pb-5 pt-4">
          {loading && (
            <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading HubSpot attribution…
            </div>
          )}

          {error && (
            <div className="text-sm text-red-500 bg-red-50 rounded-lg p-3">{error}</div>
          )}

          {data && data.rows.length === 0 && (
            <p className="text-sm text-slate-400 py-4">No MQL contacts found for this date range.</p>
          )}

          {data && data.rows.length > 0 && (
            <div className="space-y-5">
              {[
                { label: "Paid",    icon: MousePointerClick, rows: paid    },
                { label: "Organic", icon: Globe,             rows: organic },
                { label: "Other",   icon: ChevronRight,      rows: other   },
              ].filter(g => g.rows.length > 0).map(group => (
                <div key={group.label}>
                  <div className="flex items-center gap-1.5 mb-2">
                    <group.icon className="w-3.5 h-3.5 text-slate-400" />
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                      {group.label}
                    </p>
                  </div>

                  <div className="rounded-lg border border-slate-100 overflow-hidden">
                    {/* Header */}
                    <div className="grid grid-cols-[1fr_auto_auto_auto] bg-slate-50 px-4 py-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
                      <span>Source</span>
                      <span className="w-16 text-right">MQLs</span>
                      <span className="w-16 text-right">SQOs</span>
                      <span className="w-20 text-right">MQL→SQO</span>
                    </div>

                    {group.rows.map(row => (
                      <div key={row.source} className="border-t border-slate-100">
                        <button
                          onClick={() => setExpanded(expanded === row.source ? null : row.source)}
                          className="w-full grid grid-cols-[1fr_auto_auto_auto] items-center px-4 py-2.5 hover:bg-slate-50 transition-colors text-left"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-700">{row.label}</span>
                            {row.topDetail.length > 0 && (
                              <ChevronDown className={cn(
                                "w-3 h-3 text-slate-300 transition-transform",
                                expanded === row.source && "rotate-180"
                              )} />
                            )}
                          </div>
                          <span className="w-16 text-right text-sm font-semibold tabular-nums text-slate-700">{row.mqls}</span>
                          <span className="w-16 text-right text-sm tabular-nums text-slate-500">{row.sqos}</span>
                          <span className={cn(
                            "w-20 text-right text-xs font-semibold tabular-nums",
                            row.convRate >= 0.3 ? "text-emerald-600" :
                            row.convRate >= 0.1 ? "text-indigo-500"  : "text-slate-400"
                          )}>
                            {row.mqls > 0 ? (row.convRate * 100).toFixed(0) + "%" : "—"}
                          </span>
                        </button>

                        {/* Expanded detail: top campaigns / referrers */}
                        {expanded === row.source && row.topDetail.length > 0 && (
                          <div className="bg-slate-50 border-t border-slate-100 px-4 py-3 space-y-1.5">
                            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">
                              Top campaigns / referrers
                            </p>
                            {row.topDetail.map((d, i) => (
                              <div key={i} className="flex items-center justify-between gap-3">
                                <span className="text-xs text-slate-600 truncate max-w-xs">{d.label || "(none)"}</span>
                                <div className="flex items-center gap-2 shrink-0">
                                  <div className="w-20 bg-slate-200 rounded-full h-1.5 overflow-hidden">
                                    <div
                                      className="h-full bg-indigo-400 rounded-full"
                                      style={{ width: `${(d.count / row.mqls) * 100}%` }}
                                    />
                                  </div>
                                  <span className="text-xs tabular-nums text-slate-500 w-6 text-right">{d.count}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <p className="text-[10px] text-slate-400 mt-2">
                Source = HubSpot first-touch channel. Detail = campaign name + medium (from UTM parameters captured on form submission).
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage Drawer
// ---------------------------------------------------------------------------

function StageDrawer({
  stage, label, from, to, onClose,
}: {
  stage: Stage; label: string; from: string; to: string; onClose: () => void;
}) {
  const [records,  setRecords]  = useState<FunnelRecord[] | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/hubspot/funnel-stage-contacts?stage=${stage}&from=${from}&to=${to}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setRecords(d.records ?? []); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [stage, from, to]);

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      {/* Backdrop */}
      <div className="flex-1 bg-black/30" />
      {/* Panel */}
      <div
        className="w-96 bg-white shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{label}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {records ? `${records.length} record${records.length !== 1 ? "s" : ""}` : " "}
              {records && records.length >= 500 ? " (capped at 500)" : ""}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex justify-center items-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
            </div>
          )}
          {error && (
            <div className="m-4 p-3 rounded-lg bg-red-50 border border-red-200">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}
          {!loading && records && records.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-12">No records in this period</p>
          )}
          {records && records.map(r => (
            <a
              key={r.id}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 group border-b border-slate-100 last:border-0 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate group-hover:text-indigo-700">{r.name}</p>
                {r.extra && <p className="text-xs text-slate-400 mt-0.5">{r.extra}</p>}
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-slate-300 group-hover:text-indigo-400 shrink-0" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notification Panel
// ---------------------------------------------------------------------------

function NotificationPanel({
  initialCount, onClose,
}: {
  initialCount: number; onClose: () => void;
}) {
  const [notifs,    setNotifs]    = useState<Notification[] | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [dismissing,setDismissing]= useState(false);

  useEffect(() => {
    fetch("/api/hubspot/funnel-notifications")
      .then(r => r.json())
      .then(d => setNotifs(d.notifications ?? []))
      .catch(() => setNotifs([]))
      .finally(() => setLoading(false));
  }, []);

  const dismiss = useCallback(async (id: string) => {
    await fetch("/api/hubspot/funnel-notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setNotifs(prev => (prev ?? []).filter(n => n.id !== id));
  }, []);

  const dismissAll = useCallback(async () => {
    setDismissing(true);
    await fetch("/api/hubspot/funnel-notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismissAll: true }),
    });
    setNotifs([]);
    setDismissing(false);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="flex-1 bg-black/30" />
      <div
        className="w-[480px] bg-white shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-amber-500" />
            <h2 className="text-base font-semibold text-slate-900">Funnel Regressions</h2>
          </div>
          <div className="flex items-center gap-2">
            {(notifs?.length ?? 0) > 0 && (
              <button
                onClick={dismissAll}
                disabled={dismissing}
                className="text-xs text-slate-400 hover:text-slate-700 px-2 py-1 rounded hover:bg-slate-100 transition-colors"
              >
                Dismiss all
              </button>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
            </div>
          )}
          {!loading && (!notifs || notifs.length === 0) && (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Bell className="w-8 h-8 mb-3 opacity-30" />
              <p className="text-sm">No regressions detected</p>
            </div>
          )}
          {notifs && notifs.map(n => (
            <div key={n.id} className="px-5 py-4 border-b border-slate-100 last:border-0">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a
                      href={n.profileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-semibold text-slate-800 hover:text-indigo-700 truncate"
                    >
                      {n.objectName}
                    </a>
                    <ExternalLink className="w-3 h-3 text-slate-300 shrink-0" />
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">{n.fromStage}</span>
                    <ChevronRight className="w-3 h-3 text-red-400" />
                    <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-50 text-red-700">{n.toStage}</span>
                  </div>
                  <div className="mt-1.5 space-y-0.5">
                    {n.changedAt && (
                      <p className="text-xs text-slate-400">
                        Changed {new Date(n.changedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        {n.changedBy ? ` by ${n.changedBy}` : ""}
                      </p>
                    )}
                    <p className="text-xs text-slate-400">
                      Detected {new Date(n.detectedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => dismiss(n.id)}
                  className="p-1 rounded hover:bg-slate-100 text-slate-300 hover:text-slate-600 transition-colors shrink-0"
                  aria-label="Dismiss"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main client component
// ---------------------------------------------------------------------------

interface Props {
  from:               string;
  to:                 string;
  estimatedSpend:     number | null;
  initialNotifCount:  number;
}

const CHANNEL_OPTIONS: { key: Channel; label: string }[] = [
  { key: "all",     label: "All"     },
  { key: "paid",    label: "Paid"    },
  { key: "organic", label: "Organic" },
];

export function FunnelClient({ from, to, estimatedSpend, initialNotifCount }: Props) {
  const [counts,       setCounts]       = useState<FunnelCounts | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [openDrawer,   setOpenDrawer]   = useState<Stage | null>(null);
  const [showNotifs,   setShowNotifs]   = useState(false);
  const [notifCount,   setNotifCount]   = useState(initialNotifCount);
  const [channel,      setChannel]      = useState<Channel>("all");
  const [chatOpen,     setChatOpen]     = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/hubspot/funnel-counts?from=${from}&to=${to}&channel=${channel}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setCounts(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to, channel]);

  const conversionPairs: Array<{ fromLabel: string; toLabel: string; a: number; b: number }> = counts
    ? [
        { fromLabel: "Visits",  toLabel: "Leads",      a: counts.siteVisits, b: counts.leads     },
        { fromLabel: "Leads",   toLabel: "MQLs",       a: counts.leads,      b: counts.mqls      },
        { fromLabel: "MQLs",    toLabel: "SQOs",       a: counts.mqls,       b: counts.sqos      },
        { fromLabel: "SQOs",    toLabel: "Closed Won", a: counts.sqos,       b: counts.closedWon },
      ]
    : [];

  const siteVisits = counts?.siteVisits ?? 0;

  // Which spend figure to use for cost-per calculations:
  // - organic: no cost (show "—")
  // - paid: actual Google Ads spend from CampaignDailySpend
  // - all: estimated marketing spend (pacing target / sheets)
  const effectiveSpend =
    channel === "organic" ? null :
    channel === "paid"    ? (counts?.adSpend ?? null) :
    estimatedSpend;

  return (
    <>
      {/* Top controls row */}
      <div className="flex items-center justify-between gap-3">
        {/* Channel toggle */}
        <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
          {CHANNEL_OPTIONS.map(opt => (
            <button
              key={opt.key}
              onClick={() => setChannel(opt.key)}
              className={cn(
                "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                channel === opt.key
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Notification button */}
        <button
          onClick={() => setShowNotifs(true)}
          className={cn(
            "flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border transition-colors",
            notifCount > 0
              ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
              : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
          )}
        >
          <Bell className="w-3.5 h-3.5" />
          <span>{notifCount > 0 ? `${notifCount} regression${notifCount !== 1 ? "s" : ""}` : "No regressions"}</span>
        </button>
      </div>

      {/* Funnel */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {/* Column headings */}
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-0 px-4 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-100">
          <span className="px-4">Stage</span>
          <span className="text-right w-24 px-4">Count</span>
          <span className="text-right w-28 px-4">Conversion</span>
          <span className="text-right w-32 px-4">Cost Per</span>
        </div>

        {loading && (
          <div className="flex justify-center items-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        )}
        {error && (
          <div className="m-6 p-4 rounded-lg bg-red-50 border border-red-200">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {counts && (() => {
          // Log scale for bar widths — prevents the T-shape when top-of-funnel
          // (site visits) dwarfs lower stages by orders of magnitude.
          const topCount = Math.max(siteVisits, counts.leads, 1);
          const logPct = (count: number) => {
            if (count <= 0) return 8;
            if (count >= topCount) return 100;
            return Math.max(
              (Math.log2(count + 1) / Math.log2(topCount + 1)) * 100,
              8,
            );
          };

          return (
            <>
              {/* Site Visits — non-clickable top-of-funnel row */}
              <div className="w-full grid grid-cols-[1fr_auto_auto_auto] gap-0 items-stretch border-b border-slate-100">
                <div className="py-2 px-4 flex items-center">
                  <div className="relative flex-1 h-9">
                    <div
                      className="absolute inset-y-0 rounded-sm transition-all duration-700 bg-indigo-400"
                      style={{
                        left:  `${(100 - logPct(siteVisits)) / 2}%`,
                        right: `${(100 - logPct(siteVisits)) / 2}%`,
                      }}
                    />
                    <div className="absolute inset-0 flex items-center justify-center gap-1">
                      <Globe className="w-3 h-3 text-white drop-shadow-sm" />
                      <span className="text-white text-xs font-semibold drop-shadow-sm">
                        {channel === "paid" ? "Paid Visits" : channel === "organic" ? "Organic Visits" : "Site Visits"}
                      </span>
                    </div>
                  </div>
                  {/* spacer to align with clickable rows that have ChevronRight */}
                  <div className="ml-2 w-3.5 h-3.5 shrink-0" />
                </div>
                <div className="flex items-center justify-end w-24 px-4">
                  <span className="text-sm font-semibold text-slate-800 tabular-nums">
                    {siteVisits.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-end w-28 px-4">
                  <span className="text-xs text-slate-300">—</span>
                </div>
                <div className="flex items-center justify-end w-32 px-4">
                  <span className="text-xs text-slate-300">—</span>
                </div>
              </div>

              {/* Existing funnel stages */}
              {STAGES.map((stage, i) => {
                const count   = getCount(counts, stage.key);
                const barPct  = logPct(count);

                // Conversion from previous stage (visits for Leads, otherwise prev stage)
                const prevCount =
                  i === 0 ? siteVisits : getCount(counts, STAGES[i - 1].key);
                const conversion = fmtPct(count, prevCount);

                const costPer = effectiveSpend != null && count > 0
                  ? fmtCurrency(effectiveSpend / count)
                  : "—";

                return (
                  <button
                    key={stage.key}
                    onClick={() => setOpenDrawer(stage.key)}
                    className="w-full grid grid-cols-[1fr_auto_auto_auto] gap-0 items-stretch hover:bg-slate-50/80 transition-colors border-b border-slate-100 last:border-0 text-left group"
                  >
                    <div className="py-2 px-4 flex items-center">
                      <div className="relative flex-1 h-9">
                        <div
                          className={cn(
                            "absolute inset-y-0 rounded-sm transition-all duration-700",
                            stage.barColor,
                          )}
                          style={{
                            left:  `${(100 - barPct) / 2}%`,
                            right: `${(100 - barPct) / 2}%`,
                          }}
                        />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-white text-xs font-semibold drop-shadow-sm px-2 truncate">
                            {stage.label}
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="ml-2 w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500 shrink-0 transition-colors" />
                    </div>

                    <div className="flex items-center justify-end w-24 px-4">
                      <span className="text-sm font-semibold text-slate-800 tabular-nums">
                        {count.toLocaleString()}
                      </span>
                    </div>

                    <div className="flex items-center justify-end w-28 px-4">
                      <span className={cn(
                        "text-xs font-medium",
                        conversion === "—" ? "text-slate-300" : "text-slate-600"
                      )}>
                        {conversion}
                      </span>
                    </div>

                    <div className="flex items-center justify-end w-32 px-4">
                      <span className={cn(
                        "text-xs font-medium",
                        costPer === "—" ? "text-slate-300" : "text-slate-600"
                      )}>
                        {costPer}
                      </span>
                    </div>
                  </button>
                );
              })}
            </>
          );
        })()}
      </div>

      {/* Conversion rate summary row */}
      {counts && (
        <div className="bg-slate-50 rounded-xl border border-slate-200 p-5">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Stage Conversion Rates</p>
          <div className="flex items-center gap-2 flex-wrap">
            {conversionPairs.map(({ fromLabel, toLabel, a, b }) => {
              const pct = fmtPct(b, a);
              return (
                <div key={`${fromLabel}-${toLabel}`} className="flex items-center gap-1 bg-white rounded-lg border border-slate-200 px-3 py-2">
                  <span className="text-xs text-slate-500">{fromLabel}</span>
                  <ChevronRight className="w-3 h-3 text-slate-300" />
                  <span className="text-xs text-slate-500">{toLabel}</span>
                  <span className="ml-1.5 text-xs font-semibold text-indigo-600">{pct}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Cost per summary */}
      {counts && effectiveSpend != null && (
        <div className="bg-slate-50 rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Cost Per Stage</p>
            <p className="text-xs text-slate-400">
              {channel === "paid"
                ? `Based on ${fmtCurrency(effectiveSpend)} actual ad spend`
                : `Based on ${fmtCurrency(effectiveSpend)} est. marketing spend`}
            </p>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {/* Site visits cost tile */}
            <div className="rounded-lg p-3 text-center bg-indigo-50">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">
                {channel === "paid" ? "Paid Visit" : "Site Visit"}
              </p>
              <p className="text-sm font-bold mt-1 text-indigo-700">
                {siteVisits > 0 ? fmtCurrency(effectiveSpend / siteVisits) : "—"}
              </p>
            </div>
            {STAGES.map(stage => {
              const count   = getCount(counts, stage.key);
              const costPer = count > 0 ? fmtCurrency(effectiveSpend / count) : "—";
              return (
                <div key={stage.key} className={cn("rounded-lg p-3 text-center", stage.bg)}>
                  <p className={cn("text-[11px] font-semibold uppercase tracking-wide", stage.color)}>{stage.label}</p>
                  <p className={cn("text-sm font-bold mt-1", stage.color)}>{costPer}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* MQL Source Attribution */}
      <AttributionPanel from={from} to={to} />

      {/* Drawer */}
      {openDrawer && (
        <StageDrawer
          stage={openDrawer}
          label={STAGES.find(s => s.key === openDrawer)?.label ?? openDrawer}
          from={from}
          to={to}
          onClose={() => setOpenDrawer(null)}
        />
      )}

      {/* Notifications panel */}
      {showNotifs && (
        <NotificationPanel
          initialCount={notifCount}
          onClose={() => { setShowNotifs(false); setNotifCount(0); }}
        />
      )}

      {/* Mar Ops AI chat */}
      <FunnelChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} />
      <button
        onClick={() => setChatOpen(true)}
        className={cn(
          "fixed bottom-6 right-6 z-40 flex items-center gap-2.5 px-4 py-3 rounded-2xl shadow-lg font-medium text-sm transition-all duration-200",
          chatOpen
            ? "opacity-0 pointer-events-none scale-90"
            : "bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-xl hover:scale-105"
        )}
      >
        <Bot className="w-5 h-5" />
        Ask AI
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Funnel Chat Drawer (Mar Ops agent, funnel-scoped)
// ---------------------------------------------------------------------------

interface ChatMsg { role: "user" | "assistant"; content: string }

const FUNNEL_STARTERS = [
  "What's our biggest funnel drop-off right now?",
  "How does our Visits → Lead conversion compare to last quarter?",
  "Which channel is driving the most MQLs?",
  "Are we on pace to hit our SQO target this quarter?",
  "What's driving the gap between MQLs and SQOs?",
];

function renderInline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={i} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`"))
      return <code key={i} className="bg-slate-100 text-slate-800 px-1 py-0.5 rounded text-xs font-mono">{part.slice(1, -1)}</code>;
    return part;
  });
}

function SimpleMarkdown({ content }: { content: string }) {
  const lines = content.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("### ")) {
      nodes.push(<h3 key={i} className="text-xs font-semibold text-slate-800 mt-3 mb-1">{renderInline(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      nodes.push(<h2 key={i} className="text-sm font-semibold text-slate-900 mt-3 mb-1.5">{renderInline(line.slice(3))}</h2>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("* "))) {
        items.push(lines[i].slice(2)); i++;
      }
      nodes.push(<ul key={`ul${i}`} className="list-disc list-inside space-y-0.5 mb-2">{items.map((it, j) => <li key={j} className="text-slate-700">{renderInline(it)}</li>)}</ul>);
      continue;
    } else if (line.trim() === "") {
      // skip
    } else {
      nodes.push(<p key={i} className="mb-2 last:mb-0">{renderInline(line)}</p>);
    }
    i++;
  }
  return <div className="text-xs leading-relaxed">{nodes}</div>;
}

function FunnelChatDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Conversation + archived sessions live in localStorage so the panel keeps
  // its history across closes and reloads (see src/lib/use-chat-history.ts).
  const { messages, setMessages, sessions, archiveAndClear, restoreSession, deleteSession, clearAll } =
    useChatHistory("funnel");
  const [showHistory, setShowHistory] = useState(false);
  const [input,       setInput]       = useState("");
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(q: string) {
    if (!q.trim() || loading) return;
    setError(null);
    setSuggestions([]);
    const userMsg: ChatMsg = { role: "user", content: q };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res  = await fetch("/api/mar-ops/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ question: q, messages: messages.map(m => ({ role: m.role, content: m.content })) }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMessages([...next, { role: "assistant", content: data.answer ?? "No response." }]);
      if (Array.isArray(data.suggestions)) setSuggestions(data.suggestions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setMessages(next);
    } finally {
      setLoading(false);
    }
  }

  function startNewConversation() {
    archiveAndClear();
    setSuggestions([]);
    setError(null);
    setInput("");
  }

  function openSession(session: ChatSession) {
    restoreSession(session);
    setSuggestions([]);
    setError(null);
    setShowHistory(false);
  }

  if (!open) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 w-[420px] max-h-[70vh] flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 bg-indigo-600 shrink-0">
        <Sparkles className="w-4 h-4 text-white" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-white leading-none">Mar Ops Agent</p>
          <p className="text-xs text-indigo-200 mt-0.5">Funnel analysis · live data</p>
        </div>
        <button onClick={() => setShowHistory(h => !h)} title="Conversation history"
          className={cn("p-1 rounded transition-colors mr-0.5",
            showHistory ? "bg-indigo-500 text-white" : "hover:bg-indigo-500 text-indigo-200 hover:text-white")}>
          <Clock className="w-3.5 h-3.5" />
        </button>
        <button onClick={startNewConversation} title="Save & start a new conversation"
          disabled={messages.length === 0}
          className="p-1 rounded hover:bg-indigo-500 transition-colors text-indigo-200 hover:text-white mr-0.5 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button onClick={onClose} className="p-1 rounded hover:bg-indigo-500 transition-colors text-indigo-200 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* History */}
      {showHistory && (
        <div className="flex-1 overflow-y-auto min-h-0 bg-slate-50">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-white sticky top-0">
            <button onClick={() => setShowHistory(false)} className="p-1 rounded hover:bg-slate-100 text-slate-500">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs font-semibold text-slate-700">Past conversations</span>
            <span className="ml-auto text-[10px] text-slate-400">{sessions.length} saved</span>
            {sessions.length > 0 && (
              <button onClick={() => { clearAll(); setSuggestions([]); setError(null); }}
                title="Delete all conversations"
                className="text-[10px] text-slate-400 hover:text-red-600 transition-colors">
                Clear all
              </button>
            )}
          </div>
          {sessions.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-8 px-4">
              No saved conversations yet. Chats are saved when you start a new one.
            </p>
          ) : (
            <ul className="divide-y divide-slate-200">
              {sessions.map(sn => (
                <li key={sn.id} className="flex items-start gap-2 px-3 py-2.5 hover:bg-white transition-colors">
                  <button onClick={() => openSession(sn)} className="flex-1 text-left min-w-0">
                    <p className="text-xs text-slate-700 truncate">{sn.title}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {relativeTime(sn.startedAt)} · {sn.messages.length} messages
                    </p>
                  </button>
                  <button onClick={() => deleteSession(sn.id)} title="Delete conversation"
                    className="p-1 rounded text-slate-300 hover:text-red-600 hover:bg-red-50 transition-colors shrink-0">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Messages */}
      <div className={cn("flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0", showHistory && "hidden")}>
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-slate-400 text-center py-2">Ask anything about your funnel</p>
            {FUNNEL_STARTERS.map((s) => (
              <button key={s} onClick={() => send(s)}
                className="w-full text-left text-xs px-3 py-2 bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 rounded-lg text-slate-600 hover:text-indigo-700 transition-colors">
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={cn("flex gap-2", m.role === "user" ? "flex-row-reverse" : "")}>
            <div className={cn("w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-white text-[10px] font-bold mt-0.5",
              m.role === "user" ? "bg-slate-700" : "bg-indigo-600")}>
              {m.role === "user" ? "Y" : <Bot className="w-3 h-3" />}
            </div>
            <div className={cn("rounded-xl px-3 py-2 max-w-[85%]",
              m.role === "user"
                ? "bg-slate-800 text-white text-xs leading-relaxed"
                : "bg-slate-50 border border-slate-200 text-slate-700")}>
              {m.role === "assistant" ? <SimpleMarkdown content={m.content} /> : <span className="text-xs">{m.content}</span>}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-2">
            <div className="w-6 h-6 rounded-full bg-indigo-600 shrink-0 flex items-center justify-center mt-0.5">
              <Bot className="w-3 h-3 text-white" />
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 flex items-center gap-2 text-xs text-slate-400">
              <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />
              Analysing…
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700">{error}</div>
        )}

        {suggestions.length > 0 && !loading && (
          <div className="space-y-1 pl-8">
            <p className="text-[10px] text-slate-400 font-medium">Suggested follow-ups</p>
            {suggestions.map((s, i) => (
              <button key={i} onClick={() => send(s)}
                className="w-full text-left text-xs text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 rounded-lg px-2 py-1.5 transition-colors">
                {s}
              </button>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className={cn("shrink-0 px-3 py-2 border-t border-slate-100", showHistory && "hidden")}>
        <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            placeholder="Ask about your funnel…"
            className="flex-1 bg-transparent text-xs text-slate-800 placeholder-slate-400 focus:outline-none"
          />
          <button onClick={() => send(input)} disabled={!input.trim() || loading}
            className={cn("w-6 h-6 rounded-lg flex items-center justify-center transition-colors",
              input.trim() && !loading ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-slate-200 text-slate-400 cursor-not-allowed")}>
            <Send className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
