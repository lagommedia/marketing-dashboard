/**
 * Debug endpoint — tests Google Ads campaign name resolution.
 * Visit: GET /api/debug/google-ads-campaigns
 *
 * Also accepts ?ids=22594522054,23013863929 to check specific campaign IDs.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getValidGoogleToken } from "@/lib/sync/utils";

const BASE = "https://googleads.googleapis.com/v18";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const idsParam = searchParams.get("ids"); // optional: comma-separated campaign IDs to look up

  // ── Check integration status ──────────────────────────────────────────────
  const row = await prisma.integration.findUnique({ where: { platform: "google_ads" } });
  if (!row) return NextResponse.json({ error: "Google Ads integration row not found in DB" });

  const status = {
    connected:   row.connected,
    hasToken:    !!row.accessToken,
    tokenExpiry: row.tokenExpiry ?? null,
    customerId:  row.accountId ?? null,
    accountName: row.accountName ?? null,
  };

  // ── Try to get a valid token ──────────────────────────────────────────────
  let accessToken: string;
  try {
    accessToken = await getValidGoogleToken("google_ads");
  } catch (err) {
    return NextResponse.json({
      status,
      error: `Token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "";
  const customerId = row.accountId?.replace(/[^0-9]/g, "") ?? "";

  if (!customerId) {
    return NextResponse.json({ status, error: "No customer ID stored — enter it in Integrations → Google Ads" });
  }

  // ── Query all campaigns ───────────────────────────────────────────────────
  const gaql = `
    SELECT campaign.id, campaign.name, campaign.status
    FROM campaign
    ORDER BY campaign.id ASC
  `.trim();

  let campaigns: { id: string; name: string; status: string }[] = [];
  let queryError: string | null = null;

  try {
    const res = await fetch(`${BASE}/customers/${customerId}/googleAds:search`, {
      method: "POST",
      headers: {
        Authorization:     `Bearer ${accessToken}`,
        "developer-token": devToken,
        "Content-Type":    "application/json",
      },
      body: JSON.stringify({ query: gaql }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      queryError = `Google Ads ${res.status}: ${text.slice(0, 500)}`;
    } else {
      const json = await res.json();
      campaigns = (json.results ?? []).map((r: {
        campaign?: { id?: string | number; name?: string; status?: string }
      }) => ({
        id:     String(r.campaign?.id   ?? ""),
        name:   String(r.campaign?.name ?? ""),
        status: String(r.campaign?.status ?? ""),
      }));
    }
  } catch (err) {
    queryError = err instanceof Error ? err.message : String(err);
  }

  // ── Check specific IDs if provided ────────────────────────────────────────
  const lookupResults: Record<string, string | null> = {};
  if (idsParam) {
    const idMap = new Map(campaigns.map((c) => [c.id, c.name]));
    for (const id of idsParam.split(",").map((s) => s.trim())) {
      lookupResults[id] = idMap.get(id) ?? null;
    }
  }

  return NextResponse.json({
    status,
    devTokenPresent: !!devToken,
    customerId,
    queryError,
    totalCampaigns: campaigns.length,
    campaigns,          // full list
    ...(idsParam ? { lookupResults } : {}),
  });
}
