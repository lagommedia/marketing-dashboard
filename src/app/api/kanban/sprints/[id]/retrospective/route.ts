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

export type RetroCategory = { name: string; items: string[]; summary: string };
export type RetroContributor = { name: string; completed: string[]; highlights: string };
export type SprintRetrospective = {
  headline: string;
  overview: string;
  categories: RetroCategory[];
  contributors: RetroContributor[];
  incomplete: { title: string; status: string }[];
};

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

  const apiKey = await resolveApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic AI is not connected. Go to Settings → Integrations to add your API key." },
      { status: 503 }
    );
  }

  const completedCards = sprint.cards.filter(c => c.status === "completed");
  const incompleteCards = sprint.cards.filter(c => c.status !== "completed");

  const completedList = completedCards
    .map(c => `- [${c.assignee?.name ?? "Unassigned"}] ${c.title}${c.description ? `: ${c.description}` : ""}`)
    .join("\n") || "(none)";

  const incompleteList = incompleteCards
    .map(c => `- [${c.status.replace(/_/g, " ")}] ${c.title}${c.assignee ? ` (${c.assignee.name})` : ""}`)
    .join("\n") || "(none)";

  const client = new Anthropic({ apiKey });

  const systemPrompt = `You are a marketing operations analyst writing a sprint retrospective for a marketing team.

You will receive completed and incomplete sprint tickets. Produce a comprehensive retrospective.

**Categorize completed work into relevant marketing channels:**
- SEO / AEO / GEO
- Paid Media
- PR & Communications
- Social Media
- Email Marketing
- Content & Creative
- Analytics & Reporting
- Other

**For contributors:** summarize each person's impact — what they shipped, why it matters.

**For each completed project:** include a brief definition of what it was and its potential forward impact.

Respond ONLY with valid JSON (no markdown fences):
{
  "headline": "One punchy sentence — the sprint's biggest win",
  "overview": "2-3 sentences: what the team accomplished, what moved the needle, key themes",
  "categories": [
    {
      "name": "SEO / AEO / GEO",
      "items": ["ticket title"],
      "summary": "1-2 sentences: what was done and potential impact"
    }
  ],
  "contributors": [
    {
      "name": "Person Name",
      "completed": ["ticket title"],
      "highlights": "1-2 sentences on their contributions and impact"
    }
  ],
  "incomplete": [
    { "title": "ticket title", "status": "in progress" }
  ]
}

Rules:
- Only include categories with at least one completed ticket
- Only include contributors with at least one completed ticket
- incomplete array mirrors the input (title + readable status)
- Keep all text tight and action-oriented
- Potential impact should be specific and forward-looking`;

  const userMsg = `Sprint: ${sprint.name}${sprint.goal ? `\nGoal: ${sprint.goal}` : ""}

COMPLETED tickets (assignee shown in brackets):
${completedList}

INCOMPLETE tickets (status shown in brackets):
${incompleteList}

Generate the sprint retrospective.`;

  try {
    const message = await client.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 2000,
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

    let structured: SprintRetrospective;
    try {
      structured = JSON.parse(raw) as SprintRetrospective;
    } catch {
      structured = {
        headline: "Sprint complete",
        overview: raw,
        categories: [],
        contributors: [],
        incomplete: incompleteCards.map(c => ({ title: c.title, status: c.status.replace(/_/g, " ") })),
      };
    }

    // Save retrospective to the sprint record
    await prisma.kanbanSprint.update({
      where: { id },
      data: { retrospective: structured as object },
    });

    return NextResponse.json(structured);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
