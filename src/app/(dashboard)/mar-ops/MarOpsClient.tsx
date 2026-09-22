"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send, Loader2, Sparkles, RefreshCw, ChevronRight,
  Bot, User, Lightbulb, BarChart2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  content: string;
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

// ── Markdown renderer ─────────────────────────────────────────────────────────

function MarkdownAnswer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        p:      ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
        ul:     ({ children }) => <ul className="list-disc list-inside space-y-1 mb-3">{children}</ul>,
        ol:     ({ children }) => <ol className="list-decimal list-inside space-y-1 mb-3">{children}</ol>,
        li:     ({ children }) => <li className="text-slate-700">{children}</li>,
        h2:     ({ children }) => <h2 className="text-base font-semibold text-slate-900 mt-4 mb-2">{children}</h2>,
        h3:     ({ children }) => <h3 className="text-sm font-semibold text-slate-800 mt-3 mb-1.5">{children}</h3>,
        code:   ({ children }) => <code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-xs font-mono">{children}</code>,
        pre:    ({ children }) => <pre className="bg-slate-100 rounded-lg p-3 overflow-x-auto text-xs mb-3">{children}</pre>,
        table:  ({ children }) => <div className="overflow-x-auto mb-3"><table className="w-full text-xs border-collapse">{children}</table></div>,
        th:     ({ children }) => <th className="text-left px-3 py-2 bg-slate-100 border border-slate-200 font-semibold text-slate-700">{children}</th>,
        td:     ({ children }) => <td className="px-3 py-2 border border-slate-200 text-slate-700">{children}</td>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MarOpsClient() {
  const [messages,  setMessages]  = useState<Message[]>([]);
  const [input,     setInput]     = useState("");
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const bottomRef  = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      setMessages(next); // keep user message visible
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
      <div className="flex items-center gap-3 px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center">
          <Sparkles className="w-4.5 h-4.5 text-white" />
        </div>
        <div>
          <h1 className="text-sm font-semibold text-slate-900">Mar Ops Agent</h1>
          <p className="text-xs text-slate-500">Powered by live dashboard data · /mar-ops skill</p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => { setMessages([]); setSuggestions([]); setError(null); }}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:bg-slate-100 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            New conversation
          </button>
        )}
      </div>

      {/* Messages area */}
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
            {/* Avatar */}
            <div className={cn(
              "w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-white mt-0.5",
              msg.role === "user" ? "bg-slate-700" : "bg-indigo-600"
            )}>
              {msg.role === "user"
                ? <User className="w-3.5 h-3.5" />
                : <Bot className="w-3.5 h-3.5" />
              }
            </div>

            {/* Bubble */}
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
    </div>
  );
}
