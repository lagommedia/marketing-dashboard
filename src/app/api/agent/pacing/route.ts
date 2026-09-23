/**
 * GET /api/agent/pacing?period=2026-Q3
 *
 * Quarterly targets vs actuals by channel, plus the org assumptions the CAC,
 * LTV and GTM-efficiency cards depend on. Defaults to the current quarter.
 *
 * Pacing is expressed against the fraction of the quarter elapsed, which is
 * the same basis the dashboard's CAC and GTM efficiency cards use.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkAgentAuth, ratio } from "@/lib/agent-auth";

export const dynamic = "force-dynamic";

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

function quarterBounds(period: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(period);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const q = parseInt(m[2], 10) - 1;
  return {
    start: new Date(Date.UTC(year, q * 3, 1)),
    end: new Date(Date.UTC(year, q * 3 + 3, 0, 23, 59, 59, 999)),
  };
}

export async function GET(req: NextRequest) {
  const denied = checkAgentAuth(req);
  if (denied) return denied;

  const period = req.nextUrl.searchParams.get("period") ?? currentPeriod();
  const bounds = quarterBounds(period);
  if (!bounds) {
    return NextResponse.json({ error: "period must look like 2026-Q3" }, { status: 400 });
  }

  const asOf = new Date(Math.min(Date.now(), bounds.end.getTime()));
  const totalMs = bounds.end.getTime() - bounds.start.getTime();
  const pctElapsed = Math.min(Math.max((asOf.getTime() - bounds.start.getTime()) / totalMs, 0), 1);

  const [targets, rows] = await Promise.all([
    prisma.pacingTarget.findMany({ where: { period } }),
    prisma.metricSnapshot.findMany({ where: { date: { gte: bounds.start, lte: asOf } } }),
  ]);

  const org = targets.find((t) => t.channel === "marketing_org") ?? null;

  const actualsFor = (channel: string) => {
    const rs = rows.filter((r) => r.channel === channel);
    return {
      mqls: rs.reduce((s, r) => s + (r.mqls ?? 0), 0),
      sqos: rs.reduce((s, r) => s + (r.sqos ?? 0), 0),
      pipeline: rs.reduce((s, r) => s + (r.pipeline ?? 0), 0),
      closedWon: rs.reduce((s, r) => s + (r.closedWon ?? 0), 0),
      revenue: rs.reduce((s, r) => s + (r.revenue ?? 0), 0),
      spend: rs.reduce((s, r) => s + (r.spend ?? 0), 0),
    };
  };

  const pacing = targets
    .filter((t) => t.channel !== "marketing_org")
    .map((t) => {
      const a = actualsFor(t.channel);
      const vs = (actual: number, target: number | null) =>
        target != null && target > 0
          ? { actual, target, attainment: actual / target, paceIndex: ratio(actual / target, pctElapsed) }
          : { actual, target, attainment: null, paceIndex: null };
      return {
        channel: t.channel,
        mqls: vs(a.mqls, t.targetMqls),
        sqos: vs(a.sqos, t.targetSqos),
        pipeline: vs(a.pipeline, t.targetPipeline),
        closedWon: vs(a.closedWon, t.targetClosedWon),
        revenue: vs(a.revenue, t.targetRevenue),
        spend: vs(a.spend, t.targetSpend),
      };
    });

  const allActuals = actualsFor("all");
  const grossExpenses = org?.targetSpend ?? null;
  const expensesToDate = grossExpenses != null ? grossExpenses * pctElapsed : null;

  return NextResponse.json({
    ok: true,
    period,
    quarter: { start: bounds.start.toISOString().slice(0, 10), end: bounds.end.toISOString().slice(0, 10) },
    pctElapsed,
    pacing,
    orgAssumptions: org
      ? {
          grossExpensesQuarter: org.targetSpend,
          sharedAllocation: org.sharedAllocation,
          arpu: org.arpu,
          grossMargin: org.grossMargin,
          arrChurnPct: org.arrChurnPct,
          arrChurnAmt: org.arrChurnAmt,
        }
      : null,
    derived: {
      expensesToDate,
      closedWon: allActuals.closedWon,
      revenue: allActuals.revenue,
      cac: ratio(expensesToDate, allActuals.closedWon),
      gtmEfficiency: ratio(allActuals.revenue, expensesToDate),
    },
    notes: [
      "paceIndex = attainment ÷ fraction of quarter elapsed. 1.0 is exactly on pace; below 1.0 is behind.",
      "cac and gtmEfficiency use Gross Expenses × fraction of quarter elapsed, matching the dashboard cards. Both are null when no marketing_org target exists for the period.",
    ],
  });
}
