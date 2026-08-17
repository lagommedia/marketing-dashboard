import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { syncAiMentions } from "@/lib/integrations/ai-mention-tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // OpenAI: ~8s + Gemini free tier: 24 calls × 4s = ~105s total

const COOLDOWN_HOURS = 6;

export async function POST(req: NextRequest) {
  const force = new URL(req.url).searchParams.get("force") === "true";

  if (!force) {
    // Check cooldown — don't re-fire 48 API calls if we already synced recently
    const latest = await prisma.aiMentionSnapshot.findFirst({
      orderBy: { syncedAt: "desc" },
      select:  { syncedAt: true },
    });
    if (latest) {
      const ageMs = Date.now() - latest.syncedAt.getTime();
      const cooldownMs = COOLDOWN_HOURS * 60 * 60 * 1000;
      if (ageMs < cooldownMs) {
        const nextAvailableAt = new Date(latest.syncedAt.getTime() + cooldownMs);
        return NextResponse.json({
          ok:             true,
          cooldown:       true,
          rows:           0,
          nextAvailableAt: nextAvailableAt.toISOString(),
          message:        `Already synced recently. Next sync available at ${nextAvailableAt.toLocaleTimeString()}.`,
        });
      }
    }
  }

  try {
    const result = await syncAiMentions();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ai-mention-sync]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
