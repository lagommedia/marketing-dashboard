import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoricalPeriod {
  label:     string;
  value:     number;
  isCurrent: boolean;
}

interface ForecastRequest {
  metric:         string;               // e.g. "Revenue (Closed Won)"
  format:         "currency" | "number";
  historicalData: HistoricalPeriod[];   // all 12 periods, oldest first
  currentTotal:   number;               // QTD actual value
  daysElapsed:    number;
  totalDays:      number;
  daysRemaining:  number;
  periodLabel:    string;               // e.g. "Q2 2026"
}

// ---------------------------------------------------------------------------
// API key helper (shared pattern with /api/ai/insight)
// ---------------------------------------------------------------------------

async function resolveApiKey(): Promise<string | null> {
  try {
    const row = await prisma.integration.findUnique({ where: { platform: "anthropic" } });
    if (row?.connected && row.accessToken) return decrypt(row.accessToken);
  } catch { /* fall through */ }
  return process.env.ANTHROPIC_API_KEY ?? null;
}

// ---------------------------------------------------------------------------
// Build a structured analytical context for Claude
// ---------------------------------------------------------------------------

function buildForecastContext(body: ForecastRequest): string {
  const { metric, format, historicalData, currentTotal, daysElapsed, totalDays, daysRemaining, periodLabel } = body;
  const isCurrency = format === "currency";

  const fmtV = (v: number) => {
    if (isCurrency) {
      if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
      if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
      return `$${v.toLocaleString()}`;
    }
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
    return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  };

  const lines: string[] = [];
  lines.push(`METRIC: ${metric}`);
  lines.push(`CURRENT PERIOD: ${periodLabel}`);
  lines.push(`PACING: ${fmtV(currentTotal)} QTD — day ${daysElapsed} of ${totalDays} (${Math.round((daysElapsed / totalDays) * 100)}% elapsed, ${daysRemaining} days remaining)`);

  lines.push(`\nHISTORICAL DATA (12 quarters, oldest → newest):`);
  const completed = historicalData.filter((p) => !p.isCurrent);
  for (const p of completed) {
    lines.push(`  ${p.label}: ${fmtV(p.value)}`);
  }
  lines.push(`  ${periodLabel} (current, QTD): ${fmtV(currentTotal)}`);

  // Pre-compute stats to help the AI
  const vals = completed.map((p) => p.value).filter((v) => v > 0);
  if (vals.length >= 2) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const stdDev = Math.sqrt(vals.map((v) => (v - avg) ** 2).reduce((a, b) => a + b, 0) / vals.length);
    lines.push(`\nSUMMARY STATS (completed quarters only):`);
    lines.push(`  Average:  ${fmtV(avg)}`);
    lines.push(`  Std dev:  ${fmtV(stdDev)}`);
    lines.push(`  Min:      ${fmtV(Math.min(...vals))}`);
    lines.push(`  Max:      ${fmtV(Math.max(...vals))}`);

    // YoY for same quarter last year (4 periods back)
    const curQ   = historicalData.at(-1);
    const yoyQ   = historicalData[historicalData.length - 5]; // same Q, prior year
    if (yoyQ && curQ) {
      const yoyPct = yoyQ.value > 0 ? ((currentTotal - yoyQ.value) / yoyQ.value) * 100 : null;
      lines.push(`\nYEAR-OVER-YEAR:`);
      lines.push(`  ${yoyQ.label} (same Q, prior year): ${fmtV(yoyQ.value)}`);
      lines.push(`  ${periodLabel} QTD:                 ${fmtV(currentTotal)}`);
      if (yoyPct != null) lines.push(`  YoY pacing delta:            ${yoyPct >= 0 ? "+" : ""}${yoyPct.toFixed(1)}%`);
    }

    // QoQ for same quarter type (e.g. all Q2s)
    const qLabel = periodLabel.split(" ")[0]; // "Q2"
    const sameQs = completed.filter((p) => p.label.startsWith(qLabel));
    if (sameQs.length >= 2) {
      lines.push(`\nSEASONALITY — ${qLabel} HISTORY:`);
      for (const p of sameQs) lines.push(`  ${p.label}: ${fmtV(p.value)}`);
      const qAvg = sameQs.reduce((a, p) => a + p.value, 0) / sameQs.length;
      const overallAvg = avg;
      const seasonalIdx = overallAvg > 0 ? qAvg / overallAvg : 1;
      lines.push(`  ${qLabel} seasonal index vs annual avg: ${(seasonalIdx * 100).toFixed(0)}%`);
    }

    // Recent growth trajectory (last 4 completed)
    if (vals.length >= 4) {
      const recent = vals.slice(-4);
      const growthRates: number[] = [];
      for (let i = 1; i < recent.length; i++) {
        if (recent[i - 1] > 0) growthRates.push((recent[i] - recent[i - 1]) / recent[i - 1]);
      }
      const avgGrowth = growthRates.reduce((a, b) => a + b, 0) / growthRates.length;
      lines.push(`\nRECENT MOMENTUM (last 4 completed quarters):`);
      lines.push(`  Average QoQ growth: ${(avgGrowth * 100 >= 0 ? "+" : "")}${(avgGrowth * 100).toFixed(1)}%`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic AI is not connected. Add your API key under Integrations." },
      { status: 503 }
    );
  }

  let body: ForecastRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const context = buildForecastContext(body);
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const systemPrompt = `You are a quantitative marketing analyst generating a data-driven end-of-quarter forecast.
Today is ${today}.

Using the provided historical data, you must:
1. Identify the seasonal pattern for the current quarter type (e.g. Q2 vs annual average)
2. Calculate the YoY growth rate using the same quarter last year
3. Assess whether current QTD pacing is ahead or behind the historical rate for this point in the quarter
4. Blend these signals — current pace projection, seasonal adjustment, and YoY trend — into a most-likely end-of-quarter estimate
5. Generate ASYMMETRIC confidence intervals based on historical variance:
   - "conservative": floor where there is ~80% probability actual results will meet or EXCEED this (i.e. the downside scenario)
   - "base": your best single-point estimate of the most likely final outcome
   - "optimistic": stretch goal where there is ~20% probability of achieving this (upside scenario)
   Note: the gap between base and optimistic does NOT need to equal the gap between conservative and base.

You MUST respond with ONLY this JSON (no markdown fences, no commentary outside the JSON):
{
  "conservative": <integer>,
  "base": <integer>,
  "optimistic": <integer>,
  "reasoning": "<2-3 sentences explaining the key signals: seasonality, YoY trend, and current pacing>"
}

DATA:
${context}`;

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 512,
      system:     systemPrompt,
      messages:   [{ role: "user", content: "Generate the end-of-quarter forecast." }],
    });

    const raw = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    let result: { conservative: number; base: number; optimistic: number; reasoning: string };
    try {
      result = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "AI returned unparseable response" }, { status: 500 });
    }

    // Sanity-check: values must be positive numbers
    if (
      typeof result.conservative !== "number" || result.conservative <= 0 ||
      typeof result.base         !== "number" || result.base         <= 0 ||
      typeof result.optimistic   !== "number" || result.optimistic   <= 0
    ) {
      return NextResponse.json({ error: "AI returned invalid forecast values" }, { status: 500 });
    }

    return NextResponse.json({
      conservative: Math.round(result.conservative),
      base:         Math.round(result.base),
      optimistic:   Math.round(result.optimistic),
      reasoning:    result.reasoning ?? "",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI forecast failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
