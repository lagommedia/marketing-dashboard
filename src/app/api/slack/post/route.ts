import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

async function resolveSlackToken(): Promise<string | null> {
  try {
    const row = await prisma.integration.findUnique({ where: { platform: "slack" } });
    if (row?.connected && row.accessToken) return decrypt(row.accessToken);
  } catch { /* fall through */ }
  return process.env.SLACK_BOT_TOKEN ?? null;
}

export async function POST(req: NextRequest) {
  const { channel, text, blocks } = await req.json();

  if (!channel || !text) {
    return NextResponse.json({ error: "channel and text are required" }, { status: 400 });
  }

  const token = await resolveSlackToken();
  if (!token) {
    return NextResponse.json(
      { error: "Slack is not connected. Add a SLACK_BOT_TOKEN to your environment or connect Slack in Settings → Integrations." },
      { status: 503 }
    );
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text, ...(blocks ? { blocks } : {}) }),
  });

  const data = await res.json();
  if (!data.ok) {
    return NextResponse.json({ error: data.error ?? "Slack API error" }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
