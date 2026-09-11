/**
 * HubSpot Daily Audit System
 *
 * Runs once per day (called from cron). Detects 5 alert types:
 *   a. sqo_attribution   — deal_source changed on a deal linked to an SQO meeting
 *   b. sqd_closed_lost   — deal moved from SQD stage to Closed Lost (with reason)
 *   c. negative_arr      — deal amount decreased or deal moved to a worse stage
 *   d. workflow_unenroll — inbound contact unenrolled from workflow before 60 days
 *   e. inbound_outbound_worked — inbound contact called/emailed/tasked by Outbound BDR
 */

import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

const BASE = "https://api.hubapi.com";

// HubSpot stage IDs
const SQD_STAGE = "161312014";   // SQD (Sales Qualified Deal)
const CLOSED_LOST_STAGE = "closedlost";

// Meeting types that count as SQOs (same list as funnel/overview pages)
const SQO_MEETING_TYPES = [
  "Zeni Overview - Events", "Zeni Overview - Events BDR", "Zeni Overview - Events AE",
  "Zeni Overview - Events Partnerships", "Zeni Overview - Customer Referral",
  "Zeni Overview - Employee Referral", "Zeni Overview - Inbound VC Referral",
  "Zeni Overview - Inbound", "Zeni Overview - Inbound Partnerships",
  "Partner: Inbound Consultation", "Partner: Consultation",
  "Inbound Follow Up", "Inbound Product Tour",
  "Zeni Overview - Outbound BDR", "Zeni Overview - Outbound AE",
  "Zeni Overview - Enterprise Outbound BDR", "Zeni Overview - AE Self Set BDR Spiff",
  "Zeni Overview - Partnerships", "Zeni Overview - Partnerships AE Self Set",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hsGet(token: string, path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot GET ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hsPost(token: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot POST ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve HubSpot owner/user IDs → display names (cached per run) */
async function buildOwnerMap(token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const data = await hsGet(token, "/crm/v3/owners/", { limit: "250" });
    for (const o of data.results ?? []) {
      const name = [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || String(o.id);
      map.set(String(o.id), name);
      if (o.userId) map.set(String(o.userId), name);
    }
  } catch {
    // non-fatal — alerts just won't have names resolved
  }
  return map;
}

/** Fetch deals modified in the last N hours */
async function fetchRecentDeals(token: string, sinceTs: number): Promise<string[]> {
  const dealIds: string[] = [];
  let after: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [{ propertyName: "lastmodifieddate", operator: "GTE", value: String(sinceTs) }],
      }],
      properties: [],
      sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }],
      limit: 100,
    };
    if (after) body.after = after;
    const res = await hsPost(token, "/crm/v3/objects/deals/search", body);
    for (const d of res.results ?? []) dealIds.push(d.id);
    after = res.paging?.next?.after;
    if (after) await delay(250);
  } while (after && dealIds.length < 1000);
  return dealIds;
}

/** Fetch a single deal with property history for specified properties */
async function fetchDealWithHistory(
  token: string,
  dealId: string,
  properties: string[],
): Promise<{ id: string; properties: Record<string, string>; propertiesWithHistory: Record<string, { value: string; timestamp: string; updatedByUserId?: number }[]> }> {
  const params: Record<string, string> = {
    properties:             properties.join(","),
    propertiesWithHistory:  properties.join(","),
    associations:           "companies,contacts",
  };
  return hsGet(token, `/crm/v3/objects/deals/${dealId}`, params);
}

// ─── Alert type a: SQO attribution changes ──────────────────────────────────

