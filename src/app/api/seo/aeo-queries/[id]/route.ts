/**
 * PATCH  /api/seo/aeo-queries/[id]  — update label, query, targetUrl, or active
 * DELETE /api/seo/aeo-queries/[id]  — delete
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { scorePage, EMPTY_SIGNALS } from "@/lib/aeo-scoring";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json() as { label?: string; query?: string; targetUrl?: string; active?: boolean };

  const existing = await prisma.aeoCustomQuery.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const newQuery     = body.query?.trim()     ?? existing.query;
  const newTargetUrl = body.targetUrl?.trim() ?? existing.targetUrl;
  const queryOrUrlChanged = newQuery !== existing.query || newTargetUrl !== existing.targetUrl;

  // Re-score if the query or URL changed
  let scoreData: { score: number; signals: string; fetchedAt: Date } | Record<string, never> = {};
  if (queryOrUrlChanged) {
    const { signals, score } = await scorePage(newTargetUrl, [newQuery]).catch(() => ({
      signals: { ...EMPTY_SIGNALS },
      score: 0,
    }));
    scoreData = { score, signals: JSON.stringify(signals), fetchedAt: new Date() };
  }

  const updated = await prisma.aeoCustomQuery.update({
    where: { id },
    data: {
      label:     body.label?.trim()     ?? existing.label,
      query:     newQuery,
      targetUrl: newTargetUrl,
      active:    body.active            ?? existing.active,
      ...scoreData,
    },
  });

  return NextResponse.json({ ok: true, query: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.aeoCustomQuery.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
