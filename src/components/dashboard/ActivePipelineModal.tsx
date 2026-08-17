"use client";

import { useState, useEffect } from "react";
import { X, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { AiInsightPanel } from "@/components/dashboard/AiInsightPanel";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import type { PipelineStageBreakdownResult } from "@/lib/integrations/hubspot";

function fmt(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

const SHORT_STAGE_LABELS: Record<string, string> = {
  "Demo Completed":    "Stage 1",
  "Progressing":       "Stage 3",
  "Ready to Purchase": "Stage 4",
  "Quote Signed":      "Stage 5",
};

const CHANNEL_CONFIG = [
  { key: "paid_media", label: "Paid Media", color: "#7c3aed" },
  { key: "organic",    label: "Organic",    color: "#10b981" },
  { key: "referral",   label: "Referral",   color: "#f59e0b" },
] as const;

function CustomTooltip({ active, payload, label }: {
  active?:  boolean;
  payload?: { name: string; value: number; color: string }[];
  label?:   string;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg p-3 text-xs min-w-[160px]">
      <p className="font-semibold text-slate-700 mb-2">{label}</p>
      {payload.map((p) => (
        p.value > 0 && (
          <div key={p.name} className="flex items-center justify-between gap-4 mb-1">
            <span className="flex items-center gap-1.5 text-slate-500">
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: p.color }} />
              {p.name}
            </span>
            <span className="font-medium text-slate-800">{fmt(p.value)}</span>
          </div>
        )
      ))}
      <div className="border-t border-slate-100 mt-2 pt-2 flex justify-between font-semibold text-slate-700">
        <span>Total</span>
        <span>{fmt(total)}</span>
      </div>
    </div>
  );
}

interface Props {
  open:     boolean;
  onClose:  () => void;
  channel?: string;
}

function stageChannelAmount(s: PipelineStageBreakdownResult["stages"][number], channel?: string): number {
  if (channel === "paid_media") return s.paid_media;
  if (channel === "organic")    return s.organic;
  if (channel === "referral")   return s.referral;
  return s.total;
}

interface CampaignRow { name: string; amount: number; }
interface CampaignData { paid_search: CampaignRow[]; paid_social: CampaignRow[]; }

