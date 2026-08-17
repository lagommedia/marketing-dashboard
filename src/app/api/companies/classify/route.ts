import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

async function resolveApiKey(): Promise<string | null> {
  try {
    const row = await prisma.integration.findUnique({ where: { platform: "anthropic" } });
    if (row?.connected && row.accessToken) return decrypt(row.accessToken);
  } catch { /* fall through */ }
  return process.env.ANTHROPIC_API_KEY ?? null;
}

export async function POST() {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic AI is not connected. Add your API key under Integrations." },
      { status: 503 }
    );
  }

  // Fetch unclassified companies
  const unclassified = await prisma.hubspotCompany.findMany({
    where: { isAiCompany: null },
    select: { id: true, name: true, domain: true, website: true, industry: true },
  });

  if (unclassified.length === 0) {
    return NextResponse.json({ classified: 0, message: "All companies already classified" });
  }

  const client = new Anthropic({ apiKey });
  const BATCH_SIZE = 20;
  let classified = 0;

  for (let i = 0; i < unclassified.length; i += BATCH_SIZE) {
    const batch = unclassified.slice(i, i + BATCH_SIZE);

    const input = batch.map((c) => ({
      id:       c.id,
      name:     c.name     ?? "",
      domain:   c.domain   ?? c.website ?? "",
      industry: c.industry ?? "",
    }));

    try {
      const response = await client.messages.create({
        model:      "claude-haiku-4-5",
        max_tokens: 150,
        system: `You are classifying companies as AI companies or not.
An "AI company" is one whose core product or primary business involves artificial intelligence, machine learning, LLMs, generative AI, or AI-powered software.
Companies that merely USE AI tools internally are NOT AI companies.
Respond ONLY with a valid JSON array — no markdown fences, no explanation, no trailing text.
Each element: { "id": "...", "isAiCompany": true or false, "reason": "one concise sentence" }`,
        messages: [
          {
            role:    "user",
            content: `Classify each company below. Return a JSON array with one object per company.\n\n${JSON.stringify(input)}`,
          },
        ],
      });

      const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
      // Strip any accidental markdown fences
      const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

      let results: { id: string; isAiCompany: boolean; reason: string }[];
      try {
        results = JSON.parse(clean);
      } catch {
        console.error("[classify] JSON parse failed for batch starting at", i, clean.slice(0, 200));
        continue;
      }

      await Promise.all(
        results.map((r) =>
          prisma.hubspotCompany.update({
            where: { id: r.id },
            data:  {
              isAiCompany:  r.isAiCompany,
              aiReason:     r.reason,
              classifiedAt: new Date(),
            },
          }).catch(() => null) // skip rows not found
        )
      );

      classified += results.length;
    } catch (err) {
      console.error("[classify] batch error at", i, err);
      // Continue with remaining batches
    }
  }

  return NextResponse.json({
    classified,
    total: unclassified.length,
    message: `Classified ${classified} of ${unclassified.length} companies`,
  });
}
