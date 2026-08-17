"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Target, X, Save } from "lucide-react";
import { cn } from "@/lib/utils";

interface ExistingTarget {
  targetMqls?: number | null;
  targetSqos?: number | null;
  targetPipeline?: number | null;
  targetClosedWon?: number | null;
  targetRevenue?: number | null;
  targetSpend?: number | null;
}

interface Props {
  channel: string;
  period: string;
  existing: ExistingTarget | null;
}

const FIELDS: {
  key: keyof ExistingTarget;
  label: string;
  placeholder: string;
  prefix?: string;
}[] = [
  { key: "targetMqls", label: "MQLs", placeholder: "100" },
  { key: "targetSqos", label: "SQOs", placeholder: "25" },
  { key: "targetPipeline", label: "Pipeline", placeholder: "500000", prefix: "$" },
  { key: "targetClosedWon", label: "Closed Won", placeholder: "10" },
  { key: "targetRevenue", label: "Revenue", placeholder: "100000", prefix: "$" },
  { key: "targetSpend", label: "Spend", placeholder: "50000", prefix: "$" },
];

export function PacingTargetForm({ channel, period, existing }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(
      FIELDS.map((f) => [f.key, existing?.[f.key] != null ? String(existing[f.key]) : ""])
    )
  );

  function handleOpen() {
    // Reset values from latest existing prop each time the modal opens
    setValues(
      Object.fromEntries(
        FIELDS.map((f) => [f.key, existing?.[f.key] != null ? String(existing[f.key]) : ""])
      )
    );
    setError(null);
    setOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const payload: Record<string, number | null | string> = { channel, period };
      for (const f of FIELDS) {
        const v = values[f.key].trim();
        payload[f.key] = v ? parseFloat(v) : null;
      }
      const res = await fetch("/api/pacing/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "Failed to save targets");
      }
      setOpen(false);
      router.refresh(); // re-run server component to reflect new targets
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const channelLabel = channel.replace("_", " ");

  return (
    <>
      <button
        onClick={handleOpen}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
      >
        <Target className="w-3 h-3" />
        {existing ? "Edit targets" : "Set targets"}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-md">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Quarterly Targets
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 capitalize">
                  {channelLabel} · {period}
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSave} className="p-5 space-y-4">
              <p className="text-xs text-slate-500">
                Leave a field blank to exclude it from pacing calculations.
              </p>
              <div className="grid grid-cols-2 gap-3">
                {FIELDS.map((field) => (
                  <div key={field.key}>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      {field.label}
                    </label>
                    <div className="relative">
                      {field.prefix && (
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">
                          {field.prefix}
                        </span>
                      )}
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={values[field.key]}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [field.key]: e.target.value }))
                        }
                        placeholder={field.placeholder}
                        className={cn(
                          "w-full text-xs rounded-lg border border-slate-200 py-2 pr-3 text-slate-900 placeholder-slate-400",
                          "focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
                          field.prefix ? "pl-5" : "pl-3"
                        )}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {error && (
                <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                  {error}
                </p>
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
                  {saving ? "Saving…" : "Save targets"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
