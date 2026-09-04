/**
 * GET  /api/geo/prompts          — list all GeoPrompts
 * POST /api/geo/prompts          — create a new prompt { text, notes? }
 * PATCH  /api/geo/prompts?id=... — update text/notes
 * DELETE /api/geo/prompts?id=... — delete prompt + its mention snapshots
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const prompts = await prisma.geoPrompt.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json({ prompts });
}

export async function POST(req: NextRequest) {
  const { text, notes } = await req.json() as { text: string; notes?: string };
  if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
  const prompt = await prisma.geoPrompt.create({ data: { text: text.trim(), notes: notes?.trim() ?? null } });
  return NextResponse.json({ ok: true, prompt });
}

export async function PATCH(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { text, notes } = await req.json() as { text?: string; notes?: string };
  const data: Record<string, unknown> = {};
  if (text !== undefined)  data.text  = text.trim();
  if (notes !== undefined) data.notes = notes?.trim() ?? null;
  const prompt = await prisma.geoPrompt.update({ where: { id }, data });
  return NextResponse.json({ ok: true, prompt });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  // Remove associated snapshots first
  await prisma.aiMentionSnapshot.deleteMany({ where: { promptId: id } });
  await prisma.geoPrompt.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
