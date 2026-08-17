/**
 * Reddit Ads sync
 *
 * API calls per run: 2
 *   1. POST /api/v2.0/auth/token    — get app-level access token
 *   2. GET  /api/v2.0/accounts/{id}/campaigns/report — aggregate metrics
 *
 * Rate limits: 60 req/min — we use 2/day
 */

import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { withRetry, delay } from "@/lib/sync/utils";

const API_BASE = "https://ads-api.reddit.com";
const INTER_CALL_DELAY_MS = 500;

export async function syncReddit(): Promise<{ recordsCount: number }> {
  const row = await prisma.integration.findUnique({ where: { platform: "reddit" } });
  if (!row?.accessToken) throw new Error("Reddit credentials not found");

  const clientId = decrypt(row.accessToken);        // stored in accessToken field
  const clientSecret = decrypt(row.tokenSecret!);   // stored in tokenSecret field

  // ── Call 1: get app-level access token ───────────────────────────────────
  const appToken = await withRetry(
    () => getRedditToken(clientId, clientSecret),
    { label: "reddit:auth" }
  );

  await delay(INTER_CALL_DELAY_MS);

  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Get account ID if not stored
  let accountId = row.accountId;
  if (!accountId) {
    const accounts = await withRetry(
      () => fetchAccounts(appToken),
      { label: "reddit:accounts" }
    );
    if (accounts.length === 0) throw new Error("No Reddit ad accounts found");
    accountId = accounts[0].id;
    await prisma.integration.update({
      where: { platform: "reddit" },
      data: { accountId, accountName: accounts[0].name },
    });
    await delay(INTER_CALL_DELAY_MS);
  }

  // ── Call 2: fetch aggregate campaign report ───────────────────────────────
  const report = await withRetry(
    () => fetchReport(appToken, accountId!, thirtyDaysAgo, today),
    { label: "reddit:report" }
  );

  const impressions = report.impressions ?? 0;
  const clicks = report.clicks ?? 0;
  const spend = report.spend ?? 0;
  const cpc = clicks > 0 ? spend / clicks : null;
  const ctr = impressions > 0 ? clicks / impressions : null;

  const dateKey = startOfDay(today);

  await prisma.metricSnapshot.upsert({
    where: { date_platform_channel: { date: dateKey, platform: "reddit", channel: "paid_media" } },
    create: { date: dateKey, platform: "reddit", channel: "paid_media", impressions, clicks, spend, cpc, ctr },
    update: { impressions, clicks, spend, cpc, ctr },
  });

  return { recordsCount: 1 };
}

async function getRedditToken(clientId: string, clientSecret: string): Promise<string> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "MarketingDashboard/1.0",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Reddit auth ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Reddit auth error: ${json.error}`);
  return json.access_token;
}

async function fetchAccounts(token: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`${API_BASE}/api/v2.0/me/accounts`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "MarketingDashboard/1.0" },
  });
  if (!res.ok) throw new Error(`Reddit accounts ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((a: Record<string, unknown>) => ({
    id: String(a.id),
    name: String(a.name ?? "Reddit Account"),
  }));
}

async function fetchReport(
  token: string,
  accountId: string,
  start: Date,
  end: Date
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const params = new URLSearchParams({
    start_date: formatDate(start),
    end_date: formatDate(end),
    fields: "impressions,clicks,spend",
  });

  const res = await fetch(
    `${API_BASE}/api/v2.0/accounts/${accountId}/campaigns/report?${params}`,
    {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "MarketingDashboard/1.0" },
    }
  );

  if (res.status === 429) throw new Error("429 Reddit rate limit — will retry");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Reddit report ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.data ?? {};
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
