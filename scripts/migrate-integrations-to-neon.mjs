/**
 * One-shot migration: copies Integration rows from local dev.db (SQLite)
 * into the Neon PostgreSQL database.
 *
 * Encrypted tokens are copied as-is — they were encrypted with the same
 * ENCRYPTION_KEY that Vercel uses, so no decryption/re-encryption needed.
 *
 * Run with:
 *   node scripts/migrate-integrations-to-neon.mjs
 */

import { createClient } from "@libsql/client";
import pg from "pg";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Load .env manually (avoid dotenv dependency assumption)
const envPath = resolve(root, ".env");
const envVars = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter(line => line.includes("=") && !line.startsWith("#"))
    .map(line => {
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      return [key, val];
    })
);

const dbUrl = envVars.DATABASE_URL_UNPOOLED ?? envVars.DATABASE_URL;
if (!dbUrl) {
  console.error("❌  DATABASE_URL_UNPOOLED (or DATABASE_URL) not found in .env");
  process.exit(1);
}

// ── Read from local SQLite ──────────────────────────────────────────────────

const sqlite = createClient({ url: `file:${resolve(root, "dev.db")}` });

const { rows } = await sqlite.execute("SELECT * FROM Integration");

if (rows.length === 0) {
  console.log("ℹ️  No Integration rows found in dev.db — nothing to migrate.");
  process.exit(0);
}

console.log(`Found ${rows.length} integration(s) in dev.db:`);
rows.forEach(r => console.log(`  • ${r.platform} (connected: ${r.connected})`));

// ── Write to Neon ───────────────────────────────────────────────────────────

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

let migrated = 0;
let skipped  = 0;

for (const r of rows) {
  try {
    await client.query(
      `INSERT INTO "Integration" (
        id, platform, connected,
        "accessToken", "tokenSecret", "clientId", "clientSecret",
        "refreshToken", "tokenExpiry", scopes,
        "accountId", "accountName", "lastSyncedAt",
        "createdAt", "updatedAt"
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
      )
      ON CONFLICT (platform) DO UPDATE SET
        connected      = EXCLUDED.connected,
        "accessToken"  = EXCLUDED."accessToken",
        "tokenSecret"  = EXCLUDED."tokenSecret",
        "clientId"     = EXCLUDED."clientId",
        "clientSecret" = EXCLUDED."clientSecret",
        "refreshToken" = EXCLUDED."refreshToken",
        "tokenExpiry"  = EXCLUDED."tokenExpiry",
        scopes         = EXCLUDED.scopes,
        "accountId"    = EXCLUDED."accountId",
        "accountName"  = EXCLUDED."accountName",
        "lastSyncedAt" = EXCLUDED."lastSyncedAt",
        "updatedAt"    = EXCLUDED."updatedAt"`,
      [
        r.id,
        r.platform,
        r.connected === 1 || r.connected === true,
        r.accessToken  ?? null,
        r.tokenSecret  ?? null,
        r.clientId     ?? null,
        r.clientSecret ?? null,
        r.refreshToken ?? null,
        r.tokenExpiry  ?? null,
        r.scopes       ?? null,
        r.accountId    ?? null,
        r.accountName  ?? null,
        r.lastSyncedAt ?? null,
        r.createdAt    ?? new Date().toISOString(),
        r.updatedAt    ?? new Date().toISOString(),
      ]
    );
    console.log(`  ✓ ${r.platform}`);
    migrated++;
  } catch (err) {
    console.error(`  ✗ ${r.platform}: ${err.message}`);
    skipped++;
  }
}

await client.end();
console.log(`\nDone. Migrated: ${migrated}  Skipped: ${skipped}`);
