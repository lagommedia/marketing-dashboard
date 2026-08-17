import { NextRequest, NextResponse } from "next/server";
import { syncCampaignData } from "@/lib/integrations/google-ads";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const fromStr = body.from as string | undefined;
    const fromDate = fromStr ? new Date(fromStr + "T00:00:00") : undefined;

    const result = await syncCampaignData(fromDate);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[google_ads:campaign-sync]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
