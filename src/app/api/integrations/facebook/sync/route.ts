import { NextRequest, NextResponse } from "next/server";
import { syncFacebook } from "@/lib/integrations/facebook";

export const dynamic    = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const days = Number(body.days ?? 30);
    const result = await syncFacebook(days);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[facebook:sync]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
