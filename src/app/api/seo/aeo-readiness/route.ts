/**
 * GET /api/seo/aeo-readiness
 *
 * Scores each keyword pillar's zeni.ai page against 7 AEO content signals.
 * Results are cached in AeoPillarScore for 24 hours.
 *
 * POST /api/seo/aeo-readiness  — force-refresh all scores
 *
 * Scoring rubric (0-100):
 *   FAQPage schema       20 pts
 *   Question headings    20 pts
 *   Direct answer para   20 pts
 *   Structured lists     15 pts
 *   Org/Article schema   15 pts
 *   Meta description     5 pts
 *   H1 present           5 pts
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { KEYWORD_PILLARS } from "@/lib/seo-pillars";
import { scorePage, EMPTY_SIGNALS, type AeoSignals } from "@/lib/aeo-scoring";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ZENI_BASE    = "https://www.zeni.ai";

// ---------------------------------------------------------------------------
// Sitemap discovery — find the best URL for each pillar
// ---------------------------------------------------------------------------

async function discoverPillarUrls(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const res = await fetch(`${ZENI_BASE}/sitemap.xml`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return map;
    const xml  = await res.text();
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());

    for (const pillar of KEYWORD_PILLARS) {
      let bestUrl   = "";
      let bestScore = 0;
      for (const url of urls) {
        const path = url.replace(ZENI_BASE, "").toLowerCase();
        const score = pillar.seeds.reduce((acc, seed) => {
          const slug = seed.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
          return acc + (path.includes(slug) ? 2 : path.includes(seed.split(" ")[1] ?? "") ? 1 : 0);
        }, 0);
        if (score > bestScore) { bestScore = score; bestUrl = url; }
      }
      if (bestScore > 0) map.set(pillar.id, bestUrl);
    }
  } catch {
    // silently ignore
  }
  return map;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function computeAndCache(force = false) {
  const pillarUrls = await discoverPillarUrls();
  const cutoff     = new Date(Date.now() - CACHE_TTL_MS);

  const results = await Promise.all(
    KEYWORD_PILLARS.map(async pillar => {
      const existing = await prisma.aeoPillarScore.findUnique({ where: { pillarId: pillar.id } });

      if (!force && existing && existing.fetchedAt > cutoff) {
        return {
          pillarId:        pillar.id,
          label:           pillar.label,
          isPrimary:       pillar.isPrimary,
          pageUrl:         existing.pageUrlOverride ?? existing.pageUrl,
          pageUrlOverride: existing.pageUrlOverride,
          score:           existing.score,
          signals:         JSON.parse(existing.signals) as AeoSignals,
          fromCache:       true,
        };
      }

      // User-pinned URL takes precedence over sitemap discovery
      const pageUrl = existing?.pageUrlOverride ?? pillarUrls.get(pillar.id) ?? null;
      const { signals, score } = pageUrl
        ? await scorePage(pageUrl, pillar.seeds)
        : { signals: { ...EMPTY_SIGNALS }, score: 0 };

      await prisma.aeoPillarScore.upsert({
        where:  { pillarId: pillar.id },
        create: { pillarId: pillar.id, pageUrl, score, signals: JSON.stringify(signals) },
        update: { pageUrl, score, signals: JSON.stringify(signals), fetchedAt: new Date() },
      });

      return {
        pillarId:        pillar.id,
        label:           pillar.label,
        isPrimary:       pillar.isPrimary,
        pageUrl,
        pageUrlOverride: existing?.pageUrlOverride ?? null,
        score,
        signals,
        fromCache:       false,
      };
    })
  );

  return results;
}

export async function GET() {
  try {
    const results = await computeAndCache(false);
    return NextResponse.json({ ok: true, pillars: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[aeo:readiness]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST() {
  try {
    const results = await computeAndCache(true);
    return NextResponse.json({ ok: true, refreshed: results.length, pillars: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[aeo:readiness:refresh]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
