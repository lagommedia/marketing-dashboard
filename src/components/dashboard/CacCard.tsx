"use client";

import { useEffect, useState } from "react";
import { Users, Loader2, Info } from "lucide-react";
import { MiniSparkline } from "@/components/dashboard/MiniSparkline";
import type { SparkPoint } from "@/components/dashboard/MiniSparkline";

interface Props {
  from:       string;
  to:         string;
  closedWon:  number | null;
  sparkData?: SparkPoint[];
}

interface CacResult {
  cac:              number | null;
  grossCosts?:      number;
  sharedAllocation?: number;
  pctElapsed?:      number;
  denominator?:     number;
  closedWon?:       number;
  reason?:          string;
}

function fmt(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function CacCard({ from, to, closedWon, sparkData }: Props) {
  const [result,  setResult]  = useState<CacResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!closedWon || closedWon <= 0) {
      setResult({ cac: null, reason: "No closed won customers in this period" });
      return;
    }
    setLoading(true);
    setResult(null);

    fetch(`/api/cac?from=${from}&to=${to}&closedWon=${closedWon}`)
      .then(async (r) => {
        const text = await r.text();
        try { return JSON.parse(text) as CacResult; }
        catch { throw new Error(`Server error ${r.status}`); }
      })
      .then((d) => setResult(d))
      .catch((e: Error) => setResult({ cac: null, reason: e.message }))
      .finally(() => setLoading(false));
  }, [from, to, closedWon]);

  const cac = result?.cac;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-indigo-500" />
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">CAC</span>
        </div>
        {/* Tooltip */}
        <div className="group relative">
          <Info className="w-3.5 h-3.5 text-slate-300 cursor-help" />
          <div className="absolute right-0 top-5 z-20 hidden group-hover:block w-64 bg-slate-900 text-white text-[11px] rounded-lg p-3 leading-relaxed shadow-xl">
            <p className="font-semibold mb-1">CAC Formula</p>
            <p className="text-slate-300">(Marketing Gross Costs + Shared Allocation) × % Elapsed ÷ Closed Won</p>
            {result?.denominator != null && (
              <div className="mt-2 pt-2 border-t border-slate-700 space-y-0.5 text-slate-400">
                <p>Gross costs: {fmt(result.grossCosts ?? 0)}</p>
                <p>Shared alloc: {fmt(result.sharedAllocation ?? 0)}</p>
                <p>Period elapsed: {Math.round((result.pctElapsed ?? 0) * 100)}%</p>
                <p>Total cost: {fmt(result.denominator)}</p>
                <p>Closed won: {result.closedWon} customers</p>
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
        ) : cac != null ? (
          <span className="text-3xl font-bold tabular-nums leading-none text-slate-900">
            {fmt(cac)}
          </span>
        ) : (
          <span className="text-2xl font-bold text-slate-300">—</span>
        )}
      </div>

      {/* Sub-label */}
      <p className="text-[11px] text-slate-400 leading-tight">
        {cac != null
          ? `per customer acquired`
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
