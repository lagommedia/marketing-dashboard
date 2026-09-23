import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { ratio, sum } from "@/lib/agent-auth";

const HS_BASE = "https://api.hubapi.com";

async function getHubSpotToken(): Promise<string | null> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) return null;
  return decrypt(row.accessToken);
}

// Fetch MQL/SQO contacts from HubSpot with lifecycle stage timestamps
// Returns cohort analysis: how long after MQL did engagement happen, and did they convert?
async function fetchContactTimingData(): Promise<string> {
  let token: string | null;
  try {
    token = await getHubSpotToken();
  } catch {
    return "HubSpot contact timing data: unavailable (integration error)\n";
  }
  if (!token) return "HubSpot contact timing data: unavailable (not connected)\n";

  const properties = [
    "firstname", "lastname", "lifecyclestage",
    "hs_lifecyclestage_lead_date",
    "hs_lifecyclestage_marketingqualifiedlead_date",
    "hs_lifecyclestage_salesqualifiedlead_date",
    "hs_lifecyclestage_opportunity_date",
    "first_conversion_date",
    "notes_last_contacted",
    "hs_sales_email_last_replied",
    "hs_email_last_open_date",
    "createdate",
    "hs_lead_status",
  ];

  try {
    // Fetch up to 200 contacts that have an MQL date (recently)
    const sixMonthsAgo = Date.now() - 180 * 24 * 60 * 60 * 1000;

    const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              {
                propertyName: "hs_lifecyclestage_marketingqualifiedlead_date",
                operator: "GTE",
                value: String(sixMonthsAgo),
              },
            ],
          },
        ],
        properties,
        limit: 200,
        sorts: [{ propertyName: "hs_lifecyclestage_marketingqualifiedlead_date", direction: "DESCENDING" }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return `HubSpot contact timing data: unavailable (API error ${res.status}: ${body.slice(0, 200)})\n`;
    }

    const data = await res.json();
    const contacts: Array<Record<string, string>> = (data.results ?? []).map(
      (c: { properties: Record<string, string> }) => c.properties,
    );

    if (contacts.length === 0) {
      return "HubSpot contact timing data: no MQL contacts found in the last 6 months\n";
    }

    // Cohort buckets: days from MQL date to first engagement proxy
    type Cohort = { label: string; total: number; convertedToSqo: number };
    const cohorts: Cohort[] = [
      { label: "same-day (0 days)",   total: 0, convertedToSqo: 0 },
      { label: "1-3 days",            total: 0, convertedToSqo: 0 },
      { label: "4-7 days",            total: 0, convertedToSqo: 0 },
      { label: "8-14 days",           total: 0, convertedToSqo: 0 },
      { label: "15-30 days",          total: 0, convertedToSqo: 0 },
      { label: "30+ days",            total: 0, convertedToSqo: 0 },
      { label: "MQL — no engagement", total: 0, convertedToSqo: 0 },
    ];

    let totalMqls = 0;
    let totalConverted = 0;

    for (const c of contacts) {
      const mqlDate = c.hs_lifecyclestage_marketingqualifiedlead_date
        ? new Date(c.hs_lifecyclestage_marketingqualifiedlead_date).getTime()
        : null;
      if (!mqlDate || isNaN(mqlDate)) continue;

      totalMqls++;

      const sqoDate = c.hs_lifecyclestage_salesqualifiedlead_date || c.hs_lifecyclestage_opportunity_date
        ? new Date(c.hs_lifecyclestage_salesqualifiedlead_date || c.hs_lifecyclestage_opportunity_date!).getTime()
        : null;

      const convertedToSqo = sqoDate != null && !isNaN(sqoDate) && sqoDate > mqlDate;
      if (convertedToSqo) totalConverted++;

      // First engagement proxy: earliest of last_contacted, sales_email_replied, email_open after MQL
      const engagementCandidates = [
        c.notes_last_contacted,
        c.hs_sales_email_last_replied,
        c.hs_email_last_open_date,
      ]
        .filter(Boolean)
        .map(d => new Date(d!).getTime())
        .filter(t => !isNaN(t) && t >= mqlDate);

      if (engagementCandidates.length === 0) {
        cohorts[6].total++;
        if (convertedToSqo) cohorts[6].convertedToSqo++;
        continue;
      }

      const firstEngagement = Math.min(...engagementCandidates);
      const daysToEngage = (firstEngagement - mqlDate) / (1000 * 60 * 60 * 24);

      const idx =
        daysToEngage < 1  ? 0 :
        daysToEngage <= 3  ? 1 :
        daysToEngage <= 7  ? 2 :
        daysToEngage <= 14 ? 3 :
        daysToEngage <= 30 ? 4 : 5;

      cohorts[idx].total++;
      if (convertedToSqo) cohorts[idx].convertedToSqo++;
    }

    let out = `HubSpot contact timing data (last 6 months, n=${totalMqls} MQLs, ${totalConverted} converted to SQO — overall rate ${totalMqls > 0 ? ((totalConverted / totalMqls) * 100).toFixed(1) : 0}%):\n\n`;
    out += "Time from MQL to first engagement → MQL→SQO conversion rate:\n";
    for (const c of cohorts) {
      if (c.total === 0) continue;
      const rate = c.total > 0 ? ((c.convertedToSqo / c.total) * 100).toFixed(1) : "0.0";
      out += `  - ${c.label}: ${c.total} MQLs, ${c.convertedToSqo} converted (${rate}%)\n`;
    }

    return out;
  } catch (err) {
    return `HubSpot contact timing data: unavailable (${err instanceof Error ? err.message : "unknown error"})\n`;
  }
}

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Resolve Anthropic API key
// ---------------------------------------------------------------------------

