/**
 * Google Search Console sync
 *
 * Writes one MetricSnapshot per day per run:
 *   platform: "google_search_console", channel: "organic"
 *   fields:   impressions, clicks, ctr
 *
 * GSC has a 2-3 day data lag — the effective end date is always today minus 3 days.
 * The daily sync covers the last 30 days. The backfill export covers any `from` → today-3.
 *
 * Site URL discovery:
 *   If no accountId is stored (first run after OAuth), we call /webmasters/v3/sites
 *   and persist the first verified property automatically.
 *
 * API: Google Search Console v3
 *   POST /webmasters/v3/sites/{siteUrl}/searchAnalytics/query
 *   GET  /webmasters/v3/sites
 *
 * Rate limits: 1,200 req/min — we use 1-2/day.
 */

import { prisma } from "@/lib/db";
import { withRetry, getValidGoogleToken } from "@/lib/sync/utils";

const INTER_CALL_DELAY_MS = 300;
const GSC_LAG_DAYS = 3; // GSC data is typically 2-3 days behind

// ---------------------------------------------------------------------------
// Main exports
// ---------------------------------------------------------------------------

export async function syncSearchConsole(): Promise<{ recordsCount: number }> {
  const { accessToken, siteUrl } = await getCredentials();

  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 30);

  const days = await syncSearchConsoleRange(accessToken, siteUrl, from, today);
  return { recordsCount: days };
}

export async function backfillSearchConsole(
  from: Date
): Promise<{ days: number; snapshots: number }> {
  const { accessToken, siteUrl } = await getCredentials();
  const days = await syncSearchConsoleRange(accessToken, siteUrl, from, new Date());
  return { days, snapshots: days };
}

// ---------------------------------------------------------------------------
// Core range sync — shared by daily sync and backfill
// ---------------------------------------------------------------------------

async function syncSearchConsoleRange(
  accessToken: string,
  siteUrl: string,
  from: Date,
  to: Date
): Promise<number> {
  // Respect GSC data lag — never query past today-3
  const lagCutoff = new Date();
  lagCutoff.setDate(lagCutoff.getDate() - GSC_LAG_DAYS);
  const effectiveTo = to > lagCutoff ? lagCutoff : to;

  if (from > effectiveTo) {
    console.log("[gsc] from > effectiveTo after lag adjustment — nothing to fetch");
    return 0;
  }

  const rows = await withRetry(
    () => fetchSearchAnalyticsDaily(accessToken, siteUrl, formatDate(from), formatDate(effectiveTo)),
    { label: "gsc:analytics" }
  );

  let count = 0;
  for (const row of rows) {
    const dateStr = row.keys?.[0] as string | undefined; // first key = date (YYYY-MM-DD)
    if (!dateStr) continue;

    const impressions = Math.round(row.impressions ?? 0);
    const clicks      = Math.round(row.clicks      ?? 0);
    const ctr         = impressions > 0 ? clicks / impressions : null;
    const dateKey     = new Date(dateStr + "T00:00:00Z");

    await prisma.metricSnapshot.upsert({
      where: { date_platform_channel: { date: dateKey, platform: "google_search_console", channel: "organic" } },
      create: { date: dateKey, platform: "google_search_console", channel: "organic",
                impressions, clicks, ctr },
      update: { impressions, clicks, ctr },
    });
    count++;
    // Pure DB write — no delay needed here
  }

  console.log(`[gsc] wrote ${count} daily snapshots (${formatDate(from)} → ${formatDate(effectiveTo)})`);
  return count;
}

// ---------------------------------------------------------------------------
// GSC Search Analytics — by date
// ---------------------------------------------------------------------------

interface GscRow {
  keys:        string[];
  clicks:      number;
  impressions: number;
  ctr:         number;
  position:    number;
}

async function fetchSearchAnalyticsDaily(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string
): Promise<GscRow[]> {
  const encodedSite = encodeURIComponent(siteUrl);
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ["date"], // one row per day
        type:       "web",
        rowLimit:   25000,    // well above 365 days
      }),
    }
  );

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new Error(`429 GSC rate limit${retryAfter ? ` — Retry-After: ${retryAfter}` : ""}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GSC analytics ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.rows ?? [];
}

// ---------------------------------------------------------------------------
// Query-level sync — populates GscQuerySnapshot for pillar analysis
// ---------------------------------------------------------------------------

export async function syncSearchConsoleQueries(
  from: Date,
  to?: Date
): Promise<{ rows: number }> {
  const { accessToken, siteUrl } = await getCredentials();

  const lagCutoff = new Date();
  lagCutoff.setDate(lagCutoff.getDate() - GSC_LAG_DAYS);
  const effectiveTo = to && to < lagCutoff ? to : lagCutoff;

  if (from > effectiveTo) return { rows: 0 };

  const gscRows = await withRetry(
    () => fetchSearchAnalyticsByQuery(accessToken, siteUrl, formatDate(from), formatDate(effectiveTo)),
    { label: "gsc:queries" }
  );

  let count = 0;
  for (const row of gscRows) {
    const [dateStr, query] = row.keys as [string, string];
    if (!dateStr || !query) continue;
    const dateKey = new Date(dateStr + "T00:00:00Z");
    const clicks      = Math.round(row.clicks      ?? 0);
    const impressions = Math.round(row.impressions  ?? 0);
    const ctr         = impressions > 0 ? clicks / impressions : null;
    const position    = row.position ?? null;

    await prisma.gscQuerySnapshot.upsert({
      where: { date_query: { date: dateKey, query } },
      create: { date: dateKey, query, clicks, impressions, ctr, position },
      update: { clicks, impressions, ctr, position },
    });
    count++;
  }

  console.log(`[gsc:queries] wrote ${count} query rows (${formatDate(from)} → ${formatDate(effectiveTo)})`);
  return { rows: count };
}

async function fetchSearchAnalyticsByQuery(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string
): Promise<GscRow[]> {
  const encodedSite = encodeURIComponent(siteUrl);
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ["date", "query"],
        type:       "web",
        rowLimit:   25000,
      }),
    }
  );

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new Error(`429 GSC rate limit${retryAfter ? ` — Retry-After: ${retryAfter}` : ""}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GSC query analytics ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.rows ?? [];
}

