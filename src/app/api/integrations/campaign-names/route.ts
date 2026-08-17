import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** GET /api/integrations/campaign-names — list all mappings */
export async function GET() {
  const rows = await prisma.campaignNameMap.findMany({
    orderBy: { campaignName: "asc" },
  });
  return NextResponse.json(rows);
}

/** POST /api/integrations/campaign-names — upsert a mapping */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    campaignId?: string;
    campaignName?: string;
  };

  const campaignId   = body.campaignId?.trim();
  const campaignName = body.campaignName?.trim();

  if (!campaignId || !campaignName) {
    return NextResponse.json(
      { error: "campaignId and campaignName are required" },
      { status: 422 }
    );
  }

  const row = await prisma.campaignNameMap.upsert({
    where:  { campaignId },
    create: { campaignId, campaignName },
    update: { campaignName },
  });

  return NextResponse.json(row);
}
