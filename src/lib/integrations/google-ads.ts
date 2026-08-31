/**
 * Google Ads sync
 *
 * Writes one MetricSnapshot per day per run:
 *   platform: "google_ads", channel: "paid_media"
 *   fields:   impressions, clicks, spend, cpc, ctr
 *
 * The daily sync covers the last 30 days (upserts, so re-running is safe).
 * The backfill export covers any arbitrary `from` → today.
 *
 * Customer ID discovery:
 *   If no accountId is stored (first run after OAuth), we call
 *   customers:listAccessibleCustomers and persist the first result.
 *
 * API: Google Ads REST v18
 *   POST /v18/customers/{id}/googleAds:search   (paginated GAQL)
 *   GET  /v18/customers:listAccessibleCustomers
 *
 * Rate limits: 15,000 ops/day (standard tier) — we use ~1-2/day.
 */

import { prisma } from "@/lib/db";
import { withRetry, getValidGoogleToken, delay } from "@/lib/sync/utils";

const BASE = "https://googleads.googleapis.com/v25";
const INTER_CALL_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// Main exports
// ---------------------------------------------------------------------------

export async function syncGoogleAds(): Promise<{ recordsCount: number }> {
  const { accessToken, customerId } = await getCredentials();

  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 30);

  const days = await syncGoogleAdsRange(accessToken, customerId, from, today);
  return { recordsCount: days };
}

export async function backfillGoogleAds(
  from: Date
): Promise<{ days: number; snapshots: number }> {
  const { accessToken, customerId } = await getCredentials();
  const days = await syncGoogleAdsRange(accessToken, customerId, from, new Date());
  return { days, snapshots: days };
}

// ---------------------------------------------------------------------------
// Core range sync — shared by daily sync and backfill
// ---------------------------------------------------------------------------

