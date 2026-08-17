/**
 * LinkedIn sync — Ads + Organic Page Analytics
 *
 * Ads (Marketing Developer Platform):
 *   GET /rest/adAnalytics  — daily spend, impressions, clicks per day
 *   Writes MetricSnapshot rows: platform="linkedin", channel="paid_media"
 *
 * Organic Page (Organization Social API):
 *   GET /rest/organizationalEntityShareStatistics  — daily impressions, engagement
 *   GET /rest/networkSizes/{orgUrn}                — current follower count
 *   Writes MetricSnapshot rows: platform="linkedin", channel="organic"
 *
 * Rate limits: 100 calls/day per member — we use ~4/sync, well within limit
 * LinkedIn-Version header required since 2024: use latest stable (202501)
 */

import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { withRetry, delay } from "@/lib/sync/utils";

const API_BASE    = "https://api.linkedin.com";
const LI_VERSION  = "202508"; // LinkedIn API versioning via header
const DELAY_MS    = 500;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function syncLinkedin(days = 30): Promise<{ recordsCount: number }> {
  const row = await prisma.integration.findUnique({ where: { platform: "linkedin" } });
  if (!row?.accessToken) throw new Error("LinkedIn not connected");
  const token = decrypt(row.accessToken);

  const today = new Date();
  const from  = new Date(today);
  from.setDate(from.getDate() - days);

  // Resolve ad account ID
  let adAccountId = row.accountId;
  if (!adAccountId) {
    const accounts = await withRetry(() => fetchAdAccounts(token), { label: "linkedin:accounts" });
    if (accounts.length === 0) throw new Error("No LinkedIn ad accounts found");
    adAccountId = accounts[0].id;
    await prisma.integration.update({
      where: { platform: "linkedin" },
      data:  { accountId: adAccountId, accountName: accounts[0].name },
    });
    await delay(DELAY_MS);
  }

  let count = 0;

  // ── Ads: daily analytics ──────────────────────────────────────────────────
  try {
    const adDays = await withRetry(
      () => fetchDailyAdAnalytics(token, adAccountId!, from, today),
      { label: "linkedin:ad-analytics" }
    );
    await delay(DELAY_MS);

    for (const day of adDays) {
      const { date, impressions, clicks, spend } = day;
      const cpc = clicks      > 0 ? spend / clicks           : null;
      const ctr = impressions > 0 ? clicks / impressions     : null;
      await prisma.metricSnapshot.upsert({
        where:  { date_platform_channel: { date, platform: "linkedin", channel: "paid_media" } },
        create: { date, platform: "linkedin", channel: "paid_media", impressions, clicks, spend, cpc, ctr },
        update: { impressions, clicks, spend, cpc, ctr },
      });
      count++;
    }
  } catch (err) {
    console.warn("[linkedin] ad analytics failed:", err instanceof Error ? err.message : err);
  }

  // ── Organic: page impressions + engagement ────────────────────────────────
  // Requires r_organization_social scope and organization URN
  const orgUrn = row.accountName?.startsWith("urn:li:") ? row.accountName : null;
  if (orgUrn) {
    try {
      const orgDays = await withRetry(
        () => fetchDailyOrgAnalytics(token, orgUrn, from, today),
        { label: "linkedin:org-analytics" }
      );
      await delay(DELAY_MS);

      for (const day of orgDays) {
        const { date, impressions, clicks } = day;
        const ctr = impressions > 0 ? clicks / impressions : null;
        await prisma.metricSnapshot.upsert({
          where:  { date_platform_channel: { date, platform: "linkedin", channel: "organic" } },
          create: { date, platform: "linkedin", channel: "organic", impressions, clicks, ctr },
          update: { impressions, clicks, ctr },
        });
        count++;
      }
    } catch (err) {
      console.warn("[linkedin] org analytics failed (scope may not be granted):", err instanceof Error ? err.message : err);
    }
  }

  await prisma.integration.update({
    where: { platform: "linkedin" },
    data:  { lastSyncedAt: new Date() },
  });

  return { recordsCount: count };
}

