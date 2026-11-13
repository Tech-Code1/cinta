// Illustrator files as compositions (After Effects' "Import As: Composition" + "Create Shapes from Vector Layer"):
// an .ai saved with PDF compatibility is a PDF whose page carries the artwork, each Illustrator layer marked as an
// optional-content group. Every layer becomes a shape layer whose paths keep their fill, stroke, width, caps,
// joins, dashes, opacity and compound holes (even-odd / non-zero), so they animate like shapes drawn in Cinta.
// Text that was not converted to outlines, images, gradients (shadings) and clipping are reported, not drawn.
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { Editor } from './ops';
import { motionOps } from './motion/ops';
import type { Comp } from './motion/model';

// ───────────────────────── PDF objects ─────────────────────────
type PdfRef = { ref: number };
type PdfVal = number | string | boolean | null | PdfRef | PdfName | PdfVal[] | PdfDict;
type PdfName = { name: string };
type PdfDict = { [k: string]: PdfVal } & { __stream?: Buffer };
const isName = (v: PdfVal): v is PdfName => !!v && typeof v === 'object' && 'name' in (v as object);
const isRef = (v: PdfVal): v is PdfRef => !!v && typeof v === 'object' && 'ref' in (v as object);
const isDict = (v: PdfVal): v is PdfDict => !!v && typeof v === 'object' && !Array.isArray(v) && !isName(v) && !isRef(v);

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

/** Tokenizer shared by objects and content streams (works on bytes: binary inline data is skipped by the caller). */
class Lexer {
  i = 0;
  constructor(public b: Buffer, start = 0) { this.i = start; }
  skip() {
    for (;;) {
      while (this.i < this.b.length && WS.has(this.b[this.i])) this.i++;
      if (this.b[this.i] === 37) { while (this.i < this.b.length && this.b[this.i] !== 10 && this.b[this.i] !== 13) this.i++; continue; }
      return;
    }
  }
  /** next token: numbers, names, strings, operators and the delimiters [ ] << >> */
  next(): { t: 'num' | 'name' | 'str' | 'op' | 'delim'; v: string | number } | null {
    this.skip();
    const b = this.b, c = b[this.i];
    if (c === undefined) return null;
    if (c === 47) { let j = ++this.i; while (j < b.length && !WS.has(b[j]) && !DELIM.has(b[j])) j++; const v = b.toString('latin1', this.i, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); this.i = j; return { t: 'name', v }; }
    if (c === 40) { // (literal string) with nesting and escapes
      let depth = 1, out = ''; this.i++;
      while (this.i < b.length && depth) {
        const x = b[this.i++];
        if (x === 92) { const y = b[this.i++]; const m: Record<number, string> = { 110: '\n', 114: '\r', 116: '\t', 98: '\b', 102: '\f', 40: '(', 41: ')', 92: '\\' }; if (m[y]) out += m[y]; else if (y >= 48 && y <= 55) { let o = String.fromCharCode(y); for (let k = 0; k < 2 && b[this.i] >= 48 && b[this.i] <= 55; k++) o += String.fromCharCode(b[this.i++]); out += String.fromCharCode(parseInt(o, 8)); } else if (y !== 10 && y !== 13) out += String.fromCharCode(y); continue; }
        if (x === 40) depth++; else if (x === 41 && !--depth) break;
        out += String.fromCharCode(x);
      }
      return { t: 'str', v: out };
    }
    if (c === 60 && b[this.i + 1] === 60) { this.i += 2; return { t: 'delim', v: '<<' }; }
    if (c === 62 && b[this.i + 1] === 62) { this.i += 2; return { t: 'delim', v: '>>' }; }
    if (c === 60) { const j = b.indexOf(62, this.i); const hex = b.toString('latin1', this.i + 1, j).replace(/\s/g, ''); this.i = j + 1; let out = ''; for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16)); return { t: 'str', v: out }; }
    if (c === 91 || c === 93 || c === 123 || c === 125) { this.i++; return { t: 'delim', v: String.fromCharCode(c) }; }
    let j = this.i; while (j < b.length && !WS.has(b[j]) && !DELIM.has(b[j])) j++;
    if (j === this.i) j++;
    const s = b.toString('latin1', this.i, j); this.i = j;
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? { t: 'num', v: Number(s) } : { t: 'op', v: s };
  }
  /** a whole value (dictionaries, arrays, references) */
  value(tok = this.next()): PdfVal {
    if (!tok) return null;
    if (tok.t === 'num') {
      // "n g R" is a reference
      const save = this.i, a = this.next(), r = a?.t === 'num' ? this.next() : null;
      if (a?.t === 'num' && r?.t === 'op' && r.v === 'R') return { ref: tok.v as number };
      this.i = save; return tok.v as number;
    }
    if (tok.t === 'name') return { name: tok.v as string };
    if (tok.t === 'str') return tok.v as string;
    if (tok.t === 'delim' && tok.v === '[') { const arr: PdfVal[] = []; for (let x = this.next(); x && !(x.t === 'delim' && x.v === ']'); x = this.next()) arr.push(this.value(x)); return arr; }
    if (tok.t === 'delim' && tok.v === '<<') { const d: PdfDict = {}; for (let k = this.next(); k && !(k.t === 'delim' && k.v === '>>'); k = this.next()) if (k.t === 'name') d[k.v as string] = this.value(); return d; }
    if (tok.t === 'op') return tok.v === 'true' ? true : tok.v === 'false' ? false : null;
    return null;
  }
}

