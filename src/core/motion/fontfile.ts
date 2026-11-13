// A small OpenType reader (own code, no dependencies): enough of TrueType (glyf), CFF and the variable-font
// tables (fvar, avar, gvar, HVAR-free advances through gvar phantom points) to get the outline of every glyph as
// the font draws it — used by «Crear formas / máscaras a partir del texto» and to draw variable-font axes.
// Coordinates are font units, y up.

export interface FontAxis { tag: string; name: string; min: number; def: number; max: number; hidden: boolean }
export interface FontInstance { name: string; coords: Record<string, number> }
export interface FaceInfo { family: string; subfamily: string; typoFamily?: string; typoSubfamily?: string; fullName: string; weight: number; italic: boolean; axes: FontAxis[] }
/** path commands of one glyph: M x y | L x y | Q cx cy x y | C c1x c1y c2x c2y x y | Z */
export type PathCmd = ['M' | 'L', number, number] | ['Q', number, number, number, number] | ['C', number, number, number, number, number, number] | ['Z'];

type Reader = (off: number, len: number) => Uint8Array;
interface Table { off: number; len: number }

class R {
  b: Uint8Array;
  p: number;
  private dv: DataView;
  constructor(b: Uint8Array, p = 0) { this.b = b; this.p = p; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u8(o = this.p) { this.p = o + 1; return this.b[o]; }
  i8(o = this.p) { this.p = o + 1; return this.dv.getInt8(o); }
  u16(o = this.p) { this.p = o + 2; return this.dv.getUint16(o); }
  i16(o = this.p) { this.p = o + 2; return this.dv.getInt16(o); }
  u32(o = this.p) { this.p = o + 4; return this.dv.getUint32(o); }
  i32(o = this.p) { this.p = o + 4; return this.dv.getInt32(o); }
  f2(o = this.p) { return this.i16(o) / 16384; }
  fixed(o = this.p) { return this.i32(o) / 65536; }
  tag(o = this.p) { this.p = o + 4; return String.fromCharCode(this.b[o], this.b[o + 1], this.b[o + 2], this.b[o + 3]); }
}

/** Offsets of the faces in a file (a .ttc holds several). */
export function faceOffsets(head: Uint8Array): number[] {
  const r = new R(head);
  if (r.tag(0) !== 'ttcf') return [0];
  const n = r.u32(8);
  return Array.from({ length: n }, (_, i) => r.u32(12 + i * 4));
}

function tableDir(read: Reader, at: number): Map<string, Table> {
  const h = new R(read(at, 12));
  const n = h.u16(4);
  const d = new R(read(at + 12, n * 16));
  const m = new Map<string, Table>();
  for (let i = 0; i < n; i++) m.set(d.tag(i * 16), { off: d.u32(i * 16 + 8), len: d.u32(i * 16 + 12) });
  return m;
}

function decodeName(b: Uint8Array, platform: number): string {
  if (platform === 0 || platform === 3) { let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]); return s; }
  return String.fromCharCode(...b);
}
function readNames(t: Uint8Array): Map<number, string> {
  const r = new R(t), n = r.u16(2), so = r.u16(4), out = new Map<number, string>(), rank = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 12, pl = r.u16(o), enc = r.u16(o + 2), lang = r.u16(o + 4), id = r.u16(o + 6), len = r.u16(o + 8), off = r.u16(o + 10);
    // prefer Windows English, then any Windows / Unicode, then Mac Roman
    const sc = pl === 3 && (lang === 0x409) ? 3 : pl === 3 || pl === 0 ? 2 : pl === 1 && enc === 0 && lang === 0 ? 1 : 0;
    if (!sc || (rank.get(id) ?? 0) >= sc || so + off + len > t.length) continue;
    rank.set(id, sc);
    out.set(id, decodeName(t.subarray(so + off, so + off + len), pl));
  }
  return out;
}
function readAxes(t: Uint8Array, names: Map<number, string>): { axes: FontAxis[]; instances: FontInstance[] } {
  const r = new R(t), ao = r.u16(4), ac = r.u16(8), as = r.u16(10), ic = r.u16(12), is = r.u16(14);
  const axes: FontAxis[] = [];
  for (let i = 0; i < ac; i++) {
    const o = ao + i * as;
    axes.push({ tag: r.tag(o), min: r.fixed(o + 4), def: r.fixed(o + 8), max: r.fixed(o + 12), hidden: !!(r.u16(o + 16) & 1), name: names.get(r.u16(o + 18)) ?? r.tag(o) });
  }
  const instances: FontInstance[] = [];
  for (let i = 0; i < ic; i++) {
    const o = ao + ac * as + i * is, coords: Record<string, number> = {};
    axes.forEach((a, k) => { coords[a.tag] = r.fixed(o + 4 + k * 4); });
    instances.push({ name: names.get(r.u16(o)) ?? `#${i}`, coords });
  }
  return { axes, instances };
}

