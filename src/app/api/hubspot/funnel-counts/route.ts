import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to   = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  try {
    const fromDate = new Date(from);
    const toEnd    = new Date(to);
    toEnd.setHours(23, 59, 59, 999);

    // Same query as the overview page: "all" channel = marketing-attributed totals
    const rows = await prisma.metricSnapshot.findMany({
      where: {
        date: { gte: fromDate, lte: toEnd },
        OR: [
          { platform: "hubspot",               channel: "all"        },
          { platform: "google_ads",            channel: "paid_media" },
          { platform: "google_search_console", channel: "organic"    },
          { platform: "manual",                channel: "paid_media" },
          { platform: "manual",                channel: "organic"    },
        ],
      },
    });

    const sum = (key: "leads" | "mqls" | "sqos" | "closedWon") =>
      rows.reduce((acc, r) => acc + ((r[key] as number | null) ?? 0), 0);

    return NextResponse.json({
      leads:     sum("leads"),
      mqls:      sum("mqls"),
      sqls:      0,
      sqos:      sum("sqos"),
      sqds:      0,
      closedWon: sum("closedWon"),
    });
  } catch (e) {
    console.error("[funnel-counts]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
