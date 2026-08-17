/**
 * Google Sheets integration — read data from a connected spreadsheet.
 *
 * Auth: OAuth 2.0 (access token + refresh token stored in Integration row)
 *       Spreadsheet ID stored as accountId in the Integration row.
 *
 * Tokens are auto-refreshed when they expire.
 */

import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/encryption";
// prisma is already imported above — used for both token management and Reference Sheet cache

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

/** Returns a valid access token, refreshing it first if it has expired. */
async function getAccessToken(): Promise<string> {
  const row = await prisma.integration.findUnique({
    where: { platform: "google_sheets" },
  });

  if (!row?.connected || !row.accessToken) {
    throw new Error(
      "Google Sheets is not connected. Authorise it under Integrations."
    );
  }

  // If the token is still valid (with a 2-min buffer), return it as-is
  if (row.tokenExpiry && row.tokenExpiry.getTime() - Date.now() > 2 * 60 * 1000) {
    return decrypt(row.accessToken);
  }

  // Token expired — use the refresh token to get a new one
  if (!row.refreshToken || !row.clientId || !row.clientSecret) {
    throw new Error(
      "Google Sheets access token expired and cannot be refreshed. Re-authorise under Integrations."
    );
  }

  const clientId     = decrypt(row.clientId);
  const clientSecret = decrypt(row.clientSecret);
  const refreshToken = decrypt(row.refreshToken);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(
      "Failed to refresh Google Sheets access token. Re-authorise under Integrations."
    );
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  const expiry = new Date(Date.now() + data.expires_in * 1000);

  await prisma.integration.update({
    where: { platform: "google_sheets" },
    data: {
      accessToken: encrypt(data.access_token),
      tokenExpiry: expiry,
    },
  });

  return data.access_token;
}

async function getSpreadsheetId(): Promise<string> {
  const row = await prisma.integration.findUnique({
    where:  { platform: "google_sheets" },
    select: { accountId: true },
  });
  if (!row?.accountId) {
    throw new Error("Spreadsheet ID not found — reconnect Google Sheets.");
  }
  return row.accountId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Fetch a named range or A1 notation range from the connected spreadsheet.
 * Returns a 2-D array of raw cell values (all as strings).
 *
 * @example
 *   const rows = await fetchSheetRange("Sheet1!A1:Z100");
 *   const rows = await fetchSheetRange("Targets");  // named range
 */
export async function fetchSheetRange(range: string): Promise<string[][]> {
  const [token, spreadsheetId] = await Promise.all([
    getAccessToken(),
    getSpreadsheetId(),
  ]);

  const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Google Sheets API error ${res.status}`);
  }

  const data = await res.json() as { values?: string[][] };
  return data.values ?? [];
}

/**
 * Fetch the list of sheet tab names in the connected spreadsheet.
 */
export async function fetchSheetNames(): Promise<string[]> {
  const [token, spreadsheetId] = await Promise.all([
    getAccessToken(),
    getSpreadsheetId(),
  ]);

  const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Google Sheets API error ${res.status}`);
  }

  const data = await res.json() as { sheets?: { properties: { title: string } }[] };
  return (data.sheets ?? []).map((s) => s.properties.title);
}

/**
 * Convert a flat 2-D values array into an array of objects using the
 * first row as column headers.
 *
 * @example
 *   const rows  = await fetchSheetRange("Targets!A:Z");
 *   const items = rowsToObjects(rows);
 *   // → [{ Quarter: "Q2 2026", Revenue: "1500000", ... }, ...]
 */
export function rowsToObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length < 2) return [];
  const [headers, ...body] = rows;
  return body.map((row) =>
    Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]))
  );
}

// ---------------------------------------------------------------------------
// Sync entry-point (called by the generic sync engine)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reference Sheet sync — populates the ReferenceSheetMonth cache
// ---------------------------------------------------------------------------

const SHORT_MONTHS_SYNC = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function normMonthSync(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}

