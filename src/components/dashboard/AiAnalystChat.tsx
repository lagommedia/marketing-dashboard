"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2, Sparkles, RefreshCw } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ClassifyResult {
  classified?: number;
  total?: number;
  message?: string;
  error?: string;
}

const SUGGESTED = [
  "What's our Pipeline-to-Revenue ratio this quarter?",
  "What is our current CAC and LTV:CAC ratio?",
  "How is our funnel converting from MQL to close?",
  "What % of our pipeline companies are AI companies?",
  "What's our GTM efficiency this quarter?",
  "Break down our pipeline by segment",
];

export default function AiAnalystChat() {
  const [messages, setMessages]         = useState<Message[]>([]);
  const [input, setInput]               = useState("");
  const [loading, setLoading]           = useState(false);
  const [classifying, setClassifying]   = useState(false);
  const [classifyResult, setClassifyResult] = useState<ClassifyResult | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const bottomRef                       = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function handleSend(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;

    const next: Message[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const res  = await fetch("/api/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Request failed");
      setMessages([...next, { role: "assistant", content: data.message }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      // Remove the optimistic user message on failure
      setMessages(messages);
    } finally {
      setLoading(false);
    }
  }

  async function handleClassify() {
    setClassifying(true);
    setClassifyResult(null);
    try {
      const res  = await fetch("/api/companies/classify", { method: "POST" });
      const data = await res.json();
      setClassifyResult(data);
    } catch {
      setClassifyResult({ error: "Classification request failed" });
    } finally {
      setClassifying(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Classify action */}
      <div className="flex items-center gap-3 p-4 bg-white rounded-xl border border-gray-200">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900">Classify companies</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Run Claude classification on all unclassified HubSpot companies. Requires a HubSpot sync first.
          </p>
          {classifyResult && (
            <p className={`text-xs mt-1 font-medium ${classifyResult.error ? "text-red-500" : "text-emerald-600"}`}>
              {classifyResult.error ?? classifyResult.message}
            </p>
          )}
        </div>
        <button
          onClick={handleClassify}
          disabled={classifying}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 transition-colors shrink-0"
        >
          {classifying ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          {classifying ? "Classifying…" : "Run Classification"}
        </button>
      </div>

      {/* Chat card */}
      <div className="flex flex-col bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Message list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-[320px] max-h-[480px]">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center gap-5 py-8">
              <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-indigo-600" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-900">Ask about your marketing data</p>
                <p className="text-xs text-gray-500 mt-1">
                  Spend, pipeline, CAC, LTV, funnel, organic search, and AI company breakdown — all in one place.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center">
                {SUGGESTED.map((q) => (
                  <button
                    key={q}
                    onClick={() => handleSend(q)}
                    className="text-xs px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-700 hover:bg-indigo-50 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
                    m.role === "user"
                      ? "bg-indigo-600 text-white rounded-br-sm"
                      : "bg-gray-100 text-gray-900 rounded-bl-sm"
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))
          )}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-2.5">
                <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-500 text-center">{error}</p>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="border-t border-gray-100 p-3 flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder="Ask about spend, pipeline, CAC, LTV, funnel, companies…"
            disabled={loading}
            className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50 placeholder:text-gray-400"
          />
          <button
            onClick={() => handleSend()}
            disabled={loading || !input.trim()}
            className="p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
