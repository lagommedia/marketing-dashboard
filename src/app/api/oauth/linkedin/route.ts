import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

const SCOPES = ["r_ads", "r_ads_reporting", "r_organization_social", "r_organization_admin"].join(" ");

export async function GET(_req: NextRequest) {
  const row = await prisma.integration.findUnique({ where: { platform: "linkedin" } });
  const clientId = row?.clientId ? decrypt(row.clientId) : process.env.LINKEDIN_CLIENT_ID;

  if (!clientId) {
    return NextResponse.json(
      { error: "LinkedIn Client ID not configured. Go to Integrations and enter your OAuth credentials first." },
      { status: 500 }
    );
  }

  const redirectUri = `${process.env.NEXTAUTH_URL}/api/oauth/linkedin/callback`;
  const state = Math.random().toString(36).slice(2);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: SCOPES,
  });

  return NextResponse.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
}
