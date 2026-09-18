/**
 * GET  /api/seo/aeo-queries  — list all custom AEO query/page pairs
 * POST /api/seo/aeo-queries  — create a new one (body: { label, query, targetUrl })
 * POST /api/seo/aeo-queries?rescore=1 — rescore all active custom queries
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { scorePage, EMPTY_SIGNALS } from "@/lib/aeo-scoring";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await prisma.aeoCustomQuery.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json({ queries: rows });
}

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Rescore all active queries
  if (searchParams.get("rescore") === "1") {
    const active = await prisma.aeoCustomQuery.findMany({ where: { active: true } });
    await Promise.all(
      active.map(async q => {
        const seeds = [q.query]; // use the exact query as the seed term
        const { signals, score } = await scorePage(q.targetUrl, seeds);
        await prisma.aeoCustomQuery.update({
          where: { id: q.id },
          data:  { score, signals: JSON.stringify(signals), fetchedAt: new Date() },
        });
      })
    );
    const updated = await prisma.aeoCustomQuery.findMany({ orderBy: { createdAt: "asc" } });
    return NextResponse.json({ ok: true, queries: updated });
  }

  // Create
  const body = await req.json() as { label?: string; query?: string; targetUrl?: string };
  if (!body.label?.trim() || !body.query?.trim() || !body.targetUrl?.trim()) {
    return NextResponse.json({ error: "label, query, and targetUrl are required" }, { status: 400 });
  }

  // Score immediately on creation
  const { signals, score } = await scorePage(body.targetUrl.trim(), [body.query.trim()]).catch(() => ({
    signals: { ...EMPTY_SIGNALS },
    score: 0,
  }));

  const row = await prisma.aeoCustomQuery.create({
    data: {
      label:     body.label.trim(),
      query:     body.query.trim(),
      targetUrl: body.targetUrl.trim(),
      score,
      signals:   JSON.stringify(signals),
      fetchedAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true, query: row }, { status: 201 });
}
