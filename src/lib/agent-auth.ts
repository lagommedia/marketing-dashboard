/**
 * Bearer-token auth for the /api/agent/* surface.
 *
 * These routes are excluded from the NextAuth middleware (see src/proxy.ts)
 * so that agents and scripts can read the dashboard without a browser session.
 * They are READ-ONLY by design — never add a mutating route under /api/agent.
 *
 * Set AGENT_API_TOKEN in Vercel (Production + Preview) and locally in .env.
 * If it is unset the whole surface returns 503 rather than falling open.
 */

import { NextResponse } from "next/server";

export function checkAgentAuth(req: Request): NextResponse | null {
  const expected = process.env.AGENT_API_TOKEN;

  if (!expected) {
    return NextResponse.json(
      { error: "AGENT_API_TOKEN is not configured on this deployment." },
      { status: 503 }
    );
  }

  const header = req.headers.get("authorization") ?? "";
  if (header !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

/** Parse ?from=&to= (YYYY-MM-DD). Defaults to the trailing `defaultDays` days. */
export function dateRange(
  sp: URLSearchParams,
  defaultDays = 90
): { from: Date; to: Date; fromStr: string; toStr: string } {
  const toStr = sp.get("to") ?? new Date().toISOString().slice(0, 10);
  const fromStr =
    sp.get("from") ??
    new Date(Date.now() - defaultDays * 86_400_000).toISOString().slice(0, 10);

  const from = new Date(`${fromStr}T00:00:00.000Z`);
  const to = new Date(`${toStr}T23:59:59.999Z`);

  return { from, to, fromStr, toStr };
}

export const sum = (nums: (number | null | undefined)[]): number =>
  nums.reduce<number>((s, n) => s + (n ?? 0), 0);

export const ratio = (a: number | null, b: number | null): number | null =>
  a != null && b != null && b > 0 ? a / b : null;
