import { NextRequest, NextResponse } from "next/server";
import { getMetricBySource, MetricSourceKey } from "@/lib/integrations/hubspot";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Period generation (mirrors /api/metrics/trend)
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
  if (days === 1) return from.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (days >= 28 && days <= 32) return from.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  const f = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(from)} – ${f(to)}`;
}

interface Period {
  label:     string;
  from:      Date;
  to:        Date;
  periodEnd: Date;
  isCurrent: boolean;
}

function generatePeriods(from: Date, to: Date): Period[] {
  if (isQuarterStart(from)) {
    const curYear = to.getFullYear();
    const curQ    = Math.floor(to.getMonth() / 3);
    return Array.from({ length: 12 }, (_, i) => {
      let q  = curQ - (11 - i);
      let yr = curYear;
      while (q < 0) { q += 4; yr--; }
      const qStart = new Date(yr, q * 3, 1);
      const qEnd   = new Date(yr, q * 3 + 3, 0);
      const isLast = i === 11;
      return { label: `Q${q + 1} ${yr}`, from: isLast ? from : qStart, to: isLast ? to : qEnd, periodEnd: qEnd, isCurrent: isLast };
    });
  }
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  return Array.from({ length: 12 }, (_, i) => {
    const offset = (11 - i) * days;
    const pFrom  = addDays(from, -offset);
    const pTo    = addDays(to,   -offset);
    return { label: fixedPeriodLabel(pFrom, pTo, days), from: pFrom, to: pTo, periodEnd: pTo, isCurrent: i === 11 };
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fromStr  = searchParams.get("from");
  const toStr    = searchParams.get("to");
  const metricParam = (searchParams.get("metric") ?? "revenue") as MetricSourceKey;

  if (!fromStr || !toStr) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  const from    = new Date(fromStr + "T00:00:00");
  const to      = new Date(toStr   + "T00:00:00");
  const periods = generatePeriods(from, to);

  // Run in batches of 3 with a pause between batches to stay well under
  // HubSpot's 100 req/10s limit even when background syncs are in flight.
  async function runBatched<T>(
    items: T[],
    fn: (item: T) => Promise<unknown>,
    batchSize: number,
    pauseMs: number
  ) {
    const out: Awaited<ReturnType<typeof fn>>[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(fn));
      out.push(...results);
      if (i + batchSize < items.length) await new Promise((r) => setTimeout(r, pauseMs));
    }
    return out;
  }

  try {
    const results = await runBatched(
      periods,
      async (period) => {
        const pFrom = period.from.toISOString().slice(0, 10);
        const pTo   = period.to.toISOString().slice(0, 10);
        const src   = await getMetricBySource(metricParam, pFrom, pTo);
        return {
          label:       period.label,
          from:        pFrom,
          to:          pTo,
          periodEnd:   period.periodEnd.toISOString().slice(0, 10),
          isCurrent:   period.isCurrent,
          paid_search: src.paid_search,
          paid_social: src.paid_social,
          total:       src.total,
        };
      },
      3,   // 3 periods per batch
      600  // 600ms pause between batches → 4 batches × 600ms = ~2.4s worst-case overhead
    ) as {
      label: string; from: string; to: string; periodEnd: string;
      isCurrent: boolean; paid_search: number; paid_social: number; total: number;
    }[];

    return NextResponse.json({ periods: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
