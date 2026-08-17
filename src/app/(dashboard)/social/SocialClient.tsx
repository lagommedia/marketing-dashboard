"use client";

import { useState, useEffect, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from "recharts";
import {
  RefreshCw, Share2, Users, Eye, Heart, TrendingUp,
  MousePointerClick, AlertCircle, ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DayPoint {
  date:         string;
  impressions:  number;
  reach:        number;
  engagements:  number;
  clicks:       number;
  profileViews: number;
  followers:    number;
}

interface Summary {
  followers:      number;
  impressions:    number;
  reach:          number;
  engagements:    number;
  clicks:         number;
  profileViews:   number;
  engagementRate: number | null;
}

interface PlatformData {
  connected:    boolean;
  lastSyncedAt: string | null;
  hasData:      boolean;
  summary:      Summary | null;
  dailySeries:  DayPoint[];
}

interface SocialData {
  days:      number;
  platforms: {
    linkedin:  PlatformData;
    facebook:  PlatformData;
    instagram: PlatformData;
  };
}

type Platform = "linkedin" | "facebook" | "instagram";
type ChartMetric = "impressions" | "reach" | "engagements";

// ---------------------------------------------------------------------------
// Platform config
// ---------------------------------------------------------------------------

const PLATFORMS: { id: Platform; label: string; color: string; syncRoute: string }[] = [
  { id: "linkedin",  label: "LinkedIn",  color: "#0A66C2", syncRoute: "/api/integrations/linkedin/organic-sync"  },
  { id: "facebook",  label: "Facebook",  color: "#1877F2", syncRoute: "/api/integrations/facebook/organic-sync"  },
  { id: "instagram", label: "Instagram", color: "#E1306C", syncRoute: "/api/integrations/facebook/organic-sync"  },
];

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const fmtN = (n: number | null | undefined) =>
  n == null ? "—" : Number(n) >= 1_000_000
    ? `${(Number(n) / 1_000_000).toFixed(1)}M`
    : Number(n) >= 1_000
    ? `${(Number(n) / 1_000).toFixed(1)}k`
    : Number(n).toLocaleString("en-US");

const fmtPct = (n: number | null | undefined) =>
  n == null ? "—" : (Number(n) * 100).toFixed(2) + "%";

const shortDate = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

const relativeTime = (iso: string | null) => {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return "< 1 hour ago";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function KpiCard({ label, value, icon: Icon, accent = false }: {
  label: string; value: string; icon: React.ElementType; accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
        <span className={cn("rounded-lg p-1.5", accent ? "bg-indigo-50" : "bg-slate-50")}>
          <Icon className={cn("w-4 h-4", accent ? "text-indigo-500" : "text-slate-400")} />
        </span>
      </div>
      <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function NotConnected({ platform }: { platform: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-10 text-center">
      <AlertCircle className="w-8 h-8 mx-auto mb-3 text-slate-300" />
      <p className="font-semibold text-slate-600 mb-1">{platform} not connected</p>
      <p className="text-sm text-slate-400 mb-4">
        Connect your {platform}{platform === "Instagram" ? " (via Facebook)" : ""} integration to start pulling metrics.
      </p>
      <a
        href="/integrations"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:underline"
      >
        Go to Integrations <ExternalLink className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}

function PlatformPanel({
  config, data, days, syncing, syncMsg, onSync,
}: {
  config:   typeof PLATFORMS[number];
  data:     PlatformData | undefined;
  days:     30 | 90;
  syncing:  boolean;
  syncMsg:  string | null;
  onSync:   () => void;
}) {
  const [chartMetric, setChartMetric] = useState<ChartMetric>("impressions");
  const summary = data?.summary ?? null;

  const CHART_OPTS: { id: ChartMetric; label: string }[] = [
    { id: "impressions", label: "Impressions" },
    { id: "reach",       label: "Reach"       },
    { id: "engagements", label: "Engagements" },
  ];

  return (
    <div className="space-y-6">
      {/* Panel header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: config.color }} />
          <div>
            <p className="text-sm font-semibold text-slate-900">{config.label} — Organic</p>
            {data?.lastSyncedAt && (
              <p className="text-xs text-slate-400">Last synced {relativeTime(data.lastSyncedAt)}</p>
            )}
          </div>
          {data?.connected && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
              Connected
            </span>
          )}
        </div>

        {data?.connected && (
          <button
            onClick={onSync}
            disabled={syncing}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors",
              syncing
                ? "border-slate-200 text-slate-400 cursor-not-allowed"
                : "border-slate-300 text-slate-600 hover:bg-slate-50",
            )}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", syncing && "animate-spin")} />
            {syncing ? "Syncing…" : `Sync ${days}d`}
          </button>
        )}
      </div>

      {syncMsg && (
        <div className={cn(
          "rounded-lg px-4 py-3 text-sm",
          syncMsg.toLowerCase().includes("error") || syncMsg.toLowerCase().includes("fail")
            ? "bg-red-50 text-red-700 border border-red-200"
            : "bg-green-50 text-green-700 border border-green-200",
        )}>
          {syncMsg}
        </div>
      )}

      {!data?.connected && <NotConnected platform={config.label} />}

      {data?.connected && !data.hasData && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-10 text-center">
          <Share2 className="w-8 h-8 mx-auto mb-3 text-slate-300" />
          <p className="font-semibold text-slate-600 mb-1">No data yet</p>
          <p className="text-sm text-slate-400">Click Sync to pull your {config.label} organic analytics.</p>
        </div>
      )}

      {data?.hasData && summary && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <KpiCard label="Followers"       value={fmtN(summary.followers)}      icon={Users}            accent />
            <KpiCard label="Impressions"     value={fmtN(summary.impressions)}    icon={Eye} />
            <KpiCard label="Reach"           value={fmtN(summary.reach)}          icon={TrendingUp} />
            <KpiCard label="Engagements"     value={fmtN(summary.engagements)}    icon={Heart} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-2 gap-4">
            <KpiCard label="Engagement Rate" value={fmtPct(summary.engagementRate)} icon={TrendingUp} />
            <KpiCard label="Clicks / Profile Views"
              value={summary.clicks > 0 || summary.profileViews > 0
                ? `${fmtN(summary.clicks + summary.profileViews)}`
                : "—"}
              icon={MousePointerClick}
            />
          </div>

          {/* Trend chart */}
          {data.dailySeries.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-6">
              <div className="flex items-center justify-between mb-5">
                <p className="text-sm font-semibold text-slate-900">Trend — Last {days} days</p>
                <div className="flex rounded-lg border border-slate-200 bg-slate-50 overflow-hidden text-xs">
                  {CHART_OPTS.map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => setChartMetric(opt.id)}
                      className={cn(
                        "px-2.5 py-1 font-medium transition-colors",
                        chartMetric === opt.id
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700",
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={data.dailySeries} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id={`grad-${config.id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={config.color} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={config.color} stopOpacity={0}   />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDate}
                    tick={{ fontSize: 11, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    interval={Math.max(1, Math.floor(data.dailySeries.length / 8))}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    width={48}
                    tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                  />
                  <Tooltip
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter={(v: any) => [fmtN(v as number), CHART_OPTS.find(o => o.id === chartMetric)?.label ?? chartMetric]}
                    labelFormatter={l => {
                      const d = new Date(String(l) + "T00:00:00");
                      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                    }}
                    contentStyle={{ border: "1px solid #e2e8f0", borderRadius: "8px", fontSize: "12px" }}
                  />
                  <Area
                    type="monotone"
                    dataKey={chartMetric}
                    stroke={config.color}
                    strokeWidth={2}
                    fill={`url(#grad-${config.id})`}
                    dot={false}
                    activeDot={{ r: 4, fill: config.color }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SocialClient() {
  const [days,      setDays]     = useState<30 | 90>(30);
  const [tab,       setTab]      = useState<Platform>("linkedin");
  const [data,      setData]     = useState<SocialData | null>(null);
  const [loading,   setLoading]  = useState(true);
  const [syncing,   setSyncing]  = useState<Platform | null>(null);
  const [syncMsgs,  setSyncMsgs] = useState<Partial<Record<Platform, string>>>({});

  const load = useCallback(async (d: 30 | 90) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/social/metrics?days=${d}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  async function handleSync(platform: Platform, route: string) {
    setSyncing(platform);
    setSyncMsgs(m => ({ ...m, [platform]: undefined }));

    // Syncing Facebook also updates Instagram
    const affected: Platform[] = platform === "facebook"
      ? ["facebook", "instagram"]
      : [platform];

    try {
      const res  = await fetch(route, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ days }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");

      const msg  = `Synced ${json.recordsCount} rows.`;
      const msgs: Partial<Record<Platform, string>> = {};
      for (const p of affected) msgs[p] = msg;
      setSyncMsgs(m => ({ ...m, ...msgs }));
      await load(days);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sync failed";
      setSyncMsgs(m => ({ ...m, [platform]: msg }));
    } finally {
      setSyncing(null);
    }
  }

  const activeConfig = PLATFORMS.find(p => p.id === tab)!;
  const activeData   = data?.platforms[tab];

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Share2 className="w-6 h-6 text-indigo-500" />
            <h1 className="text-2xl font-bold text-slate-900">Social Media</h1>
          </div>
          <p className="text-sm text-slate-500">Organic performance across LinkedIn, Facebook &amp; Instagram</p>
        </div>

        <div className="flex rounded-lg border border-slate-200 bg-slate-50 overflow-hidden text-sm self-start">
          {([30, 90] as const).map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn(
                "px-3 py-1.5 font-medium transition-colors",
                days === d ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700",
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Platform tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {PLATFORMS.map(p => (
          <button
            key={p.id}
            onClick={() => setTab(p.id)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px",
              tab === p.id
                ? "border-current text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-700",
            )}
            style={tab === p.id ? { borderColor: p.color, color: p.color } : {}}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="py-16 text-center text-slate-400">
          <RefreshCw className="w-8 h-8 mx-auto mb-3 animate-spin text-slate-300" />
          <p className="text-sm">Loading…</p>
        </div>
      ) : (
        <PlatformPanel
          config={activeConfig}
          data={activeData}
          days={days}
          syncing={syncing === tab || (tab === "instagram" && syncing === "facebook")}
          syncMsg={syncMsgs[tab] ?? null}
          onSync={() => handleSync(tab, activeConfig.syncRoute)}
        />
      )}

      {tab === "instagram" && (
        <p className="text-xs text-slate-400">
          Instagram organic data is pulled via your connected Facebook Page. Connect Facebook in Integrations to enable both.
        </p>
      )}
    </div>
  );
}
