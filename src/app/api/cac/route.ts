import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function pctElapsed(from: Date, to: Date): number {
  const q      = Math.floor(from.getMonth() / 3);
  const qStart = new Date(from.getFullYear(), q * 3,     1);
  const qEnd   = new Date(from.getFullYear(), q * 3 + 3, 0);
  const totalMs   = qEnd.getTime() - qStart.getTime() + 86_400_000;
  const asOf      = new Date(Math.min(Date.now(), new Date(to.getTime() + 86_400_000).getTime()));
  const elapsedMs = Math.min(Math.max(asOf.getTime() - qStart.getTime(), 0), totalMs);
  return elapsedMs / totalMs;
}

/**
 * GET /api/cac?from=YYYY-MM-DD&to=YYYY-MM-DD&closedWon=N
 *
 * CAC = (Gross Expenses × % of quarter elapsed) ÷ Closed Won
 * Gross Expenses comes from PacingTarget.targetSpend (the Pacing page).
 */
export async function GET(req: NextRequest) {
  try {
    const sp        = req.nextUrl.searchParams;
    const fromStr   = sp.get("from");
    const toStr     = sp.get("to");
    const closedWon = parseFloat(sp.get("closedWon") ?? "0");

    if (!fromStr || !toStr) {
      return NextResponse.json({ cac: null, reason: "from and to are required" });
    }
    if (!closedWon || closedWon <= 0) {
      return NextResponse.json({ cac: null, reason: "No closed won customers in this period" });
    }

    const from = new Date(fromStr + "T00:00:00Z");
    const to   = new Date(toStr   + "T00:00:00Z");

    const q      = Math.floor(from.getMonth() / 3);
    const period = `${from.getFullYear()}-Q${q + 1}`;

    const target = await prisma.pacingTarget.findUnique({
      where:  { period_channel: { period, channel: "marketing_org" } },
      select: { targetSpend: true },
    });

    if (target?.targetSpend == null) {
      return NextResponse.json({
        cac: null,
        reason: `No Gross Expenses set for ${period} — add them on the Pacing page.`,
      });
    }

    const grossExpenses = target.targetSpend;
    const pct           = pctElapsed(from, to);
    const denominator   = grossExpenses * pct;

    if (denominator <= 0) {
      return NextResponse.json({ cac: null, reason: "Cost denominator is zero" });
    }

    return NextResponse.json({
      cac: denominator / closedWon,
      grossExpenses,
      pctElapsed: pct,
      denominator,
      closedWon,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ cac: null, reason: msg });
  }
}
