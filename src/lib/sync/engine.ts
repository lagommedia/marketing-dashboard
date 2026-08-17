import { prisma } from "@/lib/db";
import type { Platform } from "@/types";

// Minimum time between manual syncs per platform (1 hour)
const COOLDOWN_MS = 60 * 60 * 1000;

// If a sync has been "running" for more than 10 minutes, treat it as stale
const STALE_LOCK_MS = 10 * 60 * 1000;

export interface SyncResult {
  ok: boolean;
  skipped?: boolean;
  skipReason?: string;
  recordsCount?: number;
  error?: string;
}

export async function runSync(platform: Platform, force = false): Promise<SyncResult> {
  const integration = await prisma.integration.findUnique({ where: { platform } });

  if (!integration?.connected) {
    return { ok: false, error: "Integration not connected" };
  }

  // ── 1. Stale lock cleanup ────────────────────────────────────────────────
  const staleCutoff = new Date(Date.now() - STALE_LOCK_MS);
  await prisma.syncLog.updateMany({
    where: {
      integrationId: integration.id,
      status: "running",
      startedAt: { lt: staleCutoff },
    },
    data: { status: "error", completedAt: new Date(), message: "Timed out (stale lock cleaned up)" },
  });

  // ── 2. Lock check — is a sync already running? ───────────────────────────
  const running = await prisma.syncLog.findFirst({
    where: { integrationId: integration.id, status: "running" },
  });
  if (running) {
    return { ok: true, skipped: true, skipReason: "Sync already in progress" };
  }

  // ── 3. Cooldown check (skip for forced/scheduled syncs) ──────────────────
  if (!force) {
    const cooldownCutoff = new Date(Date.now() - COOLDOWN_MS);
    const recent = await prisma.syncLog.findFirst({
      where: {
        integrationId: integration.id,
        status: "success",
        completedAt: { gte: cooldownCutoff },
      },
      orderBy: { completedAt: "desc" },
    });
    if (recent) {
      const minsAgo = Math.round((Date.now() - recent.completedAt!.getTime()) / 60000);
      return {
        ok: true,
        skipped: true,
        skipReason: `Last synced ${minsAgo} min ago — manual syncs are limited to once per hour`,
      };
    }
  }

  // ── 4. Acquire lock ───────────────────────────────────────────────────────
  const log = await prisma.syncLog.create({
    data: { integrationId: integration.id, status: "running" },
  });

  // ── 5. Run platform-specific sync ─────────────────────────────────────────
  try {
    const result = await dispatchSync(platform);

    await prisma.$transaction([
      prisma.integration.update({
        where: { platform },
        data: { lastSyncedAt: new Date() },
      }),
      prisma.syncLog.update({
        where: { id: log.id },
        data: {
          status: "success",
          completedAt: new Date(),
          message: `Synced ${result.recordsCount ?? 0} records`,
          recordsCount: result.recordsCount ?? 0,
        },
      }),
    ]);

    return { ok: true, recordsCount: result.recordsCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[sync:${platform}]`, message);

    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "error", completedAt: new Date(), message },
    });

    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Dispatch to platform-specific sync functions
// ---------------------------------------------------------------------------
async function dispatchSync(platform: Platform): Promise<{ recordsCount: number }> {
  switch (platform) {
    case "hubspot": {
      const { syncHubspot } = await import("@/lib/integrations/hubspot");
      return syncHubspot();
    }
    case "google_ads": {
      const { syncGoogleAds } = await import("@/lib/integrations/google-ads");
      return syncGoogleAds();
    }
    case "google_search_console": {
      const { syncSearchConsole } = await import("@/lib/integrations/google-search-console");
      return syncSearchConsole();
    }
    case "facebook": {
      const { syncFacebook } = await import("@/lib/integrations/facebook");
      return syncFacebook();
    }
    case "linkedin": {
      const { syncLinkedin } = await import("@/lib/integrations/linkedin");
      return syncLinkedin();
    }
    case "reddit": {
      const { syncReddit } = await import("@/lib/integrations/reddit");
      return syncReddit();
    }
    case "google_sheets": {
      const { syncGoogleSheets } = await import("@/lib/integrations/google-sheets");
      return syncGoogleSheets();
    }
    default:
      throw new Error(`No sync function for platform: ${platform}`);
  }
}
