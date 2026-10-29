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

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const sprint = await prisma.kanbanSprint.findUnique({
    where: { id },
    include: {
      cards: {
        include: { assignee: true },
        orderBy: { position: "asc" },
      },
    },
  });

  if (!sprint) return NextResponse.json({ error: "Sprint not found" }, { status: 404 });

  const completed = sprint.cards.filter(c => c.status === "completed");
  if (completed.length === 0) {
    return NextResponse.json({ error: "No completed cards in this sprint" }, { status: 400 });
  }

  const apiKey = await resolveApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic AI is not connected. Go to Settings → Integrations to add your API key." },
      { status: 503 }
    );
  }

  const client = new Anthropic({ apiKey });

  const cardList = completed
    .map(c => `- ${c.title}${c.description ? `: ${c.description}` : ""}${c.assignee ? ` (${c.assignee.name})` : ""}`)
    .join("\n");

  const systemPrompt = `You are a marketing operations analyst generating sprint retrospective summaries for a marketing team.

You will be given a list of completed sprint tickets (title + description). Categorize each ticket into one of these marketing channels:
- SEO / AEO / GEO
- Paid Media
- PR & Communications
- Social Media
- Email Marketing
- Content & Creative
- Analytics & Reporting
- Other

Then write a cohesive sprint summary.

Respond ONLY with valid JSON in this exact schema (no markdown fences):
{
  "headline": "One punchy sentence summarising the sprint's biggest win",
  "overview": "2-3 sentence paragraph: what the team accomplished, what moved the needle, any themes",
  "categories": [
    {
      "name": "SEO / AEO / GEO",
      "items": ["ticket title 1", "ticket title 2"],
      "summary": "1-2 sentence summary of what was accomplished in this area"
    }
  ]
}

Rules:
- Only include categories that have at least one completed ticket
- "items" should be concise ticket titles (trim if long)
- Keep category summaries tight and action-oriented
- If a ticket is ambiguous, use context clues from the description`;

  const userMsg = `Sprint: ${sprint.name}${sprint.goal ? `\nGoal: ${sprint.goal}` : ""}

Completed tickets:
${cardList}

Generate the sprint summary.`;

  try {
    const message = await client.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 1200,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userMsg }],
    });

    const raw = message.content
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("\n")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    let structured: unknown;
    try {
      structured = JSON.parse(raw);
    } catch {
      structured = { headline: "Sprint complete", overview: raw, categories: [] };
    }

    return NextResponse.json(structured);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
