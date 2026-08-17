import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/encryption";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code  = searchParams.get("code");
  const error = searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=linkedin_organic_oauth_denied`
    );
  }

  const row = await prisma.integration.findUnique({ where: { platform: "linkedin_organic" } });
  const clientId     = row?.clientId     ? decrypt(row.clientId)     : null;
  const clientSecret = row?.clientSecret ? decrypt(row.clientSecret) : null;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=linkedin_organic_missing_credentials`
    );
  }

  const redirectUri = `${process.env.NEXTAUTH_URL}/api/oauth/linkedin-organic/callback`;

  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      redirect_uri:  redirectUri,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(
      `${process.env.NEXTAUTH_URL}/integrations?error=linkedin_organic_token_exchange`
    );
  }

  const tokens = await tokenRes.json();
  const expiry  = new Date(Date.now() + tokens.expires_in * 1000);

  await prisma.integration.upsert({
    where:  { platform: "linkedin_organic" },
    create: {
      platform:     "linkedin_organic",
      connected:    true,
      accessToken:  encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      tokenExpiry:  expiry,
      scopes:       tokens.scope,
      accountName:  "LinkedIn Organic",
    },
    update: {
      connected:    true,
      accessToken:  encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      tokenExpiry:  expiry,
      scopes:       tokens.scope,
    },
  });

  return NextResponse.redirect(`${process.env.NEXTAUTH_URL}/integrations?success=linkedin_organic`);
}
