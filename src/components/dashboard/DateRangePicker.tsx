"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { CalendarDays, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function todayIso(): string {
  return toIso(new Date());
}

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toIso(d);
}

function firstOfMonthIso(): string {
  const d = new Date();
  d.setDate(1);
  return toIso(d);
}

function quarterBounds(offset = 0): { from: string; to: string } {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + offset;  // quarter index, may be negative
  const year = now.getFullYear() + Math.floor(q / 4);
  const qi = ((q % 4) + 4) % 4;                        // normalise to 0-3
  const from = new Date(year, qi * 3, 1);
  const to   = new Date(year, qi * 3 + 3, 0);          // last day of quarter
  return { from: toIso(from), to: toIso(to) };
}

function firstOfYearIso(): string {
  return `${new Date().getFullYear()}-01-01`;
}

function formatRange(from: string, to: string): string {
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(f)} – ${fmt(t)}`;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

interface Preset {
  label: string;
  from: () => string;
  to: () => string;
}

const PRESETS: Preset[] = [
  { label: "Since Jan 2025", from: () => "2025-01-01",           to: todayIso },
  { label: "This quarter",   from: () => quarterBounds(0).from,  to: todayIso },
  { label: "Last quarter",   from: () => quarterBounds(-1).from, to: () => quarterBounds(-1).to },
  { label: "Year to date",   from: firstOfYearIso,               to: todayIso },
  { label: "Last 30 days",   from: () => daysAgoIso(29),         to: todayIso },
  { label: "Last 90 days",   from: () => daysAgoIso(89),         to: todayIso },
];

const DEFAULT_FROM = () => quarterBounds(0).from;
const DEFAULT_TO = todayIso;

function matchPreset(from: string, to: string): string | null {
  for (const p of PRESETS) {
    if (p.from() === from && p.to() === to) return p.label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
}

interface Props {
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DateRangePicker({ from, to }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);
  const [mode, setMode] = useState<"preset" | "custom">(
    matchPreset(from, to) ? "preset" : "custom"
  );

  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Sync local state when panel opens
  function handleOpen() {
    setCustomFrom(from);
    setCustomTo(to);
    setMode(matchPreset(from, to) ? "preset" : "custom");
    setOpen(true);
  }

  function apply(newFrom: string, newTo: string) {
    const params = new URLSearchParams(searchParams.toString());
    const defaultFrom = DEFAULT_FROM();
    const defaultTo = DEFAULT_TO();
    // If it matches the default, clear params to keep URL clean
    if (newFrom === defaultFrom && newTo === defaultTo) {
      params.delete("from");
      params.delete("to");
    } else {
      params.set("from", newFrom);
      params.set("to", newTo);
    }
    router.push(`${pathname}?${params.toString()}`);
    setOpen(false);
  }

  function selectPreset(preset: Preset) {
    apply(preset.from(), preset.to());
  }

  function applyCustom() {
    if (!customFrom || !customTo) return;
    if (customFrom > customTo) return;
    apply(customFrom, customTo);
  }

  function clearRange() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("from");
    params.delete("to");
    router.push(`${pathname}?${params.toString()}`);
    setOpen(false);
  }

  const presetLabel = matchPreset(from, to);
  const isDefault = from === DEFAULT_FROM() && to === DEFAULT_TO();
  const buttonLabel = presetLabel ?? formatRange(from, to);

  return (
    <div className="relative" ref={panelRef}>
      {/* Trigger button */}
      <button
        onClick={handleOpen}
        className={cn(
          "inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors border",
          open
            ? "bg-white border-indigo-300 text-slate-900 shadow-sm ring-1 ring-indigo-200"
            : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
        )}
      >
        <CalendarDays className="w-4 h-4 text-slate-400 shrink-0" />
        <span className="max-w-[180px] truncate">{buttonLabel}</span>
        {!isDefault && (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); clearRange(); }}
            className="ml-0.5 hover:text-red-500 transition-colors"
            title="Reset to default"
          >
            <X className="w-3.5 h-3.5" />
          </span>
        )}
        {isDefault && <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full mt-2 z-40 bg-white border border-slate-200 rounded-xl shadow-lg w-64 p-3">
          {/* Presets */}
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2 px-1">
            Quick select
          </p>
          <div className="space-y-0.5 mb-3">
            {PRESETS.map((preset) => {
              const active = presetLabel === preset.label;
              return (
                <button
                  key={preset.label}
                  onClick={() => selectPreset(preset)}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors",
                    active
                      ? "bg-indigo-50 text-indigo-700 font-medium"
                      : "text-slate-700 hover:bg-slate-50"
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          {/* Divider */}
          <div className="border-t border-slate-100 mb-3" />

          {/* Custom range */}
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2 px-1">
            Custom range
          </p>
          <div className="space-y-2">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Start date
              </label>
              <input
                type="date"
                value={customFrom}
                max={customTo || todayIso()}
                onChange={(e) => {
                  setCustomFrom(e.target.value);
                  setMode("custom");
                }}
                className="w-full text-xs rounded-lg border border-slate-200 px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                End date
              </label>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={todayIso()}
                onChange={(e) => {
                  setCustomTo(e.target.value);
                  setMode("custom");
                }}
                className="w-full text-xs rounded-lg border border-slate-200 px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            <button
              onClick={applyCustom}
              disabled={!customFrom || !customTo || customFrom > customTo}
              className={cn(
                "w-full px-4 py-2 rounded-lg text-sm font-semibold transition-colors",
                customFrom && customTo && customFrom <= customTo
                  ? "bg-indigo-600 text-white hover:bg-indigo-700"
                  : "bg-slate-100 text-slate-400 cursor-not-allowed"
              )}
            >
              Apply range
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
