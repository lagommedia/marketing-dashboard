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
    // Snapshots exist but predate the responseText field — user needs to re-run the prompt
    return NextResponse.json({
      competitorDetails: [],
      citedPages:        uniqueCitedUrls,
      zeniMentioned:     false,
      synopsis:          "No GPT response text stored yet. Run the prompt (\"Run 10×\") once more to capture response text, then click Analyze.",
    });
  }

  const combinedText = responseTexts.slice(-5).join("\n\n---\n\n"); // last 5 responses

  // Build a URL→domain map for matching competitors to cited pages
  const citedUrlMap = uniqueCitedUrls.reduce<Record<string, string>>((acc, url) => {
    try { acc[new URL(url).hostname.replace("www.", "")] = url; } catch { /* skip */ }
    return acc;
  }, {});

  const analysisPrompt = `You are a competitive intelligence analyst. A user asked AI assistants: "${prompt.text}"

Here are the most recent AI responses:
---
${combinedText}
---

The cited URLs from AI web search grounding are:
${uniqueCitedUrls.slice(0, 20).join("\n") || "(none)"}

Analyze which companies appear in the AI responses and return a JSON object with exactly this structure:

{
  "competitorDetails": [
    {
      "company": "Company or product name",
      "citedUrl": "The specific URL from the cited list that matches this company, or null if none",
      "why": "1-2 sentences: WHY is this company being surfaced by GPT for this query? What gives it authority here?",
      "whatZeniCanDo": "1-2 sentences: What specific action or positioning could Zeni take to compete with or displace this result?"
    }
  ],
  "zeniMentioned": true or false,
  "synopsis": "2-3 sentences summarizing the competitive landscape and Zeni's position"
}

Rules:
- Include only companies/products OTHER than Zeni (unless Zeni was not mentioned — then note that in synopsis)
- Order by prominence in the responses (most frequently or prominently mentioned first)
- Keep "why" specific to THIS query, not generic — explain the actual reason GPT surfaces them for this question
- Keep "whatZeniCanDo" actionable and concrete — a specific content, SEO, or positioning move
- citedUrl must be one of the cited URLs provided above, or null
- Return ONLY valid JSON. No markdown, no explanation outside the JSON.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 1500,
        temperature: 0,
        messages: [{ role: "user", content: analysisPrompt }],
      }),
    });

    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const raw  = json.choices?.[0]?.message?.content ?? "{}";

    // Strip markdown code fences GPT sometimes wraps JSON in
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

    let parsed: {
      competitorDetails?: Array<{ company: string; citedUrl: string | null; why: string; whatZeniCanDo: string }>;
      zeniMentioned?: boolean;
      synopsis?: string;
    } = {};
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("[geo/analyze] JSON parse failed. Raw:", raw.slice(0, 500), parseErr);
    }

    const payload = {
      competitorDetails: parsed.competitorDetails ?? [],
      zeniMentioned:     parsed.zeniMentioned     ?? false,
      citedPages:        uniqueCitedUrls,
      synopsis:          parsed.synopsis           ?? "Analysis unavailable.",
      promptText:        prompt.text,
      citedUrlMap,
    };

    // Persist so the analysis survives page refreshes
    await prisma.geoPrompt.update({
      where: { id: promptId },
      data:  { analysisJson: JSON.stringify(payload), analyzedAt: new Date() },
    });

    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Analysis failed" }, { status: 500 });
  }
}
