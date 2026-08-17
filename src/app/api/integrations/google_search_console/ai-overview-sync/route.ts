import { NextRequest, NextResponse } from "next/server";
import { syncAiOverviewQueries } from "@/lib/integrations/google-search-console";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const fromStr = (body.from as string) ?? (() => {
      const d = new Date();
      d.setDate(d.getDate() - 90);
      return d.toISOString().slice(0, 10);
    })();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr)) {
      return NextResponse.json({ error: "Invalid `from` date. Expected YYYY-MM-DD." }, { status: 400 });
    }

    const from = new Date(fromStr + "T00:00:00");
    const result = await syncAiOverviewQueries(from);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[gsc:ai-overview-sync]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
