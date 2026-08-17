import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getValidGoogleToken } from "@/lib/sync/utils";

const BASE = "https://googleads.googleapis.com/v18";

export async function GET() {
  const row = await prisma.integration.findUnique({ where: { platform: "google_ads" } });
  if (!row) return NextResponse.json({ error: "No google_ads record in DB" });

  const stored = row.accountId?.replace(/[^0-9]/g, "") ?? "";
  const customerId = stored.length >= 1 && stored.length <= 10 ? stored : null;
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "";

  // ── Live API tests ────────────────────────────────────────────────────────
  let accessToken: string | null = null;
  let tokenError: string | null = null;
  try {
    accessToken = await getValidGoogleToken("google_ads");
  } catch (e) {
    tokenError = e instanceof Error ? e.message : String(e);
  }

  // Test 1: listAccessibleCustomers
  let customersResult: unknown = null;
  if (accessToken) {
    const r = await fetch(`${BASE}/customers:listAccessibleCustomers`, {
      headers: {
        Authorization:     `Bearer ${accessToken}`,
        "developer-token": devToken,
      },
    });
    const body = await r.text().catch(() => "");
    customersResult = {
      status: r.status,
      ok: r.ok,
      body: body.slice(0, 500),
    };
  }

  // Test 2: minimal GAQL search using stored customer ID
  let searchResult: unknown = null;
  if (accessToken && customerId) {
    const r = await fetch(`${BASE}/customers/${customerId}/googleAds:search`, {
      method: "POST",
      headers: {
        Authorization:     `Bearer ${accessToken}`,
        "developer-token": devToken,
        "Content-Type":    "application/json",
      },
      body: JSON.stringify({
        query: "SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1",
      }),
    });
    const body = await r.text().catch(() => "");
    searchResult = {
      status: r.status,
      ok: r.ok,
      url: `${BASE}/customers/${customerId}/googleAds:search`,
      body: body.slice(0, 500),
    };
  }

  return NextResponse.json({
    // DB state
    db: {
      connected:        row.connected,
      accountId_raw:    row.accountId,
      customerId_clean: customerId,
      passes_check:     !!customerId,
      accountName:      row.accountName,
      tokenExpiry:      row.tokenExpiry,
      hasAccessToken:   !!row.accessToken,
      hasRefreshToken:  !!row.refreshToken,
      hasClientId:      !!row.clientId,
      hasClientSecret:  !!row.clientSecret,
    },
    // Env
    env: {
      GOOGLE_ADS_DEVELOPER_TOKEN_set: !!devToken,
      GOOGLE_ADS_DEVELOPER_TOKEN_preview: devToken ? `${devToken.slice(0, 4)}…` : "(not set)",
    },
    // Live tests
    tokenError,
    listAccessibleCustomers: customersResult,
    searchTest:              searchResult,
  });
}

/** POST { "customerId": "XXX-XXX-XXXX" } — set the customer ID directly */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const raw = (body.customerId as string | undefined) ?? "";
  const customerId = raw.replace(/[^0-9]/g, "");

  if (!customerId || customerId.length > 10) {
    return NextResponse.json(
      { error: "Provide a valid Google Ads Customer ID (format: XXX-XXX-XXXX)" },
      { status: 400 }
    );
  }

  await prisma.integration.update({
    where: { platform: "google_ads" },
    data: { accountId: customerId },
  });

  return NextResponse.json({ ok: true, customerId });
}
