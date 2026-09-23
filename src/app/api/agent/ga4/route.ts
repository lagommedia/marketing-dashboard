/**
 * GET /api/agent/ga4
 *
 * LIVE Google Analytics 4 passthrough (Data API v1beta runReport). This is the
 * skill's real GA4 connection: the synced GaOrganicSnapshot table only holds
 * Organic Search by landing page, whereas this route can ask GA4 for any
 * dimension/metric combination the property supports.
 *
 * Params
 *   from, to        YYYY-MM-DD (default: trailing 28 days)
 *   dimensions      comma-separated GA4 dimension API names
 *                   (default: date,sessionDefaultChannelGroup)
 *   metrics         comma-separated GA4 metric API names
 *                   (default: sessions,totalUsers,engagedSessions,bounceRate,conversions)
 *   channelGroup    optional exact filter on sessionDefaultChannelGroup
 *   limit           max rows (default 10000, hard cap 100000)
 *   compare         "true" → also return the immediately preceding window of
 *                   equal length as `previous`, for period-over-period reads
 *
 * READ-ONLY. Uses the dashboard's existing Google OAuth credentials.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getValidGoogleToken } from "@/lib/sync/utils";
import { checkAgentAuth, dateRange } from "@/lib/agent-auth";

export const dynamic = "force-dynamic";

const GA4_BASE = "https://analyticsdata.googleapis.com/v1beta/properties";

const DEFAULT_DIMENSIONS = "date,sessionDefaultChannelGroup";
const DEFAULT_METRICS = "sessions,totalUsers,engagedSessions,bounceRate,conversions";

interface ReportRows {
  rows: Record<string, string | number>[];
  rowCount: number;
  sampled: boolean;
}

async function runReport(
  accessToken: string,
  propertyId: string,
  startDate: string,
  endDate: string,
  dimensions: string[],
  metrics: string[],
  channelGroup: string | null,
  limit: number
): Promise<ReportRows> {
  const body: Record<string, unknown> = {
    dateRanges: [{ startDate, endDate }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit,
  };

  if (channelGroup) {
    body.dimensionFilter = {
      filter: {
        fieldName: "sessionDefaultChannelGroup",
        stringFilter: { matchType: "EXACT", value: channelGroup },
      },
    };
  }

  const res = await fetch(`${GA4_BASE}/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GA4 API error ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = (await res.json()) as {
    rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
    rowCount?: number;
    metadata?: { samplingMetadatas?: unknown[] };
  };

  const rows = (data.rows ?? []).map((row) => {
    const out: Record<string, string | number> = {};
    dimensions.forEach((d, i) => {
      const v = row.dimensionValues[i]?.value ?? "";
      // GA4 returns date as YYYYMMDD — normalise to ISO for joinability
      out[d] =
        d === "date" && /^\d{8}$/.test(v)
          ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
          : v;
    });
    metrics.forEach((m, i) => {
      const n = parseFloat(row.metricValues[i]?.value ?? "");
      out[m] = isNaN(n) ? 0 : n;
    });
    return out;
  });

  return {
    rows,
    rowCount: data.rowCount ?? rows.length,
    sampled: (data.metadata?.samplingMetadatas?.length ?? 0) > 0,
  };
}

export async function GET(req: NextRequest) {
  const denied = checkAgentAuth(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const { fromStr, toStr } = dateRange(sp, 28);

  const dimensions = (sp.get("dimensions") ?? DEFAULT_DIMENSIONS)
    .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 9);
  const metrics = (sp.get("metrics") ?? DEFAULT_METRICS)
    .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const channelGroup = sp.get("channelGroup");
  const limit = Math.min(parseInt(sp.get("limit") ?? "10000", 10) || 10000, 100000);
  const compare = sp.get("compare") === "true";

  try {
    const row = await prisma.integration.findUnique({ where: { platform: "google_analytics" } });
    if (!row?.connected) {
      return NextResponse.json(
        { error: "Google Analytics is not connected — authorise it under Integrations." },
        { status: 409 }
      );
    }
    if (!row.accountId) {
      return NextResponse.json(
        { error: "GA4 Property ID is not set on the google_analytics integration." },
        { status: 409 }
      );
    }

    const accessToken = await getValidGoogleToken("google_analytics");

    const current = await runReport(
      accessToken, row.accountId, fromStr, toStr, dimensions, metrics, channelGroup, limit
    );

    let previous: (ReportRows & { from: string; to: string }) | null = null;
    if (compare) {
      const start = new Date(`${fromStr}T00:00:00Z`);
      const end = new Date(`${toStr}T00:00:00Z`);
      const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
      const prevEnd = new Date(start.getTime() - 86_400_000);
      const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86_400_000);
      const pFrom = prevStart.toISOString().slice(0, 10);
      const pTo = prevEnd.toISOString().slice(0, 10);
      const rep = await runReport(
        accessToken, row.accountId, pFrom, pTo, dimensions, metrics, channelGroup, limit
      );
      previous = { ...rep, from: pFrom, to: pTo };
    }

    return NextResponse.json({
      ok: true,
      propertyId: row.accountId,
      query: { from: fromStr, to: toStr, dimensions, metrics, channelGroup, limit },
      rowCount: current.rowCount,
      sampled: current.sampled,
      rows: current.rows,
      previous,
      notes: [
        "Live GA4 read — not the synced table. Figures can differ slightly from a previous run as GA4 finalises data (typically 24-48h).",
        "sampled=true means GA4 estimated these numbers; say so rather than reporting them as exact.",
      ],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
