import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const HS_BASE = "https://api.hubapi.com";

export async function GET() {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return NextResponse.json({ error: "HubSpot not connected" }, { status: 503 });
  }
  const token = decrypt(row.accessToken);

  // Fetch first email from the list
  const listRes = await fetch(`${HS_BASE}/marketing/v3/emails?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listBody = await listRes.text();
  if (!listRes.ok) {
    return NextResponse.json({ step: "list", status: listRes.status, body: listBody });
  }

  const listData = JSON.parse(listBody);
  const firstEmail = listData.results?.[0];
  if (!firstEmail) {
    return NextResponse.json({ step: "list", note: "no emails returned", raw: listData });
  }

  // Fetch stats for that email
  const statsRes = await fetch(`${HS_BASE}/marketing/v3/emails/${firstEmail.id}/statistics/summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const statsBody = await statsRes.text();

  return NextResponse.json({
    email: { id: firstEmail.id, name: firstEmail.name, properties: firstEmail.properties },
    stats: { status: statsRes.status, body: JSON.parse(statsBody.length > 0 ? statsBody : "{}") },
  });
}
