/**
 * POST /api/geo/run?id=<promptId>&runs=10
 *
 * Fires the specified GeoPrompt against OpenAI runs times using the Responses
 * API with web search enabled, accumulates mention counts and cited URLs,
 * and upserts into AiMentionSnapshot.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ZENI_PATTERN = /\bzeni\b/i;
const ZENI_DOMAIN  = "zeni.ai";

// ---------------------------------------------------------------------------
// OpenAI Responses API (with web search grounding)
// ---------------------------------------------------------------------------

interface UrlAnnotation { type: "url_citation"; url: string; title?: string }

async function queryOpenAI(
  question: string,
  apiKey: string,
): Promise<{ mentioned: boolean; citedUrls: string[]; responseText: string }> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      tools: [{ type: "web_search_preview" }],
      input: question,
    }),
  });
  if (!res.ok) {
    // Fall back to chat completions if Responses API not available
    return queryOpenAIChat(question, apiKey);
  }
  const json = await res.json();

  // Extract text + annotations from the output message
  const outputMsg = (json.output ?? []).find((o: { type: string }) => o.type === "message");
  const outputText = (outputMsg?.content ?? []).find((c: { type: string }) => c.type === "output_text");
  const text: string = outputText?.text ?? "";
  const annotations: UrlAnnotation[] = outputText?.annotations ?? [];

  const citedUrls = [...new Set(
    annotations
      .filter(a => a.type === "url_citation")
      .map(a => a.url)
      .filter(Boolean),
  )];

  return {
    mentioned:    ZENI_PATTERN.test(text) || citedUrls.some(u => u.includes(ZENI_DOMAIN)),
    citedUrls,
    responseText: text.slice(0, 1500),
  };
}

/** Fallback: classic Chat Completions (no web search, no cited URLs) */
async function queryOpenAIChat(
  question: string,
  apiKey: string,
): Promise<{ mentioned: boolean; citedUrls: string[]; responseText: string }> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 400,
      messages: [
        { role: "system", content: "You are a helpful B2B software research assistant. When asked about software categories, name specific companies and products. Be concise (under 300 words)." },
        { role: "user", content: question },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text: string = json.choices?.[0]?.message?.content ?? "";
  return { mentioned: ZENI_PATTERN.test(text), citedUrls: [], responseText: text.slice(0, 1500) };
}

// ---------------------------------------------------------------------------
// Accumulate results
// ---------------------------------------------------------------------------

async function runPromptForOpenAI(
  promptId: string,
  query: string,
  runs: number,
  apiKey: string,
): Promise<void> {
  let mentions = 0;
  let lastMentioned = false;
  const newUrls: string[] = [];
  const responseSnippets: string[] = [];

  for (let i = 0; i < runs; i++) {
    try {
      const result = await queryOpenAI(query, apiKey);
      if (result.mentioned) mentions++;
      lastMentioned = result.mentioned;
      newUrls.push(...result.citedUrls);
      if (result.responseText) responseSnippets.push(result.responseText);
    } catch (err) {
      console.error(`[geo/run] openai run ${i + 1} failed:`, err);
    }
    if (i < runs - 1) await new Promise(r => setTimeout(r, 400));
  }

  // Merge cited URLs
  const existing = await prisma.aiMentionSnapshot.findUnique({
    where: { engine_query: { engine: "openai", query } },
    select: { citedUrls: true },
  });
  const existingUrls: string[] = existing?.citedUrls ? (JSON.parse(existing.citedUrls) as string[]) : [];
  const mergedUrls = [...new Set([...existingUrls, ...newUrls])];

  // Store the most recent response snippet (last run)
  const latestResponse = responseSnippets[responseSnippets.length - 1] ?? null;

  await prisma.aiMentionSnapshot.upsert({
    where:  { engine_query: { engine: "openai", query } },
    create: {
      engine: "openai", query, promptId,
      mentioned: lastMentioned,
      runCount: runs, mentionCount: mentions,
      citedUrls:    JSON.stringify(mergedUrls),
      responseText: latestResponse,
      syncedAt: new Date(),
    },
    update: {
      promptId,
      mentioned: lastMentioned,
      runCount:     { increment: runs },
      mentionCount: { increment: mentions },
      citedUrls:    JSON.stringify(mergedUrls),
      responseText: latestResponse,
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
  if (!openaiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
  }

  await runPromptForOpenAI(promptId, prompt.text, runs, openaiKey);

  return NextResponse.json({ ok: true, runs, engines: ["openai"] });
}
