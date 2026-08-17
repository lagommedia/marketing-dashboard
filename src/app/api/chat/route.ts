import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { getCachedSheetMonths, normMonth } from "@/lib/sheets-cache";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function currentQuarterMonths(): string[] {
  const now = new Date();
  const q   = Math.floor(now.getMonth() / 3);
  return [0, 1, 2].map(i => `${SHORT_MONTHS[q * 3 + i]} ${now.getFullYear()}`);
}

function quarterLabel(date: Date): string {
  const q = Math.floor(date.getUTCMonth() / 3) + 1;
  return `Q${q} ${date.getUTCFullYear()}`;
}

function monthsAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
}

function pctElapsed(): number {
  const now    = new Date();
  const q      = Math.floor(now.getMonth() / 3);
  const qStart = new Date(now.getFullYear(), q * 3, 1);
  const qEnd   = new Date(now.getFullYear(), q * 3 + 3, 0);
  const totalMs   = qEnd.getTime() - qStart.getTime() + 86_400_000;
  const elapsedMs = Math.min(Math.max(now.getTime() - qStart.getTime(), 0), totalMs);
  return elapsedMs / totalMs;
}

function fmt$(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

function fmtN(n: number): string {
  return n.toLocaleString();
}

async function resolveApiKey(): Promise<string | null> {
  try {
    const row = await prisma.integration.findUnique({ where: { platform: "anthropic" } });
    if (row?.connected && row.accessToken) return decrypt(row.accessToken);
  } catch { /* fall through */ }
  return process.env.ANTHROPIC_API_KEY ?? null;
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

async function buildContext(): Promise<string> {
  const now     = new Date();
  const today   = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const q       = Math.floor(now.getMonth() / 3);
  const qLabel  = `Q${q + 1} ${now.getFullYear()}`;
  const qtdFrom = new Date(now.getFullYear(), q * 3, 1);
  const qtdTo   = now;

  // ── 1. Marketing spend from Reference Sheet cache ─────────────────────────
  const qtdMonths  = currentQuarterMonths();
  const sheetCache = await getCachedSheetMonths(qtdMonths).catch(() => null);

  let grossCosts = 0, sharedAlloc = 0, ltv = 0, churnRate = 0, grossMargin = 0;
  if (sheetCache) {
    for (const m of qtdMonths) {
      const row = sheetCache.get(normMonth(m));
      if (row) {
        grossCosts  += row.grossCosts;
        sharedAlloc += row.sharedAllocation;
        ltv          = row.ltv > 0 ? row.ltv : ltv;
        churnRate    = row.churnRate > 0 ? row.churnRate : churnRate;
        grossMargin  = row.grossMargin > 0 ? row.grossMargin : grossMargin;
      }
    }
  }
  const totalSpend     = grossCosts + sharedAlloc;
  const pct            = pctElapsed();
  const proRatedSpend  = totalSpend * pct;
  const spendNote      = sheetCache ? "" : " (Reference Sheet not yet synced — values may be 0)";

  // ── 2. HubSpot metrics from MetricSnapshot ────────────────────────────────
  const snapshots = await prisma.metricSnapshot.findMany({
    where: {
      platform: "hubspot",
      channel:  "all",
      date:     { gte: qtdFrom, lte: qtdTo },
    },
    select: { revenue: true, pipeline: true, activePipeline: true, leads: true, mqls: true, sqos: true, closedWon: true, spend: true },
  });

  let revenue = 0, pipeline = 0, activePipeline = 0, leads = 0, mqls = 0, sqos = 0, closedWon = 0;
  for (const s of snapshots) {
    revenue        += s.revenue        ?? 0;
    pipeline       += s.pipeline       ?? 0;
    activePipeline  = Math.max(activePipeline, s.activePipeline ?? 0);
    leads          += s.leads          ?? 0;
    mqls           += s.mqls           ?? 0;
    sqos           += s.sqos           ?? 0;
    closedWon      += s.closedWon      ?? 0;
  }

  // ── 3. GSC organic metrics ─────────────────────────────────────────────────
  const gscSnaps = await prisma.metricSnapshot.findMany({
    where: {
      platform: "google_search_console",
      channel:  "organic",
      date:     { gte: qtdFrom, lte: qtdTo },
    },
    select: { impressions: true, clicks: true, ctr: true },
  });

  let impressions = 0, clicks = 0;
  for (const s of gscSnaps) {
    impressions += s.impressions ?? 0;
    clicks      += s.clicks      ?? 0;
  }
  const ctr = impressions > 0 ? clicks / impressions : null;

  // ── 4. Derived metrics ────────────────────────────────────────────────────
  const cac        = closedWon > 0 && proRatedSpend > 0 ? proRatedSpend / closedWon : null;
  const ltvCac     = cac && ltv > 0 ? ltv / cac : null;
  const gtmEff     = revenue > 0 && proRatedSpend > 0 ? revenue / proRatedSpend : null;
  const pipeRev    = revenue > 0 && pipeline > 0 ? pipeline / revenue : null;
  const mqlToClose = mqls > 0 && closedWon > 0 ? (closedWon / mqls) * 100 : null;
  const sqoToClose = sqos > 0 && closedWon > 0 ? (closedWon / sqos) * 100 : null;
  const leadToMql  = leads > 0 && mqls > 0 ? (mqls / leads) * 100 : null;

  // ── 5. Pipeline by segment (current quarter) ──────────────────────────────
  let pipeSnaps: Array<{ segment: string; amountAll: number; amountPaid: number; amountOrganic: number; amountReferral: number }> = [];
  try {
    pipeSnaps = await prisma.pipelineQuarterSnapshot.findMany({
      where:   { quarter: qLabel },
      orderBy: { segment: "asc" },
    });
  } catch {
    // model may not be populated yet
  }

  const pipeSegRows = pipeSnaps.length
    ? pipeSnaps.map(r => `  ${r.segment}: ${fmt$(r.amountAll)} total (paid: ${fmt$(r.amountPaid)}, organic: ${fmt$(r.amountOrganic)}, referral: ${fmt$(r.amountReferral)})`).join("\n")
    : "  Not yet available";

  // ── 5b. Historical quarterly HubSpot metrics (last 8 quarters) ───────────
  const histFrom = monthsAgo(24);
  const histSnaps = await prisma.metricSnapshot.findMany({
    where: { platform: "hubspot", channel: "all", date: { gte: histFrom, lt: qtdFrom } },
    select: { date: true, revenue: true, pipeline: true, leads: true, mqls: true, sqos: true, closedWon: true, activePipeline: true },
    orderBy: { date: "asc" },
  });

  // Aggregate into quarters
  const qMap = new Map<string, { revenue: number; pipeline: number; leads: number; mqls: number; sqos: number; closedWon: number }>();
  for (const s of histSnaps) {
    const ql = quarterLabel(new Date(s.date));
    const cur = qMap.get(ql) ?? { revenue: 0, pipeline: 0, leads: 0, mqls: 0, sqos: 0, closedWon: 0 };
    cur.revenue   += s.revenue   ?? 0;
    cur.pipeline  += s.pipeline  ?? 0;
    cur.leads     += s.leads     ?? 0;
    cur.mqls      += s.mqls      ?? 0;
    cur.sqos      += s.sqos      ?? 0;
    cur.closedWon += s.closedWon ?? 0;
    qMap.set(ql, cur);
  }

  // Sort quarters chronologically and keep last 8
  const sortedQs = [...qMap.entries()].sort((a, b) => {
    const [qa, ya] = a[0].split(" "); const [qb, yb] = b[0].split(" ");
    return +ya !== +yb ? +ya - +yb : +qa.slice(1) - +qb.slice(1);
  }).slice(-8);

  const histQRows = sortedQs.length
    ? sortedQs.map(([ql, m]) => {
        const cac = m.closedWon > 0 ? null : null; // spend not available per-quarter here
        const leadToMqlH = m.leads > 0 && m.mqls > 0 ? ((m.mqls / m.leads) * 100).toFixed(1) + "%" : "N/A";
        const sqoToCloseH = m.sqos > 0 && m.closedWon > 0 ? ((m.closedWon / m.sqos) * 100).toFixed(1) + "%" : "N/A";
        return `  ${ql}: Revenue ${fmt$(m.revenue)}, Pipeline ${fmt$(m.pipeline)}, Leads ${fmtN(m.leads)}, MQLs ${fmtN(m.mqls)}, SQOs ${fmtN(m.sqos)}, Closed Won ${fmtN(m.closedWon)}, Lead→MQL ${leadToMqlH}, SQO→Close ${sqoToCloseH}`;
      }).join("\n")
    : "  No historical data available";

  // ── 5c. Historical monthly unit economics (last 12 months from Ref Sheet) ─
  const histMonthLabels: string[] = [];
  for (let i = 12; i >= 1; i--) {
    const d = monthsAgo(i);
    histMonthLabels.push(`${SHORT_MONTHS[d.getUTCMonth()].toLowerCase()} ${d.getUTCFullYear()}`);
  }
  const histSheetCache = await getCachedSheetMonths(histMonthLabels).catch(() => null);

  const histMonthRows = histSheetCache
    ? histMonthLabels
        .map(m => {
          const row = histSheetCache.get(normMonth(m));
          if (!row) return null;
          const spend = row.grossCosts + row.sharedAllocation;
          return `  ${m}: Spend ${fmt$(spend)} (costs ${fmt$(row.grossCosts)} + headcount ${fmt$(row.sharedAllocation)}), LTV ${row.ltv > 0 ? fmt$(row.ltv) : "N/A"}, Churn ${row.churnRate > 0 ? (row.churnRate * 100).toFixed(2) + "%" : "N/A"}, GrossMargin ${row.grossMargin > 0 ? (row.grossMargin * 100).toFixed(1) + "%" : "N/A"}`;
        })
        .filter(Boolean)
        .join("\n") || "  No historical spend data"
    : "  Reference Sheet not synced";

  // ── 5d. Historical pipeline by segment (all quarters) ─────────────────────
  let allPipeQuarters: Array<{ quarter: string; segment: string; amountAll: number; amountPaid: number; amountOrganic: number; amountReferral: number }> = [];
  try {
    allPipeQuarters = await prisma.pipelineQuarterSnapshot.findMany({
      where:   { quarter: { not: qLabel } },
      orderBy: [{ quarter: "asc" }, { segment: "asc" }],
    });
  } catch { /* ok */ }

  const histPipeByQ: Record<string, string[]> = {};
  for (const r of allPipeQuarters) {
    if (!histPipeByQ[r.quarter]) histPipeByQ[r.quarter] = [];
    histPipeByQ[r.quarter].push(`    ${r.segment}: ${fmt$(r.amountAll)} (paid ${fmt$(r.amountPaid)}, organic ${fmt$(r.amountOrganic)}, referral ${fmt$(r.amountReferral)})`);
  }
  const histPipeRows = Object.entries(histPipeByQ)
    .map(([ql, rows]) => `  ${ql}:\n${rows.join("\n")}`)
    .join("\n") || "  No historical pipeline segment data";

  // ── 6. HubSpot company classification ────────────────────────────────────
  const [total, aiCount, nonAiCount, unclassified] = await Promise.all([
    prisma.hubspotCompany.count(),
    prisma.hubspotCompany.count({ where: { isAiCompany: true } }),
    prisma.hubspotCompany.count({ where: { isAiCompany: false } }),
    prisma.hubspotCompany.count({ where: { isAiCompany: null } }),
  ]);

  const bySegment = await prisma.hubspotCompany.groupBy({
    by:     ["segment", "isAiCompany"],
    _count: { id: true },
    where:  { segment: { not: null } },
  });

  const segMap: Record<string, { ai: number; notAi: number; unknown: number }> = {};
  for (const row of bySegment) {
    const seg = row.segment ?? "Unknown";
    if (!segMap[seg]) segMap[seg] = { ai: 0, notAi: 0, unknown: 0 };
    if (row.isAiCompany === true)  segMap[seg].ai      += row._count.id;
    if (row.isAiCompany === false) segMap[seg].notAi   += row._count.id;
    if (row.isAiCompany === null)  segMap[seg].unknown += row._count.id;
  }
  const segSummary = Object.entries(segMap)
    .map(([seg, c]) => `  ${seg}: ${c.ai} AI, ${c.notAi} non-AI${c.unknown ? `, ${c.unknown} unclassified` : ""}`)
    .join("\n") || "  No segment data";

  const aiPct = total > 0 ? Math.round((aiCount / total) * 100) : 0;

  const companies = await prisma.hubspotCompany.findMany({
    select:  { name: true, domain: true, industry: true, segment: true, isAiCompany: true, aiReason: true },
    orderBy: { name: "asc" },
    take:    300,
  });

  // ── 7. Assemble system prompt ─────────────────────────────────────────────
  return `You are an AI marketing analyst for Zeni, a B2B SaaS company. Today is ${today}.
You have full access to Zeni's marketing dashboard data. Answer any question about marketing performance, pipeline, spend, efficiency, and company classification using the data below. Be specific, use the actual numbers, and show calculations when helpful.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${qLabel} QTD MARKETING METRICS (${qLabel} so far, ${Math.round(pct * 100)}% of quarter elapsed)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Spend & Efficiency${spendNote}
- Marketing Gross Costs (QTD full quarter): ${fmt$(grossCosts)}
- Shared Headcount Allocation (QTD full quarter): ${fmt$(sharedAlloc)}
- Total Estimated Marketing Spend (full quarter): ${fmt$(totalSpend)}
- Pro-Rated Spend (${Math.round(pct * 100)}% elapsed): ${fmt$(proRatedSpend)}
- GTM Efficiency (Revenue ÷ Pro-Rated Spend): ${gtmEff ? gtmEff.toFixed(2) + "x" : "N/A"}

## Revenue & Pipeline
- Closed-Won Revenue (QTD): ${fmt$(revenue)}
- Total Pipeline Created (QTD): ${fmt$(pipeline)}
- Active Pipeline (current point-in-time): ${fmt$(activePipeline)}
- Pipeline-to-Revenue Ratio: ${pipeRev ? pipeRev.toFixed(2) + "x" : "N/A"}
- Pipeline by Segment (${qLabel}):
${pipeSegRows}

## Funnel
- New Leads (QTD): ${fmtN(leads)}
- MQLs (QTD): ${fmtN(mqls)}
- SQOs (QTD): ${fmtN(sqos)}
- Closed Won (QTD): ${fmtN(closedWon)}
- Lead → MQL Rate: ${leadToMql ? leadToMql.toFixed(1) + "%" : "N/A"}
- MQL → Close Rate: ${mqlToClose ? mqlToClose.toFixed(1) + "%" : "N/A"}
- SQO → Close Rate: ${sqoToClose ? sqoToClose.toFixed(1) + "%" : "N/A"}

## Organic Search (Google Search Console, QTD)
- Impressions: ${fmtN(Math.round(impressions))}
- Clicks: ${fmtN(Math.round(clicks))}
- Avg CTR: ${ctr ? (ctr * 100).toFixed(2) + "%" : "N/A"}

## Unit Economics (from Reference Sheet)
- LTV: ${ltv > 0 ? fmt$(ltv) : "Not synced"}
- Monthly Churn Rate: ${churnRate > 0 ? (churnRate * 100).toFixed(2) + "%" : "Not synced"}
- Gross Margin: ${grossMargin > 0 ? (grossMargin * 100).toFixed(1) + "%" : "Not synced"}
- Marketing CAC (pro-rated spend ÷ closed won): ${cac ? fmt$(cac) : "N/A (need both spend and closed won)"}
- LTV:CAC Ratio: ${ltvCac ? ltvCac.toFixed(2) + "x" : "N/A"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HISTORICAL DATA (prior quarters & months)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Quarterly Funnel & Revenue (last 8 quarters, excluding current QTD)
${histQRows}

## Monthly Marketing Spend & Unit Economics (last 12 months)
${histMonthRows}

## Historical Pipeline by Segment (prior quarters)
${histPipeRows}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AI COMPANY CLASSIFICATION (HubSpot CRM)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Total companies: ${fmtN(total)}
- AI companies: ${fmtN(aiCount)} (${aiPct}%)
- Non-AI: ${fmtN(nonAiCount)}
- Unclassified: ${fmtN(unclassified)}

By segment:
${segSummary}

Company list (up to 300, alphabetical):
${JSON.stringify(companies, null, 2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NOTES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- If spend/cost data shows $0, the Reference Sheet sync has not been run yet.
- If funnel metrics (leads/MQLs/SQOs) show 0, a HubSpot sync may be needed.
- Pipeline figures come from HubSpot deal data synced to the dashboard.
- Organic search data comes from Google Search Console.
- Format dollar amounts clearly. Show your math when computing ratios or derived metrics.`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic AI is not connected. Add your API key under Integrations." },
      { status: 503 }
    );
  }

  let messages: { role: "user" | "assistant"; content: string }[];
  try {
    const body = await req.json();
    messages = body.messages ?? [];
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!messages.length) {
    return NextResponse.json({ error: "messages array is required" }, { status: 400 });
  }

  const systemPrompt = await buildContext();

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model:      "claude-sonnet-5",
    max_tokens: 2048,
    system:     systemPrompt,
    messages,
  });

  const textBlock = response.content.find(c => c.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text : "";
  return NextResponse.json({ message: text });
}
