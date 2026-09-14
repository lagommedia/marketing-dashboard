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

  const analysisPrompt = `You are a GEO (Generative Engine Optimization) specialist. An AI assistant was asked: "${prompt.text}"

Here are the actual AI responses:
---
${combinedText}
---

URLs the AI cited via web search:
${uniqueCitedUrls.slice(0, 20).join("\n") || "(none)"}

Zeni (zeni.ai) is an AI-powered bookkeeping and financial operations platform for startups and growing businesses.

Return a JSON object with exactly this structure:

{
  "competitorDetails": [
    {
      "company": "Company or product name",
      "citedUrl": "One of the cited URLs above that belongs to this company, or null",
      "mentioned": "1-2 sentences: what did the AI actually say about this company? Quote or closely paraphrase the specific claim or feature the AI attributed to them."
    }
  ],
  "actions": [
    {
      "category": "Content" | "Schema" | "Internal Links" | "Directory / PR" | "Page Update",
      "priority": "high" | "medium" | "low",
      "task": "Specific, executable action. Name the exact page, schema type, directory, keyword, or section. E.g. 'Add an FAQ section to zeni.ai/bookkeeping answering Is AI bookkeeping safe? with a 60-word direct answer paragraph' or 'Submit Zeni to G2\\'s AI Accounting Software category — QuickBooks and Xero are currently listed there' or 'Add FAQPage + Article schema to the zeni.ai/blog/ai-bookkeeping post' or 'Internally link from zeni.ai/pricing to zeni.ai/security using anchor text AI bookkeeping security'."
    }
  ],
  "zeniMentioned": true or false,
  "synopsis": "2-3 sentences: what does the AI say about this topic space, and what specifically is causing Zeni to be absent (or present)?"
}

Rules:
- competitorDetails: only companies OTHER than Zeni; order by how prominently the AI mentioned them
- citedUrl must be an exact URL from the list above or null — do not invent URLs
- actions: 5-8 specific, immediately executable tasks Zeni's team can act on to appear for this query. Each task must name a real page, schema type, directory, or anchor text — no vague guidance like "create more content" or "improve SEO." Reference the cited URLs and competitor pages where relevant.
- priority high = biggest gap or highest-leverage action; low = nice-to-have
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
      competitorDetails?: Array<{ company: string; citedUrl: string | null; mentioned: string }>;
      actions?: Array<{ category: string; priority: string; task: string }>;
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
      actions:           parsed.actions           ?? [],
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
