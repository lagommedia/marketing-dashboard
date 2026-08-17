"use client";

import { useState, useEffect } from "react";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { PipelineBreakdownModal } from "@/components/dashboard/PipelineBreakdownModal";
import { MetricTrendModal } from "@/components/dashboard/MetricTrendModal";
import { type MiniBarItem } from "@/components/dashboard/MiniBarPreview";
import { MiniPiePreview } from "@/components/dashboard/MiniPiePreview";
import { MiniSparkline } from "@/components/dashboard/MiniSparkline";
import type { SparkPoint } from "@/components/dashboard/MiniSparkline";
import type { MetricPace } from "@/components/dashboard/MetricCard";
import type { PipelineBreakdownResult } from "@/lib/integrations/hubspot";

const SEGMENT_COLORS: Record<string, string> = {
  Starter:    "#a5b4fc",
  Discovery:  "#818cf8",
  Growth:     "#6366f1",
  Enterprise: "#4338ca",
  Other:      "#cbd5e1",
};

interface Props {
  value:      string;
  from:       string;
  to:         string;
  channel:    string;
  pace?:      MetricPace | null;
  sparkData?: SparkPoint[];
}

/** Returns the ISO date of the first day of the quarter that is `n` quarters before the quarter containing `toStr`. */
function twelveQuartersFrom(toStr: string): string {
  const to  = new Date(toStr + "T00:00:00");
  let q     = Math.floor(to.getMonth() / 3) - 11;
  let yr    = to.getFullYear();
  while (q < 0) { q += 4; yr--; }
  return new Date(yr, q * 3, 1).toISOString().slice(0, 10);
}

export function NewPipelineCard({ value, from, to, channel, pace, sparkData }: Props) {
  const [open, setOpen]           = useState(false);
  const [trendOpen, setTrendOpen] = useState(false);
  const [preview, setPreview]     = useState<MiniBarItem[] | null>(null);
  const previewUrl = `/api/pipeline/new-breakdown?from=${from}&to=${to}&channel=${channel}`;

  // Always show 12 quarters in the breakdown modal regardless of selected range
  const trendFrom  = twelveQuartersFrom(to);
  const trendUrl   = `/api/pipeline/new-breakdown?from=${trendFrom}&to=${to}`;

  // Fetch segment preview for the mini pie chart (always "all" channels, selected range only)
  useEffect(() => {
    fetch(previewUrl)
      .then((r) => r.json())
      .then((d: PipelineBreakdownResult) => {
        if (!d.bySegment) return;
        setPreview(
          d.bySegment
            .filter((s) => s.total > 0 && s.segment !== "Other")
            .map((s) => ({
              label: s.segment,
              value: s.total,
              color: SEGMENT_COLORS[s.segment] ?? "#6366f1",
            }))
        );
      })
      .catch(() => {/* silently skip preview on error */});
  }, [previewUrl]);

  return (
    <>
      <MetricCard
        label="New Pipeline Generated"
        value={value}
        subValue="click to see trend"
        pace={pace}
        onClick={() => channel === "paid_media" ? setTrendOpen(true) : setOpen(true)}
        footer={sparkData ? <MiniSparkline data={sparkData} format="currency" /> : preview ? <MiniPiePreview items={preview} /> : undefined}
      />
      <PipelineBreakdownModal
        open={open}
        onClose={() => setOpen(false)}
        url={trendUrl}
        title="New Pipeline Generated — Trend"
        subtitle="Last 12 quarters by segment · channel toggle applies"
        initialChannel={(channel === "all" ? "all" : channel) as "all" | "paid_media" | "organic" | "referral"}
      />
      <MetricTrendModal
        open={trendOpen}
        onClose={() => setTrendOpen(false)}
        metric="pipeline"
        label="New Pipeline Generated"
        from={from}
        to={to}
        channel={channel}
        format="currency"
      />
    </>
  );
}