// ---------------------------------------------------------------------------
// AI Overview sync — daily totals where Zeni appears inside a Google AI Overview
//
// GSC API constraint: searchAppearance cannot be combined with any other dimension.
// We use [date, searchAppearance] to get daily counts, then filter for AI_OVERVIEW.
// Per-query breakdown of AI Overview data is not available via the GSC API.
// ---------------------------------------------------------------------------

export async function syncAiOverviewQueries(
  from: Date,
  to?: Date
): Promise<{ rows: number }> {
  const { accessToken, siteUrl } = await getCredentials();

  const lagCutoff = new Date();
  lagCutoff.setDate(lagCutoff.getDate() - GSC_LAG_DAYS);
  const effectiveTo = to && to < lagCutoff ? to : lagCutoff;

  if (from > effectiveTo) return { rows: 0 };

  // GSC constraint: searchAppearance cannot be combined with ANY other dimension.
  // Workaround: run one request per week and store each week's AI Overview total.
  // This gives ~13 data points for a 90-day sparkline.
  const weeks: { weekStart: Date; weekEnd: Date }[] = [];
  const cursor = new Date(from);
  while (cursor <= effectiveTo) {
    const weekStart = new Date(cursor);
    const weekEnd   = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);
    if (weekEnd > effectiveTo) weekEnd.setTime(effectiveTo.getTime());
    weeks.push({ weekStart, weekEnd });
    cursor.setDate(cursor.getDate() + 7);
  }

  let count = 0;
  for (const { weekStart, weekEnd } of weeks) {
    if (weekStart > weekEnd) continue;
    const rows = await withRetry(
      () => fetchAiOverviewTotal(accessToken, siteUrl, formatDate(weekStart), formatDate(weekEnd)),
      { label: `gsc:ai-overview:${formatDate(weekStart)}` }
    );
    const aiRow = rows.find(r => (r.keys as string[])[0] === "AI_OVERVIEW");
    const clicks      = Math.round(aiRow?.clicks      ?? 0);
    const impressions = Math.round(aiRow?.impressions  ?? 0);
    const ctr         = impressions > 0 ? clicks / impressions : null;

    await prisma.gscAiOverviewDay.upsert({
      where:  { date: weekStart },
      create: { date: weekStart, clicks, impressions, ctr },
      update: { clicks, impressions, ctr },
    });
    count++;
    // Polite pacing — 13 calls over ~4 seconds stays well inside 1200 req/min
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[gsc:ai-overview] synced ${count} weekly buckets (${formatDate(from)} → ${formatDate(effectiveTo)})`);
  return { rows: count };
}

async function fetchAiOverviewTotal(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string
): Promise<GscRow[]> {
  const encodedSite = encodeURIComponent(siteUrl);
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate,
        endDate,
        // searchAppearance MUST be the only dimension — GSC rejects any combination
        dimensions: ["searchAppearance"],
        rowLimit: 50,
      }),
    }
  );

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new Error(`429 GSC rate limit${retryAfter ? ` — Retry-After: ${retryAfter}` : ""}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GSC AI Overview ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  return json.rows ?? [];
}

// ---------------------------------------------------------------------------
// Verified sites list (for auto-discovery)
// ---------------------------------------------------------------------------

async function fetchVerifiedSites(accessToken: string): Promise<{ siteUrl: string }[]> {
  const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`GSC sites list ${res.status}`);
  const json = await res.json();
  return json.siteEntry ?? [];
}

// ---------------------------------------------------------------------------
// Credential resolution (site URL discovery on first run)
// ---------------------------------------------------------------------------

async function getCredentials(): Promise<{ accessToken: string; siteUrl: string }> {
  const accessToken = await getValidGoogleToken("google_search_console");
  const row = await prisma.integration.findUnique({ where: { platform: "google_search_console" } });

  let siteUrl = row?.accountId ?? "";

  if (!siteUrl) {
    const sites = await withRetry(
      () => fetchVerifiedSites(accessToken),
      { label: "gsc:sites" }
    );
    if (sites.length === 0) {
      throw new Error(
        "No verified sites found in Google Search Console. " +
        "Add and verify your property at search.google.com/search-console, then re-sync."
      );
    }
    siteUrl = sites[0].siteUrl;
    await prisma.integration.update({
      where: { platform: "google_search_console" },
      data: { accountId: siteUrl, accountName: siteUrl },
    });
    console.log(`[gsc] discovered site: ${siteUrl}`);
  }

  return { accessToken, siteUrl };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
