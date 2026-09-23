"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send, Loader2, Sparkles, ChevronRight, ChevronLeft,
  Bot, User, Lightbulb, BarChart2, Clock, Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatSession {
  id:        string;
  startedAt: string;
  title:     string;
  messages:  Message[];
}

// ── Suggested starter questions ───────────────────────────────────────────────

const STARTERS = [
  { icon: BarChart2, text: "Give me a full funnel report for the last 12 weeks" },
  { icon: Lightbulb, text: "Where is the biggest drop-off in our funnel right now?" },
  { icon: BarChart2, text: "How is paid media pacing vs. target this quarter?" },
  { icon: Lightbulb, text: "Which channel is generating the best return per dollar spent?" },
  { icon: BarChart2, text: "Are we on pace to hit our MQL and SQO targets?" },
  { icon: Lightbulb, text: "What's our current CAC and GTM efficiency?" },
];

const STORAGE_KEY_CHAT    = "mar-ops-chat-history";
const STORAGE_KEY_SESSIONS = "mar-ops-chat-sessions";
const MAX_SESSIONS = 20;

// ── Markdown renderer (no external dependency) ───────────────────────────────

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={i} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`"))
      return <code key={i} className="bg-slate-100 text-slate-800 px-1 py-0.5 rounded text-xs font-mono">{part.slice(1, -1)}</code>;
    return part;
  });
}

function MarkdownAnswer({ content }: { content: string }) {
  const lines = content.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("### ")) {
      nodes.push(<h3 key={i} className="text-sm font-semibold text-slate-800 mt-3 mb-1.5">{renderInline(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      nodes.push(<h2 key={i} className="text-base font-semibold text-slate-900 mt-4 mb-2">{renderInline(line.slice(3))}</h2>);
    } else if (line.startsWith("# ")) {
      nodes.push(<h1 key={i} className="text-lg font-bold text-slate-900 mt-4 mb-2">{renderInline(line.slice(2))}</h1>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("* "))) {
        items.push(lines[i].slice(2));
        i++;
      }
      nodes.push(
        <ul key={`ul-${i}`} className="list-disc list-inside space-y-1 mb-3">
          {items.map((item, j) => <li key={j} className="text-slate-700">{renderInline(item)}</li>)}
        </ul>
      );
      continue;
    } else if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ""));
        i++;
      }
      nodes.push(
        <ol key={`ol-${i}`} className="list-decimal list-inside space-y-1 mb-3">
          {items.map((item, j) => <li key={j} className="text-slate-700">{renderInline(item)}</li>)}
        </ol>
      );
      continue;
    } else if (line.startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const rows = tableLines.filter(l => !l.match(/^\|[-| ]+\|$/));
      nodes.push(
        <div key={`tbl-${i}`} className="overflow-x-auto mb-3">
          <table className="w-full text-xs border-collapse">
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {row.split("|").filter((_, ci) => ci > 0 && ci < row.split("|").length - 1).map((cell, ci) => (
                    ri === 0
                      ? <th key={ci} className="text-left px-3 py-2 bg-slate-100 border border-slate-200 font-semibold text-slate-700">{renderInline(cell.trim())}</th>
                      : <td key={ci} className="px-3 py-2 border border-slate-200 text-slate-700">{renderInline(cell.trim())}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    } else if (line.trim() === "") {
      // blank lines — spacing handled by mb-3
    } else {
      nodes.push(<p key={i} className="mb-3 last:mb-0">{renderInline(line)}</p>);
    }
    i++;
  }

  return <div className="text-sm leading-relaxed">{nodes}</div>;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MarOpsClient() {
  const [messages,     setMessages]     = useState<Message[]>([]);
  const [sessions,     setSessions]     = useState<ChatSession[]>([]);
  const [input,        setInput]        = useState("");
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [suggestions,  setSuggestions]  = useState<string[]>([]);
  const [showHistory,  setShowHistory]  = useState(false);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load persisted chat + sessions on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_CHAT);
      if (saved) setMessages(JSON.parse(saved));
    } catch { /* ignore */ }
    try {
      const savedSessions = localStorage.getItem(STORAGE_KEY_SESSIONS);
      if (savedSessions) setSessions(JSON.parse(savedSessions));
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist active chat whenever it changes
  useEffect(() => {
    try {
      if (messages.length > 0) localStorage.setItem(STORAGE_KEY_CHAT, JSON.stringify(messages));
    } catch { /* ignore */ }
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  function archiveAndClear() {
    if (messages.length === 0) return;
    const firstUser = messages.find(m => m.role === "user");
    const session: ChatSession = {
      id:        Date.now().toString(),
      startedAt: new Date().toISOString(),
      title:     firstUser ? firstUser.content.slice(0, 80) : "Conversation",
      messages,
    };
    setSessions(prev => {
      const next = [session, ...prev].slice(0, MAX_SESSIONS);
      try { localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setMessages([]);
    setSuggestions([]);
    setError(null);
    try { localStorage.removeItem(STORAGE_KEY_CHAT); } catch { /* ignore */ }
  }

  function restoreSession(session: ChatSession) {
    if (messages.length > 0) archiveAndClear();
    setMessages(session.messages);
    setSuggestions([]);
    setError(null);
    try { localStorage.setItem(STORAGE_KEY_CHAT, JSON.stringify(session.messages)); } catch { /* ignore */ }
    setSessions(prev => {
      const next = prev.filter(s => s.id !== session.id);
      try { localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setShowHistory(false);
  }

  function deleteSession(id: string) {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      try { localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  const sendMessage = useCallback(async (question: string) => {
    if (!question.trim() || loading) return;
    setError(null);
    setSuggestions([]);

    const userMsg: Message = { role: "user", content: question };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/mar-ops/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          question,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
        }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const assistantMsg: Message = { role: "assistant", content: data.answer };
      setMessages([...next, assistantMsg]);
      if (Array.isArray(data.suggestions) && data.suggestions.length > 0) {
        setSuggestions(data.suggestions);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setMessages(next);
    } finally {
      setLoading(false);
    }
  }, [messages, loading]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 bg-indigo-600 border-b border-indigo-700 shrink-0">
        <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center">
          <Sparkles className="w-4 h-4 text-white" />
        </div>
        <div>
          <h1 className="text-sm font-semibold text-white">Mar Ops Agent</h1>
          <p className="text-xs text-indigo-200">Powered by live dashboard data · /mar-ops skill</p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setShowHistory(h => !h)}
            title="Conversation history"
            className={cn(
              "p-1.5 rounded-lg transition-colors",
              showHistory ? "bg-white/30" : "hover:bg-white/20"
            )}
          >
            <Clock className="w-4 h-4 text-white" />
          </button>
          <button
            onClick={archiveAndClear}
            title="Archive & start new conversation"
            disabled={messages.length === 0}
            className="p-1.5 rounded-lg hover:bg-white/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-4 h-4 text-white" />
          </button>
        </div>
      </div>

      {/* History panel */}
      {showHistory && (
        <div className="flex-1 overflow-y-auto bg-slate-50 flex flex-col">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 bg-white shrink-0">
            <button onClick={() => setShowHistory(false)} className="p-1 rounded hover:bg-slate-100 text-slate-500">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <p className="text-sm font-semibold text-slate-800">Conversation History</p>
            <span className="ml-auto text-xs text-slate-400">{sessions.length} saved</span>
          </div>
          {sessions.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-400 text-center px-6 py-12">
              No history yet. Use the trash icon to archive a conversation and save it here.
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
              {sessions.map(s => (
                <div key={s.id} className="px-4 py-3 hover:bg-white transition-colors group">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-800 leading-snug line-clamp-2">{s.title}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        {new Date(s.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                        {" · "}{s.messages.length} message{s.messages.length !== 1 ? "s" : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        onClick={() => restoreSession(s)}
                        className="text-[10px] px-2 py-1 rounded bg-indigo-50 text-indigo-600 hover:bg-indigo-100 font-medium"
                      >
                        Restore
                      </button>
                      <button
                        onClick={() => deleteSession(s.id)}
                        className="text-[10px] px-2 py-1 rounded bg-red-50 text-red-500 hover:bg-red-100 font-medium"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Messages area — hidden while viewing history */}
      {!showHistory && (
        <>
          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
            {/* Empty state */}
            {isEmpty && (
              <div className="max-w-2xl mx-auto space-y-8">
                <div className="text-center pt-8">
                  <div className="w-16 h-16 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center mx-auto mb-4">
                    <Sparkles className="w-7 h-7 text-indigo-500" />
                  </div>
                  <h2 className="text-lg font-semibold text-slate-900 mb-2">Marketing Operations Agent</h2>
                  <p className="text-sm text-slate-500 max-w-md mx-auto">
                    Ask about your funnel, channel efficiency, pacing vs. targets, anomalies, or anything across your live marketing data.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-2.5">
                  {STARTERS.map(({ icon: Icon, text }) => (
                    <button
                      key={text}
                      onClick={() => sendMessage(text)}
                      className="flex items-center gap-3 px-4 py-3.5 bg-white rounded-xl border border-slate-200 text-left hover:border-indigo-300 hover:bg-indigo-50/40 transition-all group text-sm text-slate-700"
                    >
                      <Icon className="w-4 h-4 text-slate-400 group-hover:text-indigo-500 shrink-0 transition-colors" />
                      <span className="flex-1">{text}</span>
                      <ChevronRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-indigo-400 shrink-0 transition-colors" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Conversation */}
            {messages.map((msg, i) => (
              <div
                key={i}
                className={cn("flex gap-3 max-w-3xl", msg.role === "user" ? "ml-auto flex-row-reverse" : "")}
              >
                <div className={cn(
                  "w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-white mt-0.5",
                  msg.role === "user" ? "bg-slate-700" : "bg-indigo-600"
                )}>
                  {msg.role === "user"
                    ? <User className="w-3.5 h-3.5" />
                    : <Bot className="w-3.5 h-3.5" />
                  }
                </div>

                <div className={cn(
                  "rounded-xl px-4 py-3 text-sm leading-relaxed max-w-none",
                  msg.role === "user"
                    ? "bg-slate-800 text-white max-w-lg"
                    : "bg-white border border-slate-200 text-slate-700 shadow-sm flex-1"
                )}>
                  {msg.role === "assistant"
                    ? <MarkdownAnswer content={msg.content} />
                    : msg.content
                  }
                </div>
              </div>
            ))}

            {/* Loading */}
            {loading && (
              <div className="flex gap-3 max-w-3xl">
                <div className="w-7 h-7 rounded-full bg-indigo-600 shrink-0 flex items-center justify-center text-white mt-0.5">
                  <Bot className="w-3.5 h-3.5" />
                </div>
                <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />
                  Analysing live data…
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="max-w-3xl bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {/* Follow-up suggestions */}
            {suggestions.length > 0 && !loading && (
              <div className="max-w-3xl space-y-2 pl-10">
                <p className="text-xs text-slate-400 font-medium">Suggested follow-ups</p>
                <div className="flex flex-col gap-1.5">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => sendMessage(s)}
                      className="text-left text-xs text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 rounded-lg px-3 py-2 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input bar */}
          <div className="shrink-0 px-6 pb-6 pt-2">
            <div className="max-w-3xl mx-auto">
              <div className="flex items-end gap-3 bg-white border border-slate-200 rounded-2xl shadow-sm px-4 py-3 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about your funnel, channels, pacing, anomalies…"
                  rows={1}
                  className="flex-1 resize-none bg-transparent text-sm text-slate-800 placeholder-slate-400 focus:outline-none leading-relaxed"
                />
                <button
                  onClick={() => sendMessage(input)}
                  disabled={!input.trim() || loading}
                  className={cn(
                    "shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-colors",
                    input.trim() && !loading
                      ? "bg-indigo-600 text-white hover:bg-indigo-700"
                      : "bg-slate-100 text-slate-300 cursor-not-allowed"
                  )}
                >
                  {loading
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Send className="w-4 h-4" />
                  }
                </button>
              </div>
              <p className="text-xs text-slate-400 text-center mt-2">
                Pulls live funnel, channel, and pacing data · Read-only · Press Enter to send
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
