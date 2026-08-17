"use client";

import { useEffect, useState } from "react";
import { Ratio, Loader2, Info } from "lucide-react";
import { MiniSparkline } from "@/components/dashboard/MiniSparkline";
import type { SparkPoint } from "@/components/dashboard/MiniSparkline";

interface Props {
  from:       string;
  to:         string;
  closedWon:  number | null;
  sparkData?: SparkPoint[];
}

interface LtvResult  { ltv:  number | null; reason?: string; }
interface CacResult  { cac:  number | null; reason?: string; }

function fmtCurrency(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function LtvCacRatioCard({ from, to, closedWon, sparkData }: Props) {
  const [ltv,     setLtv]     = useState<number | null>(null);
  const [cac,     setCac]     = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!closedWon || closedWon <= 0) {
      setLtv(null);
      setCac(null);
      setError("No closed won customers in this period");
      return;
    }

    setLoading(true);
    setLtv(null);
    setCac(null);
    setError(null);

    Promise.all([
      fetch(`/api/ltv?from=${from}&to=${to}`)
        .then((r) => r.json() as Promise<LtvResult>),
      fetch(`/api/cac?from=${from}&to=${to}&closedWon=${closedWon}`)
        .then((r) => r.json() as Promise<CacResult>),
    ])
      .then(([ltvData, cacData]) => {
        if (ltvData.ltv == null) { setError(ltvData.reason ?? "LTV unavailable"); return; }
        if (cacData.cac == null) { setError(cacData.reason ?? "CAC unavailable"); return; }
        setLtv(ltvData.ltv);
        setCac(cacData.cac);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to, closedWon]);

  const ratio    = ltv != null && cac != null && cac > 0 ? ltv / cac : null;
  const isStrong = ratio != null && ratio >= 5;
  const isGood   = ratio != null && ratio >= 3;
  const isWeak   = ratio != null && ratio < 1;

  const color = isStrong ? "text-emerald-600"
              : isGood   ? "text-indigo-700"
              : isWeak   ? "text-red-500"
              : ratio != null ? "text-amber-600"
              : "text-slate-300";

  const badge = isStrong ? "Strong"
              : isGood   ? "Healthy"
              : isWeak   ? "Below 1×"
              : ratio != null ? "Developing"
              : null;

  const badgeColor = isStrong ? "text-emerald-500"
                   : isGood   ? "text-indigo-400"
                   : isWeak   ? "text-red-400"
                   : "text-amber-500";

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Ratio className="w-3.5 h-3.5 text-indigo-500" />
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">LTV : CAC</span>
        </div>
        <div className="group relative">
          <Info className="w-3.5 h-3.5 text-slate-300 cursor-help" />
          <div className="absolute right-0 top-5 z-20 hidden group-hover:block w-64 bg-slate-900 text-white text-[11px] rounded-lg p-3 leading-relaxed shadow-xl">
            <p className="font-semibold mb-1">LTV : CAC Ratio</p>
            <p className="text-slate-300">LTV ÷ CAC — how much lifetime value you generate per $1 spent acquiring a customer.</p>
            <div className="mt-2 pt-2 border-t border-slate-700 space-y-0.5 text-slate-400">
              <p className="text-emerald-400">5×+ &nbsp;Strong</p>
              <p className="text-indigo-400">3–5× &nbsp;Healthy</p>
              <p className="text-amber-400">1–3× &nbsp;Developing</p>
              <p className="text-red-400">&lt;1× &nbsp;&nbsp;Below break-even</p>
            </div>
            {ltv != null && cac != null && (
              <div className="mt-2 pt-2 border-t border-slate-700 space-y-0.5 text-slate-400">
                <p>LTV: {fmtCurrency(ltv)}</p>
                <p>CAC: {fmtCurrency(cac)}</p>
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
        ) : ratio != null ? (
          <>
            <span className={`text-3xl font-bold tabular-nums leading-none ${color}`}>
              {ratio.toFixed(1)}x
            </span>
            {badge && (
              <span className={`text-xs font-medium mb-0.5 ${badgeColor}`}>{badge}</span>
            )}
          </>
        ) : (
          <span className="text-2xl font-bold text-slate-300">—</span>
        )}
      </div>

      {/* Sub-label */}
      <p className="text-[11px] text-slate-400 leading-tight">
        {ratio != null
          ? `${fmtCurrency(ltv!)} LTV vs ${fmtCurrency(cac!)} CAC`
          : error
            ? <span className="text-amber-500">{error}</span>
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
