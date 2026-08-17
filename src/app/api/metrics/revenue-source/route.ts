import { NextRequest, NextResponse } from "next/server";
import { getMetricBySource, getMetricCampaignBreakdown, MetricSourceKey } from "@/lib/integrations/hubspot";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const from        = searchParams.get("from");
  const to          = searchParams.get("to");
  const metricParam = (searchParams.get("metric") ?? "revenue") as MetricSourceKey;

  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  try {
    // Fetch totals and campaign breakdown in parallel
    const [totals, campaigns] = await Promise.all([
      getMetricBySource(metricParam, from, to),
      getMetricCampaignBreakdown(metricParam, from, to),
    ]);

    return NextResponse.json({ ...totals, campaigns });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
