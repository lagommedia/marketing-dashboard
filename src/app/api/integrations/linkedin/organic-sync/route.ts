import { NextRequest, NextResponse } from "next/server";
import { syncLinkedinOrganic } from "@/lib/integrations/linkedin-organic";

export const dynamic     = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const days = Number(body.days ?? 30);
    const result = await syncLinkedinOrganic(days);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[linkedin:organic-sync]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
