/**
 * Facebook + Instagram Ads sync (Meta Graph API v26.0)
 *
 * Makes 2 daily-breakdown insight calls against the same Meta Ads account:
 *   1. Facebook placements → MetricSnapshot platform="facebook", channel="paid_media"
 *   2. Instagram placements → MetricSnapshot platform="instagram", channel="paid_media"
 *
 * Uses publisher_platform breakdown to split the spend correctly.
 * Rate limits: score-based (~200 calls/hour) — we use 2/sync, well within limit.
 */

import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { withRetry, delay } from "@/lib/sync/utils";

const GRAPH_API  = "https://graph.facebook.com/v26.0";
const DELAY_MS   = 500;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function syncFacebook(days = 30): Promise<{ recordsCount: number }> {
  const row = await prisma.integration.findUnique({ where: { platform: "facebook" } });
  if (!row?.accessToken) throw new Error("Facebook not connected");

  const token       = decrypt(row.accessToken);
  const adAccountId = row.tokenSecret
    ? decrypt(row.tokenSecret)
    : (row.accountId ?? "");

  if (!adAccountId) throw new Error("Facebook Ad Account ID not configured");

  let count = 0;

  // ── Facebook placements (daily) ──────────────────────────────────────────
  try {
    const fbDays = await withRetry(
      () => fetchDailyInsights(token, adAccountId, days, "facebook"),
      { label: "facebook:insights" }
    );
    await delay(DELAY_MS);

    for (const day of fbDays) {
      const { date, impressions, clicks, spend } = day;
      const cpc = clicks      > 0 ? spend / clicks       : null;
      const ctr = impressions > 0 ? clicks / impressions : null;
      await prisma.metricSnapshot.upsert({
        where:  { date_platform_channel: { date, platform: "facebook", channel: "paid_media" } },
        create: { date, platform: "facebook", channel: "paid_media", impressions, clicks, spend, cpc, ctr },
        update: { impressions, clicks, spend, cpc, ctr },
      });
      count++;
    }
  } catch (err) {
    console.warn("[facebook] insights failed:", err instanceof Error ? err.message : err);
  }

  // ── Instagram placements (daily) ─────────────────────────────────────────
  try {
    const igDays = await withRetry(
      () => fetchDailyInsights(token, adAccountId, days, "instagram"),
      { label: "instagram:insights" }
    );
    await delay(DELAY_MS);

    for (const day of igDays) {
      const { date, impressions, clicks, spend } = day;
      const cpc = clicks      > 0 ? spend / clicks       : null;
      const ctr = impressions > 0 ? clicks / impressions : null;
      await prisma.metricSnapshot.upsert({
        where:  { date_platform_channel: { date, platform: "instagram", channel: "paid_media" } },
        create: { date, platform: "instagram", channel: "paid_media", impressions, clicks, spend, cpc, ctr },
        update: { impressions, clicks, spend, cpc, ctr },
      });
      count++;
    }
  } catch (err) {
    console.warn("[instagram] insights failed:", err instanceof Error ? err.message : err);
  }

  await prisma.integration.update({
    where: { platform: "facebook" },
    data:  { lastSyncedAt: new Date() },
  });

  return { recordsCount: count };
}

// ---------------------------------------------------------------------------
// Meta Ads Insights — daily breakdown by publisher platform
// ---------------------------------------------------------------------------

interface DayRow { date: Date; impressions: number; clicks: number; spend: number }

async function fetchDailyInsights(
  token:      string,
  accountId:  string,
  days:       number,
  platform:   "facebook" | "instagram",
): Promise<DayRow[]> {
  const acct = accountId.startsWith("act_") ? accountId : `act_${accountId}`;

  const filtering = JSON.stringify([{
    field:    "publisher_platform",
    operator: "IN",
    value:    [platform],
  }]);

  const params = new URLSearchParams({
    fields:          "impressions,clicks,spend,date_start",
    date_preset:     `last_${days}_d`,
    time_increment:  "1",          // one row per day
    level:           "account",
    breakdowns:      "publisher_platform",
    filtering,
    access_token:    token,
  });

  const rows: DayRow[] = [];
  let url: string | null = `${GRAPH_API}/${acct}/insights?${params}`;

  while (url) {
    const res = await fetch(url);
    if (res.status === 429) throw new Error("429 Meta rate limit — will retry");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Meta ${res.status} [${platform}]: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    for (const el of json.data ?? []) {
      const dateStr = el.date_start as string | undefined;
      if (!dateStr) continue;
      const date = new Date(dateStr + "T00:00:00");
      rows.push({
        date,
        impressions: Number(el.impressions ?? 0),
        clicks:      Number(el.clicks      ?? 0),
        spend:       Number(el.spend       ?? 0),
      });
    }

    // Pagination
    url = json.paging?.next ?? null;
    if (url) await delay(DELAY_MS);
  }

  return rows;
}
