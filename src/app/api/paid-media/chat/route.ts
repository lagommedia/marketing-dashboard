import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Server-side DB enrichment — pulls full datasets regardless of what the
// frontend currently has on screen.
// ---------------------------------------------------------------------------

async function fetchEnrichedContext() {
  const now   = new Date();
  const d90   = new Date(now); d90.setDate(d90.getDate() - 90);
  const d365  = new Date(now); d365.setDate(d365.getDate() - 365);
  const d60   = new Date(now); d60.setDate(d60.getDate() - 60);

  // Current quarter label, e.g. "Q3 2026"
  const quarter = `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`;
  const prevQ   = (() => {
    const q = Math.ceil((now.getMonth() + 1) / 3);
    return q === 1 ? `Q4 ${now.getFullYear() - 1}` : `Q${q - 1} ${now.getFullYear()}`;
  })();

  const [
    campaignDaily,
    metricSnaps,
    pacingTargets,
    changeEvents,
    pipelineSnaps,
  ] = await Promise.all([
    // 90 days of daily spend per campaign
    prisma.campaignDailySpend.findMany({
      where: { date: { gte: d90 } },
      orderBy: { date: "asc" },
      select: {
        campaignId: true, campaignName: true, date: true,
        spend: true, clicks: true, impressions: true,
        conversions: true, conversionValue: true,
        ctr: true, cpc: true,
        searchImprShare: true, searchTopIS: true, searchAbsTopIS: true,
        searchLostISRank: true, searchLostISBudget: true,
        invalidClicks: true,
      },
    }),
    // 12 months of paid_media MetricSnapshot (leads → pipeline)
    prisma.metricSnapshot.findMany({
      where: {
        date:    { gte: d365 },
        channel: "paid_media",
        OR: [
          { platform: "hubspot" },
          { platform: "google_ads" },
          { platform: "manual" },
        ],
      },
      orderBy: { date: "asc" },
      select: {
        date: true, platform: true, channel: true,
        impressions: true, clicks: true, spend: true,
        leads: true, mqls: true, sqos: true, closedWon: true,
        pipeline: true, activePipeline: true, revenue: true,
        cpc: true, cpl: true, cpMql: true, cpSqo: true,
        ctr: true, leadToMql: true, mqlToSqo: true, sqoToClose: true,
      },
    }),
    // Pacing targets for current quarter and channel
    prisma.pacingTarget.findMany({
      where: { period: { in: [quarter, prevQ] }, channel: "paid_media" },
    }),
    // Recent campaign change events (last 60 days, human-initiated only)
    prisma.campaignChangeEvent.findMany({
      where: { changedAt: { gte: d60 }, userEmail: { not: "" } },
      orderBy: { changedAt: "desc" },
      take: 30,
      select: {
        changedAt: true, changeResourceType: true, operation: true,
        campaignName: true, description: true, expectedOutcome: true,
      },
    }),
    // Pipeline by quarter and segment (last 4 quarters)
    prisma.pipelineQuarterSnapshot.findMany({
      orderBy: { quarter: "desc" },
      take: 20,
      select: {
        quarter: true, segment: true,
        amountAll: true, amountPaid: true,
        amountOrganic: true, amountReferral: true,
      },
    }),
  ]);

  return { campaignDaily, metricSnaps, pacingTargets, changeEvents, pipelineSnaps, quarter, prevQ };
}