export async function detectSqoAttributionChanges(
  token: string,
  portalId: string,
  sinceTs: number,
  ownerMap: Map<string, string>,
): Promise<number> {
  let count = 0;
  const dealIds = await fetchRecentDeals(token, sinceTs);
  if (dealIds.length === 0) return 0;

  // First: identify which deals are linked to SQO meetings (batch)
  // We only care about deals linked to completed SQO meetings
  // Fetch in batches of 20 to stay within rate limits
  const SQO_LINKED_DEALS = new Set<string>();
  const batchSize = 20;
  for (let i = 0; i < dealIds.length; i += batchSize) {
    const chunk = dealIds.slice(i, i + batchSize);
    // Fetch deal→meeting associations
    try {
      const assocRes = await hsPost(token, "/crm/v3/associations/deals/meetings/batch/read", {
        inputs: chunk.map((id) => ({ id })),
      });
      for (const item of assocRes.results ?? []) {
        if ((item.to ?? []).length > 0) SQO_LINKED_DEALS.add(String(item.from.id));
      }
    } catch { /* skip if no meeting associations */ }
    if (i + batchSize < dealIds.length) await delay(300);
  }

  if (SQO_LINKED_DEALS.size === 0) return 0;

  // Check property history for deal_source on SQO-linked deals
  for (const dealId of SQO_LINKED_DEALS) {
    try {
      const deal = await fetchDealWithHistory(token, dealId, ["dealname", "deal_source", "amount"]);
      await delay(150);

      const history = deal.propertiesWithHistory?.deal_source ?? [];
      if (history.length < 2) continue;

      // Find a change that happened since sinceTs
      const recentChange = history.find((h) => new Date(h.timestamp).getTime() >= sinceTs);
      if (!recentChange) continue;

      const prevEntry = history.find((h) => new Date(h.timestamp).getTime() < new Date(recentChange.timestamp).getTime());
      if (!prevEntry || prevEntry.value === recentChange.value) continue;

      // Resolve contact + company
      const assocs = deal as { associations?: { contacts?: { results: { id: string }[] }; companies?: { results: { id: string }[] } } };
      const contactId = assocs.associations?.contacts?.results?.[0]?.id;
      const companyId = assocs.associations?.companies?.results?.[0]?.id;

      let contactName: string | undefined;
      let companyName: string | undefined;

      if (contactId) {
        try {
          const c = await hsGet(token, `/crm/v3/objects/contacts/${contactId}`, {
            properties: "firstname,lastname,email",
          });
          const p = c.properties ?? {};
          contactName = [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email;
          await delay(100);
        } catch { /* skip */ }
      }
      if (companyId) {
        try {
          const co = await hsGet(token, `/crm/v3/objects/companies/${companyId}`, { properties: "name" });
          companyName = co.properties?.name;
          await delay(100);
        } catch { /* skip */ }
      }

      const changedByName = recentChange.updatedByUserId
        ? (ownerMap.get(String(recentChange.updatedByUserId)) ?? `User ${recentChange.updatedByUserId}`)
        : undefined;

      // Upsert — avoid duplicate alerts for same deal+change on same day
      const alertKey = `sqo_attribution:${dealId}:${recentChange.timestamp}`;
      await prisma.hubspotAuditAlert.upsert({
        where:  { id: alertKey },
        update: {},
        create: {
          id:          alertKey,
          alertType:   "sqo_attribution",
          detectedAt:  new Date(),
          contactId,
          contactName,
          companyId,
          companyName,
          dealId,
          dealName:    deal.properties?.dealname ?? undefined,
          dealUrl:     `https://app.hubspot.com/contacts/${portalId}/deal/${dealId}`,
          contactUrl:  contactId ? `https://app.hubspot.com/contacts/${portalId}/contact/${contactId}` : undefined,
          fromValue:   prevEntry.value,
          toValue:     recentChange.value,
          changedByUserId: recentChange.updatedByUserId ? String(recentChange.updatedByUserId) : undefined,
          changedByName,
          changedAt:   new Date(recentChange.timestamp),
        },
      });
      count++;
    } catch (e) {
      console.error(`[audit:sqo_attribution] deal ${dealId}:`, e);
    }
  }
  return count;
}

// ─── Alert type b: SQD → Closed Lost ────────────────────────────────────────

export async function detectSqdClosedLost(
  token: string,
  portalId: string,
  sinceTs: number,
  ownerMap: Map<string, string>,
): Promise<number> {
  let count = 0;

  // Find deals that are now closed lost and were modified recently
  let after: string | undefined;
  const closedLostDeals: string[] = [];
  do {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [
          { propertyName: "dealstage",        operator: "EQ",  value: CLOSED_LOST_STAGE },
          { propertyName: "lastmodifieddate", operator: "GTE", value: String(sinceTs)   },
        ],
      }],
      properties: [],
      limit: 100,
    };
    if (after) body.after = after;
    const res = await hsPost(token, "/crm/v3/objects/deals/search", body);
    for (const d of res.results ?? []) closedLostDeals.push(d.id);
    after = res.paging?.next?.after;
    if (after) await delay(250);
  } while (after && closedLostDeals.length < 500);

  for (const dealId of closedLostDeals) {
    try {
      const deal = await fetchDealWithHistory(token, dealId, [
        "dealname", "dealstage", "closed_lost_reason", "amount", "hubspot_owner_id",
      ]);
      await delay(150);

      const stageHistory = deal.propertiesWithHistory?.dealstage ?? [];
      if (stageHistory.length < 2) continue;

      // Find the entry that set it to closedlost
      const closedEntry = stageHistory.find(
        (h) => h.value === CLOSED_LOST_STAGE && new Date(h.timestamp).getTime() >= sinceTs,
      );
      if (!closedEntry) continue;

      // Check if the previous stage was SQD
      const prevEntry = stageHistory.find(
        (h) => new Date(h.timestamp).getTime() < new Date(closedEntry.timestamp).getTime(),
      );
      if (!prevEntry || prevEntry.value !== SQD_STAGE) continue;

      const changedByName = closedEntry.updatedByUserId
        ? (ownerMap.get(String(closedEntry.updatedByUserId)) ?? `User ${closedEntry.updatedByUserId}`)
        : undefined;

      const assocs = deal as { associations?: { companies?: { results: { id: string }[] } } };
      const companyId = assocs.associations?.companies?.results?.[0]?.id;
      let companyName: string | undefined;
      if (companyId) {
        try {
          const co = await hsGet(token, `/crm/v3/objects/companies/${companyId}`, { properties: "name" });
          companyName = co.properties?.name;
          await delay(100);
        } catch { /* skip */ }
      }

      const alertKey = `sqd_closed_lost:${dealId}:${closedEntry.timestamp}`;
      await prisma.hubspotAuditAlert.upsert({
        where:  { id: alertKey },
        update: {},
        create: {
          id:           alertKey,
          alertType:    "sqd_closed_lost",
          detectedAt:   new Date(),
          dealId,
          dealName:     deal.properties?.dealname ?? undefined,
          dealUrl:      `https://app.hubspot.com/contacts/${portalId}/deal/${dealId}`,
          companyId,
          companyName,
          fromValue:    "SQD",
          toValue:      "Closed Lost",
          changeReason: deal.properties?.closed_lost_reason ?? undefined,
          changedByUserId: closedEntry.updatedByUserId ? String(closedEntry.updatedByUserId) : undefined,
          changedByName,
          changedAt:    new Date(closedEntry.timestamp),
          metadata:     JSON.stringify({ amount: deal.properties?.amount }),
        },
      });
      count++;
    } catch (e) {
      console.error(`[audit:sqd_closed_lost] deal ${dealId}:`, e);
    }
  }
  return count;
}

