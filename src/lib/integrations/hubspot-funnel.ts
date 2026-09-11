/**
 * HubSpot Funnel — stage counts, contact listings, and change-detection snapshot.
 *
 * Funnel stages (top → bottom):
 *   Leads      → all contacts created in range
 *   MQLs       → contacts created in range, currently at MQL stage
 *   SQLs       → contacts created in range, currently at SAL or SQL stage
 *   SQOs       → contacts created in range, currently at opportunity stage
 *   SQDs       → contacts created in range, currently at SQD stage (custom: 161312014)
 *   Closed Won → deals with dealstage = closedwon in closedate range
 *
 * Each count uses createdate + lifecyclestage EQ filters. Per-stage lifecycle
 * date properties (hs_lifecyclestage_*_date) are not indexed for search on this
 * account. HubSpot IN-filter also causes 400s, so multi-value stage filters use
 * multiple filterGroups (OR semantics, max 5 per HubSpot limit).
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

const CLOSED_WON_STAGE = "closedwon";

const SQO_MEETING_TYPES = [
  "Zeni Overview - Events", "Zeni Overview - Events BDR", "Zeni Overview - Events AE", "Zeni Overview - Events Partnerships",
  "Zeni Overview - Customer Referral", "Zeni Overview - Employee Referral", "Zeni Overview - Inbound VC Referral",
  "Zeni Overview - Inbound", "Zeni Overview - Inbound Partnerships", "Partner: Inbound Consultation", "Partner: Consultation",
  "Inbound Follow Up", "Inbound Product Tour",
  "Zeni Overview - Outbound BDR", "Zeni Overview - Outbound AE", "Zeni Overview - Enterprise Outbound BDR",
  "Zeni Overview - AE Self Set BDR Spiff", "Zeni Overview - Partnerships", "Zeni Overview - Partnerships AE Self Set",
];

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
// Count helpers
// ---------------------------------------------------------------------------

/**
 * Count contacts created in the date range currently at the given lifecycle stages.
 * Uses one filterGroup per stage value (OR semantics) — max 5 per HubSpot limit.
 * Pass null stageValues to count all contacts regardless of stage.
 */
async function countContactsByStage(
  token: string,
  fromTs: number,
  toTs: number,
  stageValues: string[] | null,
): Promise<number> {
  const dateFilters = [
    { propertyName: "createdate", operator: "GTE", value: String(fromTs) },
    { propertyName: "createdate", operator: "LTE", value: String(toTs)   },
  ];

  const filterGroups = stageValues
    ? stageValues.map(v => ({ filters: [...dateFilters, { propertyName: "lifecyclestage", operator: "EQ", value: v }] }))
    : [{ filters: dateFilters }];

  const res = await hsFetch(token, "/crm/v3/objects/contacts/search", {
    filterGroups,
    properties: [],
    limit: 1,
  });
  return res.total ?? 0;
}

/** Count deals closed won in the date range. */
async function countClosedWon(token: string, fromTs: number, toTs: number): Promise<number> {
  const res = await hsFetch(token, "/crm/v3/objects/deals/search", {
    filterGroups: [{
      filters: [
        { propertyName: "closedate",  operator: "GTE", value: String(fromTs)   },
        { propertyName: "closedate",  operator: "LTE", value: String(toTs)     },
        { propertyName: "dealstage",  operator: "EQ",  value: CLOSED_WON_STAGE },
      ],
    }],
    properties: [],
    limit: 1,
  });
  return res.total ?? 0;
}

