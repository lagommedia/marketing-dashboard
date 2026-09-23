import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Internal agent API caller — uses AGENT_API_TOKEN, server-side only
// ---------------------------------------------------------------------------

// VERCEL_URL is auto-set by Vercel (no https://); NEXTAUTH_URL is the app's
// canonical URL. Prefer NEXTAUTH_URL, fall back to VERCEL_URL, then localhost.
const DASHBOARD_BASE =
  process.env.NEXTAUTH_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3001");

async function agentFetch(path: string): Promise<unknown> {
  const token = process.env.AGENT_API_TOKEN;
  if (!token) return { error: "AGENT_API_TOKEN not configured" };
  try {
    const res = await fetch(`${DASHBOARD_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 0 },
    });
    if (!res.ok) return { error: `${path} returned ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: e instanceof Error ? e.message : "fetch failed" };
  }
}

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
// Pull live context from agent endpoints
// ---------------------------------------------------------------------------

async function fetchLiveContext() {
  const now       = new Date();
  const quarter   = `${now.getFullYear()}-Q${Math.ceil((now.getMonth() + 1) / 3)}`;
  const w12Ago    = new Date(now); w12Ago.setDate(w12Ago.getDate() - 84);
  const m6Ago     = new Date(now); m6Ago.setMonth(m6Ago.getMonth() - 6);
  const today     = now.toISOString().slice(0, 10);
  const w12Start  = w12Ago.toISOString().slice(0, 10);
  const m6Start   = m6Ago.toISOString().slice(0, 10);

  const [schema, funnel12w, funnelMonthly, channels, pacing] = await Promise.all([
    agentFetch("/api/agent/schema"),
    agentFetch(`/api/agent/funnel?from=${w12Start}&to=${today}&granularity=week&channel=all`),
    agentFetch(`/api/agent/funnel?from=${m6Start}&to=${today}&granularity=month&channel=all`),
    agentFetch(`/api/agent/channels?from=${w12Start}&to=${today}`),
    agentFetch(`/api/agent/pacing?period=${quarter}`),
  ]);

  return { schema, funnel12w, funnelMonthly, channels, pacing, today, quarter, w12Start, m6Start };
}

function formatLiveContext(ctx: Awaited<ReturnType<typeof fetchLiveContext>>): string {
  const { schema, funnel12w, funnelMonthly, channels, pacing, today, quarter } = ctx;

  let out = `## Live Dashboard Context — pulled ${today}\n\n`;

  // Schema / integration status
  const s = schema as Record<string, unknown>;
  if (s && !s.error) {
    const integrations = (s.integrations as Array<{platform: string; connected: boolean; lastSyncedAt: string | null}>) ?? [];
    out += `### Integration status\n`;
    for (const i of integrations) {
      const synced = i.lastSyncedAt ? `last synced ${i.lastSyncedAt.slice(0, 10)}` : "never synced";
      out += `- **${i.platform}**: ${i.connected ? "connected" : "NOT connected"} (${synced})\n`;
    }
    if (s.caveats) {
      out += `\n### Known caveats\n${JSON.stringify(s.caveats, null, 2)}\n`;
    }
  } else {
    out += `Schema fetch failed: ${JSON.stringify(schema)}\n`;
  }

  // Funnel 12-week
  out += `\n### Funnel — trailing 12 weeks (weekly, all channels)\n`;
  out += JSON.stringify(funnel12w, null, 2).slice(0, 4000) + "\n";

  // Funnel 6-month
  out += `\n### Funnel — trailing 6 months (monthly, all channels)\n`;
  out += JSON.stringify(funnelMonthly, null, 2).slice(0, 2000) + "\n";

  // Channel efficiency
  out += `\n### Channel efficiency (trailing 12 weeks)\n`;
  out += JSON.stringify(channels, null, 2).slice(0, 3000) + "\n";

  // Pacing
  out += `\n### Pacing — ${quarter}\n`;
  out += JSON.stringify(pacing, null, 2).slice(0, 2000) + "\n";

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
