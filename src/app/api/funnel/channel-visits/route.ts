import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getValidGoogleToken } from "@/lib/sync/utils";

export const dynamic = "force-dynamic";

const GA4_BASE = "https://analyticsdata.googleapis.com/v1beta/properties";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to   = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  const gaRow = await prisma.integration.findUnique({ where: { platform: "google_analytics" } });
  if (!gaRow?.connected || !gaRow.accountId) {
    return NextResponse.json({ error: "GA4 not connected" }, { status: 409 });
  }

  try {
    const token = await getValidGoogleToken("google_analytics");

    const body = {
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      limit: 50,
    };

    const res = await fetch(`${GA4_BASE}/${gaRow.accountId}:runReport`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GA4 API ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
    };

    const rows = (data.rows ?? [])
      .map(r => ({
        channel:  r.dimensionValues[0]?.value ?? "(not set)",
        sessions: parseInt(r.metricValues[0]?.value ?? "0", 10) || 0,
      }))
      .sort((a, b) => b.sessions - a.sessions);

    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 502 });
  }
}