/** Family, style, weight, italic and variation axes of one face, reading only the small tables. */
export function faceInfo(read: Reader, at = 0): FaceInfo {
  const dir = tableDir(read, at);
  const get = (k: string) => { const t = dir.get(k); return t ? read(t.off, t.len) : null; };
  const nt = get('name'), names = nt ? readNames(nt) : new Map<number, string>();
  const os2 = get('OS/2'), o = os2 ? new R(os2) : null;
  const fv = get('fvar');
  const sub = names.get(2) ?? 'Regular';
  return {
    family: names.get(1) ?? '', subfamily: sub, typoFamily: names.get(16), typoSubfamily: names.get(17), fullName: names.get(4) ?? '',
    weight: o ? o.u16(4) : /bold/i.test(sub) ? 700 : 400,
    italic: o ? !!(o.u16(62) & 0x201) : /italic|oblique/i.test(sub),
    axes: fv ? readAxes(fv, names).axes : [],
  };
}

// ───────────────────────── CFF ─────────────────────────
function cffIndex(r: R, at: number): { items: [number, number][]; end: number } {
  const n = r.u16(at);
  if (!n) return { items: [], end: at + 2 };
  const os = r.u8(at + 2), base = at + 3 + (n + 1) * os - 1;
  const off = (i: number) => { let v = 0; for (let k = 0; k < os; k++) v = v * 256 + r.b[at + 3 + i * os + k]; return v; };
  const items: [number, number][] = [];
  for (let i = 0; i < n; i++) items.push([base + off(i), base + off(i + 1)]);
  return { items, end: base + off(n) };
}
function cffDict(b: Uint8Array, s: number, e: number): Map<number, number[]> {
  const d = new Map<number, number[]>();
  let ops: number[] = [];
  for (let i = s; i < e;) {
    const v = b[i];
    if (v <= 21) { let k = v; i++; if (v === 12) k = 1200 + b[i++]; d.set(k, ops); ops = []; }
    else if (v === 28) { ops.push(((b[i + 1] << 24) >> 16) | b[i + 2]); i += 3; }
    else if (v === 29) { ops.push((b[i + 1] << 24) | (b[i + 2] << 16) | (b[i + 3] << 8) | b[i + 4]); i += 5; }
    else if (v === 30) {
      let str = ''; i++;
      const nib = '0123456789.EE?-';
      for (;;) { const x = b[i++], a = x >> 4, c = x & 15; if (a === 15) break; str += a === 12 ? 'E-' : nib[a]; if (c === 15) break; str += c === 12 ? 'E-' : nib[c]; }
      ops.push(parseFloat(str));
    } else if (v >= 32 && v <= 246) { ops.push(v - 139); i++; }
    else if (v >= 247 && v <= 250) { ops.push((v - 247) * 256 + b[i + 1] + 108); i += 2; }
    else if (v >= 251 && v <= 254) { ops.push(-(v - 251) * 256 - b[i + 1] - 108); i += 2; }
    else i++;
  }
  return d;
}
const subrBias = (n: number) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

