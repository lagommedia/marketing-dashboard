import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const COLORS = [
  "#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6",
];

export async function GET() {
  const members = await prisma.kanbanMember.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json(members);
}

export async function POST(req: Request) {
  const body = await req.json();
  const { name, email } = body;

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const count = await prisma.kanbanMember.count();
  const color = COLORS[count % COLORS.length];

  const member = await prisma.kanbanMember.create({
    data: { name: name.trim(), email: email?.trim() || null, color },
  });
  return NextResponse.json(member, { status: 201 });
}
