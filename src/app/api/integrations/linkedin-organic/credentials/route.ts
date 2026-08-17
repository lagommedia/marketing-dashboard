import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";

export async function POST(req: NextRequest) {
  const { clientId, clientSecret } = await req.json();
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "clientId and clientSecret are required" }, { status: 400 });
  }

  await prisma.integration.upsert({
    where:  { platform: "linkedin_organic" },
    create: {
      platform:     "linkedin_organic",
      connected:    false,
      clientId:     encrypt(clientId),
      clientSecret: encrypt(clientSecret),
    },
    update: {
      clientId:     encrypt(clientId),
      clientSecret: encrypt(clientSecret),
      connected:    false,
    },
  });

  return NextResponse.json({ ok: true });
}
