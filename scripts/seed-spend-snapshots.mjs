/**
 * Seed MetricSnapshot from CampaignDailySpend.
 *
 * Aggregates all campaigns by date → upserts one MetricSnapshot row per day
 * for platform="google_ads", channel="paid_media".
 *
 * Fields populated:  spend, clicks, impressions, cpc, ctr
 *
 * Usage:  node scripts/seed-spend-snapshots.mjs
 */

import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const adapter = new PrismaLibSql({ url: "file:./dev.db" });
const prisma  = new PrismaClient({ adapter });

console.log("Aggregating CampaignDailySpend by date…");

// Group all campaign rows by date
const rows = await prisma.campaignDailySpend.groupBy({
  by: ["date"],
  _sum: {
    spend:       true,
    clicks:      true,
    impressions: true,
  },
  orderBy: { date: "asc" },
});

console.log(`Found ${rows.length} distinct dates to upsert.`);

let upserted = 0;
const BATCH = 100;

for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);

  await Promise.all(
    batch.map((row) => {
      const spend       = row._sum.spend       ?? 0;
      const clicks      = row._sum.clicks      ?? 0;
      const impressions = row._sum.impressions ?? 0;
      const cpc = clicks      > 0 ? spend / clicks           : null;
      const ctr = impressions > 0 ? clicks  / impressions    : null;

      return prisma.metricSnapshot.upsert({
        where: {
          date_platform_channel: {
            date:     row.date,
            platform: "google_ads",
            channel:  "paid_media",
          },
        },
        create: {
          date:        row.date,
          platform:    "google_ads",
          channel:     "paid_media",
          spend,
          clicks,
          impressions,
          cpc,
          ctr,
        },
        update: {
          spend,
          clicks,
          impressions,
          cpc,
          ctr,
        },
      }).then(() => upserted++);
    })
  );

  if ((i / BATCH) % 5 === 0) {
    process.stdout.write(`\r  Progress: ${upserted} / ${rows.length} days…`);
  }
}

console.log(`\n✓ ${upserted} MetricSnapshot rows upserted.`);

// Sanity check
const check = await prisma.metricSnapshot.aggregate({
  where: { platform: "google_ads", channel: "paid_media" },
  _sum:   { spend: true },
  _min:   { date: true },
  _max:   { date: true },
  _count: { id: true },
});

console.log(`  Rows in DB : ${check._count.id}`);
console.log(`  Date range : ${check._min.date?.toISOString().slice(0,10)} → ${check._max.date?.toISOString().slice(0,10)}`);
console.log(`  Total spend: $${(check._sum.spend ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

await prisma.$disconnect();
