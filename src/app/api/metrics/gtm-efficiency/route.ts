import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function pctElapsed(from: Date, to: Date): number {
  const q      = Math.floor(from.getMonth() / 3);
  const qStart = new Date(from.getFullYear(), q * 3,     1);
  const qEnd   = new Date(from.getFullYear(), q * 3 + 3, 0);
  const totalMs   = qEnd.getTime() - qStart.getTime() + 86_400_000;
  // Cap at today or the end of the selected range, whichever is earlier
  const asOf      = new Date(Math.min(Date.now(), new Date(to.getTime() + 86_400_000).getTime()));
  const elapsedMs = Math.min(Math.max(asOf.getTime() - qStart.getTime(), 0), totalMs);
  return elapsedMs / totalMs;
}

export async function GET(req: NextRequest) {
  try {
    const sp           = req.nextUrl.searchParams;
    const fromStr      = sp.get("from");
    const toStr        = sp.get("to");
    const revenueParam = sp.get("revenue");

    if (!fromStr || !toStr || revenueParam == null) {
      return NextResponse.json({ error: "from, to, and revenue are required" }, { status: 400 });
    }

    const from    = new Date(fromStr + "T00:00:00Z");
    const to      = new Date(toStr   + "T00:00:00Z");
    const revenue = parseFloat(revenueParam);

    if (isNaN(revenue)) {
      return NextResponse.json({ gtmEfficiency: null, reason: "invalid revenue" });
    }

    const q      = Math.floor(from.getMonth() / 3);
    const period = `${from.getFullYear()}-Q${q + 1}`;

    const target = await prisma.pacingTarget.findUnique({
      where:  { period_channel: { period, channel: "marketing_org" } },
      select: { targetSpend: true },
    });

    if (target?.targetSpend == null) {
      return NextResponse.json({
        gtmEfficiency: null,
        reason: `No Gross Expenses set for ${period} — add them on the Pacing page.`,
      });
    }

    const grossExpenses = target.targetSpend;
    const pct           = pctElapsed(from, to);
    const denominator   = grossExpenses * pct;

    if (denominator <= 0) {
      return NextResponse.json({ gtmEfficiency: null, reason: "Denominator is zero" });
    }

    return NextResponse.json({
      gtmEfficiency: revenue / denominator,
      revenue,
      grossExpenses,
      denominator,
      pctElapsed: pct,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gtm-efficiency]", msg);
    return NextResponse.json({ gtmEfficiency: null, reason: msg });
  }
}
