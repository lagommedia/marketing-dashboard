import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=linkedin_oauth_denied`
    );
  }

  const { decrypt } = await import("@/lib/encryption");
  const row = await prisma.integration.findUnique({ where: { platform: "linkedin" } });
  const clientId = row?.clientId ? decrypt(row.clientId) : process.env.LINKEDIN_CLIENT_ID!;
  const clientSecret = row?.clientSecret ? decrypt(row.clientSecret) : process.env.LINKEDIN_CLIENT_SECRET!;
  const redirectUri = `${process.env.NEXTAUTH_URL}/api/oauth/linkedin/callback`;

  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=linkedin_token_exchange`
    );
  }

  const tokens = await tokenRes.json();
  const expiry = new Date(Date.now() + tokens.expires_in * 1000);

  // Fetch profile for account name
  const profileRes = await fetch("https://api.linkedin.com/v2/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await profileRes.json().catch(() => ({}));
  const name =
    `${profile.localizedFirstName ?? ""} ${profile.localizedLastName ?? ""}`.trim() ||
    "LinkedIn Account";

  await prisma.integration.upsert({
    where: { platform: "linkedin" },
    create: {
      platform: "linkedin",
      connected: true,
      accessToken: encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      tokenExpiry: expiry,
      scopes: tokens.scope,
      accountName: name,
    },
    update: {
      connected: true,
      accessToken: encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      tokenExpiry: expiry,
      scopes: tokens.scope,
      accountName: name,
    },
  });

  return NextResponse.redirect(`${process.env.NEXTAUTH_URL}/integrations?success=linkedin`);
}
