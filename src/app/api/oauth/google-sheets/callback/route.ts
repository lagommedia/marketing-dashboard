import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/encryption";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code  = searchParams.get("code");
  const error = searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=google_sheets_oauth_denied`
    );
  }

  // Read credentials saved via the credentials form
  const row = await prisma.integration.findUnique({ where: { platform: "google_sheets" } });

  if (!row?.clientId || !row.clientSecret) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=google_sheets_missing_credentials`
    );
  }

  const clientId     = decrypt(row.clientId);
  const clientSecret = decrypt(row.clientSecret);
  const redirectUri  = `${process.env.NEXTAUTH_URL}/api/oauth/google-sheets/callback`;

  // Exchange auth code for access + refresh tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=google_sheets_token_exchange`
    );
  }

  const tokens = await tokenRes.json() as {
    access_token:  string;
    refresh_token?: string;
    expires_in:    number;
    scope:         string;
  };

  const expiry = new Date(Date.now() + tokens.expires_in * 1000);

  // Fetch the Google account email for display
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const user = await userRes.json().catch(() => ({})) as { email?: string };

  // Fetch the spreadsheet title using the stored spreadsheet ID
  let sheetTitle = "Google Sheet";
  if (row.accountId) {
    try {
      const sheetRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(row.accountId)}?fields=properties.title`,
        { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      );
      if (sheetRes.ok) {
        const sheetData = await sheetRes.json() as { properties?: { title?: string } };
        sheetTitle = sheetData.properties?.title ?? sheetTitle;
      }
    } catch { /* non-fatal — fall back to generic name */ }
  }

  await prisma.integration.update({
    where: { platform: "google_sheets" },
    data: {
      connected:    true,
      accessToken:  encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined,
      tokenExpiry:  expiry,
      scopes:       tokens.scope,
      accountName:  sheetTitle,
      // accountId (spreadsheetId) was saved during the credentials step — preserve it
    },
  });

  return NextResponse.redirect(
    `${process.env.NEXTAUTH_URL}/integrations?success=google_sheets`
  );
}
