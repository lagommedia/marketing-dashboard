"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2, Sparkles, RefreshCw, Paperclip, X, FileText, Image } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Attachment {
  name:     string;
  mimeType: string;
  data?:    string; // base64 (images, PDFs)
  text?:    string; // decoded text (CSV, TXT, JSON)
  preview?: string; // data URL for image previews
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

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

function fileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return <Image className="w-3.5 h-3.5" />;
  return <FileText className="w-3.5 h-3.5" />;
}

export default function AiAnalystChat() {
  const [messages, setMessages]         = useState<Message[]>([]);
  const [input, setInput]               = useState("");
  const [loading, setLoading]           = useState(false);
  const [classifying, setClassifying]   = useState(false);
  const [classifyResult, setClassifyResult] = useState<ClassifyResult | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const [attachment, setAttachment]     = useState<Attachment | null>(null);
  const [fileError, setFileError]       = useState<string | null>(null);
  const bottomRef                       = useRef<HTMLDivElement>(null);
  const fileInputRef                    = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function handleFileSelect(file: File) {
    setFileError(null);
    if (file.size > MAX_FILE_BYTES) {
      setFileError(`File too large (max 10 MB). "${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB.`);
      return;
    }

    const isImage = file.type.startsWith("image/");
    const isPdf   = file.type === "application/pdf";
    const isText  = ["text/csv", "text/plain", "application/json", "text/tab-separated-values"].includes(file.type)
                    || file.name.endsWith(".csv") || file.name.endsWith(".tsv") || file.name.endsWith(".txt") || file.name.endsWith(".json");

    if (!isImage && !isPdf && !isText) {
      setFileError(`Unsupported file type. Supported: images (PNG, JPEG, GIF, WebP), PDF, CSV, TXT, JSON.`);
      return;
    }

    const reader = new FileReader();

    if (isImage) {
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        const base64  = dataUrl.split(",")[1];
        setAttachment({ name: file.name, mimeType: file.type, data: base64, preview: dataUrl });
      };
      reader.readAsDataURL(file);
    } else if (isPdf) {
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        const base64  = dataUrl.split(",")[1];
        setAttachment({ name: file.name, mimeType: file.type, data: base64 });
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = (e) => {
        const text = e.target?.result as string;
        setAttachment({ name: file.name, mimeType: file.type, text });
      };
      reader.readAsText(file);
    }

    // Reset input so the same file can be re-selected if removed
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSend(text?: string) {
    const content = (text ?? input).trim();
    if ((!content && !attachment) || loading) return;

    const userContent = content || (attachment ? `Please analyze the attached file: ${attachment.name}` : "");
    const next: Message[] = [...messages, { role: "user", content: userContent }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);

    const sentAttachment = attachment;
    setAttachment(null);

    try {
      const res = await fetch("/api/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages:   next,
          attachment: sentAttachment ? {
            name:     sentAttachment.name,
            mimeType: sentAttachment.mimeType,
            data:     sentAttachment.data,
            text:     sentAttachment.text,
          } : null,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Request failed");
      setMessages([...next, { role: "assistant", content: data.message }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
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
          {classifying ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
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
                  Attach a CSV, PDF, or image to analyze external data.
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
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
                  m.role === "user"
                    ? "bg-indigo-600 text-white rounded-br-sm"
                    : "bg-gray-100 text-gray-900 rounded-bl-sm"
                }`}>
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

          {error && <p className="text-xs text-red-500 text-center">{error}</p>}
          <div ref={bottomRef} />
        </div>

        {/* Attachment preview */}
        {(attachment || fileError) && (
          <div className="border-t border-gray-100 px-3 pt-2.5 pb-0">
            {fileError && (
              <p className="text-xs text-red-500 mb-1.5">{fileError}</p>
            )}
            {attachment && (
              <div className="flex items-center gap-2 mb-2">
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-50 border border-indigo-100 rounded-lg text-indigo-700 text-xs font-medium max-w-xs">
                  {attachment.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={attachment.preview} alt="" className="w-4 h-4 rounded object-cover" />
                  ) : (
                    fileIcon(attachment.mimeType)
                  )}
                  <span className="truncate max-w-[200px]">{attachment.name}</span>
                </div>
                <button
                  onClick={() => { setAttachment(null); setFileError(null); }}
                  className="p-1 text-gray-400 hover:text-gray-600 rounded"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Input bar */}
        <div className="border-t border-gray-100 p-3 flex gap-2 items-center">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf,text/csv,text/plain,application/json,.csv,.tsv,.txt,.json"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }}
          />
          {/* Attach button */}
          <button
            onClick={() => { setFileError(null); fileInputRef.current?.click(); }}
            disabled={loading}
            title="Attach image, PDF, or CSV"
            className="p-2 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 transition-colors shrink-0"
          >
            <Paperclip className="w-4 h-4" />
          </button>

          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder={attachment ? "Ask a question about the attached file…" : "Ask about spend, pipeline, CAC, LTV, funnel, companies…"}
            disabled={loading}
            className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50 placeholder:text-gray-400"
          />
          <button
            onClick={() => handleSend()}
            disabled={loading || (!input.trim() && !attachment)}
            className="p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
