import { Suspense } from "react";
import { prisma } from "@/lib/db";
import { DateRangePicker } from "@/components/dashboard/DateRangePicker";
import { FunnelClient } from "./FunnelClient";
import { getCachedSheetMonths, normMonth } from "@/lib/sheets-cache";

const SHORT_MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"] as const;

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function quarterStartIso(): string {
  const now = new Date();
  const q   = Math.floor(now.getMonth() / 3);
  return new Date(now.getFullYear(), q * 3, 1).toISOString().slice(0, 10);
}

async function getEstimatedSpend(from: Date, to: Date): Promise<number | null> {
  const q    = Math.floor(from.getMonth() / 3);
  const year = from.getFullYear();

  const qStart  = new Date(year, q * 3,     1);
  const qEnd    = new Date(year, q * 3 + 3, 0);
  const totalMs = qEnd.getTime() - qStart.getTime() + 86_400_000;

  const toEndOfDay = new Date(to.getTime() + 86_400_000);
  const asOf       = new Date(Math.min(Date.now(), toEndOfDay.getTime()));
  const pct        = Math.min(Math.max(asOf.getTime() - qStart.getTime(), 0), totalMs) / totalMs;

  const period = `${year}-Q${q + 1}`;
  const pacingTarget = await prisma.pacingTarget.findUnique({
    where:  { period_channel: { period, channel: "marketing_org" } },
    select: { targetSpend: true },
  });
  if (pacingTarget?.targetSpend != null) {
    return pacingTarget.targetSpend * pct;
  }

  const months: string[] = [];
  const cur = new Date(year, q * 3, 1);
  const qLastMonth = new Date(year, q * 3 + 2, 1);
  while (cur <= qLastMonth) {
    months.push(`${SHORT_MONTHS[cur.getMonth()]} ${cur.getFullYear()}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  const cached = await getCachedSheetMonths(months);
  if (!cached) return null;

  let total = 0;
  for (const m of months) {
    const row = cached.get(normMonth(m));
    if (row) total += (row.grossCosts ?? 0) + (row.sharedAllocation ?? 0);
  }
  return total > 0 ? total * pct : null;
}

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function FunnelPage({ searchParams }: PageProps) {
  const sp      = await searchParams;
  const fromStr = sp.from ?? quarterStartIso();
  const toStr   = sp.to   ?? todayIso();
  const fromDate = new Date(fromStr + "T00:00:00");
  const toDate   = new Date(toStr   + "T00:00:00");

  const [estimatedSpend, notifCount] = await Promise.all([
    getEstimatedSpend(fromDate, toDate),
    prisma.funnelChangeNotification.count({ where: { dismissed: false } }),
  ]);

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Marketing Funnel</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Contacts created {fromStr} – {toStr}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Suspense>
            <DateRangePicker from={fromStr} to={toStr} />
          </Suspense>
        </div>
      </div>

      {/* Main client component — fetches funnel counts client-side so date changes are instant */}
      <FunnelClient
        from={fromStr}
        to={toStr}
        estimatedSpend={estimatedSpend}
        initialNotifCount={notifCount}
      />
    </div>
  );
}
