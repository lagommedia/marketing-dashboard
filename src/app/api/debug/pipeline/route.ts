import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

async function hs(token: string, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

/**
 * GET /api/debug/pipeline
 * Fetches 3 deals, looks up their company associations, then reads new_segment.
 * Returns every raw intermediate response so we can see exactly where it breaks.
 */
export async function GET() {
  try {
    const integration = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
    if (!integration?.accessToken) return NextResponse.json({ error: "HubSpot not connected" }, { status: 400 });
    const token = decrypt(integration.accessToken);

    // Step 1 — grab 3 deals
    const dealsRes = await hs(token, "POST", "/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [{ propertyName: "createdate", operator: "GTE", value: String(Date.now() - 90 * 86400_000) }] }],
      properties: ["dealname", "amount", "createdate"],
      limit: 3,
    });
    const deals = (dealsRes.results ?? []).map((d: { id: string; properties: Record<string, string> }) => ({
      id: d.id,
      name: d.properties?.dealname,
      amount: d.properties?.amount,
    }));
    const dealIds = deals.map((d: { id: string }) => d.id);

    // Step 2 — v4 batch associations
    const assocRes = await hs(token, "POST", "/crm/v4/associations/deal/company/batch/read", {
      inputs: dealIds.map((id: string) => ({ id })),
    });

    // Step 3 — pull out company IDs from whatever structure comes back
    const sampleResult = assocRes.results?.[0];
    const companyIds: string[] = [];
    for (const r of assocRes.results ?? []) {
      for (const t of r.to ?? []) {
        const cid = t.toObjectId ?? t.id ?? t.objectId;
        if (cid) companyIds.push(String(cid));
      }
    }

    // Step 4 — batch read new_segment from companies
    let companiesRes = null;
    if (companyIds.length > 0) {
      companiesRes = await hs(token, "POST", "/crm/v3/objects/companies/batch/read", {
        inputs: [...new Set(companyIds)].map((id) => ({ id })),
        properties: ["name", "new_segment"],
      });
    }

    return NextResponse.json({
      deals,
      assoc_raw_first_result: sampleResult,
      company_ids_found: companyIds,
      companies_raw: companiesRes?.results?.map((c: { id: string; properties: Record<string, string> }) => ({
        id: c.id,
        name: c.properties?.name,
        new_segment: c.properties?.new_segment,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
