import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const HS_BASE = "https://api.hubapi.com";

// Temporary diagnostic — fetches a handful of organic MQL contacts and dumps
// ALL their non-empty properties so we can identify where the keyword is stored.
// DELETE after investigation.

export async function GET() {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return NextResponse.json({ error: "HubSpot not connected" }, { status: 503 });
  }
  const token = decrypt(row.accessToken);

  // Fetch all contact property definitions to get a full list of names
  const propsRes = await fetch(`${HS_BASE}/crm/v3/properties/contacts?limit=500`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const propsData = await propsRes.json();
  const allPropNames: string[] = (propsData.results ?? []).map((p: { name: string }) => p.name);

  // Search for recent organic MQL contacts — filter by became_an_mql_date and
  // try to narrow to organic by checking mql_source in a second pass.
  const searchRes = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      filterGroups: [{
        filters: [{ propertyName: "became_an_mql_date", operator: "GTE", value: "0" }],
      }],
      properties: [
        "became_an_mql_date", "mql_source", "mql_source_details_1", "mql_source_details_2",
        // common HubSpot keyword/search properties
        "hs_analytics_source", "hs_analytics_source_data_1", "hs_analytics_source_data_2",
        "hs_analytics_last_search_term", "hs_analytics_last_url",
        "hs_latest_source", "hs_latest_source_data_1", "hs_latest_source_data_2",
        // utm fields
        "hs_analytics_first_url", "hs_analytics_first_referrer",
      ],
      limit: 100,
    }),
  });
  const searchData = await searchRes.json();

  // Client-side filter for organic contacts
  const organicContacts = (searchData.results ?? []).filter((c: { properties: Record<string, string | null> }) => {
    const src = (c.properties.mql_source ?? "").toLowerCase();
    return /organic|seo|referr|blog|content/.test(src);
  }).slice(0, 10);

  // For each organic contact, batch-read ALL properties to see everything
  const ids = organicContacts.map((c: { id: string }) => c.id);
  const batchRes = await fetch(`${HS_BASE}/crm/v3/objects/contacts/batch/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: allPropNames.slice(0, 200), // batch read up to 200 props
      inputs: ids.map((id: string) => ({ id })),
    }),
  });
  const batchData = await batchRes.json();

  const samples = (batchData.results ?? []).map((c: { id: string; properties: Record<string, string | null> }) => ({
    id: c.id,
    properties: Object.fromEntries(
      Object.entries(c.properties).filter(([, v]) => v != null && v !== "")
    ),
  }));

  // Also list any properties whose name contains keyword/search/term/query/utm
  const relevantProps = (propsData.results ?? [])
    .filter((p: { name: string; label: string }) =>
      /keyword|search_term|query|utm_term|seo_term|organic_keyword/i.test(p.name + " " + p.label)
    )
    .map((p: { name: string; label: string; type: string }) => ({
      name: p.name, label: p.label, type: p.type,
    }));

  return NextResponse.json({ relevantProps, samples });
}
