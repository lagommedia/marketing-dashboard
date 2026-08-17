/**
 * GET /api/seo/ai-visibility
 *
 * Reads AiMentionSnapshot to compute:
 *   - Per-engine mention counts
 *   - Per-pillar visibility (which engines mention Zeni)
 *   - Cited pages (unique zeni.ai URLs from Gemini grounding)
 *   - Overall visibility score (0–100)
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { KEYWORD_PILLARS } from "@/lib/seo-pillars";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await prisma.aiMentionSnapshot.findMany({
    orderBy: { syncedAt: "desc" },
  });

  if (rows.length === 0) {
    return NextResponse.json({ hasData: false });
  }

  const lastSyncedAt = rows[0].syncedAt;

  // Which engines are present
  const engines = [...new Set(rows.map(r => r.engine))].sort();

  // Per-engine totals
  const engineStats: Record<string, { mentions: number; totalQueries: number; citedPages: string[] }> = {};
  for (const engine of engines) {
    const engineRows = rows.filter(r => r.engine === engine);
    const citedUrls  = engineRows
      .flatMap(r => {
        try { return JSON.parse(r.citedUrls ?? "[]") as string[]; }
        catch { return []; }
      })
      .filter((u, i, a) => a.indexOf(u) === i); // unique

    engineStats[engine] = {
      mentions:    engineRows.filter(r => r.mentioned).length,
      totalQueries: engineRows.length,
      citedPages:  citedUrls,
    };
  }

  // Per-pillar visibility
  const byPillar = KEYWORD_PILLARS.map(pillar => {
    const pillarRows = rows.filter(r => r.pillarId === pillar.id);
    const perEngine: Record<string, boolean> = {};
    for (const engine of engines) {
      perEngine[engine] = pillarRows.filter(r => r.engine === engine).some(r => r.mentioned);
    }
    const allCitedUrls = pillarRows
      .flatMap(r => {
        try { return JSON.parse(r.citedUrls ?? "[]") as string[]; }
        catch { return []; }
      })
      .filter((u, i, a) => a.indexOf(u) === i);

    return {
      pillarId:  pillar.id,
      label:     pillar.label,
      isPrimary: pillar.isPrimary,
      engines:   perEngine,
      citedUrls: allCitedUrls,
    };
  });

  // Overall visibility score (0–100)
  // = percentage of (pillar × engine) combinations where Zeni was mentioned
  const totalPossible = KEYWORD_PILLARS.length * engines.length;
  const totalMentioned = byPillar.reduce((sum, p) => {
    return sum + Object.values(p.engines).filter(Boolean).length;
  }, 0);
  const visibilityScore = totalPossible > 0
    ? Math.round((totalMentioned / totalPossible) * 100)
    : 0;

  // All unique cited pages across all engines
  const allCitedPages = [...new Set(
    rows.flatMap(r => {
      try { return JSON.parse(r.citedUrls ?? "[]") as string[]; }
      catch { return []; }
    })
  )];

  return NextResponse.json({
    hasData:        true,
    lastSyncedAt:   lastSyncedAt.toISOString(),
    visibilityScore,
    engines:        engineStats,
    allCitedPages,
    byPillar,
  });
}
