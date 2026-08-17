export type Platform =
  | "hubspot"
  | "google_ads"
  | "google_search_console"
  | "facebook"
  | "linkedin"
  | "linkedin_organic"
  | "reddit"
  | "anthropic"
  | "google_sheets"
  | "google_analytics";

export type Channel = "paid_media" | "organic" | "referral" | "all";

export type AuthMethod = "token" | "oauth";

export interface PlatformConfig {
  id: Platform;
  name: string;
  description: string;
  authMethod: AuthMethod;
  /** Omit for non-data-source integrations (e.g. AI providers) */
  channel?: Channel;
  color: string;
  logo: string;
  oauthPath?: string; // override for OAuth redirect, e.g. google_ads → /api/oauth/google
  fields?: TokenField[]; // for token-based auth
  credentialFields?: TokenField[]; // OAuth app credentials (clientId, clientSecret)
  oauthScopes?: string[];
  docsUrl: string;
  setupSteps: string[];
}

export interface TokenField {
  key: string;
  label: string;
  placeholder: string;
  type: "text" | "password";
  hint?: string;
}

export interface IntegrationStatus {
  id: string;
  platform: Platform;
  connected: boolean;
  hasCredentials: boolean; // OAuth app credentials saved in DB
  accountId?: string | null;
  accountName?: string | null;
  lastSyncedAt?: Date | null;
}

export interface FunnelMetrics {
  impressions: number | null;
  clicks: number | null;
  sessions: number | null;
  leads: number | null;
  mqls: number | null;
  sqos: number | null;
  opportunities: number | null;
  closedWon: number | null;
  spend: number | null;
  revenue: number | null;
  pipeline: number | null;
  activePipeline: number | null;
  cpc: number | null;
  cpl: number | null;
  cpMql: number | null;
  cpSqo: number | null;
  paidCac: number | null;
  mktgCac: number | null;
  ctr: number | null;
  leadToMql: number | null;
  mqlToSqo: number | null;
  sqoToClose: number | null;
}

export interface PacingData {
  channel: Channel;
  period: string;
  targets: Partial<FunnelMetrics>;
  actuals: Partial<FunnelMetrics>;
  elapsedFraction: number; // 0-1
}