class Pdf {
  private at = new Map<number, number>();
  private cache = new Map<number, PdfVal>();
  private inStreams: Map<number, { stm: number; idx: number }> | null = null;
  constructor(public b: Buffer) {
    // every "n g obj" (last one wins, as incremental updates append newer versions)
    const s = b.toString('latin1');
    for (const m of s.matchAll(/(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g)) this.at.set(Number(m[1]), m.index! + m[0].length);
  }
  get(v: PdfVal): PdfVal {
    if (!isRef(v)) return v;
    const n = v.ref;
    if (this.cache.has(n)) return this.cache.get(n)!;
    let out: PdfVal = null;
    const pos = this.at.get(n);
    if (pos !== undefined) {
      const lx = new Lexer(this.b, pos);
      out = lx.value();
      if (isDict(out)) {
        const save = lx.i, t = lx.next();
        if (t?.t === 'op' && t.v === 'stream') {
          let i = lx.i; if (this.b[i] === 13) i++; if (this.b[i] === 10) i++;
          const len = this.get(out.Length ?? null);
          const end = typeof len === 'number' && this.b.toString('latin1', i + len, i + len + 30).includes('endstream') ? i + len : this.b.indexOf('endstream', i, 'latin1');
          out.__stream = this.b.subarray(i, end);
        } else lx.i = save;
      }
    } else out = this.fromObjStm(n);
    this.cache.set(n, out);
    return out;
  }
  /** objects packed in object streams (PDF 1.5) */
  private fromObjStm(n: number): PdfVal {
    if (!this.inStreams) {
      this.inStreams = new Map();
      for (const k of this.at.keys()) {
        const o = this.get({ ref: k });
        if (!isDict(o) || (o.Type as PdfName)?.name !== 'ObjStm') continue;
        const data = this.data(o), first = Number(this.get(o.First ?? 0)), count = Number(this.get(o.N ?? 0));
        const lx = new Lexer(data);
        for (let i = 0; i < count; i++) { const num = lx.value() as number, off = lx.value() as number; this.inStreams.set(num, { stm: k, idx: first + off }); }
      }
    }
    const loc = this.inStreams.get(n);
    if (!loc) return null;
    return new Lexer(this.data(this.get({ ref: loc.stm }) as PdfDict), loc.idx).value();
  }
  /** a stream's decoded bytes (FlateDecode; other filters are not used for vector content) */
  data(d: PdfDict): Buffer {
    let buf = d.__stream ?? Buffer.alloc(0);
    const f = this.get(d.Filter ?? null), filters = (Array.isArray(f) ? f : f ? [f] : []).map((x) => (isName(x) ? x.name : ''));
    for (const name of filters) {
      if (name === 'FlateDecode') { try { buf = inflateSync(buf); } catch { buf = inflateSync(buf, { finishFlush: 2 }); } }
      else throw new Error(`Filtro de PDF no admitido: ${name}`);
    }
    return buf;
  }
  dict(v: PdfVal): PdfDict { const o = this.get(v); return isDict(o) ? o : {}; }
}

// ───────────────────────── artwork ─────────────────────────
type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const ap = (m: M, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

/** one subpath: anchors with in / out handles in absolute coordinates */
interface Sub { pts: { x: number; y: number; ix: number; iy: number; ox: number; oy: number }[]; closed: boolean }
export interface AiPath { subs: Sub[]; fill: string | null; stroke: string | null; width: number; cap: 'butt' | 'round' | 'square'; join: 'miter' | 'round' | 'bevel'; dash: number[]; fillOpacity: number; strokeOpacity: number; rule: 'nonzero' | 'evenodd' }
export interface AiLayer { name: string; paths: AiPath[] }
export interface AiArt { width: number; height: number; layers: AiLayer[]; skipped: Record<string, number> }

const hex2 = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0');
const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const cmykHex = (c: number, m: number, y: number, k: number) => rgbHex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
const colorOf = (comps: number[]): string => comps.length >= 4 ? cmykHex(comps[0], comps[1], comps[2], comps[3]) : comps.length === 3 ? rgbHex(comps[0], comps[1], comps[2]) : rgbHex(comps[0] ?? 0, comps[0] ?? 0, comps[0] ?? 0);

/** Reads the artwork of the first page (its crop box is the artboard). */
export function readAi(buf: Buffer): AiArt {
  if (buf.toString('latin1', 0, 1024).indexOf('%PDF') < 0) throw new Error('Este archivo de Illustrator no tiene compatibilidad con PDF: guárdelo en Illustrator con «Crear archivo compatible con PDF» activado.');
  const pdf = new Pdf(buf);
  const trailerRoot = (() => { const s = buf.toString('latin1'); const m = [...s.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].pop(); return m ? Number(m[1]) : null; })();
  if (trailerRoot === null) throw new Error('No se encontró el catálogo del PDF.');
  const findPage = (node: PdfDict): PdfDict | null => {
    if ((node.Type as PdfName)?.name === 'Page') return node;
    for (const k of (pdf.get(node.Kids ?? null) as PdfVal[] | null) ?? []) { const p = findPage(pdf.dict(k)); if (p) return p; }
    return null;
  };
  const page = findPage(pdf.dict(pdf.dict({ ref: trailerRoot }).Pages ?? null));
  if (!page) throw new Error('El PDF no tiene páginas.');
  const inherited = (k: string): PdfVal => { for (let n: PdfDict | null = page; n; n = n.Parent ? pdf.dict(n.Parent) : null) if (n[k] !== undefined) return pdf.get(n[k]); return null; };
  const box = ((inherited('CropBox') ?? inherited('MediaBox')) as number[] | null)?.map((x) => Number(pdf.get(x))) ?? [0, 0, 612, 792];
  const [bx0, by0, bx1, by1] = [Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.max(box[0], box[2]), Math.max(box[1], box[3])];
  const width = Math.round(bx1 - bx0), height = Math.round(by1 - by0);
  const layers: AiLayer[] = [], byName = new Map<string, AiLayer>();
  const skipped: Record<string, number> = {};
  const skip = (what: string) => { skipped[what] = (skipped[what] ?? 0) + 1; };
  const layerFor = (name: string) => { let l = byName.get(name); if (!l) { l = { name, paths: [] }; byName.set(name, l); layers.push(l); } return l; };

  type GS = { m: M; fill: number[]; stroke: number[]; fcs: number; scs: number; width: number; cap: AiPath['cap']; join: AiPath['join']; dash: number[]; fa: number; sa: number };
  // artwork space (PDF points, y up) → comp pixels (72 ppi, y down, artboard origin)
  const base: M = [1, 0, 0, -1, -bx0, by1];
  const run = (content: Buffer, res: PdfDict, gs0: GS, depth: number, mcStack: string[]) => {
    if (depth > 12) return;
    const props = pdf.dict(res.Properties ?? null), xobj = pdf.dict(res.XObject ?? null), egs = pdf.dict(res.ExtGState ?? null), cspaces = pdf.dict(res.ColorSpace ?? null);
    const lx = new Lexer(content);
    const stack: GS[] = [];
    let gs: GS = { ...gs0, fill: [...gs0.fill], stroke: [...gs0.stroke], dash: [...gs0.dash] };
    let subs: Sub[] = [], cur: Sub | null = null, cx = 0, cy = 0;
    const ops: PdfVal[] = [];
    const nums = (k: number) => ops.slice(-k).map((x) => Number(x));
    const csComps = (v: PdfVal): number => {
      const name = isName(v) ? v.name : '';
      if (/Gray|^G$/.test(name)) return 1; if (/CMYK|^CMYK$/.test(name)) return 4; if (/RGB/.test(name)) return 3;
      const def = pdf.get(cspaces[name] ?? null);
      if (Array.isArray(def)) { const kind = isName(def[0]) ? def[0].name : ''; if (kind === 'ICCBased') return Number(pdf.dict(def[1]).N ?? 3); if (kind === 'Separation') return -1; if (kind === 'DeviceN') return -1; }
      return 3;
    };
    const layerName = () => mcStack.filter(Boolean).at(-1) ?? 'Capa 1';
    const paint = (fill: boolean, stroke: boolean, rule: AiPath['rule']) => {
      if (cur) { subs.push(cur); cur = null; }
      const live = subs.filter((s) => s.pts.length >= (s.closed ? 2 : 2));
      if (live.length && (fill || stroke)) {
        layerFor(layerName()).paths.push({ subs: live, fill: fill ? colorOf(gs.fill) : null, stroke: stroke ? colorOf(gs.stroke) : null, width: gs.width * Math.sqrt(Math.abs(gs.m[0] * gs.m[3] - gs.m[1] * gs.m[2])), cap: gs.cap, join: gs.join, dash: gs.dash, fillOpacity: gs.fa * 100, strokeOpacity: gs.sa * 100, rule });
      }
      subs = [];
    };
    const pt = (x: number, y: number) => ap(mul(gs.m, base), x, y);
    for (let tok = lx.next(); tok; tok = lx.next()) {
      if (tok.t !== 'op') { ops.push(lx.value(tok)); continue; }
      const op = tok.v as string;
      switch (op) {
        case 'q': stack.push({ ...gs, fill: [...gs.fill], stroke: [...gs.stroke], dash: [...gs.dash] }); break;
        case 'Q': gs = stack.pop() ?? gs; break;
        case 'cm': gs.m = mul(nums(6) as M, gs.m); break;
        case 'w': gs.width = nums(1)[0]; break;
        case 'J': gs.cap = (['butt', 'round', 'square'] as const)[nums(1)[0]] ?? 'butt'; break;
        case 'j': gs.join = (['miter', 'round', 'bevel'] as const)[nums(1)[0]] ?? 'miter'; break;
        case 'd': { const a = ops[ops.length - 2]; gs.dash = Array.isArray(a) ? a.map(Number) : []; break; }
        case 'gs': { const d = pdf.dict(egs[(ops.at(-1) as PdfName)?.name ?? ''] ?? null); if (typeof d.ca === 'number') gs.fa = d.ca; if (typeof d.CA === 'number') gs.sa = d.CA; break; }
        case 'g': gs.fill = nums(1); break; case 'G': gs.stroke = nums(1); break;
        case 'rg': gs.fill = nums(3); break; case 'RG': gs.stroke = nums(3); break;
        case 'k': gs.fill = nums(4); break; case 'K': gs.stroke = nums(4); break;
        case 'cs': gs.fcs = csComps(ops.at(-1) ?? null); gs.fill = gs.fcs === 4 ? [0, 0, 0, 1] : gs.fcs === 1 ? [0] : [0, 0, 0]; break;
        case 'CS': gs.scs = csComps(ops.at(-1) ?? null); gs.stroke = gs.scs === 4 ? [0, 0, 0, 1] : gs.scs === 1 ? [0] : [0, 0, 0]; break;
        case 'sc': case 'scn': case 'SC': case 'SCN': {
          const fillOp = op === 'sc' || op === 'scn', n = fillOp ? gs.fcs : gs.scs;
          if (isName(ops.at(-1) ?? null)) { skip('patrones o degradados'); break; }
          // spot colours (Separation): the tint as a grey, the closest without the alternate space
          const v = n === -1 ? [1 - nums(1)[0]] : nums(n);
          if (fillOp) gs.fill = v; else gs.stroke = v;
          break;
        }
        case 'm': { if (cur) subs.push(cur); const [x, y] = nums(2); [cx, cy] = [x, y]; const [X, Y] = pt(x, y); cur = { pts: [{ x: X, y: Y, ix: X, iy: Y, ox: X, oy: Y }], closed: false }; break; }
        case 'l': { const [x, y] = nums(2); [cx, cy] = [x, y]; const [X, Y] = pt(x, y); cur?.pts.push({ x: X, y: Y, ix: X, iy: Y, ox: X, oy: Y }); break; }
        case 'c': case 'v': case 'y': {
          const a = op === 'c' ? nums(6) : nums(4);
          const [c1x, c1y, c2x, c2y, x, y] = op === 'c' ? a : op === 'v' ? [cx, cy, a[0], a[1], a[2], a[3]] : [a[0], a[1], a[2], a[3], a[2], a[3]];
          if (!cur) break;
          const last = cur.pts[cur.pts.length - 1];
          [last.ox, last.oy] = pt(c1x, c1y);
          const [X, Y] = pt(x, y), [IX, IY] = pt(c2x, c2y);
          cur.pts.push({ x: X, y: Y, ix: IX, iy: IY, ox: X, oy: Y });
          [cx, cy] = [x, y];
          break;
        }
        case 'h': if (cur) { cur.closed = true; const f = cur.pts[0], l = cur.pts[cur.pts.length - 1]; if (cur.pts.length > 1 && Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) { f.ix = l.ix; f.iy = l.iy; cur.pts.pop(); } subs.push(cur); cur = null; } break;
        case 're': {
          if (cur) subs.push(cur);
          const [x, y, w, h] = nums(4);
          cur = { pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([a, b]) => { const [X, Y] = pt(a, b); return { x: X, y: Y, ix: X, iy: Y, ox: X, oy: Y }; }), closed: true };
          subs.push(cur); cur = null;
          break;
        }
        case 'f': case 'F': paint(true, false, 'nonzero'); break;
        case 'f*': paint(true, false, 'evenodd'); break;
        case 'S': paint(false, true, 'nonzero'); break;
        case 's': if (cur) cur.closed = true; paint(false, true, 'nonzero'); break;
        case 'B': paint(true, true, 'nonzero'); break;
        case 'B*': paint(true, true, 'evenodd'); break;
        case 'b': if (cur) cur.closed = true; paint(true, true, 'nonzero'); break;
        case 'b*': if (cur) cur.closed = true; paint(true, true, 'evenodd'); break;
        case 'n': if (subs.length || cur) { if (ops.length === 0) skip('trazados de recorte'); } subs = []; cur = null; break;
        case 'W': case 'W*': skip('trazados de recorte'); break;
        case 'BDC': {
          const tag = ops[ops.length - 2], p = ops.at(-1);
          let nm = '';
          if (isName(tag ?? null) && (tag as PdfName).name === 'OC') { const ocg = pdf.dict(isName(p ?? null) ? props[(p as PdfName).name] ?? null : p ?? null); nm = typeof ocg.Name === 'string' ? decodePdfText(ocg.Name) : ''; }
          mcStack.push(nm);
          break;
        }
        case 'BMC': mcStack.push(''); break;
        case 'EMC': mcStack.pop(); break;
        case 'BT': { // text that was not outlined: skip to ET
          skip('textos (conviértalos a contornos en Illustrator)');
          for (let t = lx.next(); t && !(t.t === 'op' && t.v === 'ET'); t = lx.next()) if (t.t !== 'op') lx.value(t);
          break;
        }
        case 'BI': { const at = content.indexOf('EI', lx.i, 'latin1'); lx.i = at < 0 ? content.length : at + 2; skip('imágenes'); break; }
        case 'sh': skip('degradados'); break;
        case 'Do': {
          const x = pdf.dict(xobj[(ops.at(-1) as PdfName)?.name ?? ''] ?? null);
          const sub = (x.Subtype as PdfName)?.name;
          if (sub === 'Form') {
            const fm = ((pdf.get(x.Matrix ?? null) as number[] | null) ?? [1, 0, 0, 1, 0, 0]).map(Number) as M;
            run(pdf.data(x), x.Resources ? pdf.dict(x.Resources) : res, { ...gs, m: mul(fm, gs.m) }, depth + 1, mcStack);
          } else if (sub === 'Image') skip('imágenes');
          break;
        }
      }
      ops.length = 0;
    }
  };
  const contents = pdf.get(page.Contents ?? null);
  const parts = (Array.isArray(contents) ? contents : [page.Contents ?? null]).map((c) => pdf.data(pdf.dict(c)));
  const gs0: GS = { m: [1, 0, 0, 1, 0, 0], fill: [0], stroke: [0], fcs: 1, scs: 1, width: 1, cap: 'butt', join: 'miter', dash: [], fa: 1, sa: 1 };
  run(Buffer.concat(parts.flatMap((p) => [p, Buffer.from('\n')])), pdf.dict(inherited('Resources')), gs0, 0, []);
  return { width, height, layers: layers.filter((l) => l.paths.length), skipped };
}
/** PDF text strings: UTF-16BE with a byte order mark, else PDFDocEncoding (≈ Latin-1) */
function decodePdfText(s: string): string {
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) { let o = ''; for (let i = 2; i + 1 < s.length; i += 2) o += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1)); return o; }
  return s;
}

