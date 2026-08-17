"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  LayoutDashboard,
  Plug,
  TrendingUp,
  Target,
  ChevronRight,
  PencilLine,
  Sparkles,
  Search,
  Megaphone,
  Newspaper,
  Share2,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  {
    href: "/",
    label: "Overview",
    icon: LayoutDashboard,
    description: "Full-funnel snapshot",
  },
  {
    href: "/pacing",
    label: "Pacing",
    icon: Target,
    description: "vs. monthly targets",
  },
  {
    href: "/seo",
    label: "SEO / AEO / GEO",
    icon: Search,
    description: "Search & discoverability",
  },
  {
    href: "/paid-media",
    label: "Paid Media",
    icon: Megaphone,
    description: "Campaigns & ad spend",
  },
  {
    href: "/pr",
    label: "PR",
    icon: Newspaper,
    description: "Press & earned media",
  },
  {
    href: "/social",
    label: "Social Media",
    icon: Share2,
    description: "Social performance",
  },
  {
    href: "/manual",
    label: "Manual Entry",
    icon: PencilLine,
    description: "Enter data manually",
  },
  {
    href: "/ai-analyst",
    label: "AI Analyst",
    icon: Sparkles,
    description: "Company AI breakdown",
  },
  {
    href: "/integrations",
    label: "Integrations",
    icon: Plug,
    description: "Manage data sources",
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();

  return (
    <aside className="flex flex-col w-64 min-h-screen bg-slate-900 text-slate-100 shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-slate-700">
        <div className="w-8 h-8 rounded-lg bg-indigo-500 flex items-center justify-center shrink-0">
          <TrendingUp className="w-4 h-4 text-white" />
        </div>
        <div>
          <p className="text-sm font-semibold leading-none text-white">Marketing</p>
          <p className="text-xs text-slate-400 mt-0.5">Dashboard</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon, description }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors group",
                active
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium leading-none">{label}</p>
                <p
                  className={cn(
                    "text-xs mt-0.5 truncate",
                    active ? "text-indigo-200" : "text-slate-500"
                  )}
                >
                  {description}
                </p>
              </div>
              {active && <ChevronRight className="w-3 h-3 shrink-0 text-indigo-300" />}
            </Link>
          );
        })}
      </nav>

      {/* User + sign out */}
      <div className="px-3 py-3 border-t border-slate-700">
        {session?.user && (
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg">
            {session.user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={session.user.image} alt="" className="w-7 h-7 rounded-full shrink-0" />
            ) : (
              <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center shrink-0 text-xs font-semibold text-white">
                {session.user.name?.[0] ?? session.user.email?.[0] ?? "?"}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-slate-300 truncate">{session.user.name ?? session.user.email}</p>
              {session.user.name && <p className="text-[11px] text-slate-500 truncate">{session.user.email}</p>}
            </div>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="shrink-0 p-1.5 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
