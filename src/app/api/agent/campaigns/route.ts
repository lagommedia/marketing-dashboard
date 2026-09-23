/**
 * GET /api/agent/campaigns?from=&to=&limit=200
 *
 * Google Ads performance by campaign with impression-share diagnostics, plus
 * the human change events logged for the same window — so a spend or CPC move
 * can be checked against "did someone change something" before it is blamed
 * on the market.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkAgentAuth, dateRange, ratio } from "@/lib/agent-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = checkAgentAuth(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const { from, to, fromStr, toStr } = dateRange(sp, 90);
  const limit = Math.min(parseInt(sp.get("limit") ?? "200", 10) || 200, 1000);

  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86_400_000);

  const [cur, prev, changes, names] = await Promise.all([
    prisma.campaignDailySpend.findMany({ where: { date: { gte: from, lte: to } } }),
    prisma.campaignDailySpend.findMany({ where: { date: { gte: prevFrom, lte: prevTo } } }),
    prisma.campaignChangeEvent.findMany({
      where: { changedAt: { gte: from, lte: to } },
      orderBy: { changedAt: "desc" },
      take: 200,
    }),
    prisma.campaignNameMap.findMany(),
  ]);

  const nameFor = new Map(names.map((n) => [n.campaignId, n.campaignName]));

  interface C {
    campaignId: string; campaignName: string | null;
    spend: number; clicks: number; impressions: number;
    conversions: number; conversionValue: number;
    isSum: number; isLostRankSum: number; isLostBudgetSum: number; isDays: number;
  }

  const roll = (rows: typeof cur) => {
    const m = new Map<string, C>();
    for (const r of rows) {
      const c = m.get(r.campaignId) ?? {
        campaignId: r.campaignId,
        campaignName: r.campaignName ?? nameFor.get(r.campaignId) ?? null,
        spend: 0, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0,
        isSum: 0, isLostRankSum: 0, isLostBudgetSum: 0, isDays: 0,
      };
      c.campaignName = c.campaignName ?? r.campaignName ?? nameFor.get(r.campaignId) ?? null;
      c.spend += r.spend;
      c.clicks += r.clicks;
      c.impressions += r.impressions;
      c.conversions += r.conversions;
      c.conversionValue += r.conversionValue;
      if (r.searchImprShare != null) {
        c.isSum += r.searchImprShare;
        c.isLostRankSum += r.searchLostISRank ?? 0;
        c.isLostBudgetSum += r.searchLostISBudget ?? 0;
        c.isDays += 1;
      }
      m.set(r.campaignId, c);
    }
    return m;
  };

  const curMap = roll(cur);
  const prevMap = roll(prev);

  const campaigns = [...curMap.values()]
    .sort((a, b) => b.spend - a.spend)
    .slice(0, limit)
    .map((c) => {
      const b = prevMap.get(c.campaignId);
      const cpc = ratio(c.spend, c.clicks);
      const prevCpc = b ? ratio(b.spend, b.clicks) : null;
      return {
        campaignId: c.campaignId,
        campaignName: c.campaignName,
        spend: c.spend,
        clicks: c.clicks,
        impressions: c.impressions,
        conversions: c.conversions,
        conversionValue: c.conversionValue,
        ctr: ratio(c.clicks, c.impressions),
        cpc,
        costPerConversion: ratio(c.spend, c.conversions),
        roas: ratio(c.conversionValue, c.spend),
        avgImprShare: c.isDays > 0 ? c.isSum / c.isDays : null,
        avgISLostRank: c.isDays > 0 ? c.isLostRankSum / c.isDays : null,
        avgISLostBudget: c.isDays > 0 ? c.isLostBudgetSum / c.isDays : null,
        spendDeltaPct: b && b.spend > 0 ? (c.spend - b.spend) / b.spend : null,
        cpcDeltaPct: cpc != null && prevCpc != null && prevCpc > 0 ? (cpc - prevCpc) / prevCpc : null,
      };
    });

  return NextResponse.json({
    ok: true,
    query: { from: fromStr, to: toStr, limit },
    comparedTo: { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) },
    campaigns,
    changeEvents: changes.map((c) => ({
      changedAt: c.changedAt.toISOString(),
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      resourceType: c.changeResourceType,
      operation: c.operation,
      user: c.userEmail,
      description: c.description,
      expectedOutcome: c.expectedOutcome,
    })),
    notes: [
      "Impression-share fields are null for non-Search campaigns (including Performance Max).",
      "conversionValue is what Google Ads attributes, on its own attribution model — it will not match HubSpot revenue.",
      "Check changeEvents before attributing a spend or CPC move to the market.",
    ],
  });
}
