import { Suspense } from "react";
import { DateRangePicker } from "@/components/dashboard/DateRangePicker";
import PaidMediaClient from "./PaidMediaClient";

export const dynamic = "force-dynamic";

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function PaidMediaPage({ searchParams }: PageProps) {
  const sp      = await searchParams;
  const fromStr = sp.from ?? daysAgoIso(29);
  const toStr   = sp.to   ?? todayIso();

  return (
    <PaidMediaClient from={fromStr} to={toStr}>
      <Suspense>
        <DateRangePicker from={fromStr} to={toStr} />
      </Suspense>
    </PaidMediaClient>
  );
}
