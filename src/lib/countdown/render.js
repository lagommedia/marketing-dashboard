// Zeni countdown GIF — rendering core (framework-agnostic).
//
// Returns a freshly generated animated GIF on every request, so the numbers
// are correct at the moment the email is opened (that is the whole trick —
// nothing is pre-rendered). The first frame already shows the right time,
// which is what Outlook displays since it never animates GIFs.
//
// GET /?end=2026-10-10T23:59:59-07:00
//      &title=Zeni%20Cards%20stop%20working%20after
//      &sub=Move%20your%20team%20to%20Ramp%20before%20then
//      &units=4          (4 = days/hours/mins/secs, 3 = drop seconds)
//      &frames=30        (seconds of animation before the GIF loops)
//      &expired=Zeni%20Cards%20are%20no%20longer%20active

import { encodeGif } from "./gif.js";
import { Canvas, Palette, drawText, drawTextCentered, measureText } from "./draw.js";

const THEME = {
  bg: "#162324", // --onyx
  box: "#26454F", // --sapphire-dark
  digit: "#FFFFFF",
  label: "#A6B0B1", // --gray-1
  title: "#97C3B9", // --jade
  sub: "#D4DCDD", // --gray-2
};

export const DEFAULTS = {
  title: "Zeni Cards stop working after",
  sub: "Move your team to Ramp before then",
  expired: "Zeni Cards are no longer active",
  units: 4,
  frames: 30,
};

const UNIT_LABELS = ["DAYS", "HOURS", "MINS", "SECS"];

function splitRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return [
    Math.floor(total / 86400),
    Math.floor((total % 86400) / 3600),
    Math.floor((total % 3600) / 60),
    total % 60,
  ];
}

const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

// The canvas is authored at 2x (1184x340) and displayed at 592x170 in the
// email, so it stays crisp on retina screens. Glyph faces in glyphs.js are
// rendered at these same 2x sizes.
function layout(unitCount) {
  const width = 1184;
  const boxW = unitCount === 4 ? 236 : 280;
  const gap = 24;
  const totalBoxes = unitCount * boxW + (unitCount - 1) * gap;
  return {
    width,
    height: 340,
    boxW,
    boxH: 152,
    gap,
    boxTop: 96,
    boxLeft: Math.round((width - totalBoxes) / 2),
    radius: 16,
    digitBandTop: 124,
    digitBandHeight: 88,
    titleBaseline: 60,
    digitBaseline: 196,
    labelBaseline: 228,
    subBaseline: 300,
    tracking: 3,
  };
}

function buildPalette() {
  const p = new Palette();
  const bg = p.solid(THEME.bg);
  const box = p.solid(THEME.box);
  return {
    palette: p,
    bg,
    box,
    digitRamp: p.ramp(THEME.digit, THEME.box),
    labelRamp: p.ramp(THEME.label, THEME.box),
    titleRamp: p.ramp(THEME.title, THEME.bg),
    subRamp: p.ramp(THEME.sub, THEME.bg),
  };
}

function boxX(L, i) {
  return L.boxLeft + i * (L.boxW + L.gap);
}

function drawBox(canvas, L, colors, i, value, label) {
  const x = boxX(L, i);
  canvas.roundRect(x, L.boxTop, L.boxW, L.boxH, L.radius, colors.box);
  drawTextCentered(canvas, "label", label, x + L.boxW / 2, L.labelBaseline, colors.labelRamp, L.tracking);
  drawDigits(canvas, L, colors, i, value);
}

// Per-tick redraw: only the band the digits sit in, which is what each
// animation frame ships.
function drawDigits(canvas, L, colors, i, value) {
  const x = boxX(L, i);
  canvas.fillRect(x, L.digitBandTop, L.boxW, L.digitBandHeight, colors.box);
  drawTextCentered(canvas, "big", value, x + L.boxW / 2, L.digitBaseline, colors.digitRamp, 0);
}

function renderStatic(L, colors, opts, values) {
  const canvas = new Canvas(L.width, L.height, colors.bg);
  drawTextCentered(canvas, "label", opts.title.toUpperCase(), L.width / 2, L.titleBaseline, colors.titleRamp, L.tracking);
  for (let i = 0; i < opts.units; i++) {
    drawBox(canvas, L, colors, i, pad2(values[i]), UNIT_LABELS[i]);
  }
  if (opts.sub) {
    drawTextCentered(canvas, "body", opts.sub, L.width / 2, L.subBaseline, colors.subRamp, 0);
  }
  return canvas;
}

function renderExpired(L, colors, opts) {
  const canvas = new Canvas(L.width, L.height, colors.bg);
  drawTextCentered(canvas, "label", opts.title.toUpperCase(), L.width / 2, Math.round(L.height / 2 - 28), colors.titleRamp, L.tracking);
  const text = opts.expired;
  drawText(canvas, "body", text, Math.round((L.width - measureText("body", text)) / 2), Math.round(L.height / 2 + 44), colors.subRamp, 0);
  return canvas;
}

export function renderCountdownGif(nowMs, opts) {
  const o = { ...DEFAULTS, ...opts };
  const L = layout(o.units);
  const colors = buildPalette();
  const palette = colors.palette.toArray();

  const remaining = o.endMs - nowMs;
  if (remaining <= 0) {
    const canvas = renderExpired(L, colors, o);
    return encodeGif({
      width: L.width,
      height: L.height,
      palette,
      frames: [{ indices: canvas.data, delay: 0 }],
      loop: null,
    });
  }

  let values = splitRemaining(remaining).slice(0, o.units);
  const canvas = renderStatic(L, colors, o, values);
  // Copy, not reference: the canvas keeps being mutated for later frames.
  const frames = [{ indices: new Uint8Array(canvas.data), delay: 100 }];

  // Only the boxes whose digits actually changed get redrawn, and each frame
  // ships just the bounding box of those — that keeps a 60-frame GIF small.
  for (let f = 1; f < o.frames; f++) {
    const next = splitRemaining(remaining - f * 1000).slice(0, o.units);
    const changed = [];
    for (let i = 0; i < o.units; i++) if (next[i] !== values[i]) changed.push(i);
    if (changed.length === 0) continue;
    for (const i of changed) drawDigits(canvas, L, colors, i, pad2(next[i]));
    const first = Math.min(...changed);
    const last = Math.max(...changed);
    const x = boxX(L, first);
    const w = boxX(L, last) + L.boxW - x;
    frames.push({
      indices: canvas.crop(x, L.digitBandTop, w, L.digitBandHeight),
      x,
      y: L.digitBandTop,
      w,
      h: L.digitBandHeight,
      delay: 100,
    });
    values = next;
  }

  return encodeGif({ width: L.width, height: L.height, palette, frames, loop: 0 });
}
