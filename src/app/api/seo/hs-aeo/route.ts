/**
 * GET /api/seo/hs-aeo
 *
 * Fetches AEO data from HubSpot's public beta AEO API:
 * - Tracked prompts with latest run data (visibility, citations, mentions)
 * - Content recommendations
 * - Aggregated brand visibility summary
 *
 * HubSpot API (beta): /marketing/aeo/2027-03-beta
 * Required scope: marketing.aeo.read
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const HS_BASE = "https://api.hubapi.com";
const AEO_BASE = `${HS_BASE}/marketing/aeo/2027-03-beta`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface HsPrompt {
  id: string;
  prompt: string;
  language: string;
  buyingJourneyPhase: string;
  aiAssistants: string[];
  businessUnitId: string;
  productIds?: string[];
  icpIds?: string[];
  createdAt: string;
  visibility?: Record<string, unknown>;
}

interface HsRun {
  id: string;
  promptId: string;
  state: string;
  aiModel: string;
  completedAt: string;
  totalCitations: number;
  ownedMentions: number;
  competitorMentions: number;
  createdAt: string;
}

interface HsRecommendation {
  id: string;
  promptIds: string[];
  recommendationType: string;
  actionCategory: string;
  actionChannel: string;
  contentType: string;
  contentTopic: string;
  domain?: string;
  url?: string;
  recommendationSummary: string;
  priority: string;
  status: string;
  startDate: string;
  endDate: string;
}

async function hsGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${AEO_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot AEO ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

async function fetchAllPrompts(token: string): Promise<HsPrompt[]> {
  const all: HsPrompt[] = [];
  let after: string | undefined;
  do {
    const url = `/prompts?limit=100${after ? `&after=${after}` : ""}`;
    const data = await hsGet<{ results: HsPrompt[]; paging?: { next?: { after: string } } }>(token, url);
    all.push(...(data.results ?? []));
    after = data.paging?.next?.after;
    if (after) await sleep(100);
  } while (after && all.length < 500);
  return all;
}

async function fetchLatestRunsForPrompt(token: string, promptId: string): Promise<HsRun[]> {
  try {
    const data = await hsGet<{ results: HsRun[] }>(token, `/prompts/${promptId}/runs?limit=10`);
    return (data.results ?? []).filter(r => r.state === "COMPLETED");
  } catch {
    return [];
  }
}

async function fetchRecommendations(token: string): Promise<HsRecommendation[]> {
  try {
    const data = await hsGet<{ results: HsRecommendation[] }>(token, "/recommendations?limit=20");
    return data.results ?? [];
  } catch {
    return [];
  }
}

export async function GET() {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return NextResponse.json({ error: "HubSpot not connected", hasData: false }, { status: 503 });
  }
  const token = decrypt(row.accessToken);

  try {
    const [prompts, recommendations] = await Promise.all([
      fetchAllPrompts(token),
      fetchRecommendations(token),
    ]);

    // Fetch latest runs for each prompt in batches of 5
    const BATCH = 5;
    const promptsWithRuns: Array<{
      id: string;
      prompt: string;
      buyingJourneyPhase: string;
      language: string;
      aiAssistants: string[];
      createdAt: string;
      latestRuns: HsRun[];
    }> = [];

    for (let i = 0; i < prompts.length; i += BATCH) {
      const batch = prompts.slice(i, i + BATCH);
      const batchRuns = await Promise.all(
        batch.map(p => fetchLatestRunsForPrompt(token, p.id))
      );
      batch.forEach((p, idx) => {
        promptsWithRuns.push({
          id: p.id,
          prompt: p.prompt,
          buyingJourneyPhase: p.buyingJourneyPhase,
          language: p.language,
          aiAssistants: p.aiAssistants ?? [],
          createdAt: p.createdAt,
          latestRuns: batchRuns[idx],
        });
      });
      if (i + BATCH < prompts.length) await sleep(120);
    }

    // Aggregate: for each prompt, take the most recent run per AI model
    type PromptSummary = {
      id: string;
      prompt: string;
      buyingJourneyPhase: string;
      language: string;
      byModel: Record<string, { ownedMentions: number; competitorMentions: number; totalCitations: number; completedAt: string }>;
      ownedMentions: number;
      competitorMentions: number;
      totalCitations: number;
      visibility: boolean; // any model mentioned us
    };

    const promptSummaries: PromptSummary[] = promptsWithRuns.map(p => {
      // Most recent run per model
      const byModel: Record<string, HsRun> = {};
      for (const run of p.latestRuns) {
        if (!byModel[run.aiModel] || run.completedAt > byModel[run.aiModel].completedAt) {
          byModel[run.aiModel] = run;
        }
      }

      const modelSummary: PromptSummary["byModel"] = {};
      let totalOwned = 0, totalCompetitor = 0, totalCitations = 0;
      for (const [model, run] of Object.entries(byModel)) {
        modelSummary[model] = {
          ownedMentions: run.ownedMentions,
          competitorMentions: run.competitorMentions,
          totalCitations: run.totalCitations,
          completedAt: run.completedAt,
        };
        totalOwned += run.ownedMentions;
        totalCompetitor += run.competitorMentions;
        totalCitations += run.totalCitations;
      }

      return {
        id: p.id,
        prompt: p.prompt,
        buyingJourneyPhase: p.buyingJourneyPhase,
        language: p.language,
        byModel: modelSummary,
        ownedMentions: totalOwned,
        competitorMentions: totalCompetitor,
        totalCitations: totalCitations,
        visibility: totalOwned > 0,
      };
    });

    // Overall summary
    const totalPrompts = promptSummaries.length;
    const promptsWithData = promptSummaries.filter(p => Object.keys(p.byModel).length > 0);
    const promptsWithMention = promptSummaries.filter(p => p.visibility).length;
    const visibilityRate = promptsWithData.length > 0
      ? Math.round((promptsWithMention / promptsWithData.length) * 100)
      : null;

    const totalOwned = promptSummaries.reduce((s, p) => s + p.ownedMentions, 0);
    const totalCompetitor = promptSummaries.reduce((s, p) => s + p.competitorMentions, 0);
    const totalCitations = promptSummaries.reduce((s, p) => s + p.totalCitations, 0);

    // By buying journey phase
    const byPhase: Record<string, { total: number; withMention: number }> = {};
    for (const p of promptSummaries) {
      const phase = p.buyingJourneyPhase ?? "UNKNOWN";
      if (!byPhase[phase]) byPhase[phase] = { total: 0, withMention: 0 };
      if (Object.keys(p.byModel).length > 0) {
        byPhase[phase].total++;
        if (p.visibility) byPhase[phase].withMention++;
      }
    }

    // By AI model
    const byModel: Record<string, { total: number; withMention: number; ownedCitations: number }> = {};
    for (const p of promptSummaries) {
      for (const [model, data] of Object.entries(p.byModel)) {
        if (!byModel[model]) byModel[model] = { total: 0, withMention: 0, ownedCitations: 0 };
        byModel[model].total++;
        if (data.ownedMentions > 0) byModel[model].withMention++;
        byModel[model].ownedCitations += data.ownedMentions;
      }
    }

    return NextResponse.json({
      hasData: promptsWithData.length > 0,
      summary: {
        totalPrompts,
        promptsWithData: promptsWithData.length,
        promptsWithMention,
        visibilityRate,
        totalCitations,
        ownedCitations: totalOwned,
        competitorCitations: totalCompetitor,
      },
      byPhase,
      byModel,
      prompts: promptSummaries,
      recommendations: recommendations.slice(0, 10).map(r => ({
        id: r.id,
        priority: r.priority,
        status: r.status,
        actionCategory: r.actionCategory,
        contentTopic: r.contentTopic,
        recommendationSummary: r.recommendationSummary,
        domain: r.domain ?? null,
        url: r.url ?? null,
      })),
    });
  } catch (err) {
    console.error("[hs-aeo]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error", hasData: false },
      { status: 500 }
    );
  }
}
