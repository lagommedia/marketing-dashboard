import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { KEYWORD_PILLARS, isBranded, getPillarForQuery } from "@/lib/seo-pillars";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp       = req.nextUrl.searchParams;
  const segment  = (sp.get("segment") ?? "non-branded") as "branded" | "non-branded" | "all";
  const fromStr  = sp.get("from");
  const toStr    = sp.get("to");

  const from = fromStr ? new Date(fromStr + "T00:00:00") : (() => { const d = new Date(); d.setDate(d.getDate() - 90); return d; })();
  const to   = toStr   ? new Date(toStr   + "T23:59:59") : new Date();

  // Load all query rows in range
  const rows = await prisma.gscQuerySnapshot.findMany({
    where: { date: { gte: from, lte: to } },
    select: { query: true, clicks: true, impressions: true, ctr: true, position: true, date: true },
  });

  // Separate branded vs non-branded
  const filtered = rows.filter(r => {
    if (segment === "all") return true;
    return segment === "branded" ? isBranded(r.query) : !isBranded(r.query);
  });

  // Overall totals
  const totalImpressions = filtered.reduce((s, r) => s + r.impressions, 0);
  const totalClicks      = filtered.reduce((s, r) => s + r.clicks,      0);
  const overallCtr       = totalImpressions > 0 ? totalClicks / totalImpressions : null;
  const positionRows     = filtered.filter(r => r.position != null);
  const avgPosition      = positionRows.length > 0
    ? positionRows.reduce((s, r) => s + (r.position ?? 0), 0) / positionRows.length
    : null;

  // Midpoint used for first-half vs second-half position change (pillar + query level)
  const midpoint = new Date((from.getTime() + to.getTime()) / 2);

  // Pillar breakdown
  const pillarMap   = new Map<string, { clicks: number; impressions: number; posSum: number; posCount: number; topQueries: Map<string, { clicks: number; impressions: number; position: number | null }> }>();
  const pillarFirst = new Map<string, { posSum: number; posCount: number }>();
  const pillarLast  = new Map<string, { posSum: number; posCount: number }>();
  for (const p of KEYWORD_PILLARS) {
    pillarMap.set(p.id, { clicks: 0, impressions: 0, posSum: 0, posCount: 0, topQueries: new Map() });
    pillarFirst.set(p.id, { posSum: 0, posCount: 0 });
    pillarLast.set(p.id,  { posSum: 0, posCount: 0 });
  }

  for (const row of filtered) {
    const pillar = getPillarForQuery(row.query);
    if (!pillar) continue;
    const bucket = pillarMap.get(pillar.id)!;
    bucket.clicks      += row.clicks;
    bucket.impressions += row.impressions;
    if (row.position != null) { bucket.posSum += row.position; bucket.posCount++; }

    const qb = bucket.topQueries.get(row.query) ?? { clicks: 0, impressions: 0, position: null };
    qb.clicks      += row.clicks;
    qb.impressions += row.impressions;
    if (row.position != null) qb.position = row.position;
    bucket.topQueries.set(row.query, qb);

    if (row.position != null) {
      const half = row.date < midpoint ? pillarFirst : pillarLast;
      const h = half.get(pillar.id)!;
      h.posSum += row.position; h.posCount++;
    }
  }

  const pillars = KEYWORD_PILLARS.map(p => {
    const b = pillarMap.get(p.id)!;
    const pillarCtr = b.impressions > 0 ? b.clicks / b.impressions : null;
    const avgPos    = b.posCount > 0 ? b.posSum / b.posCount : null;
    const topQueries = [...b.topQueries.entries()]
      .map(([q, d]) => ({ query: q, ...d, ctr: d.impressions > 0 ? d.clicks / d.impressions : null }))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10);
    const pf = pillarFirst.get(p.id)!;
    const pl = pillarLast.get(p.id)!;
    const positionChange = pf.posCount > 0 && pl.posCount > 0
      ? (pf.posSum / pf.posCount) - (pl.posSum / pl.posCount)
      : null;
    return { ...p, clicks: b.clicks, impressions: b.impressions, ctr: pillarCtr, avgPosition: avgPos, positionChange, topQueries };
  });

  // Top queries overall (for the "All Queries" panel)
  const queryAgg   = new Map<string, { clicks: number; impressions: number; posSum: number; posCount: number }>();
  const queryFirst = new Map<string, { posSum: number; posCount: number }>();
  const queryLast  = new Map<string, { posSum: number; posCount: number }>();

  for (const row of filtered) {
    const a = queryAgg.get(row.query) ?? { clicks: 0, impressions: 0, posSum: 0, posCount: 0 };
    a.clicks += row.clicks; a.impressions += row.impressions;
    if (row.position != null) { a.posSum += row.position; a.posCount++; }
    queryAgg.set(row.query, a);

    if (row.position != null) {
      const half = row.date < midpoint ? queryFirst : queryLast;
      const h = half.get(row.query) ?? { posSum: 0, posCount: 0 };
      h.posSum += row.position; h.posCount++;
      half.set(row.query, h);
    }
  }

  const topQueries = [...queryAgg.entries()]
    .map(([q, d]) => {
      const first = queryFirst.get(q);
      const last  = queryLast.get(q);
      const positionChange =
        first && last && first.posCount > 0 && last.posCount > 0
          ? (first.posSum / first.posCount) - (last.posSum / last.posCount)
          : null;
      return {
        query: q,
        clicks: d.clicks,
        impressions: d.impressions,
        ctr: d.impressions > 0 ? d.clicks / d.impressions : null,
        avgPosition: d.posCount > 0 ? d.posSum / d.posCount : null,
        positionChange,  // positive = improved (moved closer to #1), negative = declined
      };
    })
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 25);

  // Daily series for sparklines — aggregate filtered rows by date
  const dateMap = new Map<string, { impressions: number; clicks: number; posSum: number; posCount: number }>();
  for (const row of filtered) {
    const key  = row.date.toISOString().slice(0, 10);
    const prev = dateMap.get(key) ?? { impressions: 0, clicks: 0, posSum: 0, posCount: 0 };
    prev.impressions += row.impressions;
    prev.clicks      += row.clicks;
    if (row.position != null) { prev.posSum += row.position; prev.posCount++; }
    dateMap.set(key, prev);
  }
  const dailySeries = [...dateMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      impressions:  d.impressions,
      clicks:       d.clicks,
      ctr:          d.impressions > 0 ? d.clicks / d.impressions : null,
      avgPosition:  d.posCount > 0 ? d.posSum / d.posCount : null,
    }));

  const lastSyncedAt = await prisma.gscQuerySnapshot.findFirst({
    orderBy: { createdAt: "desc" }, select: { createdAt: true },
  });

  return NextResponse.json({
    segment,
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
    totals: { impressions: totalImpressions, clicks: totalClicks, ctr: overallCtr, avgPosition },
    dailySeries,
    pillars,
    topQueries,
    hasData: rows.length > 0,
    lastSyncedAt: lastSyncedAt?.createdAt ?? null,
  });
}