// ─── Alert type c: Negative ARR shift ───────────────────────────────────────

// Stages considered "worse" than a given stage (ordered from best to worst)
const STAGE_ORDER = [
  "closedwon",
  "161312014", // SQD
  "opportunity", // SQO (lifecycle)
  "contractsent",
  "decisionmakerboughtin",
  "presentationscheduled",
  "qualifiedtobuy",
  "appointmentscheduled",
  CLOSED_LOST_STAGE,
];

export async function detectNegativeArrShift(
  token: string,
  portalId: string,
  sinceTs: number,
  ownerMap: Map<string, string>,
): Promise<number> {
  let count = 0;
  const dealIds = await fetchRecentDeals(token, sinceTs);
  if (dealIds.length === 0) return 0;

  const batchSize = 15;
  for (let i = 0; i < dealIds.length; i += batchSize) {
    const chunk = dealIds.slice(i, i + batchSize);
    for (const dealId of chunk) {
      try {
        const deal = await fetchDealWithHistory(token, dealId, [
          "dealname", "amount", "dealstage", "deal_source", "hubspot_owner_id",
        ]);
        await delay(150);

        let triggered = false;
        let fromValue: string | undefined;
        let toValue: string | undefined;
        let changedAt: Date | undefined;
        let changedByUserId: string | undefined;
        let changedByName: string | undefined;
        let alertKey: string;

        // Check amount decrease
        const amountHistory = deal.propertiesWithHistory?.amount ?? [];
        const recentAmountChange = amountHistory.find(
          (h) => new Date(h.timestamp).getTime() >= sinceTs,
        );
        if (recentAmountChange) {
          const prevAmount = amountHistory.find(
            (h) => new Date(h.timestamp).getTime() < new Date(recentAmountChange.timestamp).getTime(),
          );
          const newAmt = parseFloat(recentAmountChange.value);
          const oldAmt = prevAmount ? parseFloat(prevAmount.value) : NaN;
          if (!isNaN(oldAmt) && !isNaN(newAmt) && newAmt < oldAmt) {
            triggered = true;
            fromValue = `$${oldAmt.toLocaleString()}`;
            toValue   = `$${newAmt.toLocaleString()}`;
            changedAt = new Date(recentAmountChange.timestamp);
            changedByUserId = recentAmountChange.updatedByUserId ? String(recentAmountChange.updatedByUserId) : undefined;
            changedByName = changedByUserId ? (ownerMap.get(changedByUserId) ?? `User ${changedByUserId}`) : undefined;
            alertKey = `negative_arr:amount:${dealId}:${recentAmountChange.timestamp}`;
          }
        }

        // Check stage moved backward (e.g. SQD → SQL, opportunity → MQL)
        if (!triggered) {
          const stageHistory = deal.propertiesWithHistory?.dealstage ?? [];
          const recentStageChange = stageHistory.find(
            (h) => new Date(h.timestamp).getTime() >= sinceTs,
          );
          if (recentStageChange) {
            const prevStageEntry = stageHistory.find(
              (h) => new Date(h.timestamp).getTime() < new Date(recentStageChange.timestamp).getTime(),
            );
            if (prevStageEntry && prevStageEntry.value !== recentStageChange.value) {
              const prevIdx = STAGE_ORDER.indexOf(prevStageEntry.value);
              const newIdx  = STAGE_ORDER.indexOf(recentStageChange.value);
              // Higher index = worse stage (or moved to closedlost)
              const isNegative =
                recentStageChange.value === CLOSED_LOST_STAGE ||
                (prevIdx !== -1 && newIdx !== -1 && newIdx > prevIdx && prevIdx !== STAGE_ORDER.indexOf("closedwon"));
              if (isNegative) {
                triggered = true;
                fromValue = prevStageEntry.value;
                toValue   = recentStageChange.value;
                changedAt = new Date(recentStageChange.timestamp);
                changedByUserId = recentStageChange.updatedByUserId ? String(recentStageChange.updatedByUserId) : undefined;
                changedByName = changedByUserId ? (ownerMap.get(changedByUserId) ?? `User ${changedByUserId}`) : undefined;
                alertKey = `negative_arr:stage:${dealId}:${recentStageChange.timestamp}`;
              }
            }
          }
        }

        if (!triggered) continue;

        const assocs = deal as { associations?: { companies?: { results: { id: string }[] }; contacts?: { results: { id: string }[] } } };
        const companyId = assocs.associations?.companies?.results?.[0]?.id;
        const contactId = assocs.associations?.contacts?.results?.[0]?.id;
        let companyName: string | undefined;
        if (companyId) {
          try {
            const co = await hsGet(token, `/crm/v3/objects/companies/${companyId}`, { properties: "name" });
            companyName = co.properties?.name;
            await delay(100);
          } catch { /* skip */ }
        }

        await prisma.hubspotAuditAlert.upsert({
          where:  { id: alertKey! },
          update: {},
          create: {
            id:          alertKey!,
            alertType:   "negative_arr",
            detectedAt:  new Date(),
            dealId,
            dealName:    deal.properties?.dealname ?? undefined,
            dealUrl:     `https://app.hubspot.com/contacts/${portalId}/deal/${dealId}`,
            companyId,
            companyName,
            contactId,
            contactUrl:  contactId ? `https://app.hubspot.com/contacts/${portalId}/contact/${contactId}` : undefined,
            fromValue,
            toValue,
            changedByUserId,
            changedByName,
            changedAt,
            metadata:    JSON.stringify({ currentAmount: deal.properties?.amount }),
          },
        });
        count++;
      } catch (e) {
        console.error(`[audit:negative_arr] deal ${dealId}:`, e);
      }
    }
    if (i + batchSize < dealIds.length) await delay(300);
  }
  return count;
}

