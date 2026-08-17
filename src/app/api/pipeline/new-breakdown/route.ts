import { NextResponse } from "next/server";
import { fetchNewPipelineBreakdown } from "@/lib/integrations/hubspot";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const fromStr = searchParams.get("from");
    const toStr   = searchParams.get("to");

    if (!fromStr || !toStr) {
      return NextResponse.json({ error: "from and to query params required" }, { status: 400 });
    }

    const from = new Date(fromStr + "T00:00:00");
    const to   = new Date(toStr   + "T23:59:59");

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
    }

    const channel = searchParams.get("channel") ?? undefined;
    const data = await fetchNewPipelineBreakdown(from, to, channel);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch pipeline breakdown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
