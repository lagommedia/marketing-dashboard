import { NextRequest, NextResponse } from "next/server";
import { fetchSheetRange } from "@/lib/integrations/google-sheets";
import { getCachedSheetMonths, normMonth } from "@/lib/sheets-cache";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers — mirrors gtm-efficiency/route.ts exactly
// ---------------------------------------------------------------------------

const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

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

const _SHORT_CAC = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * Returns the last calendar day of the last month in `months` that has non-zero
 * cost data in the cache.  Falls back to today when nothing is found.
 */
/**
 * Returns the FIRST DAY OF THE NEXT MONTH after the last month in `months`
 * that has non-zero cost data.  Using "start of next month" means:
 *   - For a completed past quarter, asOf > qEnd → pctElapsed = 1.0 (100%) ✓
 *   - For the current quarter, min(today, firstOfNextMonth) = today when data
 *     is available up to the current month, preventing future-month drift ✓
 * Falls back to today if no month has data.
 */
function lastCachedDate(months: string[], cached: Map<string, { grossCosts: number; sharedAllocation: number }>): Date {
  for (let i = months.length - 1; i >= 0; i--) {
    const row = cached.get(normMonth(months[i]));
    if (row && (row.grossCosts > 0 || row.sharedAllocation > 0)) {
      const [mon, yr] = months[i].split(" ");
      const mIdx = _SHORT_CAC.indexOf(mon);
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

/**
 * GET /api/cac?from=YYYY-MM-DD&to=YYYY-MM-DD&closedWon=N
 *
 * Returns:
 *   { cac, grossCosts, sharedAllocation, pctElapsed, denominator }
 * or
 *   { cac: null, reason: "..." }
 */
export async function GET(req: NextRequest) {
  try {
    const sp          = req.nextUrl.searchParams;
    const fromStr     = sp.get("from");
    const toStr       = sp.get("to");
    const closedWon   = parseFloat(sp.get("closedWon") ?? "0");

    if (!fromStr || !toStr) {
      return NextResponse.json({ cac: null, reason: "from and to are required" });
    }
    if (!closedWon || closedWon <= 0) {
      return NextResponse.json({ cac: null, reason: "No closed won customers in this period" });
    }

    const from = new Date(fromStr + "T00:00:00");

    // Always use the full quarter so crossing a month boundary mid-quarter doesn't
    // cause a step-jump in costs. pctElapsed handles the elapsed-time portion.
    const q = Math.floor(from.getMonth() / 3);
    const qEnd = new Date(from.getFullYear(), q * 3 + 2, 1); // first of last quarter month
    const months = monthsInRange(from, qEnd);
    if (months.length === 0) {
      return NextResponse.json({ cac: null, reason: "No months in selected range" });
    }

    // -- Try DB cache first (populated by Google Sheets sync) -----------------
    let grossCosts = 0, sharedAllocation = 0;
    const cached = await getCachedSheetMonths(months);

    if (cached) {
      for (const m of months) {
        const row = cached.get(normMonth(m));
        if (row) { grossCosts += row.grossCosts; sharedAllocation += row.sharedAllocation; }
      }
    } else {
      // -- Fallback: live Sheets read (before first sync) ----------------------
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
        return NextResponse.json({ cac: null, reason: err instanceof Error ? err.message : "Sheet unavailable" });
      }
      const GROSS_LABEL = "Marketing Gross Costs";
      let grossRowIdx: number | null = null;
      for (let i = 0; i < labelCol.length; i++) {
        if ((labelCol[i][0] ?? "").trim() === GROSS_LABEL) { grossRowIdx = i; break; }
      }
      if (grossRowIdx === null) {
        return NextResponse.json({ cac: null, reason: `"${GROSS_LABEL}" not found — run a Google Sheets sync first` });
      }
      const [r1, r2] = await Promise.all([
        fetchSheetRange(`${SHEET}!${grossRowIdx + 1}:${grossRowIdx + 1}`),
        fetchSheetRange(`${SHEET}!${grossRowIdx + 2}:${grossRowIdx + 2}`),
      ]);
      const normHdr = headerRow.map(normalise);
      const target  = new Set(months.map(normalise));
      const grossRow = r1[0] ?? [], sharedRow = r2[0] ?? [];
      for (const [i, h] of normHdr.entries()) {
        if (target.has(h)) {
          grossCosts       += parseNum(grossRow[i]);
          sharedAllocation += parseNum(sharedRow[i]);
        }
      }
    }

    const lastData    = cached ? lastCachedDate(months, cached) : new Date();
    const asOf        = new Date(Math.min(new Date().getTime(), lastData.getTime()));
    const pct         = pctElapsed(from, asOf);
    const denominator = (grossCosts + sharedAllocation) * pct;

    if (denominator <= 0) {
      return NextResponse.json({ cac: null, reason: "Cost denominator is zero — check Reference Sheet values" });
    }

    const cac = denominator / closedWon;

    return NextResponse.json({ cac, grossCosts, sharedAllocation, pctElapsed: pct, denominator, closedWon });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ cac: null, reason: msg });
  }
}
