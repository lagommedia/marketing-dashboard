import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  const { orgId } = await req.json();
  if (!orgId || typeof orgId !== "string") {
    return NextResponse.json({ error: "orgId is required" }, { status: 400 });
  }

  const trimmed = orgId.trim().replace(/^urn:li:organization:/, "");
  if (!/^\d+$/.test(trimmed)) {
    return NextResponse.json(
      { error: "Invalid Company Page ID — should be a numeric ID like 12345678" },
      { status: 400 }
    );
  }

  const urn = `urn:li:organization:${trimmed}`;

  // Prefer the dedicated organic integration row; fall back to the ads row
  const organicRow = await prisma.integration.findUnique({ where: { platform: "linkedin_organic" } });
  const platform   = organicRow ? "linkedin_organic" : "linkedin";

  await prisma.integration.update({
    where: { platform },
    data:  { tokenSecret: urn },
  });

  return NextResponse.json({ ok: true, orgUrn: urn });
}
