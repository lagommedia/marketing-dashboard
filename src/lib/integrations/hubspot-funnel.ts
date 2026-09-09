/**
 * HubSpot Funnel — stage counts, contact listings, and change-detection snapshot.
 *
 * Funnel stages (top → bottom):
 *   Leads      → all contacts created in range
 *   MQLs       → lifecycle >= marketingqualifiedlead
 *   SQLs       → lifecycle >= salesqualifiedlead (includes SAL 114184284)
 *   SQOs       → lifecycle >= opportunity
 *   SQDs       → lifecycle >= 161312014 (Sales Qualified Deal, custom stage)
 *   Closed Won → deals with dealstage = closedwon in closedate range
 *
 * HubSpot search IN-filter causes 400s on this account, so every multi-value
 * lifecycle filter is expressed as multiple filterGroups (OR semantics).
 */

import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

// ---------------------------------------------------------------------------
// Stage definitions
// ---------------------------------------------------------------------------

const BASE = "https://api.hubapi.com";

const LIFECYCLE = {
  mql:         "marketingqualifiedlead",
  sal:         "114184284",   // Sales Accepted Lead
  sql:         "salesqualifiedlead",
  opportunity: "opportunity",
  sqd:         "161312014",   // Sales Qualified Deal
  customer:    "customer",
} as const;

// "At or above" sets — each is used for filtering contacts by their current stage
const MQL_PLUS  = [LIFECYCLE.mql, LIFECYCLE.sal, LIFECYCLE.sql, LIFECYCLE.opportunity, LIFECYCLE.sqd, LIFECYCLE.customer];
const SQL_PLUS  = [LIFECYCLE.sal, LIFECYCLE.sql, LIFECYCLE.opportunity, LIFECYCLE.sqd, LIFECYCLE.customer];
const SQO_PLUS  = [LIFECYCLE.opportunity, LIFECYCLE.sqd, LIFECYCLE.customer];
const SQD_PLUS  = [LIFECYCLE.sqd, LIFECYCLE.customer];

const CLOSED_WON_STAGE = "closedwon";

/** Human-readable label for each stage value */
export const STAGE_LABEL: Record<string, string> = {
  "lead":                    "Lead",
  [LIFECYCLE.mql]:           "MQL",
  [LIFECYCLE.sal]:           "SQL",   // SAL shown as SQL in UI
  [LIFECYCLE.sql]:           "SQL",
  [LIFECYCLE.opportunity]:   "SQO",
  [LIFECYCLE.sqd]:           "SQD",
  "customer":                "Customer",
  "closedwon":               "Closed Won",
};

// ---------------------------------------------------------------------------
// Shared fetch helper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hsFetch(token: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hsGet(token: string, path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Per-stage date properties
// ---------------------------------------------------------------------------
// Each funnel stage is counted by when a contact REACHED that stage, not when
// they were created. HubSpot sets these date properties automatically when a
// contact's lifecycle stage changes. Custom stages (SQD = 161312014) don't get
// a dedicated date property, so we fall back to createdate + current stage filter.

const STAGE_DATE_PROP: Record<string, string> = {
  leads:     "createdate",
  mqls:      "hs_lifecyclestage_marketingqualifiedlead_date",
  sqls:      "hs_lifecyclestage_salesqualifiedlead_date",
  sqos:      "hs_lifecyclestage_opportunity_date",
  sqds:      "createdate",  // custom stage — no standard date property
};

// ---------------------------------------------------------------------------
// Count helper
// ---------------------------------------------------------------------------

/** Count contacts (or deals) whose date property falls in range, with optional extra filters. */
async function countRecords(
  token: string,
  object: "contacts" | "deals",
  dateProp: string,
  fromTs: number,
  toTs: number,
  extraFilters: object[] = [],
): Promise<number> {
  const res = await hsFetch(token, `/crm/v3/objects/${object}/search`, {
    filterGroups: [{
      filters: [
        { propertyName: dateProp, operator: "GTE", value: String(fromTs) },
        { propertyName: dateProp, operator: "LTE", value: String(toTs)   },
        ...extraFilters,
      ],
    }],
    properties: [],
    limit: 1,
  });
  return res.total ?? 0;
}

// ---------------------------------------------------------------------------
// Public API — funnel counts
// ---------------------------------------------------------------------------

export interface FunnelCounts {
  leads:     number;
  mqls:      number;
  sqls:      number;
  sqos:      number;
  sqds:      number;
  closedWon: number;
}

