import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

export interface MetricPace {
  status:   "ahead" | "on-track" | "behind";
  pct:      number;              // signed % above/below expected pace (e.g. +23, -8)
  quarter:  string;              // e.g. "Q2"
  expected: number;              // expected QTD value (target * elapsed)
  diff:     number;              // actual − expected (signed)
  format:   "number" | "currency";
}

interface Props {
  label:     string;
  value:     string;
  subValue?: string;
  trend?:    number | null;
  highlight?: boolean;
  className?: string;
  pace?:     MetricPace | null;
  onClick?:  () => void;
  footer?:   React.ReactNode;
}

export function MetricCard({ label, value, subValue, trend, highlight, className, pace, onClick, footer }: Props) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "bg-white rounded-xl border border-slate-200 p-5",
        highlight && "border-indigo-200 ring-1 ring-indigo-100",
        onClick && "cursor-pointer hover:border-slate-300 hover:shadow-sm transition-all",
        className
      )}
    >
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide truncate">{label}</p>
      <p className={cn("text-2xl font-bold mt-1", highlight ? "text-indigo-700" : "text-slate-900")}>
        {value}
      </p>

      <div className="flex items-center gap-2 mt-1 min-h-[1.25rem]">
        {subValue && <p className="text-xs text-slate-400">{subValue}</p>}
        {trend != null && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-xs font-medium",
              trend > 0 ? "text-emerald-600" : trend < 0 ? "text-red-500" : "text-slate-400"
            )}
          >
            {trend > 0 ? <TrendingUp className="w-3 h-3" /> : trend < 0 ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
            {Math.abs(trend).toFixed(1)}%
          </span>
        )}
      </div>

      {footer && <div className="mt-3 pt-3 border-t border-slate-100">{footer}</div>}

      {/* QTD pace badge */}
      {pace && (
        <div className="mt-2 pt-2 border-t border-slate-100 space-y-0.5">
          {/* Line 1 — status + % */}
          <div className="flex items-center gap-1">
            {pace.status === "ahead" ? (
              <TrendingUp className="w-3 h-3 text-emerald-500 shrink-0" />
            ) : pace.status === "behind" ? (
              <TrendingDown className="w-3 h-3 text-red-400 shrink-0" />
            ) : (
              <Minus className="w-3 h-3 text-blue-400 shrink-0" />
            )}
            <span className={cn(
              "text-[11px] font-medium",
              pace.status === "ahead"  ? "text-emerald-600" :
              pace.status === "behind" ? "text-red-500"     : "text-blue-500"
            )}>
              {pace.status === "on-track"
                ? `On pace (${pace.quarter})`
                : `${pace.pct >= 0 ? "+" : ""}${Math.round(pace.pct)}% vs ${pace.quarter} pace`}
            </span>
          </div>
          {/* Line 2 — expected value + absolute diff */}
          <p className="text-[11px] text-slate-400 pl-4">
            {`Expected ${pace.format === "currency" ? formatCurrency(Math.round(pace.expected), true) : formatNumber(Math.round(pace.expected), true)}`}
            {pace.diff !== 0 && (
              <span className={cn(
                "ml-1 font-medium",
                pace.diff > 0 ? "text-emerald-500" : "text-red-400"
              )}>
                {pace.diff > 0 ? "↑" : "↓"}
                {pace.format === "currency"
                  ? formatCurrency(Math.round(Math.abs(pace.diff)), true)
                  : formatNumber(Math.round(Math.abs(pace.diff)), true)}
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
