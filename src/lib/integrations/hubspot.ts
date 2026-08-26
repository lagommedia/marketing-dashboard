/**
 * HubSpot sync — channel-segmented
 *
 * Writes four MetricSnapshots per run:
 *   • paid_media — contacts: PAID_SEARCH + PAID_SOCIAL + 50% DIRECT_TRAFFIC
 *                  deals:    deal_source=Inbound, detail=Paid* + 50% Direct Traffic
 *   • organic    — contacts: EMAIL_MARKETING + ORGANIC_SEARCH + SOCIAL_MEDIA
 *                             + REFERRALS + OTHER_CAMPAIGNS + AI_REFERRALS + 50% DIRECT
 *                  deals:    deal_source=Inbound (organic detail) + deal_source=Events
 *   • referral   — deals only (no contact MQLs): deal_source=Referral
 *   • all        — sum of above (Direct already split, no double-counting)
 *
 * Deal channel hierarchy (two-tier):
 *   deal_source=Referral               → referral
 *   deal_source=Events                 → organic
 *   deal_source=Inbound + detail=Paid* → paid_media
 *   deal_source=Inbound + detail=Direct Traffic → 50/50 paid/organic
 *   deal_source=Inbound + any other detail → organic
 *   deal_source=Sales|Partnerships|Success|Service → ignored (not marketing)
 *
 * Contact channel hierarchy (hs_analytics_source):
 *   PAID_SEARCH | PAID_SOCIAL         → paid_media
 *   DIRECT_TRAFFIC                    → 50/50 paid/organic
 *   EMAIL_MARKETING | ORGANIC_SEARCH
 *   | SOCIAL_MEDIA | REFERRALS
 *   | OTHER_CAMPAIGNS | AI_REFERRALS  → organic
 *   OFFLINE                           → excluded (not marketing)
 *
 * Rate limits: 100 req/10s, 250k req/day — we are nowhere near these.
 */

import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { delay, withRetry } from "@/lib/sync/utils";
import { getCampaignNameMap } from "@/lib/integrations/google-ads";

const BASE = "https://api.hubapi.com";
const INTER_CALL_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Source → channel mapping constants
// ---------------------------------------------------------------------------

/** HubSpot hs_analytics_source values that belong to Paid Media */
const PAID_SOURCES = ["PAID_SEARCH", "PAID_SOCIAL"];

/** HubSpot hs_analytics_source value split 50/50 between Paid Media and Organic */
const DIRECT_SOURCE = "DIRECT_TRAFFIC";

/** HubSpot hs_analytics_source values that belong to Organic (OFFLINE excluded — not marketing) */
const ORGANIC_SOURCES = [
  "EMAIL_MARKETING",
  "ORGANIC_SEARCH",
  "SOCIAL_MEDIA",   // internal value = "SOCIAL_MEDIA", label = "Organic Social"
  "REFERRALS",      // referring domains → Organic
  "OTHER_CAMPAIGNS",
  "AI_REFERRALS",
];

// ---------------------------------------------------------------------------
// Deal attribution constants (two-tier: deal_source → deal_source_detail_1)
// ---------------------------------------------------------------------------

/** High-level deal source property (enumeration). Internal name confirmed: deal_source */
const DEAL_SOURCE_PROPERTY = "deal_source";

/** Deal source detail property (free-text). Internal name confirmed: deal_source_detail_1 */
const DEAL_SOURCE_DETAIL_PROPERTY = "deal_source_detail_1";

// deal_source values that are marketing-attributed
const DEAL_SOURCE_INBOUND  = "Inbound";   // sub-classify via deal_source_detail_1
const DEAL_SOURCE_EVENTS   = "Events";    // → Organic
const DEAL_SOURCE_REFERRAL = "Referral";  // → Referral (SQOs + Closed Won only, no MQLs)
// Sales | Partnerships | Success | Service → not marketing, ignored

// ---------------------------------------------------------------------------
// Deal stage constants (Sales Pipeline — id: "default")
// ---------------------------------------------------------------------------

/**
 * Deal stages that count as Active Pipeline (SQOs).
 * Only stages 1, 3, 4, 5 are included — stages 2 and 6 are excluded by design.
 *
 *   qualifiedtobuy       Sales 1: Demo Completed
 *   decisionmakerboughtin Sales 3: Progressing
 *   6181928              Sales 4: Ready to Purchase
 *   179383700            Sales 5: Quote Signed
 */
const ACTIVE_PIPELINE_STAGES = [
  "qualifiedtobuy",        // Sales 1: Demo Completed
  "decisionmakerboughtin", // Sales 3: Progressing
  "6181928",               // Sales 4: Ready to Purchase
  "179383700",             // Sales 5: Quote Signed
];

/** Deal stage ID for Closed Won (Sales 7) */
const CLOSED_WON_STAGE = "closedwon";

// When deal_source = "Inbound", use deal_source_detail_1 to sub-classify:
const DEAL_PAID_VALUES  = ["Paid Search", "Paid Social", "Paid Media"];
const DEAL_DIRECT_VALUE = "Direct Traffic"; // → 50/50 paid/organic

// ---------------------------------------------------------------------------
// Meeting type constants (SQO attribution via hs_activity_type)
// Only COMPLETED meetings with these types count as SQOs.
// ---------------------------------------------------------------------------

/** Completed meetings of these types → Organic SQOs */
const MEETING_TYPES_EVENTS: string[] = [
  "Zeni Overview - Events",
  "Zeni Overview - Events BDR",
  "Zeni Overview - Events AE",
  "Zeni Overview - Events Partnerships",
];

/** Completed meetings of these types → Referral SQOs */
const MEETING_TYPES_REFERRAL: string[] = [
  "Zeni Overview - Customer Referral",
  "Zeni Overview - Employee Referral",
  "Zeni Overview - Inbound VC Referral",
];

/**
 * Completed meetings of these types → channel determined by associated deal's
 * deal_source / deal_source_detail_1 (same two-tier logic as revenue).
 * Falls back to "organic" when no deal is linked.
 */
const MEETING_TYPES_INBOUND: string[] = [
  "Zeni Overview - Inbound",
  "Zeni Overview - Inbound Partnerships",
  "Partner: Inbound Consultation",
  "Inbound Follow Up",
  "Inbound Product Tour",
];

// ---------------------------------------------------------------------------
// Lifecycle stage values
// ---------------------------------------------------------------------------

const LIFECYCLE = {
  lead:        "lead",
  mql:         "marketingqualifiedlead",
  sal:         "114184284",          // Sales Accepted Lead (custom stage)
  sql:         "salesqualifiedlead",
  opportunity: "opportunity",
  sqd:         "161312014",          // Sales Qualified Deal (custom stage)
  customer:    "customer",
} as const;

/**
 * All lifecycle stage values that count as "at or above MQL".
 * Used in backfill to determine whether a contact's current stage
 * means they've been an MQL at some point.
 */
