import { prisma } from "@/lib/db";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { AlertCircle, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { PacingTargetForm } from "@/components/dashboard/PacingTargetForm";
import type { Channel } from "@/types";

export const dynamic = "force-dynamic";

const CHANNELS: { value: Channel; label: string; color: string }[] = [
  { value: "paid_media", label: "Paid Media",  color: "violet"  },
  { value: "organic",    label: "Organic",     color: "emerald" },
  { value: "referral",   label: "Referral",    color: "amber"   },
];

// ---------------------------------------------------------------------------
// Quarter helpers
// ---------------------------------------------------------------------------

function getCurrentQuarter() {
  const now   = new Date();
  const year  = now.getFullYear();
  const q     = Math.floor(now.getMonth() / 3); // 0-indexed
  const start = new Date(year, q * 3, 1);
  const end   = new Date(year, q * 3 + 3, 0);   // last day of quarter
  const totalMs   = end.getTime() + 86_400_000 - start.getTime();
  const elapsedMs = Math.min(now.getTime() - start.getTime(), totalMs);
  return {
    start,
    end,
    elapsed:  elapsedMs / totalMs,
    period:   `${year}-Q${q + 1}`,
    label:    `Q${q + 1} ${year}`,
    shortLabel: `Q${q + 1}`,
    pct:      Math.round((elapsedMs / totalMs) * 100),
  };
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function getPacingData(channel: Channel) {
  const { start, period } = getCurrentQuarter();
  const toEnd = new Date();
  toEnd.setHours(23, 59, 59, 999);

  const [target, actuals] = await Promise.all([
    prisma.pacingTarget.findUnique({ where: { period_channel: { period, channel } } }),
    prisma.metricSnapshot.aggregate({
      where: {
        channel,
        date: { gte: start, lte: toEnd },
      },
      _sum: {
        mqls:      true,
        sqos:      true,
        pipeline:  true,
        closedWon: true,
        revenue:   true,
        spend:     true,
      },
    }),
  ]);

  return { target, actuals: actuals._sum, period };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function PacingPage() {
  const { elapsed, label, shortLabel, pct } = getCurrentQuarter();
  const pacingResults = await Promise.all(CHANNELS.map((c) => getPacingData(c.value)));
  const hasAnyTargets = pacingResults.some((r) => r.target != null);

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Pacing</h1>
        <p className="text-sm text-slate-500 mt-1">
          Quarter-to-date actuals vs. {label} targets ·{" "}
          <span className="font-medium text-slate-700">{pct}% through {shortLabel}</span>
        </p>
      </div>

      {!hasAnyTargets && (
        <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>
            No {label} targets set yet. Click <strong>Set targets</strong> on any channel below
            to configure quarterly goals and start tracking pacing.
          </span>
        </div>
      )}

      <div className="space-y-6">
        {CHANNELS.map((channel, i) => {
          const { target, actuals, period } = pacingResults[i];
          return (
            <ChannelPacingCard
              key={channel.value}
              channel={channel}
              target={target}
              actuals={actuals}
              elapsed={elapsed}
              period={period}
              quarterLabel={shortLabel}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel card
// ---------------------------------------------------------------------------

interface PacingRow {
  label:  string;
  actual: number | null;
  target: number | null;
  format: "number" | "currency";
}

function ChannelPacingCard({
  channel,
  target,
  actuals,
  elapsed,
  period,
  quarterLabel,
}: {
  channel:      { value: Channel; label: string; color: string };
  target:       { targetMqls?: number | null; targetSqos?: number | null; targetPipeline?: number | null; targetClosedWon?: number | null; targetRevenue?: number | null; targetSpend?: number | null } | null;
  actuals:      { mqls?: number | null; sqos?: number | null; pipeline?: number | null; closedWon?: number | null; revenue?: number | null; spend?: number | null };
  elapsed:      number;
  period:       string;
  quarterLabel: string;
}) {
  const rows: PacingRow[] = [
    { label: "MQLs",               actual: actuals.mqls      ?? null, target: target?.targetMqls      ?? null, format: "number"   },
    { label: "SQOs",               actual: actuals.sqos      ?? null, target: target?.targetSqos      ?? null, format: "number"   },
    { label: "Pipeline Generated", actual: actuals.pipeline  ?? null, target: target?.targetPipeline  ?? null, format: "currency" },
    { label: "Closed Won",         actual: actuals.closedWon ?? null, target: target?.targetClosedWon ?? null, format: "number"   },
    { label: "Revenue",            actual: actuals.revenue   ?? null, target: target?.targetRevenue   ?? null, format: "currency" },
    { label: "Spend",              actual: actuals.spend     ?? null, target: target?.targetSpend     ?? null, format: "currency" },
  ];

  const colorMap: Record<string, string> = {
    violet:  "bg-violet-50 border-violet-200",
    emerald: "bg-emerald-50 border-emerald-200",
    amber:   "bg-amber-50 border-amber-200",
  };
  const headerColorMap: Record<string, string> = {
    violet:  "text-violet-700 bg-violet-100",
    emerald: "text-emerald-700 bg-emerald-100",
    amber:   "text-amber-700 bg-amber-100",
  };

  return (
    <div className={cn("rounded-xl border p-5", colorMap[channel.color])}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <span className={cn("text-xs font-semibold px-2.5 py-1 rounded-full", headerColorMap[channel.color])}>
          {channel.label}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">
            {Math.round(elapsed * 100)}% through {quarterLabel}
          </span>
          <PacingTargetForm channel={channel.value} period={period} existing={target} />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {rows.map((row) => (
          <PacingMetric key={row.label} {...row} elapsed={elapsed} quarterLabel={quarterLabel} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual metric tile
// ---------------------------------------------------------------------------

function PacingMetric({
  label,
  actual,
  target,
  format,
  elapsed,
  quarterLabel,
}: PacingRow & { elapsed: number; quarterLabel: string }) {
  const fmt = (v: number | null) =>
    v == null ? "—" : format === "currency" ? formatCurrency(v) : formatNumber(v, true);

  // Where we should be right now given elapsed time
  const expectedQtd = target != null && elapsed > 0 ? target * elapsed : null;

  const pacing =
    actual != null && target != null && target > 0 && elapsed > 0
      ? actual / (target * elapsed)
      : null;

  const status =
    pacing == null ? null : pacing >= 1.05 ? "ahead" : pacing < 0.85 ? "behind" : "on-track";

  const statusConfig = {
    ahead:      { icon: TrendingUp,   color: "text-emerald-600", label: "Ahead"    },
    "on-track": { icon: Minus,        color: "text-blue-500",    label: "On pace"  },
    behind:     { icon: TrendingDown, color: "text-red-500",     label: "Behind"   },
  };

  const cfg = status ? statusConfig[status] : null;

  const progress =
    actual != null && target != null && target > 0
      ? Math.min((actual / target) * 100, 100)
      : 0;

  // Expected-pace marker position on the bar (capped at 100%)
  const expectedPct = expectedQtd != null && target != null && target > 0
    ? Math.min((expectedQtd / target) * 100, 100)
    : null;

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-3">
      <p className="text-xs font-medium text-slate-500 truncate">{label}</p>
      <p className="text-lg font-bold text-slate-900 mt-1">{fmt(actual)}</p>

      {target != null ? (
        <>
          {/* Progress bar with expected-pace marker */}
          <div className="relative w-full h-1.5 bg-slate-100 rounded-full mt-2">
            <div
              className={cn(
                "h-1.5 rounded-full transition-all",
                status === "ahead" ? "bg-emerald-500" : status === "behind" ? "bg-red-400" : "bg-blue-500"
              )}
              style={{ width: `${progress}%` }}
            />
            {/* Expected-pace tick mark */}
            {expectedPct != null && (
              <div
                className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-slate-400 rounded-full"
                style={{ left: `${expectedPct}%` }}
                title={`${quarterLabel} expected pace: ${fmt(expectedQtd)}`}
              />
            )}
          </div>

          <div className="flex items-center justify-between mt-1.5 gap-1">
            <div className="min-w-0">
              <p className="text-[11px] text-slate-400 truncate">
                {quarterLabel} target: {fmt(target)}
              </p>
              {expectedQtd != null && (
                <p className="text-[11px] text-slate-400 truncate">
                  Expected now: {fmt(expectedQtd)}
                </p>
              )}
            </div>
            {cfg && (
              <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium shrink-0", cfg.color)}>
                <cfg.icon className="w-3 h-3" />
                {cfg.label}
              </span>
            )}
          </div>
        </>
      ) : (
        <p className="text-[11px] text-slate-300 mt-2">No target set</p>
      )}
    </div>
  );
}