async function resolveApiKey(): Promise<string | null> {
  try {
    const row = await prisma.integration.findUnique({ where: { platform: "anthropic" } });
    if (row?.connected && row.accessToken) return decrypt(row.accessToken);
  } catch { /* fall through */ }
  return process.env.ANTHROPIC_API_KEY ?? null;
}

// ---------------------------------------------------------------------------
// Pull live context directly from Prisma — no internal HTTP calls
// ---------------------------------------------------------------------------

type Grain = "week" | "month";

function bucketKey(d: Date, grain: Grain): string {
  if (grain === "month") return d.toISOString().slice(0, 7);
  const x = new Date(d);
  const day = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - day);
  return x.toISOString().slice(0, 10);
}

function currentQuarter(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

function quarterBounds(period: string) {
  const m = /^(\d{4})-Q([1-4])$/.exec(period);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const q = parseInt(m[2], 10) - 1;
  return {
    start: new Date(Date.UTC(year, q * 3, 1)),
    end:   new Date(Date.UTC(year, q * 3 + 3, 0, 23, 59, 59, 999)),
  };
}

async function fetchLiveContext() {
  const now      = new Date();
  const today    = now.toISOString().slice(0, 10);
  const quarter  = currentQuarter();

  const w12Ago   = new Date(now); w12Ago.setDate(w12Ago.getDate() - 84);
  const m6Ago    = new Date(now); m6Ago.setMonth(m6Ago.getMonth() - 6);

  const bounds   = quarterBounds(quarter)!;
  const asOf     = new Date(Math.min(Date.now(), bounds.end.getTime()));
  const pctElapsed = Math.min(
    Math.max((asOf.getTime() - bounds.start.getTime()) / (bounds.end.getTime() - bounds.start.getTime()), 0),
    1,
  );

  const [
    integrations,
    snapshots12w,
    gaRows12w,
    adRows12w,
    snapshots6m,
    gaRows6m,
    adRows6m,
    channelRows,
    pacingTargets,
    pacingSnaps,
  ] = await Promise.all([
    prisma.integration.findMany({
      select: { platform: true, connected: true, lastSyncedAt: true, accountName: true },
      orderBy: { platform: "asc" },
    }),
    // 12-week funnel (weekly)
    prisma.metricSnapshot.findMany({
      where: { date: { gte: w12Ago, lte: now } },
      orderBy: { date: "asc" },
    }),
    prisma.gaOrganicSnapshot.findMany({
      where: { date: { gte: w12Ago, lte: now } },
      select: { date: true, sessions: true },
    }),
    prisma.campaignDailySpend.findMany({
      where: { date: { gte: w12Ago, lte: now } },
      select: { date: true, clicks: true, impressions: true, spend: true },
    }),
    // 6-month funnel (monthly)
    prisma.metricSnapshot.findMany({
      where: { date: { gte: m6Ago, lte: now } },
      orderBy: { date: "asc" },
    }),
    prisma.gaOrganicSnapshot.findMany({
      where: { date: { gte: m6Ago, lte: now } },
      select: { date: true, sessions: true },
    }),
    prisma.campaignDailySpend.findMany({
      where: { date: { gte: m6Ago, lte: now } },
      select: { date: true, clicks: true, impressions: true, spend: true },
    }),
    // Channel efficiency (12-week)
    prisma.metricSnapshot.findMany({
      where: { date: { gte: w12Ago, lte: now } },
      orderBy: { date: "asc" },
    }),
    // Pacing
    prisma.pacingTarget.findMany({ where: { period: quarter } }),
    prisma.metricSnapshot.findMany({ where: { date: { gte: bounds.start, lte: asOf } } }),
  ]);

  // Build funnel buckets
  function buildFunnelPeriods(
    snaps: typeof snapshots12w,
    gaR: typeof gaRows12w,
    adR: typeof adRows12w,
    grain: Grain,
  ) {
    interface Bucket {
      period: string; organicSessions: number; paidClicks: number;
      impressions: number; spend: number;
      leads: number; mqls: number; sqos: number; closedWon: number;
      revenue: number; pipeline: number;
    }
    const buckets = new Map<string, Bucket>();
    const get = (d: Date): Bucket => {
      const k = bucketKey(d, grain);
      let b = buckets.get(k);
      if (!b) {
        b = { period: k, organicSessions: 0, paidClicks: 0, impressions: 0, spend: 0,
              leads: 0, mqls: 0, sqos: 0, closedWon: 0, revenue: 0, pipeline: 0 };
        buckets.set(k, b);
      }
      return b;
    };
    for (const r of snaps) {
      const b = get(r.date);
      b.leads += r.leads ?? 0; b.mqls += r.mqls ?? 0;
      b.sqos += r.sqos ?? 0; b.closedWon += r.closedWon ?? 0;
      b.revenue += r.revenue ?? 0; b.pipeline += r.pipeline ?? 0;
    }
    for (const r of gaR) get(r.date).organicSessions += r.sessions;
    for (const r of adR) {
      const b = get(r.date);
      b.paidClicks += r.clicks; b.impressions += r.impressions; b.spend += r.spend;
    }
    return [...buckets.values()]
      .sort((a, b) => a.period.localeCompare(b.period))
      .map(b => ({
        ...b,
        siteVisits: b.organicSessions + b.paidClicks,
        rates: {
          visitToLead: ratio(b.leads, b.organicSessions + b.paidClicks),
          leadToMql: ratio(b.mqls, b.leads),
          mqlToSqo: ratio(b.sqos, b.mqls),
          sqoToClosedWon: ratio(b.closedWon, b.sqos),
        },
        efficiency: {
          costPerLead: ratio(b.spend, b.leads),
          costPerMql: ratio(b.spend, b.mqls),
          costPerSqo: ratio(b.spend, b.sqos),
        },
      }));
  }

  const funnel12w    = buildFunnelPeriods(snapshots12w, gaRows12w, adRows12w, "week");
  const funnelMonthly = buildFunnelPeriods(snapshots6m, gaRows6m, adRows6m, "month");

  // Channel efficiency
  interface ChannelAgg {
    key: string; impressions: number; clicks: number; sessions: number;
    leads: number; mqls: number; sqos: number; closedWon: number;
    spend: number; revenue: number; pipeline: number;
  }
  const blank = (key: string): ChannelAgg => ({
    key, impressions: 0, clicks: 0, sessions: 0, leads: 0, mqls: 0,
    sqos: 0, closedWon: 0, spend: 0, revenue: 0, pipeline: 0,
  });
  const byChannel = new Map<string, ChannelAgg>();
  for (const r of channelRows) {
    if (r.channel === "all" || r.platform === "all") continue;
    const c = byChannel.get(r.channel) ?? blank(r.channel);
    byChannel.set(r.channel, c);
    c.impressions += r.impressions ?? 0; c.clicks += r.clicks ?? 0;
    c.sessions += r.sessions ?? 0; c.leads += r.leads ?? 0;
    c.mqls += r.mqls ?? 0; c.sqos += r.sqos ?? 0;
    c.closedWon += r.closedWon ?? 0; c.spend += r.spend ?? 0;
    c.revenue += r.revenue ?? 0; c.pipeline += r.pipeline ?? 0;
  }
  const totalSpend = [...byChannel.values()].reduce((s, c) => s + c.spend, 0);
  const channels = [...byChannel.values()]
    .sort((a, b) => b.spend - a.spend)
    .map(c => ({
      ...c,
      shareOfSpend: ratio(c.spend, totalSpend),
      rates: { leadToMql: ratio(c.mqls, c.leads), mqlToSqo: ratio(c.sqos, c.mqls), sqoToClosedWon: ratio(c.closedWon, c.sqos) },
      efficiency: { costPerMql: ratio(c.spend, c.mqls), costPerSqo: ratio(c.spend, c.sqos), cac: ratio(c.spend, c.closedWon), returnPerDollar: ratio(c.revenue, c.spend) },
    }));

  // Pacing
  const org = pacingTargets.find(t => t.channel === "marketing_org") ?? null;
  const expensesToDate = org?.targetSpend != null ? org.targetSpend * pctElapsed : null;
  const actualsAll = {
    mqls: pacingSnaps.reduce((s, r) => s + (r.mqls ?? 0), 0),
    sqos: pacingSnaps.reduce((s, r) => s + (r.sqos ?? 0), 0),
    closedWon: pacingSnaps.reduce((s, r) => s + (r.closedWon ?? 0), 0),
    revenue: pacingSnaps.reduce((s, r) => s + (r.revenue ?? 0), 0),
  };
  const pacingRows = pacingTargets
    .filter(t => t.channel !== "marketing_org")
    .map(t => {
      const rs = pacingSnaps.filter(r => r.channel === t.channel);
      const actual = {
        mqls: sum(rs.map(r => r.mqls)), sqos: sum(rs.map(r => r.sqos)),
        pipeline: sum(rs.map(r => r.pipeline)), closedWon: sum(rs.map(r => r.closedWon)),
        spend: sum(rs.map(r => r.spend)),
      };
      const vs = (a: number, tgt: number | null) => tgt != null && tgt > 0
        ? { actual: a, target: tgt, attainment: a / tgt, paceIndex: ratio(a / tgt, pctElapsed) }
        : { actual: a, target: tgt, attainment: null, paceIndex: null };
      return {
        channel: t.channel,
        mqls: vs(actual.mqls, t.targetMqls),
        sqos: vs(actual.sqos, t.targetSqos),
        pipeline: vs(actual.pipeline, t.targetPipeline),
        closedWon: vs(actual.closedWon, t.targetClosedWon),
        spend: vs(actual.spend, t.targetSpend),
      };
    });

  const [contactTiming] = await Promise.all([fetchContactTimingData()]);

  return {
    today, quarter, pctElapsed,
    integrations: integrations.map(i => ({
      platform: i.platform, connected: i.connected, account: i.accountName,
      lastSyncedAt: i.lastSyncedAt?.toISOString().slice(0, 10) ?? null,
      staleDays: i.lastSyncedAt ? Math.floor((Date.now() - i.lastSyncedAt.getTime()) / 86_400_000) : null,
    })),
    funnel12w,
    funnelMonthly,
    channels,
    pacing: {
      period: quarter, pctElapsed,
      rows: pacingRows,
      derived: {
        expensesToDate,
        closedWon: actualsAll.closedWon,
        revenue: actualsAll.revenue,
        cac: ratio(expensesToDate, actualsAll.closedWon),
        gtmEfficiency: ratio(actualsAll.revenue, expensesToDate),
      },
    },
    contactTiming,
  };
}

function formatLiveContext(ctx: Awaited<ReturnType<typeof fetchLiveContext>>): string {
  const { today, quarter, integrations, funnel12w, funnelMonthly, channels, pacing } = ctx;

  let out = `## Live Dashboard Context — pulled ${today}\n\n`;

  out += `### Integration status\n`;
  for (const i of integrations) {
    const synced = i.lastSyncedAt ? `last synced ${i.lastSyncedAt} (${i.staleDays}d ago)` : "never synced";
    out += `- **${i.platform}**: ${i.connected ? "connected" : "NOT connected"} (${synced})\n`;
  }

  out += `\n### Funnel — trailing 12 weeks (weekly, all channels)\n`;
  out += JSON.stringify(funnel12w, null, 2).slice(0, 4000) + "\n";

  out += `\n### Funnel — trailing 6 months (monthly, all channels)\n`;
  out += JSON.stringify(funnelMonthly, null, 2).slice(0, 2000) + "\n";

  out += `\n### Channel efficiency (trailing 12 weeks)\n`;
  out += JSON.stringify(channels, null, 2).slice(0, 3000) + "\n";

  out += `\n### Pacing — ${quarter} (${(ctx.pctElapsed * 100).toFixed(0)}% of quarter elapsed)\n`;
  out += JSON.stringify(pacing, null, 2).slice(0, 2000) + "\n";

  out += `\n### MQL → SQO conversion timing (HubSpot contact-level)\n`;
  out += ctx.contactTiming + "\n";

  return out;
}

// ---------------------------------------------------------------------------
// Mar Ops system prompt — grounded in the /mar-ops skill
// ---------------------------------------------------------------------------

const MAR_OPS_SYSTEM = `You are the Marketing Operations AI analyst for Zeni, a B2B SaaS company in the fintech / financial services space. You operate according to the /mar-ops skill — a set of principles, definitions, and analytical modes that govern every answer you give.

## Your role
You read live dashboard data, reconcile it against the definitions the business already uses, and return a diagnosis — not a table dump. You are read-only: you never modify GA4, HubSpot, Google Ads, or the dashboard.

## The cardinal rule
A number without a baseline is not a finding. Every figure is compared against its own trailing history first, then against target or benchmark, and paired with what to do about it.

## Zeni's definitions (use these exactly — never invent alternatives)

**Channel attribution:**
- Paid Media = Paid Search + Paid Social + 50% of Direct Traffic
- Organic = Email + Organic Search + Social + the other 50% of Direct
- Referral = deal-sourced only, no contact MQLs
- Deal source logic: deal_source=Referral → referral; Events → organic; Inbound + Paid* detail → paid media; Inbound + Direct Traffic → 50/50; any other Inbound detail → organic

**Funnel stages:** Site Visits → Leads → MQL → SQL/SAL → SQO → Closed Won
- Stage counts are contacts created in the window, currently at that stage (not where they were)

**Site visits are two units:**
- Paid visits = Google Ads clicks
- Organic visits = GA4 sessions
- Never call the combined figure "sessions", never compare it to a GA4 sessions total

**CAC and GTM efficiency** divide Gross Expenses by the fraction of the quarter elapsed. With no target set, both are null — report as "not set", never as zero.

## Analytical discipline (apply to every answer)

1. **Baseline before verdict.** Compare to the metric's own trailing 12-week or trailing 3-month average. A move inside the trailing band is noise — say so.
2. **Discount the tail.** The most recent 2–3 weeks of MQL/SQO/Closed Won are provisional. GSC lags 2–3 days; GA4 finalises over 24–48h. Never flag a "decline" that is really lag.
3. **Check for a human cause first.** Before attributing any paid move to the market, look for change events. A budget change beats a market theory.
4. **Segment before concluding.** A flat top-line usually hides two opposite moves. Split by channel at minimum.
5. **Say what you don't know.** A missing feed or stale sync is a finding, not something to route around.

## Modes you operate in

**Mode 1 — Funnel report:** Headline findings → funnel table by period → split paid vs organic → stage-conversion trends → pacing vs target → specific findings with actions.

**Mode 2 — Anomaly diagnosis:** Work the funnel top-down. Confirm it's real → localise by channel/page/device/geo → rule out measurement issues → rule out human changes → then external causes. Deliver: what happened, when, size in % and absolute, where concentrated, ranked causes with evidence, what would confirm the leading one, confidence level.

**Mode 3 — Channel efficiency:** Per channel: spend, share of spend, cost per MQL/SQO/Closed Won, CAC, return per $1, pace index. Lead with the marginal question: where should the next dollar go?

**Mode 6 — MQL timing analysis:** Use the "MQL → SQO conversion timing" section of the live data. Group by days-to-first-engagement cohort, compare conversion rates across cohorts, identify whether faster engagement correlates with higher SQO conversion, and flag cohorts with large populations but low conversion rates as the highest-leverage intervention points.

**Mode 4 — Landing page audit:** High traffic, low conversion → Declining sessions → High impressions, low CTR (GSC) → Orphaned/missing pages. Rank by opportunity size (sessions × conversion-rate gap vs site median).

**Mode 5 — Campaign governance / UTM QA:** All five UTM params present and correct, destination URLs return 200, forms post to HubSpot. Monthly sweep: new source/medium pairs, campaigns landing in (not set), numeric utm_campaign values, channel volumes moving without spend changes.

## Response format
Respond ONLY with a valid JSON object, no other text. Schema:
{
  "answer": "your analysis — use **bold** for key numbers, bullet points using - prefix, headers using ## and ###",
  "suggestions": ["follow-up question 1", "follow-up question 2", "follow-up question 3"]
}

Keep answers direct and diagnostic. Match the ask: a quick question gets 2-3 paragraphs, a full report gets sections. Always end with a short "what I'd do next" unless the user asked something quick. Always state the date range and effective data cut-off.`;

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const [apiKey, liveCtx] = await Promise.all([resolveApiKey(), fetchLiveContext()]);

  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic AI is not connected. Add your API key under Integrations." },
      { status: 503 }
    );
  }

  let question: string;
  let messages: Array<{ role: string; content: string }>;
  try {
    const body = await req.json();
    question   = body.question ?? "";
    messages   = body.messages ?? [];
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!question.trim()) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const liveContextText = formatLiveContext(liveCtx);

  const systemWithContext = `${MAR_OPS_SYSTEM}

## ── LIVE DASHBOARD DATA ─────────────────────────────────────────────────────
Today: ${liveCtx.today}   Current quarter: ${liveCtx.quarter}

${liveContextText}`;

  const chatHistory = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  let raw = "";
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 8192,
      system:     systemWithContext,
      messages:   [...chatHistory, { role: "user", content: question }],
    });
    const textBlock = response.content.find(c => c.type === "text");
    raw = textBlock?.type === "text" ? textBlock.text.trim() : "";
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    return NextResponse.json({ answer: `Error: ${msg}`, suggestions: [] }, { status: 500 });
  }

  if (!raw) {
    return NextResponse.json({ answer: "The AI returned an empty response. Please try again.", suggestions: [] });
  }

  // Robust JSON extraction
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

  function sanitizeJsonStrings(text: string): string {
    let out = ""; let inStr = false; let esc = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (esc)             { out += ch; esc = false; continue; }
      if (ch === "\\")     { out += ch; esc = true;  continue; }
      if (ch === '"')      { out += ch; inStr = !inStr; continue; }
      if (inStr && ch === "\n") { out += "\\n"; continue; }
      if (inStr && ch === "\r") { out += "\\r"; continue; }
      if (inStr && ch === "\t") { out += "\\t"; continue; }
      out += ch;
    }
    return out;
  }

  const jsonStr = extractOutermostObject(raw);
  if (!jsonStr) {
    return NextResponse.json({ answer: raw, suggestions: [] });
  }

  try {
    const parsed = JSON.parse(sanitizeJsonStrings(jsonStr));
    return NextResponse.json({
      answer:      typeof parsed.answer === "string" && parsed.answer ? parsed.answer : raw,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    });
  } catch {
    return NextResponse.json({ answer: raw, suggestions: [] });
  }
}