export async function getFunnelCounts(from: Date, to: Date): Promise<FunnelCounts> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) throw new Error("HubSpot not connected");
  const token = decrypt(row.accessToken);
  const fromTs = from.getTime();
  const toTs   = to.getTime();

  // Run sequentially — HubSpot CRM search is capped at 5 req/s; parallel bursts hit 429s.
  // Each stage filters by when a contact REACHED that stage (not createdate).
  const gap = () => new Promise(r => setTimeout(r, 220));
  const leads     = await countRecords(token, "contacts", "createdate",                                              fromTs, toTs); await gap();
  const mqls      = await countRecords(token, "contacts", "hs_lifecyclestage_marketingqualifiedlead_date",           fromTs, toTs); await gap();
  const sqls      = await countRecords(token, "contacts", "hs_lifecyclestage_salesqualifiedlead_date",               fromTs, toTs); await gap();
  const sqos      = await countRecords(token, "contacts", "hs_lifecyclestage_opportunity_date",                      fromTs, toTs); await gap();
  const sqds      = await countRecords(token, "contacts", "createdate", fromTs, toTs, [{ propertyName: "lifecyclestage", operator: "EQ", value: LIFECYCLE.sqd }]); await gap();
  const closedWon = await countRecords(token, "deals",    "closedate",  fromTs, toTs, [{ propertyName: "dealstage",      operator: "EQ", value: CLOSED_WON_STAGE }]);

  return { leads, mqls, sqls, sqos, sqds, closedWon };
}

// ---------------------------------------------------------------------------
// Public API — contacts / deals for a stage (for the drawer)
// ---------------------------------------------------------------------------

export interface FunnelRecord {
  id:   string;
  name: string;
  url:  string;
  extra?: string; // e.g. amount for deals
}

export type FunnelStage = "leads" | "mqls" | "sqls" | "sqos" | "sqds" | "closedwon";

export async function getFunnelStageRecords(
  stage: FunnelStage,
  from: Date,
  to: Date,
): Promise<FunnelRecord[]> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) throw new Error("HubSpot not connected");
  const token    = decrypt(row.accessToken);
  const portalId = row.accountId ?? "";
  const fromTs   = from.getTime();
  const toTs     = to.getTime();

  // Closed won = deals
  if (stage === "closedwon") {
    const results: FunnelRecord[] = [];
    let after: string | undefined;
    do {
      const body: Record<string, unknown> = {
        filterGroups: [{
          filters: [
            { propertyName: "closedate",  operator: "GTE", value: String(fromTs)   },
            { propertyName: "closedate",  operator: "LTE", value: String(toTs)     },
            { propertyName: "dealstage",  operator: "EQ",  value: CLOSED_WON_STAGE },
          ],
        }],
        properties: ["dealname", "amount"],
        sorts: [{ propertyName: "closedate", direction: "DESCENDING" }],
        limit: 100,
      };
      if (after) body.after = after;
      const res = await hsFetch(token, "/crm/v3/objects/deals/search", body);
      for (const d of res.results ?? []) {
        const p = d.properties ?? {};
        const amt = p.amount ? `$${parseFloat(p.amount).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : undefined;
        results.push({
          id:    d.id,
          name:  p.dealname || "Unnamed Deal",
          url:   `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`,
          extra: amt,
        });
      }
      after = res.paging?.next?.after;
    } while (after && results.length < 500);
    return results;
  }

  // Contacts — filter by when the contact REACHED each stage (not createdate)
  const dateProp =
    stage === "leads" ? "createdate" :
    stage === "mqls"  ? "hs_lifecyclestage_marketingqualifiedlead_date" :
    stage === "sqls"  ? "hs_lifecyclestage_salesqualifiedlead_date" :
    stage === "sqos"  ? "hs_lifecyclestage_opportunity_date" :
                        "createdate"; // sqds — custom stage, no standard date property

  const extraFilters: object[] =
    stage === "sqds" ? [{ propertyName: "lifecyclestage", operator: "EQ", value: LIFECYCLE.sqd }] : [];

  const filterGroups = [{
    filters: [
      { propertyName: dateProp, operator: "GTE", value: String(fromTs) },
      { propertyName: dateProp, operator: "LTE", value: String(toTs)   },
      ...extraFilters,
    ],
  }];

  const results: FunnelRecord[] = [];
  let after: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filterGroups,
      properties: ["firstname", "lastname", "email", "lifecyclestage"],
      sorts: [{ propertyName: dateProp, direction: "DESCENDING" }],
      limit: 100,
    };
    if (after) body.after = after;
    const res = await hsFetch(token, "/crm/v3/objects/contacts/search", body);
    for (const c of res.results ?? []) {
      const p = c.properties ?? {};
      const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || "Unknown";
      const stageLabel = STAGE_LABEL[p.lifecyclestage ?? ""] ?? p.lifecyclestage ?? "";
      results.push({
        id:    c.id,
        name,
        url:   `https://app.hubspot.com/contacts/${portalId}/contact/${c.id}`,
        extra: stageLabel || undefined,
      });
    }
    after = res.paging?.next?.after;
  } while (after && results.length < 500);

  return results;
}

