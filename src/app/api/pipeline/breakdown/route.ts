import { NextResponse } from "next/server";
import { fetchActivePipelineBreakdown } from "@/lib/integrations/hubspot";

export async function GET() {
  try {
    const data = await fetchActivePipelineBreakdown();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch pipeline breakdown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
