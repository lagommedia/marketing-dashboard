/**
 * LinkedIn Organic Page Analytics
 *
 * API calls per sync:
 *   1. GET /rest/organizationalEntityAcls  — discover organization URN (cached in accountId)
 *   2. GET /rest/organizationalEntityShareStatistics — daily page impressions, clicks, engagement
 *   3. GET /rest/networkSizes/{orgUrn}     — current follower count
 *
 * Writes SocialOrganicSnapshot rows: platform="linkedin"
 *
 * Required OAuth scopes: r_organization_social, r_liteprofile
 * LinkedIn-Version header: 202501
 */

import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { withRetry, delay } from "@/lib/sync/utils";

const API_BASE   = "https://api.linkedin.com";
const LI_VERSION = "202603";
const DELAY_MS   = 500;

export async function syncLinkedinOrganic(days = 30): Promise<{ recordsCount: number }> {
  // Token strategy: Marketing Developer Platform (ads) token has r_organization_social +
  // r_organization_admin and is NOT subject to Community Management API Development Tier
  // restrictions. Prefer it for API calls; fall back to the dedicated organic app token.
  const adsRow     = await prisma.integration.findUnique({ where: { platform: "linkedin" } });
  const organicRow = await prisma.integration.findUnique({ where: { platform: "linkedin_organic" } });

  const tokenRow = (adsRow?.accessToken ? adsRow : null) ?? organicRow;
  if (!tokenRow?.accessToken) throw new Error("LinkedIn not connected — connect LinkedIn Campaign Manager or LinkedIn Organic in Integrations.");
  const token = decrypt(tokenRow.accessToken);

  // ── Discover org URN ──────────────────────────────────────────────────────
  // Prefer manually saved URN (from either row's tokenSecret), then try API discovery.
  let orgUrn: string | null =
    (organicRow?.tokenSecret?.startsWith("urn:li:organization:") ? organicRow.tokenSecret : null)
    ?? (adsRow?.tokenSecret?.startsWith("urn:li:organization:") ? adsRow.tokenSecret : null);

  if (!orgUrn) {
    try {
      orgUrn = await withRetry(() => discoverOrgUrn(token), { label: "linkedin:org-discovery" });
    } catch {
      // Discovery fails without r_organization_admin scope
    }
    if (!orgUrn) {
      throw new Error(
        "Could not determine LinkedIn Company Page. " +
        "Enter your Company Page numeric ID in Integrations → Organic Social → LinkedIn."
      );
    }
    const saveRow = organicRow ?? adsRow;
    if (saveRow) {
      await prisma.integration.update({
        where: { platform: saveRow.platform as string },
        data:  { tokenSecret: orgUrn },
      });
    }
    await delay(DELAY_MS);
  }

  let count = 0;
  let shareStatsWarning: string | null = null;
  const today = new Date();
  const from  = new Date(today);
  from.setDate(from.getDate() - days);

  // ── Daily page share statistics (impressions, clicks, engagement) ─────────
  // Requires Community Management API Standard Tier. If the app is on Dev Tier
  // or lacks the product, LinkedIn returns 403 — we catch it and sync followers only.
  let shareStats: ShareStatDay[] = [];
  try {
    shareStats = await withRetry(
      () => fetchDailyShareStats(token, orgUrn!, from, today),
      { label: "linkedin:share-stats" }
    );
    await delay(DELAY_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403")) {
      shareStatsWarning =
        "Page impressions/reach/engagement require Community Management API Standard Tier. " +
        "Request an upgrade in your LinkedIn Developer App to unlock full analytics. " +
        "Follower count will still sync.";
    } else {
      throw err;
    }
  }

  // ── Current follower count ────────────────────────────────────────────────
  const followerCount = await withRetry(
    () => fetchFollowerCount(token, orgUrn!),
    { label: "linkedin:followers" }
  ).catch(() => 0);

  if (shareStats.length > 0) {
    // Full data: upsert one row per day with all metrics
    for (const stat of shareStats) {
      const isToday = stat.date.toDateString() === today.toDateString();
      await prisma.socialOrganicSnapshot.upsert({
        where:  { platform_date: { platform: "linkedin", date: stat.date } },
        create: {
          platform:    "linkedin",
          date:        stat.date,
          followers:   isToday ? followerCount : 0,
          impressions: stat.impressions,
          reach:       stat.uniqueImpressions,
          engagements: stat.engagements,
          clicks:      stat.clicks,
        },
        update: {
          followers:   isToday ? followerCount : undefined,
          impressions: stat.impressions,
          reach:       stat.uniqueImpressions,
          engagements: stat.engagements,
          clicks:      stat.clicks,
        },
      });
      count++;
    }
  } else if (followerCount > 0) {
    // Partial data: write today's follower count only
    await prisma.socialOrganicSnapshot.upsert({
      where:  { platform_date: { platform: "linkedin", date: today } },
      create: { platform: "linkedin", date: today, followers: followerCount, impressions: 0, reach: 0, engagements: 0, clicks: 0 },
      update: { followers: followerCount },
    });
    count++;
  }

  if (shareStatsWarning) {
    throw new Error(shareStatsWarning);
  }

  const updateRow = organicRow ?? adsRow;
  if (updateRow) {
    await prisma.integration.update({
      where: { platform: updateRow.platform as string },
      data:  { lastSyncedAt: new Date() },
    });
  }

  return { recordsCount: count };
}

