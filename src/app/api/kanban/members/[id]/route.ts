import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Unassign cards before deleting member
  await prisma.kanbanCard.updateMany({ where: { assigneeId: id }, data: { assigneeId: null } });
  await prisma.kanbanMember.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
