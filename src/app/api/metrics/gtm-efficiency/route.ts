import { NextRequest, NextResponse } from "next/server";
import { fetchSheetRange } from "@/lib/integrations/google-sheets";
import { getCachedSheetMonths, normMonth } from "@/lib/sheets-cache";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** Returns labels like ["Apr 2026", "May 2026", "Jun 2026"] for the range. */
function monthsInRange(from: Date, to: Date): string[] {
  const months: string[] = [];
  const cur = new Date(from.getFullYear(), from.getMonth(), 1);
  const end = new Date(to.getFullYear(),   to.getMonth(),   1);
  while (cur <= end) {
    months.push(`${SHORT_MONTHS[cur.getMonth()]} ${cur.getFullYear()}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  return months;
}

/** Normalise a cell for comparison: lowercase, strip punctuation/whitespace. */
function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}


/**
 * Fraction of the quarter (derived from `from`) that has elapsed as of `asOf`
 * (defaults to today).  Pass the end of the last month with cost data so the
 * denominator doesn't drift when no new Reference Sheet data has been synced.
 */
function pctElapsed(from: Date, asOf?: Date): number {
  const q      = Math.floor(from.getMonth() / 3);
  const qStart = new Date(from.getFullYear(), q * 3,     1);
  const qEnd   = new Date(from.getFullYear(), q * 3 + 3, 0);
  const now    = asOf ?? new Date();
  const totalMs   = qEnd.getTime() - qStart.getTime() + 86_400_000;
  const elapsedMs = Math.min(Math.max(now.getTime() - qStart.getTime(), 0), totalMs);
  return elapsedMs / totalMs;
}

const _SHORT_GTM = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function lastCachedDate(months: string[], cached: Map<string, { grossCosts: number; sharedAllocation: number }>): Date {
  for (let i = months.length - 1; i >= 0; i--) {
    const row = cached.get(normMonth(months[i]));
    if (row && (row.grossCosts > 0 || row.sharedAllocation > 0)) {
      const [mon, yr] = months[i].split(" ");
      const mIdx = _SHORT_GTM.indexOf(mon);
      return new Date(Number(yr), mIdx + 1, 1); // first day of NEXT month
    }
  }
  return new Date();
}

function parseNum(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    return await handler(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gtm-efficiency]", msg);
    return NextResponse.json({ gtmEfficiency: null, reason: msg });
  }
}

async function handler(req: NextRequest) {
  const sp   = req.nextUrl.searchParams;
  const fromStr      = sp.get("from");
  const toStr        = sp.get("to");
  const revenueParam = sp.get("revenue");

  if (!fromStr || !toStr || revenueParam == null) {
    return NextResponse.json({ error: "from, to, and revenue are required" }, { status: 400 });
  }

  const from    = new Date(fromStr + "T00:00:00Z");
  const to      = new Date(toStr   + "T00:00:00Z");
  const revenue = parseFloat(revenueParam);

  if (isNaN(revenue)) {
    return NextResponse.json({ gtmEfficiency: null, reason: "invalid revenue" });
  }

  // Always use the full quarter so crossing a month boundary mid-quarter doesn't
  // cause a step-jump in costs. pctElapsed handles the elapsed-time portion.
  const q = Math.floor(from.getMonth() / 3);
  const qEnd = new Date(from.getFullYear(), q * 3 + 2, 1); // first of last quarter month
  const months = monthsInRange(from, qEnd);
  if (months.length === 0) {
    return NextResponse.json({ gtmEfficiency: null, reason: "No months in selected range" });
  }

  // -- Try DB cache first (populated by Google Sheets sync) -------------------
  let grossCosts = 0, sharedAllocation = 0;
  const cached = await getCachedSheetMonths(months);

  if (cached) {
    for (const m of months) {
      const row = cached.get(normMonth(m));
      if (row) { grossCosts += row.grossCosts; sharedAllocation += row.sharedAllocation; }
    }
  } else {
    // -- Fallback: live Sheets read (before first sync) -----------------------
    const SHEET = "'Reference Sheet (DO NOT TOUCH)'";
    let headerRow: string[], labelCol: string[][];
    try {
      const [hRows, lCol] = await Promise.all([
        fetchSheetRange(`${SHEET}!2:2`),
        fetchSheetRange(`${SHEET}!B:B`),
      ]);
      headerRow = hRows[0] ?? [];
      labelCol  = lCol;
    } catch (err) {
      return NextResponse.json({ gtmEfficiency: null, reason: err instanceof Error ? err.message : "Sheet unavailable" });
    }
    const GROSS_LABEL = "Marketing Gross Costs";
    let grossRowIdx: number | null = null;
    for (let i = 0; i < labelCol.length; i++) {
      if ((labelCol[i][0] ?? "").trim() === GROSS_LABEL) { grossRowIdx = i; break; }
    }
    if (grossRowIdx === null) {
      return NextResponse.json({ gtmEfficiency: null, reason: `"${GROSS_LABEL}" not found — run a Google Sheets sync first` });
    }
    const [r1, r2] = await Promise.all([
      fetchSheetRange(`${SHEET}!${grossRowIdx + 1}:${grossRowIdx + 1}`),
      fetchSheetRange(`${SHEET}!${grossRowIdx + 2}:${grossRowIdx + 2}`),
    ]);
    const normHdr = headerRow.map(normalise);
    const target  = new Set(months.map(normalise));
    const grossRow = r1[0] ?? [], sharedRow = r2[0] ?? [];
    for (const [i, h] of normHdr.entries()) {
      if (target.has(h)) { grossCosts += parseNum(grossRow[i]); sharedAllocation += parseNum(sharedRow[i]); }
    }
  }

  const lastData    = cached ? lastCachedDate(months, cached) : new Date();
  const toEndOfDay  = new Date(to.getTime() + 86_400_000); // include full last day
  const asOf        = new Date(Math.min(new Date().getTime(), lastData.getTime(), toEndOfDay.getTime()));
  const pct         = pctElapsed(from, asOf);
  const denominator = (grossCosts + sharedAllocation) * pct;

  if (denominator <= 0) {
    return NextResponse.json({
      gtmEfficiency: null,
      reason: `Denominator is zero. Check that Reference Sheet values are present for the selected months.`,
    });
  }

  const gtmEfficiency = revenue / denominator;

  return NextResponse.json({
    gtmEfficiency,
    revenue,
    grossCosts,
    sharedAllocation,
    denominator,
    pctElapsed: pct,
  });
}
