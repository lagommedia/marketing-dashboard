/**
 * Seed CampaignDailySpend from a Google Ads campaign report CSV.
 *
 * Expected CSV format (UTF-16, tab-separated, exported from Google Ads):
 *   Row 1: "Campaign report"
 *   Row 2: date range header
 *   Row 3: column headers (Day, Campaign, Campaign ID, Cost, Clicks, Impr., …)
 *   Row 4+: data rows (one row per campaign per day)
 *   Trailing "Total:" rows are skipped automatically.
 *
 * Usage:  node scripts/seed-campaign-spend.mjs
 */

import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------
const adapter = new PrismaLibSql({ url: "file:./dev.db" });
const prisma  = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// Parse UTF-16 CSV
// ---------------------------------------------------------------------------
const CSV_PATH = "/Users/benashworth/Downloads/Campaign report (2).csv";

console.log("Reading CSV…");
const raw = fs.readFileSync(CSV_PATH);

// Decode UTF-16 LE (common Google Ads export format)
const text = raw.toString("utf16le");
const lines = text.split(/\r?\n/);

// Row 3 (index 2) = headers
const headers = lines[2].split("\t").map((h) => h.trim().replace(/^"|"$/g, ""));

const COL = {
  day:        headers.indexOf("Day"),
  campaignId: headers.indexOf("Campaign ID"),
  cost:       headers.indexOf("Cost"),
  clicks:     headers.indexOf("Clicks"),
  impressions: headers.indexOf("Impr."),
};

console.log("Column indices:", COL);

if (Object.values(COL).some((v) => v === -1)) {
  console.error("❌ Could not find required columns. Check CSV format.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse rows
// ---------------------------------------------------------------------------
function parseNum(s) {
  if (!s || s.trim() === "--" || s.trim() === "") return 0;
  return parseFloat(s.replace(/,/g, "")) || 0;
}

const rows = [];

for (let i = 3; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  const parts = line.split("\t").map((p) => p.trim().replace(/^"|"$/g, ""));

  const campaignId = parts[COL.campaignId] ?? "";
  // Skip total/summary rows (no numeric campaign ID)
  if (!campaignId || !/^\d+$/.test(campaignId)) continue;

  const dateStr = parts[COL.day] ?? "";
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

  const spend       = parseNum(parts[COL.cost]);
  const clicks      = Math.round(parseNum(parts[COL.clicks]));
  const impressions = Math.round(parseNum(parts[COL.impressions]));

  rows.push({ campaignId, dateStr, spend, clicks, impressions });
}

console.log(`Parsed ${rows.length.toLocaleString()} valid rows.`);

// ---------------------------------------------------------------------------
// Upsert in batches
// ---------------------------------------------------------------------------
const BATCH = 500;
let upserted = 0;
let skipped  = 0;

for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);

  await Promise.all(
    batch.map(({ campaignId, dateStr, spend, clicks, impressions }) => {
      const date = new Date(dateStr + "T00:00:00.000Z");
      return prisma.campaignDailySpend.upsert({
        where:  { campaignId_date: { campaignId, date } },
        create: { campaignId, date, spend, clicks, impressions },
        update: { spend, clicks, impressions },
      }).then(() => upserted++).catch(() => skipped++);
    })
  );

  if ((i / BATCH) % 10 === 0) {
    process.stdout.write(`\r  Progress: ${upserted.toLocaleString()} upserted…`);
  }
}

console.log(`\n✓ ${upserted.toLocaleString()} rows upserted, ${skipped} skipped.`);

// Quick sanity check
const count = await prisma.campaignDailySpend.count();
const total = await prisma.campaignDailySpend.aggregate({ _sum: { spend: true } });
console.log(`  DB now has ${count.toLocaleString()} campaign-day rows.`);
console.log(`  Total spend in DB: $${(total._sum.spend ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

await prisma.$disconnect();