function formatEnrichedContext(ctx: Awaited<ReturnType<typeof fetchEnrichedContext>>): string {
  const { campaignDaily, metricSnaps, pacingTargets, changeEvents, pipelineSnaps, quarter, prevQ } = ctx;

  const fmt$ = (v: number | null | undefined) =>
    v == null ? "—" : `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const fmtN  = (v: number | null | undefined, d = 0) => v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: d });
  const fmtPct = (v: number | null | undefined) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;

  // ── Campaign daily: aggregate per campaign per week for readability ────────
  const campaignWeekly: Record<string, Record<string, {
    spend: number; clicks: number; impressions: number;
    conversions: number; conversionValue: number;
    searchImprShare: number | null; searchLostISRank: number | null; searchLostISBudget: number | null;
    days: number;
  }>> = {};

  for (const row of campaignDaily) {
    const name = row.campaignName ?? row.campaignId;
    const weekStart = new Date(row.date);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const wk = weekStart.toISOString().slice(0, 10);
    if (!campaignWeekly[name]) campaignWeekly[name] = {};
    const e = campaignWeekly[name][wk] ?? {
      spend: 0, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0,
      searchImprShare: null, searchLostISRank: null, searchLostISBudget: null, days: 0,
    };
    e.spend          += row.spend;
    e.clicks         += row.clicks;
    e.impressions    += row.impressions;
    e.conversions    += row.conversions;
    e.conversionValue += row.conversionValue;
    if (row.searchImprShare   != null) e.searchImprShare   = ((e.searchImprShare   ?? 0) * e.days + row.searchImprShare)   / (e.days + 1);
    if (row.searchLostISRank  != null) e.searchLostISRank  = ((e.searchLostISRank  ?? 0) * e.days + row.searchLostISRank)  / (e.days + 1);
    if (row.searchLostISBudget != null) e.searchLostISBudget = ((e.searchLostISBudget ?? 0) * e.days + row.searchLostISBudget) / (e.days + 1);
    e.days++;
    campaignWeekly[name][wk] = e;
  }

  let campText = "\n## Google Ads — Weekly Campaign Performance (last 90 days, oldest first)\n";
  for (const [name, weeks] of Object.entries(campaignWeekly)) {
    campText += `\n### ${name}\n`;
    campText += "Week | Spend | Impressions | Clicks | Conv | Conv Value | Search IS | Lost IS (Rank) | Lost IS (Budget)\n";
    for (const [wk, d] of Object.entries(weeks).sort(([a], [b]) => a.localeCompare(b))) {
      campText += `${wk} | ${fmt$(d.spend)} | ${fmtN(d.impressions)} | ${fmtN(d.clicks)} | ${fmtN(d.conversions, 1)} | ${fmt$(d.conversionValue)} | ${fmtPct(d.searchImprShare)} | ${fmtPct(d.searchLostISRank)} | ${fmtPct(d.searchLostISBudget)}\n`;
    }
  }

  // ── MetricSnapshot: monthly roll-up for paid_media ────────────────────────
  const monthlyMetrics: Record<string, {
    spend: number; leads: number; mqls: number; sqos: number; closedWon: number;
    pipeline: number; revenue: number; days: number;
  }> = {};
  for (const row of metricSnaps) {
    const mo = row.date.toISOString().slice(0, 7);
    const e = monthlyMetrics[mo] ?? { spend: 0, leads: 0, mqls: 0, sqos: 0, closedWon: 0, pipeline: 0, revenue: 0, days: 0 };
    e.spend    += row.spend    ?? 0;
    e.leads    += row.leads    ?? 0;
    e.mqls     += row.mqls     ?? 0;
    e.sqos     += row.sqos     ?? 0;
    e.closedWon += row.closedWon ?? 0;
    e.pipeline  += row.pipeline  ?? 0;
    e.revenue   += row.revenue   ?? 0;
    e.days++;
    monthlyMetrics[mo] = e;
  }
  let metricText = "\n## Paid Media Funnel — Monthly Attribution (last 12 months, oldest first)\n";
  metricText += "Month | Spend | Leads | MQLs | SQOs | Closed Won | Pipeline | Revenue | CPL | CPMql | CPSqo\n";
  for (const [mo, d] of Object.entries(monthlyMetrics).sort(([a], [b]) => a.localeCompare(b))) {
    const cpl  = d.leads    > 0 ? d.spend / d.leads    : null;
    const cpMql = d.mqls    > 0 ? d.spend / d.mqls     : null;
    const cpSqo = d.sqos    > 0 ? d.spend / d.sqos     : null;
    metricText += `${mo} | ${fmt$(d.spend)} | ${fmtN(d.leads, 0)} | ${fmtN(d.mqls, 0)} | ${fmtN(d.sqos, 0)} | ${fmtN(d.closedWon, 0)} | ${fmt$(d.pipeline)} | ${fmt$(d.revenue)} | ${fmt$(cpl)} | ${fmt$(cpMql)} | ${fmt$(cpSqo)}\n`;
  }

  // ── Pacing targets ────────────────────────────────────────────────────────
  let pacingText = "";
  if (pacingTargets.length > 0) {
    pacingText = "\n## Pacing Targets (paid_media channel)\n";
    for (const t of pacingTargets) {
      pacingText += `**${t.period}**: MQLs ${t.targetMqls ?? "—"} | SQOs ${t.targetSqos ?? "—"} | Pipeline ${fmt$(t.targetPipeline ?? undefined)} | Closed Won ${t.targetClosedWon ?? "—"} | Spend ${fmt$(t.targetSpend ?? undefined)}\n`;
    }
  }

  // ── Change events ─────────────────────────────────────────────────────────
  let changeText = "";
  if (changeEvents.length > 0) {
    changeText = "\n## Recent Google Ads Changes (last 60 days, most recent first)\n";
    for (const e of changeEvents) {
      const d = new Date(e.changedAt).toISOString().slice(0, 10);
      changeText += `- **${d}** [${e.changeResourceType}/${e.operation}] ${e.campaignName ?? ""}: ${e.description ?? "no description"}${e.expectedOutcome ? ` → Expected: ${e.expectedOutcome}` : ""}\n`;
    }
  }

  // ── Pipeline by segment ───────────────────────────────────────────────────
  const quarters = [...new Set(pipelineSnaps.map(p => p.quarter))].sort().slice(-4);
  let pipelineText = "";
  if (pipelineSnaps.length > 0) {
    pipelineText = "\n## Pipeline by Quarter & Segment (paid media attribution)\n";
    pipelineText += `Segment | ${quarters.join(" | ")}\n`;
    const segments = [...new Set(pipelineSnaps.map(p => p.segment))].sort();
    for (const seg of segments) {
      const row = quarters.map(q => {
        const snap = pipelineSnaps.find(p => p.quarter === q && p.segment === seg);
        return snap ? fmt$(snap.amountPaid) : "—";
      });
      pipelineText += `${seg} | ${row.join(" | ")}\n`;
    }
  }

  return `${campText}${metricText}${pacingText}${changeText}${pipelineText}`;
}