export function ActivePipelineModal({ open, onClose, channel }: Props) {
  const [data, setData] = useState<PipelineStageBreakdownResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [campaignData, setCampaignData] = useState<CampaignData | null>(null);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setData(null);
    fetch("/api/pipeline/breakdown")
      .then((r) => r.json())
      .then((d) => { if (d.error) throw new Error(d.error); setData(d); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || channel !== "paid_media") return;
    setCampaignLoading(true);
    setCampaignData(null);
    fetch("/api/pipeline/active-campaign-breakdown")
      .then((r) => r.json())
      .then((d) => { if (!d.error) setCampaignData(d); })
      .catch(() => {})
      .finally(() => setCampaignLoading(false));
  }, [open, channel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Active Pipeline Breakdown</h3>
            <p className="text-xs text-slate-400 mt-0.5">Current open deals by stage and channel</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-56 gap-2 text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-56 text-red-500 text-sm">{error}</div>
          )}
          {data && !loading && (
            <>
              {/* Channel summary pills — filtered to active channel when specific */}
              <div className="flex flex-wrap gap-2 mb-6">
                {CHANNEL_CONFIG
                  .filter(({ key }) => !channel || channel === "all" || key === channel)
                  .map(({ key, label, color }) => (
                    <div key={key} className="flex items-center gap-2 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
                      <span className="text-xs text-slate-500">{label}</span>
                      <span className="text-xs font-semibold text-slate-800">{fmt(data.totals[key])}</span>
                    </div>
                  ))}
                <div className="flex items-center gap-2 bg-slate-900 rounded-lg px-3 py-2 ml-auto">
                  <span className="text-xs text-slate-400">Total</span>
                  <span className="text-xs font-bold text-white">{fmt(
                    channel === "paid_media" ? data.totals.paid_media :
                    channel === "organic"    ? data.totals.organic    :
                    channel === "referral"   ? data.totals.referral   :
                    data.totals.total
                  )}</span>
                </div>
              </div>

              {/* Bar chart — filtered to active channel when specific */}
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={data.stages}
                  margin={{ top: 4, right: 8, left: 8, bottom: 4 }}
                  barCategoryGap="30%"
                >
                  <CartesianGrid vertical={false} stroke="#f1f5f9" />
                  <XAxis
                    dataKey="stageLabel"
                    tick={{ fontSize: 11, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={fmt}
                    tick={{ fontSize: 11, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "#f8fafc" }} />
                  <Legend iconType="square" iconSize={8} wrapperStyle={{ fontSize: 11, paddingTop: 12 }} />
                  {CHANNEL_CONFIG
                    .filter(({ key }) => !channel || channel === "all" || key === channel)
                    .map(({ key, label, color }, i, arr) => (
                      <Bar
                        key={key}
                        dataKey={key}
                        name={label}
                        stackId="a"
                        fill={color}
                        radius={i === arr.length - 1 ? [3, 3, 0, 0] : undefined}
                      />
                    ))}
                </BarChart>
              </ResponsiveContainer>

              {/* Stage totals */}
              <div className="grid grid-cols-4 gap-2 mt-4">
                {data.stages.map((s) => (
                  <div key={s.stageLabel} className="text-center bg-slate-50 rounded-lg py-2 px-3">
                    <p className="text-[10px] text-slate-400 truncate">{s.stageLabel}</p>
                    <p className="text-xs font-semibold text-slate-700 mt-0.5">{fmt(stageChannelAmount(s, channel))}</p>
                  </div>
                ))}
              </div>

              {channel === "paid_media" && (campaignLoading || campaignData) && (
                <div className="mt-6">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
                    Pipeline by Campaign
                  </p>
                  {campaignLoading && !campaignData && (
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <Loader2 className="w-3 h-3 animate-spin" /> Loading campaigns…
                    </div>
                  )}
                  {campaignData && (
                    <div className="space-y-3">
                      {[
                        { key: "paid_search" as const, label: "Paid Search", color: "#6366f1" },
                        { key: "paid_social" as const, label: "Paid Social", color: "#7c3aed" },
                      ].map(({ key, label, color }) => {
                        const campaigns = campaignData[key] ?? [];
                        const total = campaigns.reduce((s, c) => s + c.amount, 0);
                        const isExpanded = expandedSources.has(key);
                        return (
                          <div key={key}>
                            <button
                              onClick={() => setExpandedSources((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key); else next.add(key);
                                return next;
                              })}
                              className="w-full text-left"
                            >
                              <div className="flex items-center justify-between mb-1">
                                <span className="flex items-center gap-1.5 text-xs text-slate-600">
                                  {isExpanded
                                    ? <ChevronDown className="w-3 h-3 text-slate-400" />
                                    : <ChevronRight className="w-3 h-3 text-slate-400" />}
                                  <span className="w-2 h-2 rounded-sm" style={{ background: color }} />
                                  {label}
                                </span>
                                <span className="text-xs font-semibold text-slate-800">{fmt(total)}</span>
                              </div>
                              <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: "100%", background: color }} />
                              </div>
                            </button>
                            {isExpanded && campaigns.length > 0 && (
                              <div className="mt-2 ml-5 space-y-1.5 border-l-2 pl-3" style={{ borderColor: `${color}40` }}>
                                {campaigns.map((c) => {
                                  const pct = total > 0 ? (c.amount / total) * 100 : 0;
                                  return (
                                    <div key={c.name} className="flex-1 min-w-0">
                                      <div className="flex items-center justify-between mb-0.5">
                                        <span className="text-[10px] text-slate-600 truncate max-w-[200px]" title={c.name}>{c.name}</span>
                                        <span className="text-[10px] font-semibold text-slate-700 ml-2 shrink-0">
                                          {fmt(c.amount)}
                                          <span className="ml-1 text-[9px] font-normal text-slate-400">{pct.toFixed(0)}%</span>
                                        </span>
                                      </div>
                                      <div className="h-1 rounded-full bg-slate-200 overflow-hidden">
                                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: `${color}99` }} />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* AI Insight Panel */}
        {data && !loading && (
          <AiInsightPanel
            payload={{
              cardLabel: "Active Pipeline Breakdown",
              byStage:   data.stages as unknown[],
              bySegment: CHANNEL_CONFIG.map(({ key, label }) => ({
                segment: label,
                total:   data.totals[key] ?? 0,
              })),
              grandTotal: data.totals.total,
            }}
          />
        )}
      </div>
    </div>
  );
}
