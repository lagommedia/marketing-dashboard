/**
 * POST /api/geo/analyze?id=<promptId>
 *
 * Uses GPT to analyze the stored response texts for a GeoPrompt and return:
 *  - competitors: companies/products commonly mentioned alongside or instead of Zeni
 *  - citedPages: URLs cited by OpenAI web search grounding
 *  - synopsis: why Zeni did or didn't appear, and what competitive context surrounds it
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const promptId = searchParams.get("id");
  if (!promptId) return NextResponse.json({ error: "id required" }, { status: 400 });

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

  // Fetch the prompt + all stored snapshots
  const [prompt, snapshots] = await Promise.all([
    prisma.geoPrompt.findUnique({ where: { id: promptId } }),
    prisma.aiMentionSnapshot.findMany({ where: { promptId, engine: "openai" } }),
  ]);

  if (!prompt) return NextResponse.json({ error: "prompt not found" }, { status: 404 });

  const responseTexts = snapshots
    .map(s => s.responseText)
    .filter(Boolean) as string[];

  const citedUrls = snapshots.flatMap(s => {
    try { return JSON.parse(s.citedUrls ?? "[]") as string[]; } catch { return []; }
  });
  const uniqueCitedUrls = [...new Set(citedUrls)];

  if (responseTexts.length === 0) {
    return NextResponse.json({
      competitors: [],
      citedPages:  uniqueCitedUrls,
      synopsis:    "No response text available yet — run the prompt first.",
    });
  }

  const combinedText = responseTexts.slice(-5).join("\n\n---\n\n"); // last 5 responses

  const analysisPrompt = `You are analyzing AI engine responses to the following research question:
"${prompt.text}"

Here are the most recent responses from OpenAI's GPT:
---
${combinedText}
---

Please analyze these responses and return a JSON object with exactly these fields:
{
  "competitors": ["list of company/product names mentioned in the responses OTHER than Zeni — ordered by frequency"],
  "zeniMentioned": true/false,
  "synopsis": "2-3 sentence plain-English explanation of: (1) what landscape GPT describes, (2) whether and how Zeni appears, (3) what the top competing products are and why they're being surfaced"
}

Return ONLY valid JSON. No markdown, no explanation.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 600,
        temperature: 0,
        messages: [{ role: "user", content: analysisPrompt }],
      }),
    });

    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const json = await res.json();
    const raw  = json.choices?.[0]?.message?.content ?? "{}";

    let parsed: { competitors?: string[]; zeniMentioned?: boolean; synopsis?: string } = {};
    try { parsed = JSON.parse(raw); } catch { /* malformed — use defaults */ }

    return NextResponse.json({
      competitors:   parsed.competitors   ?? [],
      zeniMentioned: parsed.zeniMentioned ?? false,
      citedPages:    uniqueCitedUrls,
      synopsis:      parsed.synopsis      ?? "Analysis unavailable.",
      promptText:    prompt.text,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Analysis failed" }, { status: 500 });
  }
}
