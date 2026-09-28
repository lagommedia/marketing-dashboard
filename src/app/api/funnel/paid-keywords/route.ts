import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const HS_BASE = "https://api.hubapi.com";

interface HsContact {
  properties: Record<string, string | null>;
}

async function fetchPaidSearchContacts(
  token: string,
  fromMs: number,
  toMs: number,
): Promise<HsContact[]> {
  const all: HsContact[] = [];
  let after: string | undefined;

  const properties = [
    "hs_analytics_source",
    "hs_analytics_source_data_1",
    "hs_analytics_source_data_2",
    "hs_lifecyclestage_marketingqualifiedlead_date",
    "hs_lifecyclestage_salesqualifiedlead_date",
    "hs_lifecyclestage_customer_date",
  ];

  do {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            { propertyName: "hs_lifecyclestage_marketingqualifiedlead_date", operator: "GTE", value: String(fromMs) },
            { propertyName: "hs_lifecyclestage_marketingqualifiedlead_date", operator: "LTE", value: String(toMs)   },
            { propertyName: "hs_analytics_source", operator: "EQ", value: "PAID_SEARCH" },
          ],
        },
      ],
      properties,
      limit: 200,
      sorts: [{ propertyName: "hs_lifecyclestage_marketingqualifiedlead_date", direction: "DESCENDING" }],
    };
    if (after) body.after = after;

    const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HubSpot contacts ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    all.push(...(data.results ?? []));
    after = data.paging?.next?.after ?? undefined;
  } while (after && all.length < 1000);

  return all;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to   = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  const fromMs = new Date(from + "T00:00:00").getTime();
  const toMs   = new Date(to   + "T23:59:59").getTime();

  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return NextResponse.json({ error: "HubSpot not connected" }, { status: 503 });
  }
  const token = decrypt(row.accessToken);

  try {
    const contacts = await fetchPaidSearchContacts(token, fromMs, toMs);

    type KeywordRow = {
      keyword:   string;
      network:   string | null; // hs_analytics_source_data_1 (e.g. "google", "bing")
      mqls:      number;
      sqos:      number;
      customers: number;
    };

    const groups = new Map<string, KeywordRow>();

    for (const c of contacts) {
      const p = c.properties;

      // hs_analytics_source_data_2 = keyword for paid search
      const raw     = p.hs_analytics_source_data_2?.trim() || null;
      const keyword = raw && raw !== "(not provided)" && raw !== "not provided" ? raw : "(unknown keyword)";
      const network = p.hs_analytics_source_data_1?.trim() || null;

      const mqlDate      = p.hs_lifecyclestage_marketingqualifiedlead_date;
      const sqoDate      = p.hs_lifecyclestage_salesqualifiedlead_date;
      const customerDate = p.hs_lifecyclestage_customer_date;

      const isSqo      = sqoDate      != null && mqlDate != null && new Date(sqoDate)      >= new Date(mqlDate);
      const isCustomer = customerDate != null && mqlDate != null && new Date(customerDate) >= new Date(mqlDate);

      if (!groups.has(keyword)) {
        groups.set(keyword, { keyword, network, mqls: 0, sqos: 0, customers: 0 });
      }
      const g = groups.get(keyword)!;
      g.mqls++;
      if (isSqo)      g.sqos++;
      if (isCustomer) g.customers++;
    }

    const rows = [...groups.values()]
      .sort((a, b) => b.mqls - a.mqls)
      .map(g => ({
        keyword:        g.keyword,
        network:        g.network,
        mqls:           g.mqls,
        sqos:           g.sqos,
        customers:      g.customers,
        mqlToSqo:       g.mqls > 0 ? g.sqos      / g.mqls : 0,
        sqoToCustomer:  g.sqos > 0 ? g.customers / g.sqos  : 0,
      }));

    return NextResponse.json({ from, to, total: contacts.length, rows });
  } catch (err) {
    console.error("[funnel/paid-keywords]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
