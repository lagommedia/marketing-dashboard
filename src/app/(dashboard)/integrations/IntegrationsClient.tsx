"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PLATFORMS } from "@/lib/platforms";
import { IntegrationCard } from "@/components/integrations/IntegrationCard";
import { CheckCircle2, XCircle, RefreshCw, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IntegrationStatus } from "@/types";

interface Props {
  statuses:       IntegrationStatus[];
  linkedinOrgUrn?: string | null;
}

// ---------------------------------------------------------------------------
// Organic social — lightweight inline cards that share credentials with the
// paid LinkedIn / Facebook integrations but hit the organic-sync routes.
// ---------------------------------------------------------------------------

const ORGANIC_SOCIAL = [
  {
    id:          "linkedin_organic",
    name:        "LinkedIn Page (Organic)",
    description: "Sync follower count, post impressions, reach, clicks, and engagement from your LinkedIn Company Page.",
    color:       "#0A66C2",
    syncRoute:   "/api/integrations/linkedin-organic/organic-sync",
    credRoute:   "/api/integrations/linkedin-organic/credentials",
    oauthPath:   "/api/oauth/linkedin-organic",
    setupNote:   "Requires a separate LinkedIn Developer App with only the Community Management API product. The redirect URL is: " + (typeof window !== "undefined" ? window.location.origin : "") + "/api/oauth/linkedin-organic/callback",
    docsUrl:     "https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/organizations/share-statistics",
    requiredScopes: "r_organization_admin, rw_organization_admin",
  },
  {
    id:          "facebook",
    name:        "Facebook & Instagram (Organic)",
    description: "Sync Page reach, impressions, engaged users, fan count, and Instagram Business insights.",
    color:       "#1877F2",
    syncRoute:   "/api/integrations/facebook/organic-sync",
    credRoute:   null,
    oauthPath:   null,
    setupNote:   "Uses the same Facebook token as Facebook Business Manager. Ensure your token has pages_read_engagement, read_insights, and instagram_manage_insights permissions.",
    docsUrl:     "https://developers.facebook.com/docs/graph-api/reference/v26.0/page/insights",
    requiredScopes: "pages_read_engagement, read_insights, pages_show_list, instagram_basic, instagram_manage_insights",
  },
];

