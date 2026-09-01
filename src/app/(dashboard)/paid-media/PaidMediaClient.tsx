"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  AreaChart, Area,
  BarChart, Bar,
  LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend,
} from "recharts";
import {
  RefreshCw, Megaphone, TrendingUp, MousePointerClick, Eye,
  DollarSign, BarChart2, Zap, ArrowUpDown, ChevronUp, ChevronDown,
  CalendarDays, Target, Send, Bot, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CampaignBreakdown {
  campaignId:        string;
  campaignName:      string;
  impressions:       number;
  clicks:            number;
  spend:             number;
  conversions:       number;
  conversionValue:   number;
  ctr:               number | null;
  cpc:               number | null;
  roas:              number | null;
  costPerConversion: number | null;
  invalidClicks:     number | null;
  searchImprShare:   number | null;
  searchTopIS:       number | null;
  searchAbsTopIS:    number | null;
  searchLostISRank:  number | null;
  searchLostISBudget: number | null;
}

interface RollingRow {
  label:             string;
  startDate:         string;
  endDate:           string;
  impressions:       number;
  clicks:            number;
  spend:             number;
  conversions:       number;
  conversionValue:   number;
  ctr:               number | null;
  cpc:               number | null;
  roas:              number | null;
  costPerConversion: number | null;
  invalidClicks:     number | null;
  searchImprShare:   number | null;
  searchTopIS:       number | null;
  searchAbsTopIS:    number | null;
  searchLostISRank:  number | null;
  searchLostISBudget: number | null;
  campaigns?:        CampaignBreakdown[];
}

interface RollingDelta {
  impressions:       number | null;
  clicks:            number | null;
  spend:             number | null;
  ctr:               number | null;
  cpc:               number | null;
  conversions:       number | null;
  conversionValue:   number | null;
  roas:              number | null;
  costPerConversion: number | null;
  invalidClicks:     number | null;
  searchImprShare:   number | null;
  searchTopIS:       number | null;
  searchAbsTopIS:    number | null;
  searchLostISRank:  number | null;
  searchLostISBudget: number | null;
}

interface FunnelMetrics {
  leads:      number | null;
  mqls:       number | null;
  sqos:       number | null;
  closedWon:  number | null;
  leadToMql:  number | null;
  mqlToSqo:   number | null;
  sqoToClose: number | null;
}

interface FunnelData {
  qtdStart:  string;
  qtdLabel:  string;
  prevLabel: string;
  current:   FunnelMetrics;
  prior:     FunnelMetrics;
}

interface RollingData {
  view:       "daily" | "weekly" | "monthly";
  dayName:    string;
  anchorDate: string;
  campaigns:  { campaignId: string; campaignName: string }[];
  rows:       RollingRow[];
  avg12:      RollingRow;
  wowDelta:   RollingDelta | null;
  wowPct:     RollingDelta | null;
  avg12Delta: RollingDelta | null;
  avg12Pct:   RollingDelta | null;
}

interface Campaign {
  campaignId:      string;
  campaignName:    string;
  spend:           number;
  clicks:          number;
  impressions:     number;
  conversions:     number;
  conversionValue: number;
  ctr:             number | null;
  cpc:             number | null;
  roas:            number | null;
}

interface DayPoint {
  date:        string;
  spend:       number;
  clicks:      number;
  impressions: number;
}

interface Summary {
  spend:           number;
  clicks:          number;
  impressions:     number;
  conversions:     number;
  conversionValue: number;
  ctr:             number | null;
  cpc:             number | null;
  roas:            number | null;
}

interface PaidMediaData {
  hasData:     boolean;
  days:        number;
  summary:     Summary;
  dailySeries: DayPoint[];
  campaigns:   Campaign[];
}

type SortKey = "spend" | "clicks" | "impressions" | "ctr" | "cpc" | "roas" | "conversions";
type SortDir = "asc" | "desc";

// Only these campaigns are shown — everything else is hidden
const ACTIVE_CAMPAIGNS = ["Performance Max", "S_Non-Brand", "S_Brand"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$$(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function fmtN(n: number | null | undefined, decimals = 0): string {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: decimals });
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return (n * 100).toFixed(2) + "%";
}

function fmtRoas(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(2)}×`;
}

function fmtCpc(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);
}

function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtDelta(v: number | null, fmt: (n: number) => string): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return sign + fmt(v);
}

function fmtPctDelta(v: number | null): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return sign + (v * 100).toFixed(1) + "%";
}

function deltaClass(v: number | null, lowerIsBetter = false): string {
  if (v == null || v === 0) return "text-slate-400";
  const positive = lowerIsBetter ? v < 0 : v > 0;
  return positive ? "text-emerald-600 font-semibold" : "text-red-500 font-semibold";
}

// ---------------------------------------------------------------------------
// Rolling Average Table
// ---------------------------------------------------------------------------

type RollingColDef = {
  key:          string;
  label:        string;
  fmt:          (v: number) => string;
  searchOnly?:  boolean;
  lowerBetter?: boolean;
  funnelOnly?:  boolean;
};

const ROLLING_COLS: RollingColDef[] = [
  { key: "impressions",       label: "Impressions",        fmt: (v) => fmtN(v) },
  { key: "clicks",            label: "Clicks",             fmt: (v) => fmtN(v) },
  { key: "ctr",               label: "CTR",                fmt: (v) => fmtPct(v) },
  { key: "spend",             label: "Cost",               fmt: (v) => fmt$$(v),  lowerBetter: true },
  { key: "cpc",               label: "CPC",                fmt: (v) => fmtCpc(v), lowerBetter: true },
  { key: "conversions",       label: "Conversions",        fmt: (v) => fmtN(v, 1) },
  { key: "conversionValue",   label: "Conv. Value",        fmt: (v) => fmt$$(v) },
  { key: "roas",              label: "ROAS",               fmt: (v) => fmtRoas(v) },
  { key: "costPerConversion", label: "Cost/Conv.",         fmt: (v) => fmtCpc(v), lowerBetter: true },
  { key: "invalidClicks",     label: "Invalid Clicks",     fmt: (v) => fmtN(v),   lowerBetter: true },
  { key: "searchImprShare",   label: "Search Impr. Share", fmt: (v) => fmtPct(v), searchOnly: true },
  { key: "searchTopIS",       label: "Search Top IS",      fmt: (v) => fmtPct(v), searchOnly: true },
  { key: "searchAbsTopIS",    label: "Abs. Top IS",        fmt: (v) => fmtPct(v), searchOnly: true },
  { key: "searchLostISRank",  label: "Lost IS (Rank)",     fmt: (v) => fmtPct(v), searchOnly: true, lowerBetter: true },
  { key: "searchLostISBudget",label: "Lost IS (Budget)",   fmt: (v) => fmtPct(v), searchOnly: true, lowerBetter: true },
  { key: "leads",             label: "Leads",              fmt: (v) => fmtN(v, 0), funnelOnly: true },
  { key: "mqls",              label: "MQLs",               fmt: (v) => fmtN(v, 0), funnelOnly: true },
  { key: "sqos",              label: "SQOs",               fmt: (v) => fmtN(v, 0), funnelOnly: true },
  { key: "closedWon",         label: "Closed Won",         fmt: (v) => fmtN(v, 0), funnelOnly: true },
];

function rollingVal(row: RollingRow | RollingDelta, key: string): number | null {
  const v = (row as unknown as Record<string, unknown>)[key];
  return typeof v === "number" ? v : null;
}

// ---------------------------------------------------------------------------
// Client-side rolling computation helpers (mirrors API logic)
// ---------------------------------------------------------------------------

function nullableAvg(vals: (number | null)[]): number | null {
  const valid = vals.filter((v): v is number => v != null);
  return valid.length > 0 ? valid.reduce((s, v) => s + v, 0) / valid.length : null;
}

function nullableSum(vals: (number | null)[]): number | null {
  const valid = vals.filter((v): v is number => v != null);
  return valid.length > 0 ? valid.reduce((s, v) => s + v, 0) : null;
}

function clientAvgRow(rows: RollingRow[]): RollingRow {
  const n = rows.length;
  if (n === 0) return { label: "12-period avg", startDate: "", endDate: "", impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, ctr: null, cpc: null, roas: null, costPerConversion: null, invalidClicks: null, searchImprShare: null, searchTopIS: null, searchAbsTopIS: null, searchLostISRank: null, searchLostISBudget: null };
  const impressions     = rows.reduce((s, r) => s + r.impressions, 0) / n;
  const clicks          = rows.reduce((s, r) => s + r.clicks, 0) / n;
  const spend           = rows.reduce((s, r) => s + r.spend, 0) / n;
  const conversions     = rows.reduce((s, r) => s + r.conversions, 0) / n;
  const conversionValue = rows.reduce((s, r) => s + r.conversionValue, 0) / n;
  const invSum          = nullableSum(rows.map(r => r.invalidClicks));
  return {
    label: "12-period avg", startDate: "", endDate: "",
    impressions, clicks, spend, conversions, conversionValue,
    ctr:               impressions > 0 ? clicks / impressions   : null,
    cpc:               clicks      > 0 ? spend  / clicks        : null,
    roas:              spend       > 0 ? conversionValue / spend : null,
    costPerConversion: conversions > 0 ? spend / conversions    : null,
    invalidClicks:      invSum != null ? invSum / n : null,
    searchImprShare:    nullableAvg(rows.map(r => r.searchImprShare)),
    searchTopIS:        nullableAvg(rows.map(r => r.searchTopIS)),
    searchAbsTopIS:     nullableAvg(rows.map(r => r.searchAbsTopIS)),
    searchLostISRank:   nullableAvg(rows.map(r => r.searchLostISRank)),
    searchLostISBudget: nullableAvg(rows.map(r => r.searchLostISBudget)),
  };
}

function clientDeltaRow(a: RollingRow, b: RollingRow): RollingDelta {
  function d(av: number | null, bv: number | null) { return av != null && bv != null ? av - bv : null; }
  return {
    impressions: d(a.impressions, b.impressions), clicks: d(a.clicks, b.clicks),
    spend: d(a.spend, b.spend), ctr: d(a.ctr, b.ctr), cpc: d(a.cpc, b.cpc),
    conversions: d(a.conversions, b.conversions), conversionValue: d(a.conversionValue, b.conversionValue),
    roas: d(a.roas, b.roas), costPerConversion: d(a.costPerConversion, b.costPerConversion),
    invalidClicks: d(a.invalidClicks, b.invalidClicks),
    searchImprShare: d(a.searchImprShare, b.searchImprShare),
    searchTopIS: d(a.searchTopIS, b.searchTopIS),
    searchAbsTopIS: d(a.searchAbsTopIS, b.searchAbsTopIS),
    searchLostISRank: d(a.searchLostISRank, b.searchLostISRank),
    searchLostISBudget: d(a.searchLostISBudget, b.searchLostISBudget),
  };
}

function clientPctDeltaRow(a: RollingRow, b: RollingRow): RollingDelta {
  function pd(av: number | null, bv: number | null) {
    return av != null && bv != null && bv !== 0 ? (av - bv) / Math.abs(bv) : null;
  }
  return {
    impressions: pd(a.impressions, b.impressions), clicks: pd(a.clicks, b.clicks),
    spend: pd(a.spend, b.spend), ctr: pd(a.ctr, b.ctr), cpc: pd(a.cpc, b.cpc),
    conversions: pd(a.conversions, b.conversions), conversionValue: pd(a.conversionValue, b.conversionValue),
    roas: pd(a.roas, b.roas), costPerConversion: pd(a.costPerConversion, b.costPerConversion),
    invalidClicks: pd(a.invalidClicks, b.invalidClicks),
    searchImprShare: pd(a.searchImprShare, b.searchImprShare),
    searchTopIS: pd(a.searchTopIS, b.searchTopIS),
    searchAbsTopIS: pd(a.searchAbsTopIS, b.searchAbsTopIS),
    searchLostISRank: pd(a.searchLostISRank, b.searchLostISRank),
    searchLostISBudget: pd(a.searchLostISBudget, b.searchLostISBudget),
  };
}

function buildCampaignRollingData(sourceData: RollingData, campaignId: string): RollingData {
  const rows: RollingRow[] = sourceData.rows.map(row => {
    const c = row.campaigns?.find(c => c.campaignId === campaignId);
    const impressions     = c?.impressions     ?? 0;
    const clicks          = c?.clicks          ?? 0;
    const spend           = c?.spend           ?? 0;
    const conversions     = c?.conversions     ?? 0;
    const conversionValue = c?.conversionValue ?? 0;
    return {
      label: row.label, startDate: row.startDate, endDate: row.endDate,
      impressions, clicks, spend, conversions, conversionValue,
      ctr:               impressions > 0 ? clicks / impressions   : null,
      cpc:               clicks      > 0 ? spend  / clicks        : null,
      roas:              spend       > 0 ? conversionValue / spend : null,
      costPerConversion: conversions > 0 ? spend / conversions    : null,
      invalidClicks:      c?.invalidClicks      ?? null,
      searchImprShare:    c?.searchImprShare    ?? null,
      searchTopIS:        c?.searchTopIS        ?? null,
      searchAbsTopIS:     c?.searchAbsTopIS     ?? null,
      searchLostISRank:   c?.searchLostISRank   ?? null,
      searchLostISBudget: c?.searchLostISBudget ?? null,
    };
  });

  const avg12      = clientAvgRow(rows);
  const wowDelta   = rows.length >= 2 ? clientDeltaRow(rows[0], rows[1]) : null;
  const wowPct     = rows.length >= 2 ? clientPctDeltaRow(rows[0], rows[1]) : null;
  const avg12Delta = rows.length >= 1 ? clientDeltaRow(rows[0], avg12) : null;
  const avg12Pct   = rows.length >= 1 ? clientPctDeltaRow(rows[0], avg12) : null;

  return { ...sourceData, rows, avg12, wowDelta, wowPct, avg12Delta, avg12Pct };
}


// ---------------------------------------------------------------------------
// Floating AI Chatbot (global, page-level)
// ---------------------------------------------------------------------------

interface ChatChart {
  title:   string;
  type:    "bar" | "line" | "area";
  xKey:    string;
  unit?:   string;
  series:  { key: string; label: string; color: string; dashed?: boolean }[];
  data:    Record<string, string | number>[];
}

interface ChatMsg {
  role:        "user" | "assistant";
  content:     string;
  charts?:     ChatChart[];
  suggestions?: string[];
}

interface ChatContext {
  data:        PaidMediaData | null;
  rollingData: RollingData   | null;
  funnelData:  FunnelData    | null;
  rollingView: string;
}

function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-1.5 text-sm leading-relaxed">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1" />;
        const isBullet = /^[-•]\s/.test(line.trim());
        const raw = isBullet ? line.trim().slice(2) : line;
        const parts = raw.split(/\*\*(.+?)\*\*/g);
        const nodes = parts.map((p, j) =>
          j % 2 === 1
            ? <strong key={j} className="font-semibold text-slate-900">{p}</strong>
            : p
        );
        return isBullet
          ? <div key={i} className="flex gap-1.5 items-start"><span className="text-indigo-400 mt-0.5 shrink-0">•</span><span>{nodes}</span></div>
          : <p key={i}>{nodes}</p>;
      })}
    </div>
  );
}

function ChatChartCard({ chart }: { chart: ChatChart }) {
  const fmtTick = (v: number) => {
    if (chart.unit === "$") return v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`;
    if (chart.unit === "%") return `${v}%`;
    if (chart.unit === "×") return `${v}×`;
    return v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v);
  };
  const fmtTooltip = (v: number) => {
    if (chart.unit === "$") return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    if (chart.unit === "%") return `${v}%`;
    if (chart.unit === "×") return `${v}×`;
    return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  };

  const commonAxis = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
      <XAxis dataKey={chart.xKey} tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
      <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={fmtTick} width={44} />
      <Tooltip
        formatter={(v: unknown) => [fmtTooltip(v as number)]}
        contentStyle={{ border: "1px solid #e2e8f0", borderRadius: "8px", fontSize: "11px" }}
      />
      {chart.series.length > 1 && <Legend wrapperStyle={{ fontSize: "11px" }} />}
    </>
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 mt-2">
      <p className="text-xs font-semibold text-slate-600 mb-2">{chart.title}</p>
      <ResponsiveContainer width="100%" height={140}>
        {chart.type === "bar" ? (
          <BarChart data={chart.data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            {commonAxis}
            {chart.series.map(s => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={32} />
            ))}
          </BarChart>
        ) : chart.type === "area" ? (
          <AreaChart data={chart.data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              {chart.series.map(s => (
                <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={s.color} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={s.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            {commonAxis}
            {chart.series.map(s => (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.label}
                stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? "5 3" : undefined}
                fill={`url(#grad-${s.key})`} dot={false} activeDot={{ r: 3 }} />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={chart.data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            {commonAxis}
            {chart.series.map(s => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label}
                stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? "5 3" : undefined}
                dot={false} activeDot={{ r: 3 }} />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function PaidMediaChatDrawer({ open, onClose, ctx }: { open: boolean; onClose: () => void; ctx: ChatContext }) {
  const [input,    setInput]    = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loading,  setLoading]  = useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(question?: string) {
    const q = (question ?? input).trim();
    if (!q || loading) return;
    setInput("");
    const history = messages.map(m => ({ role: m.role, content: m.content }));
    const newMsgs: ChatMsg[] = [...messages, { role: "user", content: q }];
    setMessages(newMsgs);
    setLoading(true);
    try {
      // Build per-campaign rolling rows so the AI has individual campaign data
      const campaignRolling = ctx.rollingData
        ? (ctx.rollingData.campaigns ?? [])
            .filter(c => ACTIVE_CAMPAIGNS.includes(c.campaignName))
            .map(c => {
              const d = buildCampaignRollingData(ctx.rollingData!, c.campaignId);
              return {
                campaignName: c.campaignName,
                campaignId:   c.campaignId,
                rows: d.rows.slice(0, 12).map(r => ({
                  period:        r.label,
                  spend:         r.spend,
                  impressions:   r.impressions,
                  clicks:        r.clicks,
                  ctr:           r.ctr != null ? parseFloat((r.ctr * 100).toFixed(2)) : null,
                  cpc:           r.cpc != null ? parseFloat(r.cpc.toFixed(2)) : null,
                  conversions:   r.conversions,
                  roas:          r.roas != null ? parseFloat(r.roas.toFixed(2)) : null,
                  searchImprShare:    r.searchImprShare    != null ? parseFloat((r.searchImprShare * 100).toFixed(1)) : null,
                  searchLostISRank:   r.searchLostISRank   != null ? parseFloat((r.searchLostISRank * 100).toFixed(1)) : null,
                  searchLostISBudget: r.searchLostISBudget != null ? parseFloat((r.searchLostISBudget * 100).toFixed(1)) : null,
                })),
              };
            })
        : [];

      const res = await fetch("/api/paid-media/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          question:        q,
          tableData:       ctx.rollingData ?? {},
          funnelData:      ctx.funnelData,
          summaryData:     ctx.data?.summary,
          campaigns:       ctx.data?.campaigns,
          campaignRolling,
          rollingView:     ctx.rollingView,
          messages:        history,
        }),
      });
      const json = await res.json();
      setMessages([...newMsgs, {
        role:        "assistant",
        content:     json.answer || json.error || "No response.",
        charts:      Array.isArray(json.charts) ? json.charts : [],
        suggestions: Array.isArray(json.suggestions) ? json.suggestions : [],
      }]);
    } catch {
      setMessages([...newMsgs, { role: "assistant", content: "Error reaching AI. Please try again." }]);
    } finally {
      setLoading(false);
    }
  }

  const INITIAL_SUGGESTIONS = [
    "How is Performance Max performing vs Search?",
    "Where are we losing impression share?",
    "What's driving our CPC trends?",
    "How does spend compare to 12-period average?",
  ];

  return (
    <div className={cn(
      "fixed top-0 right-0 z-50 h-full w-full max-w-md bg-white shadow-2xl flex flex-col transition-transform duration-300 ease-in-out border-l border-slate-200",
      open ? "translate-x-0" : "translate-x-full",
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-indigo-700 bg-indigo-600 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Paid Media AI</p>
            <p className="text-xs text-indigo-200">Powered by google-ads-analyzer</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
          <X className="w-4 h-4 text-white" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 bg-slate-50">
        {/* Welcome + initial suggestions */}
        <div className="space-y-3">
          <div className="flex gap-2.5">
            <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
              <Bot className="w-4 h-4 text-indigo-600" />
            </div>
            <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-slate-700 leading-relaxed shadow-sm">
              Hi! I can analyze your paid media performance — trends, IS diagnostics, campaign comparisons, budget pacing, and forecasts. What would you like to know?
            </div>
          </div>
          {messages.length === 0 && (
            <div className="grid grid-cols-1 gap-2 pl-9">
              {INITIAL_SUGGESTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-left text-xs px-3 py-2 rounded-lg border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {messages.map((m, i) => (
          <div key={i} className={cn("flex gap-2.5", m.role === "user" ? "justify-end" : "justify-start")}>
            {m.role === "assistant" && (
              <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
                <Bot className="w-4 h-4 text-indigo-600" />
              </div>
            )}
            <div className={cn("max-w-[88%]", m.role === "user" ? "flex flex-col items-end" : "space-y-2 w-full")}>
              <div className={cn(
                "rounded-2xl px-4 py-3",
                m.role === "user"
                  ? "bg-indigo-600 text-white rounded-tr-sm text-sm"
                  : "bg-white border border-slate-200 text-slate-700 rounded-tl-sm shadow-sm w-full",
              )}>
                {m.role === "user"
                  ? m.content
                  : <RichText text={m.content} />}
              </div>

              {/* Charts */}
              {m.role === "assistant" && m.charts && m.charts.length > 0 && (
                <div className="w-full space-y-2">
                  {m.charts.map((chart, ci) => (
                    <ChatChartCard key={ci} chart={chart} />
                  ))}
                </div>
              )}

              {/* Follow-up suggestions */}
              {m.role === "assistant" && m.suggestions && m.suggestions.length > 0 && i === messages.length - 1 && (
                <div className="w-full grid grid-cols-1 gap-1.5 pt-1">
                  {m.suggestions.map(s => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="text-left text-xs px-3 py-2 rounded-lg border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-2.5 justify-start">
            <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-indigo-600 animate-pulse" />
            </div>
            <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-slate-400 shadow-sm">
              Analyzing…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-4 border-t border-slate-200 bg-white shrink-0">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
            placeholder="Ask about your campaigns…"
            className="flex-1 text-sm rounded-xl border border-slate-200 px-4 py-2.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-slate-50"
          />
          <button
            onClick={() => send()}
            disabled={!input.trim() || loading}
            className={cn(
              "px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors flex items-center",
              input.trim() && !loading
                ? "bg-indigo-600 text-white hover:bg-indigo-700"
                : "bg-slate-100 text-slate-400 cursor-not-allowed",
            )}
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

type FunnelBucket = { leads: number; mqls: number; sqos: number; closedWon: number };

function RollingTable({ data, title, subtitle, hideIS, campaignId, campaignName }: { data: RollingData; title?: string; subtitle?: string; hideIS?: boolean; campaignId?: string; campaignName?: string }) {
  const { rows, avg12, wowDelta, wowPct, avg12Delta, avg12Pct, view, dayName } = data;

  // Per-period funnel data (campaign tables only)
  const [funnelRolling, setFunnelRolling] = useState<Record<string, FunnelBucket> | null>(null);
  const [funnelLoading, setFunnelLoading] = useState(false);

  useEffect(() => {
    if (!campaignId || rows.length === 0) return;
    const ranges = rows.map(r => `${r.startDate}~${r.endDate}`).join(",");
    setFunnelLoading(true);
    fetch(
      `/api/paid-media/funnel/campaign/rolling?campaignId=${encodeURIComponent(campaignId)}&campaignName=${encodeURIComponent(campaignName ?? "")}&ranges=${encodeURIComponent(ranges)}`
    )
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.connected) setFunnelRolling(d.data ?? null); })
      .finally(() => setFunnelLoading(false));
  }, [campaignId, campaignName, rows]);

  const funnelAvg = useMemo<FunnelBucket | null>(() => {
    if (!funnelRolling) return null;
    const vals = rows.map(r => funnelRolling[r.startDate]).filter((v): v is FunnelBucket => v != null);
    if (vals.length === 0) return null;
    const n = vals.length;
    return {
      leads:     vals.reduce((s, v) => s + v.leads, 0) / n,
      mqls:      vals.reduce((s, v) => s + v.mqls, 0) / n,
      sqos:      vals.reduce((s, v) => s + v.sqos, 0) / n,
      closedWon: vals.reduce((s, v) => s + v.closedWon, 0) / n,
    };
  }, [funnelRolling, rows]);

  const cols = (() => {
    let c = ROLLING_COLS;
    if (hideIS) c = c.filter(col => !col.searchOnly);
    if (!campaignId) c = c.filter(col => !col.funnelOnly);
    return c;
  })();

  const defaultSubtitle =
    view === "daily"   ? `Last 12 ${dayName}s` :
    view === "weekly"  ? "Last 12 Weeks" :
                         "Last 12 Months";
  const wowLabel =
    view === "daily"   ? "WoW Δ" :
    view === "weekly"  ? "Week-over-Week Δ" :
                         "MoM Δ";

  function DataCells({ row, funnelData }: { row: RollingRow | RollingDelta; funnelData?: FunnelBucket | null }) {
    return (
      <>
        {cols.map(col => (
          <td key={col.key} className="px-4 py-3 text-right tabular-nums text-slate-600 whitespace-nowrap">
            {(() => {
              if (col.funnelOnly) {
                if (funnelLoading && !funnelRolling) return <span className="text-slate-300 text-[10px]">…</span>;
                const v = funnelData != null ? (funnelData as unknown as Record<string, number>)[col.key] ?? null : null;
                return v != null ? col.fmt(v) : <span className="text-slate-300">—</span>;
              }
              const v = rollingVal(row, col.key);
              return v != null ? col.fmt(v) : <span className="text-slate-300">—</span>;
            })()}
          </td>
        ))}
      </>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">{title ?? "12-Period Rolling Average"}</h2>
            <p className="text-xs text-slate-400 mt-0.5">{subtitle ?? defaultSubtitle} · newest first</p>
          </div>
          {hideIS && (
            <span className="text-[10px] font-medium text-slate-400 bg-slate-100 rounded-md px-2 py-1 whitespace-nowrap">
              IS metrics N/A (Performance Max)
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100">
              <th className="sticky left-0 z-10 bg-slate-50 text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                {view === "daily" ? "Date" : view === "weekly" ? "Week" : "Month"}
              </th>
              {cols.map(col => (
                <th key={col.key} className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, i) => (
              <tr
                key={row.startDate}
                className={cn(
                  "transition-colors",
                  i === 0 ? "bg-indigo-50/30 hover:bg-indigo-50/50" : i % 2 === 1 ? "bg-slate-50/40 hover:bg-slate-100/60" : "hover:bg-slate-50/60",
                )}
              >
                <td className={cn("sticky left-0 z-10 px-4 py-3 font-medium whitespace-nowrap", i === 0 ? "bg-indigo-50/30 text-indigo-700" : "bg-white text-slate-900")}>
                  <span className="inline-flex items-center gap-2">
                    {row.label}
                    {i === 0 && <span className="text-xs text-indigo-400 font-normal">most recent</span>}
                  </span>
                </td>
                <DataCells row={row} funnelData={funnelRolling?.[row.startDate] ?? null} />
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-slate-200">
            <tr className="bg-slate-800 text-white">
              <td className="sticky left-0 z-10 bg-slate-800 px-6 py-3 text-xs font-bold uppercase tracking-wide whitespace-nowrap">
                12-Period Avg
              </td>
              {cols.map(col => (
                <td key={col.key} className="px-4 py-3 text-right tabular-nums text-slate-200 font-semibold whitespace-nowrap">
                  {(() => {
                    if (col.funnelOnly) {
                      const v = funnelAvg != null ? (funnelAvg as unknown as Record<string, number>)[col.key] ?? null : null;
                      return v != null ? col.fmt(v) : "—";
                    }
                    const v = rollingVal(avg12, col.key);
                    return v != null ? col.fmt(v) : "—";
                  })()}
                </td>
              ))}
            </tr>

            {wowDelta && wowPct && (
              <tr className="bg-slate-100 border-t border-slate-200">
                <td className="sticky left-0 z-10 bg-slate-100 px-6 py-2.5 text-xs font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap">
                  {wowLabel}
                </td>
                {cols.map(col => {
                  if (col.funnelOnly) {
                    // Compute funnel WoW delta: most recent period vs previous
                    const cur  = rows[0] ? funnelRolling?.[rows[0].startDate] : null;
                    const prev = rows[1] ? funnelRolling?.[rows[1].startDate] : null;
                    const raw  = cur && prev ? ((cur as unknown as Record<string,number>)[col.key] ?? 0) - ((prev as unknown as Record<string,number>)[col.key] ?? 0) : null;
                    return (
                      <td key={col.key} className={cn("px-4 py-2.5 text-right tabular-nums text-xs whitespace-nowrap", deltaClass(raw))}>
                        {raw != null ? fmtDelta(raw, col.fmt) : "—"}
                      </td>
                    );
                  }
                  const raw = rollingVal(wowDelta, col.key);
                  const pct = rollingVal(wowPct, col.key);
                  return (
                    <td key={col.key} className={cn("px-4 py-2.5 text-right tabular-nums text-xs whitespace-nowrap", deltaClass(raw, col.lowerBetter))}>
                      {raw != null ? (<><div>{fmtDelta(raw, col.fmt)}</div><div className="text-[10px] opacity-70">{fmtPctDelta(pct)}</div></>) : "—"}
                    </td>
                  );
                })}
              </tr>
            )}

            {avg12Delta && avg12Pct && (
              <tr className="bg-slate-50 border-t border-slate-200">
                <td className="sticky left-0 z-10 bg-slate-50 px-6 py-2.5 text-xs font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap">
                  vs 12-Period Avg
                </td>
                {cols.map(col => {
                  if (col.funnelOnly) {
                    const cur = rows[0] ? funnelRolling?.[rows[0].startDate] : null;
                    const raw = cur && funnelAvg ? ((cur as unknown as Record<string,number>)[col.key] ?? 0) - ((funnelAvg as unknown as Record<string,number>)[col.key] ?? 0) : null;
                    return (
                      <td key={col.key} className={cn("px-4 py-2.5 text-right tabular-nums text-xs whitespace-nowrap", deltaClass(raw))}>
                        {raw != null ? fmtDelta(raw, col.fmt) : "—"}
                      </td>
                    );
                  }
                  const raw = rollingVal(avg12Delta, col.key);
                  const pct = rollingVal(avg12Pct, col.key);
                  return (
                    <td key={col.key} className={cn("px-4 py-2.5 text-right tabular-nums text-xs whitespace-nowrap", deltaClass(raw, col.lowerBetter))}>
                      {raw != null ? (<><div>{fmtDelta(raw, col.fmt)}</div><div className="text-[10px] opacity-70">{fmtPctDelta(pct)}</div></>) : "—"}
                    </td>
                  );
                })}
              </tr>
            )}
          </tfoot>
        </table>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// HubSpot Funnel section
// ---------------------------------------------------------------------------

function FunnelKpiCard({
  label, value, sub, delta, deltaLabel,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: number | null;
  deltaLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
      {delta != null && (
        <p className={cn("mt-1.5 text-xs font-medium", delta >= 0 ? "text-emerald-600" : "text-red-500")}>
          {delta >= 0 ? "+" : ""}{fmtN(delta, 0)} {deltaLabel ?? "vs prior quarter"}
        </p>
      )}
    </div>
  );
}

type CampaignFunnelData = { leads: number; mqls: number; sqos: number; closedWon: number };

function HubSpotFunnelSection({
  data,
  campaigns,
}: {
  data: FunnelData;
  campaigns?: { campaignId: string; campaignName: string }[];
}) {
  const { current: c, prior: p, qtdLabel, prevLabel } = data;
  const [byCampaign, setByCampaign] = useState(false);
  const [campaignFunnel, setCampaignFunnel] = useState<Record<string, CampaignFunnelData> | null>(null);
  const [campaignLoading, setCampaignLoading] = useState(false);

  const CAMPAIGN_COLORS: Record<string, string> = {
    "Performance Max": "#6366f1",
    "S_Non-Brand":     "#818cf8",
    "S_Brand":         "#c7d2fe",
  };

  useEffect(() => {
    if (!byCampaign || !campaigns?.length || campaignFunnel) return;
    setCampaignLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    const range  = `${data.qtdStart}~${today}`;
    Promise.all(
      campaigns.map(async (cam) => {
        const url = `/api/paid-media/funnel/campaign/rolling?campaignId=${encodeURIComponent(cam.campaignId)}&campaignName=${encodeURIComponent(cam.campaignName)}&ranges=${encodeURIComponent(range)}`;
        const res = await fetch(url).then(r => r.ok ? r.json() : null);
        const bucket = res?.data?.[data.qtdStart] ?? { leads: 0, mqls: 0, sqos: 0, closedWon: 0 };
        return [cam.campaignName, bucket] as [string, CampaignFunnelData];
      })
    ).then(entries => {
      setCampaignFunnel(Object.fromEntries(entries));
      setCampaignLoading(false);
    });
  }, [byCampaign, campaigns, campaignFunnel, data.qtdStart]);

  function delta(cur: number | null, prev: number | null) {
    return cur != null && prev != null ? cur - prev : null;
  }

  const STAGES = [
    { key: "leads"     as const, label: "Leads"      },
    { key: "mqls"      as const, label: "MQLs"       },
    { key: "sqos"      as const, label: "SQOs"       },
    { key: "closedWon" as const, label: "Closed Won" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-semibold text-slate-900">Bottom-of-Funnel · HubSpot Attribution</span>
        </div>
        <div className="flex items-center gap-2">
          {campaigns && campaigns.length > 0 && (
            <button
              onClick={() => setByCampaign(v => !v)}
              className={cn(
                "text-xs rounded-md px-2.5 py-1 font-medium transition-colors",
                byCampaign
                  ? "bg-indigo-100 text-indigo-700"
                  : "bg-slate-100 text-slate-500 hover:bg-slate-200"
              )}
            >
              By Campaign
            </button>
          )}
          <span className="text-xs text-slate-400 bg-slate-100 rounded-md px-2.5 py-1 font-medium">
            {qtdLabel} QTD · vs {prevLabel}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <FunnelKpiCard
          label="Leads"
          value={c.leads != null ? fmtN(c.leads, 0) : "—"}
          sub="Paid media attributed"
          delta={delta(c.leads, p.leads)}
        />
        <FunnelKpiCard
          label="MQLs"
          value={c.mqls != null ? fmtN(c.mqls, 0) : "—"}
          sub={c.leadToMql != null ? `${(c.leadToMql * 100).toFixed(1)}% lead→MQL` : "Paid attributed"}
          delta={delta(c.mqls, p.mqls)}
        />
        <FunnelKpiCard
          label="SQOs"
          value={c.sqos != null ? fmtN(c.sqos, 0) : "—"}
          sub={c.mqlToSqo != null ? `${(c.mqlToSqo * 100).toFixed(1)}% MQL→SQO` : "Paid attributed"}
          delta={delta(c.sqos, p.sqos)}
        />
        <FunnelKpiCard
          label="Closed Won"
          value={c.closedWon != null ? fmtN(c.closedWon, 0) : "—"}
          sub={c.sqoToClose != null ? `${(c.sqoToClose * 100).toFixed(1)}% SQO→close` : "Paid attributed"}
          delta={delta(c.closedWon, p.closedWon)}
        />
      </div>

      {/* Per-campaign funnel breakdown */}
      {byCampaign && (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-4">
            Funnel by Campaign — {qtdLabel} QTD
          </p>
          {campaignLoading ? (
            <p className="text-xs text-slate-400 text-center py-4">Loading campaign data…</p>
          ) : campaignFunnel && campaigns ? (
            <div className="space-y-5">
              {campaigns.map(cam => {
                const f = campaignFunnel[cam.campaignName] ?? { leads: 0, mqls: 0, sqos: 0, closedWon: 0 };
                const color = CAMPAIGN_COLORS[cam.campaignName] ?? "#6366f1";
                const maxVal = Math.max(f.leads, 1);
                return (
                  <div key={cam.campaignId}>
                    <p className="text-xs font-semibold mb-2" style={{ color }}>{cam.campaignName}</p>
                    <div className="flex items-end gap-2">
                      {STAGES.map(({ key, label }) => {
                        const val = f[key];
                        const pct = val / maxVal;
                        return (
                          <div key={key} className="flex-1 flex flex-col items-center gap-1">
                            <span className="text-xs font-semibold text-slate-700">{fmtN(val, 0)}</span>
                            <div
                              className="w-full rounded-t-sm"
                              style={{ height: `${Math.max(pct * 80, 4)}px`, backgroundColor: color, opacity: key === "leads" ? 0.3 : key === "mqls" ? 0.55 : key === "sqos" ? 0.8 : 1 }}
                            />
                            <span className="text-[10px] text-slate-500 text-center">{label}</span>
                            {key !== "leads" && f.leads > 0 && (
                              <span className="text-[10px] text-slate-400">{((val / f.leads) * 100).toFixed(1)}%</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      )}

      {/* Funnel conversion rate bar */}
      {!byCampaign && (c.leads != null && c.leads > 0) && (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-4">
            Paid Media Funnel Conversion — {qtdLabel}
          </p>
          <div className="flex items-end gap-2">
            {[
              { label: "Leads",      value: c.leads,     color: "bg-indigo-200" },
              { label: "MQLs",       value: c.mqls,      color: "bg-indigo-400" },
              { label: "SQOs",       value: c.sqos,      color: "bg-indigo-600" },
              { label: "Closed Won", value: c.closedWon, color: "bg-indigo-800" },
            ].map(({ label, value, color }) => {
              const pct = value != null && c.leads != null && c.leads > 0 ? (value / c.leads) : 0;
              return (
                <div key={label} className="flex-1 flex flex-col items-center gap-1.5">
                  <span className="text-xs font-semibold text-slate-700">{value != null ? fmtN(value, 0) : "—"}</span>
                  <div className="w-full rounded-t-md" style={{ height: `${Math.max(pct * 120, 4)}px`, minHeight: "4px" }}>
                    <div className={cn("w-full h-full rounded-t-md", color)} />
                  </div>
                  <span className="text-[10px] text-slate-500 text-center">{label}</span>
                  {pct < 1 && <span className="text-[10px] text-slate-400">{(pct * 100).toFixed(1)}%</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {c.leads == null && c.mqls == null && (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
          <Target className="w-6 h-6 mx-auto mb-2 text-slate-300" />
          <p className="text-sm text-slate-500">No HubSpot paid-media funnel data for {qtdLabel} yet.</p>
          <p className="text-xs text-slate-400 mt-1">Run a HubSpot sync to populate leads, MQLs, SQOs, and Closed Won for paid channels.</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function KpiCard({
  label, value, sub, icon: Icon, accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent?: boolean;
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
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function SortIcon({ col, active, dir }: { col: string; active: string; dir: SortDir }) {
  if (col !== active) return <ArrowUpDown className="w-3 h-3 text-slate-300" />;
  return dir === "desc"
    ? <ChevronDown className="w-3 h-3 text-indigo-500" />
    : <ChevronUp   className="w-3 h-3 text-indigo-500" />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function PaidMediaClient() {
  const [days,         setDays]        = useState<30 | 90>(30);
  const [data,         setData]        = useState<PaidMediaData | null>(null);
  const [loading,      setLoading]     = useState(true);
  const [syncing,      setSyncing]     = useState(false);
  const [syncMsg,      setSyncMsg]     = useState<string | null>(null);
  const [sortKey,      setSortKey]     = useState<SortKey>("spend");
  const [sortDir,      setSortDir]     = useState<SortDir>("desc");
  const [chartView,    setChartView]   = useState<"spend" | "clicks">("spend");

  // Rolling average state
  const [rollingView,  setRollingView] = useState<"daily" | "weekly" | "monthly">("daily");
  const [rollingData,  setRollingData] = useState<RollingData | null>(null);
  const [rollingLoading, setRollingLoading] = useState(false);

  // HubSpot funnel state
  const [funnelData,    setFunnelData]    = useState<FunnelData | null>(null);
  const [backfilling,   setBackfilling]   = useState(false);

  // Global AI chat drawer
  const [chatOpen, setChatOpen] = useState(false);

  const load = useCallback(async (d: 30 | 90) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/paid-media/campaigns?days=${d}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRolling = useCallback(async (view: "daily" | "weekly" | "monthly") => {
    setRollingLoading(true);
    try {
      const res = await fetch(`/api/paid-media/rolling?view=${view}&campaignId=all`);
      if (res.ok) setRollingData(await res.json());
    } finally {
      setRollingLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [days, load]);
  useEffect(() => { loadRolling(rollingView); }, [rollingView, loadRolling]);
  useEffect(() => {
    fetch("/api/paid-media/funnel").then(r => r.ok ? r.json() : null).then(d => { if (d) setFunnelData(d); });
  }, []);

  async function runSync(daysBack: number, label: string) {
    setSyncMsg(null);
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - daysBack);
    const res  = await fetch("/api/integrations/google_ads/campaign-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ from: from.toISOString().slice(0, 10) }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `${label} failed`);
    setSyncMsg(`${label}: synced ${json.rows} rows across campaigns.`);
    await load(days);
    await loadRolling(rollingView);
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await runSync(84, "Synced"); // 12 weeks
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleBackfill() {
    setBackfilling(true);
    try {
      await runSync(365, "Backfill complete"); // 12 months
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : "Backfill failed");
    } finally {
      setBackfilling(false);
    }
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => d === "desc" ? "asc" : "desc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sortedCampaigns = data?.campaigns
    ? [...data.campaigns]
        .filter(c => ACTIVE_CAMPAIGNS.includes(c.campaignName))
        .sort((a, b) => {
          const av = a[sortKey] ?? -Infinity;
          const bv = b[sortKey] ?? -Infinity;
          return sortDir === "desc" ? (bv as number) - (av as number) : (av as number) - (bv as number);
        })
    : [];

  const summary = data?.summary;
  const hasRoas = (summary?.roas ?? null) !== null && (summary?.roas ?? 0) > 0;

  return (
    <div className="p-8 space-y-8">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Megaphone className="w-6 h-6 text-indigo-500" />
            <h1 className="text-2xl font-bold text-slate-900">Paid Media</h1>
          </div>
          <p className="text-sm text-slate-500">Campaign performance, ad spend &amp; ROAS</p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Date range toggle */}
          <div className="flex rounded-lg border border-slate-200 bg-slate-50 overflow-hidden text-sm">
            {([30, 90] as const).map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={cn(
                  "px-3 py-1.5 font-medium transition-colors",
                  days === d
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-700",
                )}
              >
                {d}d
              </button>
            ))}
          </div>

          {/* Sync button */}
          <button
            onClick={handleSync}
            disabled={syncing || backfilling}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors",
              syncing || backfilling
                ? "border-slate-200 text-slate-400 cursor-not-allowed"
                : "border-indigo-200 text-indigo-600 hover:bg-indigo-50",
            )}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", syncing && "animate-spin")} />
            {syncing ? "Syncing…" : "Sync Campaigns"}
          </button>

          {/* Backfill 12 months */}
          <button
            onClick={handleBackfill}
            disabled={syncing || backfilling}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors",
              syncing || backfilling
                ? "border-slate-200 text-slate-400 cursor-not-allowed"
                : "border-slate-200 text-slate-600 hover:bg-slate-50",
            )}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", backfilling && "animate-spin")} />
            {backfilling ? "Backfilling…" : "Backfill 12 Months"}
          </button>
        </div>
      </div>

      {syncMsg && (
        <div className={cn(
          "rounded-lg px-4 py-3 text-sm",
          syncMsg.toLowerCase().includes("fail") || syncMsg.toLowerCase().includes("error")
            ? "bg-red-50 text-red-700 border border-red-200"
            : "bg-green-50 text-green-700 border border-green-200",
        )}>
          {syncMsg}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Loading / empty state                                               */}
      {/* ------------------------------------------------------------------ */}
      {loading && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-12 text-center text-slate-400">
          <RefreshCw className="w-8 h-8 mx-auto mb-3 animate-spin text-slate-300" />
          <p className="text-sm">Loading campaign data…</p>
        </div>
      )}

      {!loading && !data?.hasData && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-12 text-center text-slate-400">
          <Megaphone className="w-10 h-10 mx-auto mb-3 text-slate-300" />
          <p className="font-medium text-slate-600">No campaign data yet</p>
          <p className="text-sm mt-1 mb-4">
            Click <strong>Sync Campaigns</strong> above to pull your Google Ads campaign data.
          </p>
          <p className="text-xs text-slate-400">
            Requires Google Ads connection in Integrations settings.
          </p>
        </div>
      )}

      {!loading && data?.hasData && (
        <>
          {/* -------------------------------------------------------------- */}
          {/* KPI Cards                                                        */}
          {/* -------------------------------------------------------------- */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <KpiCard label="Total Spend"   value={fmt$$(summary?.spend)}       sub={`Last ${days} days`}  icon={DollarSign}         accent />
            <KpiCard label="Impressions"   value={fmtN(summary?.impressions)}  sub="Ad views"             icon={Eye} />
            <KpiCard label="Clicks"        value={fmtN(summary?.clicks)}       sub="Link clicks"          icon={MousePointerClick} />
            <KpiCard label="Avg CTR"       value={fmtPct(summary?.ctr)}        sub="Click-through rate"   icon={TrendingUp} />
            <KpiCard label="Avg CPC"       value={fmtCpc(summary?.cpc)}        sub="Cost per click"       icon={BarChart2} />
            <KpiCard
              label="ROAS"
              value={hasRoas ? fmtRoas(summary?.roas) : "—"}
              sub={hasRoas ? "Conv. value / spend" : "Set up conversion tracking"}
              icon={Zap}
              accent={hasRoas}
            />
          </div>

          {/* -------------------------------------------------------------- */}
          {/* Trend Chart                                                      */}
          {/* -------------------------------------------------------------- */}
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Daily Performance</h2>
                <p className="text-xs text-slate-400 mt-0.5">Last {days} days</p>
              </div>
              <div className="flex rounded-lg border border-slate-200 bg-slate-50 overflow-hidden text-xs">
                {(["spend", "clicks"] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => setChartView(v)}
                    className={cn(
                      "px-3 py-1.5 font-medium transition-colors capitalize",
                      chartView === v
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-500 hover:text-slate-700",
                    )}
                  >
                    {v === "spend" ? "Spend ($)" : "Clicks"}
                  </button>
                ))}
              </div>
            </div>

            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={data.dailySeries} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="clicksGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#0ea5e9" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={shortDate}
                  tick={{ fontSize: 11, fill: "#94a3b8" }}
                  axisLine={false}
                  tickLine={false}
                  interval={Math.floor(data.dailySeries.length / 8)}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#94a3b8" }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                  tickFormatter={v =>
                    chartView === "spend"
                      ? "$" + (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)
                      : fmtN(v)
                  }
                />
                <Tooltip
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any) =>
                    chartView === "spend"
                      ? [fmt$$(value ?? 0), "Spend"]
                      : [fmtN(value ?? 0), "Clicks"]
                  }
                  labelFormatter={l => {
                    const d = new Date(String(l) + "T00:00:00");
                    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  }}
                  contentStyle={{ border: "1px solid #e2e8f0", borderRadius: "8px", fontSize: "12px" }}
                />
                {chartView === "spend" ? (
                  <Area
                    type="monotone"
                    dataKey="spend"
                    stroke="#6366f1"
                    strokeWidth={2}
                    fill="url(#spendGrad)"
                    dot={false}
                    activeDot={{ r: 4, fill: "#6366f1" }}
                  />
                ) : (
                  <Area
                    type="monotone"
                    dataKey="clicks"
                    stroke="#0ea5e9"
                    strokeWidth={2}
                    fill="url(#clicksGrad)"
                    dot={false}
                    activeDot={{ r: 4, fill: "#0ea5e9" }}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* -------------------------------------------------------------- */}
          {/* Campaign Table                                                   */}
          {/* -------------------------------------------------------------- */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Campaign Breakdown</h2>
                <p className="text-xs text-slate-400 mt-0.5">{ACTIVE_CAMPAIGNS.length} campaigns · last {days} days</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Campaign</th>
                    {(
                      [
                        { key: "spend",       label: "Spend" },
                        { key: "impressions", label: "Impressions" },
                        { key: "clicks",      label: "Clicks" },
                        { key: "ctr",         label: "CTR" },
                        { key: "cpc",         label: "CPC" },
                        { key: "conversions", label: "Conversions" },
                        { key: "roas",        label: "ROAS" },
                      ] as { key: SortKey; label: string }[]
                    ).map(col => (
                      <th
                        key={col.key}
                        onClick={() => toggleSort(col.key)}
                        className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide cursor-pointer hover:text-slate-700 select-none whitespace-nowrap"
                      >
                        <span className="inline-flex items-center gap-1 justify-end">
                          {col.label}
                          <SortIcon col={col.key} active={sortKey} dir={sortDir} />
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sortedCampaigns.map((c, i) => (
                    <tr key={c.campaignId} className={cn("hover:bg-slate-50 transition-colors", i % 2 === 0 ? "" : "bg-slate-50/40")}>
                      <td className="px-6 py-3.5 font-medium text-slate-900 max-w-[220px]">
                        <span className="block truncate" title={c.campaignName}>{c.campaignName || c.campaignId}</span>
                      </td>
                      <td className="px-4 py-3.5 text-right text-slate-700 tabular-nums font-medium">{fmt$$(c.spend)}</td>
                      <td className="px-4 py-3.5 text-right text-slate-500 tabular-nums">{fmtN(c.impressions)}</td>
                      <td className="px-4 py-3.5 text-right text-slate-500 tabular-nums">{fmtN(c.clicks)}</td>
                      <td className="px-4 py-3.5 text-right text-slate-500 tabular-nums">{fmtPct(c.ctr)}</td>
                      <td className="px-4 py-3.5 text-right text-slate-500 tabular-nums">{fmtCpc(c.cpc)}</td>
                      <td className="px-4 py-3.5 text-right text-slate-500 tabular-nums">{fmtN(c.conversions, 1)}</td>
                      <td className="px-4 py-3.5 text-right tabular-nums">
                        {c.roas != null && c.roas > 0 ? (
                          <span className={cn(
                            "inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold",
                            c.roas >= 3 ? "bg-green-50 text-green-700" :
                            c.roas >= 1 ? "bg-amber-50 text-amber-700" :
                                         "bg-red-50 text-red-700",
                          )}>
                            {fmtRoas(c.roas)}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/* Summary row */}
                <tfoot>
                  <tr className="bg-slate-50 border-t-2 border-slate-200">
                    <td className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Total</td>
                    <td className="px-4 py-3 text-right font-bold text-slate-900 tabular-nums">{fmt$$(summary?.spend)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtN(summary?.impressions)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtN(summary?.clicks)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtPct(summary?.ctr)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtCpc(summary?.cpc)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">{fmtN(summary?.conversions, 1)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular-nums">
                      {hasRoas ? fmtRoas(summary?.roas) : "—"}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* -------------------------------------------------------------- */}
          {/* Rolling Average Section                                          */}
          {/* -------------------------------------------------------------- */}
          <div className="space-y-4">
            {/* Controls */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-semibold text-slate-900">Rolling Averages</span>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {/* View toggle */}
                <div className="flex rounded-lg border border-slate-200 bg-slate-50 overflow-hidden text-sm">
                  {(["daily", "weekly", "monthly"] as const).map(v => (
                    <button
                      key={v}
                      onClick={() => setRollingView(v)}
                      className={cn(
                        "px-3 py-1.5 font-medium transition-colors",
                        rollingView === v
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700",
                      )}
                    >
                      {v === "daily" ? "Daily" : v === "weekly" ? "Weekly" : "Monthly"}
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => loadRolling(rollingView)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", rollingLoading && "animate-spin")} />
                  Refresh
                </button>
              </div>
            </div>

            {rollingLoading && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-10 text-center">
                <RefreshCw className="w-6 h-6 mx-auto mb-2 animate-spin text-slate-300" />
                <p className="text-sm text-slate-400">Building rolling averages…</p>
              </div>
            )}

            {!rollingLoading && rollingData && (
              rollingData.rows.length > 0 ? (
                <div className="space-y-6">
                  {/* All-campaigns aggregate table */}
                  <RollingTable data={rollingData} />

                  {/* Per-campaign tables — active campaigns only */}
                  {(rollingData.campaigns ?? []).map(c => {
                    if (!ACTIVE_CAMPAIGNS.includes(c.campaignName)) return null;
                    const campaignData = buildCampaignRollingData(rollingData, c.campaignId);
                    const hasData = campaignData.rows.some(r => r.spend > 0 || r.impressions > 0 || r.clicks > 0);
                    if (!hasData) return null;
                    const isPMax = /performance.?max|pmax/i.test(c.campaignName);
                    return (
                      <RollingTable
                        key={c.campaignId}
                        data={campaignData}
                        title={c.campaignName}
                        subtitle={`12-period rolling · ${rollingView === "daily" ? `${rollingData.dayName}s` : rollingView === "weekly" ? "weekly" : "monthly"}`}
                        hideIS={isPMax}
                        campaignId={c.campaignId}
                        campaignName={c.campaignName}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-10 text-center">
                  <CalendarDays className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                  <p className="text-sm text-slate-500">No data yet for this period.</p>
                  <p className="text-xs text-slate-400 mt-1">Run a campaign sync or backfill to populate historical data.</p>
                </div>
              )
            )}
          </div>

          {/* -------------------------------------------------------------- */}
          {/* HubSpot Bottom-of-Funnel                                        */}
          {/* -------------------------------------------------------------- */}
          {funnelData && (
            <HubSpotFunnelSection
              data={funnelData}
              campaigns={rollingData?.campaigns}
            />
          )}

          {/* -------------------------------------------------------------- */}
          {/* ROAS setup note (only when no ROAS data)                        */}
          {/* -------------------------------------------------------------- */}
          {!hasRoas && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-6 py-4">
              <div className="flex items-start gap-3">
                <Zap className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-amber-900">Set up conversion tracking to see ROAS</p>
                  <p className="text-xs text-amber-700 mt-1">
                    ROAS is calculated from <strong>Google Ads conversion value</strong>. Enable conversion tracking in Google Ads
                    (Tools → Conversions) and tag revenue events to see return-on-ad-spend per campaign.
                    Alternatively, HubSpot UTM attribution will be added in a future update to tie closed-won ARR to each campaign.
                  </p>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Floating AI Chat Button + Drawer                                    */}
      {/* ------------------------------------------------------------------ */}
      <button
        onClick={() => setChatOpen(true)}
        className={cn(
          "fixed bottom-6 right-6 z-40 flex items-center gap-2.5 px-4 py-3 rounded-2xl shadow-lg font-medium text-sm transition-all duration-200",
          chatOpen
            ? "opacity-0 pointer-events-none scale-90"
            : "bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-xl hover:scale-105",
        )}
      >
        <Bot className="w-5 h-5" />
        Ask AI
      </button>

      <PaidMediaChatDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        ctx={{ data, rollingData, funnelData, rollingView }}
      />
    </div>
  );
}
