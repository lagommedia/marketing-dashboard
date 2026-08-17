"use client";

import { useState, useRef, useEffect } from "react";
import { Sparkles, SendHorizontal, Loader2, ChevronDown } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiInsightPayload {
  cardLabel:   string;
  metric?:     string;
  format?:     "currency" | "number";
  periods?:    unknown[];
  bySegment?:  unknown[];
  byQuarter?:  unknown[];
  byStage?:    unknown[];
  grandTotal?: number;
  channel?:    string;
}

interface AiTable {
  headers: string[];
  rows:    string[][];
}

interface ForecastBand {
  value: string;
  note:  string;
}

interface AiForecast {
  label:        string;
  conservative: ForecastBand;
  base:         ForecastBand;
  optimistic:   ForecastBand;
}

interface AiAnswer {
  summary:   string;
  table?:    AiTable;
  forecast?: AiForecast;
}

interface Message {
  role:    "user" | "assistant";
  content: AiAnswer | string;  // string = fallback if JSON parse failed
}

// ---------------------------------------------------------------------------
// Rendered answer
// ---------------------------------------------------------------------------

function AnswerCard({ content }: { content: AiAnswer | string }) {
  if (typeof content === "string") {
    return <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">{content}</p>;
  }

  const { summary, table, forecast } = content;

  return (
    <div className="space-y-3">
      {/* Summary */}
      <p className="text-xs text-slate-700 leading-relaxed">{summary}</p>

      {/* Table */}
      {table && table.headers?.length > 0 && table.rows?.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-100">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                {table.headers.map((h, i) => (
                  <th
                    key={i}
                    className={`px-3 py-2 font-semibold text-slate-500 ${i === 0 ? "text-left" : "text-right"}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 0 ? "bg-white" : "bg-slate-50/50"}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={`px-3 py-1.5 text-slate-700 ${ci === 0 ? "text-left font-medium" : "text-right tabular-nums"}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Forecast confidence bands */}
      {forecast && (
        <div>
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">
            {forecast.label} — Confidence Intervals
          </p>
          <div className="grid grid-cols-3 gap-2">
            {/* Conservative — 80% chance of meeting */}
            <div className="rounded-xl border border-amber-100 bg-amber-50 p-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold text-amber-700">Conservative</span>
                <span className="text-[9px] text-amber-500 bg-amber-100 rounded-full px-1.5 py-0.5">80% likely to exceed</span>
              </div>
              <p className="text-base font-bold text-amber-800 tabular-nums">{forecast.conservative.value}</p>
              <p className="text-[10px] text-amber-600 mt-1 leading-tight">{forecast.conservative.note}</p>
            </div>

            {/* Base — 50/50 */}
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold text-indigo-700">Base Case</span>
                <span className="text-[9px] text-indigo-500 bg-indigo-100 rounded-full px-1.5 py-0.5">50 / 50</span>
              </div>
              <p className="text-base font-bold text-indigo-800 tabular-nums">{forecast.base.value}</p>
              <p className="text-[10px] text-indigo-600 mt-1 leading-tight">{forecast.base.note}</p>
            </div>

            {/* Optimistic — 20% chance */}
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold text-emerald-700">Optimistic</span>
                <span className="text-[9px] text-emerald-500 bg-emerald-100 rounded-full px-1.5 py-0.5">20% stretch</span>
              </div>
              <p className="text-base font-bold text-emerald-800 tabular-nums">{forecast.optimistic.value}</p>
              <p className="text-[10px] text-emerald-600 mt-1 leading-tight">{forecast.optimistic.note}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface Props {
  payload: AiInsightPayload;
}

export function AiInsightPanel({ payload }: Props) {
  const [open, setOpen]         = useState(false);
  const [input, setInput]       = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 80);
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function submit() {
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    try {
      const res = await fetch("/api/ai/insight", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ ...payload, question }),
      });
      const data: { answer?: AiAnswer; error?: string } = await res.json();
      if (data.error) throw new Error(data.error);
      setMessages((prev) => [...prev, { role: "assistant", content: data.answer! }]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  const SUGGESTIONS = [
    "What's the trend over the last 4 quarters?",
    "Which channel is performing best?",
    "Project end-of-quarter performance",
    "Any anomalies I should know about?",
  ];

  return (
    <div className="border-t border-slate-100 mt-2">
      {/* Toggle */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-xs font-medium text-slate-500 hover:text-indigo-600 hover:bg-slate-50 transition-colors group"
      >
        <span className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-indigo-400 group-hover:text-indigo-600 transition-colors" />
          Ask AI about this data
        </span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="px-4 pb-4">
          {/* Message history */}
          {messages.length > 0 && (
            <div className="mb-3 space-y-3 max-h-[480px] overflow-y-auto pr-1">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="bg-indigo-50 text-indigo-900 text-xs rounded-xl px-3 py-2.5 ml-8 leading-relaxed">
                    {m.content as string}
                  </div>
                ) : (
                  <div key={i} className="bg-slate-50 rounded-xl px-3 py-3 mr-2">
                    <span className="flex items-center gap-1 text-[10px] font-semibold text-indigo-500 mb-2">
                      <Sparkles className="w-3 h-3" /> AI Insight
                    </span>
                    <AnswerCard content={m.content as AiAnswer} />
                  </div>
                )
              )}

              {loading && (
                <div className="bg-slate-50 rounded-xl px-3 py-2.5 mr-2">
                  <span className="flex items-center gap-1 text-[10px] font-semibold text-indigo-500 mb-1">
                    <Sparkles className="w-3 h-3" /> AI Insight
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-slate-400">
                    <Loader2 className="w-3 h-3 animate-spin" /> Analysing…
                  </span>
                </div>
              )}

              {error && (
                <p className="text-xs text-red-500 bg-red-50 rounded-xl px-3 py-2">{error}</p>
              )}
              <div ref={bottomRef} />
            </div>
          )}

          {/* Suggested prompts — first open only */}
          {messages.length === 0 && !loading && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => { setInput(s); setTimeout(() => inputRef.current?.focus(), 50); }}
                  className="text-[11px] px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask a question about this data…"
              rows={2}
              className="flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 transition"
            />
            <button
              onClick={submit}
              disabled={!input.trim() || loading}
              className="p-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <SendHorizontal className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-[10px] text-slate-400 mt-1.5">Enter to send · Shift+Enter for new line</p>
        </div>
      )}
    </div>
  );
}
