import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const channel = searchParams.get("channel") ?? undefined;
    const period = searchParams.get("period") ?? undefined;

    const targets = await prisma.pacingTarget.findMany({
      where: {
        ...(channel ? { channel } : {}),
        ...(period ? { period } : {}),
      },
      orderBy: [{ period: "desc" }, { channel: "asc" }],
    });

    return NextResponse.json(targets);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { channel, period, ...targets } = body as Record<string, unknown>;

    if (!channel || typeof channel !== "string") {
      return NextResponse.json({ error: "channel is required" }, { status: 422 });
    }
    if (!period || typeof period !== "string") {
      return NextResponse.json({ error: "period is required (e.g. '2026-04')" }, { status: 422 });
    }

    // Coerce numeric fields — allow null to clear a target
    const numericFields = [
      "targetMqls",
      "targetSqos",
      "targetPipeline",
      "targetClosedWon",
      "targetRevenue",
      "targetSpend",
    ];
    const data: Record<string, number | null> = {};
    for (const key of numericFields) {
      const raw = targets[key];
      if (raw === null || raw === undefined || raw === "") {
        data[key] = null;
      } else {
        const n = Number(raw);
        data[key] = isNaN(n) ? null : n;
      }
    }

    const result = await prisma.pacingTarget.upsert({
      where: { period_channel: { period, channel } },
      create: { period, channel, ...data },
      update: data,
    });

    return NextResponse.json({ ok: true, id: result.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[pacing targets]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
