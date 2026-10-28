import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const sprints = await prisma.kanbanSprint.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      cards: {
        include: { assignee: true },
        orderBy: { position: "asc" },
      },
    },
  });
  return NextResponse.json(sprints);
}

export async function POST(req: Request) {
  const body = await req.json();
  const { name, goal, startDate, endDate } = body;

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const sprint = await prisma.kanbanSprint.create({
    data: {
      name:      name.trim(),
      goal:      goal?.trim() || null,
      startDate: startDate ? new Date(startDate) : null,
      endDate:   endDate   ? new Date(endDate)   : null,
      status:    "active",
    },
    include: { cards: { include: { assignee: true } } },
  });

  return NextResponse.json(sprint, { status: 201 });
}