async function resolveApiKey(): Promise<string | null> {
  try {
    const row = await prisma.integration.findUnique({ where: { platform: "anthropic" } });
    if (row?.connected && row.accessToken) return decrypt(row.accessToken);
  } catch { /* fall through */ }
  return process.env.ANTHROPIC_API_KEY ?? null;
}

function formatTableForPrompt(tableData: Record<string, unknown>): string {
  const rows = tableData.rows as Array<Record<string, unknown>> | undefined;
  const avg12 = tableData.avg12 as Record<string, unknown> | undefined;
  const view = tableData.view as string | undefined;

  if (!rows?.length) return "No rolling average data available.";

  function fmtVal(key: string, v: unknown): string {
    if (v == null) return "—";
    if (typeof v !== "number") return String(v);
    if (key === "spend" || key === "conversionValue" || key === "costPerConversion") return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    if (key === "cpc")   return `$${v.toFixed(2)}`;
    if (key === "roas")  return `${v.toFixed(2)}×`;
    if (["ctr","searchImprShare","searchTopIS","searchAbsTopIS","searchLostISRank","searchLostISBudget"].includes(key))
      return `${(v * 100).toFixed(1)}%`;
    return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  }

  const cols = ["impressions","clicks","ctr","spend","cpc","conversions","conversionValue","roas","costPerConversion","invalidClicks","searchImprShare","searchTopIS","searchAbsTopIS","searchLostISRank","searchLostISBudget"];
  const header = `Period | ${cols.join(" | ")}`;
  const rowLines = (rows ?? []).map(r =>
    `${r.label} | ${cols.map(c => fmtVal(c, r[c])).join(" | ")}`
  );
  const avgLine = avg12 ? `12-period avg | ${cols.map(c => fmtVal(c, avg12[c])).join(" | ")}` : "";

  return `View: ${view ?? "unknown"}\n\n${header}\n${rowLines.join("\n")}${avgLine ? "\n" + avgLine : ""}`;
}