/** Imports an .ai as a composition: one shape layer per Illustrator layer (bottom → top). */
export function aiImport(e: Editor, path: string, o: { name?: string } = {}): Promise<{ comp: Comp; layers: number; paths: number; warnings: string[] }> {
  const art = readAi(readFileSync(path));
  if (!art.layers.length) throw new Error('No se encontraron trazados vectoriales en el archivo.');
  const warnings = Object.entries(art.skipped).map(([k, n]) => `${n} ${k} no se importaron.`);
  // one undo step for the comp and all its shapes
  return e.batch(async () => {
    const c = motionOps.compNew(e, { name: o.name ?? basename(path, extname(path)), width: Math.max(16, art.width), height: Math.max(16, art.height), transparent: true });
    const cx = c.width / 2, cy = c.height / 2;
    let paths = 0;
    for (const al of art.layers) {
      let layerId: string | undefined;
      al.paths.forEach((p, i) => {
        // flat bezier relative to the layer (centred in the comp): [x, y, inX, inY, outX, outY…] with relative handles
        const flat = (s: Sub) => s.pts.flatMap((q) => [q.x - cx, q.y - cy, q.ix - q.x, q.iy - q.y, q.ox - q.x, q.oy - q.y]);
        const main = p.subs[0];
        const r = motionOps.shapeAdd(e, c.id, layerId, {
          kind: 'path', name: `Trazado ${i + 1}`, path: flat(main), bezier: true, closed: main.closed || !!p.fill, contours: p.subs.length > 1 ? p.subs.slice(1).map(flat) : undefined,
          color: p.fill, fillRule: p.rule, fillOpacity: p.fill ? p.fillOpacity : undefined,
          stroke: p.stroke ?? undefined, strokeWidth: p.stroke ? p.width : undefined, cap: p.cap, join: p.join, strokeOpacity: p.stroke ? p.strokeOpacity : undefined, dash: p.dash.length ? p.dash : undefined,
        });
        if (r.shape.stroke.on !== !!p.stroke) motionOps.shapeSet(e, c.id, r.layer.id, r.shape.id, { stroke: !!p.stroke });
        if (!layerId) { layerId = r.layer.id; motionOps.layerSet(e, c.id, layerId, { name: al.name }); }
        paths++;
      });
    }
    return { comp: c, layers: art.layers.length, paths, warnings };
  });
}