// ---------------------------------------------------------------------------
// Discover org URN from admin roles
// ---------------------------------------------------------------------------

async function discoverOrgUrn(token: string): Promise<string | null> {
  const res = await liGet(
    token,
    "/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=5"
  );
  const json = await res.json();
  const first = json.elements?.[0];
  // field is "organizationTarget" in paginated responses, "organization" in single-item responses
  const urn = (first?.organizationTarget ?? first?.organization) as string | undefined;
  return urn ?? null;
}

// ---------------------------------------------------------------------------
// Daily share statistics
// ---------------------------------------------------------------------------

interface ShareStatDay {
  date:             Date;
  impressions:      number;
  uniqueImpressions:number;
  clicks:           number;
  engagements:      number;
}

async function fetchDailyShareStats(
  token:  string,
  orgUrn: string,
  from:   Date,
  to:     Date,
): Promise<ShareStatDay[]> {
  const params = new URLSearchParams({
    q:                       "organizationalEntity",
    organizationalEntity:    orgUrn,
    "timeIntervals.timeGranularityType": "DAY",
    "timeIntervals.timeRange.start":     String(from.getTime()),
    "timeIntervals.timeRange.end":       String(to.getTime()),
  });

  // Use v2 API — the /rest/ equivalent requires LinkedIn Partner API tier which
  // is gated behind a paid program. The v2 API predates this restriction.
  const res  = await liGetV2(token, `/v2/organizationalEntityShareStatistics?${params}`);
  const json = await res.json();

  const rows: ShareStatDay[] = [];
  for (const el of json.elements ?? []) {
    const ts = el.timeRange?.start;
    if (!ts) continue;
    const date = new Date(Number(ts));
    date.setHours(0, 0, 0, 0);
    const s = el.totalShareStatistics ?? {};
    rows.push({
      date,
      impressions:       Number(s.impressionCount        ?? 0),
      uniqueImpressions: Number(s.uniqueImpressionsCount ?? 0),
      clicks:            Number(s.clickCount             ?? 0),
      engagements:       Number(s.likeCount ?? 0) + Number(s.commentCount ?? 0) + Number(s.shareCount ?? 0),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Follower count
// ---------------------------------------------------------------------------

async function fetchFollowerCount(token: string, orgUrn: string): Promise<number> {
  const encoded = encodeURIComponent(orgUrn);
  const res  = await liGetV2(token, `/v2/networkSizes/${encoded}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`);
  const json = await res.json();
  return Number(json.firstDegreeSize ?? 0);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** v2 API — predates the LinkedIn Partner API tier restriction */
async function liGetV2(token: string, path: string): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization:               `Bearer ${token}`,
      "X-Restli-Protocol-Version": "2.0.0",
    },
  });
  if (res.status === 429) throw new Error("429 LinkedIn rate limit — will retry");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LinkedIn ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

async function liGet(token: string, path: string): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization:              `Bearer ${token}`,
      "LinkedIn-Version":         LI_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    },
  });
  if (res.status === 429) throw new Error("429 LinkedIn rate limit — will retry");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LinkedIn ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}