const MQL_OR_ABOVE = new Set([
  LIFECYCLE.mql,
  LIFECYCLE.sal,
  LIFECYCLE.sql,
  LIFECYCLE.opportunity,
  LIFECYCLE.sqd,
  LIFECYCLE.customer,
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DealRecord {
  amount:      number;
  source:      string | null;       // deal_source       (high-level: Inbound/Events/Referral/…)
  sourceDetail: string | null;      // deal_source_detail_1 (only meaningful when source=Inbound)
  dealtype:    string | null;       // "newbusiness" | "existingbusiness" | null
}

type DealChannel = "paid_media" | "organic" | "referral" | "direct";

interface ChannelMetrics {
  leads: number;
  mqls: number;
  sqos: number;
  closedWon: number;
  activePipeline: number; // current value of deals in stages 1,3,4,5 (point-in-time)
  newPipeline: number;    // value of deals created in the period (any stage)
  revenue: number;        // closed won value
}

// ---------------------------------------------------------------------------
// Company sync — fetches all HubSpot companies and upserts into DB
// ---------------------------------------------------------------------------

async function syncHubspotCompanies(token: string): Promise<number> {
  const COMPANY_PROPS = ["name", "domain", "website", "industry", "new_segment"];
  let after: string | undefined;
  let total = 0;

  do {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = { limit: 100, properties: COMPANY_PROPS };
    if (after) body.after = after;

    const res = await hubspotFetch(token, "POST", "/crm/v3/objects/companies/search", body);
    const results: { id: string; properties: Record<string, string | null> }[] = res.results ?? [];

    await Promise.all(
      results.map((c) =>
        prisma.hubspotCompany.upsert({
          where:  { id: c.id },
          update: {
            name:     c.properties.name    ?? null,
            domain:   c.properties.domain  ?? null,
            website:  c.properties.website ?? null,
            industry: c.properties.industry ?? null,
            segment:  c.properties.new_segment ?? null,
            syncedAt: new Date(),
          },
          create: {
            id:       c.id,
            name:     c.properties.name    ?? null,
            domain:   c.properties.domain  ?? null,
            website:  c.properties.website ?? null,
            industry: c.properties.industry ?? null,
            segment:  c.properties.new_segment ?? null,
          },
        })
      )
    );

    total += results.length;
    after  = res.paging?.next?.after ?? undefined;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  return total;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function syncHubspot(): Promise<{ recordsCount: number }> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.accessToken) throw new Error("HubSpot token not found");

  const token = decrypt(row.accessToken);

  const today = new Date();

  // All daily-sync queries use startOfDay(today) so each row is a true daily
  // delta. The dashboard sums rows across date ranges; cumulative lookbacks
  // would cause every metric to inflate proportionally to the range length.
  // Backfill writes the same way (per-day deltas) so they sum correctly.
  const sinceTs      = startOfDay(today).getTime(); // leads/MQLs/new pipeline: today only
  const closedSinceTs = sinceTs;                    // closed-won revenue: today only

  // ── Contact counts: 12 parallel queries (3 source groups × 4 stages) ──────
  const [
    paidLeads,   paidMqls,   paidSqls,   paidOpps,
    directLeads, directMqls, directSqls, directOpps,
    orgLeads,    orgMqls,    orgSqls,    orgOpps,
  ] = await withRetry(
    () => Promise.all([
      countContacts(token, LIFECYCLE.lead,        sinceTs, PAID_SOURCES),
      countContacts(token, LIFECYCLE.mql,         sinceTs, PAID_SOURCES),
      countContacts(token, LIFECYCLE.sql,         sinceTs, PAID_SOURCES),
      countContacts(token, LIFECYCLE.opportunity, sinceTs, PAID_SOURCES),

      countContacts(token, LIFECYCLE.lead,        sinceTs, [DIRECT_SOURCE]),
      countContacts(token, LIFECYCLE.mql,         sinceTs, [DIRECT_SOURCE]),
      countContacts(token, LIFECYCLE.sql,         sinceTs, [DIRECT_SOURCE]),
      countContacts(token, LIFECYCLE.opportunity, sinceTs, [DIRECT_SOURCE]),

      countContacts(token, LIFECYCLE.lead,        sinceTs, ORGANIC_SOURCES),
      countContacts(token, LIFECYCLE.mql,         sinceTs, ORGANIC_SOURCES),
      countContacts(token, LIFECYCLE.sql,         sinceTs, ORGANIC_SOURCES),
      countContacts(token, LIFECYCLE.opportunity, sinceTs, ORGANIC_SOURCES),
    ]),
    { label: "hubspot:contacts" }
  );

  await delay(INTER_CALL_DELAY_MS);

  // ── Deal fetches ───────────────────────────────────────────────────────────
  // Active pipeline: all deals currently in stages 1,3,4,5 (no date filter)
  const activePipelineDeals = await withRetry(
    () => fetchDeals(token, sinceTs, "active"),
    { label: "hubspot:active-pipeline" }
  );

  await delay(INTER_CALL_DELAY_MS);

  // New pipeline: all deals *created* in the window (any stage — counts as SQO + new pipeline value)
  const newPipelineDeals = await withRetry(
    () => fetchDeals(token, sinceTs, "new"),
    { label: "hubspot:new-pipeline" }
  );

  await delay(INTER_CALL_DELAY_MS);

  const closedWonDeals = await withRetry(
    () => fetchDeals(token, closedSinceTs, "closed"),
    { label: "hubspot:closed" }
  );

  // ── Apply 50/50 Direct split to contact counts ────────────────────────────
  const half = (n: number) => n * 0.5;

  const contactsByChannel = {
    paid_media: {
      leads: paidLeads + half(directLeads),
      mqls:  paidMqls  + half(directMqls),
      sqls:  paidSqls  + half(directSqls),
      opps:  paidOpps  + half(directOpps),
    },
    organic: {
      leads: orgLeads + half(directLeads),
      mqls:  orgMqls  + half(directMqls),
      sqls:  orgSqls  + half(directSqls),
      opps:  orgOpps  + half(directOpps),
    },
    // Referral has no contact-level MQLs — attribution is deal-only
    referral: { leads: 0, mqls: 0, sqls: 0, opps: 0 },
  };

  // ── Attribute deals to channels ────────────────────────────────────────────
  const activeTotals: Record<DealChannel, { activePipeline: number }> = {
    paid_media: { activePipeline: 0 },
    organic:    { activePipeline: 0 },
    referral:   { activePipeline: 0 },
    direct:     { activePipeline: 0 },
  };

  const newTotals: Record<DealChannel, { newPipeline: number }> = {
    paid_media: { newPipeline: 0 },
    organic:    { newPipeline: 0 },
    referral:   { newPipeline: 0 },
    direct:     { newPipeline: 0 },
  };

  const closedTotals: Record<DealChannel, { count: number; revenue: number }> = {
    paid_media: { count: 0, revenue: 0 },
    organic:    { count: 0, revenue: 0 },
    referral:   { count: 0, revenue: 0 },
    direct:     { count: 0, revenue: 0 },
  };

  for (const deal of activePipelineDeals) {
    const ch = getDealChannel(deal);
    if (!ch) continue;
    activeTotals[ch].activePipeline += deal.amount;
  }

  for (const deal of newPipelineDeals) {
    const ch = getDealChannel(deal);
    if (!ch) continue;
    newTotals[ch].newPipeline += deal.amount;
  }

  for (const deal of closedWonDeals) {
    const ch = getDealChannel(deal);
    if (!ch) continue;
    // Count only new business deals; revenue includes all closed won (new + cross-sell)
    if (deal.dealtype === "newbusiness") closedTotals[ch].count += 1;
    closedTotals[ch].revenue += deal.amount;
  }

  // ── Meeting-based SQOs ─────────────────────────────────────────────────────
  await delay(INTER_CALL_DELAY_MS);
  const sqoMeetingRecords = await withRetry(
    () => fetchSqoMeetings(token, sinceTs),
    { label: "hubspot:sqo-meetings" }
  );
  const sqoTotals: Record<DealChannel, number> = {
    paid_media: 0, organic: 0, referral: 0, direct: 0,
  };
  for (const sqo of sqoMeetingRecords) {
    sqoTotals[sqo.channel] += 1;
  }
  // Apply 50/50 Direct split to SQOs
  sqoTotals.paid_media += half(sqoTotals.direct);
  sqoTotals.organic    += half(sqoTotals.direct);

  // Apply 50/50 Direct split to all deal metric buckets
  for (const bucket of [activeTotals, newTotals, closedTotals] as const) {
    const d    = bucket.direct     as Record<string, number>;
    const paid = bucket.paid_media as Record<string, number>;
    const org  = bucket.organic    as Record<string, number>;
    for (const key of Object.keys(d)) {
      const v = d[key] ?? 0;
      paid[key] = (paid[key] ?? 0) + half(v);
      org[key]  = (org[key]  ?? 0) + half(v);
    }
  }

  // ── Build final per-channel metric objects ────────────────────────────────
  const channels: Record<"paid_media" | "organic" | "referral", ChannelMetrics> = {
    paid_media: {
      leads:          contactsByChannel.paid_media.leads,
      mqls:           contactsByChannel.paid_media.mqls,
      sqos:           sqoTotals.paid_media,
      activePipeline: activeTotals.paid_media.activePipeline,
      newPipeline:    newTotals.paid_media.newPipeline,
      closedWon:      closedTotals.paid_media.count,
      revenue:        closedTotals.paid_media.revenue,
    },
    organic: {
      leads:          contactsByChannel.organic.leads,
      mqls:           contactsByChannel.organic.mqls,
      sqos:           sqoTotals.organic,
      activePipeline: activeTotals.organic.activePipeline,
      newPipeline:    newTotals.organic.newPipeline,
      closedWon:      closedTotals.organic.count,
      revenue:        closedTotals.organic.revenue,
    },
    referral: {
      leads:          0,
      mqls:           0,
      sqos:           sqoTotals.referral,
      activePipeline: activeTotals.referral.activePipeline,
      newPipeline:    newTotals.referral.newPipeline,
      closedWon:      closedTotals.referral.count,
      revenue:        closedTotals.referral.revenue,
    },
  };

  // "all" = sum of channels (Direct already distributed, no double-counting)
  const allMetrics: ChannelMetrics = {
    leads:          channels.paid_media.leads          + channels.organic.leads,
    mqls:           channels.paid_media.mqls           + channels.organic.mqls,
    sqos:           sqoTotals.paid_media               + sqoTotals.organic               + sqoTotals.referral,
    activePipeline: channels.paid_media.activePipeline + channels.organic.activePipeline + channels.referral.activePipeline,
    newPipeline:    channels.paid_media.newPipeline    + channels.organic.newPipeline    + channels.referral.newPipeline,
    closedWon:      channels.paid_media.closedWon      + channels.organic.closedWon      + channels.referral.closedWon,
    revenue:        channels.paid_media.revenue        + channels.organic.revenue        + channels.referral.revenue,
  };

  // ── Persist snapshots ─────────────────────────────────────────────────────
  const dateKey = startOfDay(today);

  const snapshots: Array<["paid_media" | "organic" | "referral" | "all", ChannelMetrics]> = [
    ["paid_media", channels.paid_media],
    ["organic",    channels.organic],
    ["referral",   channels.referral],
    ["all",        allMetrics],
  ];

  for (const [channel, m] of snapshots) {
    const convRates = computeConversions(m);
    const data = {
      leads:         m.leads      || null,
      mqls:          m.mqls       || null,
      sqos:          m.sqos       || null,
      closedWon:     m.closedWon  || null,
      activePipeline: m.activePipeline || null,
      pipeline:       m.newPipeline   || null,
      revenue:       m.revenue    || null,
      ...convRates,
    };
    await prisma.metricSnapshot.upsert({
      where: { date_platform_channel: { date: dateKey, platform: "hubspot", channel } },
      create: { date: dateKey, platform: "hubspot", channel, ...data },
      update: data,
    });
  }

  const totalRecords =
    allMetrics.leads + allMetrics.mqls + allMetrics.sqos + allMetrics.closedWon;

  // Sync companies in the background — failures do not block the main sync
  try {
    await syncHubspotCompanies(token);
  } catch (err) {
    console.error("[hubspot] company sync failed (non-fatal):", err);
  }

  return { recordsCount: Math.round(totalRecords) };
}

// ---------------------------------------------------------------------------
// Channel attribution for a deal (two-tier: deal_source → deal_source_detail_1)
// ---------------------------------------------------------------------------

/**
 * Returns the marketing channel for a deal, or null if the deal is not
 * marketing-attributed (e.g. deal_source = Sales, Partnerships, Success, Service).
 *
 * Tier 1 — deal_source:
 *   "Referral"  → referral  (no further sub-classification)
 *   "Events"    → organic   (no further sub-classification)
 *   "Inbound"   → use deal_source_detail_1 for Tier 2
 *   anything else → null (not marketing)
 *
 * Tier 2 — deal_source_detail_1 (only when deal_source = "Inbound"):
 *   Paid Search | Paid Social | Paid Media → paid_media
 *   Direct Traffic                         → direct (split 50/50 downstream)
 *   anything else / blank                  → organic
 */
function getDealChannel(deal: DealRecord): DealChannel | null {
  const src = deal.source ?? "";

  if (src === DEAL_SOURCE_REFERRAL) return "referral";
  if (src === DEAL_SOURCE_EVENTS)   return "organic";

  if (src === DEAL_SOURCE_INBOUND) {
    const detail = deal.sourceDetail ?? "";
    if (DEAL_PAID_VALUES.includes(detail))  return "paid_media";
    if (detail === DEAL_DIRECT_VALUE)       return "direct";
    return "organic"; // any other Inbound detail (or blank) → organic
  }

  // Sales | Partnerships | Success | Service → not marketing
  return null;
}

// ---------------------------------------------------------------------------
// Conversion rate helpers
// ---------------------------------------------------------------------------

function computeConversions(m: ChannelMetrics) {
  return {
    leadToMql:  m.leads     > 0 ? m.mqls      / m.leads     : null,
    mqlToSqo:   m.mqls      > 0 ? m.sqos      / m.mqls      : null,
    sqoToClose: m.sqos      > 0 ? m.closedWon / m.sqos      : null,
  };
}

// ---------------------------------------------------------------------------
// Count contacts matching a lifecycle stage + source list
// Uses HubSpot CRM Search — returns `total` only (1 result page, limit: 1)
// ---------------------------------------------------------------------------

async function countContacts(
  token: string,
  lifecycleStage: string,
  sinceTimestamp: number,
  sources: string[]
): Promise<number> {
  const filters: HubspotFilter[] = [
    { propertyName: "lifecyclestage", operator: "EQ",  value: lifecycleStage },
    { propertyName: "createdate",     operator: "GTE", value: String(sinceTimestamp) },
    { propertyName: "hs_analytics_source", operator: "IN", values: sources },
  ];

  const res = await hubspotFetch(token, "POST", "/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters }],
    properties: ["lifecyclestage"],
    limit: 1,
  });

  return res.total ?? 0;
}

// ---------------------------------------------------------------------------
// Fetch all deals (pipeline or closed won), paginated
// Returns lightweight DealRecord array for in-app channel attribution
// ---------------------------------------------------------------------------

async function fetchDeals(
  token: string,
  sinceTimestamp: number,
  mode: "active" | "new" | "closed"
): Promise<DealRecord[]> {
  // active: all deals currently in stages 1,3,4,5 (no date filter — point-in-time)
  // new:    all deals created in the window (any stage — SQO count + new pipeline value)
  // closed: deals closed won in the window
  const filters =
    mode === "active"
      ? [{ propertyName: "dealstage",  operator: "IN",  values: ACTIVE_PIPELINE_STAGES    }]
      : mode === "new"
      ? [{ propertyName: "createdate", operator: "GTE", value: String(sinceTimestamp)      }]
      : [
          { propertyName: "dealstage",  operator: "EQ",  value: CLOSED_WON_STAGE           },
          { propertyName: "closedate",  operator: "GTE", value: String(sinceTimestamp)      },
        ];

  const results: DealRecord[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters }],
      properties: ["amount", "dealtype", DEAL_SOURCE_PROPERTY, DEAL_SOURCE_DETAIL_PROPERTY],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotFetch(token, "POST", "/crm/v3/objects/deals/search", body);

    for (const deal of res.results ?? []) {
      results.push({
        amount:       parseFloat(deal.properties?.amount ?? "0") || 0,
        source:       deal.properties?.[DEAL_SOURCE_PROPERTY]       ?? null,
        sourceDetail: deal.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? null,
        dealtype:     deal.properties?.dealtype ?? null,
      });
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  return results;
}

// ---------------------------------------------------------------------------
// Active pipeline breakdown (by stage × channel) — used by the drill-down modal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Active pipeline breakdown — by deal stage × channel (grouped bar)
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<string, string> = {
  qualifiedtobuy:        "Demo Completed",
  decisionmakerboughtin: "Progressing",
  "6181928":             "Ready to Purchase",
  "179383700":           "Quote Signed",
};

const STAGE_ORDER = [
  "qualifiedtobuy",
  "decisionmakerboughtin",
  "6181928",
  "179383700",
];

export interface PipelineStageRow {
  stageLabel: string;
  paid_media: number;
  organic:    number;
  referral:   number;
  total:      number;
}

export interface PipelineStageBreakdownResult {
  stages:  PipelineStageRow[];
  totals:  { paid_media: number; organic: number; referral: number; total: number };
}

export async function fetchActivePipelineBreakdown(): Promise<PipelineStageBreakdownResult> {
  const integration = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!integration?.accessToken) throw new Error("HubSpot not connected");
  const token = decrypt(integration.accessToken);

  const acc: Record<string, { paid_media: number; organic: number; referral: number }> = {};
  for (const id of ACTIVE_PIPELINE_STAGES) acc[id] = { paid_media: 0, organic: 0, referral: 0 };

  let after: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: [
        { propertyName: "dealstage",          operator: "IN",                values: ACTIVE_PIPELINE_STAGES },
        { propertyName: "pipeline",           operator: "EQ",                value: "default"               },
        { propertyName: "dealname",           operator: "NOT_CONTAINS_TOKEN", value: "SuperNova"             },
        { propertyName: DEAL_SOURCE_PROPERTY, operator: "IN",                values: ["Inbound", "Events", "Referral"] },
      ]}],
      properties: ["amount", "dealstage", DEAL_SOURCE_PROPERTY, DEAL_SOURCE_DETAIL_PROPERTY],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotFetch(token, "POST", "/crm/v3/objects/deals/search", body);
    for (const deal of res.results ?? []) {
      const stageId = deal.properties?.dealstage ?? "";
      const bucket  = acc[stageId];
      if (!bucket) continue;
      const d = {
        amount:       parseFloat(deal.properties?.amount ?? "0") || 0,
        source:       deal.properties?.[DEAL_SOURCE_PROPERTY]        ?? null,
        sourceDetail: deal.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? null,
        dealtype:     null,
      };
      const ch  = getDealChannel(d);
      const amt = d.amount;
      if (ch === "direct") { bucket.paid_media += amt * 0.5; bucket.organic += amt * 0.5; }
      else if (ch === "paid_media" || ch === "organic" || ch === "referral") bucket[ch] += amt;
      else bucket.organic += amt;
    }
    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  const stages: PipelineStageRow[] = STAGE_ORDER.map((id) => {
    const b = acc[id];
    return {
      stageLabel: STAGE_LABELS[id],
      paid_media: Math.round(b.paid_media),
      organic:    Math.round(b.organic),
      referral:   Math.round(b.referral),
      total:      Math.round(b.paid_media + b.organic + b.referral),
    };
  });

  const totals = stages.reduce(
    (a, s) => ({ paid_media: a.paid_media + s.paid_media, organic: a.organic + s.organic, referral: a.referral + s.referral, total: a.total + s.total }),
    { paid_media: 0, organic: 0, referral: 0, total: 0 }
  );

  return { stages, totals };
}

