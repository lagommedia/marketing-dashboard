/**
 * Facebook Page + Instagram Business Organic Analytics (Meta Graph API v26.0)
 *
 * API calls per sync:
 *   1. GET /me/accounts           — discover managed pages + their page access tokens
 *   2. GET /{page-id}/insights    — daily reach, impressions, engaged users, new fans
 *   3. GET /{page-id}?fields=instagram_business_account — discover connected IG account
 *   4. GET /{ig-user-id}/insights — daily Instagram reach, impressions, profile views
 *   5. GET /{ig-user-id}          — Instagram follower count
 *
 * Writes SocialOrganicSnapshot rows: platform="facebook" and platform="instagram"
 *
 * Required permissions:
 *   Facebook: pages_read_engagement, read_insights, pages_show_list
 *   Instagram: instagram_basic, instagram_manage_insights
 */

import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { withRetry, delay } from "@/lib/sync/utils";

const GRAPH = "https://graph.facebook.com/v26.0";
const DELAY_MS = 500;

export async function syncFacebookOrganic(days = 30): Promise<{ recordsCount: number }> {
  const row = await prisma.integration.findUnique({ where: { platform: "facebook" } });
  if (!row?.accessToken) throw new Error("Facebook not connected — add credentials in Integrations.");
  const userToken = decrypt(row.accessToken);

  // ── Discover pages ────────────────────────────────────────────────────────
  const pages = await withRetry(() => fetchPages(userToken), { label: "facebook:pages" });
  if (pages.length === 0) {
    throw new Error(
      "No Facebook Pages found for this account. " +
      "Make sure the token has pages_show_list and pages_read_engagement permissions."
    );
  }
  await delay(DELAY_MS);

  const today    = new Date();
  const since    = new Date(today);
  since.setDate(since.getDate() - days);
  const sinceUnix = Math.floor(since.getTime() / 1000);
  const untilUnix = Math.floor(today.getTime() / 1000);

  let count = 0;

  for (const page of pages) {
    // ── Facebook Page insights ─────────────────────────────────────────────
    try {
      const fbStats = await withRetry(
        () => fetchPageInsights(page.accessToken, page.id, sinceUnix, untilUnix),
        { label: `facebook:page-insights:${page.id}` }
      );
      await delay(DELAY_MS);

      const fanCount = await withRetry(
        () => fetchPageFanCount(page.accessToken, page.id),
        { label: `facebook:fans:${page.id}` }
      ).catch(() => 0);
      await delay(DELAY_MS);

      for (const stat of fbStats) {
        const isToday = stat.date.toDateString() === today.toDateString();
        await prisma.socialOrganicSnapshot.upsert({
          where:  { platform_date: { platform: "facebook", date: stat.date } },
          create: {
            platform:    "facebook",
            date:        stat.date,
            followers:   isToday ? fanCount : 0,
            impressions: stat.impressions,
            reach:       stat.reach,
            engagements: stat.engagedUsers,
          },
          update: {
            followers:   isToday ? fanCount : undefined,
            impressions: stat.impressions,
            reach:       stat.reach,
            engagements: stat.engagedUsers,
          },
        });
        count++;
      }
    } catch (err) {
      console.warn(`[facebook:organic] page ${page.id} insights failed:`, err instanceof Error ? err.message : err);
    }

    // ── Instagram Business insights ────────────────────────────────────────
    try {
      const igId = page.instagramBusinessAccountId;
      if (!igId) {
        console.log(`[instagram:organic] no IG business account linked to page ${page.id}`);
      } else {
        const igStats = await withRetry(
          () => fetchIgInsights(page.accessToken, igId, sinceUnix, untilUnix),
          { label: `instagram:insights:${igId}` }
        );
        await delay(DELAY_MS);

        const igFollowers = await withRetry(
          () => fetchIgFollowers(page.accessToken, igId),
          { label: `instagram:followers:${igId}` }
        ).catch(() => 0);
        await delay(DELAY_MS);

        for (const stat of igStats) {
          const isToday = stat.date.toDateString() === today.toDateString();
          await prisma.socialOrganicSnapshot.upsert({
            where:  { platform_date: { platform: "instagram", date: stat.date } },
            create: {
              platform:     "instagram",
              date:         stat.date,
              followers:    isToday ? igFollowers : 0,
              impressions:  stat.impressions,
              reach:        stat.reach,
              profileViews: stat.profileViews,
            },
            update: {
              followers:    isToday ? igFollowers : undefined,
              impressions:  stat.impressions,
              reach:        stat.reach,
              profileViews: stat.profileViews,
            },
          });
          count++;
        }
      }
    } catch (err) {
      console.warn(`[instagram:organic] insights failed:`, err instanceof Error ? err.message : err);
    }
  }

  await prisma.integration.update({
    where: { platform: "facebook" },
    data:  { lastSyncedAt: new Date() },
  });

  return { recordsCount: count };
}

