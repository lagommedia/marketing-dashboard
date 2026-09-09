import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/ltv?from=YYYY-MM-DD
 *
 * LTV = (Annual ARPU × Gross Margin %) ÷ Annual Churn Rate
 * All inputs come from PacingTarget for the quarter containing `from`.
 */
export async function GET(req: NextRequest) {
  try {
    const fromStr = req.nextUrl.searchParams.get("from");
    if (!fromStr) {
      return NextResponse.json({ ltv: null, reason: "from is required" });
    }

    const from   = new Date(fromStr + "T00:00:00Z");
    const q      = Math.floor(from.getMonth() / 3);
    const period = `${from.getFullYear()}-Q${q + 1}`;

    const target = await prisma.pacingTarget.findUnique({
      where:  { period_channel: { period, channel: "marketing_org" } },
      select: { arpu: true, grossMargin: true, arrChurnPct: true },
    });

    if (!target) {
      return NextResponse.json({
        ltv: null,
        reason: `No assumptions set for ${period} — add them on the Pacing page.`,
      });
    }

    const { arpu, grossMargin, arrChurnPct } = target;

    if (arpu == null)        return NextResponse.json({ ltv: null, reason: "ARPU not set — add it on the Pacing page." });
    if (grossMargin == null) return NextResponse.json({ ltv: null, reason: "Gross Margin % not set — add it on the Pacing page." });
    if (arrChurnPct == null || arrChurnPct <= 0)
      return NextResponse.json({ ltv: null, reason: "ARR Churn % not set — add it on the Pacing page." });

    const ltv = (arpu * grossMargin) / arrChurnPct;

    return NextResponse.json({ ltv, arpu, grossMargin, annualChurnRate: arrChurnPct, period });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ltv: null, reason: msg });
  }
}
