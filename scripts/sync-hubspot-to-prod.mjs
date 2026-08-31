/**
 * Syncs HubSpot MetricSnapshot rows from the local Neon DB into the
 * production Neon DB. Use this when the production backfill times out
 * on Vercel but the local backfill has already produced correct data.
 *
 * Usage:
 *   PROD_DATABASE_URL="<your-prod-neon-url>" node scripts/sync-hubspot-to-prod.mjs
 *
 * Get your production DATABASE_URL from Vercel → Project → Settings →
 * Environment Variables → DATABASE_URL (or DATABASE_URL_UNPOOLED).
 */

import pg from "pg";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ── Load .env ────────────────────────────────────────────────────────────────
const envVars = Object.fromEntries(
  readFileSync(resolve(root, ".env"), "utf8")
    .split("\n")
    .filter(line => line.includes("=") && !line.startsWith("#"))
    .map(line => {
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      return [key, val];
    })
);

const localUrl = envVars.DATABASE_URL_UNPOOLED ?? envVars.DATABASE_URL;
if (!localUrl) { console.error("❌  DATABASE_URL not found in .env"); process.exit(1); }

const prodUrl = process.env.PROD_DATABASE_URL;
if (!prodUrl) {
  console.error("❌  PROD_DATABASE_URL env var not set.");
  console.error("    Run: PROD_DATABASE_URL=\"<your-prod-url>\" node scripts/sync-hubspot-to-prod.mjs");
  process.exit(1);
}

// ── Connect ───────────────────────────────────────────────────────────────────
const src  = new pg.Client({ connectionString: localUrl,  ssl: { rejectUnauthorized: false } });
const dest = new pg.Client({ connectionString: prodUrl,   ssl: { rejectUnauthorized: false } });

await src.connect();
await dest.connect();
console.log("✅  Connected to both databases.");

// ── Read all HubSpot rows from local ─────────────────────────────────────────
const { rows } = await src.query(
  `SELECT * FROM "MetricSnapshot" WHERE platform = 'hubspot' ORDER BY date ASC`
);
console.log(`📦  Found ${rows.length} HubSpot rows in local DB.`);
if (rows.length === 0) {
  console.log("Nothing to sync — exiting.");
  await src.end(); await dest.end();
  process.exit(0);
}

// ── Upsert in batches ─────────────────────────────────────────────────────────
const COLS = [
  "id","date","platform","channel",
  "impressions","clicks","sessions",
  "leads","mqls","sqos","opportunities","closedWon",
  "spend","revenue","pipeline","activePipeline",
  "cpc","cpl","cpMql","cpSqo","paidCac","mktgCac",
  "ctr","leadToMql","mqlToSqo","sqoToClose",
  "createdAt",
];

// Columns that exist in the schema — filter to only what the DB actually has
const firstRow = rows[0];
const validCols = COLS.filter(c => c in firstRow);
const conflictCols = ["date", "platform", "channel"];
const updateCols = validCols.filter(c => !conflictCols.includes(c) && c !== "id" && c !== "createdAt");

const BATCH = 200;
let upserted = 0;

for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const values = [];
  const placeholders = chunk.map((row, ri) => {
    const start = ri * validCols.length + 1;
    validCols.forEach(col => values.push(row[col] ?? null));
    return `(${validCols.map((_, ci) => `$${start + ci}`).join(", ")})`;
  });

  const setClauses = updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(", ");

  await dest.query(
    `INSERT INTO "MetricSnapshot" (${validCols.map(c => `"${c}"`).join(", ")})
     VALUES ${placeholders.join(", ")}
     ON CONFLICT ("date", "platform", "channel")
     DO UPDATE SET ${setClauses}`,
    values
  );
  upserted += chunk.length;
  process.stdout.write(`\r⏳  Upserted ${upserted}/${rows.length} rows…`);
}

console.log(`\n✅  Done — ${upserted} HubSpot rows synced to production.`);
await src.end();
await dest.end();
