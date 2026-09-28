/**
 * GET /api/seo/hs-aeo
 *
 * Fetches AEO data from HubSpot's public beta AEO API.
 * Returns brand visibility summary, weekly time-series by AI model,
 * competitor citation tracking, prompt list, and recommendations.
 *
 * HubSpot API (beta): /marketing/aeo/2027-03-beta
 * Required scope: marketing.aeo.read
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const AEO_BASE = "https://api.hubapi.com/marketing/aeo/2027-03-beta";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface HsPrompt {
  id: string;
  prompt: string;
  language: string;
  buyingJourneyPhase: string;
  aiAssistants: string[];
  businessUnitId: string;
  createdAt: string;
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

interface HsRunDetail extends HsRun {
  responseText?: string;
  citations?: { url: string; title: string }[];
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

// Fetch all recent runs for a prompt (up to 20 for time-series coverage)
async function fetchRunsForPrompt(token: string, promptId: string): Promise<HsRun[]> {
  try {
    const data = await hsGet<{ results: HsRun[] }>(token, `/prompts/${promptId}/runs?limit=20`);
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

function isoWeek(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(d);
  monday.setUTCDate(diff);
  return monday.toISOString().slice(0, 10);
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

    // Fetch runs for each prompt in batches of 5
    const BATCH = 5;
    const allRuns: HsRun[] = [];
    const promptRunMap: Record<string, HsRun[]> = {};

    for (let i = 0; i < prompts.length; i += BATCH) {
      const batch = prompts.slice(i, i + BATCH);
      const batchRuns = await Promise.all(
        batch.map(p => fetchRunsForPrompt(token, p.id))
      );
      batch.forEach((p, idx) => {
        promptRunMap[p.id] = batchRuns[idx];
        allRuns.push(...batchRuns[idx]);
      });
      if (i + BATCH < prompts.length) await sleep(120);
    }

    // ── Per-prompt summary ───────────────────────────────────────────────────
    const promptSummaries = prompts.map(p => {
      const runs = promptRunMap[p.id] ?? [];
      // Latest run per model
      const byModel: Record<string, HsRun> = {};
      for (const run of runs) {
        if (!byModel[run.aiModel] || run.completedAt > byModel[run.aiModel].completedAt) {
          byModel[run.aiModel] = run;
        }
      }
      let ownedMentions = 0, competitorMentions = 0, totalCitations = 0;
      const modelSummary: Record<string, { ownedMentions: number; competitorMentions: number; totalCitations: number; completedAt: string }> = {};
      for (const [model, run] of Object.entries(byModel)) {
        modelSummary[model] = {
          ownedMentions:    run.ownedMentions,
          competitorMentions: run.competitorMentions,
          totalCitations:   run.totalCitations,
          completedAt:      run.completedAt,
        };
        ownedMentions    += run.ownedMentions;
        competitorMentions += run.competitorMentions;
        totalCitations   += run.totalCitations;
      }
      return {
        id:                 p.id,
        prompt:             p.prompt,
        buyingJourneyPhase: p.buyingJourneyPhase,
        language:           p.language,
        byModel:            modelSummary,
        ownedMentions,
        competitorMentions,
        totalCitations,
        visibility:         ownedMentions > 0,
      };
    });

    // ── Overall summary ──────────────────────────────────────────────────────
    const promptsWithData = promptSummaries.filter(p => Object.keys(p.byModel).length > 0);
    const promptsWithMention = promptSummaries.filter(p => p.visibility).length;
    const visibilityRate = promptsWithData.length > 0
      ? Math.round((promptsWithMention / promptsWithData.length) * 100)
      : null;
    const totalOwned      = promptSummaries.reduce((s, p) => s + p.ownedMentions, 0);
    const totalCompetitor = promptSummaries.reduce((s, p) => s + p.competitorMentions, 0);
    const totalCitations  = promptSummaries.reduce((s, p) => s + p.totalCitations, 0);

    // ── By AI Model (current snapshot) ──────────────────────────────────────
    const byModel: Record<string, { total: number; withMention: number; visibilityRate: number }> = {};
    for (const p of promptSummaries) {
      for (const [model, data] of Object.entries(p.byModel)) {
        if (!byModel[model]) byModel[model] = { total: 0, withMention: 0, visibilityRate: 0 };
        byModel[model].total++;
        if (data.ownedMentions > 0) byModel[model].withMention++;
      }
    }
    for (const m of Object.values(byModel)) {
      m.visibilityRate = m.total > 0 ? Math.round((m.withMention / m.total) * 100) : 0;
    }

    // ── Weekly time-series by AI model ──────────────────────────────────────
    // Structure: { week: { model: { total, withMention } } }
    const weekModelMap: Record<string, Record<string, { total: number; withMention: number }>> = {};
    for (const run of allRuns) {
      const week = isoWeek(run.completedAt);
      if (!weekModelMap[week]) weekModelMap[week] = {};
      if (!weekModelMap[week][run.aiModel]) weekModelMap[week][run.aiModel] = { total: 0, withMention: 0 };
      weekModelMap[week][run.aiModel].total++;
      if (run.ownedMentions > 0) weekModelMap[week][run.aiModel].withMention++;
    }

    const allModels = [...new Set(allRuns.map(r => r.aiModel))].sort();
    const weeklySeries = Object.entries(weekModelMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-8) // last 8 weeks
      .map(([week, modelData]) => {
        const entry: Record<string, number | string> = { week };
        for (const model of allModels) {
          const d = modelData[model];
          entry[model] = d ? Math.round((d.withMention / d.total) * 100) : 0;
        }
        return entry;
      });

    // ── Competitor citation share ────────────────────────────────────────────
    // We can derive competitor share of voice from competitorMentions per prompt.
    // HubSpot AEO beta doesn't expose named competitor breakdown via this API,
    // so we compute overall totals and flag which prompts have competitor citations.
    const byPhase: Record<string, { total: number; withMention: number }> = {};
    for (const p of promptSummaries) {
      const phase = p.buyingJourneyPhase ?? "UNKNOWN";
      if (!byPhase[phase]) byPhase[phase] = { total: 0, withMention: 0 };
      if (Object.keys(p.byModel).length > 0) {
        byPhase[phase].total++;
        if (p.visibility) byPhase[phase].withMention++;
      }
    }

    return NextResponse.json({
      hasData: promptsWithData.length > 0,
      summary: {
        totalPrompts:      prompts.length,
        promptsWithData:   promptsWithData.length,
        promptsWithMention,
        visibilityRate,
        totalCitations,
        ownedCitations:    totalOwned,
        competitorCitations: totalCompetitor,
      },
      byModel,
      byPhase,
      weeklySeries,
      allModels,
      prompts: promptSummaries,
      recommendations: recommendations.slice(0, 10).map(r => ({
        id:                    r.id,
        priority:              r.priority,
        status:                r.status,
        actionCategory:        r.actionCategory,
        contentTopic:          r.contentTopic,
        recommendationSummary: r.recommendationSummary,
        domain:                r.domain ?? null,
        url:                   r.url ?? null,
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
