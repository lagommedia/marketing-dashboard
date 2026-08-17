"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Check, Loader2, Tag } from "lucide-react";

interface CampaignRow {
  id:           string;
  campaignId:   string;
  campaignName: string;
}

export function CampaignNameEditor() {
  const [rows, setRows]         = useState<CampaignRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [newId, setNewId]       = useState("");
  const [newName, setNewName]   = useState("");
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/integrations/campaign-names");
      if (res.ok) setRows(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newId.trim() || !newName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/campaign-names", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: newId.trim(), campaignName: newName.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to save");
      }
      setNewId("");
      setNewName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(row: CampaignRow) {
    setDeletingId(row.id);
    try {
      await fetch(`/api/integrations/campaign-names/${row.id}`, { method: "DELETE" });
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="border-t border-slate-100 px-5 pb-5 pt-4">
      <div className="flex items-center gap-2 mb-3">
        <Tag className="w-3.5 h-3.5 text-slate-400" />
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
          Campaign Name Mappings
        </p>
        <span className="text-[11px] text-slate-400 font-normal normal-case tracking-normal">
          — maps utm_campaign IDs to readable names in revenue breakdowns
        </span>
      </div>

      {/* Existing rows */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-400 italic mb-3">No mappings yet — add your first one below.</p>
      ) : (
        <div className="mb-3 rounded-lg border border-slate-200 divide-y divide-slate-100 overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_1.5fr_auto] gap-3 px-3 py-1.5 bg-slate-50">
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Campaign ID</span>
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Display Name</span>
            <span />
          </div>
          {rows.map((row) => (
            <div key={row.id} className="grid grid-cols-[1fr_1.5fr_auto] gap-3 items-center px-3 py-2 bg-white hover:bg-slate-50 transition-colors">
              <span className="text-xs text-slate-500 font-mono truncate">{row.campaignId}</span>
              <span className="text-xs text-slate-800 font-medium truncate">{row.campaignName}</span>
              <button
                onClick={() => handleDelete(row)}
                disabled={deletingId === row.id}
                className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors disabled:opacity-40"
                title="Remove mapping"
              >
                {deletingId === row.id
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Trash2 className="w-3 h-3" />}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new row */}
      <form onSubmit={handleAdd} className="flex items-start gap-2">
        <div className="flex-1">
          <input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="Campaign ID (e.g. 22594522054)"
            className="w-full text-xs rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent font-mono"
          />
        </div>
        <div className="flex-[1.5]">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Display name (e.g. Brand — Exact Match)"
            className="w-full text-xs rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>
        <button
          type="submit"
          disabled={!newId.trim() || !newName.trim() || saving}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          {saving
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <><Plus className="w-3 h-3" /> Add</>}
        </button>
      </form>

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

      <p className="text-[11px] text-slate-400 mt-2">
        <Check className="w-3 h-3 inline text-emerald-500 mr-1" />
        Changes take effect immediately — no restart needed.
      </p>
    </div>
  );
}
