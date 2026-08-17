import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform } = await params;

  await prisma.integration.updateMany({
    where: { platform },
    data: {
      connected: false,
      accessToken: null,
      refreshToken: null,
      tokenSecret: null,
      tokenExpiry: null,
      accountId: null,
      accountName: null,
    },
  });

  return NextResponse.json({ ok: true });
}