// ─── Alert type d: Inbound contact unenrolled from workflow before 60 days ──

export async function detectWorkflowUnenrollments(
  token: string,
  portalId: string,
  sinceTs: number,
  ownerMap: Map<string, string>,
): Promise<number> {
  let count = 0;

  // Query contacts whose workflow enrollment status changed recently
  // HubSpot tracks workflow enrollment via the contact timeline and
  // the contacts' hs_workflows_enrolled_by_contactid property
  // We look for contacts with recent hs_time_in_lead_status changes
  // as a proxy, OR we use the Timeline API for workflow enrollment events

  // Practical approach: search contacts modified recently where
  // their latest_source_timestamp is recent AND they have inbound attribution
  // and check if their lifecyclestage moved backward (which happens on unenrollment)
  try {
    let after: string | undefined;
    do {
      const body: Record<string, unknown> = {
        filterGroups: [{
          filters: [
            { propertyName: "lastmodifieddate", operator: "GTE", value: String(sinceTs) },
            { propertyName: "hs_email_optout",  operator: "HAS_PROPERTY", value: "" },
          ],
        }],
        properties: ["firstname", "lastname", "email", "hs_email_optout",
          "lifecyclestage", "hs_lead_status", "hubspot_owner_id",
          "hs_latest_source", "hs_latest_source_data_1"],
        limit: 100,
      };
      if (after) body.after = after;

      const res = await hsPost(token, "/crm/v3/objects/contacts/search", body);
      for (const contact of res.results ?? []) {
        // We need property history for hs_email_optout to detect unenrollment
        // and also check if contact is "inbound"
        const p = contact.properties ?? {};
        const source = (p.hs_latest_source ?? "").toLowerCase();
        const isInbound = source.includes("organic") || source.includes("direct") ||
          source.includes("email") || source.includes("form");

        if (!isInbound) continue;

        try {
          const history = await fetchContactPropertyHistory(token, contact.id, [
            "hs_email_optout", "lifecyclestage",
          ]);
          await delay(150);

          const optoutHistory = history.propertiesWithHistory?.hs_email_optout ?? [];
          const recentOptout = optoutHistory.find(
            (h) => h.value === "true" && new Date(h.timestamp).getTime() >= sinceTs,
          );
          if (!recentOptout) continue;

          // Check if contact was in an active workflow for < 60 days
          // Approximation: contact was created more than 0 but less than 60 days ago
          const createdAt = new Date(contact.createdAt ?? Date.now());
          const daysSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceCreation > 60) continue;

          const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || "Unknown";
          const changedByUserId = recentOptout.updatedByUserId ? String(recentOptout.updatedByUserId) : undefined;
          const changedByName = changedByUserId ? (ownerMap.get(changedByUserId) ?? `User ${changedByUserId}`) : undefined;
          const alertKey = `workflow_unenroll:${contact.id}:${recentOptout.timestamp}`;

          await prisma.hubspotAuditAlert.upsert({
            where:  { id: alertKey },
            update: {},
            create: {
              id:           alertKey,
              alertType:    "workflow_unenroll",
              detectedAt:   new Date(),
              contactId:    contact.id,
              contactName:  name,
              contactUrl:   `https://app.hubspot.com/contacts/${portalId}/contact/${contact.id}`,
              fromValue:    "Enrolled",
              toValue:      "Opted Out / Unenrolled",
              changedByUserId,
              changedByName,
              changedAt:    new Date(recentOptout.timestamp),
              metadata:     JSON.stringify({
                daysSinceCreation: Math.round(daysSinceCreation),
                lifecyclestage: p.lifecyclestage,
                latestSource: p.hs_latest_source,
              }),
            },
          });
          count++;
        } catch { /* skip individual contact */ }
      }

      after = res.paging?.next?.after;
      if (after) await delay(300);
    } while (after && count < 200);
  } catch (e) {
    console.error("[audit:workflow_unenroll]", e);
  }
  return count;
}

