/**
 * Shared AEO content scoring logic — used by both the static pillar scorer
 * and the user-managed custom query scorer.
 */

export interface AeoSignals {
  faqSchema:        boolean;
  orgSchema:        boolean;
  questionHeadings: boolean;
  directAnswer:     boolean;
  lists:            boolean;
  metaDesc:         boolean;
  h1Present:        boolean;
}

export const EMPTY_SIGNALS: AeoSignals = {
  faqSchema: false, orgSchema: false, questionHeadings: false,
  directAnswer: false, lists: false, metaDesc: false, h1Present: false,
};

export function scoreSignals(signals: AeoSignals): number {
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

export async function scorePage(
  url: string,
  seedTerms: string[],
): Promise<{ signals: AeoSignals; score: number }> {
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

  if (!html) return { signals: { ...EMPTY_SIGNALS }, score: 0 };

  const lower = html.toLowerCase();

  // Schema detection
  const schemas      = [...html.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map(m => m[1].toLowerCase());
  const faqSchema    = schemas.some(s => s === "faqpage" || s === "question");
  const orgSchema    = schemas.some(s =>
    ["organization", "localbusiness", "softwareapplication", "article", "webpage"].includes(s),
  );

  // Question-phrased H2/H3
  const headings         = [...html.matchAll(/<h[23][^>]*>([^<]+)<\/h[23]>/gi)].map(m => m[1]);
  const questionHeadings = headings.some(h => QUESTION_WORDS.test(h));

  // Direct answer paragraph (20–90 words, contains a seed term)
  const paragraphs   = [...html.matchAll(/<p[^>]*>([^<]{80,400})<\/p>/gi)].map(m => m[1].replace(/<[^>]+>/g, ""));
  const seeds        = seedTerms.map(s => s.toLowerCase());
  const directAnswer = paragraphs.some(p => {
    const words = p.trim().split(/\s+/).length;
    return words >= 20 && words <= 90 && seeds.some(s => p.toLowerCase().includes(s));
  });

  // Lists
  const lists = lower.includes("<ul") || lower.includes("<ol");

  // Meta description — handle both attribute orderings (Webflow puts content before name)
  const metaDesc = (
    /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{30}/i.test(html) ||
    /<meta[^>]+content=["'][^"']{30}[^"']*["'][^>]+name=["']description["']/i.test(html)
  );

  // H1
  const h1Present = /<h1[\s>]/i.test(html);

  const signals: AeoSignals = { faqSchema, orgSchema, questionHeadings, directAnswer, lists, metaDesc, h1Present };
  return { signals, score: scoreSignals(signals) };
}
