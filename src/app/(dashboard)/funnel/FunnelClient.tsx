"use client";

import { useState, useEffect, useCallback } from "react";
import { ExternalLink, X, Bell, ChevronRight, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FunnelCounts {
  leads:     number;
  mqls:      number;
  sqls:      number;
  sqos:      number;
  sqds:      number;
  closedWon: number;
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

type Stage = "leads" | "mqls" | "sqls" | "sqos" | "sqds" | "closedwon";

const STAGES: { key: Stage; label: string; color: string; bg: string; barColor: string }[] = [
  { key: "leads",     label: "Leads",      color: "text-slate-700",  bg: "bg-slate-100",   barColor: "bg-slate-400"  },
  { key: "mqls",      label: "MQLs",       color: "text-blue-700",   bg: "bg-blue-50",     barColor: "bg-blue-400"   },
  { key: "sqls",      label: "SQLs",       color: "text-indigo-700", bg: "bg-indigo-50",   barColor: "bg-indigo-500" },
  { key: "sqos",      label: "SQOs",       color: "text-violet-700", bg: "bg-violet-50",   barColor: "bg-violet-500" },
  { key: "sqds",      label: "SQDs",       color: "text-purple-700", bg: "bg-purple-50",   barColor: "bg-purple-500" },
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
         stage === "sqls"      ? counts.sqls      :
         stage === "sqos"      ? counts.sqos      :
         stage === "sqds"      ? counts.sqds      :
                                 counts.closedWon;
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

export function FunnelClient({ from, to, estimatedSpend, initialNotifCount }: Props) {
  const [counts,       setCounts]       = useState<FunnelCounts | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [openDrawer,   setOpenDrawer]   = useState<Stage | null>(null);
  const [showNotifs,   setShowNotifs]   = useState(false);
  const [notifCount,   setNotifCount]   = useState(initialNotifCount);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/hubspot/funnel-counts?from=${from}&to=${to}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setCounts(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  const conversionPairs: [Stage, Stage][] = [
    ["leads", "mqls"],
    ["mqls",  "sqls"],
    ["sqls",  "sqos"],
    ["sqos",  "sqds"],
    ["sqds",  "closedwon"],
  ];

  return (
    <>
      {/* Notification button */}
      <div className="flex justify-end">
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
          const leadsCount = Math.max(counts.leads, 1);
          return STAGES.map((stage, i) => {
            const count    = getCount(counts, stage.key);
            // Scale bar relative to leads; minimum 6% so tiny bars stay visible
            const barPct   = Math.max((count / leadsCount) * 100, 6);

            const prevCount  = i > 0 ? getCount(counts, STAGES[i - 1].key) : null;
            const conversion = prevCount != null ? fmtPct(count, prevCount) : "—";
            const costPer    = estimatedSpend != null && count > 0
              ? fmtCurrency(estimatedSpend / count)
              : "—";

            return (
              <button
                key={stage.key}
                onClick={() => setOpenDrawer(stage.key)}
                className="w-full grid grid-cols-[1fr_auto_auto_auto] gap-0 items-stretch hover:bg-slate-50/80 transition-colors border-b border-slate-100 last:border-0 text-left group"
              >
                {/* Funnel bar (centered, proportional) */}
                <div className="py-2 px-4 flex items-center">
                  <div className="relative flex-1 h-9">
                    {/* Centered fill */}
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
                    {/* Label inside fill */}
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-white text-xs font-semibold drop-shadow-sm px-2 truncate">
                        {stage.label}
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="ml-2 w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500 shrink-0 transition-colors" />
                </div>

                {/* Count */}
                <div className="flex items-center justify-end w-24 px-4">
                  <span className="text-sm font-semibold text-slate-800 tabular-nums">
                    {count.toLocaleString()}
                  </span>
                </div>

                {/* Conversion */}
                <div className="flex items-center justify-end w-28 px-4">
                  {i === 0 ? (
                    <span className="text-xs text-slate-300">—</span>
                  ) : (
                    <span className={cn(
                      "text-xs font-medium",
                      conversion === "—" ? "text-slate-300" : "text-slate-600"
                    )}>
                      {conversion}
                    </span>
                  )}
                </div>

                {/* Cost per */}
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
          });
        })()}
      </div>

      {/* Conversion rate summary row */}
      {counts && (
        <div className="bg-slate-50 rounded-xl border border-slate-200 p-5">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Stage Conversion Rates</p>
          <div className="flex items-center gap-2 flex-wrap">
            {conversionPairs.map(([from_stage, to_stage]) => {
              const a = getCount(counts, from_stage);
              const b = getCount(counts, to_stage);
              const fromLabel = STAGES.find(s => s.key === from_stage)?.label ?? from_stage;
              const toLabel   = STAGES.find(s => s.key === to_stage)?.label  ?? to_stage;
              const pct = fmtPct(b, a);
              return (
                <div key={`${from_stage}-${to_stage}`} className="flex items-center gap-1 bg-white rounded-lg border border-slate-200 px-3 py-2">
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
      {counts && estimatedSpend != null && (
        <div className="bg-slate-50 rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Cost Per Stage</p>
            <p className="text-xs text-slate-400">Based on {fmtCurrency(estimatedSpend)} est. marketing spend</p>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {STAGES.map(stage => {
              const count   = getCount(counts, stage.key);
              const costPer = count > 0 ? fmtCurrency(estimatedSpend / count) : "—";
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
    </>
  );
}
