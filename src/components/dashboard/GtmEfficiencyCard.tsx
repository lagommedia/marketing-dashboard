"use client";

import { useEffect, useState } from "react";
import { TrendingUp, Loader2, Info } from "lucide-react";
import { MiniSparkline } from "@/components/dashboard/MiniSparkline";
import type { SparkPoint } from "@/components/dashboard/MiniSparkline";

interface Props {
  from:       string;
  to:         string;
  revenue:    number | null;
  sparkData?: SparkPoint[];
}

interface GtmResult {
  gtmEfficiency:   number | null;
  grossCosts?:     number;
  sharedAllocation?: number;
  denominator?:    number;
  pctElapsed?:     number;
  reason?:         string;
}

function fmt(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

export function GtmEfficiencyCard({ from, to, revenue, sparkData }: Props) {
  const [result,  setResult]  = useState<GtmResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (revenue == null) return;
    setLoading(true);
    setResult(null);

    fetch(`/api/metrics/gtm-efficiency?from=${from}&to=${to}&revenue=${revenue}`)
      .then(async (r) => {
        const text = await r.text();
        try {
          return JSON.parse(text) as GtmResult;
        } catch {
          // Route threw an HTML error page — surface the status
          throw new Error(`Server error ${r.status}: ${text.slice(0, 120)}`);
        }
      })
      .then((d) => setResult(d))
      .catch((e: Error) => setResult({ gtmEfficiency: null, reason: e.message }))
      .finally(() => setLoading(false));
  }, [from, to, revenue]);

  const efficiency = result?.gtmEfficiency;
  const isGood     = efficiency != null && efficiency >= 1;
  const isGreat    = efficiency != null && efficiency >= 2;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5 text-indigo-500" />
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
            GTM Efficiency
          </span>
        </div>
        {/* Tooltip trigger */}
        <div className="group relative">
          <Info className="w-3.5 h-3.5 text-slate-300 cursor-help" />
          <div className="absolute right-0 top-5 z-20 hidden group-hover:block w-64 bg-slate-900 text-white text-[11px] rounded-lg p-3 leading-relaxed shadow-xl">
            <p className="font-semibold mb-1">GTM Efficiency Formula</p>
            <p className="text-slate-300">Revenue ÷ ((Marketing Gross Costs + Shared Allocation) × % of Period Elapsed)</p>
            {result?.denominator != null && (
              <div className="mt-2 pt-2 border-t border-slate-700 space-y-0.5 text-slate-400">
                <p>Gross costs: {fmt(result.grossCosts ?? 0)}</p>
                <p>Shared alloc: {fmt(result.sharedAllocation ?? 0)}</p>
                <p>Period elapsed: {Math.round((result.pctElapsed ?? 0) * 100)}%</p>
                <p>Denominator: {fmt(result.denominator)}</p>
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
        ) : efficiency != null ? (
          <>
            <span className={`text-3xl font-bold tabular-nums leading-none ${
              isGreat ? "text-emerald-600" : isGood ? "text-indigo-700" : "text-amber-600"
            }`}>
              {efficiency.toFixed(2)}x
            </span>
            <span className={`text-xs font-medium mb-0.5 ${
              isGreat ? "text-emerald-500" : isGood ? "text-indigo-400" : "text-amber-500"
            }`}>
              {isGreat ? "Strong" : isGood ? "On track" : "Below 1×"}
            </span>
          </>
        ) : (
          <span className="text-2xl font-bold text-slate-300">—</span>
        )}
      </div>

      {/* Sub-label */}
      <p className="text-[11px] text-slate-400 leading-tight">
        {efficiency != null
          ? `$${efficiency.toFixed(2)} revenue per $1 of marketing cost`
          : result?.reason
            ? <span className="text-amber-500">{result.reason}</span>
            : "Connect Google Sheets to calculate"}
      </p>

      {/* Sparkline */}
      {(sparkData?.length ?? 0) >= 2 && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <MiniSparkline data={sparkData!} format="ratio" />
        </div>
      )}
    </div>
  );
}
