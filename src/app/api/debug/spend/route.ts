import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function normMonth(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}

export async function GET() {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3);

  // Replicate DEFAULT_FROM logic
  const fromIso = new Date(now.getFullYear(), q * 3, 1).toISOString().slice(0, 10);
  const from = new Date(fromIso + "T00:00:00");
  const qFromCalc = Math.floor(from.getMonth() / 3);

  const qLastMonth = new Date(from.getFullYear(), qFromCalc * 3 + 2, 1);
  const months: string[] = [];
  const cur = new Date(from.getFullYear(), qFromCalc * 3, 1);
  while (cur <= qLastMonth) {
    months.push(`${SHORT[cur.getMonth()]} ${cur.getFullYear()}`);
    cur.setMonth(cur.getMonth() + 1);
  }

  const normKeys = months.map(normMonth);
  const rows = await prisma.referenceSheetMonth.findMany({
    where: { month: { in: normKeys } },
  });

  let grossCosts = 0, sharedAllocation = 0;
  let lastDataMonth: string | null = null;
  const perMonth: Record<string, { grossCosts: number; sharedAllocation: number; normKey: string; found: boolean }> = {};

  for (const m of months) {
    const key = normMonth(m);
    const row = rows.find(r => r.month === key);
    perMonth[m] = { grossCosts: row?.grossCosts ?? 0, sharedAllocation: row?.sharedAllocation ?? 0, normKey: key, found: !!row };
    if (row) {
      grossCosts += row.grossCosts;
      sharedAllocation += row.sharedAllocation;
      if (row.grossCosts > 0 || row.sharedAllocation > 0) lastDataMonth = m;
    }
  }

  let lastDataDate = new Date();
  if (lastDataMonth) {
    const [mon, yr] = lastDataMonth.split(" ");
    const mIdx = SHORT.indexOf(mon);
    lastDataDate = new Date(Number(yr), mIdx + 1, 1);
  }
  const asOf = new Date(Math.min(now.getTime(), lastDataDate.getTime()));

  const qStart = new Date(from.getFullYear(), qFromCalc * 3, 1);
  const qEnd   = new Date(from.getFullYear(), qFromCalc * 3 + 3, 0);
  const totalMs = qEnd.getTime() - qStart.getTime() + 86_400_000;
  const pct = Math.min(Math.max(asOf.getTime() - qStart.getTime(), 0), totalMs) / totalMs;

  const result = (grossCosts + sharedAllocation) * pct;

  return NextResponse.json({
    now:           now.toISOString(),
    timezone:      Intl.DateTimeFormat().resolvedOptions().timeZone,
    fromIso,
    fromDate:      from.toISOString(),
    fromMonth:     from.getMonth(),
    q:             qFromCalc,
    months,
    normKeys,
    dbRowsFound:   rows.length,
    perMonth,
    grossCosts,
    sharedAllocation,
    total:         grossCosts + sharedAllocation,
    lastDataMonth,
    lastDataDate:  lastDataDate.toISOString(),
    asOf:          asOf.toISOString(),
    qStart:        qStart.toISOString(),
    qEnd:          qEnd.toISOString(),
    totalDays:     totalMs / 86_400_000,
    elapsedDays:   (asOf.getTime() - qStart.getTime()) / 86_400_000,
    pct,
    result,
  });
}
