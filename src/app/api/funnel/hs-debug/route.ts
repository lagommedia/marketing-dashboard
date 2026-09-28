import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";

export const dynamic = "force-dynamic";

const HS_BASE = "https://api.hubapi.com";

// Temporary diagnostic endpoint — lists property names + values for a few
// recent contacts so we can identify the correct API names for:
//   - MQL date field
//   - Source / source detail fields
// DELETE this route once the attribution route is working correctly.

export async function GET() {
  const row = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
  if (!row?.connected || !row.accessToken) {
    return NextResponse.json({ error: "HubSpot not connected" }, { status: 503 });
  }
  const token = decrypt(row.accessToken);

  // Fetch all contact property definitions so we can find the right names
  const propsRes = await fetch(`${HS_BASE}/crm/v3/properties/contacts?limit=500`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const propsData = await propsRes.json();

  // Filter to properties that look relevant: mql, source, lifecycle, analytics
  const relevant = (propsData.results ?? [])
    .filter((p: { name: string; label: string }) =>
      /mql|source|lifecycle|analytics|keyword|campaign|utm/i.test(p.name + " " + p.label)
    )
    .map((p: { name: string; label: string; type: string; fieldType: string }) => ({
      name:      p.name,
      label:     p.label,
      type:      p.type,
      fieldType: p.fieldType,
    }));

  // Also fetch 3 recent contacts with ALL their properties to see real values
  const searchRes = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      filterGroups: [
        { filters: [{ propertyName: "createdate", operator: "GTE", value: "0" }] },
      ],
      properties: relevant.map((p: { name: string }) => p.name),
      limit: 5,
    }),
  });

  const searchData = await searchRes.json();
  const samples = (searchData.results ?? []).map((c: { id: string; properties: Record<string, string | null> }) => ({
    id: c.id,
    // Only return non-null property values so the output is readable
    properties: Object.fromEntries(
      Object.entries(c.properties).filter(([, v]) => v != null && v !== "")
    ),
  }));

  return NextResponse.json({ relevantProperties: relevant, samples });
}
