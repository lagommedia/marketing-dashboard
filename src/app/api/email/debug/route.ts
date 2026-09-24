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

    // Fetch newest 20 emails (sort descending)
    const listRes = await fetch(
      `${HS_BASE}/marketing/v3/emails?limit=20&sort=-updatedAt`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const listBody = await listRes.text();
    if (!listRes.ok) {
      return NextResponse.json({ step: "list", status: listRes.status, body: listBody.slice(0, 1000) });
    }

    const listData = tryParse(listBody);
    const allEmails: Array<{ id: string; name?: string; type?: string; state?: string }> =
      listData?.results ?? [];

    // Test a BATCH_EMAIL specifically, fall back to any non-automated
    const testEmail =
      allEmails.find((e) => e.type === "BATCH_EMAIL") ??
      allEmails.find((e) => e.type !== "AUTOMATED_EMAIL" && e.state !== "AUTOMATED") ??
      allEmails[0];

    if (!testEmail) {
      return NextResponse.json({ step: "list_empty" });
    }

    // Test the statistics/summary endpoint
    const statsRes = await fetch(
      `${HS_BASE}/marketing/v3/emails/${testEmail.id}/statistics/summary`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const statsBody = await statsRes.text();

    // Also test the v1 campaign stats API as an alternative
    const v1Res = await fetch(
      `${HS_BASE}/email/public/v1/campaigns?limit=5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const v1Body = await v1Res.text();

    return NextResponse.json({
      newest_emails: allEmails.map((e) => ({ id: e.id, name: e.name, type: e.type, state: e.state })),
      testing_email: testEmail,
      stats_v3_status: statsRes.status,
      stats_v3_body: tryParse(statsBody),
      campaigns_v1_status: v1Res.status,
      campaigns_v1_body: tryParse(v1Body),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
