import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { name, goal, startDate, endDate, status } = body;

  const sprint = await prisma.kanbanSprint.update({
    where: { id },
    data: {
      ...(name      !== undefined && { name:      name.trim()            }),
      ...(goal      !== undefined && { goal:      goal?.trim() || null   }),
      ...(startDate !== undefined && { startDate: startDate ? new Date(startDate) : null }),
      ...(endDate   !== undefined && { endDate:   endDate   ? new Date(endDate)   : null }),
      ...(status    !== undefined && { status                            }),
      ...(status === "completed"  && { completedAt: new Date()           }),
    },
    include: {
      cards: {
        include: {
          assignee: true,
          checklist: { include: { assignee: true }, orderBy: { position: "asc" } },
        },
      },
    },
  });

  return NextResponse.json(sprint);
}