// ---------------------------------------------------------------------------
// Discover managed Facebook Pages
// ---------------------------------------------------------------------------

interface PageInfo {
  id:                         string;
  name:                       string;
  accessToken:                string;
  instagramBusinessAccountId: string | null;
}

async function fetchPages(userToken: string): Promise<PageInfo[]> {
  const res  = await gGet(`/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${userToken}`);
  const json = await res.json();

  return (json.data ?? []).map((p: Record<string, unknown>) => ({
    id:                         String(p.id ?? ""),
    name:                       String(p.name ?? ""),
    accessToken:                String(p.access_token ?? userToken),
    instagramBusinessAccountId: (p.instagram_business_account as { id?: string } | null)?.id ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Facebook Page daily insights — requires read_insights + pages_read_engagement
// ---------------------------------------------------------------------------

interface FbDayStat { date: Date; impressions: number; reach: number; engagedUsers: number }

async function fetchPageInsights(
  pageToken: string,
  pageId:    string,
  since:     number,
  until:     number,
): Promise<FbDayStat[]> {
  const metrics = "page_impressions,page_impressions_unique,page_engaged_users";
  const res  = await gGet(
    `/${pageId}/insights?metric=${metrics}&period=day&since=${since}&until=${until}&access_token=${pageToken}`
  );
  const json = await res.json();

  if (json.error) {
    throw new Error(`Facebook Page insights error (page ${pageId}): Meta ${json.error.code}: ${JSON.stringify(json.error)}`);
  }

  const byDate = new Map<string, FbDayStat>();

  for (const metricBlock of json.data ?? []) {
    const metricName = metricBlock.name as string;
    for (const point of metricBlock.values ?? []) {
      const dateStr = String(point.end_time ?? "").slice(0, 10);
      if (!dateStr) continue;
      const date = new Date(dateStr + "T00:00:00");
      const cur  = byDate.get(dateStr) ?? { date, impressions: 0, reach: 0, engagedUsers: 0 };
      const val  = Number(point.value ?? 0);
      if      (metricName === "page_impressions")        cur.impressions  = val;
      else if (metricName === "page_impressions_unique") cur.reach        = val;
      else if (metricName === "page_engaged_users")      cur.engagedUsers = val;
      byDate.set(dateStr, cur);
    }
  }

  return Array.from(byDate.values());
}

async function fetchPageFanCount(pageToken: string, pageId: string): Promise<number> {
  const res  = await gGet(`/${pageId}?fields=fan_count&access_token=${pageToken}`);
  const json = await res.json();
  return Number(json.fan_count ?? 0);
}

// ---------------------------------------------------------------------------
// Instagram Business daily insights
// ---------------------------------------------------------------------------

interface IgDayStat { date: Date; impressions: number; reach: number; profileViews: number }

async function fetchIgInsights(
  pageToken: string,
  igUserId:  string,
  since:     number,
  until:     number,
): Promise<IgDayStat[]> {
  const metrics = "impressions,reach,profile_views";
  const res  = await gGet(
    `/${igUserId}/insights?metric=${metrics}&period=day&since=${since}&until=${until}&access_token=${pageToken}`
  );
  const json = await res.json();

  const byDate = new Map<string, IgDayStat>();

  for (const metricBlock of json.data ?? []) {
    const metricName = metricBlock.name as string;
    for (const point of metricBlock.values ?? []) {
      const dateStr = String(point.end_time ?? "").slice(0, 10);
      if (!dateStr) continue;
      const date = new Date(dateStr + "T00:00:00");
      const cur  = byDate.get(dateStr) ?? { date, impressions: 0, reach: 0, profileViews: 0 };
      const val  = Number(point.value ?? 0);
      if      (metricName === "impressions")   cur.impressions  = val;
      else if (metricName === "reach")         cur.reach        = val;
      else if (metricName === "profile_views") cur.profileViews = val;
      byDate.set(dateStr, cur);
    }
  }

  return Array.from(byDate.values());
}

async function fetchIgFollowers(pageToken: string, igUserId: string): Promise<number> {
  const res  = await gGet(`/${igUserId}?fields=followers_count&access_token=${pageToken}`);
  const json = await res.json();
  return Number(json.followers_count ?? 0);
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function gGet(path: string): Promise<Response> {
  const res = await fetch(`${GRAPH}${path}`);
  if (res.status === 429) throw new Error("429 Meta rate limit — will retry");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Meta ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}
