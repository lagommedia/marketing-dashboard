import { Suspense } from "react";
import { DateRangePicker } from "@/components/dashboard/DateRangePicker";
import { SeoClient } from "./SeoClient";

export const dynamic = "force-dynamic";

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function SeoPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp   = await searchParams;
  const from = sp.from ?? daysAgoIso(89);
  const to   = sp.to   ?? todayIso();

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">SEO / AEO / GEO</h1>
          <p className="text-sm text-slate-500 mt-1">Search &amp; discoverability — powered by Google Search Console</p>
        </div>
        <DateRangePicker from={from} to={to} />
      </div>
      <Suspense fallback={<div className="text-slate-400 text-sm">Loading…</div>}>
        <SeoClient from={from} to={to} />
      </Suspense>
    </div>
  );
}
