// Framework-agnostic request handler: takes a standard Request, returns a
// standard Response. Cloudflare Workers, Vercel Edge, Next.js route handlers
// and anything else with fetch-style primitives can all call this directly.
//
// GET ?end=2026-10-10T23:59:59-07:00
//     &title=Zeni%20Cards%20stop%20working%20after
//     &sub=Move%20your%20team%20to%20Ramp%20before%20then
//     &units=4          (4 = days/hours/mins/secs, 3 = drop seconds)
//     &frames=30        (seconds of animation before the GIF loops)
//     &expired=Zeni%20Cards%20are%20no%20longer%20active

import { renderCountdownGif, DEFAULTS } from "./render.js";

function parseOptions(url) {
  const q = url.searchParams;
  const end = q.get("end");
  if (!end) throw new Error("Missing ?end= (ISO 8601 with offset, e.g. 2026-10-10T23:59:59-07:00)");
  const endMs = Date.parse(end);
  if (Number.isNaN(endMs)) throw new Error(`Could not parse ?end=${end}`);
  const units = Math.min(4, Math.max(2, parseInt(q.get("units") || DEFAULTS.units, 10)));
  const frames = Math.min(120, Math.max(1, parseInt(q.get("frames") || DEFAULTS.frames, 10)));
  return {
    endMs,
    units,
    frames,
    title: q.get("title") || DEFAULTS.title,
    sub: q.get("sub") ?? DEFAULTS.sub,
    expired: q.get("expired") || DEFAULTS.expired,
  };
}

export async function handleCountdownRequest(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/health")) return new Response("ok");

  let opts;
  try {
    opts = parseOptions(url);
  } catch (err) {
    return new Response(err.message, { status: 400 });
  }

  const gif = renderCountdownGif(Date.now(), opts);
  return new Response(gif, {
    headers: {
      "Content-Type": "image/gif",
      // Every open must reach this handler again, or the numbers freeze.
      // Do not put a CDN cache in front of it.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
