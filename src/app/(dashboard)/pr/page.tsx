import { Newspaper } from "lucide-react";

export default function PrPage() {
  return (
    <div className="p-8">
      <div className="flex items-center gap-3 mb-2">
        <Newspaper className="w-6 h-6 text-indigo-500" />
        <h1 className="text-2xl font-bold text-slate-900">PR</h1>
      </div>
      <p className="text-sm text-slate-500 mb-8">Press coverage & earned media</p>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-12 text-center text-slate-400">
        <Newspaper className="w-10 h-10 mx-auto mb-3 text-slate-300" />
        <p className="font-medium">Coming soon</p>
        <p className="text-sm mt-1">PR and earned media metrics will appear here.</p>
      </div>
    </div>
  );
}
