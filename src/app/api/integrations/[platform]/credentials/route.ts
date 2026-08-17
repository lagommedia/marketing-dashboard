import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { PLATFORM_MAP } from "@/lib/platforms";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  try {
    const { platform } = await params;
    const config = PLATFORM_MAP[platform];

    if (!config || config.authMethod !== "oauth") {
      return NextResponse.json({ error: "Not an OAuth platform" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const { clientId, clientSecret, customerId, spreadsheetId, propertyId } = body as Record<string, string>;

    if (!clientId?.trim() || !clientSecret?.trim()) {
      return NextResponse.json({ error: "Client ID and Client Secret are required" }, { status: 422 });
    }

    // Strip dashes/spaces from Google Ads customer ID (e.g. "123-456-7890" → "1234567890")
    const cleanCustomerId = customerId?.replace(/[^0-9]/g, "") || null;

    // Each platform stores its primary ID as accountId:
    //   google_sheets      → spreadsheetId
    //   google_analytics   → propertyId
    //   google_ads         → customerId
    const resolvedAccountId =
      spreadsheetId?.trim() ||
      propertyId?.replace(/[^0-9]/g, "") ||
      cleanCustomerId ||
      null;

    await prisma.integration.upsert({
      where: { platform },
      create: {
        platform,
        connected: false,
        clientId:     encrypt(clientId.trim()),
        clientSecret: encrypt(clientSecret.trim()),
        ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
      },
      update: {
        clientId:     encrypt(clientId.trim()),
        clientSecret: encrypt(clientSecret.trim()),
        ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[credentials] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
