import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/debug/hs-properties?q=segment&object=deal
 *
 * Searches HubSpot property definitions for all objects (deal, contact, company)
 * and returns any property whose name or label contains the query string.
 * Useful for finding the internal API name of a field visible in the HubSpot UI.
 */

async function hubspotFetch(token: string, path: string) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`HubSpot ${path} → ${res.status}`);
  return res.json();
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q       = (searchParams.get("q") ?? "segment").toLowerCase();
    const objects = (searchParams.get("object") ?? "deal,contact,company").split(",");

    const integration = await prisma.integration.findUnique({ where: { platform: "hubspot" } });
    if (!integration?.accessToken) {
      return NextResponse.json({ error: "HubSpot not connected" }, { status: 400 });
    }

    const { decrypt } = await import("@/lib/encryption");
    const token = decrypt(integration.accessToken);

    const results: Record<string, { name: string; label: string; type: string; fieldType: string }[]> = {};

    for (const obj of objects) {
      const data = await hubspotFetch(token, `/crm/v3/properties/${obj.trim()}`);
      results[obj] = (data.results ?? [])
        .filter((p: { name: string; label: string }) =>
          p.name.toLowerCase().includes(q) || p.label.toLowerCase().includes(q)
        )
        .map((p: { name: string; label: string; type: string; fieldType: string }) => ({
          name:      p.name,
          label:     p.label,
          type:      p.type,
          fieldType: p.fieldType,
        }));
    }

    return NextResponse.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