interface Cff { r: R; charStrings: [number, number][]; gsubrs: [number, number][]; privs: { subrs: [number, number][]; defW: number; nomW: number }[]; fdSelect?: (g: number) => number }
function parseCff(b: Uint8Array): Cff {
  const r = new R(b);
  const hdr = r.u8(2);
  const names = cffIndex(r, hdr), top = cffIndex(r, names.end), strs = cffIndex(r, top.end), gs = cffIndex(r, strs.end);
  const td = cffDict(b, top.items[0][0], top.items[0][1]);
  const cs = cffIndex(r, td.get(17)![0]);
  const priv = (pd: number[] | undefined) => {
    if (!pd) return { subrs: [], defW: 0, nomW: 0 };
    const [size, off] = pd, d = cffDict(b, off, off + size);
    return { subrs: d.has(19) ? cffIndex(r, off + d.get(19)![0]).items : [], defW: d.get(20)?.[0] ?? 0, nomW: d.get(21)?.[0] ?? 0 };
  };
  const out: Cff = { r, charStrings: cs.items, gsubrs: gs.items, privs: [priv(td.get(18))] };
  // CID-keyed fonts: one Private DICT per font dict, chosen per glyph by FDSelect
  if (td.has(1236) && td.has(1237)) {
    const fda = cffIndex(r, td.get(1236)![0]);
    out.privs = fda.items.map(([s, e]) => priv(cffDict(b, s, e).get(18)));
    const fo = td.get(1237)![0], fmt = r.u8(fo);
    if (fmt === 0) out.fdSelect = (g) => r.u8(fo + 1 + g);
    else {
      const nr = r.u16(fo + 1);
      out.fdSelect = (g) => { for (let i = 0; i < nr; i++) { const f = r.u16(fo + 3 + i * 3), nx = r.u16(fo + 3 + (i + 1) * 3); if (g >= f && g < nx) return r.u8(fo + 5 + i * 3); } return 0; };
    }
  }
  return out;
}
function cffGlyph(c: Cff, gid: number): PathCmd[] {
  const cmds: PathCmd[] = [];
  const priv = c.privs[c.fdSelect ? c.fdSelect(gid) : 0] ?? c.privs[0];
  const b = c.r.b;
  let st: number[] = [], nStems = 0, x = 0, y = 0, open = false, haveW = false;
  const move = (dx: number, dy: number) => { if (open) cmds.push(['Z']); x += dx; y += dy; cmds.push(['M', x, y]); open = true; };
  const line = (dx: number, dy: number) => { x += dx; y += dy; cmds.push(['L', x, y]); };
  const curve = (a: number, bb: number, cc: number, d: number, e: number, f: number) => { const x1 = x + a, y1 = y + bb, x2 = x1 + cc, y2 = y1 + d; x = x2 + e; y = y2 + f; cmds.push(['C', x1, y1, x2, y2, x, y]); };
  const width = (even: boolean) => { if (!haveW && st.length % 2 === (even ? 1 : 0)) st.shift(); haveW = true; };
  let depth = 0;
  const run = (s: number, e: number): boolean => {
    if (++depth > 12) return true;
    for (let i = s; i < e;) {
      const v = b[i];
      if (v === 28) { st.push(((b[i + 1] << 24) >> 16) | b[i + 2]); i += 3; continue; }
      if (v >= 32 && v <= 246) { st.push(v - 139); i++; continue; }
      if (v >= 247 && v <= 250) { st.push((v - 247) * 256 + b[i + 1] + 108); i += 2; continue; }
      if (v >= 251 && v <= 254) { st.push(-(v - 251) * 256 - b[i + 1] - 108); i += 2; continue; }
      if (v === 255) { st.push(((b[i + 1] << 24) | (b[i + 2] << 16) | (b[i + 3] << 8) | b[i + 4]) / 65536); i += 5; continue; }
      i++;
      switch (v) {
        case 1: case 3: case 18: case 23: width(true); nStems += st.length >> 1; st = []; break;
        case 19: case 20: width(true); nStems += st.length >> 1; st = []; i += (nStems + 7) >> 3; break;
        case 21: width(false); move(st[st.length - 2], st[st.length - 1]); st = []; break;
        case 22: width(true); move(st[st.length - 1], 0); st = []; break;
        case 4: width(true); move(0, st[st.length - 1]); st = []; break;
        case 5: for (let k = 0; k + 1 < st.length; k += 2) line(st[k], st[k + 1]); st = []; break;
        case 6: case 7: { let h = v === 6; for (const d of st) { if (h) line(d, 0); else line(0, d); h = !h; } st = []; break; }
        case 8: for (let k = 0; k + 5 < st.length; k += 6) curve(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]); st = []; break;
        case 24: { let k = 0; for (; k + 5 < st.length - 2; k += 6) curve(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]); line(st[k], st[k + 1]); st = []; break; }
        case 25: { let k = 0; for (; k + 1 < st.length - 6; k += 2) line(st[k], st[k + 1]); curve(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]); st = []; break; }
        case 26: { let k = 0, dx = 0; if (st.length % 2) dx = st[k++]; for (; k + 3 < st.length; k += 4) { curve(dx, st[k], st[k + 1], st[k + 2], 0, st[k + 3]); dx = 0; } st = []; break; }
        case 27: { let k = 0, dy = 0; if (st.length % 2) dy = st[k++]; for (; k + 3 < st.length; k += 4) { curve(st[k], dy, st[k + 1], st[k + 2], st[k + 3], 0); dy = 0; } st = []; break; }
        case 30: case 31: {
          let h = v === 31, k = 0;
          while (k + 3 < st.length) {
            const last = st.length - k === 5 ? st[k + 4] : 0;
            if (h) curve(st[k], 0, st[k + 1], st[k + 2], last, st[k + 3]); else curve(0, st[k], st[k + 1], st[k + 2], st[k + 3], last);
            k += st.length - k === 5 ? 5 : 4; h = !h;
          }
          st = []; break;
        }
        case 10: { const n = st.pop()! + subrBias(priv.subrs.length); const sr = priv.subrs[n]; if (sr && run(sr[0], sr[1])) return true; break; }
        case 29: { const n = st.pop()! + subrBias(c.gsubrs.length); const sr = c.gsubrs[n]; if (sr && run(sr[0], sr[1])) return true; break; }
        case 11: depth--; return false;
        case 14: width(true); if (open) cmds.push(['Z']); open = false; return true;
        case 12: {
          const e2 = b[i++], s0 = st;
          if (e2 === 35) { curve(s0[0], s0[1], s0[2], s0[3], s0[4], s0[5]); curve(s0[6], s0[7], s0[8], s0[9], s0[10], s0[11]); }
          else if (e2 === 34) { const y0 = y; curve(s0[0], 0, s0[1], s0[2], s0[3], 0); curve(s0[4], 0, s0[5], y0 - y, s0[6], 0); }
          else if (e2 === 36) { const y0 = y; curve(s0[0], s0[1], s0[2], s0[3], s0[4], 0); curve(s0[5], 0, s0[6], s0[7], s0[8], y0 - y); }
          else if (e2 === 37) {
            const x0 = x, y0 = y;
            let dx = 0, dy = 0; for (let k = 0; k < 10; k += 2) { dx += s0[k]; dy += s0[k + 1]; }
            curve(s0[0], s0[1], s0[2], s0[3], s0[4], s0[5]);
            const lx = x + s0[6] + s0[8], ly = y + s0[7] + s0[9];
            const horiz = Math.abs(dx) > Math.abs(dy);
            const ex = horiz ? s0[10] : x0 - lx, ey = horiz ? y0 - ly : s0[10];
            curve(s0[6], s0[7], s0[8], s0[9], ex, ey);
          }
          st = []; break;
        }
        default: st = [];
      }
    }
    depth--;
    return false;
  };
  const cs = c.charStrings[gid];
  if (cs) run(cs[0], cs[1]);
  if (open && cmds[cmds.length - 1]?.[0] !== 'Z') cmds.push(['Z']);
  return cmds;
}

