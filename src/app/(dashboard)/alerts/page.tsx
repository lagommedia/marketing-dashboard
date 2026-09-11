"use client";

import { useState, useEffect, useCallback } from "react";
import { Bell, RefreshCw, Check, ChevronDown, ExternalLink, AlertTriangle, TrendingDown, UserX, Phone } from "lucide-react";
import { cn } from "@/lib/utils";

interface AuditAlert {
  id:              string;
  alertType:       string;
  detectedAt:      string;
  contactId?:      string;
  contactName?:    string;
  contactUrl?:     string;
  companyId?:      string;
  companyName?:    string;
  dealId?:         string;
  dealName?:       string;
  dealUrl?:        string;
  fromValue?:      string;
  toValue?:        string;
  changeReason?:   string;
  changedByUserId?: string;
  changedByName?:  string;
  changedAt?:      string;
  metadata?:       string;
  dismissed:       boolean;
}

const ALERT_META: Record<string, { label: string; color: string; icon: React.ElementType; bg: string }> = {
  sqo_attribution:         { label: "SQO Attribution Change",   color: "text-amber-700",  icon: AlertTriangle, bg: "bg-amber-50 border-amber-200"  },
  sqd_closed_lost:         { label: "SQD → Closed Lost",        color: "text-red-700",    icon: TrendingDown,  bg: "bg-red-50 border-red-200"       },
  negative_arr:            { label: "Negative ARR Shift",       color: "text-red-700",    icon: TrendingDown,  bg: "bg-red-50 border-red-200"       },
  workflow_unenroll:       { label: "Workflow Unenrollment",    color: "text-purple-700", icon: UserX,         bg: "bg-purple-50 border-purple-200" },
  inbound_outbound_worked: { label: "Inbound Worked by Outbound", color: "text-blue-700", icon: Phone,         bg: "bg-blue-50 border-blue-200"    },
};

const TYPE_FILTERS = [
  { value: "",                      label: "All Types" },
  { value: "sqo_attribution",       label: "SQO Attribution" },
  { value: "sqd_closed_lost",       label: "SQD → Closed Lost" },
  { value: "negative_arr",          label: "Negative ARR" },
  { value: "workflow_unenroll",     label: "Workflow Unenroll" },
  { value: "inbound_outbound_worked", label: "Inbound Worked by Outbound" },
];

