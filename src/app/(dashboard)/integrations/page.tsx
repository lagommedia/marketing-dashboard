import { prisma } from "@/lib/db";
import { PLATFORMS } from "@/lib/platforms";
import { IntegrationsClient } from "./IntegrationsClient";
import type { IntegrationStatus } from "@/types";

export const dynamic = "force-dynamic";

async function getIntegrationStatuses(): Promise<IntegrationStatus[]> {
  const rows = await prisma.integration.findMany({
    select: {
      id: true,
      platform: true,
      connected: true,
      clientId: true,
      accountId: true,
      accountName: true,
      lastSyncedAt: true,
    },
  });

  type IntegrationRow = (typeof rows)[number];
  const platformStatuses = PLATFORMS.map((p) => {
    const row = rows.find((r: IntegrationRow) => r.platform === p.id);
    return {
      id: row?.id ?? "",
      platform: p.id,
      connected: row?.connected ?? false,
      hasCredentials: !!row?.clientId,
      accountId: row?.accountId,
      accountName: row?.accountName,
      lastSyncedAt: row?.lastSyncedAt,
    };
  });

  // Add organic-only integrations not in PLATFORMS
  const organicPlatforms: import("@/types").Platform[] = ["linkedin_organic", "facebook"];
  for (const platform of organicPlatforms) {
    if (!platformStatuses.find(s => s.platform === platform)) {
      const row = rows.find(r => r.platform === platform);
      platformStatuses.push({
        id: row?.id ?? "",
        platform,
        connected: row?.connected ?? false,
        hasCredentials: !!row?.clientId,
        accountId: row?.accountId,
        accountName: row?.accountName,
        lastSyncedAt: row?.lastSyncedAt,
      });
    }
  }

  return platformStatuses;
}

async function getLinkedinOrgUrn(): Promise<string | null> {
  const row = await prisma.integration.findUnique({
    where:  { platform: "linkedin_organic" },
    select: { tokenSecret: true },
  });
  const v = row?.tokenSecret;
  return v?.startsWith("urn:li:organization:") ? v : null;
}

export default async function IntegrationsPage() {
  const [statuses, linkedinOrgUrn] = await Promise.all([
    getIntegrationStatuses(),
    getLinkedinOrgUrn(),
  ]);

  const connected = statuses.filter((s) => s.connected).length;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Integrations</h1>
        <p className="text-sm text-slate-500 mt-1">
          Connect your data sources to populate the dashboard. Data syncs automatically
          every 24 hours.
        </p>
        <div className="flex items-center gap-2 mt-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600 bg-slate-100 px-3 py-1.5 rounded-full">
            <span
              className={`w-2 h-2 rounded-full ${connected > 0 ? "bg-emerald-500" : "bg-slate-300"}`}
            />
            {connected} of {PLATFORMS.length} connected
          </div>
        </div>
      </div>

      {/* Channel groups */}
      <IntegrationsClient statuses={statuses} linkedinOrgUrn={linkedinOrgUrn} />
    </div>
  );
}