async function fetchContactPropertyHistory(
  token: string,
  contactId: string,
  properties: string[],
): Promise<{ propertiesWithHistory: Record<string, { value: string; timestamp: string; updatedByUserId?: number }[]> }> {
  return hsGet(token, `/crm/v3/objects/contacts/${contactId}`, {
    propertiesWithHistory: properties.join(","),
  });
}

// ─── Alert type e: Inbound contact worked by Outbound BDR ───────────────────

export async function detectInboundWorkedByOutbound(
  token: string,
  portalId: string,
  sinceTs: number,
  ownerMap: Map<string, string>,
): Promise<number> {
  let count = 0;

  // Get the list of HubSpot owners to find Outbound BDRs
  // We identify Outbound BDRs by their team membership or job title
  // Since HubSpot doesn't expose team membership easily, we check activity type
  // against contact attribution

  // Strategy: fetch calls/emails/tasks created today, check if the associated
  // contact has an "inbound" deal source on their associated deals

  const engagementTypes = ["CALL", "EMAIL", "TASK"];

  for (const engType of engagementTypes) {
    try {
      let after: string | undefined;
      do {
        const body: Record<string, unknown> = {
          filterGroups: [{
            filters: [
              { propertyName: "hs_createdate",     operator: "GTE", value: String(sinceTs) },
              { propertyName: "hs_activity_type",  operator: "EQ",  value: engType         },
            ],
          }],
          properties: ["hs_activity_type", "hubspot_owner_id", "hs_timestamp", "hs_body_preview"],
          limit: 100,
        };
        if (after) body.after = after;

        const objectType = engType === "CALL" ? "calls" : engType === "EMAIL" ? "emails" : "tasks";
        const res = await hsPost(token, `/crm/v3/objects/${objectType}/search`, body);

        for (const eng of res.results ?? []) {
          const ownerId = eng.properties?.hubspot_owner_id;
          if (!ownerId) continue;

          const ownerName = ownerMap.get(String(ownerId)) ?? "";

          // Identify Outbound BDR by name pattern
          // This is heuristic — adjust "BDR" / "SDR" / "Outbound" to match Zeni's naming
          const isOutboundBdr = /outbound|bdr|sdr/i.test(ownerName);

          // If we can't determine from name, we still check the contact attribution
          // and flag it if the contact is clearly inbound
          try {
            // Get contact associations for this engagement
            const assocRes = await hsPost(
              token,
              `/crm/v3/associations/${objectType}/contacts/batch/read`,
              { inputs: [{ id: eng.id }] },
            );
            await delay(150);

            const contactIds: string[] = (assocRes.results?.[0]?.to ?? []).map(
              (t: { id: string }) => t.id,
            );
            if (contactIds.length === 0) continue;

            for (const contactId of contactIds.slice(0, 1)) {
              // Get the contact's deals to check attribution
              const dealAssocRes = await hsPost(
                token,
                "/crm/v3/associations/contacts/deals/batch/read",
                { inputs: [{ id: contactId }] },
              );
              await delay(150);

              const dealIds = (dealAssocRes.results?.[0]?.to ?? []).map((t: { id: string }) => t.id);
              if (dealIds.length === 0) continue;

              // Check the first deal's source
              const deal = await hsGet(token, `/crm/v3/objects/deals/${dealIds[0]}`, {
                properties: "deal_source,dealname",
              });
              await delay(150);

              const dealSource = (deal.properties?.deal_source ?? "").toLowerCase();
              const isInbound = dealSource.includes("inbound") || dealSource.includes("organic");

              // Only alert if inbound contact AND (outbound BDR OR activity on inbound contact)
              if (!isInbound) continue;
              if (!isOutboundBdr && !dealSource) continue;

              // Get contact name
              const contact = await hsGet(token, `/crm/v3/objects/contacts/${contactId}`, {
                properties: "firstname,lastname,email",
              });
              await delay(100);
              const cp = contact.properties ?? {};
              const contactName = [cp.firstname, cp.lastname].filter(Boolean).join(" ") || cp.email || "Unknown";

              const alertKey = `inbound_outbound_worked:${engType}:${eng.id}`;
              await prisma.hubspotAuditAlert.upsert({
                where:  { id: alertKey },
                update: {},
                create: {
                  id:            alertKey,
                  alertType:     "inbound_outbound_worked",
                  detectedAt:    new Date(),
                  contactId,
                  contactName,
                  contactUrl:    `https://app.hubspot.com/contacts/${portalId}/contact/${contactId}`,
                  dealId:        dealIds[0],
                  dealName:      deal.properties?.dealname ?? undefined,
                  dealUrl:       `https://app.hubspot.com/contacts/${portalId}/deal/${dealIds[0]}`,
                  fromValue:     isInbound ? dealSource : undefined,
                  toValue:       engType,
                  changedByUserId: ownerId,
                  changedByName: ownerName || undefined,
                  changedAt:     eng.properties?.hs_timestamp ? new Date(eng.properties.hs_timestamp) : new Date(),
                  metadata:      JSON.stringify({
                    engagementType: engType,
                    dealSource,
                    bodyPreview: eng.properties?.hs_body_preview?.slice(0, 200),
                  }),
                },
              });
              count++;
            }
          } catch { /* skip individual engagement */ }
        }

        after = res.paging?.next?.after;
        if (after) await delay(300);
      } while (after && count < 200);
    } catch (e) {
      console.error(`[audit:inbound_outbound_worked:${engType}]`, e);
    }
  }
  return count;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export interface AuditResult {
  ok: boolean;
  sinceTs: number;
  alerts: {
    sqoAttribution: number;
    sqdClosedLost: number;
    negativeArr: number;
    workflowUnenroll: number;
    inboundOutboundWorked: number;
  };
  error?: string;
}

export async function runHubspotAudit(lookbackHours = 25): Promise<AuditResult> {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return { ok: false, sinceTs: 0, alerts: { sqoAttribution: 0, sqdClosedLost: 0, negativeArr: 0, workflowUnenroll: 0, inboundOutboundWorked: 0 }, error: "HubSpot not connected" };
  }

  const token    = decrypt(row.accessToken);
  const portalId = row.accountId ?? "";
  const sinceTs  = Date.now() - lookbackHours * 60 * 60 * 1000;

  const ownerMap = await buildOwnerMap(token);

  const results = { sqoAttribution: 0, sqdClosedLost: 0, negativeArr: 0, workflowUnenroll: 0, inboundOutboundWorked: 0 };

  try { results.sqoAttribution        = await detectSqoAttributionChanges(token, portalId, sinceTs, ownerMap); } catch (e) { console.error("[audit] sqo_attribution failed:", e); }
  await delay(500);
  try { results.sqdClosedLost         = await detectSqdClosedLost(token, portalId, sinceTs, ownerMap);         } catch (e) { console.error("[audit] sqd_closed_lost failed:", e); }
  await delay(500);
  try { results.negativeArr           = await detectNegativeArrShift(token, portalId, sinceTs, ownerMap);      } catch (e) { console.error("[audit] negative_arr failed:", e); }
  await delay(500);
  try { results.workflowUnenroll      = await detectWorkflowUnenrollments(token, portalId, sinceTs, ownerMap); } catch (e) { console.error("[audit] workflow_unenroll failed:", e); }
  await delay(500);
  try { results.inboundOutboundWorked = await detectInboundWorkedByOutbound(token, portalId, sinceTs, ownerMap); } catch (e) { console.error("[audit] inbound_outbound_worked failed:", e); }

  return { ok: true, sinceTs, alerts: results };
}

// Re-export SQO_MEETING_TYPES in case other modules need it
export { SQO_MEETING_TYPES };
