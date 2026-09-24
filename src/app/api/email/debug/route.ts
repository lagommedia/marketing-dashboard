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

    // Fetch first page of emails
    const listRes = await fetch(`${HS_BASE}/marketing/v3/emails?limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listBody = await listRes.text();
    if (!listRes.ok) {
      return NextResponse.json({ step: "list", status: listRes.status, body: listBody.slice(0, 1000) });
    }

    const listData = tryParse(listBody);
    const allEmails = listData?.results ?? [];

    // Find a non-AUTOMATED email to test stats against
    const batchEmail = allEmails.find(
      (e: { type?: string; state?: string }) => e.type !== "AUTOMATED" && e.state !== "AUTOMATED"
    ) ?? allEmails[0];

    if (!batchEmail) {
      return NextResponse.json({ step: "list_empty", typesSeen: [], raw: listBody.slice(0, 500) });
    }

    // Fetch stats for that email
    const statsRes = await fetch(
      `${HS_BASE}/marketing/v3/emails/${batchEmail.id}/statistics/summary`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const statsBody = await statsRes.text();

    return NextResponse.json({
      email_types_in_page: allEmails.map((e: { id: string; name?: string; type?: string; state?: string }) => ({
        id: e.id, name: e.name, type: e.type, state: e.state,
      })),
      testing_email: { id: batchEmail.id, name: batchEmail.name, type: batchEmail.type, state: batchEmail.state },
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