// ───────────────────────── the font ─────────────────────────
export class OTFont {
  info: FaceInfo;
  axes: FontAxis[] = [];
  instances: FontInstance[] = [];
  unitsPerEm = 1000;
  ascender = 800;
  descender = -200;
  numGlyphs = 0;
  private r: R;
  private dir: Map<string, Table>;
  private cmap: (cp: number) => number = () => 0;
  private nHM = 0;
  private locaLong = false;
  private cff: Cff | null = null;
  private avar: { from: number; to: number }[][] | null = null;
  private gvar: { axisCount: number; shared: number[][]; offsets: number[]; data: number } | null = null;

  constructor(bytes: Uint8Array, faceIndex = 0) {
    this.r = new R(bytes);
    const at = faceOffsets(bytes)[faceIndex] ?? 0;
    const read: Reader = (o, l) => bytes.subarray(o, o + l);
    this.dir = tableDir(read, at);
    this.info = faceInfo(read, at);
    const t = (k: string) => this.dir.get(k);
    const r = this.r;
    const head = t('head');
    if (head) { this.unitsPerEm = r.u16(head.off + 18) || 1000; this.locaLong = r.i16(head.off + 50) === 1; }
    const hhea = t('hhea');
    if (hhea) { this.ascender = r.i16(hhea.off + 4); this.descender = r.i16(hhea.off + 6); this.nHM = r.u16(hhea.off + 34); }
    const maxp = t('maxp');
    if (maxp) this.numGlyphs = r.u16(maxp.off + 4);
    const fv = t('fvar'), nt = t('name');
    if (fv) { const x = readAxes(bytes.subarray(fv.off, fv.off + fv.len), nt ? readNames(bytes.subarray(nt.off, nt.off + nt.len)) : new Map()); this.axes = x.axes; this.instances = x.instances; }
    this.readCmap();
    const cffT = t('CFF ');
    if (cffT && !t('glyf')) this.cff = parseCff(bytes.subarray(cffT.off, cffT.off + cffT.len));
    const av = t('avar');
    if (av && this.axes.length) {
      let o = av.off + 8;
      this.avar = this.axes.map(() => { const n = r.u16(o); o += 2; const m: { from: number; to: number }[] = []; for (let i = 0; i < n; i++) { m.push({ from: r.f2(o), to: r.f2(o + 2) }); o += 4; } return m; });
    }
    const gv = t('gvar');
    if (gv && this.axes.length) {
      const o = gv.off, ac = r.u16(o + 4), sc = r.u16(o + 6), so = r.u32(o + 8), gc = r.u16(o + 12), fl = r.u16(o + 14), data = o + r.u32(o + 16);
      const shared = Array.from({ length: sc }, (_, i) => Array.from({ length: ac }, (_, k) => r.f2(o + so + (i * ac + k) * 2)));
      const offsets = Array.from({ length: gc + 1 }, (_, i) => (fl & 1 ? r.u32(o + 20 + i * 4) : r.u16(o + 20 + i * 2) * 2));
      this.gvar = { axisCount: ac, shared, offsets, data };
    }
  }

  private readCmap() {
    const c = this.dir.get('cmap');
    if (!c) return;
    const r = this.r, n = r.u16(c.off + 2);
    let best = -1, rank = 0;
    for (let i = 0; i < n; i++) {
      const pl = r.u16(c.off + 4 + i * 8), enc = r.u16(c.off + 6 + i * 8), off = c.off + r.u32(c.off + 8 + i * 8), fmt = r.u16(off);
      const sc = fmt === 12 && (pl === 3 || pl === 0) ? 4 : fmt === 4 && pl === 3 && (enc === 1 || enc === 0) ? 3 : fmt === 4 && pl === 0 ? 2 : 0;
      if (sc > rank) { rank = sc; best = off; }
    }
    if (best < 0) return;
    const o = best;
    if (r.u16(o) === 12) {
      const ng = r.u32(o + 12);
      this.cmap = (cp) => {
        let lo = 0, hi = ng - 1;
        while (lo <= hi) { const m = (lo + hi) >> 1, g = o + 16 + m * 12, s = r.u32(g), e = r.u32(g + 4); if (cp < s) hi = m - 1; else if (cp > e) lo = m + 1; else return r.u32(g + 8) + cp - s; }
        return 0;
      };
    } else {
      const segX2 = r.u16(o + 6), ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      this.cmap = (cp) => {
        if (cp > 0xffff) return 0;
        for (let i = 0; i < segX2; i += 2) {
          if (cp > r.u16(ends + i)) continue;
          const s = r.u16(starts + i);
          if (cp < s) return 0;
          const ro = r.u16(ranges + i), d = r.i16(deltas + i);
          if (!ro) return (cp + d) & 0xffff;
          const g = r.u16(ranges + i + ro + (cp - s) * 2);
          return g ? (g + d) & 0xffff : 0;
        }
        return 0;
      };
    }
  }

