"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, TrendingUp, MousePointerClick, Eye, Crosshair, ChevronDown, ChevronUp, Star, Search, Bot, Globe } from "lucide-react";
import { cn } from "@/lib/utils";

type Channel = "seo" | "aeo" | "geo";
type Segment = "branded" | "non-branded";

// ---------------------------------------------------------------------------
// AEO types
// ---------------------------------------------------------------------------

interface AeoSignals {
  faqSchema:        boolean;
  orgSchema:        boolean;
  questionHeadings: boolean;
  directAnswer:     boolean;
  lists:            boolean;
  metaDesc:         boolean;
  h1Present:        boolean;
}

interface AeoReadinessPillar {
  pillarId:  string;
  label:     string;
  isPrimary: boolean;
  pageUrl:   string | null;
  score:     number;
  signals:   AeoSignals;
}

interface AeoOverviewData {
  hasData:      boolean;
  lastSyncedAt: string | null;
  totals:       { impressions: number; clicks: number };
  dailySeries:  { date: string; impressions: number; clicks: number; ctr: number | null }[];
}

interface AiVisibilityEngine {
  mentions:     number;
  totalQueries: number;
  citedPages:   string[];
}

interface AiVisibilityPillar {
  pillarId:  string;
  label:     string;
  isPrimary: boolean;
  engines:   Record<string, boolean>;
  citedUrls: string[];
}

interface AiVisibilityData {
  hasData:         boolean;
  lastSyncedAt:    string | null;
  visibilityScore: number;
  engines:         Record<string, AiVisibilityEngine>;
  allCitedPages:   string[];
  byPillar:        AiVisibilityPillar[];
}

interface PillarData {
  id: string;
  label: string;
  isPrimary: boolean;
  clicks: number;
  impressions: number;
  ctr: number | null;
  avgPosition: number | null;
  positionChange: number | null;
  topQueries: { query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }[];
}

interface GscDayPoint {
  date: string;
  impressions: number;
  clicks: number;
  ctr: number | null;
  avgPosition: number | null;
}

interface ApiResponse {
  totals: { impressions: number; clicks: number; ctr: number | null; avgPosition: number | null };
  dailySeries: GscDayPoint[];
  pillars: PillarData[];
  topQueries: { query: string; clicks: number; impressions: number; ctr: number | null; avgPosition: number | null; positionChange: number | null }[];
  hasData: boolean;
  lastSyncedAt: string | null;
}

interface GaPage {
  pagePath:        string;
  sessions:        number;
  users:           number;
  engagedSessions: number;
  conversions:     number;
  bounceRate:      number | null;
  avgSessionSec:   number | null;
}

interface GaDayPoint {
  date: string;
  sessions: number;
  users: number;
  engagedSessions: number;
  conversions: number;
  avgBounceRate: number | null;
  avgSessionSec: number | null;
}

interface GaResponse {
  hasData:     boolean;
  connected:   boolean;
  lastSyncedAt: string | null;
  totals: {
    sessions:        number;
    users:           number;
    engagedSessions: number;
    conversions:     number;
    avgBounceRate:   number | null;
    avgSessionSec:   number | null;
  };
  dailySeries: GaDayPoint[];
  topPages: GaPage[];
}

