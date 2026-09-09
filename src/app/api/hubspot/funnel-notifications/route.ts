import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const notifications = await prisma.funnelChangeNotification.findMany({
    where:   { dismissed: false },
    orderBy: { detectedAt: "desc" },
    take:    100,
  });
  return NextResponse.json({ notifications });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { id, dismissAll } = body as { id?: string; dismissAll?: boolean };

  if (dismissAll) {
    await prisma.funnelChangeNotification.updateMany({
      where: { dismissed: false },
      data:  { dismissed: true },
    });
    return NextResponse.json({ ok: true });
  }

  if (id) {
    await prisma.funnelChangeNotification.update({
      where: { id },
      data:  { dismissed: true },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "id or dismissAll required" }, { status: 400 });
}
