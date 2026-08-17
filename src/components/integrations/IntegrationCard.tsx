"use client";

import { useState } from "react";
import { CheckCircle2, XCircle, RefreshCw, Unplug, ChevronDown, ChevronUp, ExternalLink, ArrowRight, History, RotateCcw } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import type { PlatformConfig, IntegrationStatus } from "@/types";
import { TokenForm } from "./TokenForm";
import { CampaignNameEditor } from "./CampaignNameEditor";

interface Props {
  config: PlatformConfig;
  status: IntegrationStatus | null;
  onConnect: (platform: string, data: Record<string, string>) => Promise<void>;
  onDisconnect: (platform: string) => Promise<void>;
  onSync: (platform: string) => Promise<void>;
  onBackfill?: (platform: string) => Promise<void>;
  onRefreshRecent?: (platform: string) => Promise<void>;
}

const CHANNEL_LABELS: Record<string, string> = {
  paid_media: "Paid Media",
  organic: "Organic",
  referral: "Referral",
  all: "All Channels",
};

const CHANNEL_COLORS: Record<string, string> = {
  paid_media: "bg-violet-100 text-violet-700",
  organic: "bg-emerald-100 text-emerald-700",
  referral: "bg-amber-100 text-amber-700",
  all: "bg-blue-100 text-blue-700",
};

