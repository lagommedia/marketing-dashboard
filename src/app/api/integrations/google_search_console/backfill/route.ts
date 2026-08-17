/**
 * POST /api/integrations/google_search_console/backfill
 * Body: { from: "YYYY-MM-DD" }
 *
 * Fetches GSC daily data from `from` to today-3 (GSC lag) and writes one
 * MetricSnapshot per day (impressions, clicks, ctr).
 */
import { NextRequest, NextResponse } from "next/server";
import { backfillSearchConsole } from "@/lib/integrations/google-search-console";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const fromStr = body.from as string | undefined;

    if (!fromStr || !/^\d{4}-\d{2}-\d{2}$/.test(fromStr)) {
      return NextResponse.json(
        { error: "Missing or invalid `from` date. Expected format: YYYY-MM-DD" },
        { status: 400 }
      );
    }

    const from = new Date(fromStr + "T00:00:00");
    const result = await backfillSearchConsole(from);

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[gsc:backfill]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
