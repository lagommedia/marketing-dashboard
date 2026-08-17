import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number | null | undefined, compact = false): string {
  if (value == null) return "—";
  if (compact && value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (compact && value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  // Floor to whole dollars — avoids fractional cents rounding up to a visually surprising integer
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.floor(value));
}

export function formatNumber(value: number | null | undefined, compact = false): string {
  if (value == null) return "—";
  if (compact && value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (compact && value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "Never";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date));
}

export function getPacingPercent(actual: number, target: number, elapsed: number): number {
  if (target === 0) return 0;
  const expectedAtPace = target * elapsed;
  return actual / expectedAtPace;
}
