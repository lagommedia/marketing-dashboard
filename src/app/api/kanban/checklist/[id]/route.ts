import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { title, completed, storyPoints, assigneeId } = body;

  const item = await prisma.kanbanChecklistItem.update({
    where: { id },
    data: {
      ...(title      !== undefined && { title:       title.trim()       }),
      ...(completed  !== undefined && { completed                       }),
      ...(storyPoints !== undefined && { storyPoints: storyPoints ?? null }),
      ...(assigneeId !== undefined && { assigneeId:  assigneeId ?? null }),
    },
    include: { assignee: true },
  });

  return NextResponse.json(item);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.kanbanChecklistItem.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
