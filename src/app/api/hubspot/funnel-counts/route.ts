import { NextResponse } from "next/server";
import { getFunnelCounts } from "@/lib/integrations/hubspot-funnel";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to   = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  try {
    const counts = await getFunnelCounts(new Date(from), new Date(to));
    return NextResponse.json(counts);
  } catch (e) {
    console.error("[funnel-counts]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
