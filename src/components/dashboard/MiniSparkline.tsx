"use client";

import { ComposedChart, Bar, Line, Cell, ResponsiveContainer, Tooltip } from "recharts";

export interface SparkPoint {
  label:     string;
  value:     number | null;
  isCurrent: boolean;
}

function fmtVal(v: number, format: "currency" | "number" | "ratio"): string {
  if (format === "ratio") return `${v.toFixed(1)}x`;
  if (format === "currency") {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
    return `$${Math.round(v)}`;
  }
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`;
  return `${Math.round(v)}`;
}

/** "Q2 2026" → "Q2 '26",  "Jan 2026" → "Jan '26" */
function abbrev(label: string): string {
  const m = label.match(/^(Q\d)\s+(\d{4})$/);
  if (m) return `${m[1]} '${m[2].slice(2)}`;
  const m2 = label.match(/^([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (m2) return `${m2[1]} '${m2[2].slice(2)}`;
  return label;
}

function SparkTooltip({ active, payload, format }: { active?: boolean; payload?: { value: number; payload: SparkPoint }[]; format: "currency" | "number" | "ratio" }) {
  if (!active || !payload?.length || payload[0].payload.value == null) return null;
  return (
    <div className="bg-slate-800 text-white text-[10px] px-2 py-1 rounded shadow-lg pointer-events-none">
      <p className="font-medium">{payload[0].payload.label}</p>
      <p>{fmtVal(payload[0].value, format)}</p>
    </div>
  );
}

export function MiniSparkline({
  data,
  format = "currency",
}: {
  data: SparkPoint[];
  format?: "currency" | "number" | "ratio";
}) {
  const nonNull = data.filter((d) => d.value != null);
  if (nonNull.length < 2) return null;

  const chartData = data.map((d) => ({ ...d, v: d.value ?? 0 }));

  return (
    <div>
      <ResponsiveContainer width="100%" height={44}>
        <ComposedChart data={chartData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <Tooltip content={(p: any) => <SparkTooltip {...p} format={format} />} cursor={false} />
          <Bar dataKey="v" maxBarSize={20} radius={[2, 2, 0, 0]} isAnimationActive={false}>
            {chartData.map((d, i) => (
              <Cell key={i} fill={d.isCurrent ? "#6366f1" : "#e2e8f0"} />
            ))}
          </Bar>
          <Line
            type="monotone"
            dataKey="v"
            stroke="#a5b4fc"
            strokeWidth={1.5}
            dot={{ r: 2, fill: "#6366f1", strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex justify-between px-0.5 mt-0.5">
        {data.map((d, i) => (
          <span
            key={i}
            className={`text-[9px] ${
              d.isCurrent ? "text-indigo-500 font-semibold" : "text-slate-400"
            }`}
          >
            {abbrev(d.label)}
          </span>
        ))}
      </div>
    </div>
  );
}