function OrganicSocialCard({
  config,
  status,
  orgUrn,
}: {
  config:  typeof ORGANIC_SOCIAL[number];
  status:  IntegrationStatus | null;
  orgUrn?: string | null;
}) {
  const [syncing,      setSyncing]      = useState(false);
  const [syncMsg,      setSyncMsg]      = useState<string | null>(null);
  const [showSetup,    setShowSetup]    = useState(false);
  const [clientId,     setClientId]     = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [savingCreds,  setSavingCreds]  = useState(false);
  const [credsSaved,   setCredsSaved]   = useState(status?.hasCredentials ?? false);
  const connected = status?.connected ?? false;

  const hasOAuth = !!config.oauthPath;

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res  = await fetch(config.syncRoute, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days: 30 }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      setSyncMsg(`Synced ${json.recordsCount ?? 0} rows.`);
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveCreds(e: React.FormEvent) {
    e.preventDefault();
    if (!config.credRoute) return;
    setSavingCreds(true);
    setSyncMsg(null);
    try {
      const res  = await fetch(config.credRoute, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, clientSecret }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save");
      setCredsSaved(true);
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : "Failed to save credentials");
    } finally {
      setSavingCreds(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3">
      {/* Header row */}
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-white text-base font-bold shrink-0 mt-0.5" style={{ backgroundColor: config.color }}>
          {config.name.charAt(0)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-slate-900">{config.name}</h3>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">Organic</span>
            <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium", connected ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>
              {connected ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
              {connected ? "Connected" : "Not connected"}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{config.description}</p>
        </div>
        <div className="shrink-0 flex gap-2">
          {connected ? (
            <button onClick={handleSync} disabled={syncing} className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors", syncing ? "bg-slate-100 text-slate-400 cursor-not-allowed" : "bg-indigo-600 text-white hover:bg-indigo-700")}>
              <RefreshCw className={cn("w-3.5 h-3.5", syncing && "animate-spin")} />
              {syncing ? "Syncing…" : "Sync Organic"}
            </button>
          ) : hasOAuth ? (
            <button onClick={() => setShowSetup(v => !v)} className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
              Connect
            </button>
          ) : (
            <span className="text-xs text-slate-400 italic">Uses existing connection</span>
          )}
        </div>
      </div>

      {/* LinkedIn OAuth setup flow */}
      {hasOAuth && showSetup && !connected && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Step 1 — OAuth App Credentials</p>
          <p className="text-xs text-slate-500">
            Create a <strong>separate</strong> LinkedIn Developer App with only the <strong>Community Management API</strong> product.
            Register redirect URL: <code className="bg-slate-200 px-1 rounded text-slate-700">{typeof window !== "undefined" ? window.location.origin : ""}/api/oauth/linkedin-organic/callback</code>
          </p>
          {credsSaved ? (
            <div className="flex items-center justify-between p-2 bg-white rounded border border-slate-200 text-xs text-slate-600">
              <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> Credentials saved</span>
              <button onClick={() => setCredsSaved(false)} className="text-indigo-600 hover:underline">Update</button>
            </div>
          ) : (
            <form onSubmit={handleSaveCreds} className="space-y-2">
              <input type="text" value={clientId} onChange={e => setClientId(e.target.value)} placeholder="Client ID" autoComplete="off" className="w-full text-xs rounded border border-slate-200 px-3 py-1.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder="Client Secret" autoComplete="off" className="w-full text-xs rounded border border-slate-200 px-3 py-1.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <button type="submit" disabled={!clientId || !clientSecret || savingCreds} className={cn("w-full py-1.5 rounded text-xs font-semibold transition-colors", clientId && clientSecret && !savingCreds ? "bg-slate-800 text-white hover:bg-slate-900" : "bg-slate-100 text-slate-400 cursor-not-allowed")}>
                {savingCreds ? "Saving…" : "Save credentials"}
              </button>
            </form>
          )}
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide pt-1">Step 2 — Authorise</p>
          <button onClick={() => { window.location.href = config.oauthPath!; }} disabled={!credsSaved} className={cn("w-full py-2 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-2", credsSaved ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-slate-100 text-slate-400 cursor-not-allowed")}>
            Authorise with OAuth →
          </button>
          {!credsSaved && <p className="text-[11px] text-slate-400 text-center">Save credentials above to enable OAuth</p>}
        </div>
      )}

      {syncMsg && (
        <div className={cn("rounded-lg px-3 py-2 text-xs", syncMsg.toLowerCase().includes("error") || syncMsg.toLowerCase().includes("fail") ? "bg-red-50 text-red-700 border border-red-200" : "bg-green-50 text-green-700 border border-green-200")}>
          {syncMsg}
        </div>
      )}

      <div className="rounded-lg bg-slate-50 border border-slate-100 px-4 py-3 text-xs text-slate-500 space-y-1">
        <p><span className="font-medium text-slate-700">Required scopes:</span> {config.requiredScopes}</p>
        <a href={config.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-600 hover:underline mt-1">
          View API docs <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

/** Platforms that support historical backfill, keyed to their backfill endpoint */
const BACKFILL_ENDPOINTS: Partial<Record<string, string>> = {
  hubspot:               "/api/integrations/hubspot/backfill",
  google_ads:            "/api/integrations/google_ads/backfill",
  google_search_console: "/api/integrations/google_search_console/backfill",
};

/** Platforms that support a quick 7-day refresh */
const REFRESH_RECENT_ENDPOINTS: Partial<Record<string, string>> = {
  hubspot: "/api/integrations/hubspot/backfill",
};

const SECTIONS = [
  {
    title: "CRM",
    description: "Funnel and revenue data",
    platforms: ["hubspot"],
  },
  {
    title: "Paid Media",
    description: "Spend, impressions, and conversions",
    platforms: ["google_ads", "facebook", "linkedin", "reddit"],
  },
  {
    title: "Organic & Analytics",
    description: "Search and content performance",
    platforms: ["google_search_console", "google_analytics"],
  },
  {
    title: "Internal Models",
    description: "Planning spreadsheets and internal data sources",
    platforms: ["google_sheets"],
  },
  {
    title: "AI",
    description: "Intelligent insights powered by large language models",
    platforms: ["anthropic"],
  },
];

export function IntegrationsClient({ statuses, linkedinOrgUrn }: Props) {
  const router = useRouter();

  async function handleConnect(platform: string, data: Record<string, string>) {
    const res = await fetch(`/api/integrations/${platform}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Failed to connect");
    }

    router.refresh();
  }

  async function handleDisconnect(platform: string) {
    await fetch(`/api/integrations/${platform}/disconnect`, { method: "POST" });
    router.refresh();
  }

  async function handleSync(platform: string) {
    await fetch(`/api/integrations/${platform}/sync`, { method: "POST" });
    router.refresh();
  }

  async function handleBackfill(platform: string) {
    const endpoint = BACKFILL_ENDPOINTS[platform];
    if (!endpoint) return;
    const from = `${new Date().getFullYear()}-04-01`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(`Backfill failed: ${body.error ?? res.statusText}`);
      return;
    }
    alert(`Backfill complete — ${body.days ?? 0} days, ${body.snapshots ?? 0} snapshots written.`);
    router.refresh();
  }

  async function handleRefreshRecent(platform: string) {
    const endpoint = REFRESH_RECENT_ENDPOINTS[platform];
    if (!endpoint) return;
    const from = new Date();
    from.setDate(from.getDate() - 7);
    const fromStr = from.toISOString().slice(0, 10);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromStr }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(`Refresh failed: ${body.error ?? res.statusText}`);
      return;
    }
    alert(`Refresh complete — ${body.days ?? 0} days updated.`);
    router.refresh();
  }

  return (
    <div className="space-y-8">
      {SECTIONS.map((section) => {
        const sectionPlatforms = section.platforms
          .map((id) => PLATFORMS.find((p) => p.id === id))
          .filter(Boolean);

        return (
          <div key={section.title}>
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-slate-700">{section.title}</h2>
              <p className="text-xs text-slate-400">{section.description}</p>
            </div>
            <div className="space-y-3">
              {sectionPlatforms.map((config) => {
                const status = statuses.find((s) => s.platform === config!.id) ?? null;
                return (
                  <IntegrationCard
                    key={config!.id}
                    config={config!}
                    status={status}
                    onConnect={handleConnect}
                    onDisconnect={handleDisconnect}
                    onSync={handleSync}
                    onBackfill={BACKFILL_ENDPOINTS[config!.id] ? handleBackfill : undefined}
                    onRefreshRecent={REFRESH_RECENT_ENDPOINTS[config!.id] ? handleRefreshRecent : undefined}
                  />
                );
              })}
            </div>

            {/* Organic Social sub-section — injected after Paid Media */}
            {section.title === "Paid Media" && (
              <div className="mt-8">
                <div className="mb-3">
                  <h2 className="text-sm font-semibold text-slate-700">Organic Social</h2>
                  <p className="text-xs text-slate-400">Follower growth, reach, and engagement from your company pages</p>
                </div>
                <div className="space-y-3">
                  {ORGANIC_SOCIAL.map(cfg => (
                    <OrganicSocialCard
                      key={cfg.id}
                      config={cfg}
                      status={statuses.find(s => s.platform === cfg.id) ?? null}
                      orgUrn={cfg.id === "linkedin_organic" ? linkedinOrgUrn : null}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
