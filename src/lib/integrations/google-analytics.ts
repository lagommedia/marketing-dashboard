/**
 * Google Analytics 4 sync — organic traffic by landing page.
 *
 * Writes one GaOrganicSnapshot per (date × pagePath) for the organic
 * traffic channel. Pulls the last 90 days by default; callers can pass
 * a custom `from` date for backfill.
 *
 * Auth: shared Google OAuth credentials — falls back to google_ads row
 *       credentials if the google_analytics row has none (same pattern as GSC).
 *
 * API: GA4 Data API v1beta
 *   POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport
 *
 * Rate limits: 10 concurrent requests, 1,000 req/min — we use 1 per sync.
 */

import { prisma } from "@/lib/db";
import { getValidGoogleToken, withRetry } from "@/lib/sync/utils";

const GA4_BASE = "https://analyticsdata.googleapis.com/v1beta/properties";

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function syncGoogleAnalytics(
  from?: Date
): Promise<{ rows: number }> {
  const { accessToken, propertyId } = await getCredentials();

  const start = from ?? daysAgo(90);
  const end   = new Date();

  const gaRows = await withRetry(
    () => fetchOrganicByPage(accessToken, propertyId, formatDate(start), formatDate(end)),
    { label: "ga4:organic" }
  );
  const count  = await upsertRows(gaRows);

  await prisma.integration.update({
    where: { platform: "google_analytics" },
    data:  { lastSyncedAt: new Date() },
  });

  return { rows: count };
}

// ---------------------------------------------------------------------------
// GA4 Data API fetch
// ---------------------------------------------------------------------------

interface GaRow {
  date:            string; // "YYYYMMDD"
  pagePath:        string;
  sessions:        number;
  users:           number;
  engagedSessions: number;
  bounceRate:      number | null;
  avgSessionSec:   number | null;
  conversions:     number;
}

async function fetchOrganicByPage(
  accessToken: string,
  propertyId:  string,
  startDate:   string,
  endDate:     string
): Promise<GaRow[]> {
  const url = `${GA4_BASE}/${propertyId}:runReport`;

  const body = {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "date" }, { name: "pagePath" }],
    metrics: [
      { name: "sessions" },
      { name: "totalUsers" },
      { name: "engagedSessions" },
      { name: "bounceRate" },
      { name: "averageSessionDuration" },
      { name: "conversions" },
    ],
    dimensionFilter: {
      filter: {
        fieldName: "sessionDefaultChannelGroup",
        stringFilter: { matchType: "EXACT", value: "Organic Search" },
      },
    },
    limit: 250000,
  };

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new Error(`429 GA4 rate limit${retryAfter ? ` — Retry-After: ${retryAfter}` : ""}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GA4 API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json() as {
    rows?: {
      dimensionValues: { value: string }[];
      metricValues:    { value: string }[];
    }[];
  };

  return (data.rows ?? []).map(row => {
    const [date, pagePath]                                                         = row.dimensionValues.map(d => d.value);
    const [sessions, users, engagedSessions, bounceRate, avgSessionSec, conversions] = row.metricValues.map(m => parseFloat(m.value));
    return {
      date,
      pagePath,
      sessions:        Math.round(sessions),
      users:           Math.round(users),
      engagedSessions: Math.round(engagedSessions),
      bounceRate:      isNaN(bounceRate)   ? null : bounceRate,
      avgSessionSec:   isNaN(avgSessionSec) ? null : avgSessionSec,
      conversions:     Math.round(conversions),
    };
  });
}

// ---------------------------------------------------------------------------
// DB upsert
// ---------------------------------------------------------------------------

async function upsertRows(rows: GaRow[]): Promise<number> {
  let count = 0;
  for (const row of rows) {
    // GA4 returns dates as "YYYYMMDD" — convert to ISO
    const dateStr = `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}`;
    const date    = new Date(dateStr + "T00:00:00Z");

    await prisma.gaOrganicSnapshot.upsert({
      where:  { date_pagePath: { date, pagePath: row.pagePath } },
      create: {
        date, pagePath: row.pagePath,
        sessions: row.sessions, users: row.users,
        engagedSessions: row.engagedSessions,
        bounceRate: row.bounceRate, avgSessionSec: row.avgSessionSec,
        conversions: row.conversions,
      },
      update: {
        sessions: row.sessions, users: row.users,
        engagedSessions: row.engagedSessions,
        bounceRate: row.bounceRate, avgSessionSec: row.avgSessionSec,
        conversions: row.conversions,
      },
    });
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

async function getCredentials(): Promise<{ accessToken: string; propertyId: string }> {
  const row = await prisma.integration.findUnique({ where: { platform: "google_analytics" } });

  if (!row?.connected) throw new Error("Google Analytics is not connected — authorise it under Integrations.");
  if (!row.accountId)  throw new Error("GA4 Property ID not set — reconnect Google Analytics and enter the Property ID.");

  const accessToken = await getValidGoogleToken("google_analytics");
  return { accessToken, propertyId: row.accountId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