  glyphId(ch: string): number { return this.cmap(ch.codePointAt(0) ?? 0); }

  /** Normalised coordinates (−1..1, after avar) for user axis values (missing axes at their default). */
  normalize(user: Record<string, number> = {}): number[] {
    return this.axes.map((a, i) => {
      const v = Math.max(a.min, Math.min(a.max, user[a.tag] ?? a.def));
      let n = v < a.def ? (a.def > a.min ? (v - a.def) / (a.def - a.min) : 0) : v > a.def ? (a.max > a.def ? (v - a.def) / (a.max - a.def) : 0) : 0;
      const m = this.avar?.[i];
      if (m && m.length >= 3) {
        for (let k = 1; k < m.length; k++) if (n <= m[k].from) { const p = m[k - 1], q = m[k]; n = q.from === p.from ? q.to : p.to + ((n - p.from) * (q.to - p.to)) / (q.from - p.from); break; }
      }
      return n;
    });
  }

  advance(gid: number, user?: Record<string, number>): number {
    const h = this.dir.get('hmtx');
    if (!h) return this.unitsPerEm / 2;
    const r = this.r;
    let adv = r.u16(h.off + Math.min(gid, this.nHM - 1) * 4);
    const hv = this.dir.get('HVAR');
    if (user && hv && this.axes.length) return adv + this.hvarDelta(hv.off, gid, this.normalize(user));
    if (user && this.gvar && this.dir.get('glyf')) {
      const g = this.ttGlyph(gid, this.normalize(user), 0);
      adv = g.phantom[1][0] - g.phantom[0][0];
    }
    return adv;
  }

  /** HVAR: advance width delta from the item variation store (through the advance mapping, if any). */
  private hvarDelta(o: number, gid: number, coords: number[]): number {
    const r = this.r, store = o + r.u32(o + 4), mapO = r.u32(o + 8);
    let outer = 0, inner = gid;
    if (mapO) {
      const m = o + mapO, fmt = r.u8(m), ef = r.u8(m + 1), cnt = fmt ? r.u32(m + 2) : r.u16(m + 2), base = m + (fmt ? 6 : 4);
      const size = ((ef >> 4) & 3) + 1, bits = (ef & 15) + 1, i = Math.min(gid, cnt - 1);
      let v = 0; for (let k = 0; k < size; k++) v = v * 256 + r.u8(base + i * size + k);
      outer = v >>> bits; inner = v & ((1 << bits) - 1);
    }
    const rl = store + r.u32(store + 2), nd = r.u16(store + 6);
    if (outer >= nd) return 0;
    const d = store + r.u32(store + 8 + outer * 4);
    const items = r.u16(d), wc = r.u16(d + 2), long = !!(wc & 0x8000), words = wc & 0x7fff, nr = r.u16(d + 4);
    if (inner >= items) return 0;
    const regs = Array.from({ length: nr }, (_, k) => r.u16(d + 6 + k * 2));
    const rowSize = words * (long ? 4 : 2) + (nr - words) * (long ? 2 : 1);
    let p = d + 6 + nr * 2 + inner * rowSize, sum = 0;
    const ac = r.u16(rl), rc = r.u16(rl + 2);
    for (let k = 0; k < nr; k++) {
      let delta: number;
      if (k < words) { delta = long ? r.i32(p) : r.i16(p); p += long ? 4 : 2; } else { delta = long ? r.i16(p) : r.i8(p); p += long ? 2 : 1; }
      const ri = regs[k];
      if (ri >= rc || !delta) continue;
      let sc = 1;
      for (let a = 0; a < ac && sc; a++) {
        const q = rl + 4 + (ri * ac + a) * 6, s = r.f2(q), pk = r.f2(q + 2), e = r.f2(q + 4), c = coords[a] ?? 0;
        if (!pk || s > pk || pk > e || (s < 0 && e > 0)) continue;
        if (c < s || c > e) sc = 0;
        else if (c !== pk) sc *= c < pk ? (c - s) / (pk - s) : (e - c) / (e - pk);
      }
      sum += delta * sc;
    }
    return sum;
  }

