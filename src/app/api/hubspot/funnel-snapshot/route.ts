import { NextResponse } from "next/server";
import { syncFunnelSnapshot } from "@/lib/integrations/hubspot-funnel";

export async function POST() {
  try {
    const result = await syncFunnelSnapshot();
    return NextResponse.json(result);
  } catch (e) {
    console.error("[funnel-snapshot]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
