import { NextResponse } from "next/server";
import { getFunnelStageRecords, type FunnelStage } from "@/lib/integrations/hubspot-funnel";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const stage = searchParams.get("stage") as FunnelStage | null;
  const from  = searchParams.get("from");
  const to    = searchParams.get("to");

  const validStages: FunnelStage[] = ["leads", "mqls", "sqls", "sqos", "sqds", "closedwon"];
  if (!stage || !validStages.includes(stage)) {
    return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
  }
  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  try {
    const records = await getFunnelStageRecords(stage, new Date(from), new Date(to));
    return NextResponse.json({ records });
  } catch (e) {
    console.error("[funnel-stage-contacts]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
