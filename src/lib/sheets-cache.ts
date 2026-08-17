/**
 * Thin read layer for the ReferenceSheetMonth cache.
 *
 * API routes and page-level functions call getCachedSheetMonths() instead
 * of hitting the Google Sheets API directly.  The cache is populated by
 * syncGoogleSheets() whenever the user triggers a sync from the integrations
 * page — the Sheets API is never called at page-load time.
 */

import { prisma } from "@/lib/db";

export interface CachedSheetMonth {
  grossCosts:       number;
  sharedAllocation: number;
  arpu:             number;
  ltv:              number;  // pre-computed LTV from sheet row 69
  grossMargin:      number;  // decimal 0–1
  churnRate:        number;  // decimal 0–1 (monthly, row 64)
}

/** Normalise a month string for cache key lookup ("Apr 2026" → "apr 2026"). */
export function normMonth(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}

/**
 * Returns a map of normalised-month → data for the requested months.
 * Returns null if the cache has never been populated (sync not yet run).
 *
 * Partial results are fine — months outside the cached range are simply
 * absent from the map and callers should treat them as zero.
 */
export async function getCachedSheetMonths(
  months: string[],
): Promise<Map<string, CachedSheetMonth> | null> {
  const normKeys = months.map(normMonth);
  const rows = await prisma.referenceSheetMonth.findMany({
    where: { month: { in: normKeys } },
  });
  if (rows.length === 0) return null;
  return new Map(
    rows.map((r) => [
      r.month,
      {
        grossCosts:       r.grossCosts,
        sharedAllocation: r.sharedAllocation,
        arpu:             r.arpu,
        ltv:              r.ltv,
        grossMargin:      r.grossMargin,
        churnRate:        r.churnRate,
      },
    ]),
  );
}

/** True if the cache has been seeded at least once. */
export async function isSheetCachePopulated(): Promise<boolean> {
  const count = await prisma.referenceSheetMonth.count();
  return count > 0;
}
