import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getValidGoogleToken } from "@/lib/sync/utils";

export const dynamic = "force-dynamic";

const GA4_BASE = "https://analyticsdata.googleapis.com/v1beta/properties";

// GA4 channel groups that count as "paid"
const PAID_CHANNELS = new Set([
  "Paid Search",
  "Paid Social",
  "Paid Video",
  "Paid Other",
  "Display",
]);

async function fetchGa4Sessions(
  accessToken: string,
  propertyId: string,
  fromStr: string,
  toStr: string,
): Promise<{ channel: string; sessions: number }[]> {
  const body = {
    dateRanges: [{ startDate: fromStr, endDate: toStr }],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }],
    limit: 50,
  };

  const res = await fetch(`${GA4_BASE}/${propertyId}:runReport`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GA4 API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
  };

  return (data.rows ?? []).map((row) => ({
    channel:  row.dimensionValues[0]?.value ?? "(not set)",
    sessions: parseInt(row.metricValues[0]?.value ?? "0", 10) || 0,
  }));
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from    = searchParams.get("from");
  const to      = searchParams.get("to");
  const channel = (searchParams.get("channel") ?? "all") as "all" | "paid" | "organic";

  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  try {
    const fromDate = new Date(from);
    const toEnd    = new Date(to);
    toEnd.setHours(23, 59, 59, 999);

    // ── Ad spend (always from Google Ads, regardless of channel) ─────────────
    let adSpend = 0;
    if (channel === "all" || channel === "paid") {
      const paidRows = await prisma.campaignDailySpend.findMany({
        where:  { date: { gte: fromDate, lte: toEnd } },
        select: { spend: true },
      });
      adSpend = paidRows.reduce((s, r) => s + r.spend, 0);
    }

    // ── Site visits via GA4 live API ─────────────────────────────────────────
    let paidVisits    = 0;
    let organicVisits = 0;
    let siteVisits    = 0;
    let ga4Error: string | null = null;

    const gaRow = await prisma.integration.findUnique({ where: { platform: "google_analytics" } });
    if (gaRow?.connected && gaRow.accountId) {
      try {
        const token   = await getValidGoogleToken("google_analytics");
        const rows    = await fetchGa4Sessions(token, gaRow.accountId, from, to);

        for (const { channel: ch, sessions } of rows) {
          if (ch === "Organic Search") organicVisits += sessions;
          if (PAID_CHANNELS.has(ch))   paidVisits    += sessions;
        }
        const totalSessions = rows.reduce((s, r) => s + r.sessions, 0);

        siteVisits =
          channel === "organic" ? organicVisits :
          channel === "paid"    ? paidVisits    :
          totalSessions;
      } catch (e) {
        ga4Error = e instanceof Error ? e.message : "GA4 unavailable";
        // Graceful fallback: paid = Google Ads clicks, organic = synced table
        if (channel === "all" || channel === "paid") {
          const paidRows = await prisma.campaignDailySpend.findMany({
            where:  { date: { gte: fromDate, lte: toEnd } },
            select: { clicks: true },
          });
          paidVisits = paidRows.reduce((s, r) => s + r.clicks, 0);
        }
        if (channel === "all" || channel === "organic") {
          const gaRows = await prisma.gaOrganicSnapshot.findMany({
            where:  { date: { gte: fromDate, lte: toEnd } },
            select: { sessions: true },
          });
          organicVisits = gaRows.reduce((s, r) => s + r.sessions, 0);
        }
        siteVisits = paidVisits + organicVisits;
      }
    } else {
      // GA4 not connected — fall back to old method
      if (channel === "all" || channel === "paid") {
        const paidRows = await prisma.campaignDailySpend.findMany({
          where:  { date: { gte: fromDate, lte: toEnd } },
          select: { clicks: true },
        });
        paidVisits = paidRows.reduce((s, r) => s + r.clicks, 0);
      }
      if (channel === "all" || channel === "organic") {
        const gaRows = await prisma.gaOrganicSnapshot.findMany({
          where:  { date: { gte: fromDate, lte: toEnd } },
          select: { sessions: true },
        });
        organicVisits = gaRows.reduce((s, r) => s + r.sessions, 0);
      }
      siteVisits = paidVisits + organicVisits;
    }

    // ── Funnel counts (channel-filtered HubSpot data) ─────────────────────────
    const channelValue =
      channel === "paid"    ? "paid_media" :
      channel === "organic" ? "organic"    : "all";

    const rows = await prisma.metricSnapshot.findMany({
      where: {
        date:    { gte: fromDate, lte: toEnd },
        channel: channelValue,
      },
    });

    const sum = (key: "leads" | "mqls" | "sqos" | "closedWon") =>
      rows.reduce((acc, r) => acc + ((r[key] as number | null) ?? 0), 0);

    return NextResponse.json({
      siteVisits,
      paidVisits,
      organicVisits,
      adSpend,
      leads:     sum("leads"),
      mqls:      sum("mqls"),
      sqls:      0,
      sqos:      sum("sqos"),
      sqds:      0,
      closedWon: sum("closedWon"),
      ...(ga4Error ? { ga4Warning: ga4Error } : {}),
    });
  } catch (e) {
    console.error("[funnel-counts]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
