"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

interface FunnelStage {
  name: string;
  value: number;
  color: string;
}

interface Props {
  data: FunnelStage[];
}

export function FunnelChart({ data }: Props) {
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 0, right: 60, bottom: 0, left: 0 }}
        barCategoryGap="30%"
      >
        <XAxis type="number" domain={[0, max]} hide />
        <YAxis
          type="category"
          dataKey="name"
          width={120}
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          formatter={(value) => [Number(value).toLocaleString(), "Count"]}
          contentStyle={{
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            fontSize: "12px",
            boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
          }}
        />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} minPointSize={4}>
          {data.map((entry, index) => (
            <Cell key={index} fill={entry.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
