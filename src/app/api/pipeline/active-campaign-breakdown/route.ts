import { NextResponse } from "next/server";
import { getActivePipelineCampaignBreakdown } from "@/lib/integrations/hubspot";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getActivePipelineCampaignBreakdown();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
