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

export async function GET() {
  const cards = await prisma.kanbanCard.findMany({
    include: CARD_INCLUDE,
    orderBy: [{ type: "asc" }, { position: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(cards);
}

export async function POST(req: Request) {
  const body = await req.json();
  const { title, description, type, status, blockedReason, priority, storyPoints, assigneeId, dueDate, sprintId } = body;

  if (!title?.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const last = await prisma.kanbanCard.findFirst({
    where: { type: type ?? "backlog", status: status ?? "backlog" },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const card = await prisma.kanbanCard.create({
    data: {
      title:       title.trim(),
      description: description?.trim() || null,
      type:        type    ?? "backlog",
      status:      status  ?? "backlog",
      blockedReason: blockedReason ?? null,
      priority:    priority  ?? null,
      storyPoints: storyPoints ?? null,
      assigneeId:  assigneeId  ?? null,
      dueDate:     dueDate ? new Date(dueDate) : null,
      sprintId:    sprintId ?? null,
      position:    (last?.position ?? -1) + 1,
    },
    include: CARD_INCLUDE,
  });

  return NextResponse.json(card, { status: 201 });
}
