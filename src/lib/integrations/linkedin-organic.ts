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
const LI_VERSION = "202508";
const DELAY_MS   = 500;

export async function syncLinkedinOrganic(days = 30): Promise<{ recordsCount: number }> {
  // Use the dedicated Community Management API app (linkedin_organic), falling back to
  // the main LinkedIn integration if credentials haven't been migrated yet.
  const row = await prisma.integration.findUnique({ where: { platform: "linkedin_organic" } })
    ?? await prisma.integration.findUnique({ where: { platform: "linkedin" } });
  if (!row?.accessToken) throw new Error("LinkedIn Organic not connected — save your Community Management API credentials and authorise in Integrations.");
  const token = decrypt(row.accessToken);

  // ── Discover org URN ──────────────────────────────────────────────────────
  // Prefer manually saved URN in tokenSecret; fall back to API discovery.
  // Discovery requires r_organization_admin (Community Management API product).
  let orgUrn: string | null =
    row.tokenSecret?.startsWith("urn:li:organization:") ? row.tokenSecret : null;

  if (!orgUrn) {
    try {
      orgUrn = await withRetry(() => discoverOrgUrn(token), { label: "linkedin:org-discovery" });
    } catch {
      // Discovery fails without Community Management API product — surface actionable message
    }
    if (!orgUrn) {
      throw new Error(
        "LinkedIn requires the Community Management API product to auto-discover your Company Page. " +
        "Either: (A) Add your Company Page ID in Integrations → Organic Social → LinkedIn, or " +
        "(B) Request the Community Management API product in your LinkedIn Developer App, then re-authorize."
      );
    }
    await prisma.integration.update({
      where: { platform: row.platform as string },
      data:  { tokenSecret: orgUrn },
    });
    await delay(DELAY_MS);
  }

  let count = 0;
  const today = new Date();
  const from  = new Date(today);
  from.setDate(from.getDate() - days);

  // ── Daily page share statistics (impressions, clicks, engagement) ─────────
  const shareStats = await withRetry(
    () => fetchDailyShareStats(token, orgUrn!, from, today),
    { label: "linkedin:share-stats" }
  );
  await delay(DELAY_MS);

  // ── Current follower count ────────────────────────────────────────────────
  const followerCount = await withRetry(
    () => fetchFollowerCount(token, orgUrn!),
    { label: "linkedin:followers" }
  ).catch(() => 0);

  // Upsert one row per day — put follower count on today only (API only gives total)
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

  await prisma.integration.update({
    where: { platform: row.platform as string },
    data:  { lastSyncedAt: new Date() },
  });

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

  const res  = await liGet(token, `/rest/organizationalEntityShareStatistics?${params}`);
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
  const res  = await liGet(token, `/rest/networkSizes/${encoded}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`);
  const json = await res.json();
  return Number(json.firstDegreeSize ?? 0);
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

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
