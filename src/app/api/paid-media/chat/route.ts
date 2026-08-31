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

  if (!rows?.length) return "No data available.";

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
  const header = `Period | ${cols.map(c => c).join(" | ")}`;
  const rowLines = rows.map(r =>
    `${r.label} | ${cols.map(c => fmtVal(c, r[c])).join(" | ")}`
  );
  const avgLine = avg12 ? `12-period avg | ${cols.map(c => fmtVal(c, avg12[c])).join(" | ")}` : "";

  return `View: ${view}\n\n${header}\n${rowLines.join("\n")}${avgLine ? "\n" + avgLine : ""}`;
}

export async function POST(req: NextRequest) {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic AI is not connected. Add your API key under Integrations." },
      { status: 503 }
    );
  }

  let question: string, tableData: Record<string, unknown>, funnelData: Record<string, unknown> | null, summaryData: Record<string, unknown> | null, campaigns: unknown[] | null, rollingView: string, messages: Array<{ role: string; content: string }>;
  try {
    const body  = await req.json();
    question    = body.question    ?? "";
    tableData   = body.tableData   ?? {};
    funnelData  = body.funnelData  ?? null;
    summaryData = body.summaryData ?? null;
    campaigns   = body.campaigns   ?? null;
    rollingView = body.rollingView ?? "weekly";
    messages    = body.messages    ?? [];
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!question.trim()) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const tableText = formatTableForPrompt(tableData);

  const summaryText = summaryData ? `
## Campaign Summary (overall)
Spend: $${(summaryData.spend as number ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}
Impressions: ${(summaryData.impressions as number ?? 0).toLocaleString()}
Clicks: ${(summaryData.clicks as number ?? 0).toLocaleString()}
CTR: ${((summaryData.ctr as number ?? 0) * 100).toFixed(2)}%
CPC: $${(summaryData.cpc as number ?? 0).toFixed(2)}
Conversions: ${(summaryData.conversions as number ?? 0).toFixed(1)}
ROAS: ${summaryData.roas ? `${(summaryData.roas as number).toFixed(2)}×` : "N/A"}
` : "";

  const funnelText = funnelData ? `
## HubSpot Funnel Attribution (QTD)
Leads: ${funnelData.current ? (funnelData.current as Record<string, unknown>).leads ?? "—" : "—"}
MQLs: ${funnelData.current ? (funnelData.current as Record<string, unknown>).mqls ?? "—" : "—"}
SQOs: ${funnelData.current ? (funnelData.current as Record<string, unknown>).sqos ?? "—" : "—"}
Closed Won: ${funnelData.current ? (funnelData.current as Record<string, unknown>).closedWon ?? "—" : "—"}
` : "";

  const systemPrompt = `You are a Paid Media AI analyst for a B2B SaaS company using the google-ads-analyzer framework. You have full visibility into the user's Google Ads performance and HubSpot funnel attribution. Be concise (2-4 paragraphs), specific with numbers, and actionable.
${summaryText}
## Rolling Averages Table (${rollingView} view)
${tableText}
${funnelText}
## Analysis Guidelines
- IS metrics (Search Impr. Share, Top IS, Abs. Top IS) represent capture rate of available impressions (e.g. 0.75 = 75%)
- Lost IS (Rank) = lost due to poor Ad Rank/QS — fix bids and quality score first
- Lost IS (Budget) = lost because budget ran out — increase budget or reduce bids
- IS metrics are ONLY available for Search campaigns — Performance Max shows "—" by design
- For PMax campaigns, focus on Conversions, ROAS, and Cost/Conv. rather than IS metrics
- For Search campaigns, IS metrics are the primary diagnostic alongside Conversions and ROAS
- Invalid Clicks = bot/fraudulent clicks auto-filtered by Google — high numbers warrant investigation
- Never recommend increasing budget if Lost IS (Rank) > 50% — fix QS first
- Always compare current period vs prior periods and vs 12-period average
- Format key numbers in bold. Show calculations when helpful.`;

  const chatHistory = messages.map((m: { role: string; content: string }) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model:      "claude-sonnet-5",
    max_tokens: 1024,
    system:     systemPrompt,
    messages:   [...chatHistory, { role: "user", content: question }],
  });

  const textBlock = response.content.find(c => c.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text : "";
  return NextResponse.json({ answer: text });
}
