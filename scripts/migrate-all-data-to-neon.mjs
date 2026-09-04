/**
 * Full data migration: copies all historical data tables from local dev.db
 * into Neon PostgreSQL. Safe to re-run — uses ON CONFLICT DO NOTHING.
 *
 * Run with:
 *   node scripts/migrate-all-data-to-neon.mjs
 */

import { createClient } from "@libsql/client";
import pg from "pg";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Load .env
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

const dbUrl = envVars.DATABASE_URL_UNPOOLED ?? envVars.DATABASE_URL;
if (!dbUrl) { console.error("❌  DATABASE_URL not found in .env"); process.exit(1); }

const sqlite = createClient({ url: `file:${resolve(root, "dev.db")}` });
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

// Batch upsert helper
async function batchUpsert(table, rows, columns, conflictCols) {
  if (rows.length === 0) { console.log(`  ⟳  ${table}: 0 rows — skipped`); return; }

  const BATCH = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = [];
    const placeholders = chunk.map((row, ri) => {
      const start = ri * columns.length + 1;
      columns.forEach((col, ci) => values.push(row[col] ?? null));
      return `(${columns.map((_, ci) => `$${start + ci}`).join(",")})`;
    }).join(",");

    const quotedCols = columns.map(c => `"${c}"`).join(",");
    const conflict = conflictCols
      ? `ON CONFLICT (${conflictCols.map(c => `"${c}"`).join(",")}) DO NOTHING`
      : "ON CONFLICT DO NOTHING";

    await client.query(
      `INSERT INTO "${table}" (${quotedCols}) VALUES ${placeholders} ${conflict}`,
      values
    );
    inserted += chunk.length;
  }

  console.log(`  ✓  ${table}: ${inserted} rows`);
}

// ── MetricSnapshot ──────────────────────────────────────────────────────────
{
  const { rows } = await sqlite.execute(`SELECT * FROM MetricSnapshot`);
  await batchUpsert("MetricSnapshot", rows, [
    "id","date","platform","channel","impressions","clicks","sessions",
    "leads","mqls","sqos","opportunities","closedWon","spend","revenue",
    "pipeline","activePipeline","cpc","cpl","cpMql","cpSqo","paidCac",
    "mktgCac","ctr","leadToMql","mqlToSqo","sqoToClose","createdAt"
  ], ["date","platform","channel"]);
}

// ── PipelineQuarterSnapshot ─────────────────────────────────────────────────
{
  const { rows } = await sqlite.execute(`SELECT * FROM PipelineQuarterSnapshot`);
  await batchUpsert("PipelineQuarterSnapshot", rows, [
    "id","quarter","segment","amountAll","amountPaid","amountOrganic",
    "amountReferral","syncedAt"
  ], ["quarter","segment"]);
}

// ── CampaignDailySpend ──────────────────────────────────────────────────────
{
  const { rows } = await sqlite.execute(`SELECT * FROM CampaignDailySpend`);
  await batchUpsert("CampaignDailySpend", rows, [
    "id","campaignId","campaignName","date","spend","clicks","impressions",
    "conversions","conversionValue","ctr","cpc","createdAt","updatedAt"
  ], ["campaignId","date"]);
}

// ── GaOrganicSnapshot ───────────────────────────────────────────────────────
{
  const { rows } = await sqlite.execute(`SELECT * FROM GaOrganicSnapshot`);
  await batchUpsert("GaOrganicSnapshot", rows, [
    "id","date","pagePath","sessions","users","engagedSessions",
    "bounceRate","avgSessionSec","conversions","createdAt"
  ], ["date","pagePath"]);
}

// ── GscQuerySnapshot ────────────────────────────────────────────────────────
{
  const { rows } = await sqlite.execute(`SELECT * FROM GscQuerySnapshot`);
  await batchUpsert("GscQuerySnapshot", rows, [
    "id","date","query","clicks","impressions","ctr","position","createdAt"
  ], ["date","query"]);
}

// ── GscAiOverviewDay ────────────────────────────────────────────────────────
{
  const { rows } = await sqlite.execute(`SELECT * FROM GscAiOverviewDay`);
  await batchUpsert("GscAiOverviewDay", rows, [
    "id","date","clicks","impressions","ctr","createdAt"
  ], ["date"]);
}

// ── ReferenceSheetMonth ─────────────────────────────────────────────────────
{
  const { rows } = await sqlite.execute(`SELECT * FROM ReferenceSheetMonth`);
  await batchUpsert("ReferenceSheetMonth", rows, [
    "id","month","grossCosts","sharedAllocation","arpu","ltv",
    "grossMargin","churnRate","updatedAt"
  ], ["month"]);
}

// ── PacingTarget ────────────────────────────────────────────────────────────
{
  const { rows } = await sqlite.execute(`SELECT * FROM PacingTarget`);
  await batchUpsert("PacingTarget", rows, [
    "id","period","channel","targetMqls","targetSqos","targetPipeline",
    "targetClosedWon","targetRevenue","targetSpend","sharedAllocation",
    "createdAt","updatedAt"
  ], ["period","channel"]);
}

// ── AeoPillarScore ──────────────────────────────────────────────────────────
{
  const { rows } = await sqlite.execute(`SELECT * FROM AeoPillarScore`);
  await batchUpsert("AeoPillarScore", rows, [
    "id","pillarId","pageUrl","score","signals","fetchedAt"
  ], ["pillarId"]);
}

// ── AiMentionSnapshot ───────────────────────────────────────────────────────
{
  const { rows } = await sqlite.execute(`SELECT * FROM AiMentionSnapshot`);
  await batchUpsert("AiMentionSnapshot", rows, [
    "id","pillarId","query","engine","mentioned","citedUrls","syncedAt"
  ], ["pillarId","engine","query"]);
}

await client.end();
console.log("\n✅  Migration complete.");