// ---------------------------------------------------------------------------
// Revenue by source — Paid Media sub-breakdown (Paid Search / Paid Social / Direct)
// Queries closed-won Inbound deals in a date range and splits by deal_source_detail_1
// ---------------------------------------------------------------------------

export interface RevenueBySourceResult {
  paid_search:  number;   // deal_source_detail_1 = "Paid Search" + 50% of Direct Traffic
  paid_social:  number;   // deal_source_detail_1 = "Paid Social" | "Paid Media" + 50% of Direct Traffic
  total:        number;   // sum of the above
}

export async function getRevenueBySource(from: string, to: string): Promise<RevenueBySourceResult> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.accessToken) throw new Error("HubSpot not connected");
  const token = decrypt(row.accessToken);

  const fromMs = new Date(from + "T00:00:00Z").getTime();
  const toMs   = new Date(to   + "T23:59:59").getTime();

  const result: RevenueBySourceResult = { paid_search: 0, paid_social: 0, total: 0 };
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "dealstage",           operator: "EQ",  value: CLOSED_WON_STAGE     },
          { propertyName: DEAL_SOURCE_PROPERTY,  operator: "EQ",  value: DEAL_SOURCE_INBOUND  },
          { propertyName: "closedate",           operator: "GTE", value: String(fromMs)        },
          { propertyName: "closedate",           operator: "LTE", value: String(toMs)          },
        ],
      }],
      properties: ["amount", DEAL_SOURCE_DETAIL_PROPERTY],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v3/objects/deals/search", body),
      { maxRetries: 4, baseDelayMs: 2000, label: "revenue-by-source" }
    );

    for (const deal of res.results ?? []) {
      const amount = parseFloat(deal.properties?.amount ?? "0") || 0;
      const detail = (deal.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? "").trim();

      if (detail === "Paid Search") {
        result.paid_search += amount;
      } else if (detail === "Paid Social" || detail === "Paid Media") {
        result.paid_social += amount;
      } else if (detail === DEAL_DIRECT_VALUE) {
        // Direct Traffic: 50% to paid, split evenly between Paid Search and Paid Social
        result.paid_search += amount * 0.25;
        result.paid_social += amount * 0.25;
      }
      // other Inbound sub-types → organic, excluded from paid breakdown
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  result.paid_search  = Math.round(result.paid_search);
  result.paid_social  = Math.round(result.paid_social);
  result.total        = result.paid_search + result.paid_social;
  return result;
}

// ---------------------------------------------------------------------------
// Revenue campaign breakdown — per deal, join contact utm_campaign → GA name
// Returns campaign-level revenue arrays for Paid Search and Paid Social
// ---------------------------------------------------------------------------

export interface CampaignRevenue {
  name:   string;
  amount: number;
  spend?: number;   // Google Ads spend for the period (if available)
  roas?:  number;   // amount / spend  (revenue metric only)
}

export interface RevenueCampaignBreakdownResult {
  paid_search: CampaignRevenue[];
  paid_social: CampaignRevenue[];
}

/** Chunks an array into groups of `size` */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function getRevenueCampaignBreakdown(
  from: string,
  to: string
): Promise<RevenueCampaignBreakdownResult> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.accessToken) throw new Error("HubSpot not connected");
  const token = decrypt(row.accessToken);

  const fromMs = new Date(from + "T00:00:00Z").getTime();
  const toMs   = new Date(to   + "T23:59:59").getTime();

  // ── Step 1: Fetch closed-won Inbound paid deals in range ──────────────────
  interface DealRow { id: string; amount: number; sourceDetail: string; }
  const deals: DealRow[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "dealstage",          operator: "EQ",  value: CLOSED_WON_STAGE    },
          { propertyName: DEAL_SOURCE_PROPERTY, operator: "EQ",  value: DEAL_SOURCE_INBOUND },
          { propertyName: "closedate",          operator: "GTE", value: String(fromMs)       },
          { propertyName: "closedate",          operator: "LTE", value: String(toMs)         },
        ],
      }],
      properties: ["amount", DEAL_SOURCE_DETAIL_PROPERTY],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v3/objects/deals/search", body),
      { maxRetries: 4, baseDelayMs: 2000, label: "campaign-breakdown:deals" }
    );

    for (const d of res.results ?? []) {
      const detail = (d.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? "").trim();
      // Only include deals that map to paid_media
      if ([...DEAL_PAID_VALUES, DEAL_DIRECT_VALUE].includes(detail)) {
        deals.push({
          id:           d.id,
          amount:       parseFloat(d.properties?.amount ?? "0") || 0,
          sourceDetail: detail,
        });
      }
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  if (deals.length === 0) return { paid_search: [], paid_social: [] };

  // ── Step 2: Batch-fetch deal → contact associations ──────────────────────
  const dealToContactId = new Map<string, string>();
  const dealIdChunks    = chunk(deals.map((d) => d.id), 100);

  for (const ids of dealIdChunks) {
    const assocRes = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v4/associations/deal/contact/batch/read", {
        inputs: ids.map((id) => ({ id })),
      }),
      { maxRetries: 3, baseDelayMs: 1000, label: "campaign-breakdown:assoc" }
    );
    for (const result of assocRes.results ?? []) {
      const fromId  = String(result.from?.id ?? "");
      const contact = result.to?.[0];
      if (fromId && contact) {
        dealToContactId.set(fromId, String(contact.toObjectId ?? contact.id ?? ""));
      }
    }
    await delay(INTER_CALL_DELAY_MS);
  }

  // ── Step 3: Batch-read contacts → utm_campaign ───────────────────────────
  const contactIds    = [...new Set(dealToContactId.values())].filter(Boolean);
  const contactUtmMap = new Map<string, string>(); // contactId → utm_campaign

  for (const ids of chunk(contactIds, 100)) {
    const contactRes = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v3/objects/contacts/batch/read", {
        inputs:     ids.map((id) => ({ id })),
        properties: ["utm_campaign"],
      }),
      { maxRetries: 3, baseDelayMs: 1000, label: "campaign-breakdown:contacts" }
    );
    for (const contact of contactRes.results ?? []) {
      const utm = contact.properties?.utm_campaign ?? null;
      if (utm) contactUtmMap.set(String(contact.id), utm);
    }
    await delay(INTER_CALL_DELAY_MS);
  }

  // ── Step 4: Resolve utm_campaign values → human-readable names ───────────
  // Falls back gracefully if Google Ads is not connected
  let nameMap = new Map<string, string>();
  try {
    nameMap = await getCampaignNameMap();
  } catch { /* Google Ads not connected — use raw utm_campaign values */ }

  const resolveName = (rawUtm: string | null): string => {
    if (!rawUtm) return "(Unattributed)";
    return nameMap.get(rawUtm) ?? rawUtm; // resolved name or raw value (e.g. "DC_Brand")
  };

  // ── Step 5: Accumulate revenue by (source × campaign name) ───────────────
  const paidSearchMap = new Map<string, number>();
  const paidSocialMap = new Map<string, number>();

  const addTo = (map: Map<string, number>, name: string, amount: number) =>
    map.set(name, (map.get(name) ?? 0) + amount);

  for (const deal of deals) {
    const contactId    = dealToContactId.get(deal.id);
    const rawUtm       = contactId ? (contactUtmMap.get(contactId) ?? null) : null;
    const campaignName = resolveName(rawUtm);

    if (deal.sourceDetail === "Paid Search") {
      addTo(paidSearchMap, campaignName, deal.amount);
    } else if (deal.sourceDetail === "Paid Social" || deal.sourceDetail === "Paid Media") {
      addTo(paidSocialMap, campaignName, deal.amount);
    } else if (deal.sourceDetail === DEAL_DIRECT_VALUE) {
      // 25% each to Paid Search and Paid Social (mirrors the top-level split)
      addTo(paidSearchMap, campaignName, deal.amount * 0.25);
      addTo(paidSocialMap, campaignName, deal.amount * 0.25);
    }
  }

  const toSorted = (map: Map<string, number>): CampaignRevenue[] => {
    const unattributed = map.get("(Unattributed)") ?? 0;
    const named = [...map.entries()].filter(([name]) => name !== "(Unattributed)");
    const perCampaign = named.length > 0 ? unattributed / named.length : 0;
    return named
      .map(([name, amount]) => ({ name, amount: Math.round(amount + perCampaign) }))
      .sort((a, b) => b.amount - a.amount);
  };

  const result = {
    paid_search: toSorted(paidSearchMap),
    paid_social: toSorted(paidSocialMap),
  };

  // ── Step 6: Enrich with Google Ads spend + ROAS ───────────────────────────
  await enrichWithSpend(result.paid_search, nameMap, from, to);
  await enrichWithSpend(result.paid_social, nameMap, from, to);

  return result;
}

/**
 * Looks up CampaignDailySpend for each campaign row and attaches spend + ROAS.
 * Silently skips if no spend data exists (e.g. campaign not in DB yet).
 */
async function enrichWithSpend(
  campaigns: CampaignRevenue[],
  nameMap: Map<string, string>,
  from: string,
  to: string
): Promise<void> {
  if (campaigns.length === 0) return;

  // Build reverse map: campaign name → campaignId
  const nameToId = new Map<string, string>();
  for (const [id, name] of nameMap) nameToId.set(name, id);

  const fromDate = new Date(from + "T00:00:00.000Z");
  const toDate   = new Date(to   + "T23:59:59.999Z");

  for (const row of campaigns) {
    const campaignId = nameToId.get(row.name);
    if (!campaignId) continue;

    const agg = await prisma.campaignDailySpend.aggregate({
      where: {
        campaignId,
        date: { gte: fromDate, lte: toDate },
      },
      _sum: { spend: true },
    });

    const spend = agg._sum.spend ?? 0;
    if (spend > 0) {
      row.spend = Math.round(spend);
      row.roas  = parseFloat((row.amount / spend).toFixed(2));
    }
  }
}

// ---------------------------------------------------------------------------
// Generic metric-by-source and campaign breakdown — delegates per metric
// ---------------------------------------------------------------------------

