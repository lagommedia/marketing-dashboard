import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

const SCOPES = [
  "https://www.googleapis.com/auth/adwords",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "openid",
  "email",
  "profile",
].join(" ");

export async function GET(_req: NextRequest) {
  // Read client ID from DB first (entered via UI), fall back to env
  const row = await prisma.integration.findUnique({ where: { platform: "google_ads" } });
  const clientId = row?.clientId ? decrypt(row.clientId) : process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    return NextResponse.json(
      { error: "Google Client ID not configured. Go to Integrations and enter your OAuth credentials first." },
      { status: 500 }
    );
  }

  const redirectUri = `${process.env.NEXTAUTH_URL}/api/oauth/google/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
  });

  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
