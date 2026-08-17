/**
 * POST /api/integrations/google_analytics/sync
 * Body (optional): { from: "YYYY-MM-DD" }
 *
 * Fetches organic traffic by landing page from GA4 and upserts into
 * GaOrganicSnapshot. Defaults to the last 90 days.
 */
import { NextRequest, NextResponse } from "next/server";
import { syncGoogleAnalytics } from "@/lib/integrations/google-analytics";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body   = await req.json().catch(() => ({}));
    const from   = body.from ? new Date(body.from + "T00:00:00") : undefined;

    const result = await syncGoogleAnalytics(from);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ga4:sync]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
