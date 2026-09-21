// Minimal GIF89a encoder: global palette, Netscape looping, and partial
// (sub-rectangle) frames so a ticking countdown stays small.

class ByteBuffer {
  constructor() {
    this.bytes = [];
  }
  byte(v) {
    this.bytes.push(v & 0xff);
  }
  short(v) {
    this.byte(v);
    this.byte(v >> 8);
  }
  string(s) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  raw(arr) {
    for (const v of arr) this.byte(v);
  }
  toUint8Array() {
    return new Uint8Array(this.bytes);
  }
}

// GIF's variant of LZW: variable code width, clear/end codes, 255-byte blocks.
function lzwEncode(indices, minCodeSize) {
  const out = [];
  let cur = 0; // bit accumulator
  let curBits = 0;
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dict = new Map();

  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      out.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (nextCode < 4096) {
      dict.set(key, nextCode++);
      if (nextCode - 1 === (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clearCode);
      dict = new Map();
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(endCode);
  if (curBits > 0) out.push(cur & 0xff);
  return out;
}

function blockify(buf, bytes) {
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    buf.byte(chunk.length);
    buf.raw(chunk);
  }
  buf.byte(0); // block terminator
}

/**
 * @param {object} opts
 * @param {number} opts.width  canvas width
 * @param {number} opts.height canvas height
 * @param {Array<[number,number,number]>} opts.palette up to 256 RGB triples
 * @param {Array<{indices:Uint8Array,x?:number,y?:number,w?:number,h?:number,delay:number}>} opts.frames
 *        delay is in hundredths of a second; w/h default to the canvas size
 * @param {number} [opts.loop] 0 = forever (default), omit for no loop block
 * @returns {Uint8Array}
 */
export function encodeGif({ width, height, palette, frames, loop = 0 }) {
  // Palette must be a power of two, at least 2 entries.
  let bits = 1;
  while (1 << bits < palette.length) bits++;
  const size = 1 << bits;

  const buf = new ByteBuffer();
  buf.string("GIF89a");
  buf.short(width);
  buf.short(height);
  buf.byte(0x80 | (bits - 1)); // global color table, depth
  buf.byte(0); // background index
  buf.byte(0); // pixel aspect ratio
  for (let i = 0; i < size; i++) {
    const [r, g, b] = palette[i] || [0, 0, 0];
    buf.byte(r);
    buf.byte(g);
    buf.byte(b);
  }

  if (loop !== null && frames.length > 1) {
    buf.byte(0x21);
    buf.byte(0xff);
    buf.byte(11);
    buf.string("NETSCAPE2.0");
    buf.byte(3);
    buf.byte(1);
    buf.short(loop);
    buf.byte(0);
  }

  for (const frame of frames) {
    const fx = frame.x || 0;
    const fy = frame.y || 0;
    const fw = frame.w || width;
    const fh = frame.h || height;

    buf.byte(0x21); // graphic control extension
    buf.byte(0xf9);
    buf.byte(4);
    buf.byte(0x04); // disposal 1: leave the frame in place
    buf.short(frame.delay);
    buf.byte(0); // transparent index (unused)
    buf.byte(0);

    buf.byte(0x2c); // image descriptor
    buf.short(fx);
    buf.short(fy);
    buf.short(fw);
    buf.short(fh);
    buf.byte(0); // no local color table, not interlaced

    const minCodeSize = Math.max(2, bits);
    buf.byte(minCodeSize);
    blockify(buf, lzwEncode(frame.indices, minCodeSize));
  }

  buf.byte(0x3b); // trailer
  return buf.toUint8Array();
}