function fmt(n: number | null | undefined, style: "decimal" | "percent" | "position" = "decimal"): string {
  if (n == null) return "—";
  if (style === "percent") return `${(n * 100).toFixed(1)}%`;
  if (style === "position") return n.toFixed(1);
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Sparkline SVG — renders a mini trend line with gradient fill
// ---------------------------------------------------------------------------

function Sparkline({ values, id }: { values: number[]; id: string }) {
  if (values.length < 2) return null;
  const min   = Math.min(...values);
  const max   = Math.max(...values);
  const range = max - min || 1;
  const W = 200, H = 40, PAD = 2;

  const pts = values.map((v, i) => [
    PAD + (i / (values.length - 1)) * (W - PAD * 2),
    PAD + (1 - (v - min) / range) * (H - PAD * 2),
  ]);

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const fillPath = linePath + ` L${(W - PAD).toFixed(1)},${H} L${PAD},${H} Z`;
  const gradId   = `sl-${id}`;

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#6366f1" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0"    />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparklineCard({
  label, value, icon: Icon, sub, sparkline,
}: {
  label: string; value: string; icon: React.ElementType; sub?: string; sparkline?: number[];
}) {
  const sparkId = label.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden flex flex-col">
      <div className="px-5 pt-5 pb-3 flex-1">
        <div className="flex items-center gap-2 text-slate-500 text-xs font-medium uppercase tracking-wide mb-2">
          <Icon className="w-3.5 h-3.5" />
          {label}
        </div>
        <p className="text-2xl font-bold text-slate-900">{value}</p>
        {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
      </div>
      {sparkline && sparkline.length > 1 ? (
        <div className="px-0 pb-0">
          <Sparkline values={sparkline} id={sparkId} />
        </div>
      ) : (
        <div className="h-10 bg-slate-50" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SEO Recommendations — derived from live query data
// ---------------------------------------------------------------------------

type RecType = "striking-distance" | "near-top3" | "low-ctr";

interface Rec {
  type:           RecType;
  badge:          string;
  query:          string;
  headline:       string;
  detail:         string;
  priority:       "high" | "medium";
  positionChange: number | null;
}

function buildRecommendations(pillars: PillarData[]): Rec[] {
  const recs: Rec[] = [];

  // 1. Striking distance: page 2 (pos 11–20), meaningful impressions across all pillar queries
  const striking = pillars
    .filter(p => p.avgPosition != null && p.avgPosition >= 11 && p.avgPosition <= 20 && p.impressions >= 100)
    .sort((a, b) => b.impressions - a.impressions);

  for (const p of striking.slice(0, 3)) {
    recs.push({
      type:           "striking-distance",
      badge:          "Page 2 → Page 1",
      query:          p.label,
      headline:       `${p.label} is averaging position #${p.avgPosition!.toFixed(0)} with ${p.impressions.toLocaleString()} impressions`,
      detail:         "Refresh the page content, tighten the H1, and build 2–3 supporting internal links to push this pillar into page 1.",
      priority:       "high",
      positionChange: p.positionChange ?? null,
    });
  }

  // 2. Near top 3: pos 4–7, decent impressions
  const nearTop = pillars
    .filter(p => p.avgPosition != null && p.avgPosition >= 4 && p.avgPosition <= 7 && p.impressions >= 50)
    .sort((a, b) => b.impressions - a.impressions);

  for (const p of nearTop.slice(0, 2)) {
    recs.push({
      type:           "near-top3",
      badge:          "Top 3 Opportunity",
      query:          p.label,
      headline:       `${p.label} sits at position #${p.avgPosition!.toFixed(0)} with ${p.impressions.toLocaleString()} impressions`,
      detail:         "Add FAQ schema or a direct-answer summary at the top of the page to compete for a featured snippet.",
      priority:       "medium",
      positionChange: p.positionChange ?? null,
    });
  }

  // 3. CTR gap: page 1 pillar but CTR below 2%
  const ctrGap = pillars
    .filter(p => p.avgPosition != null && p.avgPosition <= 10 && p.impressions >= 150 && (p.ctr ?? 1) < 0.02)
    .sort((a, b) => b.impressions - a.impressions);

  for (const p of ctrGap.slice(0, 2)) {
    recs.push({
      type:           "low-ctr",
      badge:          "Improve CTR",
      query:          p.label,
      headline:       `${p.label} appears ${p.impressions.toLocaleString()} times but earns only ${((p.ctr ?? 0) * 100).toFixed(1)}% CTR`,
      detail:         "Rewrite the title tag and meta description to be more compelling — add a number, benefit, or power word.",
      priority:       "medium",
      positionChange: p.positionChange ?? null,
    });
  }

  // Cap at 5, high priority first
  return recs
    .sort((a, b) => (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1))
    .slice(0, 5);
}

// Positive positionChange = moved closer to #1 (good), negative = moved away (bad)
function PositionDelta({ change }: { change: number | null }) {
  if (change === null || Math.abs(change) < 0.5) return <span className="text-slate-300 text-xs">—</span>;
  const improved = change > 0;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-semibold", improved ? "text-emerald-600" : "text-rose-500")}>
      {improved ? "▲" : "▼"} {Math.abs(change).toFixed(1)}
    </span>
  );
}

const REC_CONFIG: Record<RecType, { icon: string; accent: string; badge: string }> = {
  "striking-distance": { icon: "🎯", accent: "border-l-rose-400",   badge: "bg-rose-50 text-rose-700"   },
  "near-top3":         { icon: "⚡", accent: "border-l-amber-400",  badge: "bg-amber-50 text-amber-700"  },
  "low-ctr":           { icon: "✏️", accent: "border-l-indigo-400", badge: "bg-indigo-50 text-indigo-700" },
};

function Recommendations({ pillars }: { pillars: PillarData[] }) {
  const recs = buildRecommendations(pillars);
  if (recs.length === 0) return null;

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm">💡</span>
        <h2 className="text-sm font-semibold text-slate-700">Top Recommendations This Week</h2>
        <span className="ml-auto text-xs text-slate-400">Based on last 90 days of query data</span>
      </div>
      <div className="space-y-2">
        {recs.map((rec, i) => {
          const cfg = REC_CONFIG[rec.type];
          return (
            <div key={i} className={cn("bg-white rounded-xl border border-slate-200 border-l-4 px-5 py-4 flex items-start gap-4", cfg.accent)}>
              <span className="text-lg leading-none mt-0.5 shrink-0">{cfg.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className={cn("text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full", cfg.badge)}>{rec.badge}</span>
                  <p className="text-sm font-medium text-slate-800">{rec.headline}</p>
                  {rec.positionChange !== null && (
                    <span className="ml-auto shrink-0 flex items-center gap-1 text-xs text-slate-400">
                      90d: <PositionDelta change={rec.positionChange} />
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500">{rec.detail}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GA4 industry benchmark comparison
// Sources: Databox B2B SaaS Benchmark Report 2024, HubSpot Marketing Stats 2024,
//          Contentsquare Digital Experience Benchmark 2024
// ---------------------------------------------------------------------------

interface Benchmark {
  label:    string;
  yours:    number | null;
  unit:     "percent" | "seconds";
  low:      number;
  high:     number;
  goodHigh: boolean;
  source:   string;
}

function benchmarkStatus(yours: number | null, low: number, high: number, goodHigh: boolean): "above" | "within" | "below" | "none" {
  if (yours === null) return "none";
  if (goodHigh) {
    if (yours > high) return "above";
    if (yours >= low) return "within";
    return "below";
  } else {
    if (yours < low)  return "above";
    if (yours <= high) return "within";
    return "below";
  }
}

function fmtBenchmarkVal(val: number | null, unit: Benchmark["unit"]): string {
  if (val === null) return "—";
  if (unit === "percent") return (val * 100).toFixed(1) + "%";
  const m = Math.floor(val / 60), s = Math.round(val % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function GaBenchmarks({ totals }: { totals: { sessions: number; engagedSessions: number; conversions: number; avgBounceRate: number | null; avgSessionSec: number | null } }) {
  const engagementRate = totals.sessions > 0 ? totals.engagedSessions / totals.sessions : null;
  const conversionRate = totals.sessions > 0 ? totals.conversions    / totals.sessions : null;

  const benchmarks: Benchmark[] = [
    { label: "Bounce Rate",            yours: totals.avgBounceRate, unit: "percent", low: 0.45, high: 0.65, goodHigh: false, source: "Databox B2B SaaS 2024" },
    { label: "Engagement Rate",        yours: engagementRate,       unit: "percent", low: 0.40, high: 0.60, goodHigh: true,  source: "Contentsquare 2024" },
    { label: "Avg Session Duration",   yours: totals.avgSessionSec, unit: "seconds", low: 120,  high: 210,  goodHigh: true,  source: "HubSpot Marketing Stats 2024" },
    { label: "Organic Conversion Rate",yours: conversionRate,       unit: "percent", low: 0.02, high: 0.05, goodHigh: true,  source: "Databox B2B SaaS 2024" },
  ];

  const cfg = {
    above:  { label: "Above avg", bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500", border: "border-emerald-200" },
    within: { label: "At avg",    bg: "bg-amber-50",   text: "text-amber-700",   dot: "bg-amber-400",   border: "border-amber-200"   },
    below:  { label: "Below avg", bg: "bg-rose-50",    text: "text-rose-700",    dot: "bg-rose-500",    border: "border-rose-200"    },
    none:   { label: "No data",   bg: "bg-slate-50",   text: "text-slate-400",   dot: "bg-slate-300",   border: "border-slate-200"   },
  };

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">vs. B2B SaaS Industry Benchmarks · 90 days</h3>
        <span className="text-xs text-slate-400">Sources: Databox, HubSpot, Contentsquare 2024</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {benchmarks.map((b) => {
          const status     = benchmarkStatus(b.yours, b.low, b.high, b.goodHigh);
          const c          = cfg[status];
          const rangeLabel = `${fmtBenchmarkVal(b.low, b.unit)} – ${fmtBenchmarkVal(b.high, b.unit)}`;
          const barMax     = Math.max(b.high * 1.5, (b.yours ?? 0) * 1.1, 0.001);
          const yoursBar   = b.yours != null ? Math.min((b.yours / barMax) * 100, 100) : 0;
          const lowBar     = (b.low  / barMax) * 100;
          const highBar    = (b.high / barMax) * 100;

          return (
            <div key={b.label} className={cn("rounded-xl border p-4", c.bg, c.border)}>
              <div className="flex items-start justify-between mb-2">
                <span className="text-xs font-medium text-slate-600">{b.label}</span>
                <span className={cn("flex items-center gap-1 text-xs font-semibold", c.text)}>
                  <span className={cn("w-1.5 h-1.5 rounded-full", c.dot)} />
                  {c.label}
                </span>
              </div>
              <p className="text-2xl font-bold text-slate-900 mb-1">{fmtBenchmarkVal(b.yours, b.unit)}</p>
              <div className="relative h-2 bg-slate-200 rounded-full mb-2 mt-3">
                <div className="absolute top-0 h-2 bg-slate-300 rounded-full" style={{ left: `${lowBar}%`, width: `${highBar - lowBar}%` }} />
                {b.yours != null && (
                  <div className={cn("absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white shadow", c.dot)} style={{ left: `calc(${yoursBar}% - 6px)` }} />
                )}
              </div>
              <p className="text-xs text-slate-400">
                Industry avg: <span className="text-slate-500 font-medium">{rangeLabel}</span>
                <span className="ml-2 text-slate-300">· {b.source}</span>
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PillarCard({ pillar }: { pillar: PillarData }) {
  const [expanded, setExpanded] = useState(false);
  const hasQueries = pillar.topQueries.length > 0;

  return (
    <div className={cn("bg-white rounded-xl border p-5 transition-all", pillar.isPrimary ? "border-indigo-300 ring-1 ring-indigo-100" : "border-slate-200")}>
      <div className="flex items-start justify-between gap-2 mb-4">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {pillar.isPrimary && (
            <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-100 text-indigo-700">
              <Star className="w-2.5 h-2.5" /> Primary
            </span>
          )}
          <p className="font-semibold text-slate-800 text-sm truncate">{pillar.label}</p>
        </div>
        {hasQueries && (
          <button onClick={() => setExpanded(e => !e)} className="shrink-0 text-slate-400 hover:text-slate-600">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-slate-400">Impressions</p>
          <p className="text-lg font-bold text-slate-900">{fmt(pillar.impressions)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-400">Clicks</p>
          <p className="text-lg font-bold text-slate-900">{fmt(pillar.clicks)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-400">Avg CTR</p>
          <p className="text-lg font-bold text-slate-900">{fmt(pillar.ctr, "percent")}</p>
        </div>
        <div>
          <p className="text-xs text-slate-400">Avg Position</p>
          <div className="flex items-baseline gap-2">
            <p className="text-lg font-bold text-slate-900">{fmt(pillar.avgPosition, "position")}</p>
            <PositionDelta change={pillar.positionChange} />
          </div>
        </div>
      </div>

      {expanded && hasQueries && (
        <div className="mt-4 border-t border-slate-100 pt-4 space-y-1">
          <p className="text-xs font-medium text-slate-500 mb-2">Top Queries</p>
          {pillar.topQueries.map(q => (
            <div key={q.query} className="flex items-center justify-between gap-2 text-xs py-1">
              <span className="text-slate-700 truncate flex-1">{q.query}</span>
              <span className="shrink-0 text-slate-400">{fmt(q.impressions)} imp</span>
              <span className="shrink-0 text-slate-400">{fmt(q.ctr, "percent")} CTR</span>
              <span className="shrink-0 text-slate-500 font-medium">#{fmt(q.position, "position")}</span>
            </div>
          ))}
        </div>
      )}

      {!hasQueries && (
        <p className="mt-4 text-xs text-slate-400 italic">No matching queries in this period</p>
      )}
    </div>
  );
}

const CHANNEL_OPTIONS: { id: Channel; label: string; icon: React.ElementType; description: string }[] = [
  { id: "seo", label: "SEO", icon: Search, description: "Search Engine Optimization — organic search visibility via Google Search Console" },
  { id: "aeo", label: "AEO", icon: Bot, description: "Answer Engine Optimization — featured snippets, People Also Ask, AI Overviews" },
  { id: "geo", label: "GEO", icon: Globe, description: "Generative Engine Optimization — brand mentions in ChatGPT, Perplexity, Gemini" },
];

function fmtSec(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function SeoClient() {
  const [channel, setChannel]   = useState<Channel>("seo");
  const [segment, setSegment]   = useState<Segment>("non-branded");
  const [data, setData]         = useState<ApiResponse | null>(null);
  const [gaData, setGaData]     = useState<GaResponse | null>(null);
  const [loading, setLoading]   = useState(true);
  const [gaLoading, setGaLoading] = useState(true);
  const [syncing, setSyncing]   = useState(false);
  const [gaSyncing, setGaSyncing] = useState(false);
  const [syncMsg, setSyncMsg]   = useState<string | null>(null);
  const [gaSyncMsg, setGaSyncMsg] = useState<string | null>(null);

  // AEO state
  const [aeoOverview, setAeoOverview]       = useState<AeoOverviewData | null>(null);
  const [aeoReadiness, setAeoReadiness]     = useState<AeoReadinessPillar[] | null>(null);
  const [aeoOverviewLoading, setAeoOverviewLoading] = useState(false);
  const [aeoReadinessLoading, setAeoReadinessLoading] = useState(false);
  const [aeoSyncing, setAeoSyncing]         = useState(false);
  const [aeoSyncMsg, setAeoSyncMsg]         = useState<string | null>(null);
  const [aeoRefreshing, setAeoRefreshing]   = useState(false);

  // AI Visibility (Layer 0) state
  const [aiVisibility, setAiVisibility]         = useState<AiVisibilityData | null>(null);
  const [aiVisibilityLoading, setAiVisibilityLoading] = useState(false);
  const [aiMentionSyncing, setAiMentionSyncing] = useState(false);
  const [aiMentionSyncMsg, setAiMentionSyncMsg] = useState<string | null>(null);
  const [aiMentionCooldownUntil, setAiMentionCooldownUntil] = useState<Date | null>(null);

  const loadAeoOverview = useCallback(async () => {
    setAeoOverviewLoading(true);
    try {
      const res = await fetch("/api/seo/aeo-overview");
      setAeoOverview(await res.json());
    } finally {
      setAeoOverviewLoading(false);
    }
  }, []);

  const loadAeoReadiness = useCallback(async () => {
    setAeoReadinessLoading(true);
    try {
      const res = await fetch("/api/seo/aeo-readiness");
      const json = await res.json();
      setAeoReadiness(json.pillars ?? null);
    } finally {
      setAeoReadinessLoading(false);
    }
  }, []);

  const loadAiVisibility = useCallback(async () => {
    setAiVisibilityLoading(true);
    try {
      const res = await fetch("/api/seo/ai-visibility");
      setAiVisibility(await res.json());
    } finally {
      setAiVisibilityLoading(false);
    }
  }, []);

  const load = useCallback(async (seg: Segment) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/seo/pillars?segment=${seg}`);
      const json = await res.json();
      setData(json);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadGa = useCallback(async () => {
    setGaLoading(true);
    try {
      const res = await fetch("/api/seo/organic-traffic?days=90");
      const json = await res.json();
      setGaData(json);
    } finally {
      setGaLoading(false);
    }
  }, []);

  useEffect(() => { load(segment); }, [segment, load]);
  useEffect(() => { loadGa(); }, [loadGa]);
  useEffect(() => {
    if (channel === "aeo") {
      if (!aeoOverview)   loadAeoOverview();
      if (!aeoReadiness)  loadAeoReadiness();
      if (!aiVisibility)  loadAiVisibility();
    }
  }, [channel, aeoOverview, aeoReadiness, aiVisibility, loadAeoOverview, loadAeoReadiness, loadAiVisibility]);

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const from = new Date();
      from.setDate(from.getDate() - 90);
      const res  = await fetch("/api/integrations/google_search_console/query-sync", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ from: from.toISOString().slice(0, 10) }),
      });
      const body = await res.json();
      if (!res.ok) { setSyncMsg(`Sync failed: ${body.error ?? res.statusText}`); return; }
      setSyncMsg(`Synced ${body.rows ?? 0} query rows.`);
      await load(segment);
    } finally {
      setSyncing(false);
    }
  }

  async function handleGaSync() {
    setGaSyncing(true);
    setGaSyncMsg(null);
    try {
      const res  = await fetch("/api/integrations/google_analytics/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = await res.json();
      if (!res.ok) { setGaSyncMsg(`Sync failed: ${body.error ?? res.statusText}`); return; }
      setGaSyncMsg(`Synced ${body.rows ?? 0} rows.`);
      await loadGa();
    } finally {
      setGaSyncing(false);
    }
  }

  async function handleAeoSync() {
    setAeoSyncing(true);
    setAeoSyncMsg(null);
    try {
      const from = new Date();
      from.setDate(from.getDate() - 90);
      const res  = await fetch("/api/integrations/google_search_console/ai-overview-sync", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ from: from.toISOString().slice(0, 10) }),
      });
      const body = await res.json();
      if (!res.ok) { setAeoSyncMsg(`Sync failed: ${body.error ?? res.statusText}`); return; }
      setAeoSyncMsg(`Synced ${body.rows ?? 0} AI Overview query rows.`);
      await loadAeoOverview();
    } finally {
      setAeoSyncing(false);
    }
  }

  async function handleAiMentionSync() {
    setAiMentionSyncing(true);
    setAiMentionSyncMsg(null);
    try {
      const res  = await fetch("/api/integrations/ai-mention-sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) { setAiMentionSyncMsg(`Sync failed: ${body.error ?? res.statusText}`); return; }
      if (body.cooldown) {
        setAiMentionCooldownUntil(new Date(body.nextAvailableAt));
        setAiMentionSyncMsg(body.message);
        return;
      }
      setAiMentionCooldownUntil(null);
      const skipped = (body.skipped as string[] ?? []);
      setAiMentionSyncMsg(`Synced ${body.rows ?? 0} queries.${skipped.length ? ` (missing: ${skipped.join(", ")})` : ""}`);
      await loadAiVisibility();
    } finally {
      setAiMentionSyncing(false);
    }
  }

  async function handleAeoReadinessRefresh() {
    setAeoRefreshing(true);
    try {
      const res  = await fetch("/api/seo/aeo-readiness", { method: "POST" });
      const json = await res.json();
      setAeoReadiness(json.pillars ?? null);
    } finally {
      setAeoRefreshing(false);
    }
  }

  const primary    = data?.pillars.filter(p => p.isPrimary)  ?? [];
  const secondary  = data?.pillars.filter(p => !p.isPrimary) ?? [];

  return (
    <div className="space-y-6">
      {/* Channel toggle — SEO / AEO / GEO */}
      <div className="flex items-center gap-2 bg-slate-100 rounded-xl p-1.5 w-fit">
        {CHANNEL_OPTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setChannel(id)}
            className={cn(
              "flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all",
              channel === id
                ? "bg-white shadow text-slate-900"
                : "text-slate-500 hover:text-slate-700"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Channel description */}
      <p className="text-xs text-slate-400">
        {CHANNEL_OPTIONS.find(c => c.id === channel)?.description}
      </p>

      {/* ── SEO view ── */}
      {channel === "seo" && (
        <>
          {/* Controls */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            {/* Segment toggle */}
            <div className="flex items-center bg-slate-100 rounded-lg p-1 gap-1">
              {(["non-branded", "branded"] as Segment[]).map(s => (
                <button
                  key={s}
                  onClick={() => setSegment(s)}
                  className={cn(
                    "px-4 py-1.5 rounded-md text-sm font-medium transition-colors",
                    segment === s ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-700"
                  )}
                >
                  {s === "branded" ? "Branded" : "Non-Branded"}
                </button>
              ))}
            </div>

            {/* Sync button */}
            <div className="flex items-center gap-3">
              {data?.lastSyncedAt && (
                <span className="text-xs text-slate-400">
                  Last synced {new Date(data.lastSyncedAt).toLocaleDateString()}
                </span>
              )}
              {syncMsg && <span className="text-xs text-slate-500">{syncMsg}</span>}
              <button
                onClick={handleSync}
                disabled={syncing}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw className={cn("w-3.5 h-3.5", syncing && "animate-spin")} />
                {syncing ? "Syncing…" : "Sync GSC Data"}
              </button>
            </div>
          </div>

          {/* No data state */}
          {!loading && !data?.hasData && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-12 text-center text-slate-400">
              <p className="font-medium">No query data yet</p>
              <p className="text-sm mt-1">Click "Sync GSC Data" to pull the last 90 days of query data from Google Search Console.</p>
            </div>
          )}

          {/* Overview stat cards */}
          {data?.hasData && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <SparklineCard label="Impressions"  value={fmt(data.totals.impressions)}              icon={Eye}               sub="Last 90 days"        sparkline={data.dailySeries.map(d => d.impressions)} />
                <SparklineCard label="Clicks"        value={fmt(data.totals.clicks)}                  icon={MousePointerClick} sub="Last 90 days"        sparkline={data.dailySeries.map(d => d.clicks)} />
                <SparklineCard label="Avg CTR"       value={fmt(data.totals.ctr, "percent")}           icon={TrendingUp}        sub="Clicks ÷ impressions" sparkline={data.dailySeries.map(d => d.ctr ?? 0)} />
                <SparklineCard label="Avg Position"  value={fmt(data.totals.avgPosition, "position")}  icon={Crosshair}         sub="Lower is better"     sparkline={data.dailySeries.map(d => d.avgPosition ?? 0)} />
              </div>

              {/* Recommendations */}
              <Recommendations pillars={data.pillars} />

              {/* Primary pillars */}
              <div>
                <h2 className="text-sm font-semibold text-slate-700 mb-3">Primary Pillars</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {primary.map(p => <PillarCard key={p.id} pillar={p} />)}
                </div>
              </div>

              {/* Secondary pillars */}
              <div>
                <h2 className="text-sm font-semibold text-slate-700 mb-3">Supporting Pillars</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {secondary.map(p => <PillarCard key={p.id} pillar={p} />)}
                </div>
              </div>

          {/* Top queries table */}
              <div>
                <h2 className="text-sm font-semibold text-slate-700 mb-3">Top Queries</h2>
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Query</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Impressions</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Clicks</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">CTR</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Avg Position</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">90d Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topQueries.map((q, i) => (
                        <tr key={q.query} className={cn("border-b border-slate-50", i % 2 === 1 && "bg-slate-50/50")}>
                          <td className="px-4 py-2.5 text-slate-700">{q.query}</td>
                          <td className="px-4 py-2.5 text-right text-slate-600">{fmt(q.impressions)}</td>
                          <td className="px-4 py-2.5 text-right text-slate-600">{fmt(q.clicks)}</td>
                          <td className="px-4 py-2.5 text-right text-slate-600">{fmt(q.ctr, "percent")}</td>
                          <td className="px-4 py-2.5 text-right font-medium text-slate-700">{fmt(q.avgPosition, "position")}</td>
                          <td className="px-4 py-2.5 text-right"><PositionDelta change={q.positionChange ?? null} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {/* GA4 organic traffic section — always shown under SEO tab */}
          <div className="border-t border-slate-100 pt-6">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-700">Organic Traffic — Google Analytics</h2>
                <p className="text-xs text-slate-400 mt-0.5">Sessions, engagement & conversions from organic search · Last 90 days</p>
              </div>
              <div className="flex items-center gap-3">
                {gaData?.lastSyncedAt && (
                  <span className="text-xs text-slate-400">Last synced {new Date(gaData.lastSyncedAt).toLocaleDateString()}</span>
                )}
                {gaSyncMsg && <span className="text-xs text-slate-500">{gaSyncMsg}</span>}
                <button
                  onClick={handleGaSync}
                  disabled={gaSyncing}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", gaSyncing && "animate-spin")} />
                  {gaSyncing ? "Syncing…" : "Sync GA4 Data"}
                </button>
              </div>
            </div>

            {gaLoading && (
              <div className="text-sm text-slate-400 text-center py-8">Loading…</div>
            )}

            {!gaLoading && !gaData?.connected && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
                <p className="text-sm font-medium text-amber-800">Google Analytics not connected</p>
                <p className="text-xs text-amber-600 mt-1">Connect it under <a href="/integrations" className="underline">Integrations</a> to see organic traffic data.</p>
              </div>
            )}

            {!gaLoading && gaData?.connected && !gaData.hasData && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-400">
                <p className="font-medium text-sm">No GA4 data yet</p>
                <p className="text-xs mt-1">Click "Sync GA4 Data" to pull the last 90 days of organic traffic.</p>
              </div>
            )}

            {!gaLoading && gaData?.hasData && (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
                  <SparklineCard label="Sessions"         value={fmt(gaData.totals.sessions)}                 icon={Eye}               sub="Organic search"    sparkline={gaData.dailySeries.map(d => d.sessions)} />
                  <SparklineCard label="Users"            value={fmt(gaData.totals.users)}                    icon={TrendingUp}        sub="Unique visitors"   sparkline={gaData.dailySeries.map(d => d.users)} />
                  <SparklineCard label="Engaged Sessions" value={fmt(gaData.totals.engagedSessions)}          icon={MousePointerClick} sub="30s+ or 2+ pages"  sparkline={gaData.dailySeries.map(d => d.engagedSessions)} />
                  <SparklineCard label="Conversions"      value={fmt(gaData.totals.conversions)}              icon={Crosshair}         sub="GA4 goal events"   sparkline={gaData.dailySeries.map(d => d.conversions)} />
                  <SparklineCard label="Avg Bounce Rate"  value={fmt(gaData.totals.avgBounceRate, "percent")} icon={TrendingUp}        sub="Lower is better"   sparkline={gaData.dailySeries.map(d => d.avgBounceRate ?? 0)} />
                  <SparklineCard label="Avg Session"      value={fmtSec(gaData.totals.avgSessionSec)}         icon={Eye}               sub="Time on site"      sparkline={gaData.dailySeries.map(d => d.avgSessionSec ?? 0)} />
                </div>

                {/* GA4 industry benchmark comparison */}
                <GaBenchmarks totals={gaData.totals} />

                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Top Landing Pages by Organic Sessions</h3>
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Page</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Sessions</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Users</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Engaged</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Bounce</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Avg Session</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gaData.topPages.map((p, i) => (
                        <tr key={p.pagePath} className={cn("border-b border-slate-50", i % 2 === 1 && "bg-slate-50/50")}>
                          <td className="px-4 py-2.5 text-slate-700 font-mono text-xs truncate max-w-xs">{p.pagePath}</td>
                          <td className="px-4 py-2.5 text-right text-slate-600">{fmt(p.sessions)}</td>
                          <td className="px-4 py-2.5 text-right text-slate-600">{fmt(p.users)}</td>
                          <td className="px-4 py-2.5 text-right text-slate-600">{fmt(p.engagedSessions)}</td>
                          <td className="px-4 py-2.5 text-right text-slate-600">{fmt(p.bounceRate, "percent")}</td>
                          <td className="px-4 py-2.5 text-right text-slate-600">{fmtSec(p.avgSessionSec)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* ── AEO view ── */}
      {channel === "aeo" && (
        <div className="space-y-8">

          {/* ── Layer 0: AI Search Visibility (OpenAI + Gemini mention tracking) ── */}
          <div>
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-700">AI Search Visibility</h2>
                <p className="text-xs text-slate-400 mt-0.5">Does Zeni appear when buyers ask AI engines about your keyword pillars? · Source: OpenAI + Gemini</p>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {aiVisibility?.lastSyncedAt && (
                  <span className="text-xs text-slate-400">Last synced {new Date(aiVisibility.lastSyncedAt).toLocaleDateString()}</span>
                )}
                {aiMentionSyncMsg && <span className="text-xs text-slate-500">{aiMentionSyncMsg}</span>}
                <button
                  onClick={handleAiMentionSync}
                  disabled={aiMentionSyncing || (aiMentionCooldownUntil != null && aiMentionCooldownUntil > new Date())}
                  title={aiMentionCooldownUntil && aiMentionCooldownUntil > new Date() ? `Cooldown active — next sync available at ${aiMentionCooldownUntil.toLocaleTimeString()}` : undefined}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", aiMentionSyncing && "animate-spin")} />
                  {aiMentionSyncing ? "Querying AI engines…"
                    : aiMentionCooldownUntil && aiMentionCooldownUntil > new Date() ? `Next sync ${aiMentionCooldownUntil.toLocaleTimeString()}`
                    : "Sync AI Visibility"}
                </button>
              </div>
            </div>

            {aiVisibilityLoading && <div className="text-sm text-slate-400 py-8 text-center">Loading…</div>}

            {!aiVisibilityLoading && !aiVisibility?.hasData && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-400">
                <p className="font-medium text-sm">No AI visibility data yet</p>
                <p className="text-xs mt-1">Add <code className="bg-slate-100 px-1 rounded">OPENAI_API_KEY</code> and/or <code className="bg-slate-100 px-1 rounded">GEMINI_API_KEY</code> to <code className="bg-slate-100 px-1 rounded">.env.local</code>, then click "Sync AI Visibility".</p>
              </div>
            )}

            {!aiVisibilityLoading && aiVisibility?.hasData && (
              <>
                {/* Top stat row */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                  {/* Visibility score */}
                  <div className="bg-white rounded-xl border border-slate-200 p-5 col-span-2 lg:col-span-1 flex flex-col items-center justify-center text-center">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">AI Visibility</p>
                    <p className={cn(
                      "text-4xl font-bold",
                      (aiVisibility.visibilityScore ?? 0) >= 60 ? "text-emerald-600" :
                      (aiVisibility.visibilityScore ?? 0) >= 30 ? "text-amber-500" : "text-rose-500"
                    )}>{aiVisibility.visibilityScore}</p>
                    <p className="text-xs text-slate-400 mt-1">/ 100</p>
                  </div>

                  {/* Per-engine breakdown */}
                  {Object.entries(aiVisibility.engines).map(([engine, stats]) => (
                    <div key={engine} className="bg-white rounded-xl border border-slate-200 p-5">
                      <div className="flex items-center gap-2 mb-3">
                        {engine === "openai" ? (
                          <span className="text-xs font-bold bg-slate-900 text-white px-2 py-0.5 rounded">GPT</span>
                        ) : (
                          <span className="text-xs font-bold bg-blue-600 text-white px-2 py-0.5 rounded">Gemini</span>
                        )}
                        <span className="text-xs text-slate-400 uppercase tracking-wide">{engine === "openai" ? "OpenAI" : "Google"}</span>
                      </div>
                      <p className="text-2xl font-bold text-slate-900">{stats.mentions}</p>
                      <p className="text-xs text-slate-400 mt-0.5">mentions out of {stats.totalQueries} queries</p>
                      {stats.citedPages.length > 0 && (
                        <p className="text-xs text-indigo-600 mt-1">{stats.citedPages.length} cited page{stats.citedPages.length > 1 ? "s" : ""}</p>
                      )}
                    </div>
                  ))}

                  {/* Total cited pages */}
                  <div className="bg-white rounded-xl border border-slate-200 p-5">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-2">Cited Pages</p>
                    <p className="text-2xl font-bold text-slate-900">{aiVisibility.allCitedPages.length}</p>
                    <p className="text-xs text-slate-400 mt-0.5">Unique zeni.ai URLs cited</p>
                  </div>
                </div>

                {/* Per-pillar grid */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {aiVisibility.byPillar.map(pillar => {
                    const engines = Object.entries(pillar.engines);
                    const mentionCount = engines.filter(([, v]) => v).length;
                    const total = engines.length;
                    return (
                      <div key={pillar.pillarId} className={cn(
                        "rounded-xl border p-4",
                        mentionCount === total ? "border-emerald-200 bg-emerald-50" :
                        mentionCount > 0       ? "border-amber-200 bg-amber-50" :
                                                 "border-slate-200 bg-white"
                      )}>
                        <p className={cn("text-xs font-semibold mb-2 truncate",
                          mentionCount === total ? "text-emerald-800" :
                          mentionCount > 0       ? "text-amber-800" : "text-slate-700"
                        )}>{pillar.label}</p>
                        <div className="flex flex-wrap gap-1 mb-2">
                          {engines.map(([engine, mentioned]) => (
                            <span key={engine} className={cn(
                              "text-[10px] font-semibold px-1.5 py-0.5 rounded",
                              mentioned ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"
                            )}>
                              {mentioned ? "✓" : "✗"} {engine === "openai" ? "GPT" : "Gemini"}
                            </span>
                          ))}
                        </div>
                        {pillar.citedUrls.length > 0 && (
                          <p className="text-[10px] text-indigo-500 truncate">{pillar.citedUrls[0].replace("https://", "")}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-slate-100" />

          {/* ── Layer 2: AEO Content Readiness Score ── */}
          <div>
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-700">Content Readiness Score</h2>
                <p className="text-xs text-slate-400 mt-0.5">How well each pillar page is structured to be cited by AI Overview · Scored against 7 AEO signals</p>
              </div>
              <button
                onClick={handleAeoReadinessRefresh}
                disabled={aeoRefreshing}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw className={cn("w-3.5 h-3.5", aeoRefreshing && "animate-spin")} />
                {aeoRefreshing ? "Rescoring…" : "Refresh Scores"}
              </button>
            </div>

            {aeoReadinessLoading && <div className="text-sm text-slate-400 py-8 text-center">Fetching & scoring pillar pages…</div>}

            {!aeoReadinessLoading && aeoReadiness && (
              <>
                {/* Score grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-6">
                  {aeoReadiness.map(p => {
                    const grade = p.score >= 70 ? "strong" : p.score >= 40 ? "moderate" : "weak";
                    const cfg = {
                      strong:   { bg: "bg-emerald-50", border: "border-emerald-200", badge: "bg-emerald-100 text-emerald-700", bar: "bg-emerald-500", label: "Strong" },
                      moderate: { bg: "bg-amber-50",   border: "border-amber-200",   badge: "bg-amber-100 text-amber-700",   bar: "bg-amber-400",   label: "Moderate" },
                      weak:     { bg: "bg-rose-50",    border: "border-rose-200",    badge: "bg-rose-100 text-rose-700",    bar: "bg-rose-400",    label: "Needs work" },
                    }[grade];
                    const SIGNAL_LABELS: { key: keyof typeof p.signals; label: string; pts: number }[] = [
                      { key: "faqSchema",        label: "FAQ Schema",         pts: 20 },
                      { key: "questionHeadings", label: "Question Headings",  pts: 20 },
                      { key: "directAnswer",     label: "Direct Answer Para", pts: 20 },
                      { key: "lists",            label: "Structured Lists",   pts: 15 },
                      { key: "orgSchema",        label: "Org/Article Schema", pts: 15 },
                      { key: "metaDesc",         label: "Meta Description",   pts: 5  },
                      { key: "h1Present",        label: "H1 Present",         pts: 5  },
                    ];
                    return (
                      <div key={p.pillarId} className={cn("rounded-xl border p-4", cfg.bg, cfg.border)}>
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1 min-w-0 pr-2">
                            <p className="text-xs font-semibold text-slate-700 truncate">{p.label}</p>
                            {p.pageUrl && (
                              <a href={p.pageUrl} target="_blank" rel="noopener noreferrer"
                                 className="text-[10px] text-indigo-500 hover:underline truncate block max-w-full">
                                {p.pageUrl.replace("https://www.zeni.ai", "")}
                              </a>
                            )}
                            {!p.pageUrl && <p className="text-[10px] text-slate-400 italic">Page not discovered</p>}
                          </div>
                          <span className={cn("shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full", cfg.badge)}>
                            {cfg.label}
                          </span>
                        </div>

                        {/* Score bar */}
                        <div className="flex items-center gap-2 mb-3">
                          <div className="flex-1 h-2 bg-white/60 rounded-full overflow-hidden">
                            <div className={cn("h-2 rounded-full transition-all", cfg.bar)} style={{ width: `${p.score}%` }} />
                          </div>
                          <span className="text-sm font-bold text-slate-800 shrink-0">{p.score}/100</span>
                        </div>

                        {/* Signal checklist */}
                        <div className="space-y-1">
                          {SIGNAL_LABELS.map(s => (
                            <div key={s.key} className="flex items-center justify-between text-[10px]">
                              <span className={cn("flex items-center gap-1", p.signals[s.key] ? "text-slate-600" : "text-slate-400")}>
                                <span className={cn("w-3 h-3 rounded-full flex items-center justify-center text-white font-bold shrink-0",
                                  p.signals[s.key] ? "bg-emerald-500" : "bg-slate-200")}>
                                  {p.signals[s.key] ? "✓" : ""}
                                </span>
                                {s.label}
                              </span>
                              <span className={p.signals[s.key] ? "text-slate-500" : "text-slate-300"}>+{s.pts}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Signal legend */}
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-4">
                  <p className="text-xs font-semibold text-slate-600 mb-2">What each signal means</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-1 text-xs text-slate-500">
                    <span><strong className="text-slate-600">FAQ Schema</strong> — JSON-LD FAQPage markup (+20)</span>
                    <span><strong className="text-slate-600">Question Headings</strong> — H2/H3 phrased as questions (+20)</span>
                    <span><strong className="text-slate-600">Direct Answer Para</strong> — Concise 20–90 word answer near a keyword (+20)</span>
                    <span><strong className="text-slate-600">Structured Lists</strong> — Bulleted or numbered lists (+15)</span>
                    <span><strong className="text-slate-600">Org/Article Schema</strong> — Organization or Article JSON-LD (+15)</span>
                    <span><strong className="text-slate-600">Meta Description</strong> — 30+ char meta description (+5)</span>
                    <span><strong className="text-slate-600">H1 Present</strong> — At least one H1 tag on page (+5)</span>
                  </div>
                </div>
              </>
            )}

            {!aeoReadinessLoading && !aeoReadiness && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-400">
                <p className="font-medium text-sm">Scores not loaded yet</p>
                <p className="text-xs mt-1">Switch to this tab to trigger scoring, or click "Refresh Scores".</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── GEO view ── */}
      {channel === "geo" && (
        <div className="space-y-6">
          {/* Stat overview */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">ChatGPT Mentions</p>
              <p className="text-2xl font-bold text-slate-900">—</p>
              <p className="text-xs text-slate-400 mt-1">Tracked manually below</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">Perplexity Citations</p>
              <p className="text-2xl font-bold text-slate-900">—</p>
              <p className="text-xs text-slate-400 mt-1">Tracked manually below</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">Gemini / Copilot</p>
              <p className="text-2xl font-bold text-slate-900">—</p>
              <p className="text-xs text-slate-400 mt-1">Tracked manually below</p>
            </div>
          </div>

          {/* Manual tracking table */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-700">GEO Brand Mention Log</h2>
              <span className="text-xs text-slate-400">Manual entry — update weekly</span>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Prompt / Query</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">ChatGPT</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Perplexity</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Gemini</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Copilot</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    "Best AI bookkeeping software for startups",
                    "Best AI accounting tools",
                    "What is the best AI accountant",
                    "AI tools for month-end close",
                    "AI accounts payable automation",
                    "AI financial reporting tools",
                  ].map((prompt, i) => (
                    <tr key={prompt} className={cn("border-b border-slate-50", i % 2 === 1 && "bg-slate-50/50")}>
                      <td className="px-4 py-3 text-slate-700 font-medium">{prompt}</td>
                      {["chatgpt", "perplexity", "gemini", "copilot"].map(engine => (
                        <td key={engine} className="px-4 py-3 text-center">
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold bg-slate-100 text-slate-400">—</span>
                        </td>
                      ))}
                      <td className="px-4 py-3 text-slate-400 text-xs italic">Not yet verified</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-400 mt-2">
              Run each prompt in ChatGPT, Perplexity, Gemini, and Copilot. Mark ✓ if Zeni is mentioned or cited. Update this table weekly.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