export type MetricSourceKey = "revenue" | "pipeline" | "closedWon" | "leads" | "mqls" | "sqos";

/**
 * Returns paid_search / paid_social / total split for any supported HubSpot metric.
 */
export async function getMetricBySource(
  metric: MetricSourceKey,
  from: string,
  to: string
): Promise<RevenueBySourceResult> {
  if (metric === "revenue") return getRevenueBySource(from, to);
  if (metric === "leads" || metric === "mqls") return getContactMetricBySource(metric, from, to);
  return getDealMetricBySource(metric, from, to);
}

/**
 * Returns campaign-level breakdown for any supported HubSpot metric.
 */
export async function getMetricCampaignBreakdown(
  metric: MetricSourceKey,
  from: string,
  to: string
): Promise<RevenueCampaignBreakdownResult> {
  if (metric === "revenue") return getRevenueCampaignBreakdown(from, to);
  if (metric === "leads" || metric === "mqls") return getContactCampaignBreakdown(metric, from, to);
  return getDealCampaignBreakdown(metric, from, to);
}

// ---------------------------------------------------------------------------
// getActivePipelineCampaignBreakdown — campaign breakdown for active pipeline
// ---------------------------------------------------------------------------

export async function getActivePipelineCampaignBreakdown(): Promise<RevenueCampaignBreakdownResult> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.accessToken) throw new Error("HubSpot not connected");
  const token = decrypt(row.accessToken);

  // ── Step 1: Fetch all deals currently in active pipeline stages ───────────
  interface DealRow { id: string; amount: number; sourceDetail: string; }
  const deals: DealRow[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "dealstage",          operator: "IN", values: ACTIVE_PIPELINE_STAGES },
          { propertyName: DEAL_SOURCE_PROPERTY, operator: "EQ", value: DEAL_SOURCE_INBOUND    },
        ],
      }],
      properties: ["amount", DEAL_SOURCE_DETAIL_PROPERTY],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v3/objects/deals/search", body),
      { maxRetries: 4, baseDelayMs: 2000, label: "active-pipeline-campaign-breakdown:deals" }
    );

    for (const d of res.results ?? []) {
      const detail = (d.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? "").trim();
      if ([...DEAL_PAID_VALUES, DEAL_DIRECT_VALUE].includes(detail)) {
        const amount = parseFloat(d.properties?.amount ?? "0") || 0;
        deals.push({ id: d.id, amount, sourceDetail: detail });
      }
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  if (deals.length === 0) return { paid_search: [], paid_social: [] };

  // ── Step 2: Batch-fetch deal → contact associations ──────────────────────
  const dealToContactId = new Map<string, string>();
  const dealIdChunks    = chunk(deals.map((d) => d.id), 100);

  for (const ids of dealIdChunks) {
    const assocRes = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v4/associations/deal/contact/batch/read", {
        inputs: ids.map((id) => ({ id })),
      }),
      { maxRetries: 3, baseDelayMs: 1000, label: "active-pipeline-campaign-breakdown:assoc" }
    );
    for (const result of assocRes.results ?? []) {
      const fromId  = String(result.from?.id ?? "");
      const contact = result.to?.[0];
      if (fromId && contact) {
        dealToContactId.set(fromId, String(contact.toObjectId ?? contact.id ?? ""));
      }
    }
    await delay(INTER_CALL_DELAY_MS);
  }

  // ── Step 3: Batch-read contacts → utm_campaign ───────────────────────────
  const contactIds    = [...new Set(dealToContactId.values())].filter(Boolean);
  const contactUtmMap = new Map<string, string>();

  for (const ids of chunk(contactIds, 100)) {
    const contactRes = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v3/objects/contacts/batch/read", {
        inputs:     ids.map((id) => ({ id })),
        properties: ["utm_campaign"],
      }),
      { maxRetries: 3, baseDelayMs: 1000, label: "active-pipeline-campaign-breakdown:contacts" }
    );
    for (const contact of contactRes.results ?? []) {
      const utm = contact.properties?.utm_campaign ?? null;
      if (utm) contactUtmMap.set(String(contact.id), utm);
    }
    await delay(INTER_CALL_DELAY_MS);
  }

  // ── Step 4: Resolve utm_campaign values → human-readable names ───────────
  let nameMap = new Map<string, string>();
  try {
    nameMap = await getCampaignNameMap();
  } catch { /* Google Ads not connected — use raw utm_campaign values */ }

  const resolveName = (rawUtm: string | null): string => {
    if (!rawUtm) return "(Unattributed)";
    return nameMap.get(rawUtm) ?? rawUtm;
  };

  // ── Step 5: Accumulate amount per campaign per source ─────────────────────
  const paidSearchMap = new Map<string, number>();
  const paidSocialMap = new Map<string, number>();

  const addTo = (map: Map<string, number>, name: string, amount: number) =>
    map.set(name, (map.get(name) ?? 0) + amount);

  for (const deal of deals) {
    const contactId    = dealToContactId.get(deal.id);
    const rawUtm       = contactId ? (contactUtmMap.get(contactId) ?? null) : null;
    const campaignName = resolveName(rawUtm);

    if (deal.sourceDetail === "Paid Search") {
      addTo(paidSearchMap, campaignName, deal.amount);
    } else if (deal.sourceDetail === "Paid Social" || deal.sourceDetail === "Paid Media") {
      addTo(paidSocialMap, campaignName, deal.amount);
    } else if (deal.sourceDetail === DEAL_DIRECT_VALUE) {
      addTo(paidSearchMap, campaignName, deal.amount * 0.25);
      addTo(paidSocialMap, campaignName, deal.amount * 0.25);
    }
  }

  // ── Step 6: Spread unattributed evenly, return sorted arrays ─────────────
  const toSorted = (map: Map<string, number>): CampaignRevenue[] => {
    const unattributed = map.get("(Unattributed)") ?? 0;
    const named = [...map.entries()].filter(([name]) => name !== "(Unattributed)");
    const perCampaign = named.length > 0 ? unattributed / named.length : 0;
    return named
      .map(([name, amount]) => ({ name, amount: Math.round(amount + perCampaign) }))
      .sort((a, b) => b.amount - a.amount);
  };

  return {
    paid_search: toSorted(paidSearchMap),
    paid_social: toSorted(paidSocialMap),
  };
}

// ---------------------------------------------------------------------------
// getDealMetricBySource — paid_search / paid_social split for deal metrics
// ---------------------------------------------------------------------------

async function getDealMetricBySource(
  metric: "pipeline" | "closedWon" | "sqos",
  from: string,
  to: string
): Promise<RevenueBySourceResult> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.accessToken) throw new Error("HubSpot not connected");
  const token = decrypt(row.accessToken);

  const fromMs = new Date(from + "T00:00:00Z").getTime();
  const toMs   = new Date(to   + "T23:59:59").getTime();

  // Build filters based on metric
  const filters =
    metric === "closedWon"
      ? [
          { propertyName: "dealstage",          operator: "EQ",  value: CLOSED_WON_STAGE    },
          { propertyName: DEAL_SOURCE_PROPERTY,  operator: "EQ",  value: DEAL_SOURCE_INBOUND },
          { propertyName: "closedate",           operator: "GTE", value: String(fromMs)       },
          { propertyName: "closedate",           operator: "LTE", value: String(toMs)         },
        ]
      : [
          // pipeline and sqos: deals created in range
          { propertyName: DEAL_SOURCE_PROPERTY,  operator: "EQ",  value: DEAL_SOURCE_INBOUND },
          { propertyName: "createdate",          operator: "GTE", value: String(fromMs)       },
          { propertyName: "createdate",          operator: "LTE", value: String(toMs)         },
        ];

  const result: RevenueBySourceResult = { paid_search: 0, paid_social: 0, total: 0 };
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters }],
      properties: ["amount", DEAL_SOURCE_DETAIL_PROPERTY],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v3/objects/deals/search", body),
      { maxRetries: 4, baseDelayMs: 2000, label: `deal-metric-by-source:${metric}` }
    );

    for (const deal of res.results ?? []) {
      // Value per deal: amount for pipeline, 1 for closedWon/sqos
      const amount = parseFloat(deal.properties?.amount ?? "0") || 0;
      const value  = metric === "pipeline" ? amount : 1;
      const detail = (deal.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? "").trim();

      if (detail === "Paid Search") {
        result.paid_search += value;
      } else if (detail === "Paid Social" || detail === "Paid Media") {
        result.paid_social += value;
      } else if (detail === DEAL_DIRECT_VALUE) {
        result.paid_search += value * 0.25;
        result.paid_social += value * 0.25;
      }
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  result.paid_search  = metric === "pipeline" ? Math.round(result.paid_search) : result.paid_search;
  result.paid_social  = metric === "pipeline" ? Math.round(result.paid_social) : result.paid_social;
  result.total        = result.paid_search + result.paid_social;
  return result;
}

// ---------------------------------------------------------------------------
// getContactMetricBySource — paid_search / paid_social split for contact metrics
// ---------------------------------------------------------------------------

async function getContactMetricBySource(
  metric: "leads" | "mqls",
  from: string,
  to: string
): Promise<RevenueBySourceResult> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.accessToken) throw new Error("HubSpot not connected");
  const token = decrypt(row.accessToken);

  const fromMs = new Date(from + "T00:00:00Z").getTime();
  const toMs   = new Date(to   + "T23:59:59").getTime();

  const lifecycleStage = metric === "leads" ? LIFECYCLE.lead : LIFECYCLE.mql;

  const result: RevenueBySourceResult = { paid_search: 0, paid_social: 0, total: 0 };
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "lifecyclestage",    operator: "EQ",  value: lifecycleStage         },
          { propertyName: "createdate",        operator: "GTE", value: String(fromMs)          },
          { propertyName: "createdate",        operator: "LTE", value: String(toMs)            },
          { propertyName: "hs_analytics_source", operator: "IN", values: [...PAID_SOURCES, DIRECT_SOURCE] },
        ],
      }],
      properties: ["hs_analytics_source"],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v3/objects/contacts/search", body),
      { maxRetries: 4, baseDelayMs: 2000, label: `contact-metric-by-source:${metric}` }
    );

    for (const contact of res.results ?? []) {
      const src = (contact.properties?.hs_analytics_source ?? "").trim();
      if (src === "PAID_SEARCH") {
        result.paid_search += 1;
      } else if (src === "PAID_SOCIAL") {
        result.paid_social += 1;
      } else if (src === DIRECT_SOURCE) {
        result.paid_search += 0.5;
        result.paid_social += 0.5;
      }
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  result.total = result.paid_search + result.paid_social;
  return result;
}

// ---------------------------------------------------------------------------
// getDealCampaignBreakdown — campaign breakdown for deal metrics
// ---------------------------------------------------------------------------

