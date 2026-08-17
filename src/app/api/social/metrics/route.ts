/**
 * GET /api/social/metrics?days=30
 *
 * Returns per-platform organic metrics for LinkedIn, Facebook, Instagram.
 * Reads SocialOrganicSnapshot rows and checks Integration rows for connection status.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const SOCIAL_PLATFORMS = ["linkedin", "facebook", "instagram"] as const;
type SocialPlatform = typeof SOCIAL_PLATFORMS[number];

// Instagram shares the Facebook integration row
const INTEGRATION_KEY: Record<SocialPlatform, string> = {
  linkedin:  "linkedin",
  facebook:  "facebook",
  instagram: "facebook",
};

export async function GET(req: NextRequest) {
  const days = Math.min(Number(new URL(req.url).searchParams.get("days") ?? 30), 365);

  const from = new Date();
  from.setDate(from.getDate() - days);
  from.setHours(0, 0, 0, 0);

  const integrations = await prisma.integration.findMany({
    where:  { platform: { in: ["linkedin", "facebook"] } },
    select: { platform: true, connected: true, lastSyncedAt: true },
  });
  const intMap = new Map(integrations.map(r => [r.platform, r]));

  const rows = await prisma.socialOrganicSnapshot.findMany({
    where:   { platform: { in: [...SOCIAL_PLATFORMS] }, date: { gte: from } },
    orderBy: { date: "asc" },
  });

  const result: Record<string, unknown> = {};

  for (const platform of SOCIAL_PLATFORMS) {
    const intKey    = INTEGRATION_KEY[platform];
    const intRow    = intMap.get(intKey);
    const connected = intRow?.connected ?? false;
    const lastSyncedAt = intRow?.lastSyncedAt?.toISOString() ?? null;

    const pRows = rows.filter(r => r.platform === platform);

    if (pRows.length === 0) {
      result[platform] = { connected, lastSyncedAt, hasData: false, summary: null, dailySeries: [] };
      continue;
    }

    // Latest known follower count (most recent non-zero row)
    const latestFollowers = [...pRows].reverse().find(r => r.followers > 0)?.followers ?? 0;

    const totalImpressions = pRows.reduce((s, r) => s + r.impressions, 0);
    const totalReach       = pRows.reduce((s, r) => s + r.reach,       0);
    const totalEngagements = pRows.reduce((s, r) => s + r.engagements, 0);
    const totalClicks      = pRows.reduce((s, r) => s + r.clicks,      0);
    const totalProfileViews= pRows.reduce((s, r) => s + r.profileViews,0);

    const engagementRate = totalImpressions > 0 ? totalEngagements / totalImpressions : null;

    const dailySeries = pRows.map(r => ({
      date:         r.date.toISOString().slice(0, 10),
      impressions:  r.impressions,
      reach:        r.reach,
      engagements:  r.engagements,
      clicks:       r.clicks,
      profileViews: r.profileViews,
      followers:    r.followers,
    }));

    result[platform] = {
      connected,
      lastSyncedAt,
      hasData: true,
      summary: {
        followers:      latestFollowers,
        impressions:    totalImpressions,
        reach:          totalReach,
        engagements:    totalEngagements,
        clicks:         totalClicks,
        profileViews:   totalProfileViews,
        engagementRate,
      },
      dailySeries,
    };
  }

  return NextResponse.json({ days, platforms: result });
}
