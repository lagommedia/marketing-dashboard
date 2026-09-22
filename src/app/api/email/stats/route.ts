import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const HS_BASE = "https://api.hubapi.com";

async function getToken(): Promise<string | null> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) return null;
  return decrypt(row.accessToken);
}

function monthRange(year: number, month: number) {
  const start = new Date(year, month - 1, 1);
  const end   = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const now   = new Date();
  const year  = parseInt(searchParams.get("year")  ?? String(now.getFullYear()), 10);
  const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);

  const token = await getToken();
  if (!token) {
    return NextResponse.json({ error: "HubSpot not connected" }, { status: 503 });
  }

  const { start, end } = monthRange(year, month);
  const afterMs  = start.getTime();
  const beforeMs = end.getTime();

  try {
    // Fetch published marketing emails with stats
    const url = new URL(`${HS_BASE}/marketing/v3/emails`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("state", "PUBLISHED");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("[email/stats] HubSpot error:", res.status, body);
      return NextResponse.json({ error: "HubSpot API error", detail: body }, { status: 502 });
    }

    const data = await res.json();
    const emails: HsEmail[] = data.results ?? [];

    // Filter to emails sent within the month
    const filtered = emails.filter((e) => {
      const sent = e.publishDate ?? e.updatedAt;
      if (!sent) return false;
      const ms = new Date(sent).getTime();
      return ms >= afterMs && ms <= beforeMs;
    });

    // Map to our shape
    const campaigns: EmailCampaign[] = filtered.map((e) => {
      const s        = e.statistics ?? {};
      const sent     = s.sent ?? 0;
      const opens    = s.open ?? 0;
      const clicks   = s.click ?? 0;
      const unsubs   = s.unsubscribed ?? 0;
      const bounces  = s.bounce ?? 0;

      return {
        id:          e.id,
        name:        e.name ?? "(Untitled)",
        subject:     e.subject ?? "",
        publishDate: e.publishDate ?? e.updatedAt ?? "",
        sent,
        opens,
        clicks,
        unsubs,
        bounces,
        openRate:    sent > 0 ? opens  / sent   : 0,
        clickRate:   sent > 0 ? clicks / sent   : 0,
        ctor:        opens > 0 ? clicks / opens : 0,
        unsubRate:   sent > 0 ? unsubs / sent   : 0,
      };
    });

    // Sort by send date desc
    campaigns.sort((a, b) => new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime());

    // Aggregate totals
    const totalSent    = campaigns.reduce((s, c) => s + c.sent, 0);
    const totalOpens   = campaigns.reduce((s, c) => s + c.opens, 0);
    const totalClicks  = campaigns.reduce((s, c) => s + c.clicks, 0);
    const totalUnsubs  = campaigns.reduce((s, c) => s + c.unsubs, 0);
    const totalBounces = campaigns.reduce((s, c) => s + c.bounces, 0);

    const summary = {
      campaigns:   campaigns.length,
      sent:        totalSent,
      opens:       totalOpens,
      clicks:      totalClicks,
      unsubs:      totalUnsubs,
      bounces:     totalBounces,
      openRate:    totalSent  > 0 ? totalOpens  / totalSent  : 0,
      clickRate:   totalSent  > 0 ? totalClicks / totalSent  : 0,
      ctor:        totalOpens > 0 ? totalClicks / totalOpens : 0,
      unsubRate:   totalSent  > 0 ? totalUnsubs / totalSent  : 0,
    };

    return NextResponse.json({ year, month, summary, campaigns });
  } catch (e) {
    console.error("[email/stats]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

// ── HubSpot shapes ────────────────────────────────────────────────────────────

interface HsEmail {
  id:          string;
  name?:       string;
  subject?:    string;
  publishDate?: string;
  updatedAt?:  string;
  statistics?: {
    sent?:          number;
    open?:          number;
    click?:         number;
    unsubscribed?:  number;
    bounce?:        number;
  };
}

interface EmailCampaign {
  id:          string;
  name:        string;
  subject:     string;
  publishDate: string;
  sent:        number;
  opens:       number;
  clicks:      number;
  unsubs:      number;
  bounces:     number;
  openRate:    number;
  clickRate:   number;
  ctor:        number;
  unsubRate:   number;
}
