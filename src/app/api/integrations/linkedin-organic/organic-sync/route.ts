import { NextRequest, NextResponse } from "next/server";
import { syncLinkedinOrganic } from "@/lib/integrations/linkedin-organic";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { days = 30 } = await req.json().catch(() => ({}));
  try {
    const result = await syncLinkedinOrganic(days);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed" },
      { status: 500 }
    );
  }
}