async function syncGoogleAdsRange(
  accessToken: string,
  customerId: string,
  from: Date,
  to: Date
): Promise<number> {
  const startDate = formatDate(from);
  const endDate   = formatDate(to);

  // Fetch every (campaign × day) row in the window
  const gaql = `
    SELECT
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status IN ('ENABLED', 'PAUSED')
  `.trim();

  const rows = await withRetry(
    () => fetchGoogleAdsReport(accessToken, customerId, gaql),
    { label: "google_ads:report" }
  );

  // Aggregate by date across all campaigns
  const byDate = new Map<string, { impressions: number; clicks: number; costMicros: number }>();
  for (const row of rows) {
    const date = row.segments?.date as string | undefined;
    if (!date) continue;
    const cur = byDate.get(date) ?? { impressions: 0, clicks: 0, costMicros: 0 };
    cur.impressions += Number(row.metrics?.impressions ?? 0);
    cur.clicks      += Number(row.metrics?.clicks      ?? 0);
    cur.costMicros  += Number(row.metrics?.costMicros  ?? 0);
    byDate.set(date, cur);
  }

  // Upsert one snapshot per day — pure DB writes, no API calls, no delay needed
  let count = 0;
  for (const [dateStr, data] of byDate) {
    const spend = data.costMicros / 1_000_000;
    const cpc   = data.clicks      > 0 ? spend / data.clicks           : null;
    const ctr   = data.impressions > 0 ? data.clicks / data.impressions : null;
    const dateKey = new Date(dateStr + "T00:00:00Z");

    await prisma.metricSnapshot.upsert({
      where: { date_platform_channel: { date: dateKey, platform: "google_ads", channel: "paid_media" } },
      create: { date: dateKey, platform: "google_ads", channel: "paid_media",
                impressions: data.impressions, clicks: data.clicks, spend, cpc, ctr },
      update: { impressions: data.impressions, clicks: data.clicks, spend, cpc, ctr },
    });
    count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Google Ads REST — GAQL search (paginated)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchGoogleAdsReport(
  accessToken: string,
  customerId: string,
  query: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const url = `${BASE}/customers/${customerId}/googleAds:search`;
  const devToken   = process.env.GOOGLE_ADS_DEVELOPER_TOKEN    ?? "";
  const loginCustId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any[] = [];
  let pageToken: string | undefined;

  do {
    const body: Record<string, unknown> = { query };
    if (pageToken) body.pageToken = pageToken;

    const headers: Record<string, string> = {
      Authorization:     `Bearer ${accessToken}`,
      "developer-token": devToken,
      "Content-Type":    "application/json",
    };
    if (loginCustId) headers["login-customer-id"] = loginCustId.replace(/[^0-9]/g, "");

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (res.status === 429) throw new Error("429 Google Ads rate limit — will retry");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google Ads ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    results.push(...(json.results ?? []));
    pageToken = json.nextPageToken ?? undefined;
    if (pageToken) await delay(INTER_CALL_DELAY_MS);
  } while (pageToken);

  return results;
}

// ---------------------------------------------------------------------------
// Per-campaign sync — populates CampaignDailySpend with full campaign breakdown
// ---------------------------------------------------------------------------

export async function syncCampaignData(fromDate?: Date): Promise<{ rows: number }> {
  const { accessToken, customerId } = await getCredentials();

  const today = new Date();
  const from = fromDate ?? new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startDate = formatDate(from);
  const endDate   = formatDate(today);

  const gaql = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.search_impression_share,
      metrics.search_top_impression_share,
      metrics.search_absolute_top_impression_share,
      metrics.search_rank_lost_impression_share,
      metrics.search_budget_lost_impression_share,
      metrics.invalid_clicks
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status IN ('ENABLED', 'PAUSED')
  `.trim();

  const rows = await withRetry(
    () => fetchGoogleAdsReport(accessToken, customerId, gaql),
    { label: "google_ads:campaign_report" }
  );

  let count = 0;
  const campaignNames = new Map<string, string>();

  for (const row of rows) {
    const campaignId   = String(row.campaign?.id   ?? "");
    const campaignName = String(row.campaign?.name ?? "");
    const dateStr = row.segments?.date as string | undefined;
    if (!campaignId || !dateStr) continue;

    const clicks          = Number(row.metrics?.clicks           ?? 0);
    const impressions     = Number(row.metrics?.impressions      ?? 0);
    const costMicros      = Number(row.metrics?.costMicros       ?? 0);
    const conversions     = Number(row.metrics?.conversions      ?? 0);
    const conversionValue = Number(row.metrics?.conversionsValue ?? 0);

    // Impression share metrics — Google returns these as decimals (0–1) or null
    function toIS(v: unknown): number | null {
      const n = Number(v);
      return isNaN(n) ? null : n;
    }
    const searchImprShare    = toIS(row.metrics?.searchImpressionShare);
    const searchTopIS        = toIS(row.metrics?.searchTopImpressionShare);
    const searchAbsTopIS     = toIS(row.metrics?.searchAbsoluteTopImpressionShare);
    const searchLostISRank   = toIS(row.metrics?.searchRankLostImpressionShare);
    const searchLostISBudget = toIS(row.metrics?.searchBudgetLostImpressionShare);

    const spend = costMicros / 1_000_000;
    const ctr   = impressions > 0 ? clicks / impressions : null;
    const cpc   = clicks      > 0 ? spend  / clicks      : null;

    const date = new Date(dateStr + "T00:00:00Z");

    const invalidClicks = Number(row.metrics?.invalidClicks ?? 0) || 0;
    const isFields = { searchImprShare, searchTopIS, searchAbsTopIS, searchLostISRank, searchLostISBudget, invalidClicks };

    await prisma.campaignDailySpend.upsert({
      where:  { campaignId_date: { campaignId, date } },
      create: { campaignId, campaignName, date, spend, clicks, impressions, conversions, conversionValue, ctr, cpc, ...isFields },
      update: { campaignName, spend, clicks, impressions, conversions, conversionValue, ctr, cpc, ...isFields },
    });

    if (campaignName) campaignNames.set(campaignId, campaignName);
    count++;
  }

  // Sync names into CampaignNameMap so HubSpot attribution can resolve them
  for (const [id, name] of campaignNames) {
    await prisma.campaignNameMap.upsert({
      where:  { campaignId: id },
      create: { campaignId: id, campaignName: name },
      update: { campaignName: name },
    });
  }

  console.log(`[google_ads] campaign sync wrote ${count} rows, ${campaignNames.size} unique campaigns`);
  return { rows: count };
}

// ---------------------------------------------------------------------------
// Campaign name map — campaign ID (string) → campaign name
// Used by HubSpot revenue breakdown to resolve utm_campaign IDs to readable names
// ---------------------------------------------------------------------------

/**
 * Returns a campaign ID → name map sourced from the manual mapping table.
 * Falls back gracefully to an empty map if the table has no entries.
 *
 * When a Google Ads developer token is available in the future this function
 * can be extended to merge DB entries with live API data.
 */
export async function getCampaignNameMap(): Promise<Map<string, string>> {
  const rows = await prisma.campaignNameMap.findMany();
  const map  = new Map<string, string>();
  for (const row of rows) {
    map.set(row.campaignId, row.campaignName);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Customer ID resolution
// ---------------------------------------------------------------------------

async function getCredentials(): Promise<{ accessToken: string; customerId: string }> {
  const accessToken = await getValidGoogleToken("google_ads");
  const row = await prisma.integration.findUnique({ where: { platform: "google_ads" } });

  // Google Ads customer IDs are ≤10 digits.
  // The OAuth callback may store the Google user ID (21 digits) as accountId —
  // treat anything >10 digits as invalid and fall through to discovery.
  const stored = row?.accountId?.replace(/[^0-9]/g, "") ?? "";
  let customerId = stored.length >= 1 && stored.length <= 10 ? stored : "";

  if (!customerId) {
    // Fallback: auto-discover via listAccessibleCustomers
    console.log("[google_ads] no valid customer ID stored — attempting auto-discovery…");
    customerId = await discoverCustomerId(accessToken);
    if (!customerId) {
      throw new Error(
        "No Google Ads customer ID found. " +
        "Go to Integrations → Google Ads → Edit credentials and enter your Customer ID " +
        "(found in the top-right of ads.google.com, format: XXX-XXX-XXXX)."
      );
    }
    await prisma.integration.update({
      where: { platform: "google_ads" },
      data: { accountId: customerId, accountName: `Google Ads ${customerId}` },
    });
    console.log(`[google_ads] discovered and stored customer ID: ${customerId}`);
  }

  return { accessToken, customerId };
}

async function discoverCustomerId(accessToken: string): Promise<string> {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "";
  if (!devToken) {
    console.warn(
      "[google_ads] GOOGLE_ADS_DEVELOPER_TOKEN is not set — " +
      "customer ID discovery will likely fail. Add it to your .env.local."
    );
  }

  const loginCustId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "";
  const discoverHeaders: Record<string, string> = {
    Authorization:     `Bearer ${accessToken}`,
    "developer-token": devToken,
  };
  if (loginCustId) discoverHeaders["login-customer-id"] = loginCustId.replace(/[^0-9]/g, "");

  const res = await fetch(`${BASE}/customers:listAccessibleCustomers`, {
    headers: discoverHeaders,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[google_ads] listAccessibleCustomers ${res.status}: ${text.slice(0, 200)}`);
    return "";
  }

  const json = await res.json();
  console.log("[google_ads] accessible customers:", json.resourceNames);
  // resourceNames look like ["customers/1234567890", ...]
  const first: string = json.resourceNames?.[0] ?? "";
  return first.replace("customers/", "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
