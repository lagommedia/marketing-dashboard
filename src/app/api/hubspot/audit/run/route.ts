import { NextRequest, NextResponse } from "next/server";
import { runHubspotAudit } from "@/lib/integrations/hubspot-audit";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — audit can be slow on large portals

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const lookbackHours: number = body.lookbackHours ?? 25;

  const result = await runHubspotAudit(lookbackHours);
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
