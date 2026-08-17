import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types accepted from the client
// ---------------------------------------------------------------------------

interface TrendPeriod {
  label:      string;
  value?:     number | null;
  paid_media?: number;
  organic?:   number;
  referral?:  number;
  isCurrent:  boolean;
}

interface SegmentRow {
  segment: string;
  total:   number;
}

interface QuarterRow {
  quarter: string;
  total:   number;
  [segment: string]: number | string;
}

interface StageRow {
  stageLabel: string;
  total:      number;
  [channel: string]: number | string;
}

interface InsightRequest {
  /** Human-readable name for the card, e.g. "Revenue (Closed Won)" */
  cardLabel:  string;
  /** The metric key, e.g. "revenue", "mqls" */
  metric?:    string;
  /** Format hint for the AI */
  format?:    "currency" | "number";
  /** Trend periods — present for MetricTrendModal */
  periods?:   TrendPeriod[];
  /** Segment summary — present for PipelineBreakdownModal / ActivePipelineModal */
  bySegment?: SegmentRow[];
  /** Quarter rows — present for PipelineBreakdownModal */
  byQuarter?: QuarterRow[];
  /** Stage rows — present for ActivePipelineModal */
  byStage?:   StageRow[];
  /** Grand total — present for breakdown modals */
  grandTotal?: number;
  /** Currently active channel filter */
  channel?:   string;
  /** The user's question */
  question:   string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtVal(v: number | null | undefined, format?: string): string {
  if (v == null) return "N/A";
  if (format === "currency") {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
    return `$${v.toLocaleString()}`;
  }
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

// ---------------------------------------------------------------------------
// Build context string from the data
// ---------------------------------------------------------------------------

function buildContext(body: InsightRequest): string {
  const lines: string[] = [];

  lines.push(`CARD: ${body.cardLabel}`);
  if (body.channel && body.channel !== "all") {
    lines.push(`CHANNEL FILTER: ${body.channel.replace("_", " ")}`);
  }

  // ── Trend periods ──
  if (body.periods?.length) {
    const isCurrency = body.format === "currency";
    const hasBreakdown = body.periods.some((p) => p.paid_media != null);

    lines.push("\nHISTORICAL TREND (12 periods, newest = current/highlighted):");

    for (const p of body.periods) {
      const current = p.isCurrent ? " ← current period" : "";
      if (hasBreakdown) {
        const pm  = fmtVal(p.paid_media, body.format);
        const org = fmtVal(p.organic,    body.format);
        const ref = fmtVal(p.referral,   body.format);
        const tot = fmtVal((p.paid_media ?? 0) + (p.organic ?? 0) + (p.referral ?? 0), body.format);
        lines.push(`  ${p.label}: Paid Media ${pm}, Organic ${org}, Referral ${ref}, Total ${tot}${current}`);
      } else {
        lines.push(`  ${p.label}: ${fmtVal(p.value, body.format)}${current}`);
      }
    }

    // Quick stats
    const vals = body.periods
      .filter((p) => !p.isCurrent)
      .map((p) => {
        if (p.paid_media != null) return (p.paid_media ?? 0) + (p.organic ?? 0) + (p.referral ?? 0);
        return p.value ?? 0;
      })
      .filter((v) => v > 0);

    if (vals.length > 1) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      lines.push(`\nSTATISTICS (excluding current period):`);
      lines.push(`  Average: ${fmtVal(avg, body.format)}`);
      lines.push(`  Peak:    ${fmtVal(max, body.format)}`);
      lines.push(`  Trough:  ${fmtVal(min, body.format)}`);

      // MoM/QoQ growth of last two completed periods
      if (vals.length >= 2) {
        const prev = vals[vals.length - 2];
        const last = vals[vals.length - 1];
        if (prev > 0) {
          const pct = ((last - prev) / prev) * 100;
          lines.push(`  Last vs prior period: ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
        }
      }

      // YoY if 12 quarters
      if (body.periods.length >= 5) {
        const current = (() => {
          const p = body.periods[body.periods.length - 1];
          if (p.paid_media != null) return (p.paid_media ?? 0) + (p.organic ?? 0) + (p.referral ?? 0);
          return p.value ?? 0;
        })();
        const yoyBase = (() => {
          const p = body.periods[body.periods.length - 5];
          if (p?.paid_media != null) return (p.paid_media ?? 0) + (p.organic ?? 0) + (p.referral ?? 0);
          return p?.value ?? 0;
        })();
        if (yoyBase > 0) {
          const yoy = ((current - yoyBase) / yoyBase) * 100;
          lines.push(`  YoY (vs same period last year): ${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}%`);
        }
      }
    }
  }

  // ── Active pipeline by stage ──
  if (body.byStage?.length) {
    lines.push("\nACTIVE PIPELINE BY STAGE:");
    for (const s of body.byStage) {
      lines.push(`  ${s.stageLabel}: ${fmtVal(s.total as number, "currency")}`);
    }
  }

  // ── Pipeline / channel breakdown ──
  if (body.bySegment?.length) {
    lines.push("\nBY CHANNEL:");
    for (const s of body.bySegment) {
      if (s.total > 0) lines.push(`  ${s.segment}: ${fmtVal(s.total, "currency")}`);
    }
  }

  if (body.byQuarter?.length) {
    lines.push("\nPIPELINE BY QUARTER:");
    for (const q of body.byQuarter) {
      lines.push(`  ${q.quarter}: ${fmtVal(q.total, "currency")}`);
    }
  }

  if (body.grandTotal != null) {
    lines.push(`\nGRAND TOTAL: ${fmtVal(body.grandTotal, "currency")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/** Resolve the Anthropic API key: DB integration row takes precedence over env var */
async function resolveApiKey(): Promise<string | null> {
  try {
    const row = await prisma.integration.findUnique({ where: { platform: "anthropic" } });
    if (row?.connected && row.accessToken) return decrypt(row.accessToken);
  } catch { /* ignore DB errors — fall through to env */ }
  return process.env.ANTHROPIC_API_KEY ?? null;
}

export async function POST(req: NextRequest) {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic AI is not connected. Go to Settings → Integrations and add your API key." },
      { status: 503 }
    );
  }

  const client = new Anthropic({ apiKey });

  let body: InsightRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.question?.trim()) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const context = buildContext(body);
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const systemPrompt = `You are a senior marketing analyst embedded inside a B2B marketing dashboard.
You have access to historical performance data for a specific metric card.
Today's date is ${today}.

You MUST respond with a single valid JSON object — no markdown fences, no prose outside the JSON. Use this exact schema:

{
  "summary": "2–3 sentence plain-English insight. Be specific: use exact numbers and name the trend.",
  "table": {                          // Include when showing comparisons, breakdowns, or ranked items
    "headers": ["Col1", "Col2", ...], // 2–4 columns max
    "rows":    [["val", "val"], ...]  // up to 8 rows, most important first
  },
  "forecast": {                       // Include only when the question asks about projections, pacing, or future performance
    "label":       "What is being forecast, e.g. Q2 2026 Revenue",
    "conservative": { "value": "$X", "note": "one short note on what drives this floor" },
    "base":         { "value": "$X", "note": "most likely outcome based on current trends" },
    "optimistic":   { "value": "$X", "note": "one short note on what could drive the upside" }
  }
}

Rules:
- Omit "table" or "forecast" keys entirely if they are not relevant to the question — do NOT include empty objects.
- table column headers and row values must be strings.
- Forecast values should be formatted as currency or numbers matching the card's format.
- Only use data from the context provided. Do not invent numbers.
- Conservative = 80% chance actual meets or exceeds this (lower bound). Base = 50/50. Optimistic = 20% chance of reaching (stretch).

DATA CONTEXT:
${context}`;

  try {
    const message = await client.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 400,
      system:     systemPrompt,
      messages:   [{ role: "user", content: body.question.trim() }],
    });

    const raw = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n")
      .trim();

    // Parse JSON — strip any accidental markdown fences
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let structured: unknown;
    try {
      structured = JSON.parse(jsonStr);
    } catch {
      // Fallback: return raw text as a plain summary so the UI still renders something
      structured = { summary: raw };
    }

    return NextResponse.json({ answer: structured });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
