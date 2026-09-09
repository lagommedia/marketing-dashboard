import { prisma } from "@/lib/db";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { AlertCircle, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { OrgAssumptionsForm } from "@/components/dashboard/OrgAssumptionsForm";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Quarter helpers
// ---------------------------------------------------------------------------

function getCurrentQuarter() {
  const now   = new Date();
  const year  = now.getFullYear();
  const q     = Math.floor(now.getMonth() / 3);
  const start = new Date(year, q * 3, 1);
  const end   = new Date(year, q * 3 + 3, 0);
  const totalMs   = end.getTime() + 86_400_000 - start.getTime();
  const elapsedMs = Math.min(now.getTime() - start.getTime(), totalMs);
  return {
    start,
    end,
    elapsed:    elapsedMs / totalMs,
    period:     `${year}-Q${q + 1}`,
    label:      `Q${q + 1} ${year}`,
    shortLabel: `Q${q + 1}`,
    pct:        Math.round((elapsedMs / totalMs) * 100),
  };
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function getOrgData() {
  const { start, period } = getCurrentQuarter();
  const toEnd = new Date();
  toEnd.setHours(23, 59, 59, 999);

  const [target, actuals, history] = await Promise.all([
    prisma.pacingTarget.findUnique({
      where: { period_channel: { period, channel: "marketing_org" } },
    }),
    prisma.metricSnapshot.aggregate({
      where: { channel: "all", date: { gte: start, lte: toEnd } },
      _sum: { mqls: true, sqos: true, closedWon: true, revenue: true, spend: true, pipeline: true },
    }),
    prisma.pacingTarget.findMany({
      where: { channel: "marketing_org" },
      orderBy: { period: "desc" },
    }),
  ]);

  return { target, actuals: actuals._sum, history, period };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function PacingPage() {
  const { elapsed, label, shortLabel, pct } = getCurrentQuarter();
  const { target, actuals, history, period } = await getOrgData();

  // Computed metrics
  const grossExpenses  = target?.targetSpend ?? null;
  const revenueTarget  = target?.targetRevenue ?? null;
  const arpu           = target?.arpu ?? null;
  const arrChurnPct    = target?.arrChurnPct ?? null;   // e.g. 0.05 = 5%
  const actualRevenue  = actuals.revenue ?? null;
  const closedWon      = actuals.closedWon ?? null;

  // CAC = gross expenses / closed won customers (actual)
  const cac = grossExpenses != null && closedWon != null && closedWon > 0
    ? grossExpenses / closedWon
    : null;

  // LTV = ARPU / monthly churn rate  (annual churn / 12)
  const monthlyChurn = arrChurnPct != null && arrChurnPct > 0 ? arrChurnPct / 12 : null;
  const ltv = arpu != null && monthlyChurn != null && monthlyChurn > 0
    ? arpu / monthlyChurn
    : null;

  // LTV:CAC
  const ltvCac = ltv != null && cac != null && cac > 0 ? ltv / cac : null;

  // GTM Efficiency = actual revenue / gross expenses
  const gtmEfficiency = actualRevenue != null && grossExpenses != null && grossExpenses > 0
    ? actualRevenue / grossExpenses
    : null;

  const hasTarget = target != null;

  // Quarter history: exclude current period from the table
  const pastQuarters = history.filter((h) => h.period !== period);

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Pacing</h1>
        <p className="text-sm text-slate-500 mt-1">
          Marketing org assumptions &amp; quarter-to-date actuals ·{" "}
          <span className="font-medium text-slate-700">{pct}% through {shortLabel}</span>
        </p>
      </div>

      {!hasTarget && (
        <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>
            No {label} assumptions set yet. Click <strong>Set assumptions</strong> below to configure this quarter.
          </span>
        </div>
      )}

      {/* Org assumptions card */}
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
          <div>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-indigo-100 text-indigo-700">
              Marketing Org · {label}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">{pct}% through {shortLabel}</span>
            <OrgAssumptionsForm period={period} existing={target} />
          </div>
        </div>

        {/* Assumption inputs — displayed as read-only tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
          <AssumptionTile label="Revenue Target"     value={revenueTarget}  format="currency" />
          <AssumptionTile label="Gross Expenses"     value={grossExpenses}  format="currency"
            hint="Headcount + Tools + Advertising" />
          <AssumptionTile label="Estimated ARPU"     value={arpu}           format="currency" />
          <AssumptionTile label="ARR Churn %"        value={arrChurnPct != null ? arrChurnPct * 100 : null} format="percent" />
          <AssumptionTile label="ARR Churn $"        value={target?.arrChurnAmt ?? null} format="currency" />
        </div>

        {/* Revenue pacing */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
          <PacingMetric
            label="Revenue (QTD)"
            actual={actualRevenue}
            target={revenueTarget}
            format="currency"
            elapsed={elapsed}
            quarterLabel={shortLabel}
          />
          <PacingMetric
            label="Closed Won Customers"
            actual={closedWon}
            target={target?.targetClosedWon ?? null}
            format="number"
            elapsed={elapsed}
            quarterLabel={shortLabel}
          />
        </div>

        {/* Computed metrics */}
        <div className="border-t border-indigo-200 pt-4">
          <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wide mb-3">Computed Metrics</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <ComputedTile
              label="GTM Efficiency"
              value={gtmEfficiency != null ? `${gtmEfficiency.toFixed(2)}×` : null}
              hint="Revenue ÷ Gross Expenses"
              good={gtmEfficiency != null ? gtmEfficiency >= 1 : null}
            />
            <ComputedTile
              label="CAC"
              value={cac != null ? formatCurrency(cac) : null}
              hint="Gross Expenses ÷ Closed Won"
            />
            <ComputedTile
              label="LTV"
              value={ltv != null ? formatCurrency(ltv) : null}
              hint="ARPU ÷ Monthly Churn Rate"
            />
            <ComputedTile
              label="LTV : CAC"
              value={ltvCac != null ? `${ltvCac.toFixed(1)}×` : null}
              hint="LTV ÷ CAC"
              good={ltvCac != null ? ltvCac >= 3 : null}
            />
          </div>
        </div>
      </div>

      {/* Quarter history */}
      {pastQuarters.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Quarter History</h2>
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  {["Quarter","Revenue Target","Gross Expenses","ARPU","ARR Churn %","ARR Churn $","LTV","CAC","LTV:CAC"].map((h) => (
                    <th key={h} className="text-left text-xs font-medium text-slate-500 px-4 py-2.5 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pastQuarters.map((q) => {
                  const qGross    = q.targetSpend;
                  const qArpu     = q.arpu;
                  const qChurnPct = q.arrChurnPct;
                  const qMonthly  = qChurnPct != null && qChurnPct > 0 ? qChurnPct / 12 : null;
                  const qLtv      = qArpu != null && qMonthly != null ? qArpu / qMonthly : null;
                  // CAC needs actuals — show formula note if no actual available
                  return (
                    <tr key={q.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-800">{q.period}</td>
                      <td className="px-4 py-2.5 text-slate-600">{q.targetRevenue != null ? formatCurrency(q.targetRevenue) : "—"}</td>
                      <td className="px-4 py-2.5 text-slate-600">{qGross != null ? formatCurrency(qGross) : "—"}</td>
                      <td className="px-4 py-2.5 text-slate-600">{qArpu != null ? formatCurrency(qArpu) : "—"}</td>
                      <td className="px-4 py-2.5 text-slate-600">{qChurnPct != null ? `${(qChurnPct * 100).toFixed(1)}%` : "—"}</td>
                      <td className="px-4 py-2.5 text-slate-600">{q.arrChurnAmt != null ? formatCurrency(q.arrChurnAmt) : "—"}</td>
                      <td className="px-4 py-2.5 text-slate-600">{qLtv != null ? formatCurrency(qLtv) : "—"}</td>
                      <td className="px-4 py-2.5 text-slate-500 text-xs italic">based on actuals</td>
                      <td className="px-4 py-2.5 text-slate-500 text-xs italic">based on actuals</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assumption display tile (read-only)
// ---------------------------------------------------------------------------

function AssumptionTile({ label, value, format, hint }: {
  label: string;
  value: number | null;
  format: "currency" | "percent" | "number";
  hint?: string;
}) {
  const display =
    value == null ? "—"
    : format === "currency" ? formatCurrency(value)
    : format === "percent"  ? `${value.toFixed(1)}%`
    : formatNumber(value, true);

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-3">
      <p className="text-xs font-medium text-slate-500 truncate">{label}</p>
      {hint && <p className="text-[10px] text-slate-400 truncate">{hint}</p>}
      <p className="text-base font-bold text-slate-900 mt-1">{display}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pacing metric tile (actual vs target with progress bar)
// ---------------------------------------------------------------------------

interface PacingRow {
  label:  string;
  actual: number | null;
  target: number | null;
  format: "number" | "currency";
  elapsed: number;
  quarterLabel: string;
}

function PacingMetric({ label, actual, target, format, elapsed, quarterLabel }: PacingRow) {
  const fmt = (v: number | null) =>
    v == null ? "—" : format === "currency" ? formatCurrency(v) : formatNumber(v, true);

  const expectedQtd = target != null && elapsed > 0 ? target * elapsed : null;
  const pacing =
    actual != null && target != null && target > 0 && elapsed > 0
      ? actual / (target * elapsed) : null;
  const status =
    pacing == null ? null : pacing >= 1.05 ? "ahead" : pacing < 0.85 ? "behind" : "on-track";

  const statusConfig = {
    ahead:      { icon: TrendingUp,   color: "text-emerald-600", label: "Ahead"   },
    "on-track": { icon: Minus,        color: "text-blue-500",    label: "On pace" },
    behind:     { icon: TrendingDown, color: "text-red-500",     label: "Behind"  },
  };

  const cfg = status ? statusConfig[status] : null;
  const progress = actual != null && target != null && target > 0
    ? Math.min((actual / target) * 100, 100) : 0;
  const expectedPct = expectedQtd != null && target != null && target > 0
    ? Math.min((expectedQtd / target) * 100, 100) : null;

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-3">
      <p className="text-xs font-medium text-slate-500 truncate">{label}</p>
      <p className="text-lg font-bold text-slate-900 mt-1">{fmt(actual)}</p>

      {target != null ? (
        <>
          <div className="relative w-full h-1.5 bg-slate-100 rounded-full mt-2">
            <div
              className={cn("h-1.5 rounded-full transition-all",
                status === "ahead" ? "bg-emerald-500" : status === "behind" ? "bg-red-400" : "bg-blue-500")}
              style={{ width: `${progress}%` }}
            />
            {expectedPct != null && (
              <div
                className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-slate-400 rounded-full"
                style={{ left: `${expectedPct}%` }}
                title={`Expected pace: ${fmt(expectedQtd)}`}
              />
            )}
          </div>
          <div className="flex items-center justify-between mt-1.5 gap-1">
            <div className="min-w-0">
              <p className="text-[11px] text-slate-400 truncate">{quarterLabel} target: {fmt(target)}</p>
              {expectedQtd != null && (
                <p className="text-[11px] text-slate-400 truncate">Expected now: {fmt(expectedQtd)}</p>
              )}
            </div>
            {cfg && (
              <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium shrink-0", cfg.color)}>
                <cfg.icon className="w-3 h-3" />{cfg.label}
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

// ---------------------------------------------------------------------------
// Computed metric tile
// ---------------------------------------------------------------------------

function ComputedTile({ label, value, hint, good }: {
  label: string;
  value: string | null;
  hint?: string;
  good?: boolean | null;
}) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-3">
      <p className="text-xs font-medium text-slate-500 truncate">{label}</p>
      {hint && <p className="text-[10px] text-slate-400 truncate">{hint}</p>}
      <p className={cn("text-base font-bold mt-1",
        good === true ? "text-emerald-600" : good === false ? "text-red-500" : "text-slate-900")}>
        {value ?? "—"}
      </p>
    </div>
  );
}
