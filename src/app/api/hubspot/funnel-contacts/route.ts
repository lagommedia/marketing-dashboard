import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const BASE = "https://api.hubapi.com";

const LIFECYCLE_MQL_STAGES = ["marketingqualifiedlead", "salesqualifiedlead", "opportunity", "customer"];
const ACTIVE_PIPELINE_STAGES = ["qualifiedtobuy", "decisionmakerboughtin", "6181928", "179383700"];
const CLOSED_WON_STAGE = "closedwon";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hsFetch(token: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const metric = searchParams.get("metric"); // mqls | sqos | closedwon
  const from   = searchParams.get("from");   // YYYY-MM-DD
  const to     = searchParams.get("to");     // YYYY-MM-DD

  if (!metric || !from || !to) {
    return NextResponse.json({ error: "metric, from, to required" }, { status: 400 });
  }

  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return NextResponse.json({ error: "HubSpot not connected" }, { status: 503 });
  }

  const token    = decrypt(row.accessToken);
  const portalId = row.accountId ?? "";

  const fromTs = new Date(from + "T00:00:00Z").getTime();
  const toTs   = new Date(to   + "T23:59:59Z").getTime();

  try {
    // ── MQLs: contacts created in range with lifecycle stage >= MQL ─────────
    if (metric === "mqls") {
      const res = await hsFetch(token, "/crm/v3/objects/contacts/search", {
        filterGroups: LIFECYCLE_MQL_STAGES.map(stage => ({
          filters: [
            { propertyName: "createdate",     operator: "GTE", value: String(fromTs) },
            { propertyName: "createdate",     operator: "LTE", value: String(toTs)   },
            { propertyName: "lifecyclestage", operator: "EQ",  value: stage          },
          ],
        })),
        properties: ["firstname", "lastname", "email"],
        sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
        limit: 100,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contacts = (res.results ?? []).map((c: any) => {
        const p = c.properties ?? {};
        const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || "Unknown";
        return { name, url: `https://app.hubspot.com/contacts/${portalId}/contact/${c.id}` };
      });

      return NextResponse.json({ contacts });
    }

    // ── SQOs: deals in active pipeline stages created in range ──────────────
    if (metric === "sqos") {
      const res = await hsFetch(token, "/crm/v3/objects/deals/search", {
        filterGroups: ACTIVE_PIPELINE_STAGES.map(stage => ({
          filters: [
            { propertyName: "createdate", operator: "GTE", value: String(fromTs) },
            { propertyName: "createdate", operator: "LTE", value: String(toTs)   },
            { propertyName: "dealstage",  operator: "EQ",  value: stage          },
          ],
        })),
        properties: ["dealname", "amount", "dealstage"],
        sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
        limit: 100,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contacts = (res.results ?? []).map((d: any) => {
        const p = d.properties ?? {};
        return {
          name: p.dealname || "Unnamed Deal",
          url: `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`,
        };
      });

      return NextResponse.json({ contacts });
    }

    // ── Closed Won: deals closed in range ───────────────────────────────────
    if (metric === "closedwon") {
      const res = await hsFetch(token, "/crm/v3/objects/deals/search", {
        filterGroups: [{
          filters: [
            { propertyName: "closedate",  operator: "GTE", value: String(fromTs)       },
            { propertyName: "closedate",  operator: "LTE", value: String(toTs)         },
            { propertyName: "dealstage",  operator: "EQ",  value: CLOSED_WON_STAGE     },
          ],
        }],
        properties: ["dealname", "amount"],
        sorts: [{ propertyName: "closedate", direction: "ASCENDING" }],
        limit: 100,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contacts = (res.results ?? []).map((d: any) => {
        const p = d.properties ?? {};
        const amt = p.amount
          ? ` — $${parseFloat(p.amount).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
          : "";
        return {
          name: (p.dealname || "Unnamed Deal") + amt,
          url: `https://app.hubspot.com/contacts/${portalId}/deal/${d.id}`,
        };
      });

      return NextResponse.json({ contacts });
    }

    return NextResponse.json({ error: "Invalid metric" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "HubSpot fetch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
