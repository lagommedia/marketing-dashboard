import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

const SCOPES = ["openid", "profile", "r_organization_admin", "rw_organization_admin"].join(" ");

export async function GET(_req: NextRequest) {
  const row = await prisma.integration.findUnique({ where: { platform: "linkedin_organic" } });
  const clientId = row?.clientId ? decrypt(row.clientId) : null;

  if (!clientId) {
    return NextResponse.json(
      { error: "LinkedIn Organic Client ID not configured. Save your Community Management API credentials first." },
      { status: 500 }
    );
  }

  const redirectUri = `${process.env.NEXTAUTH_URL}/api/oauth/linkedin-organic/callback`;
  const state = Math.random().toString(36).slice(2);

  const params = new URLSearchParams({
    response_type: "code",
    client_id:     clientId,
    redirect_uri:  redirectUri,
    state,
    scope:         SCOPES,
  });

  return NextResponse.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
}
