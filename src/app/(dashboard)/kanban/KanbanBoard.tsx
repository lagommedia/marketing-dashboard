"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, X, ChevronRight, Users, ArrowRight, Trash2,
  LayoutList, Columns3, UserPlus, GripVertical, Pencil,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

type Member = { id: string; name: string; email: string | null; color: string };

type Card = {
  id:          string;
  title:       string;
  description: string | null;
  type:        "backlog" | "sprint";
  status:      "backlog" | "not_started" | "in_progress" | "under_review" | "completed";
  storyPoints: number | null;
  assigneeId:  string | null;
  assignee:    Member | null;
  position:    number;
};

const FIBONACCI = [1, 2, 3, 5, 8, 13, 21];

const SPRINT_COLS: { key: Card["status"]; label: string; color: string; bg: string }[] = [
  { key: "not_started",  label: "Not Started",  color: "text-slate-500",   bg: "bg-slate-100" },
  { key: "in_progress",  label: "In Progress",  color: "text-blue-600",    bg: "bg-blue-50"   },
  { key: "under_review", label: "Under Review", color: "text-amber-600",   bg: "bg-amber-50"  },
  { key: "completed",    label: "Completed",    color: "text-emerald-600", bg: "bg-emerald-50"},
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string) {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function Avatar({ member, size = "sm" }: { member: Member; size?: "sm" | "md" }) {
  const sz = size === "md" ? "w-7 h-7 text-xs" : "w-5 h-5 text-[10px]";
  return (
    <span
      className={cn("rounded-full flex items-center justify-center font-semibold text-white shrink-0", sz)}
      style={{ background: member.color }}
      title={member.name}
    >
      {initials(member.name)}
    </span>
  );
}

function StoryBadge({ pts }: { pts: number }) {
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold shrink-0">
      {pts}
    </span>
  );
}

// ── Card Modal ───────────────────────────────────────────────────────────────

