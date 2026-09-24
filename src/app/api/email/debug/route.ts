import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const HS_BASE = "https://api.hubapi.com";

function tryParse(text: string) {
  try { return JSON.parse(text); } catch { return text; }
}

export async function GET() {
  try {
    const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
    if (!row?.connected || !row.accessToken) {
      return NextResponse.json({ error: "HubSpot not connected" }, { status: 503 });
    }
    const token = decrypt(row.accessToken);

    // Fetch first email
    const listRes = await fetch(`${HS_BASE}/marketing/v3/emails?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listBody = await listRes.text();
    if (!listRes.ok) {
      return NextResponse.json({ step: "list", status: listRes.status, body: listBody.slice(0, 1000) });
    }

    const listData = tryParse(listBody);
    const firstEmail = listData?.results?.[0];
    if (!firstEmail) {
      return NextResponse.json({ step: "list_empty", raw: listBody.slice(0, 1000) });
    }

    // Fetch stats for that email
    const statsRes = await fetch(
      `${HS_BASE}/marketing/v3/emails/${firstEmail.id}/statistics/summary`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const statsBody = await statsRes.text();

    return NextResponse.json({
      email: {
        id: firstEmail.id,
        name: firstEmail.name ?? firstEmail.properties?.name,
        state: firstEmail.state ?? firstEmail.properties?.state,
      },
      stats_status: statsRes.status,
      stats_body: tryParse(statsBody),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
