import { Suspense } from "react";
import { SeoClient } from "./SeoClient";

export const dynamic = "force-dynamic";

export default function SeoPage() {
  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">SEO / AEO / GEO</h1>
        <p className="text-sm text-slate-500 mt-1">Search & discoverability — powered by Google Search Console</p>
      </div>
      <Suspense fallback={<div className="text-slate-400 text-sm">Loading…</div>}>
        <SeoClient />
      </Suspense>
    </div>
  );
}