export function IntegrationCard({ config, status, onConnect, onDisconnect, onSync, onBackfill, onRefreshRecent }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [campaignEditorOpen, setCampaignEditorOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [refreshingRecent, setRefreshingRecent] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const connected = status?.connected ?? false;
  const hasCredentials = status?.hasCredentials ?? false;

  async function handleSync() {
    setSyncing(true);
    try { await onSync(config.id); } finally { setSyncing(false); }
  }

  async function handleBackfill() {
    if (!onBackfill) return;
    setBackfilling(true);
    try { await onBackfill(config.id); } finally { setBackfilling(false); }
  }

  async function handleRefreshRecent() {
    if (!onRefreshRecent) return;
    setRefreshingRecent(true);
    try { await onRefreshRecent(config.id); } finally { setRefreshingRecent(false); }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try { await onDisconnect(config.id); } finally { setDisconnecting(false); }
  }

  return (
    <div className={cn(
      "bg-white rounded-xl border transition-shadow",
      connected ? "border-slate-200 shadow-sm" : "border-slate-200",
      expanded && "shadow-md"
    )}>
      {/* Header row */}
      <div className="flex items-center gap-4 p-5">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center text-white text-base font-bold shrink-0"
          style={{ backgroundColor: config.color }}
        >
          {config.name.charAt(0)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-slate-900">{config.name}</h3>
            {config.channel && (
              <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium", CHANNEL_COLORS[config.channel])}>
                {CHANNEL_LABELS[config.channel]}
              </span>
            )}
            <span className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
              connected
                ? "bg-emerald-50 text-emerald-700"
                : hasCredentials && config.credentialFields
                ? "bg-amber-50 text-amber-700"
                : "bg-slate-100 text-slate-500"
            )}>
              {connected
                ? <CheckCircle2 className="w-3 h-3" />
                : hasCredentials && config.credentialFields
                ? <ArrowRight className="w-3 h-3" />
                : <XCircle className="w-3 h-3" />}
              {connected
                ? "Connected"
                : hasCredentials && config.credentialFields
                ? "Step 2: Authorise →"
                : "Not connected"}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5 truncate">{config.description}</p>
          {connected && status?.lastSyncedAt && (
            <p className="text-xs text-slate-400 mt-0.5">
              Last synced {formatDate(status.lastSyncedAt)}
              {status.accountName && ` · ${status.accountName}`}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {connected && (
            <>
              {onBackfill && (
                <button
                  onClick={handleBackfill}
                  disabled={backfilling || syncing || refreshingRecent}
                  title="Pull historical data from April 1"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors disabled:opacity-50"
                >
                  <History className={cn("w-3 h-3", backfilling && "animate-spin")} />
                  {backfilling ? "Backfilling…" : "Backfill Apr 1→"}
                </button>
              )}
              {onRefreshRecent && (
                <button
                  onClick={handleRefreshRecent}
                  disabled={refreshingRecent || syncing || backfilling}
                  title="Re-fetch the last 7 days from HubSpot"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors disabled:opacity-50"
                >
                  <RotateCcw className={cn("w-3 h-3", refreshingRecent && "animate-spin")} />
                  {refreshingRecent ? "Refreshing…" : "Refresh last 7 days"}
                </button>
              )}
              <button
                onClick={handleSync}
                disabled={syncing || backfilling || refreshingRecent}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={cn("w-3 h-3", syncing && "animate-spin")} />
                {syncing ? "Syncing…" : "Sync now"}
              </button>
              {config.credentialFields && (
                <button
                  onClick={() => setExpanded((v) => !v)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                >
                  {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  Credentials
                </button>
              )}
              {config.id === "google_ads" && (
                <button
                  onClick={() => setCampaignEditorOpen((v) => !v)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                >
                  {campaignEditorOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  Campaign Names
                </button>
              )}
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                <Unplug className="w-3 h-3" />
                Disconnect
              </button>
            </>
          )}
          {!connected && (
            <>
              {/* Credentials saved but OAuth not done yet — go straight to Google/LinkedIn */}
              {hasCredentials && config.credentialFields ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setExpanded((v) => !v)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
                  >
                    Edit credentials
                  </button>
                  <button
                    onClick={() => { window.location.href = config.oauthPath ?? `/api/oauth/${config.id}`; }}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                  >
                    <ArrowRight className="w-3 h-3" />
                    Authorise with OAuth
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setExpanded((v) => !v)}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                >
                  Connect
                  {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Campaign name mappings editor (Google Ads only) */}
      {campaignEditorOpen && config.id === "google_ads" && (
        <CampaignNameEditor />
      )}

      {/* Expandable setup/credentials section */}
      {expanded && (
        <div className="border-t border-slate-100 px-5 pb-5 pt-4 space-y-4">
          {/* Setup steps */}
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Setup Steps</p>
            <ol className="space-y-1.5">
              {config.setupSteps.map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-slate-600">
                  <span className="flex-shrink-0 w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[10px] font-bold mt-0.5">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
            <a
              href={config.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline mt-2"
            >
              <ExternalLink className="w-3 h-3" />
              View API docs
            </a>
          </div>

          {/* Connect form — token, OAuth with credentials, or plain OAuth */}
          {config.authMethod === "token" && config.fields ? (
            <TokenForm fields={config.fields} platform={config.id} onConnect={onConnect} />
          ) : config.credentialFields ? (
            <OAuthCredentialsForm
              fields={config.credentialFields}
              platform={config.id}
              oauthPath={config.oauthPath ?? `/api/oauth/${config.id}`}
              hasCredentials={hasCredentials}
            />
          ) : (
            <OAuthButton platform={config.id} oauthPath={config.oauthPath} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OAuth with credentials form (Google, LinkedIn)
// ---------------------------------------------------------------------------

function OAuthCredentialsForm({
  fields,
  platform,
  oauthPath,
  hasCredentials,
}: {
  fields: NonNullable<PlatformConfig["credentialFields"]>;
  platform: string;
  oauthPath: string;
  hasCredentials: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, ""]))
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(hasCredentials);
  const [error, setError] = useState<string | null>(null);
  const [showFields, setShowFields] = useState(!hasCredentials);

  const allFilled = fields.every((f) => values[f.key]?.trim());

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/integrations/${platform}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to save credentials");
      }
      setSaved(true);
      setShowFields(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {saved && !showFields ? (
        <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-200">
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            Credentials saved
          </div>
          <button
            onClick={() => setShowFields(true)}
            className="text-xs text-indigo-600 hover:underline"
          >
            Update
          </button>
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
            OAuth App Credentials
          </p>
          {fields.map((field) => (
            <div key={field.key}>
              <label className="block text-xs font-medium text-slate-700 mb-1">{field.label}</label>
              <input
                type={field.type}
                value={values[field.key]}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                autoComplete="off"
                className="w-full text-xs rounded-lg border border-slate-200 px-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              {field.hint && <p className="text-[11px] text-slate-400 mt-1">{field.hint}</p>}
            </div>
          ))}
          {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
          <button
            type="submit"
            disabled={!allFilled || saving}
            className={cn(
              "w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors",
              allFilled && !saving ? "bg-slate-800 text-white hover:bg-slate-900" : "bg-slate-100 text-slate-400 cursor-not-allowed"
            )}
          >
            {saving ? "Saving…" : "Save credentials"}
          </button>
        </form>
      )}

      {/* OAuth redirect button — only active once credentials are saved */}
      <button
        onClick={() => { window.location.href = oauthPath; }}
        disabled={!saved}
        className={cn(
          "w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors",
          saved ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-slate-100 text-slate-400 cursor-not-allowed"
        )}
      >
        Authorise with OAuth
        <ArrowRight className="w-4 h-4" />
      </button>
      {!saved && (
        <p className="text-[11px] text-slate-400 text-center">Save your credentials above to enable the OAuth button</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plain OAuth button (no credential fields needed)
// ---------------------------------------------------------------------------

function OAuthButton({ platform, oauthPath }: { platform: string; oauthPath?: string }) {
  return (
    <button
      onClick={() => { window.location.href = oauthPath ?? `/api/oauth/${platform}`; }}
      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
    >
      Connect with OAuth
    </button>
  );
}
