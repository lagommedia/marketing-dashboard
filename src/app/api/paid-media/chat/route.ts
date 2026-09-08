import { NextRequest, NextResponse } from "next/server";
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
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic AI is not connected. Add your API key under Integrations." },
      { status: 503 }
    );
  }

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
      attachment: Attachment | null;
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
    attachment      = body.attachment      ?? null;
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

  const systemPrompt = `You are a Paid Media AI analyst for a B2B SaaS company. You have full visibility into the user's Google Ads and HubSpot performance data below. The three active campaigns are: Performance Max (PMax, no IS metrics), S_Non-Brand (Search), and S_Brand (Search).
${summaryText}${campaignBreakdownText}
## Aggregate Rolling Averages Table (all campaigns combined, ${rollingView} view — most recent period first)
${tableText}
${campaignRollingText}${funnelText}
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

  // Build the last user message — inject attachment content blocks if present
  type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } }
    | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

  let lastUserContent: string | ContentBlock[] = question;
  if (attachment) {
    const blocks: ContentBlock[] = [];
    if (attachment.text) {
      blocks.push({ type: "text", text: `[Attached file: ${attachment.name}]\n\`\`\`\n${attachment.text}\n\`\`\`` });
    } else if (attachment.data) {
      if (attachment.mimeType === "application/pdf") {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: attachment.data } });
      } else if (attachment.mimeType.startsWith("image/")) {
        const mt = attachment.mimeType as ImageMediaType;
        blocks.push({ type: "image", source: { type: "base64", media_type: mt, data: attachment.data } });
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
