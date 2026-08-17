"use client";

function fmt(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

export interface MiniBarItem {
  label: string;
  value: number;
  color: string;
}

/** Vertical mini column chart — bars grow upward, label + value below */
export function MiniBarPreview({ items }: { items: MiniBarItem[] }) {
  const visible = items.filter((i) => i.value > 0);
  if (!visible.length) return null;
  const max = Math.max(...visible.map((i) => i.value));
  const BAR_HEIGHT = 48; // px — max column height

  return (
    <div className="flex items-end gap-2">
      {visible.map((item) => {
        const h = Math.max((item.value / max) * BAR_HEIGHT, 3);
        return (
          <div key={item.label} className="flex flex-col items-center gap-1 flex-1 min-w-0">
            <span className="text-[9px] font-medium text-slate-500">{fmt(item.value)}</span>
            <div
              className="w-full rounded-t-sm transition-all duration-700"
              style={{ height: `${h}px`, background: item.color }}
            />
            <span className="text-[9px] text-slate-400 truncate w-full text-center">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}
