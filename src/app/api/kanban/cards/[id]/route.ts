import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { title, description, type, status, storyPoints, assigneeId, position } = body;

  const card = await prisma.kanbanCard.update({
    where: { id },
    data: {
      ...(title       !== undefined && { title:       title.trim()       }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(type        !== undefined && { type                             }),
      ...(status      !== undefined && { status                          }),
      ...(storyPoints !== undefined && { storyPoints                     }),
      ...(assigneeId  !== undefined && { assigneeId:  assigneeId || null }),
      ...(position    !== undefined && { position                        }),
    },
    include: { assignee: true },
  });

  return NextResponse.json(card);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.kanbanCard.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
