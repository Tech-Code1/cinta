// OpenEXR, multichannel: the header (channels, windows, compression and every attribute — Cryptomatte keeps its
// names, hashes and manifest there) and the pixels of any channel, exactly as stored (float bits are preserved:
// Cryptomatte IDs are hashes stored as floats). Scanline files with NONE, RLE, ZIPS and ZIP compression are read
// here; other compressions (PIZ, PXR24, B44, DWA…) are reported. A small writer makes test and export files.
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

export type ExrPixelType = 0 | 1 | 2; // uint, half, float
export interface ExrChannel { name: string; type: ExrPixelType; xSampling: number; ySampling: number }
export interface ExrHeader {
  channels: ExrChannel[];
  compression: number;
  dataWindow: [number, number, number, number];
  displayWindow: [number, number, number, number];
  lineOrder: number;
  tiled: boolean;
  /** string attributes (cryptomatte/…/name, hash, conversion, manifest…) */
  strings: Record<string, string>;
  /** where the pixel data starts (after the header and the offset table) */
  offsets: number[];
}
export const EXR_COMPRESSION = ['NONE', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB'];

const halfToFloat = (h: number) => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
};

/** Header of an EXR file (single part). */
export function readExrHeader(buf: Buffer): ExrHeader {
  if (buf.readUInt32LE(0) !== 20000630) throw new Error('No es un archivo OpenEXR.');
  const ver = buf.readUInt32LE(4);
  if (ver & 0x1000) throw new Error('EXR de varias partes (multipart): guárdelo como una sola parte con todas las capas.');
  if (ver & 0x800) throw new Error('EXR profundo (deep data): no se admite.');
  const tiled = !!(ver & 0x200);
  let p = 8;
  const cstr = () => { const e = buf.indexOf(0, p); const s = buf.toString('latin1', p, e); p = e + 1; return s; };
  const h: ExrHeader = { channels: [], compression: 0, dataWindow: [0, 0, 0, 0], displayWindow: [0, 0, 0, 0], lineOrder: 0, tiled, strings: {}, offsets: [] };
  for (;;) {
    const name = cstr();
    if (!name) break;
    const type = cstr(), size = buf.readInt32LE(p);
    p += 4;
    const v = p;
    if (type === 'chlist') {
      let q = v;
      while (buf[q]) {
        const e = buf.indexOf(0, q);
        const cn = buf.toString('utf8', q, e);
        q = e + 1;
        h.channels.push({ name: cn, type: buf.readInt32LE(q) as ExrPixelType, xSampling: buf.readInt32LE(q + 8), ySampling: buf.readInt32LE(q + 12) });
        q += 16;
      }
    } else if (type === 'compression') h.compression = buf[v];
    else if (type === 'box2i' && (name === 'dataWindow' || name === 'displayWindow')) h[name] = [buf.readInt32LE(v), buf.readInt32LE(v + 4), buf.readInt32LE(v + 8), buf.readInt32LE(v + 12)];
    else if (type === 'lineOrder') h.lineOrder = buf[v];
    else if (type === 'string') h.strings[name] = buf.toString('utf8', v, v + size);
    p = v + size;
  }
  const [x0, y0, x1, y1] = h.dataWindow;
  void x0; void x1;
  const lines = { 0: 1, 1: 1, 2: 1, 3: 16, 4: 32, 5: 16, 6: 32, 7: 32, 8: 32, 9: 256 }[h.compression] ?? 1;
  const chunks = tiled ? 0 : Math.ceil((y1 - y0 + 1) / lines);
  for (let i = 0; i < chunks; i++) h.offsets.push(Number(buf.readBigUInt64LE(p + i * 8)));
  return h;
}

/** Undoes the ZIP / RLE byte predictor and interleave. */
function unpredict(raw: Buffer): Buffer {
  const t = Buffer.from(raw);
  for (let i = 1; i < t.length; i++) t[i] = (t[i - 1] + t[i] - 128) & 255;
  const out = Buffer.alloc(t.length), half = Math.ceil(t.length / 2);
  for (let i = 0, a = 0, b = half; i < t.length; i++) out[i] = i % 2 ? t[b++] : t[a++];
  return out;
}
function rleDecode(src: Buffer, size: number): Buffer {
  const out = Buffer.alloc(size);
  let i = 0, o = 0;
  while (i < src.length && o < size) {
    const n = src.readInt8(i++);
    if (n < 0) { const c = -n; src.copy(out, o, i, i + c); o += c; i += c; }
    else { out.fill(src[i++], o, o + n + 1); o += n + 1; }
  }
  return out;
}