  /** Outline of a glyph (font units, y up). user: axis values (variable fonts). */
  path(gid: number, user?: Record<string, number>): PathCmd[] {
    if (this.cff) return cffGlyph(this.cff, gid);
    const g = this.ttGlyph(gid, user && this.axes.length ? this.normalize(user) : null, 0);
    const out: PathCmd[] = [];
    let s = 0;
    for (const e of g.ends) {
      const pts = g.pts.slice(s, e + 1), on = g.on.slice(s, e + 1);
      s = e + 1;
      if (!pts.length) continue;
      // start at an on-curve point (or the midpoint of two off-curve ones)
      let k0 = on.indexOf(true);
      let start: number[];
      if (k0 < 0) { start = [(pts[0][0] + pts[pts.length - 1][0]) / 2, (pts[0][1] + pts[pts.length - 1][1]) / 2]; k0 = 0; }
      else { start = pts[k0]; k0++; }
      out.push(['M', start[0], start[1]]);
      let ctrl: number[] | null = null;
      for (let i = 0; i < pts.length; i++) {
        const j = (k0 + i) % pts.length;
        const p = pts[j];
        if (on[j]) { if (ctrl) { out.push(['Q', ctrl[0], ctrl[1], p[0], p[1]]); ctrl = null; } else out.push(['L', p[0], p[1]]); }
        else { if (ctrl) { const mx = (ctrl[0] + p[0]) / 2, my = (ctrl[1] + p[1]) / 2; out.push(['Q', ctrl[0], ctrl[1], mx, my]); } ctrl = p; }
      }
      if (ctrl) out.push(['Q', ctrl[0], ctrl[1], start[0], start[1]]);
      else { const l = out[out.length - 1]; if (l[0] === 'L' && l[1] === start[0] && l[2] === start[1]) out.pop(); }
      out.push(['Z']);
    }
    return out;
  }

  private glyfRange(gid: number): [number, number] | null {
    const loca = this.dir.get('loca'), glyf = this.dir.get('glyf');
    if (!loca || !glyf || gid >= this.numGlyphs) return null;
    const r = this.r;
    const a = this.locaLong ? r.u32(loca.off + gid * 4) : r.u16(loca.off + gid * 2) * 2;
    const b = this.locaLong ? r.u32(loca.off + gid * 4 + 4) : r.u16(loca.off + gid * 2 + 2) * 2;
    return b > a ? [glyf.off + a, glyf.off + b] : null;
  }
  private hm(gid: number): [number, number] {
    const h = this.dir.get('hmtx')!, r = this.r;
    const adv = r.u16(h.off + Math.min(gid, this.nHM - 1) * 4);
    const lsb = gid < this.nHM ? r.i16(h.off + gid * 4 + 2) : r.i16(h.off + this.nHM * 4 + (gid - this.nHM) * 2);
    return [adv, lsb];
  }

  private ttGlyph(gid: number, coords: number[] | null, depth: number): { pts: number[][]; on: boolean[]; ends: number[]; phantom: number[][] } {
    const r = this.r, rg = this.glyfRange(gid);
    const [adv, lsb] = this.dir.get('hmtx') ? this.hm(gid) : [this.unitsPerEm / 2, 0];
    const xMin = rg ? r.i16(rg[0] + 2) : 0;
    const phantom = [[xMin - lsb, 0], [xMin - lsb + adv, 0], [0, this.ascender], [0, this.descender]];
    const empty = { pts: [] as number[][], on: [] as boolean[], ends: [] as number[], phantom };
    if (!rg) { if (coords) this.applyGvar(gid, coords, phantom, [], []); return empty; }
    const nc = r.i16(rg[0]);
    if (nc >= 0) {
      const ends = Array.from({ length: nc }, (_, i) => r.u16(rg[0] + 10 + i * 2));
      const np = nc ? ends[nc - 1] + 1 : 0;
      let p = rg[0] + 10 + nc * 2;
      p += 2 + r.u16(p);
      const flags: number[] = [];
      while (flags.length < np) { const f = r.u8(p++); flags.push(f); if (f & 8) { let n = r.u8(p++); while (n-- > 0) flags.push(f); } }
      const xs: number[] = [], ys: number[] = [];
      let v = 0;
      for (const f of flags) { if (f & 2) { const d = r.u8(p++); v += f & 16 ? d : -d; } else if (!(f & 16)) { v += r.i16(p); p += 2; } xs.push(v); }
      v = 0;
      for (const f of flags) { if (f & 4) { const d = r.u8(p++); v += f & 32 ? d : -d; } else if (!(f & 32)) { v += r.i16(p); p += 2; } ys.push(v); }
      const pts = xs.map((x, i) => [x, ys[i]]);
      if (coords) this.applyGvar(gid, coords, phantom, pts, ends);
      return { pts, on: flags.map((f) => !!(f & 1)), ends, phantom };
    }
    // composite: components placed by offsets (which variations may move) or by matching points
    if (depth > 8) return empty;
    const comps: { gid: number; dx: number; dy: number; m: number[]; byPoint?: [number, number] }[] = [];
    let p = rg[0] + 10, more = true;
    while (more) {
      const f = r.u16(p), g = r.u16(p + 2); p += 4;
      let a1: number, a2: number;
      if (f & 1) { a1 = f & 2 ? r.i16(p) : r.u16(p); a2 = f & 2 ? r.i16(p + 2) : r.u16(p + 2); p += 4; }
      else { a1 = f & 2 ? r.i8(p) : r.u8(p); a2 = f & 2 ? r.i8(p + 1) : r.u8(p + 1); p += 2; }
      let m = [1, 0, 0, 1];
      if (f & 8) { const s = r.f2(p); m = [s, 0, 0, s]; p += 2; }
      else if (f & 0x40) { m = [r.f2(p), 0, 0, r.f2(p + 2)]; p += 4; }
      else if (f & 0x80) { m = [r.f2(p), r.f2(p + 2), r.f2(p + 4), r.f2(p + 6)]; p += 8; }
      comps.push(f & 2 ? { gid: g, dx: a1, dy: a2, m } : { gid: g, dx: 0, dy: 0, m, byPoint: [a1, a2] });
      more = !!(f & 0x20);
    }
    if (coords) {
      const pts = comps.map((c) => [c.dx, c.dy]);
      this.applyGvar(gid, coords, phantom, pts, pts.map((_, i) => i));
      pts.forEach((q, i) => { comps[i].dx = q[0]; comps[i].dy = q[1]; });
    }
    const out = { pts: [] as number[][], on: [] as boolean[], ends: [] as number[], phantom };
    for (const c of comps) {
      const sub = this.ttGlyph(c.gid, coords, depth + 1);
      const tp = sub.pts.map(([x, y]) => [x * c.m[0] + y * c.m[2], x * c.m[1] + y * c.m[3]]);
      let dx = c.dx, dy = c.dy;
      if (c.byPoint) { const a = out.pts[c.byPoint[0]], b = tp[c.byPoint[1]]; if (a && b) { dx = a[0] - b[0]; dy = a[1] - b[1]; } }
      const base = out.pts.length;
      tp.forEach(([x, y]) => out.pts.push([x + dx, y + dy]));
      out.on.push(...sub.on);
      out.ends.push(...sub.ends.map((e) => e + base));
    }
    return out;
  }

