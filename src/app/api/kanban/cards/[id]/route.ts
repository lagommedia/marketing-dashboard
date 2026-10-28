import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const CARD_INCLUDE = {
  assignee: true,
  checklist: {
    include: { assignee: true },
    orderBy: { position: "asc" as const },
  },
};

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { title, description, type, status, blockedReason, priority, storyPoints, assigneeId, position, dueDate, sprintId } = body;

  const card = await prisma.kanbanCard.update({
    where: { id },
    data: {
      ...(title         !== undefined && { title:         title.trim()              }),
      ...(description   !== undefined && { description:   description?.trim() || null }),
      ...(type          !== undefined && { type                                     }),
      ...(status        !== undefined && { status                                   }),
      ...(blockedReason !== undefined && { blockedReason: blockedReason || null     }),
      ...(priority      !== undefined && { priority:      priority ?? null          }),
      ...(storyPoints   !== undefined && { storyPoints                              }),
      ...(assigneeId    !== undefined && { assigneeId:    assigneeId || null        }),
      ...(position      !== undefined && { position                                 }),
      ...(dueDate       !== undefined && { dueDate:       dueDate ? new Date(dueDate) : null }),
      ...(sprintId      !== undefined && { sprintId:      sprintId ?? null          }),
    },
    include: CARD_INCLUDE,
  });

  return NextResponse.json(card);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.kanbanCard.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