export interface ExrImage { width: number; height: number; header: ExrHeader; channel(name: string): Float32Array | null; uint(name: string): Uint32Array | null }
/** Reads the channels of a scanline EXR (over its display window; outside the data window is 0). */
export function readExr(buf: Buffer, want?: string[]): ExrImage {
  const h = readExrHeader(buf);
  if (h.tiled) throw new Error('EXR en mosaicos (tiled): guárdelo por líneas de exploración (scanline).');
  if (h.compression > 3) throw new Error(`Compresión EXR ${EXR_COMPRESSION[h.compression] ?? h.compression} no admitida: use ZIP, ZIPS, RLE o sin compresión.`);
  const [dx0, , dx1, dy1] = h.dataWindow, [vx0, vy0, vx1, vy1] = h.displayWindow;
  const W = vx1 - vx0 + 1, H = vy1 - vy0 + 1, dw = dx1 - dx0 + 1;
  const chans = [...h.channels].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const bytes = (c: ExrChannel) => (c.type === 1 ? 2 : 4);
  const wanted = chans.filter((c) => !want || want.includes(c.name));
  const outF = new Map<string, Float32Array>(), outU = new Map<string, Uint32Array>();
  for (const c of wanted) { if (c.type === 0) outU.set(c.name, new Uint32Array(W * H)); else outF.set(c.name, new Float32Array(W * H)); }
  const lines = { 0: 1, 1: 1, 2: 1, 3: 16 }[h.compression]!;
  const lineBytes = chans.reduce((a, c) => a + bytes(c) * Math.ceil(dw / c.xSampling), 0);
  for (const off of h.offsets) {
    const y = buf.readInt32LE(off), size = buf.readInt32LE(off + 4);
    const n = Math.min(lines, dy1 - y + 1), expect = lineBytes * n;
    let data = buf.subarray(off + 8, off + 8 + size);
    if (size < expect) data = h.compression === 1 ? unpredict(rleDecode(data, expect)) : unpredict(inflateSync(data));
    let q = 0;
    for (let ly = 0; ly < n; ly++) {
      const yy = y + ly - vy0;
      for (const c of chans) {
        const cw = Math.ceil(dw / c.xSampling), b = bytes(c);
        const f = outF.get(c.name), u = outU.get(c.name);
        if ((f || u) && yy >= 0 && yy < H && (y + ly) % c.ySampling === 0) {
          for (let x = 0; x < cw; x++) {
            const xx = dx0 + x * c.xSampling - vx0;
            if (xx < 0 || xx >= W) continue;
            const at = q + x * b;
            if (u) u[yy * W + xx] = data.readUInt32LE(at);
            else f![yy * W + xx] = c.type === 1 ? halfToFloat(data.readUInt16LE(at)) : data.readFloatLE(at);
          }
        }
        q += cw * b;
      }
    }
  }
  return { width: W, height: H, header: h, channel: (n) => outF.get(n) ?? null, uint: (n) => outU.get(n) ?? null };
}
export const readExrFile = (path: string, want?: string[]) => readExr(readFileSync(path), want);

/** Channel names grouped as After Effects / ProEXR show them: layer → its channels ("" is the main RGBA). */
export function exrLayers(names: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of names) { const i = n.lastIndexOf('.'); const layer = i < 0 ? '' : n.slice(0, i); (out[layer] ??= []).push(n); }
  return out;
}