  /** gvar: adds the deltas of every tuple variation (scaled for coords) to the points and the 4 phantom points. */
  private applyGvar(gid: number, coords: number[], phantom: number[][], pts: number[][], ends: number[]) {
    const gv = this.gvar;
    if (!gv || gid + 1 >= gv.offsets.length) return;
    const r = this.r;
    const at = gv.data + gv.offsets[gid], end = gv.data + gv.offsets[gid + 1];
    if (end <= at) return;
    const all = [...pts, ...phantom];
    const n = all.length;
    const cnt = r.u16(at), tc = cnt & 0x0fff;
    let dataP = at + r.u16(at + 2);
    const readPoints = (p: number): [number[] | null, number] => {
      let c = r.u8(p++);
      if (!c) return [null, p];
      if (c & 0x80) c = ((c & 0x7f) << 8) | r.u8(p++);
      const out: number[] = [];
      let v = 0;
      while (out.length < c) {
        const ctl = r.u8(p++), run = (ctl & 0x7f) + 1, w = ctl & 0x80;
        for (let k = 0; k < run && out.length < c; k++) { v += w ? r.u16(p) : r.u8(p); p += w ? 2 : 1; out.push(v); }
      }
      return [out, p];
    };
    const readDeltas = (p: number, c: number): [number[], number] => {
      const out: number[] = [];
      while (out.length < c) {
        const ctl = r.u8(p++), run = (ctl & 0x3f) + 1;
        for (let k = 0; k < run && out.length < c; k++) {
          if (ctl & 0x80) out.push(0);
          else if (ctl & 0x40) { out.push(r.i16(p)); p += 2; }
          else { out.push(r.i8(p)); p += 1; }
        }
      }
      return [out, p];
    };
    let shared: number[] | null = null;
    if (cnt & 0x8000) [shared, dataP] = readPoints(dataP);
    let h = at + 4;
    const ac = gv.axisCount;
    const dx = new Float64Array(n), dy = new Float64Array(n);
    for (let ti = 0; ti < tc; ti++) {
      const size = r.u16(h), idx = r.u16(h + 2);
      h += 4;
      let peak: number[];
      if (idx & 0x8000) { peak = Array.from({ length: ac }, (_, k) => r.f2(h + k * 2)); h += ac * 2; }
      else peak = gv.shared[idx & 0x0fff] ?? [];
      let s0: number[] | null = null, s1: number[] | null = null;
      if (idx & 0x4000) { s0 = Array.from({ length: ac }, (_, k) => r.f2(h + k * 2)); h += ac * 2; s1 = Array.from({ length: ac }, (_, k) => r.f2(h + k * 2)); h += ac * 2; }
      let scale = 1;
      for (let k = 0; k < ac && scale; k++) {
        const pk = peak[k] ?? 0, c = coords[k] ?? 0;
        if (!pk) continue;
        if (s0 && s1) {
          if (c < s0[k] || c > s1[k]) scale = 0;
          else if (c < pk) scale *= pk === s0[k] ? 1 : (c - s0[k]) / (pk - s0[k]);
          else if (c > pk) scale *= pk === s1[k] ? 1 : (s1[k] - c) / (s1[k] - pk);
        } else if (!c || c < Math.min(0, pk) || c > Math.max(0, pk)) scale = 0;
        else scale *= c / pk;
      }
      let p = dataP;
      dataP += size;
      if (!scale) continue;
      let ptsIdx = shared;
      if (idx & 0x2000) [ptsIdx, p] = readPoints(p);
      const m = ptsIdx ? ptsIdx.length : n;
      let xd: number[], yd: number[];
      [xd, p] = readDeltas(p, m);
      [yd] = readDeltas(p, m);
      if (!ptsIdx) { for (let i = 0; i < n; i++) { dx[i] += xd[i] * scale; dy[i] += yd[i] * scale; } continue; }
      // explicit points: the others of each contour are interpolated (IUP); phantom points just take theirs
      const tx = new Float64Array(n), ty = new Float64Array(n), touched = new Uint8Array(n);
      ptsIdx.forEach((pi, k) => { if (pi < n) { tx[pi] = xd[k]; ty[pi] = yd[k]; touched[pi] = 1; } });
      let s = 0;
      for (const e of ends) { iup(pts, s, e, tx, ty, touched); s = e + 1; }
      for (let i = 0; i < n; i++) { dx[i] += tx[i] * scale; dy[i] += ty[i] * scale; }
    }
    for (let i = 0; i < n; i++) { all[i][0] += dx[i]; all[i][1] += dy[i]; }
  }
}

