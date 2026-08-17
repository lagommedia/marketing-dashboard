import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "openid",
  "email",
].join(" ");

export async function GET(_req: NextRequest) {
  const row = await prisma.integration.findUnique({ where: { platform: "google_analytics" } });
  const clientId = row?.clientId ? decrypt(row.clientId) : null;

  if (!clientId) {
    return NextResponse.json(
      { error: "Google Client ID not configured. Enter your OAuth credentials first." },
      { status: 500 }
    );
  }

  const redirectUri = `${process.env.NEXTAUTH_URL}/api/oauth/google-analytics/callback`;

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: "code",
    scope:         SCOPES,
    access_type:   "offline",
    prompt:        "consent",
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  );
}