function CardModal({
  card,
  members,
  onSave,
  onDelete,
  onClose,
}: {
  card: Partial<Card> & { type: Card["type"]; status: Card["status"] };
  members: Member[];
  onSave: (data: Partial<Card>) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}) {
  const [title,       setTitle]       = useState(card.title ?? "");
  const [description, setDescription] = useState(card.description ?? "");
  const [pts,         setPts]         = useState<number | null>(card.storyPoints ?? null);
  const [assigneeId,  setAssigneeId]  = useState<string | null>(card.assigneeId ?? null);
  const [saving,      setSaving]      = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    await onSave({ title, description: description || null, storyPoints: pts, assigneeId });
    setSaving(false);
    onClose();
  }

  async function handleDelete() {
    if (!onDelete) return;
    setSaving(true);
    await onDelete();
    setSaving(false);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-900">
            {card.id ? "Edit card" : "New card"}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        <form onSubmit={submit} className="p-5 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Title *</label>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Card title"
              className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional description…"
              rows={3}
              className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
            />
          </div>

          {/* Story points */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Story points</label>
            <div className="flex gap-1.5 flex-wrap">
              {FIBONACCI.map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPts(pts === n ? null : n)}
                  className={cn(
                    "w-8 h-8 rounded-full text-xs font-bold transition-colors",
                    pts === n
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-indigo-100 hover:text-indigo-700"
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* Assignee */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Assignee</label>
            <select
              value={assigneeId ?? ""}
              onChange={e => setAssigneeId(e.target.value || null)}
              className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">Unassigned</option>
              {members.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            {onDelete && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="p-2.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                title="Delete card"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !title.trim()}
              className="flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "Saving…" : card.id ? "Save" : "Add card"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Member Panel ─────────────────────────────────────────────────────────────

function MemberPanel({ members, onAdd, onRemove, onClose }: {
  members: Member[];
  onAdd:    (name: string, email: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onClose:  () => void;
}) {
  const [name,   setName]   = useState("");
  const [email,  setEmail]  = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    await onAdd(name.trim(), email.trim());
    setName(""); setEmail("");
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-900">Team members</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Existing members */}
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {members.length === 0 && (
              <p className="text-xs text-slate-400 text-center py-3">No team members yet</p>
            )}
            {members.map(m => (
              <div key={m.id} className="flex items-center gap-3 py-1.5">
                <Avatar member={m} size="md" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{m.name}</p>
                  {m.email && <p className="text-xs text-slate-400 truncate">{m.email}</p>}
                </div>
                <button
                  onClick={() => onRemove(m.id)}
                  className="p-1.5 rounded-md text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* Add member */}
          <form onSubmit={submit} className="space-y-2 pt-2 border-t border-slate-100">
            <p className="text-xs font-medium text-slate-600">Add team member</p>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Name *"
              className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Email (optional)"
              className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="w-full px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {saving ? "Adding…" : "Add member"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Kanban Card Component ─────────────────────────────────────────────────────

function KanbanCard({
  card,
  onEdit,
  onDragStart,
  onDragEnd,
}: {
  card: Card;
  onEdit: () => void;
  onDragStart: (e: React.DragEvent, card: Card) => void;
  onDragEnd:   (e: React.DragEvent) => void;
}) {
  return (
    <div
      draggable
      onDragStart={e => onDragStart(e, card)}
      onDragEnd={onDragEnd}
      onClick={onEdit}
      className="bg-white rounded-xl border border-slate-200 p-3 shadow-sm cursor-pointer hover:shadow-md hover:border-indigo-200 transition-all group select-none"
    >
      <div className="flex items-start gap-2">
        <GripVertical className="w-3.5 h-3.5 text-slate-300 mt-0.5 shrink-0 group-hover:text-slate-400 transition-colors" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800 leading-snug">{card.title}</p>
          {card.description && (
            <p className="text-xs text-slate-500 mt-1 line-clamp-2">{card.description}</p>
          )}
          <div className="flex items-center gap-2 mt-2">
            {card.storyPoints != null && <StoryBadge pts={card.storyPoints} />}
            {card.assignee && <Avatar member={card.assignee} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Board ────────────────────────────────────────────────────────────────

export function KanbanBoard() {
  const [view,        setView]        = useState<"backlog" | "sprint">("backlog");
  const [cards,       setCards]       = useState<Card[]>([]);
  const [members,     setMembers]     = useState<Member[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [modal,       setModal]       = useState<{ card: Partial<Card> & { type: Card["type"]; status: Card["status"] } } | null>(null);
  const [memberPanel, setMemberPanel] = useState(false);

  // Drag state
  const dragging    = useRef<Card | null>(null);
  const [dragOver,  setDragOver] = useState<string | null>(null); // column key

  // ── Fetch ────────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    const [cardsRes, membersRes] = await Promise.all([
      fetch("/api/kanban/cards").then(r => r.json()),
      fetch("/api/kanban/members").then(r => r.json()),
    ]);
    setCards(cardsRes);
    setMembers(membersRes);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Card CRUD ────────────────────────────────────────────────────────────

  async function handleSaveCard(data: Partial<Card>) {
    const id = modal?.card.id;
    if (id) {
      const res = await fetch(`/api/kanban/cards/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const updated = await res.json();
      setCards(prev => prev.map(c => c.id === id ? updated : c));
    } else {
      const res = await fetch("/api/kanban/cards", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...modal?.card, ...data }),
      });
      const created = await res.json();
      setCards(prev => [...prev, created]);
    }
  }

  async function handleDeleteCard() {
    const id = modal?.card.id;
    if (!id) return;
    await fetch(`/api/kanban/cards/${id}`, { method: "DELETE" });
    setCards(prev => prev.filter(c => c.id !== id));
  }

  async function moveToSprint(card: Card) {
    const res = await fetch(`/api/kanban/cards/${card.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "sprint", status: "not_started" }),
    });
    const updated = await res.json();
    setCards(prev => prev.map(c => c.id === card.id ? updated : c));
  }

  async function moveToBacklog(card: Card) {
    const res = await fetch(`/api/kanban/cards/${card.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "backlog", status: "backlog" }),
    });
    const updated = await res.json();
    setCards(prev => prev.map(c => c.id === card.id ? updated : c));
  }

  // ── Member CRUD ──────────────────────────────────────────────────────────

  async function handleAddMember(name: string, email: string) {
    const res = await fetch("/api/kanban/members", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email }),
    });
    const member = await res.json();
    setMembers(prev => [...prev, member]);
  }

  async function handleRemoveMember(id: string) {
    await fetch(`/api/kanban/members/${id}`, { method: "DELETE" });
    setMembers(prev => prev.filter(m => m.id !== id));
    setCards(prev => prev.map(c => c.assigneeId === id ? { ...c, assigneeId: null, assignee: null } : c));
  }

  // ── Drag & Drop ──────────────────────────────────────────────────────────

  function onDragStart(e: React.DragEvent, card: Card) {
    dragging.current = card;
    e.dataTransfer.effectAllowed = "move";
  }

  function onDragEnd() {
    dragging.current = null;
    setDragOver(null);
  }

  function onDragOver(e: React.DragEvent, colKey: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(colKey);
  }

  async function onDrop(e: React.DragEvent, colKey: Card["status"]) {
    e.preventDefault();
    setDragOver(null);
    const card = dragging.current;
    if (!card || card.status === colKey) return;

    const res = await fetch(`/api/kanban/cards/${card.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: colKey, type: "sprint" }),
    });
    const updated = await res.json();
    setCards(prev => prev.map(c => c.id === card.id ? updated : c));
  }

  // ── Derived ──────────────────────────────────────────────────────────────

  const backlogCards = cards.filter(c => c.type === "backlog");
  const sprintCards  = (status: Card["status"]) => cards.filter(c => c.type === "sprint" && c.status === status);
  const totalSP      = (list: Card[]) => list.reduce((s, c) => s + (c.storyPoints ?? 0), 0);

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[400px]">
        <div className="w-6 h-6 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6 min-h-screen">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Marketing Kanban</h1>
          <p className="text-sm text-slate-500 mt-1">Backlog grooming and sprint planning</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMemberPanel(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <Users className="w-3.5 h-3.5" />
            Team
            {members.length > 0 && (
              <span className="flex items-center gap-0.5">
                {members.slice(0, 5).map(m => <Avatar key={m.id} member={m} />)}
                {members.length > 5 && <span className="text-slate-400 text-[10px]">+{members.length - 5}</span>}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* View toggle */}
      <div className="flex gap-1 p-1 bg-slate-100 rounded-xl w-fit">
        <button
          onClick={() => setView("backlog")}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
            view === "backlog" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
          )}
        >
          <LayoutList className="w-4 h-4" />
          Backlog
          {backlogCards.length > 0 && (
            <span className="ml-0.5 text-xs text-slate-500">{backlogCards.length}</span>
          )}
        </button>
        <button
          onClick={() => setView("sprint")}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
            view === "sprint" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
          )}
        >
          <Columns3 className="w-4 h-4" />
          Sprint Board
          {cards.filter(c => c.type === "sprint").length > 0 && (
            <span className="ml-0.5 text-xs text-slate-500">{cards.filter(c => c.type === "sprint").length}</span>
          )}
        </button>
      </div>

      {/* ── Backlog View ─────────────────────────────────────────────────── */}
      {view === "backlog" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-slate-800">Product Backlog</h2>
              {backlogCards.length > 0 && (
                <span className="text-xs text-slate-500">{totalSP(backlogCards)} pts</span>
              )}
            </div>
            <button
              onClick={() => setModal({ card: { type: "backlog", status: "backlog" } })}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add item
            </button>
          </div>

          {backlogCards.length === 0 ? (
            <div
              onClick={() => setModal({ card: { type: "backlog", status: "backlog" } })}
              className="flex flex-col items-center justify-center py-16 rounded-2xl border-2 border-dashed border-slate-200 text-slate-400 cursor-pointer hover:border-indigo-300 hover:text-indigo-400 transition-colors"
            >
              <Plus className="w-8 h-8 mb-2" />
              <p className="text-sm font-medium">Add your first backlog item</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
              {backlogCards
                .sort((a, b) => a.position - b.position)
                .map(card => (
                  <div
                    key={card.id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 group transition-colors"
                  >
                    <GripVertical className="w-4 h-4 text-slate-300 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{card.title}</p>
                      {card.description && (
                        <p className="text-xs text-slate-500 truncate">{card.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {card.storyPoints != null && <StoryBadge pts={card.storyPoints} />}
                      {card.assignee && <Avatar member={card.assignee} />}
                      <button
                        onClick={() => moveToSprint(card)}
                        title="Move to sprint"
                        className="opacity-0 group-hover:opacity-100 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-all"
                      >
                        Sprint <ArrowRight className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => setModal({ card })}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-all"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {/* ── Sprint Board View ─────────────────────────────────────────────── */}
      {view === "sprint" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-slate-800">Active Sprint</h2>
              {cards.filter(c => c.type === "sprint").length > 0 && (
                <span className="text-xs text-slate-500">
                  {totalSP(cards.filter(c => c.type === "sprint"))} pts total
                </span>
              )}
            </div>
            <button
              onClick={() => setModal({ card: { type: "sprint", status: "not_started" } })}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add to sprint
            </button>
          </div>

          <div className="grid grid-cols-4 gap-4">
            {SPRINT_COLS.map(col => {
              const colCards = sprintCards(col.key).sort((a, b) => a.position - b.position);
              const isDragTarget = dragOver === col.key;
              return (
                <div
                  key={col.key}
                  onDragOver={e => onDragOver(e, col.key)}
                  onDrop={e => onDrop(e, col.key)}
                  className={cn(
                    "rounded-2xl transition-colors min-h-[400px] flex flex-col",
                    isDragTarget ? "bg-indigo-50 ring-2 ring-indigo-300" : "bg-slate-50"
                  )}
                >
                  {/* Column header */}
                  <div className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={cn("text-xs font-semibold uppercase tracking-wide", col.color)}>
                        {col.label}
                      </span>
                      <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded-full", col.bg, col.color)}>
                        {colCards.length}
                      </span>
                    </div>
                    <button
                      onClick={() => setModal({ card: { type: "sprint", status: col.key } })}
                      className="p-1 rounded-md text-slate-400 hover:text-indigo-600 hover:bg-white transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Story points */}
                  {colCards.some(c => c.storyPoints != null) && (
                    <div className="px-4 pb-1">
                      <span className="text-[10px] text-slate-400">{totalSP(colCards)} pts</span>
                    </div>
                  )}

                  {/* Cards */}
                  <div className="flex-1 px-3 pb-3 space-y-2">
                    {colCards.map(card => (
                      <KanbanCard
                        key={card.id}
                        card={card}
                        onEdit={() => setModal({ card })}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                      />
                    ))}

                    {colCards.length === 0 && !isDragTarget && (
                      <div
                        onClick={() => setModal({ card: { type: "sprint", status: col.key } })}
                        className="flex items-center justify-center h-20 rounded-xl border-2 border-dashed border-slate-200 text-slate-300 cursor-pointer hover:border-indigo-200 hover:text-indigo-300 transition-colors"
                      >
                        <Plus className="w-5 h-5" />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Backlog → Sprint tip */}
          {backlogCards.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-slate-400 pt-2">
              <ChevronRight className="w-3 h-3" />
              Switch to Backlog view to move items into this sprint
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {modal && (
        <CardModal
          card={modal.card}
          members={members}
          onSave={handleSaveCard}
          onDelete={modal.card.id ? handleDeleteCard : undefined}
          onClose={() => setModal(null)}
        />
      )}

      {memberPanel && (
        <MemberPanel
          members={members}
          onAdd={handleAddMember}
          onRemove={handleRemoveMember}
          onClose={() => setMemberPanel(false)}
        />
      )}
    </div>
  );
}
