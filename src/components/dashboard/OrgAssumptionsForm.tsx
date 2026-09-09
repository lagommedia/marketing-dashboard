"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Target, X, Save } from "lucide-react";
import { cn } from "@/lib/utils";

interface ExistingTarget {
  targetRevenue?:  number | null;
  targetSpend?:    number | null;
  targetClosedWon?: number | null;
  arpu?:           number | null;
  arrChurnPct?:    number | null;  // stored as decimal e.g. 0.05
  arrChurnAmt?:    number | null;
}

interface Props {
  period:   string;
  existing: ExistingTarget | null;
}

interface Field {
  key:         keyof ExistingTarget;
  label:       string;
  hint?:       string;
  placeholder: string;
  prefix?:     string;
  suffix?:     string;
  // For arrChurnPct: stored as decimal but displayed/entered as percentage
  pctMode?:    boolean;
}

const FIELDS: Field[] = [
  { key: "targetRevenue",  label: "Revenue Target",   placeholder: "1000000", prefix: "$",
    hint: "Quarterly revenue goal" },
  { key: "targetSpend",    label: "Gross Expenses",   placeholder: "250000",  prefix: "$",
    hint: "Headcount + Tools + Advertising" },
  { key: "targetClosedWon", label: "Closed Won Target", placeholder: "20",
    hint: "New customers this quarter" },
  { key: "arpu",           label: "Estimated ARPU",   placeholder: "12000",   prefix: "$",
    hint: "Average revenue per account (annual)" },
  { key: "arrChurnPct",    label: "ARR Churn %",      placeholder: "5",       suffix: "%",
    hint: "Total ARR churn rate (annual)", pctMode: true },
  { key: "arrChurnAmt",    label: "ARR Churn $",      placeholder: "50000",   prefix: "$",
    hint: "Total ARR churn amount ($)" },
];

export function OrgAssumptionsForm({ period, existing }: Props) {
  const router = useRouter();
  const [open,   setOpen]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  function initValues(): Record<string, string> {
    return Object.fromEntries(
      FIELDS.map((f) => {
        const raw = existing?.[f.key];
        if (raw == null) return [f.key, ""];
        // Display arrChurnPct as percentage (0.05 → "5")
        const display = f.pctMode ? String(Math.round((raw as number) * 10000) / 100) : String(raw);
        return [f.key, display];
      })
    );
  }

  const [values, setValues] = useState<Record<string, string>>(initValues);

  function handleOpen() {
    setValues(initValues());
    setError(null);
    setOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const payload: Record<string, number | null | string> = {
        channel: "marketing_org",
        period,
      };
      for (const f of FIELDS) {
        const v = values[f.key].trim();
        if (!v) { payload[f.key] = null; continue; }
        const n = parseFloat(v);
        if (isNaN(n)) { payload[f.key] = null; continue; }
        // Convert pct display → decimal for storage
        payload[f.key] = f.pctMode ? n / 100 : n;
      }
      const res = await fetch("/api/pacing/targets", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? "Failed to save");
      }
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={handleOpen}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
      >
        <Target className="w-3 h-3" />
        {existing ? "Edit assumptions" : "Set assumptions"}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Marketing Org Assumptions</h3>
                <p className="text-xs text-slate-500 mt-0.5">{period}</p>
              </div>
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-5 space-y-4">
              <p className="text-xs text-slate-500">
                Leave a field blank to exclude it from calculations. Saving creates a new record for <strong>{period}</strong> without overwriting past quarters.
              </p>
              <div className="grid grid-cols-2 gap-3">
                {FIELDS.map((field) => (
                  <div key={field.key}>
                    <label className="block text-xs font-medium text-slate-700 mb-0.5">{field.label}</label>
                    {field.hint && <p className="text-[10px] text-slate-400 mb-1">{field.hint}</p>}
                    <div className="relative">
                      {field.prefix && (
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">
                          {field.prefix}
                        </span>
                      )}
                      {field.suffix && (
                        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">
                          {field.suffix}
                        </span>
                      )}
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={values[field.key]}
                        onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                        placeholder={field.placeholder}
                        className={cn(
                          "w-full text-xs rounded-lg border border-slate-200 py-2 text-slate-900 placeholder-slate-400",
                          "focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
                          field.prefix ? "pl-5 pr-3" : field.suffix ? "pl-3 pr-6" : "px-3"
                        )}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {error && (
                <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors",
                    saving
                      ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                      : "bg-indigo-600 text-white hover:bg-indigo-700"
                  )}
                >
                  <Save className="w-3.5 h-3.5" />
                  {saving ? "Saving…" : "Save assumptions"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
