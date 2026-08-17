import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/encryption";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code  = searchParams.get("code");
  const error = searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=google_analytics_oauth_denied`
    );
  }

  const row = await prisma.integration.findUnique({ where: { platform: "google_analytics" } });

  if (!row?.clientId || !row.clientSecret) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=google_analytics_missing_credentials`
    );
  }

  const clientId     = decrypt(row.clientId);
  const clientSecret = decrypt(row.clientSecret);
  const redirectUri  = `${process.env.NEXTAUTH_URL}/api/oauth/google-analytics/callback`;

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
      `${process.env.NEXTAUTH_URL}/integrations?error=google_analytics_token_exchange`
    );
  }

  const tokens = await tokenRes.json() as {
    access_token:   string;
    refresh_token?: string;
    expires_in:     number;
    scope:          string;
  };

  const expiry = new Date(Date.now() + tokens.expires_in * 1000);

  // Fetch Google account email for display
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const user = await userRes.json().catch(() => ({})) as { email?: string };

  // Fetch the GA4 property display name using the stored property ID
  let propertyName = user.email ?? "Google Analytics";
  if (row.accountId) {
    try {
      const propRes = await fetch(
        `https://analyticsadmin.googleapis.com/v1beta/properties/${row.accountId}`,
        { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      );
      if (propRes.ok) {
        const propData = await propRes.json() as { displayName?: string };
        if (propData.displayName) propertyName = propData.displayName;
      }
    } catch { /* non-fatal — fall back to email */ }
  }

  await prisma.integration.update({
    where: { platform: "google_analytics" },
    data: {
      connected:    true,
      accessToken:  encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined,
      tokenExpiry:  expiry,
      scopes:       tokens.scope,
      accountName:  propertyName,
      // accountId (propertyId) was saved during the credentials step — preserve it
    },
  });

  return NextResponse.redirect(
    `${process.env.NEXTAUTH_URL}/integrations?success=google_analytics`
  );
}
