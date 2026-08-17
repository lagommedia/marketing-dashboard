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
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { KEYWORD_PILLARS, KeywordPillar } from "@/lib/seo-pillars";

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
      // Score each URL by how many seed terms appear in the path
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
    // silently ignore — scores will show page URL as null
  }
  return map;
}

// ---------------------------------------------------------------------------
// AEO signal scoring
// ---------------------------------------------------------------------------

interface Signals {
  faqSchema:        boolean;
  orgSchema:        boolean;
  questionHeadings: boolean;
  directAnswer:     boolean;
  lists:            boolean;
  metaDesc:         boolean;
  h1Present:        boolean;
}

function scoreSignals(signals: Signals): number {
  return (
    (signals.faqSchema        ? 20 : 0) +
    (signals.questionHeadings ? 20 : 0) +
    (signals.directAnswer     ? 20 : 0) +
    (signals.lists            ? 15 : 0) +
    (signals.orgSchema        ? 15 : 0) +
    (signals.metaDesc         ?  5 : 0) +
    (signals.h1Present        ?  5 : 0)
  );
}

const QUESTION_WORDS = /\b(what|how|why|is|are|can|does|when|where|who|which|should|will)\b/i;

async function scorePage(url: string, pillar: KeywordPillar): Promise<{ signals: Signals; score: number }> {
  let html = "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ZeniDashboard/1.0)" },
      signal:  AbortSignal.timeout(10000),
    });
    if (res.ok) html = await res.text();
  } catch {
    // page unreachable — return zero score
  }

  const lower = html.toLowerCase();

  // Schema detection
  const schemas      = [...html.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map(m => m[1].toLowerCase());
  const faqSchema    = schemas.some(s => s === "faqpage" || s === "question");
  const orgSchema    = schemas.some(s => ["organization", "localbusiness", "softwareapplication", "article", "webpage"].includes(s));

  // Heading detection — look for question-phrased h2/h3
  const headings     = [...html.matchAll(/<h[23][^>]*>([^<]+)<\/h[23]>/gi)].map(m => m[1]);
  const questionHeadings = headings.some(h => QUESTION_WORDS.test(h));

  // Direct answer — paragraph that starts with or immediately follows a question heading,
  // is concise (30-80 words), and contains a seed term
  const paragraphs   = [...html.matchAll(/<p[^>]*>([^<]{80,400})<\/p>/gi)].map(m => m[1].replace(/<[^>]+>/g, ""));
  const seedTerms    = pillar.seeds.map(s => s.toLowerCase());
  const directAnswer = paragraphs.some(p => {
    const words = p.trim().split(/\s+/).length;
    return words >= 20 && words <= 90 && seedTerms.some(s => p.toLowerCase().includes(s));
  });

  // Lists
  const lists        = lower.includes("<ul") || lower.includes("<ol");

  // Meta description
  const metaDesc     = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{30}/i.test(html);

  // H1
  const h1Present    = /<h1[\s>]/i.test(html);

  const signals: Signals = { faqSchema, orgSchema, questionHeadings, directAnswer, lists, metaDesc, h1Present };
  return { signals, score: scoreSignals(signals) };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function computeAndCache(force = false) {
  const pillarUrls = await discoverPillarUrls();
  const cutoff     = new Date(Date.now() - CACHE_TTL_MS);

  const results = await Promise.all(
    KEYWORD_PILLARS.map(async pillar => {
      // Check cache first (unless forcing refresh)
      if (!force) {
        const cached = await prisma.aeoPillarScore.findUnique({ where: { pillarId: pillar.id } });
        if (cached && cached.fetchedAt > cutoff) {
          return {
            pillarId:  pillar.id,
            label:     pillar.label,
            isPrimary: pillar.isPrimary,
            pageUrl:   cached.pageUrl,
            score:     cached.score,
            signals:   JSON.parse(cached.signals) as Signals,
            fromCache: true,
          };
        }
      }

      const pageUrl = pillarUrls.get(pillar.id) ?? null;
      const { signals, score } = pageUrl
        ? await scorePage(pageUrl, pillar)
        : { signals: { faqSchema: false, orgSchema: false, questionHeadings: false, directAnswer: false, lists: false, metaDesc: false, h1Present: false }, score: 0 };

      await prisma.aeoPillarScore.upsert({
        where:  { pillarId: pillar.id },
        create: { pillarId: pillar.id, pageUrl, score, signals: JSON.stringify(signals) },
        update: { pageUrl, score, signals: JSON.stringify(signals), fetchedAt: new Date() },
      });

      return { pillarId: pillar.id, label: pillar.label, isPrimary: pillar.isPrimary, pageUrl, score, signals, fromCache: false };
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