// ---------------------------------------------------------------------------
// LinkedIn REST — Ad Accounts
// ---------------------------------------------------------------------------

async function fetchAdAccounts(token: string): Promise<{ id: string; name: string }[]> {
  const res = await liGet(token, "/rest/adAccounts?q=search&search.type.values[0]=BUSINESS&search.status.values[0]=ACTIVE");
  const json = await res.json();
  return (json.elements ?? []).map((e: Record<string, unknown>) => ({
    id:   String(e.id ?? ""),
    name: String(e.name ?? "LinkedIn Account"),
  }));
}

// ---------------------------------------------------------------------------
// LinkedIn REST — Daily Ad Analytics
// ---------------------------------------------------------------------------

interface DailyAdRow { date: Date; impressions: number; clicks: number; spend: number }

async function fetchDailyAdAnalytics(
  token:     string,
  accountId: string,
  from:      Date,
  to:        Date,
): Promise<DailyAdRow[]> {
  const params = new URLSearchParams({
    q:               "analytics",
    pivot:           "ACCOUNT",
    timeGranularity: "DAILY",
    accounts:        `List(urn:li:sponsoredAccount:${accountId})`,
    fields:          "impressions,clicks,costInLocalCurrency,dateRange",
    "dateRange.start.year":  String(from.getFullYear()),
    "dateRange.start.month": String(from.getMonth() + 1),
    "dateRange.start.day":   String(from.getDate()),
    "dateRange.end.year":    String(to.getFullYear()),
    "dateRange.end.month":   String(to.getMonth() + 1),
    "dateRange.end.day":     String(to.getDate()),
  });

  const res  = await liGet(token, `/rest/adAnalytics?${params}`);
  const json = await res.json();

  const rows: DailyAdRow[] = [];
  for (const el of json.elements ?? []) {
    const dr    = el.dateRange?.start;
    if (!dr) continue;
    const date  = new Date(dr.year, dr.month - 1, dr.day, 0, 0, 0);
    rows.push({
      date,
      impressions: Number(el.impressions ?? 0),
      clicks:      Number(el.clicks      ?? 0),
      spend:       Number(el.costInLocalCurrency ?? 0),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// LinkedIn REST — Daily Organic Page Analytics
// ---------------------------------------------------------------------------

interface DailyOrgRow { date: Date; impressions: number; clicks: number }

async function fetchDailyOrgAnalytics(
  token:  string,
  orgUrn: string,
  from:   Date,
  to:     Date,
): Promise<DailyOrgRow[]> {
  const params = new URLSearchParams({
    q:                   "organizationalEntity",
    organizationalEntity: orgUrn,
    timeIntervals:       JSON.stringify({
      timeGranularityType: "DAY",
      timeRange: {
        start: from.getTime(),
        end:   to.getTime(),
      },
    }),
  });

  const res  = await liGet(token, `/rest/organizationalEntityShareStatistics?${params}`);
  const json = await res.json();

  const rows: DailyOrgRow[] = [];
  for (const el of json.elements ?? []) {
    const ts = el.timeRange?.start;
    if (!ts) continue;
    const date = new Date(Number(ts));
    date.setHours(0, 0, 0, 0);
    const stats = el.totalShareStatistics ?? {};
    rows.push({
      date,
      impressions: Number(stats.impressionCount   ?? 0),
      clicks:      Number(stats.clickCount        ?? 0),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// LinkedIn fetch helper — injects auth + version headers
// ---------------------------------------------------------------------------

async function liGet(token: string, path: string): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization:    `Bearer ${token}`,
      "LinkedIn-Version": LI_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    },
  });
  if (res.status === 429) throw new Error("429 LinkedIn rate limit — will retry");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LinkedIn ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  return res;
}
