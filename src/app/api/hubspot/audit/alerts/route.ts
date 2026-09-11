import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/hubspot/audit/alerts?dismissed=false&limit=50&alertType=sqo_attribution
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dismissed  = searchParams.get("dismissed") !== "true";  // default: undismissed only
  const alertType  = searchParams.get("alertType") ?? undefined;
  const limit      = Math.min(parseInt(searchParams.get("limit") ?? "100", 10), 200);
  const since      = searchParams.get("since"); // ISO date string

  const alerts = await prisma.hubspotAuditAlert.findMany({
    where: {
      dismissed: !dismissed ? undefined : false,
      ...(alertType ? { alertType } : {}),
      ...(since     ? { detectedAt: { gte: new Date(since) } } : {}),
    },
    orderBy: { detectedAt: "desc" },
    take: limit,
  });

  const total = await prisma.hubspotAuditAlert.count({
    where: { dismissed: false },
  });

  return NextResponse.json({ alerts, total });
}

// PATCH /api/hubspot/audit/alerts — dismiss one or all
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { id, dismissAll, alertType } = body;

  if (dismissAll) {
    const where = alertType ? { alertType } : {};
    const { count } = await prisma.hubspotAuditAlert.updateMany({
      where: { ...where, dismissed: false },
      data:  { dismissed: true },
    });
    return NextResponse.json({ dismissed: count });
  }

  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await prisma.hubspotAuditAlert.update({
    where: { id },
    data:  { dismissed: true },
  });
  return NextResponse.json({ ok: true });
}
