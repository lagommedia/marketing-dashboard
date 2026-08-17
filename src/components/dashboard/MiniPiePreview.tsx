"use client";

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import type { MiniBarItem } from "./MiniBarPreview";

function fmt(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

function CustomTooltip({ active, payload }: {
  active?:  boolean;
  payload?: { name: string; value: number; payload: { color: string } }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-md px-2.5 py-1.5 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.payload.color }} />
        <span className="text-slate-600">{p.name}</span>
        <span className="font-semibold text-slate-800 ml-1">{fmt(p.value)}</span>
      </span>
    </div>
  );
}

export function MiniPiePreview({ items }: { items: MiniBarItem[] }) {
  const visible = items.filter((i) => i.value > 0);
  if (!visible.length) return null;

  return (
    <div className="flex items-center gap-3">
      {/* Donut chart */}
      <div className="shrink-0" style={{ width: 80, height: 80 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={visible}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={22}
              outerRadius={36}
              strokeWidth={2}
              stroke="#fff"
            >
              {visible.map((item) => (
                <Cell key={item.label} fill={item.color} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      {/* Legend */}
      <div className="flex flex-col gap-1 min-w-0">
        {(() => {
          const total = visible.reduce((s, i) => s + i.value, 0);
          return visible.map((item) => {
            const pct = total > 0 ? Math.round((item.value / total) * 100) : 0;
            return (
              <div key={item.label} className="flex items-center gap-1.5 min-w-0">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: item.color }} />
                <span className="text-[10px] text-slate-400 truncate">{item.label}</span>
                <span className="text-[10px] font-semibold text-slate-600 ml-auto pl-1 shrink-0">
                  {fmt(item.value)}
                </span>
                <span className="text-[10px] text-slate-400 shrink-0">
                  {pct}%
                </span>
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
}