function parseNumSync(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  const n = parseFloat(String(v).replace(/[$,%\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

function toDecimalSync(v: unknown): number {
  const n = parseNumSync(v);
  return n > 1 ? n / 100 : n;
}

/**
 * Reads the Reference Sheet and upserts every month column into
 * ReferenceSheetMonth.  Called whenever the user triggers a Google Sheets
 * sync from the integrations page.
 *
 * Rows read (by label scan / known row numbers):
 *   Marketing Gross Costs  — found by scanning column B
 *   Shared Allocation      — row immediately below Gross Costs
 *   Customer Churn Rate    — row 65
 *   ARPU                   — row 69
 *   Gross Margin           — row 97
 */
export async function syncGoogleSheets(): Promise<{ recordsCount: number }> {
  // Connectivity check
  await fetchSheetNames();

  const SHEET       = "'Reference Sheet (DO NOT TOUCH)'";
  const GROSS_LABEL = "Marketing Gross Costs";
  const CHURN_ROW   = 64;  // Customer Churn Rate (row 64, not 65)
  const LTV_ROW     = 69;  // Pre-computed LTV (row 69 — sheet calculates this for us)
  const MARGIN_ROW  = 97;

  // 1. Header row + label column to locate Gross Costs row
  const [headerRows, labelCol] = await Promise.all([
    fetchSheetRange(`${SHEET}!2:2`),
    fetchSheetRange(`${SHEET}!B:B`),
  ]);
  const headerRow = headerRows[0] ?? [];

  let grossRowIdx = -1;
  for (let i = 0; i < labelCol.length; i++) {
    if ((labelCol[i][0] ?? "").trim() === GROSS_LABEL) { grossRowIdx = i; break; }
  }
  if (grossRowIdx === -1) {
    throw new Error(`"${GROSS_LABEL}" not found in Reference Sheet column B`);
  }

  // 2. All five data rows in one batch
  const [grossData, sharedData, ltvData, marginData, churnData] = await Promise.all([
    fetchSheetRange(`${SHEET}!${grossRowIdx + 1}:${grossRowIdx + 1}`).then(r => r[0] ?? []),
    fetchSheetRange(`${SHEET}!${grossRowIdx + 2}:${grossRowIdx + 2}`).then(r => r[0] ?? []),
    fetchSheetRange(`${SHEET}!${LTV_ROW}:${LTV_ROW}`).then(r => r[0] ?? []),
    fetchSheetRange(`${SHEET}!${MARGIN_ROW}:${MARGIN_ROW}`).then(r => r[0] ?? []),
    fetchSheetRange(`${SHEET}!${CHURN_ROW}:${CHURN_ROW}`).then(r => r[0] ?? []),
  ]);

  // 3. Walk the header; collect every column that looks like "Mon YYYY"
  const MONTH_RE = new RegExp(
    `^(${SHORT_MONTHS_SYNC.join("|")})\\s+(\\d{4})$`,
    "i",
  );

  type UpsertRow = {
    month: string; grossCosts: number; sharedAllocation: number;
    ltv: number; grossMargin: number; churnRate: number;
  };
  const rows: UpsertRow[] = [];

  for (let i = 0; i < headerRow.length; i++) {
    const cell = String(headerRow[i] ?? "").trim();
    if (!MONTH_RE.test(cell)) continue;
    rows.push({
      month:            normMonthSync(cell),
      grossCosts:       parseNumSync(grossData[i]),
      sharedAllocation: parseNumSync(sharedData[i]),
      ltv:              parseNumSync(ltvData[i]),
      grossMargin:      toDecimalSync(marginData[i]),
      churnRate:        toDecimalSync(churnData[i]),
    });
  }

  if (rows.length === 0) {
    throw new Error("No month columns found in Reference Sheet header row");
  }

  // 4. Upsert all months in a single transaction
  await prisma.$transaction(
    rows.map((row) =>
      prisma.referenceSheetMonth.upsert({
        where:  { month: row.month },
        update: { grossCosts: row.grossCosts, sharedAllocation: row.sharedAllocation,
                  ltv: row.ltv, grossMargin: row.grossMargin, churnRate: row.churnRate },
        create: row,
      }),
    ),
  );

  return { recordsCount: rows.length };
}
