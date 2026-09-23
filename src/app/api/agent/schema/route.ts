/**
 * GET /api/agent/schema
 *
 * Self-describing entry point for the /mar-ops skill. Returns the live list of
 * agent endpoints, their parameters, which integrations are connected, how
 * fresh each dataset is, and the known caveats of each table.
 *
 * Call this FIRST on every run so the skill never reasons from a stale map of
 * the dashboard, and never reports numbers from a feed that stopped syncing.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkAgentAuth } from "@/lib/agent-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = checkAgentAuth(req);
  if (denied) return denied;

  const [integrations, gaLatest, gscLatest, msLatest, spendLatest, targets] =
    await Promise.all([
      prisma.integration.findMany({
        select: { platform: true, connected: true, lastSyncedAt: true, accountName: true },
        orderBy: { platform: "asc" },
      }),
      prisma.gaOrganicSnapshot.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
      prisma.gscQuerySnapshot.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
      prisma.metricSnapshot.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
      prisma.campaignDailySpend.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
      prisma.pacingTarget.findMany({ select: { period: true, channel: true }, orderBy: { period: "desc" }, take: 20 }),
    ]);

  const iso = (d: { date: Date } | null) => d?.date.toISOString().slice(0, 10) ?? null;

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),

    endpoints: [
      { path: "/api/agent/schema",    params: [],                                               returns: "this document" },
      { path: "/api/agent/funnel",    params: ["from", "to", "channel", "granularity"],         returns: "sessions→leads→MQL→SQO→closed won per period, with stage conversion rates and spend" },
      { path: "/api/agent/channels",  params: ["from", "to"],                                   returns: "the same funnel split by channel and platform, plus spend, revenue, pipeline, CAC" },
      { path: "/api/agent/ga4",       params: ["from", "to", "dimensions", "metrics", "limit", "channelGroup"], returns: "LIVE GA4 Data API passthrough — any dimension/metric combination, not just what is synced" },
      { path: "/api/agent/pages",     params: ["from", "to", "limit"],                          returns: "organic sessions, engagement and conversions per landing page, joined to GSC query data" },
      { path: "/api/agent/campaigns", params: ["from", "to", "limit"],                          returns: "Google Ads daily spend by campaign with impression share, plus logged human change events" },
      { path: "/api/agent/pacing",    params: ["period"],                                       returns: "quarterly targets vs actuals by channel, and org assumptions (ARPU, gross margin, churn)" },
    ],

    integrations: integrations.map((i) => ({
      platform: i.platform,
      connected: i.connected,
      account: i.accountName,
      lastSyncedAt: i.lastSyncedAt?.toISOString() ?? null,
      staleDays: i.lastSyncedAt
        ? Math.floor((Date.now() - i.lastSyncedAt.getTime()) / 86_400_000)
        : null,
    })),

    freshness: {
      gaOrganicSnapshot: iso(gaLatest),
      gscQuerySnapshot: iso(gscLatest),
      metricSnapshot: iso(msLatest),
      campaignDailySpend: iso(spendLatest),
    },

    pacingPeriods: [...new Set(targets.map((t) => t.period))],

    caveats: [
      "GaOrganicSnapshot is filtered to sessionDefaultChannelGroup = 'Organic Search' at sync time. For any other channel, or for device/geo/source-medium breakdowns, use /api/agent/ga4 — do not infer non-organic traffic from this table.",
      "Paid site visits come from Google Ads clicks, not GA4 sessions. Clicks and sessions are not the same unit — never add them and call the result sessions.",
      "MetricSnapshot rows are unique on (date, platform, channel). A channel=all row is a pre-aggregated total, not a sum of the other rows — never add 'all' to the named channels.",
      "CAC and GTM efficiency divide Gross Expenses (PacingTarget.targetSpend for channel=marketing_org) by the fraction of the quarter elapsed. A missing target for the period makes both null, not zero.",
      "HubSpot lifecycle counts are 'contacts created in range currently at stage X'. A contact that has since advanced is counted at its current stage, so recent periods shift as contacts progress — treat the last 2-3 weeks of MQL/SQO/Closed Won as provisional.",
      "GSC data lags roughly 2-3 days; GA4 conversions and HubSpot deal stages lag longer.",
    ],
  });
}
