"use client";

import { useState, useEffect } from "react";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { ActivePipelineModal } from "@/components/dashboard/ActivePipelineModal";
import { MiniBarPreview, type MiniBarItem } from "@/components/dashboard/MiniBarPreview";
import { MiniSparkline } from "@/components/dashboard/MiniSparkline";
import type { SparkPoint } from "@/components/dashboard/MiniSparkline";
import type { PipelineStageBreakdownResult } from "@/lib/integrations/hubspot";

const STAGE_COLORS: Record<string, string> = {
  "Demo Completed":    "#a5b4fc",
  "Progressing":       "#6366f1",
  "Ready to Purchase": "#4338ca",
  "Quote Signed":      "#312e81",
};

interface Props {
  channel:    string;
  sparkData?: SparkPoint[];
}

/** Pick the channel-specific amount from a stage row. */
function stageAmount(s: PipelineStageBreakdownResult["stages"][number], channel: string): number {
  if (channel === "paid_media") return s.paid_media;
  if (channel === "organic")    return s.organic;
  if (channel === "referral")   return s.referral;
  return s.total;
}

function fmt(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function ActivePipelineCard({ channel, sparkData }: Props) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<MiniBarItem[] | null>(null);
  const [liveTotal, setLiveTotal] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/pipeline/breakdown")
      .then((r) => r.json())
      .then((d: PipelineStageBreakdownResult) => {
        if (!d.stages) return;
        setPreview(
          d.stages.map((s) => ({
            label: s.stageLabel,
            value: stageAmount(s, channel),
            color: STAGE_COLORS[s.stageLabel] ?? "#6366f1",
          }))
        );
        // Use the live channel total as the headline — point-in-time, not a DB sum
        if (d.totals) {
          setLiveTotal(stageAmount({ ...d.totals, stageLabel: "", stageId: "", paid_media: d.totals.paid_media, organic: d.totals.organic, referral: d.totals.referral, total: d.totals.total }, channel));
        }
      })
      .catch(() => {/* silently skip on error */});
  }, [channel]);

  return (
    <>
      <MetricCard
        label="Active Pipeline"
        value={fmt(liveTotal)}
        subValue="click to see breakdown"
        onClick={() => setOpen(true)}
        footer={sparkData ? <MiniSparkline data={sparkData} format="currency" /> : preview ? <MiniBarPreview items={preview} /> : undefined}
      />
      <ActivePipelineModal open={open} onClose={() => setOpen(false)} channel={channel} />
    </>
  );
}
