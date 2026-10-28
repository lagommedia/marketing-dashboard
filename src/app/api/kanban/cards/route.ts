import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const cards = await prisma.kanbanCard.findMany({
    include: { assignee: true },
    orderBy: [{ type: "asc" }, { position: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(cards);
}

export async function POST(req: Request) {
  const body = await req.json();
  const { title, description, type, status, storyPoints, assigneeId } = body;

  if (!title?.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  // Position = end of column
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
      storyPoints: storyPoints ?? null,
      assigneeId:  assigneeId  ?? null,
      position:    (last?.position ?? -1) + 1,
    },
    include: { assignee: true },
  });

  return NextResponse.json(card, { status: 201 });
}
