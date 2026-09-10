"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Info, Loader2, ExternalLink } from "lucide-react";

interface Contact {
  name: string;
  url:  string;
}

const LABEL: Record<string, string> = {
  mqls:      "MQL Contacts",
  sqos:      "SQO Meetings",
  closedwon: "Closed Won Deals",
};

interface Props {
  metric: "mqls" | "sqos" | "closedwon";
  from:   string; // YYYY-MM-DD
  to:     string; // YYYY-MM-DD
}

export function FunnelContactsPopover({ metric, from, to }: Props) {
  const [open,     setOpen]     = useState(false);
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const wrapRef  = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (contacts || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/hubspot/funnel-contacts?metric=${metric}&from=${from}&to=${to}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setContacts(data.contacts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [metric, from, to, contacts, loading]);

  function handleMouseEnter() {
    timerRef.current = setTimeout(() => { setOpen(true); load(); }, 150);
  }

  function handleMouseLeave() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setOpen(false);
  }

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation(); // don't bubble to the card's onClick (trend modal)
    setOpen(v => !v);
    load();
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className="relative inline-flex items-center"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        onClick={handleClick}
        className="p-0.5 rounded text-slate-300 hover:text-indigo-500 transition-colors"
        aria-label={`View ${LABEL[metric]}`}
      >
        <Info className="w-3 h-3" />
      </button>

      {open && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 bg-white rounded-xl shadow-xl border border-slate-200 z-50">
          {/* Header */}
          <div className="px-3 py-2 border-b border-slate-100">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              {LABEL[metric]}
            </p>
          </div>

          {/* Body */}
          <div className="max-h-64 overflow-y-auto py-1">
            {loading && (
              <div className="flex justify-center py-5">
                <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
              </div>
            )}
            {error && (
              <p className="text-xs text-red-500 px-3 py-2">{error}</p>
            )}
            {!loading && contacts && contacts.length === 0 && (
              <p className="text-xs text-slate-400 px-3 py-3 text-center">No records in this period</p>
            )}
            {contacts && contacts.map((c, i) => (
              <a
                key={i}
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-indigo-50 group transition-colors"
              >
                <span className="flex-1 text-xs text-slate-700 truncate group-hover:text-indigo-700 min-w-0">
                  {c.name}
                </span>
                <ExternalLink className="w-3 h-3 text-slate-300 group-hover:text-indigo-500 shrink-0" />
              </a>
            ))}
          </div>

          {contacts && contacts.length >= 100 && (
            <div className="px-3 py-1.5 border-t border-slate-100">
              <p className="text-[10px] text-slate-400">Showing first 100 records</p>
            </div>
          )}

          {/* Tooltip arrow */}
          <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-white" />
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-px w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-slate-200" style={{ marginTop: "1px" }} />
        </div>
      )}
    </div>
  );
}
