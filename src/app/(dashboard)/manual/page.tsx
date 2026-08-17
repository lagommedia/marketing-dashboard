"use client";

import { useState } from "react";
import { PencilLine, Trash2, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonthIso() {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

function formatNum(v: string) {
  const n = parseFloat(v);
  return isNaN(n) ? "" : n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FormState {
  from: string;
  to:   string;
  paid_impressions:    string;
  paid_clicks:         string;
  paid_spend:          string;
  organic_impressions: string;
  organic_clicks:      string;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ManualEntryPage() {
  const [form, setForm] = useState<FormState>({
    from: firstOfMonthIso(),
    to:   todayIso(),
    paid_impressions:    "",
    paid_clicks:         "",
    paid_spend:          "",
    organic_impressions: "",
    organic_clicks:      "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [deleting,   setDeleting]   = useState(false);
  const [result,     setResult]     = useState<{ ok: boolean; message: string } | null>(null);

  function set(key: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setResult(null);
  }

  // Count days in range for preview
  const dayCount = (() => {
    if (!form.from || !form.to) return 0;
    const a = new Date(form.from + "T00:00:00");
    const b = new Date(form.to   + "T00:00:00");
    const diff = Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
    return diff > 0 ? diff : 0;
  })();

  const hasAnyValue = [
    form.paid_impressions, form.paid_clicks, form.paid_spend,
    form.organic_impressions, form.organic_clicks,
  ].some((v) => v.trim() !== "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const body: Record<string, string | number> = { from: form.from, to: form.to };
      if (form.paid_impressions.trim())    body.paid_impressions    = parseFloat(form.paid_impressions.replace(/,/g, ""));
      if (form.paid_clicks.trim())         body.paid_clicks         = parseFloat(form.paid_clicks.replace(/,/g, ""));
      if (form.paid_spend.trim())          body.paid_spend          = parseFloat(form.paid_spend.replace(/,/g, ""));
      if (form.organic_impressions.trim()) body.organic_impressions = parseFloat(form.organic_impressions.replace(/,/g, ""));
      if (form.organic_clicks.trim())      body.organic_clicks      = parseFloat(form.organic_clicks.replace(/,/g, ""));

      const res = await fetch("/api/manual/entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      setResult({ ok: true, message: `Saved — ${data.snapshots} daily snapshots written across ${data.days} days.` });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete all manual entries between ${form.from} and ${form.to}? This cannot be undone.`)) return;
    setDeleting(true);
    setResult(null);
    try {
      const params = new URLSearchParams({ from: form.from, to: form.to, channel: "all" });
      const res = await fetch(`/api/manual/entry?${params}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to delete");
      setResult({ ok: true, message: `Deleted ${data.deleted} manual snapshots.` });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="p-8 max-w-2xl space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <PencilLine className="w-5 h-5 text-slate-600" />
          <h1 className="text-2xl font-bold text-slate-900">Manual Entry</h1>
        </div>
        <p className="text-sm text-slate-500">
          Enter totals for a date range — they&apos;ll be distributed evenly across each day
          and appear in the Overview and Trends alongside synced data.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">

        {/* Date range */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-700">Date Range</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">From</label>
              <input
                type="date"
                value={form.from}
                onChange={(e) => set("from", e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">To</label>
              <input
                type="date"
                value={form.to}
                onChange={(e) => set("to", e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                required
              />
            </div>
          </div>
          {dayCount > 0 && (
            <p className="text-xs text-slate-400">
              {dayCount} day{dayCount !== 1 ? "s" : ""} — each metric total will be split evenly across all days
            </p>
          )}
        </div>

        {/* Paid Media */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-violet-100 text-violet-700">
              Paid Media
            </span>
            <span className="text-xs text-slate-400">Google Ads, LinkedIn, Facebook, etc.</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <MetricInput
              label="Impressions"
              value={form.paid_impressions}
              onChange={(v) => set("paid_impressions", v)}
              placeholder="e.g. 250,000"
            />
            <MetricInput
              label="Clicks"
              value={form.paid_clicks}
              onChange={(v) => set("paid_clicks", v)}
              placeholder="e.g. 4,200"
            />
            <MetricInput
              label="Spend"
              value={form.paid_spend}
              onChange={(v) => set("paid_spend", v)}
              placeholder="e.g. 18,500"
              prefix="$"
            />
          </div>
        </div>

        {/* Organic */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
              Organic
            </span>
            <span className="text-xs text-slate-400">Google Search Console, SEO</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <MetricInput
              label="Impressions"
              value={form.organic_impressions}
              onChange={(v) => set("organic_impressions", v)}
              placeholder="e.g. 85,000"
            />
            <MetricInput
              label="Clicks"
              value={form.organic_clicks}
              onChange={(v) => set("organic_clicks", v)}
              placeholder="e.g. 3,100"
            />
          </div>
        </div>

        {/* Result banner */}
        {result && (
          <div className={cn(
            "flex items-start gap-3 px-4 py-3 rounded-xl text-sm border",
            result.ok
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-red-50 border-red-200 text-red-800"
          )}>
            {result.ok && <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />}
            {result.message}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting || !hasAnyValue || dayCount === 0}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors",
              !submitting && hasAnyValue && dayCount > 0
                ? "bg-indigo-600 text-white hover:bg-indigo-700"
                : "bg-slate-100 text-slate-400 cursor-not-allowed"
            )}
          >
            {submitting ? "Saving…" : "Save entries"}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || submitting}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {deleting ? "Clearing…" : "Clear range"}
          </button>
        </div>

        <p className="text-xs text-slate-400">
          Entries are saved as &quot;manual&quot; data and can be cleared at any time using the
          button above. Once your ad integrations are connected, disable manual entries
          for that period to avoid double-counting.
        </p>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MetricInput sub-component
// ---------------------------------------------------------------------------

function MetricInput({
  label,
  value,
  onChange,
  placeholder,
  prefix,
}: {
  label:       string;
  value:       string;
  onChange:    (v: string) => void;
  placeholder: string;
  prefix?:     string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 pointer-events-none">
            {prefix}
          </span>
        )}
        <input
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn(
            "w-full text-sm rounded-lg border border-slate-200 py-2 pr-3 text-slate-900 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500",
            prefix ? "pl-6" : "pl-3"
          )}
        />
      </div>
    </div>
  );
}
