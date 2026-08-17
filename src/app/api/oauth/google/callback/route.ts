import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=google_oauth_denied`
    );
  }

  // Read credentials from DB first, fall back to env
  const { decrypt } = await import("@/lib/encryption");
  const row = await prisma.integration.findUnique({ where: { platform: "google_ads" } });
  const clientId = row?.clientId ? decrypt(row.clientId) : process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = row?.clientSecret ? decrypt(row.clientSecret) : process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = `${process.env.NEXTAUTH_URL}/api/oauth/google/callback`;

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=google_token_exchange`
    );
  }

  const tokens = await tokenRes.json();
  const expiry = new Date(Date.now() + tokens.expires_in * 1000);

  // Fetch user info for account name
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const user = await userRes.json().catch(() => ({}));

  // Upsert both Google platforms with the same token set.
  // accountId is intentionally excluded from the update block:
  //   google_ads            → set via the credentials form (customer ID, ≤10 digits)
  //   google_search_console → auto-discovered on first sync (site URL)
  // Writing user.id (Google account ID, 21 digits) here would overwrite those values.
  for (const platform of ["google_ads", "google_search_console"]) {
    await prisma.integration.upsert({
      where: { platform },
      create: {
        platform,
        connected: true,
        accessToken:  encrypt(tokens.access_token),
        refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        tokenExpiry:  expiry,
        scopes:       tokens.scope,
        accountName:  user.email ?? "Google Account",
        // accountId intentionally omitted — set separately per platform
      },
      update: {
        connected: true,
        accessToken:  encrypt(tokens.access_token),
        refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        tokenExpiry:  expiry,
        scopes:       tokens.scope,
        accountName:  user.email ?? "Google Account",
        // accountId intentionally NOT updated — preserve existing customer ID / site URL
      },
    });
  }

  return NextResponse.redirect(`${process.env.NEXTAUTH_URL}/integrations?success=google`);
}
