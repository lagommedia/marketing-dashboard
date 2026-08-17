"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

export interface TrendDataPoint {
  date: string;
  [key: string]: number | string | null;
}

export interface LineConfig {
  key: string;
  label: string;
  color: string;
}

interface Props {
  data: TrendDataPoint[];
  lines: LineConfig[];
  formatter?: (value: number) => string;
  height?: number;
}

function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function longDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function TrendsChart({ data, lines, formatter, height = 200 }: Props) {
  const defaultFmt = (v: number) => Number(v).toLocaleString();
  const fmt = formatter ?? defaultFmt;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={shortDate}
          interval={4}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={fmt}
          width={52}
        />
        <Tooltip
          formatter={(value, name) => [
            fmt(Number(value)),
            lines.find((l) => l.key === name)?.label ?? String(name),
          ]}
          labelFormatter={(label) => longDate(String(label))}
          contentStyle={{
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            fontSize: "12px",
            boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
          }}
        />
        {lines.length > 1 && (
          <Legend
            formatter={(value) =>
              lines.find((l) => l.key === value)?.label ?? value
            }
            wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }}
          />
        )}
        {lines.map((line) => (
          <Line
            key={line.key}
            type="monotone"
            dataKey={line.key}
            stroke={line.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
