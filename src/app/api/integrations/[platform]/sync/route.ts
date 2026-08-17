import { NextRequest, NextResponse } from "next/server";
import { runSync } from "@/lib/sync/engine";
import type { Platform } from "@/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  try {
    const { platform } = await params;

    // force=true lets manual "Sync now" bypass the cooldown only when explicitly requested
    const body = await req.json().catch(() => ({}));
    const force = body.force === true;

    const result = await runSync(platform as Platform, force);

    if (result.skipped) {
      return NextResponse.json({ ok: true, skipped: true, reason: result.skipReason }, { status: 200 });
    }

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({ ok: true, recordsCount: result.recordsCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[sync route]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
