"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, X, Users, ArrowRight, Trash2,
  LayoutList, Columns3, History, GripVertical, Pencil,
  Flag, CheckCircle2, ChevronDown, ChevronUp, Calendar,
  Target, BarChart2, TrendingUp, TrendingDown, Minus,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

type Member = { id: string; name: string; email: string | null; color: string };

type ChecklistItem = {
  id:          string;
  cardId:      string;
  title:       string;
  completed:   boolean;
  storyPoints: number | null;
  assigneeId:  string | null;
  assignee:    Member | null;
  position:    number;
};

type Card = {
  id:          string;
  title:       string;
  description: string | null;
  type:        "backlog" | "sprint";
  status:      "backlog" | "not_started" | "in_progress" | "under_review" | "completed";
  storyPoints: number | null;
  dueDate:     string | null;
  assigneeId:  string | null;
  assignee:    Member | null;
  sprintId:    string | null;
  checklist:   ChecklistItem[];
  position:    number;
};

type Sprint = {
  id:          string;
  name:        string;
  goal:        string | null;
  startDate:   string | null;
  endDate:     string | null;
  status:      "active" | "completed";
  completedAt: string | null;
  createdAt:   string;
  cards:       Card[];
};

const FIBONACCI = [1, 2, 3, 5, 8, 13, 21];