export async function POST(req: NextRequest) {
  const [apiKey, enriched] = await Promise.all([
    resolveApiKey(),
    fetchEnrichedContext(),
  ]);

  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic AI is not connected. Add your API key under Integrations." },
      { status: 503 }
    );
  }

  const enrichedContextText = formatEnrichedContext(enriched);

  interface Attachment {
    name:     string;
    mimeType: string;
    data?:    string;
    text?:    string;
  }

  let question: string,
      tableData: Record<string, unknown>,
      funnelData: Record<string, unknown> | null,
      summaryData: Record<string, unknown> | null,
      campaigns: unknown[] | null,
      campaignRolling: unknown[] | null,
      rollingView: string,
      messages: Array<{ role: string; content: string }>,
      attachments: Attachment[];
  try {
    const body      = await req.json();
    question        = body.question        ?? "";
    tableData       = body.tableData       ?? {};
    funnelData      = body.funnelData      ?? null;
    summaryData     = body.summaryData     ?? null;
    campaigns       = body.campaigns       ?? null;
    campaignRolling = body.campaignRolling ?? null;
    rollingView     = body.rollingView     ?? "weekly";
    messages        = body.messages        ?? [];
    // Accept both new `attachments[]` and legacy single `attachment`
    attachments     = Array.isArray(body.attachments) ? body.attachments
                    : body.attachment ? [body.attachment]
                    : [];
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!question.trim()) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const tableText = formatTableForPrompt(tableData);

  const summaryText = summaryData ? `
## Campaign Summary (all campaigns, combined)
- Spend: $${(summaryData.spend as number ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}
- Impressions: ${(summaryData.impressions as number ?? 0).toLocaleString()}
- Clicks: ${(summaryData.clicks as number ?? 0).toLocaleString()}
- CTR: ${((summaryData.ctr as number ?? 0) * 100).toFixed(2)}%
- Avg CPC: $${(summaryData.cpc as number ?? 0).toFixed(2)}
- Conversions: ${(summaryData.conversions as number ?? 0).toFixed(1)}
- ROAS: ${summaryData.roas ? `${(summaryData.roas as number).toFixed(2)}×` : "N/A (conversion tracking not set up)"}
` : "";

  // Per-campaign 30/90d breakdown
  type CampaignBreak = { campaignName: string; spend?: number; impressions?: number; clicks?: number; ctr?: number | null; cpc?: number | null; conversions?: number; roas?: number | null };
  const campaignBreakdownText = campaigns && (campaigns as CampaignBreak[]).length > 0 ? `
## Per-Campaign Breakdown (last 30/90 days)
${(campaigns as CampaignBreak[]).map(c => `**${c.campaignName}**: Spend $${(c.spend ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}, Impressions ${(c.impressions ?? 0).toLocaleString()}, Clicks ${(c.clicks ?? 0).toLocaleString()}, CTR ${c.ctr != null ? (c.ctr * 100).toFixed(2) : "—"}%, CPC ${c.cpc != null ? "$" + c.cpc.toFixed(2) : "—"}, Conv ${(c.conversions ?? 0).toFixed(1)}, ROAS ${c.roas != null && c.roas > 0 ? c.roas.toFixed(2) + "×" : "N/A"}`).join("\n")}
` : "";

  // Per-campaign rolling data
  type CampaignRollingEntry = { campaignName: string; campaignId: string; rows: unknown[] };
  const campaignRollingText = campaignRolling && (campaignRolling as CampaignRollingEntry[]).length > 0 ? `
## Per-Campaign Rolling Data (${rollingView} view, newest first)
${JSON.stringify(campaignRolling, null, 2)}
` : "";

  const cur = funnelData?.current as Record<string, unknown> | undefined;
  const funnelText = cur ? `
## HubSpot Funnel Attribution (QTD)
- Leads: ${cur.leads ?? "—"}
- MQLs: ${cur.mqls ?? "—"} (${cur.leadToMql != null ? `${((cur.leadToMql as number) * 100).toFixed(1)}% lead→MQL` : "—"})
- SQOs: ${cur.sqos ?? "—"} (${cur.mqlToSqo != null ? `${((cur.mqlToSqo as number) * 100).toFixed(1)}% MQL→SQO` : "—"})
- Closed Won: ${cur.closedWon ?? "—"} (${cur.sqoToClose != null ? `${((cur.sqoToClose as number) * 100).toFixed(1)}% SQO→close` : "—"})
` : "";

  // Extract raw row data for chart generation
  const rows = (tableData.rows ?? []) as Array<Record<string, unknown>>;
  const chartRows = rows.slice(0, 12).map(r => ({
    period: String(r.label ?? r.startDate ?? ""),
    spend:  typeof r.spend === "number" ? Math.round(r.spend) : 0,
    clicks: typeof r.clicks === "number" ? Math.round(r.clicks) : 0,
    impressions: typeof r.impressions === "number" ? Math.round(r.impressions) : 0,
    ctr:    typeof r.ctr === "number" ? parseFloat((r.ctr * 100).toFixed(2)) : null,
    cpc:    typeof r.cpc === "number" ? parseFloat(r.cpc.toFixed(2)) : null,
    conversions: typeof r.conversions === "number" ? parseFloat(r.conversions.toFixed(1)) : null,
    roas:   typeof r.roas === "number" ? parseFloat(r.roas.toFixed(2)) : null,
    searchImprShare: typeof r.searchImprShare === "number" ? parseFloat((r.searchImprShare * 100).toFixed(1)) : null,
    searchLostISRank: typeof r.searchLostISRank === "number" ? parseFloat((r.searchLostISRank * 100).toFixed(1)) : null,
    searchLostISBudget: typeof r.searchLostISBudget === "number" ? parseFloat((r.searchLostISBudget * 100).toFixed(1)) : null,
  }));

  // Determine if the most recent data period is within the 48-hour conversion lag window.
  // Rows are newest-first; each row has a startDate (ISO string). For weekly view the period
  // ends 7 days after startDate; for daily it ends 1 day after.
  const nowMs = Date.now();
  const periodDays = rollingView === "daily" ? 1 : 7;
  const mostRecentRow = rows[0] as Record<string, unknown> | undefined;
  const mostRecentStartDate = mostRecentRow?.startDate as string | undefined;
  let conversionDataIncomplete = false;
  let mostRecentPeriodLabel = "";
  if (mostRecentStartDate) {
    const periodEnd = new Date(mostRecentStartDate);
    periodEnd.setDate(periodEnd.getDate() + periodDays);
    const hoursElapsed = (nowMs - periodEnd.getTime()) / (1000 * 60 * 60);
    conversionDataIncomplete = hoursElapsed < 48;
    mostRecentPeriodLabel = mostRecentRow?.label as string ?? mostRecentStartDate;
  }

  const today = new Date().toISOString().slice(0, 10);

  const conversionLagWarning = conversionDataIncomplete
    ? `\n## ⚠️ CONVERSION DATA INCOMPLETE\nThe most recent period ("${mostRecentPeriodLabel}") ended less than 48 hours ago. Google Ads reports conversions with a 48h+ delay, and pipeline/Closed Won deal data has an average 14-day lag. For this period:\n- Lead your analysis with TOP-OF-FUNNEL metrics only: impressions, clicks, CTR, CPC\n- Explicitly state that conversion/pipeline data is not yet complete and should not be used to draw conclusions\n- Do NOT give alarming verdicts based on conversion drops — they are artefacts of the reporting lag, not real performance changes\n- Frame bottom-funnel metrics as "preliminary — expect this to update significantly over the next 48h–14 days"\n`
    : "";

  const systemPrompt = `You are a Paid Media AI analyst for a B2B SaaS company. You have full visibility into the complete Google Ads and HubSpot database — not just what is currently on screen. The three active campaigns are: Performance Max (PMax, no IS metrics), S_Non-Brand (Search), and S_Brand (Search). Today's date is ${today}. Current quarter: ${enriched.quarter}.

## DATA SOURCES AVAILABLE TO YOU
You have access to: (1) 90 days of daily Google Ads spend data per campaign from the database, (2) 12 months of paid media funnel attribution (leads → MQLs → SQOs → Closed Won → Pipeline) from the database, (3) current quarter pacing targets, (4) recent Google Ads change events (what was changed and when), (5) pipeline by quarter and customer segment, and (6) the current rolling view from the dashboard page.
${summaryText}${campaignBreakdownText}
## Dashboard Rolling Averages (all campaigns combined, ${rollingView} view — most recent period first)
${tableText}
${campaignRollingText}${funnelText}${conversionLagWarning}
## ── FULL DATABASE CONTEXT ─────────────────────────────────────────────────
${enrichedContextText}
## Underlying row data for chart generation (newest first, raw numbers)
${JSON.stringify(chartRows.slice(0, 8), null, 2)}

## Analysis Rules
- IS metrics represent capture % of available impressions (e.g. 0.75 = 75%)
- Lost IS (Rank) = lost due to poor Ad Rank/QS — fix bids/QS first, never just increase budget
- Lost IS (Budget) = budget ran out — can increase budget or reduce bids
- IS metrics only exist for Search campaigns — Performance Max always shows null/—
- For PMax: focus on Conversions, ROAS, Cost/Conv. For Search: IS metrics are the primary diagnostic
- Never recommend increasing budget if Lost IS (Rank) > 50%
- Always compare current vs prior periods and vs 12-period average
- Use **bold** for all key numbers
- PERFORMANCE MAX ANOMALIES: Never flag PMax week-to-week variance as an anomaly or cause for alarm. Google controls PMax auction/placement decisions — its volatility is expected and normal. Exclude PMax data entirely from any anomaly detection or alarming language. Only assess PMax on longer-term trends (4+ period average), not single-period swings.
- CONVERSION LAG: Google Ads conversion data has a 48h+ reporting delay. Pipeline and Closed Won data has a 14-day average lag from ad click to deal close. Always factor this in when assessing recent periods.
- DEAL CLOSE LAG: Never flag low Closed Won counts for any period ending within the last 14 days — the pipeline has not had time to mature.

## Response Format
Respond ONLY with a valid JSON object, no other text before or after. Schema:
{
  "answer": "2-4 paragraph analysis with **bold** numbers, bullet points using - prefix",
  "charts": [
    {
      "title": "descriptive chart title",
      "type": "bar|line|area",
      "xKey": "period",
      "unit": "$|%|×|",
      "series": [
        { "key": "fieldname", "label": "Display Label", "color": "#6366f1" }
      ],
      "data": [{ "period": "label", "fieldname": number }, ...]
    }
  ],
  "suggestions": ["follow-up question 1", "follow-up question 2", "follow-up question 3"]
}

Chart rules:
- Include 1-2 charts ONLY when they genuinely illustrate your point (trends, comparisons, forecasts)
- For forecasts: extrapolate from real data, show "Projected" as a separate series using a dashed style (set "dashed": true on that series)
- Use real data from the rows above — never fabricate numbers
- Reverse the data array so it goes oldest→newest (chronological order) for trend charts
- Omit "charts" key entirely if no chart adds value
- suggestions: always include 3 relevant follow-up questions`;

  const chatHistory = messages.map((m: { role: string; content: string }) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // Build the last user message — inject all attachment content blocks
  type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } }
    | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

  let lastUserContent: string | ContentBlock[] = question;
  if (attachments.length > 0) {
    const blocks: ContentBlock[] = [];
    for (const att of attachments) {
      if (att.text) {
        blocks.push({ type: "text", text: `[Attached file: ${att.name}]\n\`\`\`\n${att.text}\n\`\`\`` });
      } else if (att.data) {
        if (att.mimeType === "application/pdf") {
          blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: att.data } });
        } else if (att.mimeType.startsWith("image/")) {
          const mt = att.mimeType as ImageMediaType;
          blocks.push({ type: "image", source: { type: "base64", media_type: mt, data: att.data } });
        }
      }
    }
    blocks.push({ type: "text", text: question });
    lastUserContent = blocks;
  }

  let raw = "";
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 4096,
      system:     systemPrompt,
      messages:   [...chatHistory, { role: "user", content: lastUserContent }],
    });
    const textBlock = response.content.find(c => c.type === "text");
    raw = textBlock?.type === "text" ? textBlock.text.trim() : "";
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    return NextResponse.json({ answer: `Error from AI: ${msg}`, charts: [], suggestions: [] }, { status: 500 });
  }

  if (!raw) {
    return NextResponse.json({ answer: "The AI returned an empty response. Please try again.", charts: [], suggestions: [] });
  }

  // ── Robust JSON extraction ────────────────────────────────────────────────
  // Problems to solve:
  //   1. Claude sometimes wraps in ```json … ``` fences (with or without a
  //      leading newline, so ^ anchoring alone is unreliable).
  //   2. Claude sometimes writes LITERAL newlines/tabs inside JSON string
  //      values, which makes JSON.parse throw even after fence stripping.
  //   3. Claude sometimes adds a preamble sentence before the JSON object.
  //
  // Strategy:
  //   a) Find the first { in the raw string (skips any preamble / fence header).
  //   b) Find its matching } by tracking brace depth — this is robust to trailing
  //      text and code fences after the object.
  //   c) Sanitize the extracted string: escape literal control characters that
  //      appear inside JSON string values so JSON.parse can handle them.

  function extractOutermostObject(text: string): string | null {
    const start = text.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }

  // Escape literal newlines / carriage-returns / tabs inside JSON string
  // values (character-by-character so we don't corrupt escape sequences).
  function sanitizeJsonStrings(text: string): string {
    let out = "";
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (esc)                                  { out += ch; esc = false; continue; }
      if (ch === "\\")                          { out += ch; esc = true;  continue; }
      if (ch === '"')                           { out += ch; inStr = !inStr; continue; }
      if (inStr && ch === "\n")                 { out += "\\n"; continue; }
      if (inStr && ch === "\r")                 { out += "\\r"; continue; }
      if (inStr && ch === "\t")                 { out += "\\t"; continue; }
      out += ch;
    }
    return out;
  }

  const jsonStr = extractOutermostObject(raw);

  if (!jsonStr) {
    // No JSON object found anywhere — return raw text as the answer
    return NextResponse.json({ answer: raw, charts: [], suggestions: [] });
  }

  try {
    const parsed = JSON.parse(sanitizeJsonStrings(jsonStr));
    return NextResponse.json({
      answer:      typeof parsed.answer === "string" && parsed.answer ? parsed.answer : raw,
      charts:      Array.isArray(parsed.charts)      ? parsed.charts      : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    });
  } catch {
    // JSON.parse failed (e.g. truncated response or unexpected escape). Try to
    // regex-extract just the answer value, which is always the first string field.
    const answerMatch = raw.match(/"answer"\s*:\s*"([\s\S]*?)(?<!\\)"(?:\s*,|\s*})/);
    const rescued = answerMatch
      ? answerMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"')
      : raw.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
    return NextResponse.json({ answer: rescued, charts: [], suggestions: [] });
  }
}
