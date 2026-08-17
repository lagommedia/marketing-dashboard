/**
 * Daily sync cron endpoint
 *
 * Trigger: Vercel Cron (vercel.json) or any external scheduler at 2am
 * All syncs run sequentially with a gap between each platform to be gentle
 * on rate limits. Total runtime: ~30 seconds max.
 *
 * Security: protected by CRON_SECRET header
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runSync } from "@/lib/sync/engine";
import { delay } from "@/lib/sync/utils";
import type { Platform } from "@/types";

const BETWEEN_PLATFORMS_DELAY_MS = 3000; // 3 seconds between each platform

export async function GET(req: NextRequest) {
  // Basic auth — Vercel Cron sends this automatically when set in vercel.json
  const authHeader = req.headers.get("authorization");
  const expectedSecret = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.CRON_SECRET && authHeader !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only sync connected platforms
  const connected = await prisma.integration.findMany({
    where: { connected: true },
    select: { platform: true },
  });

  const platforms = connected.map((r) => r.platform as Platform);

  if (platforms.length === 0) {
    return NextResponse.json({ ok: true, message: "No connected integrations to sync" });
  }

  const results: Record<string, { ok: boolean; skipped?: boolean; error?: string; records?: number }> = {};

  for (const platform of platforms) {
    console.log(`[cron] syncing ${platform}…`);
    const result = await runSync(platform, true); // force=true bypasses cooldown for scheduled runs
    results[platform] = {
      ok: result.ok,
      skipped: result.skipped,
      error: result.error,
      records: result.recordsCount,
    };

    // Pause between platforms — no need to rush
    if (platform !== platforms[platforms.length - 1]) {
      await delay(BETWEEN_PLATFORMS_DELAY_MS);
    }
  }

  console.log("[cron] daily sync complete", results);
  return NextResponse.json({ ok: true, synced: platforms.length, results });
}