async function getDealCampaignBreakdown(
  metric: "pipeline" | "closedWon" | "sqos",
  from: string,
  to: string
): Promise<RevenueCampaignBreakdownResult> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.accessToken) throw new Error("HubSpot not connected");
  const token = decrypt(row.accessToken);

  const fromMs = new Date(from + "T00:00:00Z").getTime();
  const toMs   = new Date(to   + "T23:59:59").getTime();

  // ── Step 1: Fetch deals in range ──────────────────────────────────────────
  interface DealRow { id: string; value: number; sourceDetail: string; }
  const deals: DealRow[] = [];
  let after: string | undefined;

  const filters =
    metric === "closedWon"
      ? [
          { propertyName: "dealstage",          operator: "EQ",  value: CLOSED_WON_STAGE    },
          { propertyName: DEAL_SOURCE_PROPERTY,  operator: "EQ",  value: DEAL_SOURCE_INBOUND },
          { propertyName: "closedate",           operator: "GTE", value: String(fromMs)       },
          { propertyName: "closedate",           operator: "LTE", value: String(toMs)         },
        ]
      : [
          { propertyName: DEAL_SOURCE_PROPERTY,  operator: "EQ",  value: DEAL_SOURCE_INBOUND },
          { propertyName: "createdate",          operator: "GTE", value: String(fromMs)       },
          { propertyName: "createdate",          operator: "LTE", value: String(toMs)         },
        ];

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters }],
      properties: ["amount", DEAL_SOURCE_DETAIL_PROPERTY],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v3/objects/deals/search", body),
      { maxRetries: 4, baseDelayMs: 2000, label: `deal-campaign-breakdown:${metric}:deals` }
    );

    for (const d of res.results ?? []) {
      const detail = (d.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? "").trim();
      if ([...DEAL_PAID_VALUES, DEAL_DIRECT_VALUE].includes(detail)) {
        const amount = parseFloat(d.properties?.amount ?? "0") || 0;
        const value  = metric === "pipeline" ? amount : 1;
        deals.push({ id: d.id, value, sourceDetail: detail });
      }
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  if (deals.length === 0) return { paid_search: [], paid_social: [] };

  // ── Step 2: Batch-fetch deal → contact associations ──────────────────────
  const dealToContactId = new Map<string, string>();
  const dealIdChunks    = chunk(deals.map((d) => d.id), 100);

  for (const ids of dealIdChunks) {
    const assocRes = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v4/associations/deal/contact/batch/read", {
        inputs: ids.map((id) => ({ id })),
      }),
      { maxRetries: 3, baseDelayMs: 1000, label: `deal-campaign-breakdown:${metric}:assoc` }
    );
    for (const result of assocRes.results ?? []) {
      const fromId  = String(result.from?.id ?? "");
      const contact = result.to?.[0];
      if (fromId && contact) {
        dealToContactId.set(fromId, String(contact.toObjectId ?? contact.id ?? ""));
      }
    }
    await delay(INTER_CALL_DELAY_MS);
  }

  // ── Step 3: Batch-read contacts → utm_campaign ───────────────────────────
  const contactIds    = [...new Set(dealToContactId.values())].filter(Boolean);
  const contactUtmMap = new Map<string, string>();

  for (const ids of chunk(contactIds, 100)) {
    const contactRes = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v3/objects/contacts/batch/read", {
        inputs:     ids.map((id) => ({ id })),
        properties: ["utm_campaign"],
      }),
      { maxRetries: 3, baseDelayMs: 1000, label: `deal-campaign-breakdown:${metric}:contacts` }
    );
    for (const contact of contactRes.results ?? []) {
      const utm = contact.properties?.utm_campaign ?? null;
      if (utm) contactUtmMap.set(String(contact.id), utm);
    }
    await delay(INTER_CALL_DELAY_MS);
  }

  // ── Step 4: Resolve utm_campaign values → human-readable names ───────────
  let nameMap = new Map<string, string>();
  try {
    nameMap = await getCampaignNameMap();
  } catch { /* Google Ads not connected — use raw utm_campaign values */ }

  const resolveName = (rawUtm: string | null): string => {
    if (!rawUtm) return "(Unattributed)";
    return nameMap.get(rawUtm) ?? rawUtm;
  };

  // ── Step 5: Accumulate by (source × campaign name) ───────────────────────
  const paidSearchMap = new Map<string, number>();
  const paidSocialMap = new Map<string, number>();

  const addTo = (map: Map<string, number>, name: string, amount: number) =>
    map.set(name, (map.get(name) ?? 0) + amount);

  for (const deal of deals) {
    const contactId    = dealToContactId.get(deal.id);
    const rawUtm       = contactId ? (contactUtmMap.get(contactId) ?? null) : null;
    const campaignName = resolveName(rawUtm);

    if (deal.sourceDetail === "Paid Search") {
      addTo(paidSearchMap, campaignName, deal.value);
    } else if (deal.sourceDetail === "Paid Social" || deal.sourceDetail === "Paid Media") {
      addTo(paidSocialMap, campaignName, deal.value);
    } else if (deal.sourceDetail === DEAL_DIRECT_VALUE) {
      addTo(paidSearchMap, campaignName, deal.value * 0.25);
      addTo(paidSocialMap, campaignName, deal.value * 0.25);
    }
  }

  const toSortedDeals = (map: Map<string, number>): CampaignRevenue[] => {
    const unattributed = map.get("(Unattributed)") ?? 0;
    const named = [...map.entries()].filter(([name]) => name !== "(Unattributed)");
    const perCampaign = named.length > 0 ? unattributed / named.length : 0;
    return named
      .map(([name, amount]) => ({ name, amount: Math.round(amount + perCampaign) }))
      .sort((a, b) => b.amount - a.amount);
  };

  return {
    paid_search: toSortedDeals(paidSearchMap),
    paid_social: toSortedDeals(paidSocialMap),
  };
}

// ---------------------------------------------------------------------------
// getContactCampaignBreakdown — campaign breakdown for contact metrics
// ---------------------------------------------------------------------------

async function getContactCampaignBreakdown(
  metric: "leads" | "mqls",
  from: string,
  to: string
): Promise<RevenueCampaignBreakdownResult> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.accessToken) throw new Error("HubSpot not connected");
  const token = decrypt(row.accessToken);

  const fromMs = new Date(from + "T00:00:00Z").getTime();
  const toMs   = new Date(to   + "T23:59:59").getTime();

  const lifecycleStage = metric === "leads" ? LIFECYCLE.lead : LIFECYCLE.mql;

  // ── Fetch all contacts with utm_campaign + hs_analytics_source ───────────
  const paidSearchMap = new Map<string, number>();
  const paidSocialMap = new Map<string, number>();

  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "lifecyclestage",    operator: "EQ",  value: lifecycleStage         },
          { propertyName: "createdate",        operator: "GTE", value: String(fromMs)          },
          { propertyName: "createdate",        operator: "LTE", value: String(toMs)            },
          { propertyName: "hs_analytics_source", operator: "IN", values: [...PAID_SOURCES, DIRECT_SOURCE] },
        ],
      }],
      properties: ["utm_campaign", "hs_analytics_source"],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await withRetry(
      () => hubspotFetch(token, "POST", "/crm/v3/objects/contacts/search", body),
      { maxRetries: 4, baseDelayMs: 2000, label: `contact-campaign-breakdown:${metric}` }
    );

    for (const contact of res.results ?? []) {
      const src    = (contact.properties?.hs_analytics_source ?? "").trim();
      const rawUtm = contact.properties?.utm_campaign ?? null;
      // Will be resolved to a name after fetching nameMap — store raw for now
      // We collect raw values in a temporary structure and resolve below
      // (We'll accumulate directly using raw utm and resolve names post-loop)
      if (src === "PAID_SEARCH") {
        const key = rawUtm ?? "(Unattributed)";
        paidSearchMap.set(key, (paidSearchMap.get(key) ?? 0) + 1);
      } else if (src === "PAID_SOCIAL") {
        const key = rawUtm ?? "(Unattributed)";
        paidSocialMap.set(key, (paidSocialMap.get(key) ?? 0) + 1);
      } else if (src === DIRECT_SOURCE) {
        const key = rawUtm ?? "(Unattributed)";
        paidSearchMap.set(key, (paidSearchMap.get(key) ?? 0) + 0.5);
        paidSocialMap.set(key, (paidSocialMap.get(key) ?? 0) + 0.5);
      }
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  // ── Resolve utm_campaign raw values → human-readable names ───────────────
  let nameMap = new Map<string, string>();
  try {
    nameMap = await getCampaignNameMap();
  } catch { /* Google Ads not connected — use raw values */ }

  // Remap keys through nameMap
  function remapKeys(map: Map<string, number>): Map<string, number> {
    const out = new Map<string, number>();
    for (const [rawKey, count] of map.entries()) {
      const resolvedKey = rawKey === "(Unattributed)"
        ? "(Unattributed)"
        : (nameMap.get(rawKey) ?? rawKey);
      out.set(resolvedKey, (out.get(resolvedKey) ?? 0) + count);
    }
    return out;
  }

  const resolvedSearchMap = remapKeys(paidSearchMap);
  const resolvedSocialMap = remapKeys(paidSocialMap);

  const toSortedContacts = (map: Map<string, number>): CampaignRevenue[] => {
    const unattributed = map.get("(Unattributed)") ?? 0;
    const named = [...map.entries()].filter(([name]) => name !== "(Unattributed)");
    const perCampaign = named.length > 0 ? unattributed / named.length : 0;
    return named
      .map(([name, amount]) => ({ name, amount: Math.round(amount + perCampaign) }))
      .sort((a, b) => b.amount - a.amount);
  };

  return {
    paid_search: toSortedContacts(resolvedSearchMap),
    paid_social: toSortedContacts(resolvedSocialMap),
  };
}

// ---------------------------------------------------------------------------
// New pipeline breakdown — by channel × customer_segment (stacked bar)
// ---------------------------------------------------------------------------

const COMPANY_SEGMENT_PROPERTY = "new_segment";
const SEGMENTS = ["Starter", "Growth", "Enterprise", "Discovery"] as const;
export type Segment = typeof SEGMENTS[number];

export interface PipelineQuarterRow {
  quarter:    string;   // "Q2 2026"
  Starter:    number;
  Growth:     number;
  Enterprise: number;
  Discovery:  number;
  Other:      number;
  total:      number;
}

export interface PipelineBreakdownResult {
  byQuarter:  PipelineQuarterRow[];
  bySegment:  { segment: string; total: number }[];
  grandTotal: number;
}

type RawDeal = {
  id:          string;
  amount:      number;
  createdate:  string;  // ISO date string
  segment:     string;  // new_segment from associated company (may be empty)
  source:      string | null;
  sourceDetail: string | null;
};

function normalizeSegment(raw: string): string {
  const n = raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : "";
  return (SEGMENTS as readonly string[]).includes(n) ? n : "Other";
}

