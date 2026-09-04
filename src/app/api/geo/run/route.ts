/**
 * POST /api/geo/run?id=<promptId>&runs=10
 *
 * Fires the specified GeoPrompt against OpenAI and/or Gemini `runs` times,
 * accumulates mention counts and cited URLs, and upserts into AiMentionSnapshot.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ZENI_PATTERN = /\bzeni\b/i;
const ZENI_DOMAIN  = "zeni.ai";

// ---------------------------------------------------------------------------
// Engine callers
// ---------------------------------------------------------------------------

async function queryOpenAI(question: string, apiKey: string): Promise<{ mentioned: boolean; citedUrls: string[] }> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 300,
      messages: [
        { role: "system", content: "You are a helpful B2B software research assistant. When asked about software categories, name specific companies and products. Be concise (under 200 words)." },
        { role: "user", content: question },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text: string = json.choices?.[0]?.message?.content ?? "";
  return { mentioned: ZENI_PATTERN.test(text), citedUrls: [] };
}

interface GeminiGroundingChunk { web?: { uri?: string } }

async function queryGemini(question: string, apiKey: string): Promise<{ mentioned: boolean; citedUrls: string[] }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: "You are a helpful B2B software research assistant. When asked about software categories, name specific companies and products. Be concise (under 200 words)." }] },
      contents: [{ role: "user", parts: [{ text: question }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 300 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const candidate = json.candidates?.[0];
  const text: string = candidate?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  const chunks: GeminiGroundingChunk[] = candidate?.groundingMetadata?.groundingChunks ?? [];
  const zeniUrls = chunks.map(c => c.web?.uri ?? "").filter(u => u.includes(ZENI_DOMAIN));
  return { mentioned: ZENI_PATTERN.test(text) || zeniUrls.length > 0, citedUrls: zeniUrls };
}

// ---------------------------------------------------------------------------
// Accumulate results into AiMentionSnapshot
// ---------------------------------------------------------------------------

async function runPromptForEngine(
  promptId: string,
  query: string,
  engine: "openai" | "gemini",
  runs: number,
  apiKey: string,
): Promise<void> {
  const delayMs = engine === "gemini" ? 4000 : 300;
  let mentions = 0;
  let lastMentioned = false;
  const newUrls: string[] = [];

  for (let i = 0; i < runs; i++) {
    try {
      const result = engine === "openai"
        ? await queryOpenAI(query, apiKey)
        : await queryGemini(query, apiKey);
      if (result.mentioned) mentions++;
      lastMentioned = result.mentioned;
      newUrls.push(...result.citedUrls);
    } catch (err) {
      console.error(`[geo/run] ${engine} run ${i + 1} failed:`, err);
    }
    if (i < runs - 1) await new Promise(r => setTimeout(r, delayMs));
  }

  // Merge with any existing cited URLs
  const existing = await prisma.aiMentionSnapshot.findUnique({
    where: { engine_query: { engine, query } },
    select: { citedUrls: true },
  });
  const existingUrls: string[] = existing?.citedUrls
    ? (JSON.parse(existing.citedUrls) as string[])
    : [];
  const mergedUrls = [...new Set([...existingUrls, ...newUrls])];

  await prisma.aiMentionSnapshot.upsert({
    where:  { engine_query: { engine, query } },
    create: {
      engine, query, promptId,
      mentioned: lastMentioned,
      runCount: runs, mentionCount: mentions,
      citedUrls: JSON.stringify(mergedUrls),
      syncedAt: new Date(),
    },
    update: {
      promptId,
      mentioned: lastMentioned,
      runCount:     { increment: runs },
      mentionCount: { increment: mentions },
      citedUrls: JSON.stringify(mergedUrls),
      syncedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const promptId = searchParams.get("id");
  const runs     = Math.min(parseInt(searchParams.get("runs") ?? "10", 10), 20);

  if (!promptId) return NextResponse.json({ error: "id required" }, { status: 400 });

  const prompt = await prisma.geoPrompt.findUnique({ where: { id: promptId } });
  if (!prompt) return NextResponse.json({ error: "prompt not found" }, { status: 404 });

  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!openaiKey && !geminiKey) {
    return NextResponse.json({ error: "No API keys configured (OPENAI_API_KEY / GEMINI_API_KEY)" }, { status: 500 });
  }

  const engines: Array<"openai" | "gemini"> = [];
  if (openaiKey) engines.push("openai");
  if (geminiKey) engines.push("gemini");

  for (const engine of engines) {
    await runPromptForEngine(
      promptId,
      prompt.text,
      engine,
      runs,
      engine === "openai" ? openaiKey! : geminiKey!,
    );
  }

  return NextResponse.json({ ok: true, runs, engines });
}
