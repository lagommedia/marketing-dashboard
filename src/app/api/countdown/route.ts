import { handleCountdownRequest } from "@/lib/countdown/handler";

/**
 * GET /api/countdown?end=2026-10-10T23:59:59-07:00
 *
 * Generates a branded countdown GIF on every request, for use as an <img> in
 * marketing email. The numbers are computed at open time, which is the whole
 * point — nothing here may be cached, or the countdown freezes.
 *
 * This route is public (see the matcher in src/proxy.ts): mail clients send no
 * cookies, so an authenticated route would return a redirect and every
 * recipient would see a broken image.
 *
 * Params: end (required, ISO 8601 with offset), title, sub, units, frames,
 * expired — see src/lib/countdown/handler.js.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  return handleCountdownRequest(request);
}
