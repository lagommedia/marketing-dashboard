/**
 * GET /api/integrations/hubspot/properties
 *
 * Diagnostic endpoint — fetches the actual property names and enum options
 * from your HubSpot account so we can confirm the correct internal names for:
 *   • hs_analytics_source  (contact)
 *   • deal_source_detail_1 (deal)
 *   • lifecyclestage       (contact)
 *
 * Open this URL in your browser after connecting HubSpot.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

const BASE = "https://api.hubapi.com";

async function fetchProperty(token: string, objectType: string, propertyName: string) {
  const res = await fetch(`${BASE}/crm/v3/properties/${objectType}/${propertyName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { error: `${res.status}: ${text.slice(0, 300)}` };
  }
  const data = await res.json();
  return {
    name:        data.name,
    label:       data.label,
    type:        data.type,
    fieldType:   data.fieldType,
    options:     (data.options ?? []).map((o: { value: string; label: string }) => ({
      value: o.value,
      label: o.label,
    })),
  };
}

async function searchContacts(token: string, filters: object) {
  const res = await fetch(`${BASE}/crm/v3/objects/contacts/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(filters),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { error: `${res.status}: ${text.slice(0, 300)}` };
  }
  return res.json();
}

export async function GET() {
  try {
    const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
    if (!row?.accessToken) {
      return NextResponse.json({ error: "HubSpot not connected" }, { status: 400 });
    }
    const token = decrypt(row.accessToken);

    // Fetch property definitions in parallel
    const [analyticsSource, lifecycleStage, dealSourceDetail, dealSource, dealSourceHs] = await Promise.all([
      fetchProperty(token, "contacts", "hs_analytics_source"),
      fetchProperty(token, "contacts", "lifecyclestage"),
      fetchProperty(token, "deals",    "deal_source_detail_1"),
      fetchProperty(token, "deals",    "deal_source"),      // custom high-level source
      fetchProperty(token, "deals",    "hs_analytics_source"), // standard HubSpot deal source
    ]);

    // Try a minimal contact search to verify filter works
    const testSearchResult = await searchContacts(token, {
      filterGroups: [{
        filters: [
          { propertyName: "createdate", operator: "GTE", value: "1" },
        ],
      }],
      properties: ["lifecyclestage"],
      limit: 1,
    });

    // Try a source-filtered search to verify IN filter works
    const testSourceFilter = await searchContacts(token, {
      filterGroups: [{
        filters: [
          { propertyName: "createdate",          operator: "GTE", value: "1" },
          { propertyName: "hs_analytics_source", operator: "IN",  values: ["PAID_SEARCH"] },
        ],
      }],
      properties: ["lifecyclestage"],
      limit: 1,
    });

    // Fetch meeting properties to find "Call and meeting type" internal name
    const meetingPropsRes = await fetch(`${BASE}/crm/v3/properties/meetings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meetingPropsData = meetingPropsRes.ok ? await meetingPropsRes.json() : { error: meetingPropsRes.status };
    const meetingProps = (meetingPropsData.results ?? [])
      .filter((p: { name: string; label: string; type: string }) =>
        ["outcome", "title", "type", "source"].some(kw => p.name.toLowerCase().includes(kw)) ||
        ["outcome", "title", "type", "source"].some(kw => p.label.toLowerCase().includes(kw))
      )
      .map((p: { name: string; label: string; type: string; options?: { value: string; label: string }[] }) => ({
        name:    p.name,
        label:   p.label,
        type:    p.type,
        options: (p.options ?? []).slice(0, 20).map((o: { value: string; label: string }) => ({ value: o.value, label: o.label })),
      }));

    // Test a completed meeting search to verify the API works
    const meetingSearchRes = await fetch(`${BASE}/crm/v3/objects/meetings/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        filterGroups: [{ filters: [
          { propertyName: "hs_meeting_outcome", operator: "EQ", value: "COMPLETED" },
        ]}],
        properties: ["hs_meeting_outcome", "hs_meeting_title", "hs_timestamp", "hs_call_and_meeting_type"],
        limit: 3,
      }),
    });
    const meetingSearch = meetingSearchRes.ok ? await meetingSearchRes.json() : { error: meetingSearchRes.status };

    // Fetch deal pipeline stages
    const pipelinesRes = await fetch(`${BASE}/crm/v3/pipelines/deals`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const pipelinesData = pipelinesRes.ok ? await pipelinesRes.json() : { error: pipelinesRes.status };
    const pipelines = (pipelinesData.results ?? []).map((p: {
      id: string; label: string;
      stages: { id: string; label: string; displayOrder: number; metadata: { probability: string } }[]
    }) => ({
      id:     p.id,
      label:  p.label,
      stages: (p.stages ?? [])
        .sort((a: { displayOrder: number }, b: { displayOrder: number }) => a.displayOrder - b.displayOrder)
        .map((s: { id: string; label: string; displayOrder: number; metadata: { probability: string } }) => ({
          id:           s.id,
          label:        s.label,
          displayOrder: s.displayOrder,
          probability:  s.metadata?.probability,
        })),
    }));

    return NextResponse.json({
      contact_properties: {
        hs_analytics_source: analyticsSource,
        lifecyclestage:      lifecycleStage,
      },
      deal_properties: {
        deal_source_detail_1:  dealSourceDetail,
        deal_source:           dealSource,
        hs_analytics_source:   dealSourceHs,
      },
      meeting_properties: meetingProps,
      meeting_search_sample: meetingSearch.total !== undefined
        ? { ok: true, total: meetingSearch.total, sample: meetingSearch.results?.slice(0, 2) }
        : meetingSearch,
      deal_pipelines: pipelines,
      test_searches: {
        minimal_search:       testSearchResult.total !== undefined
          ? { ok: true, total: testSearchResult.total }
          : testSearchResult,
        source_IN_filter:     testSourceFilter.total !== undefined
          ? { ok: true, total: testSourceFilter.total }
          : testSourceFilter,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
