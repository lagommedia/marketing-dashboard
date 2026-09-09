"use client";

import { useState } from "react";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { MetricTrendModal } from "@/components/dashboard/MetricTrendModal";
import { MiniSparkline } from "@/components/dashboard/MiniSparkline";
import { FunnelContactsPopover } from "@/components/dashboard/FunnelContactsPopover";
import type { MetricPace } from "@/components/dashboard/MetricCard";
import type { SparkPoint } from "@/components/dashboard/MiniSparkline";

const FUNNEL_POPOVER_METRICS = new Set(["mqls", "sqos", "closedWon"]);

interface Props {
  // Card display
  label:       string;
  value:       string;
  subValue?:   string;
  highlight?:  boolean;
  pace?:       MetricPace | null;
  sparkData?:  SparkPoint[];
  // Trend modal
  metric:      string;
  from:        string;
  to:          string;
  channel:     string;
  format:      "currency" | "number";
  /** Show stacked Paid Media / Organic / Referral breakdown in the trend chart */
  breakdown?:  boolean;
}

export function TrendableMetricCard({
  label, value, subValue, highlight, pace, sparkData,
  metric, from, to, channel, format, breakdown,
}: Props) {
  const [open, setOpen] = useState(false);

  const popoverMetric = metric === "closedWon" ? "closedwon" : metric as "mqls" | "sqos";
  const showPopover = FUNNEL_POPOVER_METRICS.has(metric);

  return (
    <>
      <MetricCard
        label={label}
        value={value}
        subValue={subValue ?? "click to see trend"}
        highlight={highlight}
        pace={pace}
        onClick={() => setOpen(true)}
        footer={sparkData ? <MiniSparkline data={sparkData} format={format} /> : undefined}
        infoPopover={showPopover ? (
          <FunnelContactsPopover
            metric={popoverMetric as "mqls" | "sqos" | "closedwon"}
            from={from}
            to={to}
          />
        ) : undefined}
      />
      <MetricTrendModal
        open={open}
        onClose={() => setOpen(false)}
        metric={metric}
        label={label}
        from={from}
        to={to}
        channel={channel}
        format={format}
        breakdown={breakdown}
      />
    </>
  );
}
