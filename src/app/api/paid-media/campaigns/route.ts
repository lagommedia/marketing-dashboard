/**
 * GET /api/paid-media/campaigns?days=30
 *
 * Returns per-campaign aggregated metrics from CampaignDailySpend,
 * plus a daily time series for the trend chart.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const days = Math.min(Number(new URL(req.url).searchParams.get("days") ?? 30), 365);

  const from = new Date();
  from.setDate(from.getDate() - days);
  from.setHours(0, 0, 0, 0);

  const rows = await prisma.campaignDailySpend.findMany({
    where: { date: { gte: from } },
    orderBy: { date: "asc" },
  });

  if (rows.length === 0) {
    return NextResponse.json({
      hasData: false,
      days,
      summary: { spend: 0, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0, ctr: null, cpc: null, roas: null },
      dailySeries: [],
      campaigns: [],
    });
  }

  // --- Per-campaign aggregates ---
  type CampaignAgg = {
    campaignId: string;
    campaignName: string;
    spend: number;
    clicks: number;
    impressions: number;
    conversions: number;
    conversionValue: number;
  };
  const byCampaign = new Map<string, CampaignAgg>();

  for (const row of rows) {
    const cur = byCampaign.get(row.campaignId) ?? {
      campaignId: row.campaignId,
      campaignName: row.campaignName ?? row.campaignId,
      spend: 0, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0,
    };
    cur.campaignName  = row.campaignName ?? cur.campaignName;
    cur.spend         += row.spend;
    cur.clicks        += row.clicks;
    cur.impressions   += row.impressions;
    cur.conversions   += row.conversions;
    cur.conversionValue += row.conversionValue;
    byCampaign.set(row.campaignId, cur);
  }

  const campaigns = Array.from(byCampaign.values())
    .map(c => ({
      ...c,
      ctr:  c.impressions > 0 ? c.clicks / c.impressions : null,
      cpc:  c.clicks      > 0 ? c.spend  / c.clicks      : null,
      roas: c.spend       > 0 && c.conversionValue > 0 ? c.conversionValue / c.spend : null,
    }))
    .sort((a, b) => b.spend - a.spend);

  // --- Daily series for trend chart ---
  type DayAgg = { spend: number; clicks: number; impressions: number };
  const byDay = new Map<string, DayAgg>();
  for (const row of rows) {
    const key = row.date.toISOString().slice(0, 10);
    const cur = byDay.get(key) ?? { spend: 0, clicks: 0, impressions: 0 };
    cur.spend       += row.spend;
    cur.clicks      += row.clicks;
    cur.impressions += row.impressions;
    byDay.set(key, cur);
  }
  const dailySeries = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, ...d }));

  // --- Overall summary ---
  const totalSpend          = campaigns.reduce((s, c) => s + c.spend, 0);
  const totalClicks         = campaigns.reduce((s, c) => s + c.clicks, 0);
  const totalImpressions    = campaigns.reduce((s, c) => s + c.impressions, 0);
  const totalConversions    = campaigns.reduce((s, c) => s + c.conversions, 0);
  const totalConversionValue = campaigns.reduce((s, c) => s + c.conversionValue, 0);

  const summary = {
    spend:           totalSpend,
    clicks:          totalClicks,
    impressions:     totalImpressions,
    conversions:     totalConversions,
    conversionValue: totalConversionValue,
    ctr:             totalImpressions > 0 ? totalClicks / totalImpressions : null,
    cpc:             totalClicks      > 0 ? totalSpend  / totalClicks      : null,
    roas:            totalSpend > 0 && totalConversionValue > 0 ? totalConversionValue / totalSpend : null,
  };

  return NextResponse.json({ hasData: true, days, summary, dailySeries, campaigns });
}