function AlertCard({ alert, onDismiss }: { alert: AuditAlert; onDismiss: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const meta    = ALERT_META[alert.alertType] ?? { label: alert.alertType, color: "text-slate-700", icon: Bell, bg: "bg-slate-50 border-slate-200" };
  const Icon    = meta.icon;
  const metadata = alert.metadata ? (() => { try { return JSON.parse(alert.metadata!); } catch { return {}; } })() : {};

  const changedAtStr = alert.changedAt
    ? new Date(alert.changedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div className={cn("border rounded-xl overflow-hidden", meta.bg)}>
      {/* Header row */}
      <div className="flex items-start gap-3 p-4">
        <div className={cn("mt-0.5 shrink-0", meta.color)}>
          <Icon className="w-4 h-4" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("text-xs font-semibold uppercase tracking-wider", meta.color)}>
              {meta.label}
            </span>
            {changedAtStr && (
              <span className="text-[11px] text-slate-400">{changedAtStr}</span>
            )}
          </div>

          {/* Primary summary line */}
          <p className="text-sm font-medium text-slate-800 mt-0.5">
            {alert.contactName && (
              <a href={alert.contactUrl ?? "#"} target="_blank" rel="noopener noreferrer"
                className="underline decoration-dotted hover:text-indigo-700 mr-1" onClick={e => e.stopPropagation()}>
                {alert.contactName}
              </a>
            )}
            {alert.companyName && !alert.contactName && (
              <span className="mr-1">{alert.companyName}</span>
            )}
            {alert.dealName && (
              <a href={alert.dealUrl ?? "#"} target="_blank" rel="noopener noreferrer"
                className="underline decoration-dotted hover:text-indigo-700 mx-1" onClick={e => e.stopPropagation()}>
                {alert.dealName}
              </a>
            )}
          </p>

          {/* Change summary */}
          {(alert.fromValue || alert.toValue) && (
            <p className="text-xs text-slate-600 mt-0.5">
              {alert.fromValue && <span className="line-through mr-1 opacity-60">{alert.fromValue}</span>}
              {alert.fromValue && alert.toValue && <span className="mr-1">→</span>}
              {alert.toValue && <span className="font-medium">{alert.toValue}</span>}
            </p>
          )}

          {alert.changeReason && (
            <p className="text-xs text-slate-500 mt-0.5">
              <span className="font-medium">Reason:</span> {alert.changeReason}
            </p>
          )}

          {alert.changedByName && (
            <p className="text-xs text-slate-500 mt-0.5">
              <span className="font-medium">Changed by:</span> {alert.changedByName}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setExpanded(v => !v)}
            className="p-1.5 rounded-lg hover:bg-black/10 text-slate-400 transition-colors"
            title="Expand details"
          >
            <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", expanded && "rotate-180")} />
          </button>
          <button
            onClick={() => onDismiss(alert.id)}
            className="p-1.5 rounded-lg hover:bg-black/10 text-slate-400 hover:text-emerald-600 transition-colors"
            title="Dismiss"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-current/10 px-4 py-3 bg-white/50 space-y-1.5">
          {alert.companyName && alert.contactName && (
            <p className="text-xs text-slate-500"><span className="font-medium">Company:</span> {alert.companyName}</p>
          )}
          {metadata.daysSinceCreation !== undefined && (
            <p className="text-xs text-slate-500"><span className="font-medium">Days in workflow:</span> {metadata.daysSinceCreation}</p>
          )}
          {metadata.amount && (
            <p className="text-xs text-slate-500"><span className="font-medium">Deal amount:</span> ${parseFloat(metadata.amount).toLocaleString()}</p>
          )}
          {metadata.engagementType && (
            <p className="text-xs text-slate-500"><span className="font-medium">Activity type:</span> {metadata.engagementType}</p>
          )}
          {metadata.dealSource && (
            <p className="text-xs text-slate-500"><span className="font-medium">Deal source:</span> {metadata.dealSource}</p>
          )}
          {metadata.bodyPreview && (
            <p className="text-xs text-slate-500 truncate"><span className="font-medium">Preview:</span> {metadata.bodyPreview}</p>
          )}
          {alert.changedByUserId && !alert.changedByName && (
            <p className="text-xs text-slate-400">HubSpot user ID: {alert.changedByUserId}</p>
          )}
          <div className="flex gap-3 pt-1">
            {alert.contactUrl && (
              <a href={alert.contactUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-indigo-600 hover:underline">
                <ExternalLink className="w-3 h-3" /> View contact
              </a>
            )}
            {alert.dealUrl && (
              <a href={alert.dealUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-indigo-600 hover:underline">
                <ExternalLink className="w-3 h-3" /> View deal
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AlertsPage() {
  const [alerts,      setAlerts]      = useState<AuditAlert[]>([]);
  const [total,       setTotal]       = useState(0);
  const [loading,     setLoading]     = useState(true);
  const [running,     setRunning]     = useState(false);
  const [typeFilter,  setTypeFilter]  = useState("");
  const [runResult,   setRunResult]   = useState<string | null>(null);

  const load = useCallback(async (type = typeFilter) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (type) params.set("alertType", type);
      const res  = await fetch(`/api/hubspot/audit/alerts?${params}`);
      const data = await res.json();
      setAlerts(data.alerts ?? []);
      setTotal(data.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => { load(); }, [load]);

  async function runAudit() {
    setRunning(true);
    setRunResult(null);
    try {
      const res  = await fetch("/api/hubspot/audit/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lookbackHours: 25 }) });
      const data = await res.json();
      if (data.ok) {
        const a = data.alerts;
        setRunResult(`Audit complete — ${a.sqoAttribution} attribution, ${a.sqdClosedLost} closed lost, ${a.negativeArr} ARR shifts, ${a.workflowUnenroll} unenrollments, ${a.inboundOutboundWorked} inbound/outbound`);
        await load(typeFilter);
      } else {
        setRunResult(`Error: ${data.error}`);
      }
    } catch (e) {
      setRunResult(`Failed: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setRunning(false);
    }
  }

  async function dismiss(id: string) {
    await fetch("/api/hubspot/audit/alerts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setAlerts(prev => prev.filter(a => a.id !== id));
    setTotal(t => Math.max(0, t - 1));
  }

  async function dismissAll() {
    const type = typeFilter || undefined;
    await fetch("/api/hubspot/audit/alerts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismissAll: true, alertType: type }),
    });
    setAlerts([]);
    setTotal(0);
  }

  function changeType(t: string) {
    setTypeFilter(t);
    load(t);
  }

  // Group alerts by type for the summary chips
  const counts = alerts.reduce<Record<string, number>>((acc, a) => {
    acc[a.alertType] = (acc[a.alertType] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Bell className="w-6 h-6 text-indigo-500" />
            HubSpot Audit Alerts
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Daily automated audit — {total} active alert{total !== 1 ? "s" : ""}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {alerts.length > 0 && (
            <button
              onClick={dismissAll}
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
            >
              Dismiss all{typeFilter ? " (filtered)" : ""}
            </button>
          )}
          <button
            onClick={() => load(typeFilter)}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors flex items-center gap-1.5"
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
          <button
            onClick={runAudit}
            disabled={running}
            className="px-4 py-1.5 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            {running ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Bell className="w-3 h-3" />}
            {running ? "Running audit…" : "Run audit now"}
          </button>
        </div>
      </div>

      {/* Run result banner */}
      {runResult && (
        <div className="px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">
          {runResult}
        </div>
      )}

      {/* Type filter */}
      <div className="flex gap-2 flex-wrap">
        {TYPE_FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => changeType(f.value)}
            className={cn(
              "px-3 py-1 text-xs rounded-full border transition-colors",
              typeFilter === f.value
                ? "bg-indigo-600 text-white border-indigo-600"
                : "border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-700",
            )}
          >
            {f.label}
            {f.value && counts[f.value] ? (
              <span className="ml-1.5 opacity-70">({counts[f.value]})</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Alert list */}
      {loading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => (
            <div key={i} className="h-20 rounded-xl bg-slate-100 animate-pulse" />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <div className="text-center py-20 text-slate-400">
          <Bell className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No active alerts{typeFilter ? " for this type" : ""}.</p>
          <p className="text-xs mt-1">Run the audit to check for new anomalies.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map(alert => (
            <AlertCard key={alert.id} alert={alert} onDismiss={dismiss} />
          ))}
        </div>
      )}

      {/* Info panel */}
      <div className="mt-8 p-4 rounded-xl bg-slate-50 border border-slate-200">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Alert Types</p>
        <ul className="space-y-1">
          <li className="text-xs text-slate-600"><span className="font-medium">SQO Attribution Change</span> — deal_source changed on a deal linked to a completed demo meeting</li>
          <li className="text-xs text-slate-600"><span className="font-medium">SQD → Closed Lost</span> — a deal that was at the SQD stage moved to Closed Lost (with reason)</li>
          <li className="text-xs text-slate-600"><span className="font-medium">Negative ARR Shift</span> — deal amount decreased or deal stage moved backward</li>
          <li className="text-xs text-slate-600"><span className="font-medium">Workflow Unenrollment</span> — inbound contact opted out / unenrolled before 60 days in workflow</li>
          <li className="text-xs text-slate-600"><span className="font-medium">Inbound Worked by Outbound</span> — inbound-attributed contact received a call, email, or task from an outbound rep</li>
        </ul>
        <p className="text-xs text-slate-400 mt-3">The audit runs automatically every day at 2 AM via the daily sync cron. You can also trigger it manually with "Run audit now".</p>
      </div>
    </div>
  );
}
