/**
 * AI Mention Tracker
 *
 * For each keyword pillar, fires 3 natural-language queries against:
 *   - OpenAI gpt-4o-mini  (tests model knowledge — OPENAI_API_KEY)
 *   - Gemini 1.5 Flash     (grounded search, returns real citations — GEMINI_API_KEY)
 *
 * Upserts results into AiMentionSnapshot. Run weekly.
 * Cost: ~$0.003 per full sync (48 queries across 2 engines).
 */

import { prisma } from "@/lib/db";
import { KEYWORD_PILLARS } from "@/lib/seo-pillars";

const ZENI_PATTERN = /\bzeni\b/i;
const ZENI_DOMAIN  = "zeni.ai";

// ---------------------------------------------------------------------------
// Query template generation
// ---------------------------------------------------------------------------

function queriesForPillar(label: string): string[] {
  return [
    `What is the best ${label} software for startups?`,
    `Which companies offer ${label} solutions?`,
    `What are the top ${label} tools used by finance teams?`,
    `Recommend a ${label} platform for a growing startup`,
    `What software do you recommend for ${label}?`,
  ];
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function queryOpenAI(question: string, apiKey: string): Promise<{ mentioned: boolean; citedUrls: string[] }> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful B2B software research assistant. When asked about software categories, name specific companies and products. Be concise (under 200 words).",
        },
        { role: "user", content: question },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const text: string = json.choices?.[0]?.message?.content ?? "";
  const mentioned = ZENI_PATTERN.test(text);
  return { mentioned, citedUrls: [] }; // OpenAI doesn't return URLs in standard completions
}

// ---------------------------------------------------------------------------
// Gemini — with Google Search grounding for real citations
// ---------------------------------------------------------------------------

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
}

async function queryGemini(question: string, apiKey: string): Promise<{ mentioned: boolean; citedUrls: string[] }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: {
        parts: [{
          text: "You are a helpful B2B software research assistant. When asked about software categories, name specific companies and products. Be concise (under 200 words).",
        }],
      },
      contents: [{ role: "user", parts: [{ text: question }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 300 },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const candidate = json.candidates?.[0];
  const text: string = candidate?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";

  // Check text mention
  const mentionedInText = ZENI_PATTERN.test(text);

  // Check grounding citations
  const chunks: GeminiGroundingChunk[] = candidate?.groundingMetadata?.groundingChunks ?? [];
  const zeniUrls = chunks
    .map(c => c.web?.uri ?? "")
    .filter(u => u.includes(ZENI_DOMAIN));

  const mentionedInCitations = zeniUrls.length > 0;

  return {
    mentioned:  mentionedInText || mentionedInCitations,
    citedUrls:  zeniUrls,
  };
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

type Engine = "openai" | "gemini";

interface QueryResult {
  pillarId:  string;
  query:     string;
  engine:    Engine;
  mentioned: boolean;
  citedUrls: string[];
}

export async function syncAiMentions(): Promise<{ rows: number; skipped: string[] }> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  const engines: Engine[] = [];
  const skipped: string[] = [];
  if (openaiKey) engines.push("openai");
  else           skipped.push("openai (OPENAI_API_KEY not set)");
  if (geminiKey) engines.push("gemini");
  else           skipped.push("gemini (GEMINI_API_KEY not set)");

  if (engines.length === 0) {
    throw new Error("No AI API keys configured. Add OPENAI_API_KEY and/or GEMINI_API_KEY to .env.local");
  }

  const results: QueryResult[] = [];

  // Build full query list per engine, then run each engine's batch separately
  // so we can use different pacing rates.
  // OpenAI paid tier: 300ms between calls (fine for TPM limits)
  // Gemini free tier: 4s between calls (15 RPM limit = 1 call every 4s)
  const ENGINE_DELAY_MS: Record<Engine, number> = { openai: 300, gemini: 4000 };

  for (const engine of engines) {
    for (const pillar of KEYWORD_PILLARS) {
      const queries = queriesForPillar(pillar.label);
      for (const query of queries) {
        try {
          let result: { mentioned: boolean; citedUrls: string[] };
          if (engine === "openai") {
            result = await queryOpenAI(query, openaiKey!);
          } else {
            result = await queryGemini(query, geminiKey!);
          }
          results.push({ pillarId: pillar.id, query, engine, ...result });
        } catch (err) {
          console.error(`[ai-mentions] ${engine} query failed for "${query}":`, err);
          results.push({ pillarId: pillar.id, query, engine, mentioned: false, citedUrls: [] });
        }
        await new Promise(r => setTimeout(r, ENGINE_DELAY_MS[engine]));
      }
    }
  }

  // Upsert all results
  for (const r of results) {
    await prisma.aiMentionSnapshot.upsert({
      where:  { pillarId_engine_query: { pillarId: r.pillarId, engine: r.engine, query: r.query } },
      create: { pillarId: r.pillarId, query: r.query, engine: r.engine, mentioned: r.mentioned, citedUrls: JSON.stringify(r.citedUrls), syncedAt: new Date() },
      update: { mentioned: r.mentioned, citedUrls: JSON.stringify(r.citedUrls), syncedAt: new Date() },
    });
  }

  console.log(`[ai-mentions] synced ${results.length} query results across ${engines.join(", ")}`);
  return { rows: results.length, skipped };
}
