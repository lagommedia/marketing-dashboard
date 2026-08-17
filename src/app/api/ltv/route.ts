import { NextRequest, NextResponse } from "next/server";
import { getCachedSheetMonths, normMonth } from "@/lib/sheets-cache";

export const dynamic = "force-dynamic";

const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * GET /api/ltv?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns the pre-computed LTV for the last month in the selected range,
 * read directly from the Reference Sheet cache (row 69 in the sheet).
 *
 * Returns:
 *   { ltv, targetMonth }
 * or
 *   { ltv: null, reason: "..." }
 */
export async function GET(req: NextRequest) {
  try {
    const sp    = req.nextUrl.searchParams;
    const toStr = sp.get("to");

    if (!toStr) {
      return NextResponse.json({ ltv: null, reason: "to is required" });
    }

    const to          = new Date(toStr + "T00:00:00");
    const targetMonth = `${SHORT_MONTHS[to.getMonth()]} ${to.getFullYear()}`;

    const cached = await getCachedSheetMonths([targetMonth]);
    if (!cached) {
      return NextResponse.json({ ltv: null, reason: "Run a Google Sheets sync to populate LTV data" });
    }

    const row = cached.get(normMonth(targetMonth));
    if (!row || row.ltv <= 0) {
      return NextResponse.json({ ltv: null, reason: `LTV is zero for ${targetMonth} — check the Reference Sheet` });
    }

    return NextResponse.json({ ltv: row.ltv, targetMonth });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ltv: null, reason: msg });
  }
}