// ───────────────────────── Cryptomatte (open specification, Psyop 2015) ─────────────────────────
export interface CryptoLayer { key: string; name: string; hash: string; conversion: string; manifest: Record<string, string> | null; channels: string[] }
/** The Cryptomatte layers described in the header (name, its ranked channels, manifest name → hex ID). */
export function cryptoLayers(h: ExrHeader): CryptoLayer[] {
  const out: CryptoLayer[] = [];
  for (const [k, v] of Object.entries(h.strings)) {
    const m = /^cryptomatte\/([^/]+)\/name$/.exec(k);
    if (!m) continue;
    const key = m[1], s = (x: string) => h.strings[`cryptomatte/${key}/${x}`];
    let manifest: Record<string, string> | null = null;
    try { manifest = s('manifest') ? JSON.parse(s('manifest')) : null; } catch { manifest = null; }
    const channels = h.channels.map((c) => c.name).filter((n) => new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d\\d\\.(R|G|B|A|red|green|blue|alpha)$`).test(n)).sort();
    out.push({ key, name: v, hash: s('hash') ?? 'MurmurHash3_32', conversion: s('conversion') ?? 'uint32_to_float32', manifest, channels });
  }
  return out;
}
/** MurmurHash3 x86 32-bit (seed 0) of a UTF-8 name: the Cryptomatte ID before conversion. */
export function murmur3(name: string, seed = 0): number {
  const d = Buffer.from(name, 'utf8');
  let h = seed >>> 0;
  const c1 = 0xcc9e2d51, c2 = 0x1b873593, n = d.length & ~3;
  for (let i = 0; i < n; i += 4) {
    let k = d.readUInt32LE(i);
    k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  // tail bytes
  const r = d.length & 3;
  if (r) {
    let k = 0;
    if (r === 3) k ^= d[n + 2] << 16;
    if (r >= 2) k ^= d[n + 1] << 8;
    k ^= d[n]; k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2); h ^= k;
  }
  h ^= d.length;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
/** uint32_to_float32: the hash bits as a float, with the exponent kept away from 0 and 255 (no denormals,
 *  infinities or NaNs). Returns the uint32 bits of that float. */
export function cryptoIdBits(name: string): number {
  const h = murmur3(name), e = (h >>> 23) & 255;
  return e === 0 || e === 255 ? (h ^ (1 << 23)) >>> 0 : h;
}
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export const bitsToFloat = (b: number) => { u32[0] = b >>> 0; return f32[0]; };
export const floatToBits = (f: number) => { f32[0] = f; return u32[0]; };
/** IDs (uint32 bits) of the names chosen: from the manifest (with * and ? wildcards) or hashed directly. */
export function cryptoSelection(layer: CryptoLayer, selection: string): Set<number> {
  const names = selection.split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const out = new Set<number>();
  for (const n of names) {
    if (/[*?]/.test(n)) {
      if (!layer.manifest) throw new Error('Los comodines (* o ?) necesitan el manifiesto JSON de la capa Cryptomatte.');
      const re = new RegExp(`^${n.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
      for (const [k, hex] of Object.entries(layer.manifest)) if (re.test(k)) out.add(parseInt(hex, 16) >>> 0);
    } else out.add(layer.manifest?.[n] ? parseInt(layer.manifest[n], 16) >>> 0 : cryptoIdBits(n));
  }
  return out;
}

// ───────────────────────── writer (scanline, NONE or ZIP) ─────────────────────────
export function writeExr(width: number, height: number, channels: { name: string; type: ExrPixelType; data: Float32Array | Uint32Array }[], o: { compression?: 0 | 3; strings?: Record<string, string> } = {}): Buffer {
  const comp = o.compression ?? 0, lines = comp === 3 ? 16 : 1;
  const chans = [...channels].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Buffer[] = [];
  const attr = (name: string, type: string, val: Buffer) => { const sz = Buffer.alloc(4); sz.writeInt32LE(val.length); parts.push(Buffer.from(`${name}\0${type}\0`, 'latin1'), sz, val); };
  const i32 = (...v: number[]) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeInt32LE(x, i * 4)); return b; };
  const f32b = (...v: number[]) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };
  attr('channels', 'chlist', Buffer.concat([...chans.flatMap((c) => [Buffer.from(`${c.name}\0`, 'utf8'), i32(c.type), Buffer.from([0, 0, 0, 0]), i32(1, 1)]), Buffer.from([0])]));
  attr('compression', 'compression', Buffer.from([comp]));
  attr('dataWindow', 'box2i', i32(0, 0, width - 1, height - 1));
  attr('displayWindow', 'box2i', i32(0, 0, width - 1, height - 1));
  attr('lineOrder', 'lineOrder', Buffer.from([0]));
  attr('pixelAspectRatio', 'float', f32b(1));
  attr('screenWindowCenter', 'v2f', f32b(0, 0));
  attr('screenWindowWidth', 'float', f32b(1));
  for (const [k, v] of Object.entries(o.strings ?? {})) attr(k, 'string', Buffer.from(v, 'utf8'));
  parts.push(Buffer.from([0]));
  const head = Buffer.concat([Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]), ...parts]);
  const n = Math.ceil(height / lines), chunks: Buffer[] = [];
  for (let c = 0; c < n; c++) {
    const y0 = c * lines, y1 = Math.min(height, y0 + lines);
    const rows: Buffer[] = [];
    for (let y = y0; y < y1; y++) for (const ch of chans) {
      const b = Buffer.alloc(width * (ch.type === 1 ? 2 : 4));
      for (let x = 0; x < width; x++) { const v = ch.data[y * width + x]; if (ch.type === 0) b.writeUInt32LE(v >>> 0, x * 4); else b.writeFloatLE(v, x * 4); }
      rows.push(b);
    }
    let data = Buffer.concat(rows);
    if (comp === 3) {
      // interleave and predictor, then zlib (only kept when smaller)
      const half = Math.ceil(data.length / 2), t = Buffer.alloc(data.length);
      for (let i = 0, a = 0, b = half; i < data.length; i++) { if (i % 2) t[b++] = data[i]; else t[a++] = data[i]; }
      for (let i = t.length - 1; i > 0; i--) t[i] = (t[i] - t[i - 1] + 128 + 256) & 255;
      const z = deflateSync(t);
      if (z.length < data.length) data = z;
    }
    const hd = Buffer.alloc(8); hd.writeInt32LE(y0); hd.writeInt32LE(data.length, 4);
    chunks.push(Buffer.concat([hd, data]));
  }
  const table = Buffer.alloc(n * 8);
  let off = head.length + table.length;
  chunks.forEach((c, i) => { table.writeBigUInt64LE(BigInt(off), i * 8); off += c.length; });
  return Buffer.concat([head, table, ...chunks]);
}
