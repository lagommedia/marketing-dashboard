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

// Fetch all published emails (paginated, up to 1 000)
async function fetchAllEmails(token: string): Promise<HsEmail[]> {
  const emails: HsEmail[] = [];
  let after: string | undefined;

  do {
    const url = new URL(`${HS_BASE}/marketing/v3/emails`);
    url.searchParams.set("limit", "100");
    // Omit state filter — PUBLISHED is set after scheduling, PROCESSED after delivery.
    // Fetch all and let date filtering decide what counts as "sent this month".
    if (after) url.searchParams.set("after", after);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HubSpot list error ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    // Exclude AUTOMATED workflow emails — the statistics/summary endpoint returns
    // 404 for those; only batch campaign sends have delivery stats.
    const batch = (data.results ?? []).filter(
      (e: HsEmail) => e.type !== "AUTOMATED" && e.state !== "AUTOMATED"
    );
    emails.push(...batch);
    after = data.paging?.next?.after ?? undefined;
  } while (after && emails.length < 1000);

  return emails;
}

// Fetch statistics via v1 campaigns API using the email's primaryEmailCampaignId.
// The v3 /statistics/summary endpoint returns 404 for this account; v1 works correctly.
async function fetchEmailStats(token: string, campaignId: string): Promise<HsStats> {
  try {
    const res = await fetch(`${HS_BASE}/email/public/v1/campaigns/${campaignId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return {};
    const data = await res.json();
    return (data.counters ?? {}) as HsStats;
  } catch {
    return {};
  }
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
    const allEmails = await fetchAllEmails(token);

    // Filter to emails whose publish/send date falls in the requested month
    const filtered = allEmails.filter((e) => {
      const dateStr = e.publishDate ?? e.scheduledAt ?? e.updatedAt;
      if (!dateStr) return false;
      const ms = new Date(dateStr).getTime();
      return ms >= afterMs && ms <= beforeMs;
    });

    // Fetch statistics for each matched email (parallel, max 50 to avoid rate limits)
    // Use primaryEmailCampaignId with the v1 campaigns API — v3 stats endpoint is unavailable.
    const slice = filtered.slice(0, 50);
    const statsArr = await Promise.all(
      slice.map((e) =>
        e.primaryEmailCampaignId
          ? fetchEmailStats(token, e.primaryEmailCampaignId)
          : Promise.resolve({} as HsStats)
      )
    );

    const campaigns: EmailCampaign[] = slice.map((e, i) => {
      const s       = statsArr[i];
      const sent    = s.sent    ?? s.delivered ?? 0;
      const opens   = s.open   ?? s.opens ?? 0;
      const clicks  = s.click  ?? s.clicks ?? 0;
      const unsubs  = s.unsubscribed ?? s.unsubscribes ?? 0;
      const bounces = s.bounce ?? s.bounces ?? 0;

      return {
        id:          e.id,
        name:        e.name ?? "(Untitled)",
        subject:     e.subject ?? "",
        publishDate: e.publishDate ?? e.scheduledAt ?? e.updatedAt ?? "",
        sent,
        opens,
        clicks,
        unsubs,
        bounces,
        openRate:  sent  > 0 ? opens  / sent  : 0,
        clickRate: sent  > 0 ? clicks / sent  : 0,
        ctor:      opens > 0 ? clicks / opens : 0,
        unsubRate: sent  > 0 ? unsubs / sent  : 0,
      };
    });

    campaigns.sort((a, b) => new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime());

    const totalSent    = campaigns.reduce((s, c) => s + c.sent,    0);
    const totalOpens   = campaigns.reduce((s, c) => s + c.opens,   0);
    const totalClicks  = campaigns.reduce((s, c) => s + c.clicks,  0);
    const totalUnsubs  = campaigns.reduce((s, c) => s + c.unsubs,  0);
    const totalBounces = campaigns.reduce((s, c) => s + c.bounces, 0);

    const summary = {
      campaigns:  campaigns.length,
      sent:       totalSent,
      opens:      totalOpens,
      clicks:     totalClicks,
      unsubs:     totalUnsubs,
      bounces:    totalBounces,
      openRate:   totalSent  > 0 ? totalOpens  / totalSent  : 0,
      clickRate:  totalSent  > 0 ? totalClicks / totalSent  : 0,
      ctor:       totalOpens > 0 ? totalClicks / totalOpens : 0,
      unsubRate:  totalSent  > 0 ? totalUnsubs / totalSent  : 0,
    };

    return NextResponse.json({ year, month, summary, campaigns });
  } catch (e) {
    console.error("[email/stats]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// ── HubSpot shapes ─────────────────────────────────────────────────────────────

interface HsEmail {
  id:                      string;
  name?:                   string;
  subject?:                string;
  publishDate?:            string;
  scheduledAt?:            string;
  updatedAt?:              string;
  type?:                   string;
  state?:                  string;
  primaryEmailCampaignId?: string;
}

// Statistics field names vary slightly across HubSpot API versions
interface HsStats {
  sent?:           number;
  delivered?:      number;
  open?:           number;
  opens?:          number;
  click?:          number;
  clicks?:         number;
  unsubscribed?:   number;
  unsubscribes?:   number;
  bounce?:         number;
  bounces?:        number;
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