/** Interpolation of untouched points (gvar IUP) for one contour [s..e]. */
function iup(pts: number[][], s: number, e: number, tx: Float64Array, ty: Float64Array, touched: Uint8Array) {
  const idx: number[] = [];
  for (let i = s; i <= e; i++) if (touched[i]) idx.push(i);
  if (!idx.length) return;
  if (idx.length === 1) { for (let i = s; i <= e; i++) if (!touched[i]) { tx[i] = tx[idx[0]]; ty[i] = ty[idx[0]]; } return; }
  for (let k = 0; k < idx.length; k++) {
    const a = idx[k], b = idx[(k + 1) % idx.length];
    for (let i = a + 1; ; i++) {
      if (i > e) i = s;
      if (i === b) break;
      for (const [d, ax] of [[tx, 0], [ty, 1]] as [Float64Array, number][]) {
        const pa = pts[a][ax], pb = pts[b][ax], pi = pts[i][ax];
        const lo = Math.min(pa, pb), hi = Math.max(pa, pb), dlo = pa <= pb ? d[a] : d[b], dhi = pa <= pb ? d[b] : d[a];
        d[i] = pa === pb ? (d[a] === d[b] ? d[a] : 0) : pi <= lo ? dlo : pi >= hi ? dhi : dlo + ((pi - lo) * (dhi - dlo)) / (hi - lo);
      }
    }
  }
}

/** Glyph path → closed contours as flat beziers [x, y, inX, inY, outX, outY, …] (tangents relative), transformed by
 *  (x, y) → (ox + x·k, oy − y·k) (font units, y up → layer pixels, y down); then rotate by `a` radians about (ox, oy). */
export function pathToContours(cmds: PathCmd[], k: number, ox: number, oy: number, a = 0): number[][] {
  const c = Math.cos(a), s = Math.sin(a);
  const T = (x: number, y: number): [number, number] => { const X = x * k, Y = -y * k; return [ox + X * c - Y * s, oy + X * s + Y * c]; };
  const out: number[][] = [];
  let cur: number[] = [];
  let px = 0, py = 0;
  const vert = (x: number, y: number) => { cur.push(x, y, 0, 0, 0, 0); };
  for (const cm of cmds) {
    if (cm[0] === 'M') { if (cur.length) out.push(cur); cur = []; [px, py] = T(cm[1], cm[2]); vert(px, py); }
    else if (cm[0] === 'L') { [px, py] = T(cm[1], cm[2]); vert(px, py); }
    else if (cm[0] === 'Q' || cm[0] === 'C') {
      let c1: [number, number], c2: [number, number], p: [number, number];
      if (cm[0] === 'Q') { const q = T(cm[1], cm[2]); p = T(cm[3], cm[4]); c1 = [px + (2 / 3) * (q[0] - px), py + (2 / 3) * (q[1] - py)]; c2 = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])]; }
      else { c1 = T(cm[1], cm[2]); c2 = T(cm[3], cm[4]); p = T(cm[5], cm[6]); }
      const n = cur.length;
      cur[n - 2] = c1[0] - px; cur[n - 1] = c1[1] - py;
      vert(p[0], p[1]);
      cur[cur.length - 4] = c2[0] - p[0]; cur[cur.length - 3] = c2[1] - p[1];
      [px, py] = p;
    } else if (cm[0] === 'Z') {
      // the closing point repeats the first: fold its in-tangent into the first vertex
      const n = cur.length;
      if (n >= 12 && Math.abs(cur[n - 6] - cur[0]) < 1e-6 && Math.abs(cur[n - 5] - cur[1]) < 1e-6) { cur[2] = cur[n - 4]; cur[3] = cur[n - 3]; cur.length = n - 6; }
      if (cur.length >= 6) out.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 6) out.push(cur);
  return out;
}
