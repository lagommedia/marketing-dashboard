"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import type { Channel } from "@/types";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "all", label: "All Channels" },
  { value: "paid_media", label: "Paid Media" },
  { value: "organic", label: "Organic" },
  { value: "referral", label: "Referral" },
];

interface Props {
  active: Channel;
}

export function ChannelFilter({ active }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function select(channel: Channel) {
    const params = new URLSearchParams(searchParams.toString());
    if (channel === "all") {
      params.delete("channel");
    } else {
      params.set("channel", channel);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
      {CHANNELS.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => select(value)}
          className={cn(
            "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
            active === value
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
