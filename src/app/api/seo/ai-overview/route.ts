import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkAiOverview } from "@/lib/integrations/dataforseo";
import { KEYWORD_PILLARS } from "@/lib/seo-pillars";

export const dynamic    = "force-dynamic";
export const maxDuration = 120;

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function GET() {
  const checks = await prisma.aiOverviewCheck.findMany({
    orderBy: { checkedAt: "desc" },
  });

  const seen   = new Set<string>();
  const latest = checks.filter(c => {
    if (seen.has(c.query)) return false;
    seen.add(c.query);
    return true;
  });

  return NextResponse.json({ checks: latest });
}

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  if (searchParams.get("all") === "1") {
    const customQueries = await prisma.aeoCustomQuery.findMany({
      where: { active: true },
    });

    const pillarQueries = KEYWORD_PILLARS.map(p => ({
      label: p.label,
      query: p.seeds[0],
    }));

    const customEntries = customQueries.map(q => ({
      label: q.label,
      query: q.query,
    }));

    const seen = new Set<string>();
    const allEntries = [...pillarQueries, ...customEntries].filter(e => {
      if (seen.has(e.query)) return false;
      seen.add(e.query);
      return true;
    });

    const results = [];

    for (let i = 0; i < allEntries.length; i++) {
      const { query } = allEntries[i];
      if (i > 0) await delay(400);

      try {
        const result = await checkAiOverview(query);
        const row = await prisma.aiOverviewCheck.create({
          data: {
            query,
            hasOverview: result.hasOverview,
            zeniCited:   result.zeniCited,
            overviewText: result.overviewText?.slice(0, 500) ?? null,
            citedUrls:   JSON.stringify(result.citedItems),
            allResults:  JSON.stringify(result.topOrganic),
          },
        });
        results.push(row);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("credentials not configured")) {
          return NextResponse.json({ error: "DataForSEO credentials not configured" }, { status: 400 });
        }
        results.push({ query, error: message });
      }
    }

    return NextResponse.json({ ok: true, checked: allEntries.length, results });
  }

  let body: { query?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.query?.trim()) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  const query = body.query.trim();

  try {
    const result = await checkAiOverview(query);
    const row = await prisma.aiOverviewCheck.create({
      data: {
        query,
        hasOverview: result.hasOverview,
        zeniCited:   result.zeniCited,
        overviewText: result.overviewText?.slice(0, 500) ?? null,
        citedUrls:   JSON.stringify(result.citedItems),
        allResults:  JSON.stringify(result.topOrganic),
      },
    });
    return NextResponse.json({ ok: true, check: row });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("credentials not configured")) {
      return NextResponse.json({ error: "DataForSEO credentials not configured" }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
