import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/encryption";

// ---------------------------------------------------------------------------
// Simple delay
// ---------------------------------------------------------------------------
export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Exponential backoff retry with jitter
//
// Retries on:
//   • 429 Too Many Requests  — respects Retry-After header when present
//   • 500/502/503/504        — transient server errors
//
// Does NOT retry on 400/401/403/404 — those are permanent and retrying
// would waste quota and potentially trigger abuse detection.
//
// Jitter (±25% of computed delay) prevents thundering-herd when multiple
// syncs run close together.
// ---------------------------------------------------------------------------

// Matches "429", "500", "502", "503", "504" anywhere in the error message.
const RETRYABLE_STATUS = /\b(429|5[0-9]{2})\b/;

export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 4, baseDelayMs = 1000, maxDelayMs = 32_000, label = "request" }: {
    maxRetries?:  number;
    baseDelayMs?: number;
    maxDelayMs?:  number;
    label?:       string;
  } = {}
): Promise<T> {
  let lastError: Error = new Error("Unknown error");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const shouldRetry = RETRYABLE_STATUS.test(lastError.message) && attempt < maxRetries;
      if (!shouldRetry) throw lastError;

      // Honour Retry-After if the error message carries it (format: "Retry-After: N")
      const retryAfterMatch = lastError.message.match(/Retry-After:\s*(\d+)/i);
      const retryAfterMs    = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) * 1000 : null;

      // Exponential backoff capped at maxDelayMs, then ±25% jitter
      const expBackoff = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const jitter     = expBackoff * 0.25 * (Math.random() * 2 - 1); // –25% … +25%
      const waitMs     = retryAfterMs ?? Math.round(expBackoff + jitter);

      console.warn(`[sync:${label}] attempt ${attempt + 1}/${maxRetries} failed (${lastError.message.slice(0, 80)}), retrying in ${waitMs}ms…`);
      await delay(waitMs);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Google OAuth token refresh
// Access tokens expire after 1 hour — refresh silently before each sync
// ---------------------------------------------------------------------------
export async function getValidGoogleToken(platform: string): Promise<string> {
  const row = await prisma.integration.findUnique({ where: { platform } });
  if (!row?.accessToken) throw new Error(`No access token stored for ${platform}`);

  // Check if still valid (with 5-min buffer)
  const expiryBuffer = 5 * 60 * 1000;
  if (row.tokenExpiry && row.tokenExpiry.getTime() - Date.now() > expiryBuffer) {
    return decrypt(row.accessToken);
  }

  // Token expired — refresh it
  if (!row.refreshToken) throw new Error(`No refresh token stored for ${platform} — re-authorise in Integrations`);

  // All Google platforms share the same OAuth app credentials, stored on the
  // google_ads row. Fall back there if this platform's row doesn't have them.
  let clientId     = row.clientId     ? decrypt(row.clientId)     : null;
  let clientSecret = row.clientSecret ? decrypt(row.clientSecret) : null;
  if (!clientId || !clientSecret) {
    const adsRow = await prisma.integration.findUnique({ where: { platform: "google_ads" } });
    clientId     = adsRow?.clientId     ? decrypt(adsRow.clientId)     : process.env.GOOGLE_CLIENT_ID!;
    clientSecret = adsRow?.clientSecret ? decrypt(adsRow.clientSecret) : process.env.GOOGLE_CLIENT_SECRET!;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decrypt(row.refreshToken),
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Google token refresh failed: ${body.error_description ?? res.status}`);
  }

  const tokens = await res.json();
  const newExpiry = new Date(Date.now() + tokens.expires_in * 1000);

  // Persist the refreshed token
  await prisma.integration.update({
    where: { platform },
    data: {
      accessToken: encrypt(tokens.access_token),
      tokenExpiry: newExpiry,
    },
  });

  return tokens.access_token;
}
