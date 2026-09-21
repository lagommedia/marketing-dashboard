// An indexed-colour canvas plus the drawing primitives the countdown needs.
// Everything is drawn in palette indices; colours are pre-blended ramps so
// anti-aliased text still looks smooth inside GIF's 256-colour limit.

import glyphs from "./glyphs.js";

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/**
 * Builds the global palette: solid colours first, then one 16-step ramp per
 * (text colour over background colour) pair used in the layout.
 */
export class Palette {
  constructor() {
    this.colors = [];
    this.ramps = {};
  }
  solid(hex) {
    const rgb = hexToRgb(hex);
    const existing = this.colors.findIndex(
      (c) => c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2]
    );
    if (existing >= 0) return existing;
    this.colors.push(rgb);
    return this.colors.length - 1;
  }
  /** 16-step ramp from `overHex` (alpha 0) to `hex` (alpha 15). */
  ramp(hex, overHex, steps = 16) {
    const key = `${hex}|${overHex}|${steps}`;
    if (this.ramps[key]) return this.ramps[key];
    const from = hexToRgb(overHex);
    const to = hexToRgb(hex);
    const start = this.colors.length;
    for (let i = 0; i < steps; i++) {
      this.colors.push(mix(from, to, i / (steps - 1)));
    }
    const r = { start, steps };
    this.ramps[key] = r;
    return r;
  }
  toArray() {
    return this.colors;
  }
}

export class Canvas {
  constructor(width, height, bgIndex = 0) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height).fill(bgIndex);
  }
  set(x, y, index) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.data[y * this.width + x] = index;
  }
  fillRect(x, y, w, h, index) {
    for (let yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= this.height) continue;
      const row = yy * this.width;
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) {
        this.data[row + xx] = index;
      }
    }
  }
  roundRect(x, y, w, h, r, index) {
    this.fillRect(x + r, y, w - 2 * r, h, index);
    this.fillRect(x, y + r, r, h - 2 * r, index);
    this.fillRect(x + w - r, y + r, r, h - 2 * r, index);
    const corners = [
      [x + r, y + r, -1, -1],
      [x + w - r - 1, y + r, 1, -1],
      [x + r, y + h - r - 1, -1, 1],
      [x + w - r - 1, y + h - r - 1, 1, 1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      for (let dy = 0; dy <= r; dy++) {
        for (let dx = 0; dx <= r; dx++) {
          if (dx * dx + dy * dy <= r * r) this.set(cx + sx * dx, cy + sy * dy, index);
        }
      }
    }
  }
  /** Copies a sub-rectangle out, for partial GIF frames. */
  crop(x, y, w, h) {
    const out = new Uint8Array(w * h);
    for (let yy = 0; yy < h; yy++) {
      out.set(this.data.subarray((y + yy) * this.width + x, (y + yy) * this.width + x + w), yy * w);
    }
    return out;
  }
}

function decodeMask(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length * 2);
  for (let i = 0; i < bin.length; i++) {
    const byte = bin.charCodeAt(i);
    out[i * 2] = byte >> 4;
    out[i * 2 + 1] = byte & 0x0f;
  }
  return out;
}

const maskCache = new Map();
function glyphMask(face, ch) {
  const key = `${face}|${ch}`;
  let m = maskCache.get(key);
  if (!m) {
    const g = glyphs[face].glyphs[ch];
    if (!g || !g.d) return null;
    m = decodeMask(g.d);
    maskCache.set(key, m);
  }
  return m;
}

export function measureText(face, text, tracking = 0) {
  const f = glyphs[face];
  let w = 0;
  for (const ch of text) {
    const g = f.glyphs[ch];
    if (!g) continue;
    w += g.adv + tracking;
  }
  return Math.max(0, w - tracking);
}

/**
 * Draws text with its baseline at `baselineY`, left edge at `x`.
 * `ramp` comes from Palette.ramp() — alpha picks the blended colour.
 */
export function drawText(canvas, face, text, x, baselineY, ramp, tracking = 0) {
  const f = glyphs[face];
  let penX = Math.round(x);
  for (const ch of text) {
    const g = f.glyphs[ch];
    if (!g) continue;
    const mask = glyphMask(face, ch);
    if (mask) {
      const gx = penX + g.l;
      const gy = Math.round(baselineY) - f.ascent + g.t;
      for (let row = 0; row < g.h; row++) {
        for (let col = 0; col < g.w; col++) {
          const a = mask[row * g.w + col];
          if (a === 0) continue;
          const step = Math.min(ramp.steps - 1, Math.round((a / 15) * (ramp.steps - 1)));
          if (step === 0) continue;
          canvas.set(gx + col, gy + row, ramp.start + step);
        }
      }
    }
    penX += g.adv + tracking;
  }
  return penX;
}

export function drawTextCentered(canvas, face, text, centerX, baselineY, ramp, tracking = 0) {
  const w = measureText(face, text, tracking);
  return drawText(canvas, face, text, Math.round(centerX - w / 2), baselineY, ramp, tracking);
}

export const faceMetrics = (face) => glyphs[face];