/** Count completed SQO meetings (demo meetings) in the date range. */
async function countSqoMeetings(token: string, fromTs: number, toTs: number): Promise<number> {
  const res = await hsFetch(token, "/crm/v3/objects/meetings/search", {
    filterGroups: [{
      filters: [
        { propertyName: "hs_timestamp",      operator: "GTE", value: String(fromTs)      },
        { propertyName: "hs_timestamp",      operator: "LTE", value: String(toTs)        },
        { propertyName: "hs_meeting_outcome", operator: "EQ",  value: "COMPLETED"        },
        { propertyName: "hs_activity_type",   operator: "IN",  values: SQO_MEETING_TYPES },
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
  // MQL = contacts who reached MQL or any higher stage (same as the daily sync backfill's MQL_OR_ABOVE).
  // Contacts progress past MQL to SQL/SQO/SQD/customer, so "exactly MQL" severely undercounts.
  // Split into two calls to stay within HubSpot's 5-filterGroups-per-request limit.
  const gap = () => new Promise(r => setTimeout(r, 220));
  const leads     = await countContactsByStage(token, fromTs, toTs, null); await gap();
  const mqlsLow   = await countContactsByStage(token, fromTs, toTs, [LIFECYCLE.mql, LIFECYCLE.sal, LIFECYCLE.sql]); await gap();
  const mqlsHigh  = await countContactsByStage(token, fromTs, toTs, [LIFECYCLE.opportunity, LIFECYCLE.sqd, LIFECYCLE.customer]); await gap();
  const mqls      = mqlsLow + mqlsHigh;
  const sqls      = await countContactsByStage(token, fromTs, toTs, [LIFECYCLE.sal, LIFECYCLE.sql]); await gap();
  const sqos      = await countSqoMeetings(token, fromTs, toTs); await gap();
  const sqds      = await countContactsByStage(token, fromTs, toTs, [LIFECYCLE.sqd]); await gap();
  const closedWon = await countClosedWon(token, fromTs, toTs);

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

  // SQOs — fetch completed demo meetings in range, resolve their associated contacts
  if (stage === "sqos") {
    const meetingResults: FunnelRecord[] = [];
    let after: string | undefined;
    do {
      const body: Record<string, unknown> = {
        filterGroups: [{
          filters: [
            { propertyName: "hs_timestamp",      operator: "GTE", value: String(fromTs)      },
            { propertyName: "hs_timestamp",      operator: "LTE", value: String(toTs)        },
            { propertyName: "hs_meeting_outcome", operator: "EQ",  value: "COMPLETED"        },
            { propertyName: "hs_activity_type",   operator: "IN",  values: SQO_MEETING_TYPES },
          ],
        }],
        properties: ["hs_activity_type"],
        sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
        limit: 100,
      };
      if (after) body.after = after;
      const res = await hsFetch(token, "/crm/v3/objects/meetings/search", body);
      const meetings = res.results ?? [];

      if (meetings.length > 0) {
        // Batch-read meeting → contact associations
        const assocRes = await hsFetch(token, "/crm/v3/associations/meetings/contacts/batch/read",
          { inputs: meetings.map((m: { id: string }) => ({ id: m.id })) }
        );
        const meetingToContact = new Map<string, string>();
        for (const item of assocRes.results ?? []) {
          const toIds = (item.to ?? []).map((t: { id: string }) => t.id);
          if (toIds.length > 0) meetingToContact.set(String(item.from.id), toIds[0]);
        }

        const uniqueContactIds = [...new Set(meetingToContact.values())];
        const contactMap = new Map<string, string>();
        if (uniqueContactIds.length > 0) {
          const contactRes = await hsFetch(token, "/crm/v3/objects/contacts/batch/read", {
            inputs: uniqueContactIds.map((id) => ({ id })),
            properties: ["firstname", "lastname", "email"],
          });
          for (const c of contactRes.results ?? []) {
            const p = c.properties ?? {};
            const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || "Unknown";
            contactMap.set(String(c.id), name);
          }
        }

        for (const m of meetings) {
          const contactId = meetingToContact.get(m.id);
          const name = contactId ? (contactMap.get(contactId) ?? "Unknown") : "(No contact linked)";
          const type = m.properties?.hs_activity_type ?? "";
          meetingResults.push({
            id:    m.id,
            name,
            url:   contactId
              ? `https://app.hubspot.com/contacts/${portalId}/contact/${contactId}`
              : `https://app.hubspot.com/contacts/${portalId}/objects/0-47/views/all/list`,
            extra: type || undefined,
          });
        }
      }

      after = res.paging?.next?.after;
      if (after) await new Promise(r => setTimeout(r, 250));
    } while (after && meetingResults.length < 500);

    return meetingResults;
  }

  // Contacts — createdate in range + exact lifecyclestage EQ filter per stage
  const dateFilters = [
    { propertyName: "createdate", operator: "GTE", value: String(fromTs) },
    { propertyName: "createdate", operator: "LTE", value: String(toTs)   },
  ];

  const stageFilters: string[] =
    stage === "mqls" ? [LIFECYCLE.mql] :
    stage === "sqls" ? [LIFECYCLE.sal, LIFECYCLE.sql] :
    stage === "sqds" ? [LIFECYCLE.sqd] :
    []; // leads — no stage filter

  const filterGroups = stageFilters.length > 0
    ? stageFilters.map(v => ({ filters: [...dateFilters, { propertyName: "lifecyclestage", operator: "EQ", value: v }] }))
    : [{ filters: dateFilters }];

  const results: FunnelRecord[] = [];
  let after: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filterGroups,
      properties: ["firstname", "lastname", "email", "lifecyclestage"],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
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
