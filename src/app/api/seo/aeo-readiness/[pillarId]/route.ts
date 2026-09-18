/**
 * PATCH /api/seo/aeo-readiness/[pillarId]
 *
 * Set or clear a user-pinned URL override for a static pillar, then rescore.
 * Body: { pageUrlOverride: string | null }
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { KEYWORD_PILLARS } from "@/lib/seo-pillars";
import { scorePage, EMPTY_SIGNALS } from "@/lib/aeo-scoring";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ pillarId: string }> },
) {
  const { pillarId } = await params;

  const pillar = KEYWORD_PILLARS.find(p => p.id === pillarId);
  if (!pillar) return NextResponse.json({ error: "pillar not found" }, { status: 404 });

  const body = await req.json() as { pageUrlOverride?: string | null };
  const override = body.pageUrlOverride?.trim() || null;

  // Score the new URL (or clear if null)
  const urlToScore = override;
  const { signals, score } = urlToScore
    ? await scorePage(urlToScore, pillar.seeds).catch(() => ({ signals: { ...EMPTY_SIGNALS }, score: 0 }))
    : { signals: { ...EMPTY_SIGNALS }, score: 0 };

  const updated = await prisma.aeoPillarScore.upsert({
    where:  { pillarId },
    create: {
      pillarId,
      pageUrl:         override,
      pageUrlOverride: override,
      score:           urlToScore ? score : 0,
      signals:         JSON.stringify(urlToScore ? signals : EMPTY_SIGNALS),
    },
    update: {
      pageUrlOverride: override,
      // If clearing the override, keep the existing auto-discovered score intact
      ...(urlToScore ? { score, signals: JSON.stringify(signals), fetchedAt: new Date() } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    pillar: {
      pillarId,
      label:           pillar.label,
      isPrimary:       pillar.isPrimary,
      pageUrl:         updated.pageUrlOverride ?? updated.pageUrl,
      pageUrlOverride: updated.pageUrlOverride,
      score:           updated.score,
      signals:         JSON.parse(updated.signals),
    },
  });
}