const SPRINT_COLS: { key: Card["status"]; label: string; color: string; bg: string; dot: string }[] = [
  { key: "not_started",  label: "Not Started",  color: "text-slate-500",   bg: "bg-slate-100",   dot: "bg-slate-400"   },
  { key: "in_progress",  label: "In Progress",  color: "text-blue-600",    bg: "bg-blue-50",     dot: "bg-blue-500"    },
  { key: "under_review", label: "Under Review", color: "text-amber-600",   bg: "bg-amber-50",    dot: "bg-amber-500"   },
  { key: "completed",    label: "Completed",    color: "text-emerald-600", bg: "bg-emerald-50",  dot: "bg-emerald-500" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string) {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function fmtDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function totalPts(cards: Card[]) {
  return cards.reduce((s, c) => s + (c.storyPoints ?? 0), 0);
}

function Avatar({ member, size = "sm" }: { member: Member; size?: "sm" | "md" | "lg" }) {
  const sz = size === "lg" ? "w-8 h-8 text-xs" : size === "md" ? "w-6 h-6 text-[10px]" : "w-5 h-5 text-[10px]";
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

function StoryBadge({ pts, size = "sm" }: { pts: number; size?: "sm" | "md" }) {
  const sz = size === "md" ? "w-6 h-6 text-xs" : "w-5 h-5 text-[10px]";
  return (
    <span className={cn("inline-flex items-center justify-center rounded-full bg-indigo-100 text-indigo-700 font-bold shrink-0", sz)}>
      {pts}
    </span>
  );
}

// ── Card Modal ───────────────────────────────────────────────────────────────

type PendingItem = { tempId: string; title: string; storyPoints: number | null; assigneeId: string | null };

function CardModal({
  card, members, onSave, onDelete, onClose,
}: {
  card: Partial<Card> & { type: Card["type"]; status: Card["status"] };
  members: Member[];
  onSave:   (data: Partial<Card>, pendingItems: PendingItem[]) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose:  () => void;
}) {
  const [title,       setTitle]       = useState(card.title ?? "");
  const [description, setDescription] = useState(card.description ?? "");
  const [pts,         setPts]         = useState<number | null>(card.storyPoints ?? null);
  const [assigneeId,  setAssigneeId]  = useState<string | null>(card.assigneeId ?? null);
  const [dueDate,     setDueDate]     = useState(card.dueDate ? card.dueDate.slice(0, 10) : "");
  const [saving,      setSaving]      = useState(false);

  // Saved checklist items (existing card)
  const [checklist,       setChecklist]       = useState<ChecklistItem[]>(card.checklist ?? []);
  // Pending items for new cards (not yet persisted)
  const [pendingItems,    setPendingItems]     = useState<PendingItem[]>([]);
  const [newItemTitle,    setNewItemTitle]     = useState("");
  const [newItemPts,      setNewItemPts]       = useState<number | null>(null);
  const [newItemAssignee, setNewItemAssignee]  = useState<string | null>(null);
  const [addingItem,      setAddingItem]       = useState(false);

  const isExisting = !!card.id;

  const isOverdue = dueDate && new Date(dueDate) < new Date() && card.status !== "completed";

  // ── Card save ──────────────────────────────────────────────────────────────

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    await onSave(
      { title, description: description || null, storyPoints: pts, assigneeId, dueDate: dueDate || null },
      pendingItems,
    );
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

  // ── Checklist helpers ─────────────────────────────────────────────────────

  function addPendingOrSavedItem(e: React.FormEvent) {
    e.preventDefault();
    if (!newItemTitle.trim()) return;
    if (isExisting) {
      // Persist immediately
      setAddingItem(true);
      fetch(`/api/kanban/cards/${card.id}/checklist`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newItemTitle, storyPoints: newItemPts, assigneeId: newItemAssignee }),
      })
        .then(r => r.json())
        .then(item => {
          setChecklist(prev => [...prev, item]);
          setNewItemTitle(""); setNewItemPts(null); setNewItemAssignee(null);
          setAddingItem(false);
        });
    } else {
      // Stage locally — will be created after the card is saved
      setPendingItems(prev => [...prev, {
        tempId: crypto.randomUUID(),
        title: newItemTitle.trim(),
        storyPoints: newItemPts,
        assigneeId: newItemAssignee,
      }]);
      setNewItemTitle(""); setNewItemPts(null); setNewItemAssignee(null);
    }
  }

  async function toggleItem(item: ChecklistItem) {
    const res = await fetch(`/api/kanban/checklist/${item.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: !item.completed }),
    });
    const updated = await res.json();
    setChecklist(prev => prev.map(i => i.id === item.id ? updated : i));
  }

  async function deleteItem(id: string) {
    await fetch(`/api/kanban/checklist/${id}`, { method: "DELETE" });
    setChecklist(prev => prev.filter(i => i.id !== id));
  }

  function removePending(tempId: string) {
    setPendingItems(prev => prev.filter(i => i.tempId !== tempId));
  }

  async function updateItemAssignee(item: ChecklistItem, memberId: string | null) {
    const res = await fetch(`/api/kanban/checklist/${item.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeId: memberId }),
    });
    const updated = await res.json();
    setChecklist(prev => prev.map(i => i.id === item.id ? updated : i));
  }

  const allItems   = isExisting ? checklist : pendingItems.map(p => ({ ...p, id: p.tempId, cardId: "", completed: false, assignee: members.find(m => m.id === p.assigneeId) ?? null, position: 0 })) as ChecklistItem[];
  const doneCount  = checklist.filter(i => i.completed).length;
  const totalCount = allItems.length;
  const donePts    = checklist.filter(i => i.completed).reduce((s, i) => s + (i.storyPoints ?? 0), 0);
  const totalPtsChecklist = allItems.reduce((s, i) => s + (i.storyPoints ?? 0), 0);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
          <h3 className="text-sm font-semibold text-slate-900">{isExisting ? "Edit card" : "New card"}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          <form onSubmit={submit} id="card-form" className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Title *</label>
              <input
                autoFocus type="text" value={title} onChange={e => setTitle(e.target.value)}
                placeholder="Card title" required
                className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Description</label>
              <textarea
                value={description} onChange={e => setDescription(e.target.value)}
                placeholder="Optional description…" rows={2}
                className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Due date</label>
                <input
                  type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
                  className={cn(
                    "w-full text-sm rounded-lg border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500",
                    isOverdue ? "border-red-300 text-red-600 bg-red-50" : "border-slate-200 text-slate-900"
                  )}
                />
                {isOverdue && <p className="text-[10px] text-red-500 mt-0.5">Overdue</p>}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Owner (overall responsible)</label>
                <select value={assigneeId ?? ""} onChange={e => setAssigneeId(e.target.value || null)}
                  className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="">Unassigned</option>
                  {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-2">Card story points (Fibonacci)</label>
              <div className="flex gap-1.5 flex-wrap">
                {FIBONACCI.map(n => (
                  <button key={n} type="button" onClick={() => setPts(pts === n ? null : n)}
                    className={cn(
                      "w-8 h-8 rounded-full text-xs font-bold transition-colors",
                      pts === n ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-indigo-100 hover:text-indigo-700"
                    )}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </form>

          {/* ── Checklist ── */}
          <div className="px-5 pb-5 space-y-3 border-t border-slate-100 pt-4">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Task checklist</h4>
              {totalCount > 0 && (
                <span className="text-xs text-slate-500">
                  {isExisting ? `${doneCount}/${totalCount} done` : `${totalCount} task${totalCount !== 1 ? "s" : ""} queued`}
                  {totalPtsChecklist > 0 && isExisting && ` · ${donePts}/${totalPtsChecklist} pts`}
                  {totalPtsChecklist > 0 && !isExisting && ` · ${totalPtsChecklist} pts`}
                </span>
              )}
            </div>

            {/* Progress bar (existing cards only) */}
            {isExisting && totalCount > 0 && (
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500 rounded-full transition-all"
                  style={{ width: `${Math.round((doneCount / totalCount) * 100)}%` }} />
              </div>
            )}

            {/* Item list */}
            <div className="space-y-1.5">
              {allItems.map(item => {
                const isPending = !isExisting;
                return (
                  <div key={item.id} className="flex items-start gap-2 group">
                    {/* Checkbox — only functional for saved items */}
                    <button
                      type="button"
                      onClick={() => !isPending && toggleItem(item)}
                      className={cn(
                        "mt-0.5 w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors",
                        isPending ? "border-slate-200 cursor-default"
                          : item.completed ? "bg-indigo-500 border-indigo-500"
                          : "border-slate-300 hover:border-indigo-400"
                      )}
                    >
                      {item.completed && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 10 10"><path d="M1.5 5l2.5 2.5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className={cn("text-sm", item.completed ? "line-through text-slate-400" : "text-slate-700")}>
                        {item.title}
                      </p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {item.storyPoints != null && (
                          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 text-[9px] font-bold">
                            {item.storyPoints}
                          </span>
                        )}
                        {isExisting ? (
                          <select
                            value={item.assigneeId ?? ""}
                            onChange={e => updateItemAssignee(item, e.target.value || null)}
                            className="text-[10px] text-slate-500 border-0 bg-transparent focus:outline-none cursor-pointer hover:text-slate-700 max-w-[120px]"
                          >
                            <option value="">No assignee</option>
                            {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                          </select>
                        ) : (
                          item.assignee && (
                            <span className="text-[10px] text-slate-500">{item.assignee.name}</span>
                          )
                        )}
                        {item.assignee && (
                          <span
                            className="w-4 h-4 rounded-full text-[9px] font-bold text-white flex items-center justify-center shrink-0"
                            style={{ background: item.assignee.color }}
                            title={item.assignee.name}
                          >
                            {initials(item.assignee.name)}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => isPending ? removePending(item.id) : deleteItem(item.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded text-slate-300 hover:text-red-500 transition-all shrink-0"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Add new task row */}
            <form onSubmit={addPendingOrSavedItem} className="space-y-2 pt-1">
              <input
                type="text" value={newItemTitle} onChange={e => setNewItemTitle(e.target.value)}
                placeholder="Add a task…"
                className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              {newItemTitle.trim() && (
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <select
                      value={newItemAssignee ?? ""}
                      onChange={e => setNewItemAssignee(e.target.value || null)}
                      className="w-full text-xs rounded-md border border-slate-200 px-2 py-1.5 text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    >
                      <option value="">Assignee</option>
                      {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </div>
                  <div className="flex gap-1">
                    {FIBONACCI.map(n => (
                      <button key={n} type="button" onClick={() => setNewItemPts(newItemPts === n ? null : n)}
                        className={cn(
                          "w-6 h-6 rounded-full text-[10px] font-bold transition-colors",
                          newItemPts === n ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-indigo-100"
                        )}>
                        {n}
                      </button>
                    ))}
                  </div>
                  <button
                    type="submit" disabled={addingItem}
                    className="px-3 py-1.5 rounded-md text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors shrink-0"
                  >
                    Add
                  </button>
                </div>
              )}
            </form>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 py-4 border-t border-slate-100 shrink-0">
          {onDelete && (
            <button type="button" onClick={handleDelete} disabled={saving}
              className="p-2.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="Delete card">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button type="button" onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">
            Cancel
          </button>
          <button type="submit" form="card-form" disabled={saving || !title.trim()}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            {saving ? "Saving…" : isExisting ? "Save" : pendingItems.length > 0 ? `Add card + ${pendingItems.length} task${pendingItems.length !== 1 ? "s" : ""}` : "Add card"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sprint Modal (create / edit) ──────────────────────────────────────────────

function SprintModal({ sprint, onSave, onClose }: {
  sprint?: Partial<Sprint>;
  onSave:  (data: { name: string; goal: string; startDate: string; endDate: string }) => Promise<void>;
  onClose: () => void;
}) {
  const [name,      setName]      = useState(sprint?.name ?? "");
  const [goal,      setGoal]      = useState(sprint?.goal ?? "");
  const [startDate, setStartDate] = useState(sprint?.startDate ? sprint.startDate.slice(0, 10) : "");
  const [endDate,   setEndDate]   = useState(sprint?.endDate   ? sprint.endDate.slice(0, 10)   : "");
  const [saving,    setSaving]    = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    await onSave({ name, goal, startDate, endDate });
    setSaving(false);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-900">{sprint?.id ? "Edit sprint" : "Start new sprint"}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Sprint name *</label>
            <input autoFocus type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Sprint 1 — Q4" required
              className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Sprint goal</label>
            <input type="text" value={goal} onChange={e => setGoal(e.target.value)} placeholder="What does this sprint achieve?"
              className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Start date</label>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">End date</label>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving || !name.trim()}
              className="flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
              {saving ? "Saving…" : sprint?.id ? "Save" : "Start sprint"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Complete Sprint Modal ─────────────────────────────────────────────────────

function CompleteSprintModal({ sprint, onComplete, onClose }: {
  sprint:     Sprint;
  onComplete: (incompleteAction: "backlog" | "next") => Promise<void>;
  onClose:    () => void;
}) {
  const incomplete = sprint.cards.filter(c => c.status !== "completed");
  const completed  = sprint.cards.filter(c => c.status === "completed");
  const [action, setAction]   = useState<"backlog" | "next">("backlog");
  const [saving, setSaving]   = useState(false);

  async function submit() {
    setSaving(true);
    await onComplete(action);
    setSaving(false);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-900">Complete sprint</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-emerald-50 rounded-xl p-3 text-center">
              <p className="text-2xl font-bold text-emerald-600">{completed.length}</p>
              <p className="text-xs text-emerald-600 mt-0.5">Completed</p>
              <p className="text-xs text-emerald-500">{totalPts(completed)} pts</p>
            </div>
            <div className="bg-amber-50 rounded-xl p-3 text-center">
              <p className="text-2xl font-bold text-amber-600">{incomplete.length}</p>
              <p className="text-xs text-amber-600 mt-0.5">Incomplete</p>
              <p className="text-xs text-amber-500">{totalPts(incomplete)} pts</p>
            </div>
          </div>

          {/* Handle incomplete */}
          {incomplete.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-700">Move {incomplete.length} incomplete card{incomplete.length !== 1 ? "s" : ""} to:</p>
              <div className="space-y-2">
                {(["backlog", "next"] as const).map(opt => (
                  <label key={opt} className={cn(
                    "flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors",
                    action === opt ? "border-indigo-400 bg-indigo-50" : "border-slate-200 hover:border-indigo-200"
                  )}>
                    <input type="radio" className="mt-0.5" checked={action === opt} onChange={() => setAction(opt)} />
                    <div>
                      <p className="text-sm font-medium text-slate-800">
                        {opt === "backlog" ? "Marketing Backlog" : "Next Sprint"}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {opt === "backlog"
                          ? "Cards return to the backlog for re-prioritization"
                          : "Cards carry forward into the next sprint automatically"}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">
              Cancel
            </button>
            <button onClick={submit} disabled={saving}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors">
              <CheckCircle2 className="w-4 h-4" />
              {saving ? "Completing…" : "Complete sprint"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Velocity Analytics ───────────────────────────────────────────────────────

function VelocityAnalytics({ sprints }: { sprints: Sprint[] }) {
  const completed = [...sprints].sort(
    (a, b) => new Date(a.completedAt ?? a.createdAt).getTime() - new Date(b.completedAt ?? b.createdAt).getTime()
  );

  if (completed.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 rounded-2xl border-2 border-dashed border-slate-200 text-slate-400 space-y-2">
        <BarChart2 className="w-10 h-10" />
        <p className="text-sm font-medium text-slate-600">No data yet</p>
        <p className="text-xs text-slate-400">Complete at least one sprint to see velocity analytics</p>
      </div>
    );
  }

  const sprintData = completed.map(s => {
    const done      = s.cards.filter(c => c.status === "completed");
    const notDone   = s.cards.filter(c => c.status !== "completed");
    const velocity  = totalPts(done);
    const planned   = totalPts(s.cards);
    const rate      = s.cards.length > 0 ? Math.round((done.length / s.cards.length) * 100) : 0;
    return { sprint: s, velocity, planned, rate, doneCount: done.length, notDoneCount: notDone.length };
  });

  const maxVelocity = Math.max(...sprintData.map(d => d.planned), 1);
  const avgVelocity = Math.round(sprintData.reduce((s, d) => s + d.velocity, 0) / sprintData.length);
  const avgRate     = Math.round(sprintData.reduce((s, d) => s + d.rate, 0) / sprintData.length);

  // Trend: compare last 2 sprints
  const trend = sprintData.length >= 2
    ? sprintData[sprintData.length - 1].velocity - sprintData[sprintData.length - 2].velocity
    : 0;
  const TrendIcon = trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus;
  const trendColor = trend > 0 ? "text-emerald-600" : trend < 0 ? "text-red-500" : "text-slate-400";

  // Per-member contribution across all sprints
  const memberMap: Record<string, { member: Member; pts: number; cards: number }> = {};
  completed.forEach(s => {
    s.cards.filter(c => c.status === "completed" && c.assignee).forEach(c => {
      const m = c.assignee!;
      if (!memberMap[m.id]) memberMap[m.id] = { member: m, pts: 0, cards: 0 };
      memberMap[m.id].pts   += c.storyPoints ?? 0;
      memberMap[m.id].cards += 1;
    });
  });
  const memberContribs = Object.values(memberMap).sort((a, b) => b.pts - a.pts);
  const maxMemberPts   = Math.max(...memberContribs.map(m => m.pts), 1);

  const BAR_H = 160;

  return (
    <div className="space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Avg Velocity</p>
          <p className="text-2xl font-bold text-indigo-600">{avgVelocity} <span className="text-sm font-normal text-slate-400">pts/sprint</span></p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Avg Completion</p>
          <p className="text-2xl font-bold text-emerald-600">{avgRate}%</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Total Delivered</p>
          <p className="text-2xl font-bold text-slate-700">
            {sprintData.reduce((s, d) => s + d.velocity, 0)} <span className="text-sm font-normal text-slate-400">pts</span>
          </p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Trend</p>
          <div className="flex items-center gap-2">
            <TrendIcon className={cn("w-6 h-6", trendColor)} />
            <p className={cn("text-2xl font-bold", trendColor)}>
              {trend > 0 ? "+" : ""}{trend !== 0 ? `${trend} pts` : "Flat"}
            </p>
          </div>
          {sprintData.length >= 2 && (
            <p className="text-[10px] text-slate-400 mt-0.5">vs previous sprint</p>
          )}
        </div>
      </div>

      {/* Velocity bar chart */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-800 mb-4">Velocity per Sprint</h3>
        <div className="flex items-end gap-3" style={{ height: BAR_H + 40 }}>
          {sprintData.map((d, i) => {
            const completedH = maxVelocity > 0 ? Math.round((d.velocity / maxVelocity) * BAR_H) : 0;
            const plannedH   = maxVelocity > 0 ? Math.round((d.planned  / maxVelocity) * BAR_H) : 0;
            const isLast     = i === sprintData.length - 1;
            return (
              <div key={d.sprint.id} className="flex-1 flex flex-col items-center gap-1 min-w-0 group">
                <div className="relative w-full flex flex-col items-center justify-end" style={{ height: BAR_H }}>
                  {/* Planned (ghost) */}
                  <div
                    className="absolute bottom-0 w-full rounded-t-md bg-slate-100 transition-all"
                    style={{ height: plannedH }}
                  />
                  {/* Completed (solid) */}
                  <div
                    className={cn(
                      "relative w-full rounded-t-md transition-all",
                      isLast ? "bg-indigo-500" : "bg-indigo-300"
                    )}
                    style={{ height: completedH }}
                  >
                    {/* Tooltip on hover */}
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10 pointer-events-none">
                      <div className="bg-slate-900 text-white text-xs rounded-lg px-2.5 py-1.5 whitespace-nowrap shadow-lg">
                        <p className="font-semibold">{d.sprint.name}</p>
                        <p>Completed: {d.velocity} pts ({d.doneCount} cards)</p>
                        <p>Planned: {d.planned} pts</p>
                        <p>Rate: {d.rate}%</p>
                      </div>
                    </div>
                  </div>
                </div>
                <p className="text-[10px] text-slate-500 truncate w-full text-center leading-tight">
                  {d.sprint.name.replace(/sprint\s*/i, "S").slice(0, 10)}
                </p>
                <p className="text-[10px] font-bold text-indigo-600">{d.velocity}</p>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 mt-3">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-indigo-300" />
            <span className="text-xs text-slate-500">Completed pts</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-slate-200" />
            <span className="text-xs text-slate-500">Planned pts</span>
          </div>
        </div>
      </div>

      {/* Completion rate trend line */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-800 mb-4">Completion Rate Trend</h3>
        {(() => {
          const W = 600, H = 100, PAD = 20;
          const pts = sprintData.map((d, i) => ({
            x: sprintData.length === 1 ? W / 2 : PAD + (i / (sprintData.length - 1)) * (W - PAD * 2),
            y: H - PAD - ((d.rate / 100) * (H - PAD * 2)),
            rate: d.rate,
            name: d.sprint.name,
          }));
          const pathD = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
          const areaD = pts.length > 0
            ? `${pathD} L ${pts[pts.length - 1].x} ${H - PAD} L ${pts[0].x} ${H - PAD} Z`
            : "";
          return (
            <div className="relative w-full overflow-hidden" style={{ height: H + 30 }}>
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
                {/* Grid lines */}
                {[0, 25, 50, 75, 100].map(pct => {
                  const y = H - PAD - ((pct / 100) * (H - PAD * 2));
                  return (
                    <g key={pct}>
                      <line x1={PAD} y1={y} x2={W - PAD} y2={y} stroke="#f1f5f9" strokeWidth="1" />
                      <text x={0} y={y + 4} fontSize="9" fill="#94a3b8">{pct}%</text>
                    </g>
                  );
                })}
                {/* Area fill */}
                <path d={areaD} fill="#6366f1" fillOpacity="0.08" />
                {/* Line */}
                <path d={pathD} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                {/* Points */}
                {pts.map((p, i) => (
                  <g key={i} className="group">
                    <circle cx={p.x} cy={p.y} r="5" fill="#6366f1" stroke="white" strokeWidth="2" />
                    <title>{p.name}: {p.rate}%</title>
                  </g>
                ))}
              </svg>
              {/* X labels */}
              <div className="flex justify-between px-5 mt-1">
                {sprintData.map(d => (
                  <p key={d.sprint.id} className="text-[10px] text-slate-400 truncate flex-1 text-center">
                    {d.sprint.name.replace(/sprint\s*/i, "S").slice(0, 8)}
                  </p>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Team member contribution */}
      {memberContribs.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-800 mb-4">Team Velocity Contribution</h3>
          <div className="space-y-3">
            {memberContribs.map(({ member, pts, cards }) => {
              const pct = Math.round((pts / maxMemberPts) * 100);
              return (
                <div key={member.id} className="flex items-center gap-3">
                  <Avatar member={member} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs font-medium text-slate-700">{member.name}</p>
                      <p className="text-xs text-slate-500">{pts} pts · {cards} cards</p>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, background: member.color }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Sprint breakdown table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-800">Sprint Breakdown</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left">
                <th className="px-5 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Sprint</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide text-right">Planned</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide text-right">Completed</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide text-right">Rate</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide text-right">Cards</th>
                <th className="px-5 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Completed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[...sprintData].reverse().map(d => (
                <tr key={d.sprint.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3">
                    <p className="font-medium text-slate-800">{d.sprint.name}</p>
                    {d.sprint.goal && <p className="text-xs text-slate-400 truncate max-w-[200px]">{d.sprint.goal}</p>}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-600 tabular-nums">{d.planned} pts</td>
                  <td className="px-4 py-3 text-right font-semibold text-indigo-600 tabular-nums">{d.velocity} pts</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className={cn(
                      "inline-block px-2 py-0.5 rounded-full text-xs font-semibold",
                      d.rate >= 80 ? "bg-emerald-100 text-emerald-700"
                        : d.rate >= 50 ? "bg-amber-100 text-amber-700"
                        : "bg-red-100 text-red-700"
                    )}>{d.rate}%</span>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-600 tabular-nums">{d.doneCount}/{d.sprint.cards.length}</td>
                  <td className="px-5 py-3 text-xs text-slate-400">{fmtDate(d.sprint.completedAt ?? d.sprint.endDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Member Panel ──────────────────────────────────────────────────────────────

function MemberPanel({ members, onAdd, onRemove, onClose }: {
  members: Member[];
  onAdd:    (name: string, email: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onClose:  () => void;
}) {
  const [name, setName]     = useState("");
  const [email, setEmail]   = useState("");
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
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors"><X className="w-4 h-4 text-slate-500" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {members.length === 0 && <p className="text-xs text-slate-400 text-center py-3">No team members yet</p>}
            {members.map(m => (
              <div key={m.id} className="flex items-center gap-3 py-1.5">
                <Avatar member={m} size="md" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{m.name}</p>
                  {m.email && <p className="text-xs text-slate-400 truncate">{m.email}</p>}
                </div>
                <button onClick={() => onRemove(m.id)} className="p-1.5 rounded-md text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
          <form onSubmit={submit} className="space-y-2 pt-2 border-t border-slate-100">
            <p className="text-xs font-medium text-slate-600">Add team member</p>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Name *"
              className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email (optional)"
              className="w-full text-sm rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <button type="submit" disabled={saving || !name.trim()}
              className="w-full px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
              {saving ? "Adding…" : "Add member"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Sprint Card ───────────────────────────────────────────────────────────────

function ChecklistProgress({ checklist }: { checklist: ChecklistItem[] }) {
  if (checklist.length === 0) return null;
  const done = checklist.filter(i => i.completed).length;
  const pct  = Math.round((done / checklist.length) * 100);
  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-400">{done}/{checklist.length} tasks</span>
        <span className="text-[10px] text-slate-400">{pct}%</span>
      </div>
      <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", pct === 100 ? "bg-emerald-500" : "bg-indigo-400")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DueDateBadge({ dueDate, status }: { dueDate: string | null; status: Card["status"] }) {
  if (!dueDate) return null;
  const d       = new Date(dueDate);
  const overdue = d < new Date() && status !== "completed";
  const today   = d.toDateString() === new Date().toDateString();
  return (
    <span className={cn(
      "inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded",
      overdue ? "bg-red-100 text-red-600"
        : today ? "bg-amber-100 text-amber-600"
        : "bg-slate-100 text-slate-500"
    )}>
      <Calendar className="w-2.5 h-2.5" />
      {d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
    </span>
  );
}

function SprintCard({ card, onEdit, onDragStart, onDragEnd }: {
  card:        Card;
  onEdit:      () => void;
  onDragStart: (e: React.DragEvent, card: Card) => void;
  onDragEnd:   (e: React.DragEvent) => void;
}) {
  return (
    <div
      draggable onDragStart={e => onDragStart(e, card)} onDragEnd={onDragEnd}
      onClick={onEdit}
      className="bg-white rounded-xl border border-slate-200 p-3 shadow-sm cursor-pointer hover:shadow-md hover:border-indigo-200 transition-all group select-none"
    >
      <div className="flex items-start gap-2">
        <GripVertical className="w-3.5 h-3.5 text-slate-300 mt-0.5 shrink-0 group-hover:text-slate-400 transition-colors" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800 leading-snug">{card.title}</p>
          {card.description && <p className="text-xs text-slate-500 mt-1 line-clamp-2">{card.description}</p>}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {card.storyPoints != null && <StoryBadge pts={card.storyPoints} />}
            <DueDateBadge dueDate={card.dueDate} status={card.status} />
            {card.assignee && <Avatar member={card.assignee} />}
          </div>
          <ChecklistProgress checklist={card.checklist ?? []} />
        </div>
      </div>
    </div>
  );
}

// ── Sprint History Card ───────────────────────────────────────────────────────

function SprintHistoryCard({ sprint }: { sprint: Sprint }) {
  const [expanded, setExpanded] = useState(false);
  const completed  = sprint.cards.filter(c => c.status === "completed");
  const incomplete = sprint.cards.filter(c => c.status !== "completed");
  const velocity   = totalPts(completed);
  const planned    = totalPts(sprint.cards);
  const rate       = sprint.cards.length > 0 ? Math.round((completed.length / sprint.cards.length) * 100) : 0;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            <p className="text-sm font-semibold text-slate-900 truncate">{sprint.name}</p>
          </div>
          {sprint.goal && <p className="text-xs text-slate-500 mt-0.5 ml-6 truncate">{sprint.goal}</p>}
          {(sprint.startDate || sprint.completedAt) && (
            <p className="text-xs text-slate-400 mt-0.5 ml-6">
              {fmtDate(sprint.startDate)} → {fmtDate(sprint.completedAt ?? sprint.endDate)}
            </p>
          )}
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 shrink-0">
          <div className="text-center">
            <p className="text-lg font-bold text-indigo-600">{velocity}</p>
            <p className="text-[10px] text-slate-400 uppercase tracking-wide">Velocity</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-slate-700">{rate}%</p>
            <p className="text-[10px] text-slate-400 uppercase tracking-wide">Done</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-slate-700">{sprint.cards.length}</p>
            <p className="text-[10px] text-slate-400 uppercase tracking-wide">Cards</p>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-slate-100">
        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${rate}%` }} />
      </div>

      {/* Expanded card list */}
      {expanded && (
        <div className="px-5 py-4 space-y-4 border-t border-slate-100 bg-slate-50">
          {completed.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wide mb-2">
                Completed · {totalPts(completed)} pts
              </p>
              <div className="space-y-1.5">
                {completed.map(c => (
                  <div key={c.id} className="flex items-center gap-3 bg-white rounded-lg px-3 py-2 border border-slate-100">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <p className="flex-1 text-sm text-slate-700 truncate">{c.title}</p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {c.storyPoints != null && <StoryBadge pts={c.storyPoints} />}
                      {c.assignee && <Avatar member={c.assignee} />}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {incomplete.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-2">
                Not completed · {totalPts(incomplete)} pts
              </p>
              <div className="space-y-1.5">
                {incomplete.map(c => (
                  <div key={c.id} className="flex items-center gap-3 bg-white rounded-lg px-3 py-2 border border-slate-100 opacity-60">
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-slate-300 shrink-0" />
                    <p className="flex-1 text-sm text-slate-700 truncate">{c.title}</p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {c.storyPoints != null && <StoryBadge pts={c.storyPoints} />}
                      {c.assignee && <Avatar member={c.assignee} />}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {sprint.cards.length === 0 && (
            <p className="text-xs text-slate-400 text-center py-2">No cards in this sprint</p>
          )}

          {/* Velocity bar breakdown */}
          {planned > 0 && (
            <div className="pt-1">
              <div className="flex justify-between text-xs text-slate-500 mb-1">
                <span>{velocity} of {planned} pts completed</span>
                <span>{rate}%</span>
              </div>
              <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${rate}%` }} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Board ────────────────────────────────────────────────────────────────

export function KanbanBoard() {
  const [view,         setView]         = useState<"backlog" | "sprint" | "history" | "analytics">("backlog");
  const [cards,        setCards]        = useState<Card[]>([]);
  const [members,      setMembers]      = useState<Member[]>([]);
  const [sprints,      setSprints]      = useState<Sprint[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [cardModal,    setCardModal]    = useState<{ card: Partial<Card> & { type: Card["type"]; status: Card["status"] } } | null>(null);
  const [sprintModal,  setSprintModal]  = useState<{ sprint?: Sprint } | null>(null);
  const [completeModal,setCompleteModal]= useState<Sprint | null>(null);
  const [memberPanel,  setMemberPanel]  = useState(false);

  const dragging  = useRef<Card | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // ── Data ──────────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    const [cardsRes, membersRes, sprintsRes] = await Promise.all([
      fetch("/api/kanban/cards").then(r => r.json()),
      fetch("/api/kanban/members").then(r => r.json()),
      fetch("/api/kanban/sprints").then(r => r.json()),
    ]);
    setCards(cardsRes);
    setMembers(membersRes);
    setSprints(sprintsRes);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const activeSprint   = sprints.find(s => s.status === "active");
  const completedSprints = sprints.filter(s => s.status === "completed").sort(
    (a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime()
  );

  // ── Card CRUD ─────────────────────────────────────────────────────────────

  async function handleSaveCard(data: Partial<Card>, pendingItems: PendingItem[] = []) {
    const id = cardModal?.card.id;
    if (id) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { checklist: _cl, ...rest } = data as Card;
      const res = await fetch(`/api/kanban/cards/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rest),
      });
      const updated = await res.json();
      setCards(prev => prev.map(c => c.id === id ? updated : c));
    } else {
      const payload = {
        ...cardModal?.card, ...data,
        sprintId:  cardModal?.card.type === "sprint" ? activeSprint?.id ?? null : null,
        checklist: undefined,
      };
      const res = await fetch("/api/kanban/cards", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const created = await res.json();
      // Create any pending checklist items now that we have the card id
      if (pendingItems.length > 0) {
        const items = await Promise.all(pendingItems.map(item =>
          fetch(`/api/kanban/cards/${created.id}/checklist`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: item.title, storyPoints: item.storyPoints, assigneeId: item.assigneeId }),
          }).then(r => r.json())
        ));
        created.checklist = items;
      }
      setCards(prev => [...prev, created]);
    }
  }

  async function handleDeleteCard() {
    const id = cardModal?.card.id;
    if (!id) return;
    await fetch(`/api/kanban/cards/${id}`, { method: "DELETE" });
    setCards(prev => prev.filter(c => c.id !== id));
  }

  async function moveToSprint(card: Card) {
    const res = await fetch(`/api/kanban/cards/${card.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "sprint", status: "not_started", sprintId: activeSprint?.id ?? null }),
    });
    const updated = await res.json();
    setCards(prev => prev.map(c => c.id === card.id ? updated : c));
  }

  // ── Sprint CRUD ───────────────────────────────────────────────────────────

  async function handleCreateSprint(data: { name: string; goal: string; startDate: string; endDate: string }) {
    const res = await fetch("/api/kanban/sprints", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const sprint = await res.json();
    setSprints(prev => [sprint, ...prev]);
    setView("sprint");
  }

  async function handleCompleteSprint(incompleteAction: "backlog" | "next") {
    if (!activeSprint) return;

    // Move incomplete cards
    const incomplete = cards.filter(c => c.sprintId === activeSprint.id && c.status !== "completed");
    if (incompleteAction === "backlog") {
      await Promise.all(incomplete.map(c =>
        fetch(`/api/kanban/cards/${c.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "backlog", status: "backlog", sprintId: null }),
        })
      ));
    }
    // (if "next", they stay in sprint type but sprintId will be updated when next sprint starts)

    // Complete the sprint
    const res = await fetch(`/api/kanban/sprints/${activeSprint.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    const completed = await res.json();

    await loadData(); // Reload everything for consistency
    setSprints(prev => prev.map(s => s.id === activeSprint.id ? completed : s));
    setView("history");
  }

  // ── Member CRUD ───────────────────────────────────────────────────────────

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

  // ── Drag & Drop ───────────────────────────────────────────────────────────

  function onDragStart(e: React.DragEvent, card: Card) {
    dragging.current = card;
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragEnd() { dragging.current = null; setDragOver(null); }
  function onDragOver(e: React.DragEvent, colKey: string) {
    e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(colKey);
  }
  async function onDrop(e: React.DragEvent, colKey: Card["status"]) {
    e.preventDefault(); setDragOver(null);
    const card = dragging.current;
    if (!card || card.status === colKey) return;
    const res = await fetch(`/api/kanban/cards/${card.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: colKey, type: "sprint" }),
    });
    const updated = await res.json();
    setCards(prev => prev.map(c => c.id === card.id ? updated : c));
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const backlogCards = cards.filter(c => c.type === "backlog");
  const sprintColCards = (status: Card["status"]) =>
    cards.filter(c => c.type === "sprint" && c.status === status && (!activeSprint || c.sprintId === activeSprint.id || c.sprintId === null))
      .sort((a, b) => a.position - b.position);

  // ── Render ────────────────────────────────────────────────────────────────

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
          <h1 className="text-2xl font-bold text-slate-900">Project Management</h1>
          <p className="text-sm text-slate-500 mt-1">Marketing backlog, sprints, and team velocity</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMemberPanel(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <Users className="w-3.5 h-3.5" />
            Team
            {members.length > 0 && (
              <span className="flex items-center gap-0.5 ml-0.5">
                {members.slice(0, 5).map(m => <Avatar key={m.id} member={m} />)}
                {members.length > 5 && <span className="text-slate-400 text-[10px]">+{members.length - 5}</span>}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* View toggle */}
      <div className="flex gap-1 p-1 bg-slate-100 rounded-xl w-fit">
        {[
          { key: "backlog",  label: "Backlog",      icon: LayoutList,  count: backlogCards.length },
          { key: "sprint",   label: "Sprint Board",  icon: Columns3,    count: cards.filter(c => c.type === "sprint").length },
          { key: "history",   label: "History",      icon: History,    count: completedSprints.length },
        { key: "analytics", label: "Analytics",    icon: BarChart2,  count: null },
        ].map(({ key, label, icon: Icon, count }) => (
          <button key={key} onClick={() => setView(key as typeof view)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              view === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            )}>
            <Icon className="w-4 h-4" />
            {label}
            {count != null && count > 0 && <span className="ml-0.5 text-xs text-slate-500">{count}</span>}
          </button>
        ))}
      </div>

      {/* ── Backlog ──────────────────────────────────────────────────────── */}
      {view === "backlog" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-slate-800">Marketing Backlog</h2>
              {backlogCards.length > 0 && (
                <span className="text-xs text-slate-500">{backlogCards.length} items · {totalPts(backlogCards)} pts</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!activeSprint && (
                <button onClick={() => setSprintModal({})}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors">
                  <Flag className="w-3.5 h-3.5" />
                  Start sprint
                </button>
              )}
              <button onClick={() => setCardModal({ card: { type: "backlog", status: "backlog" } })}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
                <Plus className="w-3.5 h-3.5" />
                Add item
              </button>
            </div>
          </div>

          {activeSprint && (
            <div className="flex items-center gap-2 px-4 py-2.5 bg-indigo-50 border border-indigo-200 rounded-xl">
              <Flag className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-xs font-semibold text-indigo-700">{activeSprint.name}</span>
                {activeSprint.goal && <span className="text-xs text-indigo-500 ml-2">· {activeSprint.goal}</span>}
                {activeSprint.endDate && (
                  <span className="text-xs text-indigo-400 ml-2">ends {fmtDate(activeSprint.endDate)}</span>
                )}
              </div>
              <button onClick={() => setView("sprint")}
                className="text-xs font-medium text-indigo-600 hover:text-indigo-800 shrink-0">
                View board →
              </button>
            </div>
          )}

          {backlogCards.length === 0 ? (
            <div onClick={() => setCardModal({ card: { type: "backlog", status: "backlog" } })}
              className="flex flex-col items-center justify-center py-16 rounded-2xl border-2 border-dashed border-slate-200 text-slate-400 cursor-pointer hover:border-indigo-300 hover:text-indigo-400 transition-colors">
              <Plus className="w-8 h-8 mb-2" />
              <p className="text-sm font-medium">Add your first backlog item</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
              {backlogCards.sort((a, b) => a.position - b.position).map(card => (
                <div key={card.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 group transition-colors">
                  <GripVertical className="w-4 h-4 text-slate-300 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{card.title}</p>
                    {card.description && <p className="text-xs text-slate-500 truncate">{card.description}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {card.storyPoints != null && <StoryBadge pts={card.storyPoints} />}
                    {card.assignee && <Avatar member={card.assignee} />}
                    {activeSprint && (
                      <button onClick={() => moveToSprint(card)} title="Move to active sprint"
                        className="opacity-0 group-hover:opacity-100 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-all">
                        Sprint <ArrowRight className="w-3 h-3" />
                      </button>
                    )}
                    <button onClick={() => setCardModal({ card })}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-all">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Sprint Board ─────────────────────────────────────────────────── */}
      {view === "sprint" && (
        <div className="space-y-4">
          {!activeSprint ? (
            <div className="flex flex-col items-center justify-center py-20 rounded-2xl border-2 border-dashed border-slate-200 text-slate-400 space-y-3">
              <Flag className="w-10 h-10" />
              <div className="text-center">
                <p className="text-sm font-medium text-slate-600">No active sprint</p>
                <p className="text-xs text-slate-400 mt-1">Start a sprint to begin moving cards from the backlog</p>
              </div>
              <button onClick={() => setSprintModal({})}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
                <Flag className="w-4 h-4" />
                Start sprint
              </button>
            </div>
          ) : (
            <>
              {/* Sprint header */}
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Flag className="w-4 h-4 text-indigo-500" />
                    <h2 className="text-base font-semibold text-slate-800">{activeSprint.name}</h2>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">Active</span>
                  </div>
                  {activeSprint.goal && <p className="text-xs text-slate-500 mt-0.5 ml-6">{activeSprint.goal}</p>}
                  {(activeSprint.startDate || activeSprint.endDate) && (
                    <p className="text-xs text-slate-400 mt-0.5 ml-6 flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {fmtDate(activeSprint.startDate)} → {fmtDate(activeSprint.endDate)}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <p className="text-xs text-slate-500">
                      {cards.filter(c => c.sprintId === activeSprint.id && c.status === "completed").length} / {cards.filter(c => c.sprintId === activeSprint.id).length} cards
                      · {totalPts(cards.filter(c => c.sprintId === activeSprint.id && c.status === "completed"))} pts done
                    </p>
                  </div>
                  <button onClick={() => setCardModal({ card: { type: "sprint", status: "not_started" } })}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors">
                    <Plus className="w-3.5 h-3.5" />
                    Add card
                  </button>
                  <button onClick={() => setCompleteModal(activeSprint)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Complete sprint
                  </button>
                </div>
              </div>

              {/* Columns */}
              <div className="grid grid-cols-4 gap-4">
                {SPRINT_COLS.map(col => {
                  const colCards = sprintColCards(col.key);
                  const isDragTarget = dragOver === col.key;
                  return (
                    <div key={col.key}
                      onDragOver={e => onDragOver(e, col.key)}
                      onDrop={e => onDrop(e, col.key)}
                      className={cn(
                        "rounded-2xl transition-colors min-h-[400px] flex flex-col",
                        isDragTarget ? "bg-indigo-50 ring-2 ring-indigo-300" : "bg-slate-50"
                      )}>
                      <div className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className={cn("w-2 h-2 rounded-full", col.dot)} />
                          <span className={cn("text-xs font-semibold uppercase tracking-wide", col.color)}>{col.label}</span>
                          <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded-full", col.bg, col.color)}>
                            {colCards.length}
                          </span>
                        </div>
                        <button onClick={() => setCardModal({ card: { type: "sprint", status: col.key } })}
                          className="p-1 rounded-md text-slate-400 hover:text-indigo-600 hover:bg-white transition-colors">
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {colCards.some(c => c.storyPoints != null) && (
                        <div className="px-4 pb-1">
                          <span className="text-[10px] text-slate-400">{totalPts(colCards)} pts</span>
                        </div>
                      )}
                      <div className="flex-1 px-3 pb-3 space-y-2">
                        {colCards.map(card => (
                          <SprintCard key={card.id} card={card}
                            onEdit={() => setCardModal({ card })}
                            onDragStart={onDragStart} onDragEnd={onDragEnd} />
                        ))}
                        {colCards.length === 0 && !isDragTarget && (
                          <div onClick={() => setCardModal({ card: { type: "sprint", status: col.key } })}
                            className="flex items-center justify-center h-20 rounded-xl border-2 border-dashed border-slate-200 text-slate-300 cursor-pointer hover:border-indigo-200 hover:text-indigo-300 transition-colors">
                            <Plus className="w-5 h-5" />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── History ──────────────────────────────────────────────────────── */}
      {view === "history" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-slate-800">Sprint History</h2>
              {completedSprints.length > 0 && (
                <span className="text-xs text-slate-500">
                  {completedSprints.length} sprint{completedSprints.length !== 1 ? "s" : ""} · avg velocity{" "}
                  {Math.round(
                    completedSprints.reduce((s, sp) => s + totalPts(sp.cards.filter(c => c.status === "completed")), 0) /
                    Math.max(completedSprints.length, 1)
                  )} pts
                </span>
              )}
            </div>
          </div>

          {completedSprints.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 rounded-2xl border-2 border-dashed border-slate-200 text-slate-400 space-y-2">
              <History className="w-10 h-10" />
              <p className="text-sm font-medium text-slate-600">No completed sprints yet</p>
              <p className="text-xs text-slate-400">Complete your first sprint to see velocity and history here</p>
            </div>
          ) : (
            <>
              {/* Velocity summary */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
                  <p className="text-2xl font-bold text-indigo-600">
                    {Math.round(
                      completedSprints.reduce((s, sp) => s + totalPts(sp.cards.filter(c => c.status === "completed")), 0) /
                      Math.max(completedSprints.length, 1)
                    )}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Avg velocity (pts/sprint)</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
                  <p className="text-2xl font-bold text-emerald-600">
                    {Math.round(
                      completedSprints.reduce((s, sp) => {
                        const done = sp.cards.filter(c => c.status === "completed").length;
                        return s + (sp.cards.length > 0 ? (done / sp.cards.length) * 100 : 0);
                      }, 0) / Math.max(completedSprints.length, 1)
                    )}%
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Avg completion rate</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
                  <p className="text-2xl font-bold text-slate-700">
                    {completedSprints.reduce((s, sp) => s + sp.cards.filter(c => c.status === "completed").length, 0)}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Total cards delivered</p>
                </div>
              </div>

              {/* Sprint list */}
              <div className="space-y-3">
                {completedSprints.map(sprint => (
                  <SprintHistoryCard key={sprint.id} sprint={sprint} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Analytics ───────────────────────────────────────────────────── */}
      {view === "analytics" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-slate-800">Velocity Analytics</h2>
            {completedSprints.length > 0 && (
              <span className="text-xs text-slate-500">{completedSprints.length} sprint{completedSprints.length !== 1 ? "s" : ""} of data</span>
            )}
          </div>
          <VelocityAnalytics sprints={completedSprints} />
        </div>
      )}

      {/* ── Modals ───────────────────────────────────────────────────────── */}
      {cardModal && (
        <CardModal card={cardModal.card} members={members}
          onSave={handleSaveCard}
          onDelete={cardModal.card.id ? handleDeleteCard : undefined}
          onClose={() => setCardModal(null)} />
      )}
      {sprintModal !== null && (
        <SprintModal sprint={sprintModal.sprint} onSave={handleCreateSprint} onClose={() => setSprintModal(null)} />
      )}
      {completeModal && (
        <CompleteSprintModal sprint={completeModal} onComplete={handleCompleteSprint} onClose={() => setCompleteModal(null)} />
      )}
      {memberPanel && (
        <MemberPanel members={members} onAdd={handleAddMember} onRemove={handleRemoveMember} onClose={() => setMemberPanel(false)} />
      )}
    </div>
  );
}
