"use client";

import { useState } from "react";
import { Eye, EyeOff, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TokenField } from "@/types";

interface Props {
  fields: TokenField[];
  platform: string;
  onConnect: (platform: string, data: Record<string, string>) => Promise<void>;
}

export function TokenForm({ fields, platform, onConnect }: Props) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, ""]))
  );
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allFilled = fields.every((f) => values[f.key]?.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await onConnect(platform, values);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed. Check your credentials and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {fields.map((field) => {
        const isPassword = field.type === "password";
        const isVisible = visible[field.key];
        const inputType = isPassword && !isVisible ? "password" : "text";

        return (
          <div key={field.key}>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {field.label}
            </label>
            <div className="relative">
              <input
                type={inputType}
                value={values[field.key]}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [field.key]: e.target.value }))
                }
                placeholder={field.placeholder}
                autoComplete="off"
                className={cn(
                  "w-full text-xs rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400",
                  "focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
                  isPassword && "pr-9"
                )}
              />
              {isPassword && (
                <button
                  type="button"
                  onClick={() =>
                    setVisible((v) => ({ ...v, [field.key]: !v[field.key] }))
                  }
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {isVisible ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
            </div>
            {field.hint && (
              <p className="text-[11px] text-slate-400 mt-1">{field.hint}</p>
            )}
          </div>
        );
      })}

      {error && (
        <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
      )}

      <button
        type="submit"
        disabled={!allFilled || loading}
        className={cn(
          "w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors",
          allFilled && !loading
            ? "bg-indigo-600 text-white hover:bg-indigo-700"
            : "bg-slate-100 text-slate-400 cursor-not-allowed"
        )}
      >
        {loading ? (
          "Verifying…"
        ) : (
          <>
            <CheckCircle2 className="w-4 h-4" />
            Save & Connect
          </>
        )}
      </button>
    </form>
  );
}
