/**
 * GET /api/geo/results
 *
 * Returns all GeoPrompts with their accumulated mention stats per engine,
 * plus GSC impression proxies for "how often is this asked" context.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const [prompts, snapshots, gscRows] = await Promise.all([
    prisma.geoPrompt.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.aiMentionSnapshot.findMany({
      where: { promptId: { not: null } },
      orderBy: { syncedAt: "desc" },
    }),
    // Pull the last 90 days of GSC data to use as a proxy for query volume
    prisma.gscQuerySnapshot.findMany({
      where: { date: { gte: new Date(Date.now() - 90 * 86400_000) } },
      select: { query: true, impressions: true },
    }),
  ]);

  // Build GSC lookup: query text → total impressions over 90 days
  const gscImpressions: Record<string, number> = {};
  for (const row of gscRows) {
    gscImpressions[row.query.toLowerCase()] = (gscImpressions[row.query.toLowerCase()] ?? 0) + row.impressions;
  }

  // For each prompt, find related GSC queries by keyword overlap (any 3+ char word match)
  function estimateGscImpressions(promptText: string): number {
    const words = promptText.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    let total = 0;
    for (const [gscQuery, impressions] of Object.entries(gscImpressions)) {
      if (words.some(w => gscQuery.includes(w))) {
        total += impressions;
      }
    }
    return total;
  }

  // Attach snapshots to each prompt
  const results = prompts.map(prompt => {
    const promptSnaps = snapshots.filter(s => s.promptId === prompt.id);
    const byEngine = Object.fromEntries(
      promptSnaps.map(s => [
        s.engine,
        {
          runCount:     s.runCount,
          mentionCount: s.mentionCount,
          rate:         s.runCount > 0 ? Math.round((s.mentionCount / s.runCount) * 100) : null,
          lastRun:      s.syncedAt.toISOString(),
          citedUrls:    (() => { try { return JSON.parse(s.citedUrls ?? "[]") as string[]; } catch { return []; } })(),
        },
      ])
    );

    const allCitedUrls = [
      ...new Set(promptSnaps.flatMap(s => {
        try { return JSON.parse(s.citedUrls ?? "[]") as string[]; } catch { return []; }
      }))
    ];

    const lastRun = promptSnaps.length > 0
      ? new Date(Math.max(...promptSnaps.map(s => s.syncedAt.getTime()))).toISOString()
      : null;

    return {
      id:           prompt.id,
      text:         prompt.text,
      notes:        prompt.notes,
      createdAt:    prompt.createdAt.toISOString(),
      byEngine,
      allCitedUrls,
      lastRun,
      gscImpressions90d: estimateGscImpressions(prompt.text),
    };
  });

  return NextResponse.json({ results });
}
