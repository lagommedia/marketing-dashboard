import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { PLATFORM_MAP } from "@/lib/platforms";
import type { Platform } from "@/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  try {
    const { platform } = await params;
    const config = PLATFORM_MAP[platform];

    if (!config) {
      return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
    }

    if (config.authMethod !== "token") {
      return NextResponse.json({ error: "This platform uses OAuth" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const { accessToken, tokenSecret } = body as Record<string, string>;

    if (!accessToken?.trim()) {
      return NextResponse.json({ error: "accessToken is required" }, { status: 422 });
    }

    // Verify the token before saving — platform-specific checks
    const verification = await verifyToken(platform as Platform, accessToken.trim(), tokenSecret?.trim());
    if (!verification.ok) {
      return NextResponse.json({ error: verification.error }, { status: 422 });
    }

    await prisma.integration.upsert({
      where: { platform },
      create: {
        platform,
        connected: true,
        accessToken: encrypt(accessToken.trim()),
        tokenSecret: tokenSecret?.trim() ? encrypt(tokenSecret.trim()) : null,
        accountId: verification.accountId,
        accountName: verification.accountName,
      },
      update: {
        connected: true,
        accessToken: encrypt(accessToken.trim()),
        tokenSecret: tokenSecret?.trim() ? encrypt(tokenSecret.trim()) : null,
        accountId: verification.accountId,
        accountName: verification.accountName,
      },
    });

    return NextResponse.json({ ok: true, accountName: verification.accountName });
  } catch (err) {
    console.error("[connect] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Platform-specific token verification
// ---------------------------------------------------------------------------

interface VerifyResult {
  ok: boolean;
  error?: string;
  accountId?: string;
  accountName?: string;
}

async function verifyToken(
  platform: Platform,
  accessToken: string,
  tokenSecret?: string
): Promise<VerifyResult> {
  try {
    switch (platform) {
      case "hubspot":
        return verifyHubspot(accessToken);
      case "facebook":
        return verifyFacebook(accessToken, tokenSecret);
      case "reddit":
        return verifyReddit(accessToken, tokenSecret);
      case "anthropic":
        return verifyAnthropic(accessToken);
      default:
        return { ok: true };
    }
  } catch {
    return { ok: false, error: "Verification request failed — check your credentials" };
  }
}

async function verifyHubspot(token: string): Promise<VerifyResult> {
  const res = await fetch("https://api.hubapi.com/account-info/v3/details", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    return { ok: false, error: "Invalid HubSpot token. Ensure the Private App token is correct and has the required scopes." };
  }

  const data = await res.json();
  return {
    ok: true,
    accountId: String(data.portalId ?? ""),
    accountName: data.uiDomain ?? data.companyName ?? "HubSpot Account",
  };
}

async function verifyFacebook(token: string, adAccountId?: string): Promise<VerifyResult> {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/me?fields=name,id&access_token=${token}`
  );

  if (!res.ok) {
    return { ok: false, error: "Invalid Facebook token. Ensure your System User token is active." };
  }

  const data = await res.json();
  return {
    ok: true,
    accountId: adAccountId ?? data.id,
    accountName: data.name ?? "Facebook Account",
  };
}

async function verifyAnthropic(apiKey: string): Promise<VerifyResult> {
  // Make a minimal API call to verify the key is valid
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (res.status === 401) {
    return { ok: false, error: "Invalid Anthropic API key. Make sure you copied the full key starting with sk-ant-." };
  }
  if (!res.ok) {
    return { ok: false, error: `Anthropic returned ${res.status} — check your key and try again.` };
  }

  return { ok: true, accountName: "Anthropic AI" };
}


async function verifyReddit(clientId: string, clientSecret?: string): Promise<VerifyResult> {
  if (!clientSecret) {
    return { ok: false, error: "Client Secret is required for Reddit." };
  }

  // Verify credentials by requesting an app-level token
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "MarketingDashboard/1.0",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    return { ok: false, error: "Invalid Reddit credentials. Check your Client ID and Secret." };
  }

  const data = await res.json();
  if (data.error) {
    return { ok: false, error: `Reddit error: ${data.error}` };
  }

  return { ok: true, accountId: clientId, accountName: "Reddit Ads Account" };
}
