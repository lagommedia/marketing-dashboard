"use client";

import { useEffect, useState } from "react";
import { Star, Loader2, Info } from "lucide-react";
import { MiniSparkline } from "@/components/dashboard/MiniSparkline";
import type { SparkPoint } from "@/components/dashboard/MiniSparkline";

interface Props {
  from:       string;
  to:         string;
  sparkData?: SparkPoint[];
}

interface LtvResult {
  ltv:              number | null;
  arpu?:            number;
  grossMargin?:     number;
  churnRate?:       number;   // monthly
  annualChurnRate?: number;   // × 12
  targetMonth?:     string;
  labels?:          { arpu: string; margin: string; churn: string };
  reason?:          string;
}

function fmtCurrency(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtPct(v: number): string {
  // v is 0–1 decimal
  return `${(v * 100).toFixed(1)}%`;
}

export function LtvCard({ from, to, sparkData }: Props) {
  const [result,  setResult]  = useState<LtvResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setResult(null);

    fetch(`/api/ltv?from=${from}&to=${to}`)
      .then(async (r) => {
        const text = await r.text();
        try { return JSON.parse(text) as LtvResult; }
        catch { throw new Error(`Server error ${r.status}`); }
      })
      .then((d) => setResult(d))
      .catch((e: Error) => setResult({ ltv: null, reason: e.message }))
      .finally(() => setLoading(false));
  }, [from, to]);

  const ltv = result?.ltv;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Star className="w-3.5 h-3.5 text-indigo-500" />
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">LTV</span>
        </div>
        {/* Tooltip */}
        <div className="group relative">
          <Info className="w-3.5 h-3.5 text-slate-300 cursor-help" />
          <div className="absolute right-0 top-5 z-20 hidden group-hover:block w-64 bg-slate-900 text-white text-[11px] rounded-lg p-3 leading-relaxed shadow-xl">
            <p className="font-semibold mb-1">LTV Formula</p>
            <p className="text-slate-300">(Annual ARPU × Gross Margin %) ÷ (Monthly Churn × 12)</p>
            {result?.targetMonth && (
              <p className="mt-1 text-slate-500">Snapshot: {result.targetMonth}</p>
            )}
            {result?.arpu != null && (
              <div className="mt-2 pt-2 border-t border-slate-700 space-y-0.5 text-slate-400">
                <p>{result.labels?.arpu ?? "ARPU"} (annual): {fmtCurrency(result.arpu)}</p>
                <p>{result.labels?.margin ?? "Gross Margin"}: {fmtPct(result.grossMargin ?? 0)}</p>
                <p>{result.labels?.churn ?? "Churn Rate"}: {fmtPct(result.churnRate ?? 0)}/mo → {fmtPct(result.annualChurnRate ?? 0)}/yr</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Value */}
      <div className="flex items-end gap-2">
        {loading ? (
          <div className="flex items-center gap-1.5 text-slate-400 text-sm">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="text-xs">Calculating…</span>
          </div>
        ) : ltv != null ? (
          <span className="text-3xl font-bold tabular-nums leading-none text-slate-900">
            {fmtCurrency(ltv)}
          </span>
        ) : (
          <span className="text-2xl font-bold text-slate-300">—</span>
        )}
      </div>

      {/* Sub-label */}
      <p className="text-[11px] text-slate-400 leading-tight">
        {ltv != null
          ? "per customer lifetime"
          : result?.reason
            ? <span className="text-amber-500">{result.reason}</span>
            : "Connect Google Sheets to calculate"}
      </p>

      {/* Sparkline */}
      {(sparkData?.length ?? 0) >= 2 && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <MiniSparkline data={sparkData!} format="currency" />
        </div>
      )}
    </div>
  );
}
