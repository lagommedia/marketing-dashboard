import { NextRequest, NextResponse } from "next/server";
import { backfillHubspot } from "@/lib/integrations/hubspot";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    // Accept a `from` date in the request body, defaulting to April 1 of the current year
    const fromStr: string = body.from ?? `${new Date().getFullYear()}-04-01`;
    const from = new Date(fromStr + "T00:00:00Z"); // UTC — prevents Mountain-Time off-by-hours

    if (isNaN(from.getTime())) {
      return NextResponse.json({ error: "Invalid `from` date — use YYYY-MM-DD" }, { status: 422 });
    }

    console.log(`[backfill] starting HubSpot backfill from ${fromStr}`);
    const result = await backfillHubspot(from);
    console.log(`[backfill] complete — ${result.days} days, ${result.snapshots} snapshots`);

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backfill failed";
    console.error("[backfill]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
