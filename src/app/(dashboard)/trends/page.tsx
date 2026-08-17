import { Suspense } from "react";
import { prisma } from "@/lib/db";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { ChannelFilter } from "@/components/dashboard/ChannelFilter";
import { TrendsChart } from "@/components/dashboard/TrendsChart";
import type { Channel } from "@/types";

/**
 * Same multi-platform channel filter as the Overview page.
 * See page.tsx for the full rationale.
 */
function buildChannelWhere(channel: Channel) {
  if (channel === "all") {
    return {
      OR: [
        { platform: "hubspot",               channel: "all"        },
        { platform: "google_ads",            channel: "paid_media" },
        { platform: "google_search_console", channel: "organic"    },
        { platform: "manual",                channel: "paid_media" },
        { platform: "manual",                channel: "organic"    },
      ],
    };
  }
  if (channel === "paid_media") {
    return {
      OR: [
        { platform: "hubspot",    channel: "paid_media" },
        { platform: "google_ads", channel: "paid_media" },
        { platform: "manual",     channel: "paid_media" },
      ],
    };
  }
  if (channel === "organic") {
    return {
      OR: [
        { platform: "hubspot",               channel: "organic" },
        { platform: "google_search_console", channel: "organic" },
        { platform: "manual",                channel: "organic" },
      ],
    };
  }
  return { channel };
}

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ channel?: string }>;
}

interface DayBucket {
  date: string;
  impressions: number;
  clicks: number;
  leads: number;
  mqls: number;
  sqos: number;
  closedWon: number;
  spend: number;
  revenue: number;
  [key: string]: number | string | null;
}

async function getTrendData(channel: Channel): Promise<DayBucket[]> {
  const since = new Date();
  since.setDate(since.getDate() - 29);
  since.setHours(0, 0, 0, 0);

  const rows = await prisma.metricSnapshot.findMany({
    where: {
      date: { gte: since },
      ...buildChannelWhere(channel),
    },
    orderBy: { date: "asc" },
  });

  // Seed all 30 days as zero buckets
  const byDate = new Map<string, DayBucket>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const key = d.toISOString().slice(0, 10);
    byDate.set(key, {
      date: key,
      impressions: 0,
      clicks: 0,
      leads: 0,
      mqls: 0,
      sqos: 0,
      closedWon: 0,
      spend: 0,
      revenue: 0,
    });
  }

  for (const row of rows) {
    const key = new Date(row.date).toISOString().slice(0, 10);
    const bucket = byDate.get(key);
    if (bucket) {
      bucket.impressions += row.impressions ?? 0;
      bucket.clicks += row.clicks ?? 0;
      bucket.leads += row.leads ?? 0;
      bucket.mqls += row.mqls ?? 0;
      bucket.sqos += row.sqos ?? 0;
      bucket.closedWon += row.closedWon ?? 0;
      bucket.spend += row.spend ?? 0;
      bucket.revenue += row.revenue ?? 0;
    }
  }

  return Array.from(byDate.values());
}

export default async function TrendsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const channel = (sp.channel as Channel) ?? "all";

  const data = await getTrendData(channel);
  const hasData = data.some(
    (d) => d.impressions > 0 || d.clicks > 0 || d.spend > 0 || d.mqls > 0
  );

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Trends</h1>
          <p className="text-sm text-slate-500 mt-1">
            Daily performance over the last 30 days
          </p>
        </div>
        <Suspense>
          <ChannelFilter active={channel} />
        </Suspense>
      </div>

      {!hasData ? (
        <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
          <p className="text-sm text-slate-400 max-w-xs mx-auto">
            No trend data yet — connect your integrations and run a sync to
            start seeing daily charts here.
          </p>
        </div>
      ) : (
        <>
          {/* Traffic */}
          <TrendSection
            title="Traffic"
            description="Impressions and clicks per day"
          >
            <TrendsChart
              data={data}
              lines={[
                { key: "impressions", label: "Impressions", color: "#818cf8" },
                { key: "clicks", label: "Clicks", color: "#4f46e5" },
              ]}
              formatter={(v) => formatNumber(v, true)}
            />
          </TrendSection>

          {/* Funnel */}
          <TrendSection
            title="Funnel"
            description="Leads, MQLs, and SQOs per day"
          >
            <TrendsChart
              data={data}
              lines={[
                { key: "leads", label: "Leads", color: "#6ee7b7" },
                { key: "mqls", label: "MQLs", color: "#10b981" },
                { key: "sqos", label: "SQOs", color: "#059669" },
              ]}
              formatter={(v) => formatNumber(v, true)}
            />
          </TrendSection>

          {/* Revenue + Closed Won side-by-side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <TrendSection
              title="Revenue vs. Spend"
              description="Financial performance per day"
            >
              <TrendsChart
                data={data}
                lines={[
                  { key: "revenue", label: "Revenue", color: "#10b981" },
                  { key: "spend", label: "Spend", color: "#f59e0b" },
                ]}
                formatter={(v) => formatCurrency(v, true)}
              />
            </TrendSection>

            <TrendSection
              title="Closed Won"
              description="Deals closed per day"
            >
              <TrendsChart
                data={data}
                lines={[{ key: "closedWon", label: "Closed Won", color: "#6366f1" }]}
                formatter={(v) => formatNumber(v, true)}
              />
            </TrendSection>
          </div>
        </>
      )}
    </div>
  );
}

function TrendSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        <p className="text-xs text-slate-400 mt-0.5">{description}</p>
      </div>
      {children}
    </div>
  );
}
