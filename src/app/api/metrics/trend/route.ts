import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MetricKey =
  | "revenue" | "pipeline" | "spend"
  | "impressions" | "clicks" | "leads" | "mqls" | "sqos" | "closedWon"
  | "cpc" | "cpl" | "cpMql" | "cpSqo" | "paidCac" | "mktgCac";

const DERIVED: Record<string, { num: string; den: string }> = {
  cpc:     { num: "spend", den: "clicks"    },
  cpl:     { num: "spend", den: "leads"     },
  cpMql:   { num: "spend", den: "mqls"      },
  cpSqo:   { num: "spend", den: "sqos"      },
  paidCac: { num: "spend", den: "closedWon" },
  mktgCac: { num: "spend", den: "closedWon" },
};

// ---------------------------------------------------------------------------
// Period generation
// ---------------------------------------------------------------------------

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function isQuarterStart(d: Date): boolean {
  return d.getDate() === 1 && [0, 3, 6, 9].includes(d.getMonth());
}

function fixedPeriodLabel(from: Date, to: Date, days: number): string {
  if (days === 1) {
    return from.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  if (days >= 28 && days <= 32) {
    return from.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
  const f = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(from)} – ${f(to)}`;
}

interface Period {
  label:     string;
  from:      Date;
  to:        Date;
  /** Actual end of the full period (= quarter end for the current quarter, even when to=today) */
  periodEnd: Date;
  isCurrent: boolean;   // true = the originally selected range
}

function generatePeriods(from: Date, to: Date): Period[] {
  // Quarterly mode: selected range starts on a quarter boundary
  if (isQuarterStart(from)) {
    const curYear = to.getFullYear();
    const curQ    = Math.floor(to.getMonth() / 3);

    return Array.from({ length: 12 }, (_, i) => {
      // i=0 → oldest, i=11 → most recent
      let q  = curQ - (11 - i);
      let yr = curYear;
      while (q < 0) { q += 4; yr--; }

      const qStart = new Date(yr, q * 3, 1);
      const qEnd   = new Date(yr, q * 3 + 3, 0);
      const isLast = i === 11;

      return {
        label:     `Q${q + 1} ${yr}`,
        from:      isLast ? from : qStart,   // respect partial current quarter
        to:        isLast ? to   : qEnd,
        periodEnd: qEnd,                     // always the true quarter end
        isCurrent: isLast,
      };
    });
  }

  // Fixed-duration mode: each period is exactly the same number of days
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;

  return Array.from({ length: 12 }, (_, i) => {
    const offset = (11 - i) * days;
    const pFrom  = addDays(from, -offset);
    const pTo    = addDays(to,   -offset);
    return {
      label:     fixedPeriodLabel(pFrom, pTo, days),
      from:      pFrom,
      to:        pTo,
      periodEnd: pTo,
      isCurrent: i === 11,
    };
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

const SUM_FIELDS = {
  revenue:     true,
  pipeline:    true,
  spend:       true,
  impressions: true,
  clicks:      true,
  leads:       true,
  mqls:        true,
  sqos:        true,
  closedWon:   true,
} as const;

async function aggregatePeriod(period: Period, channel: string) {
  const agg = await prisma.metricSnapshot.aggregate({
    where: { date: { gte: period.from, lte: period.to }, channel },
    _sum: SUM_FIELDS,
  });
  return agg._sum;
}

function extractValue(s: Awaited<ReturnType<typeof aggregatePeriod>>, metric: MetricKey): number | null {
  if (metric in DERIVED) {
    const { num, den } = DERIVED[metric];
    const n = s[num as keyof typeof s] as number | null;
    const d = s[den as keyof typeof s] as number | null;
    return n != null && d != null && d > 0 ? n / d : null;
  }
  return (s[metric as keyof typeof s] as number | null) ?? null;
}

export async function GET(req: NextRequest) {
  const sp        = req.nextUrl.searchParams;
  const metric    = sp.get("metric") as MetricKey | null;
  const fromStr   = sp.get("from");
  const toStr     = sp.get("to");
  const channel   = sp.get("channel") ?? "all";
  const breakdown = sp.get("breakdown") === "true";

  if (!metric || !fromStr || !toStr) {
    return NextResponse.json({ error: "metric, from, and to are required" }, { status: 400 });
  }

  const from = new Date(fromStr + "T00:00:00");
  const to   = new Date(toStr   + "T00:00:00");

  const periods = generatePeriods(from, to);

  if (breakdown) {
    // Return per-channel breakdown (paid_media, organic, referral) for each period
    const results = await Promise.all(
      periods.map(async (period) => {
        const [paid, organic, referral] = await Promise.all([
          aggregatePeriod(period, "paid_media"),
          aggregatePeriod(period, "organic"),
          aggregatePeriod(period, "referral"),
        ]);
        return {
          label:      period.label,
          from:       period.from.toISOString().slice(0, 10),
          to:         period.to.toISOString().slice(0, 10),
          periodEnd:  period.periodEnd.toISOString().slice(0, 10),
          isCurrent:  period.isCurrent,
          paid_media: extractValue(paid, metric) ?? 0,
          organic:    extractValue(organic, metric) ?? 0,
          referral:   extractValue(referral, metric) ?? 0,
        };
      })
    );
    return NextResponse.json({ periods: results, breakdown: true });
  }

  const results = await Promise.all(
    periods.map(async (period) => {
      const s = await aggregatePeriod(period, channel);
      return {
        label:     period.label,
        from:      period.from.toISOString().slice(0, 10),
        to:        period.to.toISOString().slice(0, 10),
        periodEnd: period.periodEnd.toISOString().slice(0, 10),
        value:     extractValue(s, metric),
        isCurrent: period.isCurrent,
      };
    })
  );

  return NextResponse.json({ periods: results });
}
