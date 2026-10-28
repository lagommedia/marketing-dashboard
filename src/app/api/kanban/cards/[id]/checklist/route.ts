import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: cardId } = await params;
  const body = await req.json();
  const { title, storyPoints, assigneeId } = body;

  if (!title?.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const count = await prisma.kanbanChecklistItem.count({ where: { cardId } });

  const item = await prisma.kanbanChecklistItem.create({
    data: {
      cardId,
      title:       title.trim(),
      storyPoints: storyPoints ?? null,
      assigneeId:  assigneeId  ?? null,
      position:    count,
    },
    include: { assignee: true },
  });

  return NextResponse.json(item, { status: 201 });
}