function dealQuarterLabel(isoDate: string): string {
  const d = new Date(isoDate);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} ${d.getUTCFullYear()}`;
}

function accumulateBreakdown(deals: RawDeal[], channelFilter?: string): PipelineBreakdownResult {
  const ALL_SEGS = [...SEGMENTS, "Other"] as const;
  const byQuarterAcc = new Map<string, Record<string, number>>();

  for (const deal of deals) {
    const ch  = getDealChannel({ amount: deal.amount, source: deal.source, sourceDetail: deal.sourceDetail, dealtype: null });
    const seg = normalizeSegment(deal.segment);
    const quarter = dealQuarterLabel(deal.createdate);

    // Determine contribution amount for this deal toward the requested channel
    let amt = 0;
    if (!channelFilter || channelFilter === "all") {
      amt = deal.amount; // include everything
    } else if (ch === "direct") {
      // Direct splits 50/50 between paid_media and organic
      if (channelFilter === "paid_media" || channelFilter === "organic") amt = deal.amount * 0.5;
    } else if (ch === channelFilter) {
      amt = deal.amount;
    }
    if (amt === 0) continue;

    if (!byQuarterAcc.has(quarter)) {
      byQuarterAcc.set(quarter, Object.fromEntries(ALL_SEGS.map((s) => [s, 0])));
    }
    byQuarterAcc.get(quarter)![seg] += amt;
  }

  // Sort quarters chronologically
  const sortedQuarters = [...byQuarterAcc.keys()].sort((a, b) => {
    const [qa, ya] = a.split(" ");
    const [qb, yb] = b.split(" ");
    return Number(ya) - Number(yb) || Number(qa.slice(1)) - Number(qb.slice(1));
  });

  const byQuarter: PipelineQuarterRow[] = sortedQuarters.map((quarter) => {
    const b = byQuarterAcc.get(quarter)!;
    return {
      quarter,
      Starter:    Math.round(b.Starter),
      Growth:     Math.round(b.Growth),
      Enterprise: Math.round(b.Enterprise),
      Discovery:  Math.round(b.Discovery),
      Other:      Math.round(b.Other),
      total:      Math.round(ALL_SEGS.reduce((s, seg) => s + b[seg], 0)),
    };
  });

  const segTotals = ALL_SEGS.map((seg) => ({
    segment: seg,
    total: Math.round(byQuarter.reduce((s, r) => s + (r[seg as keyof PipelineQuarterRow] as number), 0)),
  }));

  const grandTotal = byQuarter.reduce((s, r) => s + r.total, 0);
  return { byQuarter, bySegment: segTotals, grandTotal };
}

async function fetchPipelineDeals(
  token: string,
  filters: Record<string, unknown>[]
): Promise<RawDeal[]> {
  // Step 1 — search deals (search API does not support inline associations)
  const rawDeals: { id: string; amount: number; createdate: string; source: string | null; sourceDetail: string | null }[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: [
        ...filters,
        // Only Sales Pipeline deals
        { propertyName: "pipeline", operator: "EQ", value: "default" },
        // Exclude SuperNova test deals
        { propertyName: "dealname", operator: "NOT_CONTAINS_TOKEN", value: "SuperNova" },
        // Only marketing-sourced deals (matches HubSpot report filter)
        { propertyName: DEAL_SOURCE_PROPERTY, operator: "IN", values: ["Inbound", "Events", "Referral"] },
      ]}],
      properties: ["amount", "createdate", DEAL_SOURCE_PROPERTY, DEAL_SOURCE_DETAIL_PROPERTY],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotFetch(token, "POST", "/crm/v3/objects/deals/search", body);
    for (const deal of res.results ?? []) {
      rawDeals.push({
        id:           deal.id,
        amount:       parseFloat(deal.properties?.amount ?? "0") || 0,
        createdate:   deal.properties?.createdate ?? "",
        source:       deal.properties?.[DEAL_SOURCE_PROPERTY]        ?? null,
        sourceDetail: deal.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? null,
      });
    }
    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  if (rawDeals.length === 0) return [];

  // Step 2 — batch-fetch deal→company associations using v4 associations API
  const companyIdsByDeal = new Map<string, string[]>();
  const dealIds = rawDeals.map((d) => d.id);

  for (let i = 0; i < dealIds.length; i += 100) {
    const chunk = dealIds.slice(i, i + 100);
    const res = await hubspotFetch(token, "POST", "/crm/v4/associations/deal/company/batch/read", {
      inputs: chunk.map((id) => ({ id })),
    });
    for (const result of res.results ?? []) {
      const dealId = result.from?.id;
      const companyIds = (result.to ?? []).map((t: { toObjectId: string }) => String(t.toObjectId));
      if (dealId && companyIds.length > 0) {
        companyIdsByDeal.set(String(dealId), companyIds);
      }
    }
    if (i + 100 < dealIds.length) await delay(INTER_CALL_DELAY_MS);
  }

  // Step 3 — batch-read new_segment from unique company IDs
  const allCompanyIds = [...new Set([...companyIdsByDeal.values()].flat())];
  const segmentByCompany = new Map<string, string>();

  for (let i = 0; i < allCompanyIds.length; i += 100) {
    const chunk = allCompanyIds.slice(i, i + 100);
    const res = await hubspotFetch(token, "POST", "/crm/v3/objects/companies/batch/read", {
      inputs:     chunk.map((id) => ({ id })),
      properties: [COMPANY_SEGMENT_PROPERTY],
    });
    for (const company of res.results ?? []) {
      const seg = company.properties?.[COMPANY_SEGMENT_PROPERTY] ?? "";
      if (seg) segmentByCompany.set(String(company.id), seg);
    }
    if (i + 100 < allCompanyIds.length) await delay(INTER_CALL_DELAY_MS);
  }

  // Step 4 — join segment back onto each deal
  return rawDeals.map((d) => ({
    id:           d.id,
    amount:       d.amount,
    createdate:   d.createdate,
    source:       d.source,
    sourceDetail: d.sourceDetail,
    segment:      (companyIdsByDeal.get(d.id) ?? [])
                    .map((cid) => segmentByCompany.get(cid) ?? "")
                    .find((s) => s) ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Quarter cache helpers
// ---------------------------------------------------------------------------

/** Parse "Q2 2025" → Date at start of that quarter */
function quarterLabelToDate(label: string): Date {
  const [q, yr] = label.split(" ");
  return new Date(Number(yr), (Number(q.slice(1)) - 1) * 3, 1);
}

/** Comparator: sort quarter labels chronologically */
function compareQuarterLabels(a: string, b: string): number {
  return quarterLabelToDate(a).getTime() - quarterLabelToDate(b).getTime();
}

interface QuarterRange {
  label:     string;   // "Q2 2025"
  qFrom:     Date;     // clamped start date
  qTo:       Date;     // clamped end date
  isCurrent: boolean;  // true = still accumulating, never cache
}

/** Split a [from, to] range into per-quarter slices */
function getQuartersInRange(from: Date, to: Date): QuarterRange[] {
  const now = new Date();
  const curYear = now.getFullYear();
  const curQ    = Math.floor(now.getMonth() / 3);

  const result: QuarterRange[] = [];
  let yr = from.getFullYear();
  let q  = Math.floor(from.getMonth() / 3);

  while (true) {
    const qStart = new Date(yr, q * 3, 1);
    if (qStart > to) break;

    const qEnd  = new Date(yr, q * 3 + 3, 0);       // last day of this quarter
    const slice: QuarterRange = {
      label:     `Q${q + 1} ${yr}`,
      qFrom:     qStart < from ? from : qStart,
      qTo:       qEnd   > to   ? to   : qEnd,
      isCurrent: yr === curYear && q === curQ,
    };
    result.push(slice);

    q++;
    if (q > 3) { q = 0; yr++; }
  }

  return result;
}

/** Compute per-channel amounts for a set of deals and upsert into the cache table */
async function writeQuarterCache(quarter: string, deals: RawDeal[]): Promise<void> {
  const ALL_SEGS = [...SEGMENTS, "Other"] as const;
  type Acc = { all: number; paid: number; organic: number; referral: number };
  const acc: Record<string, Acc> = Object.fromEntries(
    ALL_SEGS.map((s) => [s, { all: 0, paid: 0, organic: 0, referral: 0 }])
  );

  for (const deal of deals) {
    const ch  = getDealChannel({ amount: deal.amount, source: deal.source, sourceDetail: deal.sourceDetail, dealtype: null });
    const seg = normalizeSegment(deal.segment);

    acc[seg].all += deal.amount;
    if (ch === "direct") {
      acc[seg].paid    += deal.amount * 0.5;
      acc[seg].organic += deal.amount * 0.5;
    } else if (ch === "paid_media") {
      acc[seg].paid     += deal.amount;
    } else if (ch === "organic") {
      acc[seg].organic  += deal.amount;
    } else if (ch === "referral") {
      acc[seg].referral += deal.amount;
    }
  }

  for (const seg of ALL_SEGS) {
    const { all, paid, organic, referral } = acc[seg];
    await prisma.pipelineQuarterSnapshot.upsert({
      where:  { quarter_segment: { quarter, segment: seg } },
      create: { quarter, segment: seg, amountAll: all, amountPaid: paid, amountOrganic: organic, amountReferral: referral },
      update: { amountAll: all, amountPaid: paid, amountOrganic: organic, amountReferral: referral, syncedAt: new Date() },
    });
  }
}

type CacheRow = {
  quarter: string; segment: string;
  amountAll: number; amountPaid: number; amountOrganic: number; amountReferral: number;
};

/** Pick the right amount column based on the requested channel */
function cacheRowAmount(row: CacheRow, channelFilter?: string): number {
  if (!channelFilter || channelFilter === "all") return row.amountAll;
  if (channelFilter === "paid_media")            return row.amountPaid;
  if (channelFilter === "organic")               return row.amountOrganic;
  if (channelFilter === "referral")              return row.amountReferral;
  return row.amountAll;
}

/** Assemble a PipelineBreakdownResult from cached DB rows */
function assembleFromCacheRows(rows: CacheRow[], channelFilter?: string): PipelineBreakdownResult {
  const ALL_SEGS = [...SEGMENTS, "Other"] as const;
  const byQuarterMap = new Map<string, Record<string, number>>();

  for (const row of rows) {
    if (!byQuarterMap.has(row.quarter)) {
      byQuarterMap.set(row.quarter, Object.fromEntries(ALL_SEGS.map((s) => [s, 0])));
    }
    byQuarterMap.get(row.quarter)![row.segment] = cacheRowAmount(row, channelFilter);
  }

  const byQuarter: PipelineQuarterRow[] = [...byQuarterMap.keys()]
    .sort(compareQuarterLabels)
    .map((quarter) => {
      const b = byQuarterMap.get(quarter)!;
      return {
        quarter,
        Starter:    Math.round(b.Starter    ?? 0),
        Growth:     Math.round(b.Growth     ?? 0),
        Enterprise: Math.round(b.Enterprise ?? 0),
        Discovery:  Math.round(b.Discovery  ?? 0),
        Other:      Math.round(b.Other      ?? 0),
        total:      Math.round(ALL_SEGS.reduce((s, seg) => s + (b[seg] ?? 0), 0)),
      };
    });

  const bySegment = ALL_SEGS.map((seg) => ({
    segment: seg,
    total: Math.round(byQuarter.reduce((s, r) => s + (r[seg as keyof PipelineQuarterRow] as number), 0)),
  }));

  return { byQuarter, bySegment, grandTotal: byQuarter.reduce((s, r) => s + r.total, 0) };
}

/** Merge two PipelineBreakdownResults (used to combine cached + live current-quarter data) */
function mergeBreakdownResults(a: PipelineBreakdownResult, b: PipelineBreakdownResult): PipelineBreakdownResult {
  const ALL_SEGS = [...SEGMENTS, "Other"] as const;
  const map = new Map<string, Record<string, number>>();

  for (const row of [...a.byQuarter, ...b.byQuarter]) {
    if (!map.has(row.quarter)) {
      map.set(row.quarter, Object.fromEntries(ALL_SEGS.map((s) => [s, 0])));
    }
    const m = map.get(row.quarter)!;
    for (const seg of ALL_SEGS) {
      m[seg] += (row[seg as keyof PipelineQuarterRow] as number) ?? 0;
    }
  }

  const byQuarter: PipelineQuarterRow[] = [...map.keys()]
    .sort(compareQuarterLabels)
    .map((quarter) => {
      const b = map.get(quarter)!;
      return {
        quarter,
        Starter:    Math.round(b.Starter    ?? 0),
        Growth:     Math.round(b.Growth     ?? 0),
        Enterprise: Math.round(b.Enterprise ?? 0),
        Discovery:  Math.round(b.Discovery  ?? 0),
        Other:      Math.round(b.Other      ?? 0),
        total:      Math.round(ALL_SEGS.reduce((s, seg) => s + (b[seg] ?? 0), 0)),
      };
    });

  const bySegment = ALL_SEGS.map((seg) => ({
    segment: seg,
    total: Math.round(byQuarter.reduce((s, r) => s + (r[seg as keyof PipelineQuarterRow] as number), 0)),
  }));

  return { byQuarter, bySegment, grandTotal: byQuarter.reduce((s, r) => s + r.total, 0) };
}

// ---------------------------------------------------------------------------
// fetchNewPipelineBreakdown — with quarter-level caching
// ---------------------------------------------------------------------------

export async function fetchNewPipelineBreakdown(from: Date, to: Date, channel?: string): Promise<PipelineBreakdownResult> {
  const integration = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!integration?.accessToken) throw new Error("HubSpot not connected");
  const token = decrypt(integration.accessToken);

  const quarters = getQuartersInRange(from, to);
  const completed = quarters.filter((q) => !q.isCurrent);
  const current   = quarters.find((q)  =>  q.isCurrent);

  // ── Completed quarters: serve from cache, fetch only what's missing ──────
  const cachedRows = completed.length
    ? await prisma.pipelineQuarterSnapshot.findMany({
        where: { quarter: { in: completed.map((q) => q.label) } },
      })
    : [];
  const cachedLabels = new Set([...new Set(cachedRows.map((r) => r.quarter))]);

  for (const q of completed) {
    if (cachedLabels.has(q.label)) continue;   // already cached — skip

    console.log(`[pipeline cache] fetching ${q.label} from HubSpot…`);
    const deals = await fetchPipelineDeals(token, [
      { propertyName: "createdate", operator: "GTE", value: String(q.qFrom.getTime()) },
      { propertyName: "createdate", operator: "LTE", value: String(q.qTo.getTime())   },
    ]);
    await writeQuarterCache(q.label, deals);
  }

  // Read all completed-quarter rows (now guaranteed to exist)
  const allCompletedRows = completed.length
    ? await prisma.pipelineQuarterSnapshot.findMany({
        where: { quarter: { in: completed.map((q) => q.label) } },
      })
    : [];

  const completedResult = assembleFromCacheRows(allCompletedRows, channel);

  // ── Current quarter: always fetch live, never cache ──────────────────────
  if (!current) return completedResult;

  const currentDeals = await fetchPipelineDeals(token, [
    { propertyName: "createdate", operator: "GTE", value: String(current.qFrom.getTime()) },
    { propertyName: "createdate", operator: "LTE", value: String(current.qTo.getTime())   },
  ]);
  const currentResult = accumulateBreakdown(currentDeals, channel);

  return mergeBreakdownResults(completedResult, currentResult);
}

// ---------------------------------------------------------------------------
// HubSpot fetch wrapper
// ---------------------------------------------------------------------------

interface HubspotFilter {
  propertyName: string;
  operator: string;
  value?: string;
  values?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hubspotFetch(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) throw new Error("429 HubSpot rate limit — will retry");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Backfill — historical day-by-day snapshots
// ---------------------------------------------------------------------------

/**
 * Fetches all HubSpot contacts + deals from `from` to today,
 * buckets them by day, and writes one MetricSnapshot per day per channel.
 *
 * Unlike the daily sync (which uses fast count queries), backfill fetches
 * full contact/deal records so we can group by their individual create/close dates.
 *
 * Contacts → leads & MQLs attributed to their createdate
 * Pipeline deals → SQOs & pipeline value attributed to deal createdate
 * Closed won deals → closedWon & revenue attributed to deal closedate
 */
export async function backfillHubspot(
  from: Date
): Promise<{ days: number; snapshots: number }> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.accessToken) throw new Error("HubSpot token not found");
  const token = decrypt(row.accessToken);

  const fromTs = from.getTime();

  // ── Types & helpers ────────────────────────────────────────────────────────
  type Accum = {
    leads: number; mqls: number; sqos: number;
    activePipeline: number; newPipeline: number;
    closedWon: number; revenue: number;
  };
  type ChannelKey = "paid_media" | "organic" | "referral";
  const CHANNELS: ChannelKey[] = ["paid_media", "organic", "referral"];
  const zero = (): Accum => ({ leads: 0, mqls: 0, sqos: 0, activePipeline: 0, newPipeline: 0, closedWon: 0, revenue: 0 });

  const dayBuckets = new Map<string, Record<ChannelKey, Accum>>();

  function getDay(dateStr: string): Record<ChannelKey, Accum> {
    if (!dayBuckets.has(dateStr)) {
      dayBuckets.set(dateStr, { paid_media: zero(), organic: zero(), referral: zero() });
    }
    return dayBuckets.get(dateStr)!;
  }

  // ── Contacts: one EQ call per source value ─────────────────────────────────
  // Using EQ (not IN) because IN with multiple values causes 400 on this account.
  // Each individual source has far fewer contacts than the 10K search cap.
  // Contacts are bucketed by their actual createDate — no upper-bound filter needed.

  /** Fetch one source, swallowing 400s (invalid/unsearchable values) gracefully. */
  async function safeContactFetch(src: string): Promise<{ createDate: string; isMql: boolean }[]> {
    try {
      return await fetchContactsForSource(token, fromTs, src);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // A 400 means HubSpot won't search by this source value — skip it and continue
      if (msg.includes("400")) {
        console.warn(`[backfill]   ${src}: skipped (400 — value not searchable on this account)`);
        return [];
      }
      throw e; // re-throw anything else (network errors, 401, 500, etc.)
    }
  }

  console.log("[backfill] fetching paid contacts…");
  for (const src of PAID_SOURCES) {
    const contacts = await safeContactFetch(src);
    console.log(`[backfill]   ${src}: ${contacts.length}`);
    for (const c of contacts) {
      if (!c.createDate) continue;
      const b = getDay(c.createDate);
      b.paid_media.leads += 1;
      if (c.isMql) b.paid_media.mqls += 1;
    }
    await delay(INTER_CALL_DELAY_MS);
  }

  console.log("[backfill] fetching direct contacts…");
  const directContacts = await safeContactFetch(DIRECT_SOURCE);
  console.log(`[backfill]   DIRECT_TRAFFIC: ${directContacts.length}`);
  for (const c of directContacts) {
    if (!c.createDate) continue;
    const b = getDay(c.createDate);
    b.paid_media.leads += 0.5;
    b.organic.leads    += 0.5;
    if (c.isMql) { b.paid_media.mqls += 0.5; b.organic.mqls += 0.5; }
  }
  await delay(INTER_CALL_DELAY_MS);

  console.log("[backfill] fetching organic contacts…");
  for (const src of ORGANIC_SOURCES) {
    const contacts = await safeContactFetch(src);
    console.log(`[backfill]   ${src}: ${contacts.length}`);
    for (const c of contacts) {
      if (!c.createDate) continue;
      const b = getDay(c.createDate);
      b.organic.leads += 1;
      if (c.isMql) b.organic.mqls += 1;
    }
    await delay(INTER_CALL_DELAY_MS);
  }

  // ── Deals ──────────────────────────────────────────────────────────────────

  // Active pipeline: ALL deals currently in stages 1,3,4,5 (no date filter)
  console.log("[backfill] fetching active pipeline deals…");
  const activePipelineDeals = await fetchDealRecordsCreated(token, fromTs)
    .catch((e: Error) => { throw new Error(`active pipeline deals: ${e.message}`); });
  console.log(`[backfill] active pipeline deals: ${activePipelineDeals.length}`);
  await delay(INTER_CALL_DELAY_MS);

  // New pipeline: deals *created* in the backfill window (any stage)
  console.log("[backfill] fetching new pipeline deals…");
  const newPipelineDeals = await fetchNewPipelineDeals(token, fromTs)
    .catch((e: Error) => { throw new Error(`new pipeline deals: ${e.message}`); });
  console.log(`[backfill] new pipeline deals: ${newPipelineDeals.length}`);
  await delay(INTER_CALL_DELAY_MS);

  console.log("[backfill] fetching closed won deals…");
  const closedDeals = await fetchDealRecordsClosed(token, fromTs)
    .catch((e: Error) => { throw new Error(`closed won deals: ${e.message}`); });
  console.log(`[backfill] closed deals: ${closedDeals.length}`);
  await delay(INTER_CALL_DELAY_MS);

  // ── Meeting-based SQOs ─────────────────────────────────────────────────────
  console.log("[backfill] fetching completed meeting SQOs…");
  const sqoRecords = await fetchSqoMeetings(token, fromTs)
    .catch((e: Error) => { throw new Error(`sqo meetings: ${e.message}`); });
  console.log(`[backfill] SQO meetings: ${sqoRecords.length}`);

  // ── Bucket deals ───────────────────────────────────────────────────────────
  const fromDateStr = from.toISOString().slice(0, 10);

  // Active pipeline: point-in-time snapshot — clamp pre-window deals to first day
  for (const d of activePipelineDeals) {
    if (!d.date) continue;
    const ch = getDealChannel(d);
    if (!ch) continue;
    const bucketDate = d.date < fromDateStr ? fromDateStr : d.date;
    const bucket = getDay(bucketDate);
    if (ch === "direct") {
      bucket.paid_media.activePipeline += d.amount * 0.5;
      bucket.organic.activePipeline    += d.amount * 0.5;
    } else {
      bucket[ch].activePipeline += d.amount;
    }
  }

  // New pipeline generated: deals created in the window, bucketed by creation date
  for (const d of newPipelineDeals) {
    if (!d.date) continue;
    const ch = getDealChannel(d);
    if (!ch) continue;
    const bucket = getDay(d.date);
    if (ch === "direct") {
      bucket.paid_media.newPipeline += d.amount * 0.5;
      bucket.organic.newPipeline    += d.amount * 0.5;
    } else {
      bucket[ch].newPipeline += d.amount;
    }
  }

  for (const d of closedDeals) {
    if (!d.date) continue;
    const ch = getDealChannel(d);
    if (!ch) continue; // not marketing-attributed (Sales, Partnerships, Service, Success, etc.)
    const bucket  = getDay(d.date);
    const isNew   = d.dealtype === "newbusiness"; // count only new business; revenue includes all
    if (ch === "direct") {
      if (isNew) {
        bucket.paid_media.closedWon += 0.5;
        bucket.organic.closedWon    += 0.5;
      }
      bucket.paid_media.revenue += d.amount * 0.5;
      bucket.organic.revenue    += d.amount * 0.5;
    } else {
      if (isNew) bucket[ch].closedWon += 1;
      bucket[ch].revenue += d.amount;
    }
  }

  // Meeting-based SQOs: bucket by meeting date, apply 50/50 direct split
  for (const sqo of sqoRecords) {
    if (!sqo.date) continue;
    const bucket = getDay(sqo.date);
    if (sqo.channel === "direct") {
      bucket.paid_media.sqos += 0.5;
      bucket.organic.sqos    += 0.5;
    } else {
      bucket[sqo.channel].sqos += 1;
    }
  }

  // ── Write snapshots ────────────────────────────────────────────────────────
  let snapshotCount = 0;

  for (const [dateStr, channelBuckets] of dayBuckets) {
    const dateKey = new Date(dateStr + "T00:00:00Z");

    const all = zero();
    for (const ch of CHANNELS) {
      const b = channelBuckets[ch];
      all.leads          += b.leads;
      all.mqls           += b.mqls;
      all.sqos           += b.sqos;
      all.activePipeline += b.activePipeline;
      all.newPipeline    += b.newPipeline;
      all.closedWon      += b.closedWon;
      all.revenue        += b.revenue;
    }

    const entries: [string, Accum][] = [
      ...CHANNELS.map((ch) => [ch, channelBuckets[ch]] as [string, Accum]),
      ["all", all],
    ];

    for (const [channel, m] of entries) {
      const data = {
        leads:          m.leads          || null,
        mqls:           m.mqls           || null,
        sqos:           m.sqos           || null,
        closedWon:      m.closedWon      || null,
        activePipeline: m.activePipeline || null,
        pipeline:       m.newPipeline    || null,
        revenue:        m.revenue        || null,
        leadToMql:      m.leads  > 0 ? m.mqls      / m.leads      : null,
        mqlToSqo:       m.mqls   > 0 ? m.sqos      / m.mqls       : null,
        sqoToClose:     m.sqos   > 0 ? m.closedWon / m.sqos       : null,
      };
      await prisma.metricSnapshot.upsert({
        where: { date_platform_channel: { date: dateKey, platform: "hubspot", channel } },
        create: { date: dateKey, platform: "hubspot", channel, ...data },
        update: data,
      });
      snapshotCount++;
    }
  }

  return { days: dayBuckets.size, snapshots: snapshotCount };
}

// ---------------------------------------------------------------------------
// Contact channel from hs_analytics_source
// ---------------------------------------------------------------------------

type ContactChannel = "paid_media" | "organic" | "referral" | "direct";

function getContactChannel(src: string | null): ContactChannel {
  if (!src) return "organic";
  if (PAID_SOURCES.includes(src))     return "paid_media";
  if (src === DIRECT_SOURCE)          return "direct";
  if (ORGANIC_SOURCES.includes(src))  return "organic";
  return "organic";
}

// ---------------------------------------------------------------------------
// Fetch ALL contact records in range (full pagination, with properties)
// ---------------------------------------------------------------------------

interface ContactRecord {
  createDate:      string;
  analyticsSource: string | null;
  isMql:           boolean;
}

async function fetchContactRecords(
  token: string,
  fromTs: number,
): Promise<ContactRecord[]> {
  const results: ContactRecord[] = [];
  let after: string | undefined;

  do {
    // Note: do NOT include "createdate" in properties — HubSpot returns it
    // at c.createdAt (response metadata) and requesting it explicitly in
    // the properties array can cause a 400 on some accounts.
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "createdate", operator: "GTE", value: String(fromTs) },
        ],
      }],
      properties: ["lifecyclestage", "hs_analytics_source"],
      limit: 100,
    };
    if (after) body.after = after;

    console.log("[backfill:contacts] request:", JSON.stringify(body));
    const res = await hubspotFetch(token, "POST", "/crm/v3/objects/contacts/search", body);

    for (const c of res.results ?? []) {
      // createdAt is always present as response metadata (ISO 8601)
      const dateStr = parseHubspotDate(c.createdAt ?? c.properties?.createdate);
      if (!dateStr) continue;
      const stage = c.properties?.lifecyclestage ?? "";
      results.push({
        createDate:      dateStr,
        analyticsSource: c.properties?.hs_analytics_source ?? null,
        isMql:           stage === LIFECYCLE.mql || stage === LIFECYCLE.sql || stage === LIFECYCLE.opportunity,
      });
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  return results;
}

// ---------------------------------------------------------------------------
// Fetch contact records in range, filtered to a specific source group
// Mirrors the countContacts filter exactly — same filter → same success rate —
// but paginates for full records instead of just the total count.
// Channel is inferred by the caller (from which source group was passed),
// so we never need hs_analytics_source as a response property.
// ---------------------------------------------------------------------------

/**
 * Fetch all contacts created since `fromTs` for a SINGLE source value (EQ).
 *
 * We use EQ (not IN) because:
 *   • EQ + GTE is the minimal proven-working filter combination.
 *   • IN with multiple values has caused 400s on this account.
 *   • LT for datetime upper-bound is unreliable on HubSpot search.
 *
 * Contacts are bucketed by their actual createDate in the caller, so fetching
 * the full range without an upper bound is safe — no double-counting occurs.
 */
async function fetchContactsForSource(
  token: string,
  fromTs: number,
  source: string
): Promise<{ createDate: string; isMql: boolean }[]> {
  const results: { createDate: string; isMql: boolean }[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "createdate",          operator: "GTE", value: String(fromTs) },
          { propertyName: "hs_analytics_source", operator: "EQ",  value: source },
        ],
      }],
      properties: ["lifecyclestage"],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotFetch(token, "POST", "/crm/v3/objects/contacts/search", body);

    for (const c of res.results ?? []) {
      const dateStr = parseHubspotDate(c.createdAt ?? c.properties?.createdate);
      if (!dateStr) continue;
      const stage = c.properties?.lifecyclestage ?? "";
      results.push({
        createDate: dateStr,
        isMql: MQL_OR_ABOVE.has(stage),
      });
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  return results;
}

// ---------------------------------------------------------------------------
// Fetch ALL deal records created in range (pipeline deals, by createdate)
// ---------------------------------------------------------------------------

interface BackfillDealRecord {
  date:         string;
  amount:       number;
  source:       string | null; // deal_source       (high-level)
  sourceDetail: string | null; // deal_source_detail_1
  dealtype:     string | null; // "newbusiness" | "existingbusiness" | null
}

async function fetchDealRecordsCreated(
  token: string,
  fromTs: number
): Promise<BackfillDealRecord[]> {
  const results: BackfillDealRecord[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          // No createdate filter — active pipeline includes deals created at any time.
          // We bucket by the deal's own createdate so older deals land on their creation day.
          { propertyName: "dealstage", operator: "IN", values: ACTIVE_PIPELINE_STAGES },
        ],
      }],
      properties: ["createdate", "amount", DEAL_SOURCE_PROPERTY, DEAL_SOURCE_DETAIL_PROPERTY],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotFetch(token, "POST", "/crm/v3/objects/deals/search", body);

    for (const d of res.results ?? []) {
      const dateStr = parseHubspotDate(d.properties?.createdate);
      if (!dateStr) continue;
      results.push({
        date:         dateStr,
        amount:       parseFloat(d.properties?.amount ?? "0") || 0,
        source:       d.properties?.[DEAL_SOURCE_PROPERTY]        ?? null,
        sourceDetail: d.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? null,
        dealtype:     null,
      });
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  return results;
}

// ---------------------------------------------------------------------------
// Fetch new pipeline deals created in range (any stage — SQOs + new pipeline value)
// ---------------------------------------------------------------------------

async function fetchNewPipelineDeals(
  token: string,
  fromTs: number
): Promise<BackfillDealRecord[]> {
  const results: BackfillDealRecord[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "createdate", operator: "GTE", value: String(fromTs) },
        ],
      }],
      properties: ["createdate", "amount", DEAL_SOURCE_PROPERTY, DEAL_SOURCE_DETAIL_PROPERTY],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotFetch(token, "POST", "/crm/v3/objects/deals/search", body);

    for (const d of res.results ?? []) {
      const dateStr = parseHubspotDate(d.properties?.createdate);
      if (!dateStr) continue;
      results.push({
        date:         dateStr,
        amount:       parseFloat(d.properties?.amount ?? "0") || 0,
        source:       d.properties?.[DEAL_SOURCE_PROPERTY]        ?? null,
        sourceDetail: d.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? null,
        dealtype:     null,
      });
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  return results;
}

// ---------------------------------------------------------------------------
// Fetch closed won deals in range (by closedate)
// ---------------------------------------------------------------------------

async function fetchDealRecordsClosed(
  token: string,
  fromTs: number
): Promise<BackfillDealRecord[]> {
  const results: BackfillDealRecord[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "dealstage",  operator: "EQ",  value: CLOSED_WON_STAGE },
          { propertyName: "closedate",  operator: "GTE", value: String(fromTs)   },
        ],
      }],
      properties: ["closedate", "amount", "dealtype", DEAL_SOURCE_PROPERTY, DEAL_SOURCE_DETAIL_PROPERTY],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotFetch(token, "POST", "/crm/v3/objects/deals/search", body);

    for (const d of res.results ?? []) {
      const dateStr = parseHubspotDate(d.properties?.closedate);
      if (!dateStr) continue;
      results.push({
        date:         dateStr,
        amount:       parseFloat(d.properties?.amount ?? "0") || 0,
        source:       d.properties?.[DEAL_SOURCE_PROPERTY]        ?? null,
        sourceDetail: d.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? null,
        dealtype:     d.properties?.dealtype ?? null,
      });
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  return results;
}

// ---------------------------------------------------------------------------
// Meeting-based SQO helpers
// ---------------------------------------------------------------------------

interface MeetingRecord {
  id:   string;
  date: string; // YYYY-MM-DD derived from hs_timestamp
}

interface SqoRecord {
  date:    string;
  channel: DealChannel;
}

/**
 * Fetch all completed meetings of the given types since `fromTs`.
 * Uses hs_timestamp GTE + hs_meeting_outcome EQ COMPLETED + hs_activity_type IN types.
 */
async function fetchMeetingsByType(
  token:  string,
  fromTs: number,
  types:  string[]
): Promise<MeetingRecord[]> {
  const results: MeetingRecord[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "hs_timestamp",      operator: "GTE", value: String(fromTs) },
          { propertyName: "hs_meeting_outcome", operator: "EQ",  value: "COMPLETED"   },
          { propertyName: "hs_activity_type",   operator: "IN",  values: types        },
        ],
      }],
      properties: ["hs_timestamp", "hs_activity_type"],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotFetch(token, "POST", "/crm/v3/objects/meetings/search", body);

    for (const m of res.results ?? []) {
      const dateStr = parseHubspotDate(
        m.properties?.hs_timestamp ?? m.createdAt
      );
      if (!dateStr) continue;
      results.push({ id: m.id, date: dateStr });
    }

    after = res.paging?.next?.after;
    if (after) await delay(INTER_CALL_DELAY_MS);
  } while (after);

  return results;
}

/**
 * Batch-read meeting → deal associations.
 * Returns a Map of meetingId → first associated dealId.
 */
async function fetchMeetingDealIds(
  token:      string,
  meetingIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  for (let i = 0; i < meetingIds.length; i += 100) {
    const chunk = meetingIds.slice(i, i + 100);
    const res = await hubspotFetch(
      token,
      "POST",
      "/crm/v3/associations/meetings/deals/batch/read",
      { inputs: chunk.map((id) => ({ id })) }
    );

    for (const item of res.results ?? []) {
      const toIds: string[] = (item.to ?? []).map((t: { id: string }) => t.id);
      if (toIds.length > 0) {
        map.set(String(item.from.id), toIds[0]);
      }
    }

    if (i + 100 < meetingIds.length) await delay(INTER_CALL_DELAY_MS);
  }

  return map;
}

/**
 * Batch-read deal source properties for a set of deal IDs.
 * Returns a Map of dealId → DealRecord.
 */
async function fetchDealSourcesById(
  token:   string,
  dealIds: string[]
): Promise<Map<string, DealRecord>> {
  const map = new Map<string, DealRecord>();

  for (let i = 0; i < dealIds.length; i += 100) {
    const chunk = dealIds.slice(i, i + 100);
    const res = await hubspotFetch(
      token,
      "POST",
      "/crm/v3/objects/deals/batch/read",
      {
        inputs:     chunk.map((id) => ({ id })),
        properties: ["amount", DEAL_SOURCE_PROPERTY, DEAL_SOURCE_DETAIL_PROPERTY],
      }
    );

    for (const d of res.results ?? []) {
      map.set(String(d.id), {
        amount:       parseFloat(d.properties?.amount ?? "0") || 0,
        source:       d.properties?.[DEAL_SOURCE_PROPERTY]        ?? null,
        sourceDetail: d.properties?.[DEAL_SOURCE_DETAIL_PROPERTY] ?? null,
        dealtype:     null,
      });
    }

    if (i + 100 < dealIds.length) await delay(INTER_CALL_DELAY_MS);
  }

  return map;
}

/**
 * Orchestrates the full meeting-based SQO fetch.
 *
 * - Events meetings     → organic
 * - Referral meetings   → referral
 * - Inbound meetings    → look up associated deal → getDealChannel()
 *                         falls back to "organic" when no deal is linked
 *
 * Returns one SqoRecord per completed meeting.
 */
async function fetchSqoMeetings(
  token:  string,
  fromTs: number,
): Promise<SqoRecord[]> {
  const sqos: SqoRecord[] = [];

  // Events → organic
  console.log("[sqo] fetching Events meetings…");
  const eventMeetings = await fetchMeetingsByType(token, fromTs, MEETING_TYPES_EVENTS);
  console.log(`[sqo]   Events: ${eventMeetings.length}`);
  for (const m of eventMeetings) {
    sqos.push({ date: m.date, channel: "organic" });
  }
  await delay(INTER_CALL_DELAY_MS);

  // Referral → referral
  console.log("[sqo] fetching Referral meetings…");
  const referralMeetings = await fetchMeetingsByType(token, fromTs, MEETING_TYPES_REFERRAL);
  console.log(`[sqo]   Referral: ${referralMeetings.length}`);
  for (const m of referralMeetings) {
    sqos.push({ date: m.date, channel: "referral" });
  }
  await delay(INTER_CALL_DELAY_MS);

  // Inbound → deal association lookup
  console.log("[sqo] fetching Inbound meetings…");
  const inboundMeetings = await fetchMeetingsByType(token, fromTs, MEETING_TYPES_INBOUND);
  console.log(`[sqo]   Inbound: ${inboundMeetings.length}`);
  await delay(INTER_CALL_DELAY_MS);

  if (inboundMeetings.length > 0) {
    const meetingIds   = inboundMeetings.map((m) => m.id);
    const meetingToDeals = await fetchMeetingDealIds(token, meetingIds);
    await delay(INTER_CALL_DELAY_MS);

    const uniqueDealIds = [...new Set(meetingToDeals.values())];
    const dealSources = uniqueDealIds.length > 0
      ? await fetchDealSourcesById(token, uniqueDealIds)
      : new Map<string, DealRecord>();
    await delay(INTER_CALL_DELAY_MS);

    for (const m of inboundMeetings) {
      const dealId  = meetingToDeals.get(m.id);
      const deal    = dealId ? dealSources.get(dealId) : undefined;
      const channel = deal ? (getDealChannel(deal) ?? "organic") : "organic";
      sqos.push({ date: m.date, channel });
    }

    console.log(`[sqo]   Inbound deal-attributed: ${meetingToDeals.size} linked, ${uniqueDealIds.length} unique deals`);
  }

  return sqos;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Parse a HubSpot datetime value into a YYYY-MM-DD string.
 *
 * HubSpot CRM Search returns datetime properties in two formats:
 *   • Millisecond timestamp string: "1743465600000"
 *   • ISO 8601 string:             "2026-04-01T00:00:00.000Z"
 *
 * Returns "" if the value is missing or unparseable.
 */
function parseHubspotDate(raw: string | null | undefined): string {
  if (!raw) return "";
  let ms: number;
  if (/^\d{10,}$/.test(raw)) {
    // Millisecond epoch timestamp
    ms = parseInt(raw, 10);
  } else {
    ms = Date.parse(raw);
  }
  if (isNaN(ms)) return "";
  // Use UTC date parts — HubSpot closedate/createdate are midnight-UTC date fields,
  // so the UTC calendar date is the canonical value. Using local parts caused
  // different date strings on Vercel (UTC) vs local dev (Mountain Time), creating
  // duplicate MetricSnapshot rows for the same calendar day.
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