// ---------------------------------------------------------------------------
// Funnel snapshot — stores current contact stages for regression detection
// ---------------------------------------------------------------------------

interface ContactStageRow {
  id:    string;
  name:  string;
  email: string;
  stage: string;
}

/** Fetch all contacts currently at MQL+ (no date filter — full contact base) */
async function fetchAllMqlPlusContacts(token: string): Promise<ContactStageRow[]> {
  const results: ContactStageRow[] = [];
  let after: string | undefined;

  do {
    // MQL+ has 6 stages — exceeds HubSpot's 5-filterGroup cap; NEQ "lead" is equivalent
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: [{ propertyName: "lifecyclestage", operator: "NEQ", value: "lead" }] }],
      properties: ["firstname", "lastname", "email", "lifecyclestage"],
      limit: 100,
    };
    if (after) body.after = after;
    const res = await hsFetch(token, "/crm/v3/objects/contacts/search", body);
    for (const c of res.results ?? []) {
      const p = c.properties ?? {};
      results.push({
        id:    c.id,
        name:  [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || `Contact ${c.id}`,
        email: p.email ?? "",
        stage: p.lifecyclestage ?? "lead",
      });
    }
    after = res.paging?.next?.after;
    if (after) await new Promise(r => setTimeout(r, 300));
  } while (after);

  return results;
}

/** Fetch HubSpot property history for a contact's lifecyclestage */
async function fetchStageHistory(
  token: string, contactId: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ value: string; timestamp: string; updatedByUserId?: number }[]> {
  try {
    const res = await hsGet(
      token,
      `/crm/v3/objects/contacts/${contactId}?propertiesWithHistory=lifecyclestage`
    );
    return res.propertiesWithHistory?.lifecyclestage ?? [];
  } catch {
    return [];
  }
}

/** Fetch HubSpot owner email by userId */
async function fetchOwnerEmail(token: string, userId: number): Promise<string | null> {
  try {
    const res = await hsGet(token, `/crm/v3/owners/${userId}?idProperty=userId`);
    return res.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Run a funnel snapshot:
 * 1. Fetch all MQL+ contacts from HubSpot
 * 2. Compare with stored FunnelContactSnapshot
 * 3. For contacts whose stage regressed, create FunnelChangeNotification records
 * 4. Update snapshot table
 */
export async function syncFunnelSnapshot(): Promise<{ checked: number; regressions: number }> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) return { checked: 0, regressions: 0 };
  const token    = decrypt(row.accessToken);
  const portalId = row.accountId ?? "";

  const contacts = await fetchAllMqlPlusContacts(token);

  // Build a stage-rank map for regression detection
  const stageRank: Record<string, number> = {
    "lead":                0,
    [LIFECYCLE.mql]:       1,
    [LIFECYCLE.sal]:       2,
    [LIFECYCLE.sql]:       3,
    [LIFECYCLE.opportunity]: 4,
    [LIFECYCLE.sqd]:       5,
    "customer":            6,
  };

  let regressions = 0;

  for (const contact of contacts) {
    const existing = await prisma.funnelContactSnapshot.findUnique({
      where: { hubspotId: contact.id },
    });

    if (existing && stageRank[contact.stage] < stageRank[existing.stage]) {
      // Stage regressed — find out when and who changed it
      const history = await fetchStageHistory(token, contact.id);

      // Find the most recent entry that matches the new (regressed) value
      const changeEntry = history.find(h => h.value === contact.stage);
      let changedAt: Date | undefined;
      let changedBy: string | undefined;

      if (changeEntry) {
        changedAt = new Date(changeEntry.timestamp);
        if (changeEntry.updatedByUserId) {
          const email = await fetchOwnerEmail(token, changeEntry.updatedByUserId);
          changedBy = email ?? `User ${changeEntry.updatedByUserId}`;
        }
      }

      await prisma.funnelChangeNotification.create({
        data: {
          hubspotId:  contact.id,
          objectType: "contact",
          objectName: contact.name,
          fromStage:  STAGE_LABEL[existing.stage] ?? existing.stage,
          toStage:    STAGE_LABEL[contact.stage]  ?? contact.stage,
          changedAt:  changedAt ?? null,
          changedBy:  changedBy ?? null,
          profileUrl: `https://app.hubspot.com/contacts/${portalId}/contact/${contact.id}`,
        },
      });
      regressions++;
    }

    // Upsert the snapshot with current stage
    await prisma.funnelContactSnapshot.upsert({
      where:  { hubspotId: contact.id },
      create: { hubspotId: contact.id, objectType: "contact", name: contact.name, email: contact.email, stage: contact.stage },
      update: { name: contact.name, email: contact.email, stage: contact.stage },
    });
  }

  return { checked: contacts.length, regressions };
}
