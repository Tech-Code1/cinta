// Text layers: per-character layout and the weights of the animator selectors (range, wiggly), so animators can
// move, scale, rotate, fade, recolour, blur or decode characters, words or lines like After Effects' text animators.
import { fbm, hash2, rnd, valueAt, type Env } from './anim';
import type { BasedOn, CharStyle, Comp, Layer, Selector, TextAnimator } from './model';
import { hyphenPoints, SCRIPT_POS, SCRIPT_SIZE, SMALL_CAPS } from './textstyle';

export interface Glyph {
  ch: string;
  /** left of the advance box and baseline, layer pixels (vertical text: left of the glyph's drawn width) */
  x: number;
  y: number;
  w: number;
  line: number;
  word: number;
  idx: number;
  idxNoSpace: number;
  space: boolean;
  /** UTF-16 offset of the source character (-1: a hyphen added by the line breaking) */
  src?: number;
  /** size factor (small caps, superscript, subscript, Tate-chu-yoko) and vertical / horizontal scale */
  k?: number;
  hs?: number;
  vs?: number;
  /** Faux bold, Faux italic */
  fb?: boolean;
  fi?: boolean;
  /** rotation in degrees (vertical text: half-width glyphs with standard Roman alignment) */
  rot?: number;
}

export interface Layout { glyphs: Glyph[]; lines: number; words: number; noSpace: number; bounds: [number, number, number, number]; vertical?: boolean }

/** Glyphs turn and scale around a point this fraction of the size above their baseline (cap-height middle). */
export const PIVOT = 0.35;

export interface LayoutOptions {
  size: number;
  tracking: number;
  leading: number;
  align: 'left' | 'center' | 'right';
  box?: number[];
  allCaps?: boolean;
  hindiDigits?: boolean;
  /** character style at a UTF-16 offset of the text (textstyle.ts styleResolver) */
  style?: (i: number) => CharStyle;
  justify?: 'left' | 'center' | 'right' | 'all';
  indentLeft?: number;
  indentRight?: number;
  indentFirst?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  hyphenate?: boolean;
  composer?: 'every' | 'single';
  vertical?: boolean;
  romanStd?: boolean;
}

interface Item { ch: string; src: number; k: number; hs: number; vs: number; bs: number; fb: boolean; fi: boolean; ts: number; tcy: boolean; space: boolean }
const HALF_WIDTH = (c: string) => { const u = c.codePointAt(0) ?? 0; return u < 0x1100 || (u >= 0xff61 && u <= 0xffdc) || (u >= 0x2000 && u < 0x2e80 && u !== 0x3000); };

/** measure(s) → advance width of s in pixels for the current font. Lays out point text, paragraph text (wrapped in
 *  `box`, single-line or every-line composer, hyphenation, justification, indents, paragraph spacing) and
 *  vertical text (columns right to left), with per-character styles. */
export function layoutText(text: string, o: LayoutOptions, measure: (s: string) => number): Layout {
  const size = o.size, vertical = !!o.vertical;
  // characters with their style
  const items: Item[] = [];
  let off = 0;
  for (const c of text.replace(/\r\n?/g, '\n')) {
    const st: CharStyle = c === '\n' ? {} : o.style?.(off) ?? {};
    let out = c, k = 1;
    if (c !== '\n') {
      if (o.allCaps || st.allCaps) out = c.toUpperCase();
      else if (st.smallCaps && c !== c.toUpperCase()) { out = c.toUpperCase(); k = SMALL_CAPS; }
      if (o.hindiDigits && c >= '0' && c <= '9') out = String.fromCharCode(0x660 + c.charCodeAt(0) - 48);
    }
    let bs = Number(st.baselineShift) || 0;
    if (st.script === 'super') { k *= SCRIPT_SIZE; bs += SCRIPT_POS * size; } else if (st.script === 'sub') { k *= SCRIPT_SIZE; bs -= SCRIPT_POS * size; }
    const hs = (st.hScale ?? 100) / 100, vs = (st.vScale ?? 100) / 100;
    for (const ch of out) items.push({ ch, src: off, k, hs, vs, bs, fb: !!st.fauxBold, fi: !!st.fauxItalic, ts: Math.max(0, Math.min(100, Number(st.tsume) || 0)) / 100, tcy: vertical && !!st.tcy && !/\s/.test(ch), space: /\s/.test(ch) });
    off += c.length;
  }
  // plain text (no character extras) keeps the exact measuring of earlier versions
  const plain = !vertical && items.every((it) => it.k === 1 && it.hs === 1 && it.ts === 0 && !it.fb);
  const trk = (it: Item) => (o.tracking * size * it.k) / 1000;
  const advH = (a: Item, b: Item | undefined) => {
    const base = b && b.k * b.hs === a.k * a.hs ? measure(a.ch + b.ch) - measure(b.ch) : measure(a.ch);
    return base * a.k * a.hs * (1 - 0.25 * a.ts) + trk(a);
  };
  const isRot = (it: Item) => vertical && !!o.romanStd && !it.tcy && HALF_WIDTH(it.ch);
  // advance along the line (vertical: along the column; a Tate-chu-yoko group takes one em)
  const advances = (arr: Item[]) => arr.map((it, i) => {
    if (!vertical) return advH(it, arr[i + 1]);
    if (it.tcy) return i > 0 && arr[i - 1].tcy ? 0 : size * it.k * it.vs + trk(it);
    if (isRot(it) || it.space) return measure(it.ch) * it.k * it.hs * (1 - 0.25 * it.ts) + trk(it);
    return size * it.k * it.vs * (1 - 0.25 * it.ts) + trk(it);
  });
  const trimEnd = (a: Item[]) => { let n = a.length; while (n && a[n - 1].space) n--; return n === a.length ? a : a.slice(0, n); };
  const width = (arr: Item[]) => {
    if (plain) return measure(arr.map((i) => i.ch).join(''));
    const ad = advances(arr);
    return ad.reduce((s, x) => s + x, 0) - (arr.length ? trk(arr[arr.length - 1]) : 0);
  };
  const hyphenOf = (it: Item): Item => ({ ...it, ch: '-', src: -1, space: false, tcy: false });

  // paragraphs → lines
  const paras: Item[][] = [[]];
  for (const it of items) { if (it.ch === '\n') paras.push([]); else paras[paras.length - 1].push(it); }
  const box = o.box && o.box[0] > 0 ? o.box : undefined;
  const span = box ? (vertical ? box[1] > 0 ? box[1] : Infinity : box[0]) : Infinity;
  const indL = o.indentLeft ?? 0, indR = o.indentRight ?? 0, indF = o.indentFirst ?? 0;
  const lines: { items: Item[]; para: number; first: boolean; last: boolean }[] = [];
  paras.forEach((para, pi) => {
    const avail = (n: number) => span - indL - indR - (n === 0 ? indF : 0);
    const out: Item[][] = [];
    if (span === Infinity) out.push(para);
    else if (o.composer === 'every') out.push(...everyLine(para, avail));
    else {
      // single-line composer: greedy, word by word (a word longer than the line breaks by characters)
      const queue: Item[][] = [];
      for (const it of para) { const last = queue[queue.length - 1]; if (last && last[0].space === it.space) last.push(it); else queue.push([it]); }
      let cur: Item[] = [];
      while (queue.length) {
        const word = queue.shift()!, ws = word[0].space, W = avail(out.length);
        const next = cur.concat(word);
        if (width(trimEnd(next)) <= W || !trimEnd(cur).length) {
          if (width(trimEnd(next)) > W && !ws) {
            const h = o.hyphenate ? hyphenFit(cur, word, W) : null;
            if (h) { out.push(h[0]); cur = []; queue.unshift(h[1]); continue; }
            for (const c of word) { if (width(cur.concat(c)) > avail(out.length) && cur.length) { out.push(trimEnd(cur)); cur = []; } cur.push(c); }
          } else cur = next;
        } else {
          const h = o.hyphenate && !ws ? hyphenFit(cur, word, W) : null;
          if (h) { out.push(h[0]); cur = []; queue.unshift(h[1]); continue; }
          out.push(trimEnd(cur));
          if (o.hyphenate && !ws) { cur = []; queue.unshift(word); } else cur = ws ? [] : word;
        }
      }
      out.push(trimEnd(cur));
    }
    out.forEach((l, i) => lines.push({ items: l, para: pi, first: i === 0, last: i === out.length - 1 }));
  });
  /** the longest start of `word` (up to a syllable break) that fits on the line after `cur`, with its hyphen */
  function hyphenFit(cur: Item[], word: Item[], W: number): [Item[], Item[]] | null {
    const str = word.map((i) => i.ch).join('');
    const pts = hyphenPoints(str);
    for (let n = pts.length - 1; n >= 0; n--) {
      let k = 0, u = 0;
      while (k < word.length && u < pts[n]) u += word[k++].ch.length;
      const line = cur.concat(word.slice(0, k), [hyphenOf(word[k - 1])]);
      if (width(line) <= W) return [line, word.slice(k)];
    }
    return null;
  }
  /** every-line composer: the breaks that make the paragraph's lines most even (least squared slack, hyphens and
   *  breaks inside words cost extra), looking at all of them at once */
  function everyLine(para: Item[], avail: (n: number) => number): Item[][] {
    if (!para.length) return [[]];
    const ad = advances(para), pre = [0];
    for (const x of ad) pre.push(pre[pre.length - 1] + x);
    // break candidates: [position, hyphen?, cost]
    const cand: [number, boolean, number][] = [];
    const words: [number, number][] = [];
    for (let i = 0; i < para.length;) { const j0 = i; while (i < para.length && para[i].space === para[j0].space) i++; if (!para[j0].space) words.push([j0, i]); }
    const minW = Math.min(avail(0), avail(1));
    for (const [a, b] of words) {
      if (o.hyphenate) {
        const str = para.slice(a, b).map((i) => i.ch).join('');
        for (const p of hyphenPoints(str)) { let k = a, u = 0; while (k < b && u < p) u += para[k++].ch.length; cand.push([k, true, 0.3]); }
      }
      if (pre[b] - pre[a] > minW) for (let k = a + 1; k < b; k++) cand.push([k, false, 1e4]);
      cand.push([b, false, 0]);
    }
    cand.sort((x, y) => x[0] - y[0]);
    const hyW = measure('-');
    const skip = (i: number) => { while (i < para.length && para[i].space) i++; return i; };
    const best = new Map<number, { cost: number; from: number; hy: boolean }>([[0, { cost: 0, from: -1, hy: false }]]);
    const starts = [0];
    let lastEnd = cand.length ? cand[cand.length - 1][0] : para.length;
    if (lastEnd < para.length) { cand.push([para.length, false, 0]); lastEnd = para.length; }
    for (const [e, hy, pen] of cand) {
      let bestHere: { cost: number; from: number; hy: boolean } | null = null;
      for (const s of starts) {
        const b0 = best.get(s)!;
        const st = skip(s);
        if (e <= st) continue;
        const W = avail(s === 0 ? 0 : 1);
        const w = pre[e] - pre[st] - trk(para[e - 1]) + (hy ? hyW * para[e - 1].k : 0);
        const lastLine = e === lastEnd;
        let c: number;
        if (w > W) c = 1e6 + (w - W);
        else c = lastLine ? 0 : ((W - w) / W) ** 2 * 100;
        c += pen + b0.cost;
        if (!bestHere || c < bestHere.cost) bestHere = { cost: c, from: s, hy };
      }
      if (bestHere) { const prev = best.get(e); if (!prev || bestHere.cost < prev.cost) best.set(e, bestHere); if (!starts.includes(e)) starts.push(e); }
    }
    const out: Item[][] = [];
    let e = lastEnd;
    while (e > 0) {
      const b = best.get(e);
      if (!b) break;
      const st = skip(b.from);
      const l = para.slice(st, e);
      out.unshift(trimEnd(b.hy ? l.concat(hyphenOf(para[e - 1])) : l));
      e = b.from;
    }
    return out.length ? out : [para];
  }

  // keep the lines (columns) that fit in the box
  const lh = o.leading > 0 ? o.leading : size * 1.2;
  const sb = o.spaceBefore ?? 0, sa = o.spaceAfter ?? 0;
  const offs: number[] = [];
  lines.forEach((l, i) => offs.push(i === 0 ? 0 : offs[i - 1] + lh + (l.first ? sa + sb : 0)));
  let keep = lines.length;
  const across = box ? (vertical ? box[0] : box[1]) : 0;
  if (box && across > 0) { keep = 0; while (keep < lines.length && offs[keep] + lh + size * 0.3 <= across + 1e-6) keep++; keep = Math.max(1, keep); }
  const L = lines.slice(0, keep);

  const glyphs: Glyph[] = [];
  let idx = 0, ns = 0, word = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  L.forEach((line, li) => {
    const its = line.items, ad = advances(its);
    const total = ad.reduce((a, b) => a + b, 0) - (its.length ? trk(its[its.length - 1]) : 0);
    // the line's span: box edges (or the origin for point text) moved by the indents
    const bw = box ? (vertical ? (box[1] > 0 ? box[1] : 0) : box[0]) : 0;
    const A = -bw / 2 + indL + (line.first ? indF : 0), B = bw / 2 - indR;
    let al: 'left' | 'center' | 'right' = o.align, extra = 0, gaps = 0, letterGaps = false;
    if (box && o.justify) {
      if (!line.last || o.justify === 'all') {
        al = 'left';
        extra = Math.max(0, B - A - total);
        gaps = its.filter((it, i) => it.space && i > 0 && i < its.length - 1).length;
        if (!gaps && its.length > 1) { gaps = its.length - 1; letterGaps = true; }
      } else al = o.justify;
    }
    let pos = al === 'left' ? A : al === 'right' ? B - total : (A + B) / 2 - total / 2;
    if (!box && !vertical && !indL && !indR && !indF) pos = al === 'left' ? 0 : al === 'right' ? -total : -total / 2;
    const cross = vertical ? (box ? box[0] / 2 - lh / 2 : 0) - offs[li] : offs[li] + (box && box[1] > 0 ? -box[1] / 2 + size * 0.9 : 0);
    let prevSpace = true;
    for (let i = 0; i < its.length; i++) {
      const it = its[i], space = it.space;
      if (!space && prevSpace && glyphs.length) word++;
      prevSpace = space;
      const g: Glyph = { ch: it.ch, x: 0, y: 0, w: ad[i], line: li, word, idx: idx++, idxNoSpace: space ? -1 : ns++, space };
      g.src = it.src;
      if (it.k !== 1) g.k = it.k;
      if (it.hs !== 1) g.hs = it.hs;
      if (it.vs !== 1) g.vs = it.vs;
      if (it.fb) g.fb = true;
      if (it.fi) g.fi = true;
      if (!vertical) {
        g.x = pos; g.y = cross - it.bs;
        minX = Math.min(minX, pos); maxX = Math.max(maxX, pos + ad[i]);
      } else if (it.tcy) {
        // Tate-chu-yoko: the group side by side across the column, squeezed into one em
        let j = i; while (j < its.length && its[j].tcy) j++;
        const ws = its.slice(i, j).map((x) => measure(x.ch) * x.k * x.hs), wg = ws.reduce((a, b) => a + b, 0);
        const c = Math.min(1, (size * it.k) / Math.max(1e-6, wg));
        let x = cross - (wg * c) / 2 + it.bs;
        const cy = pos + (ad[i] - trk(it)) / 2;
        for (let m = i; m < j; m++) {
          const gm: Glyph = m === i ? g : { ch: its[m].ch, x: 0, y: 0, w: 0, line: li, word, idx: idx++, idxNoSpace: ns++, space: false };
          gm.src = its[m].src;
          gm.w = ws[m - i] * c; gm.x = x; gm.y = cy + size * PIVOT * its[m].k * its[m].vs;
          gm.hs = its[m].hs * c; if (gm.hs === 1) delete gm.hs;
          if (its[m].k !== 1) gm.k = its[m].k;
          if (its[m].fb) gm.fb = true;
          if (its[m].fi) gm.fi = true;
          x += gm.w;
          if (m > i) glyphs.push(gm);
          minX = Math.min(minX, gm.x); maxX = Math.max(maxX, gm.x + gm.w);
        }
        minY = Math.min(minY, pos); maxY = Math.max(maxY, pos + ad[i]);
        pos += ad[i];
        // the group's first glyph goes first; the others were added above in order
        glyphs.splice(glyphs.length - (j - i - 1), 0, g);
        i = j - 1;
        prevSpace = false;
        continue;
      } else {
        const rot = isRot(it);
        const dw = measure(it.ch) * it.k * it.hs;
        g.w = dw;
        const cy = pos + (ad[i] - trk(it)) / 2;
        g.x = cross + it.bs - dw / 2; g.y = cy + size * PIVOT * it.k * it.vs;
        if (rot) g.rot = 90;
        minX = Math.min(minX, g.x); maxX = Math.max(maxX, g.x + dw); minY = Math.min(minY, pos); maxY = Math.max(maxY, pos + ad[i]);
      }
      pos += ad[i] + (extra && gaps && (letterGaps ? i < its.length - 1 : space && i > 0 && i < its.length - 1) ? extra / gaps : 0);
      glyphs.push(g);
    }
    prevSpace = true;
    if (li < L.length - 1) word++;
  });
  if (!glyphs.length) { minX = 0; maxX = 0; }
  const bounds: Layout['bounds'] = vertical ? (glyphs.length ? [minX, minY, maxX, maxY] : [0, 0, 0, 0]) : [minX, -size * 0.9, maxX, (L.length ? offs[L.length - 1] : 0) + size * 0.3];
  return { glyphs, lines: L.length, words: glyphs.length ? word + 1 : 0, noSpace: ns, bounds, ...(vertical ? { vertical } : {}) };
}

function unitOf(g: Glyph, b: BasedOn): number {
  if (b === 'words') return g.word;
  if (b === 'lines') return g.line;
  if (b === 'charsNoSpace') return g.idxNoSpace;
  return g.idx;
}
function unitCount(l: Layout, b: BasedOn): number {
  return b === 'words' ? l.words : b === 'lines' ? l.lines : b === 'charsNoSpace' ? l.noSpace : l.glyphs.length;
}

function permutation(n: number, seed: number): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd(seed, i) * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  return p;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function selectorWeights(sel: Selector, layout: Layout, t: number, env: Env, path: string): number[] {
  const n = unitCount(layout, sel.basedOn);
  const ev = (p: unknown, k: string) => num(valueAt(p as never, t, { ...env, path: `${path}.${k}` }));
  const out = new Array<number>(layout.glyphs.length).fill(0);
  if (!n) return out;
  if (sel.type === 'wiggly') {
    const mx = ev(sel.maxAmount, 'maxAmount') / 100, mn = ev(sel.minAmount, 'minAmount') / 100;
    const speed = ev(sel.speed, 'speed'), corr = Math.max(0, Math.min(100, ev(sel.correlation, 'correlation'))) / 100;
    layout.glyphs.forEach((g, i) => {
      const u = unitOf(g, sel.basedOn);
      if (u < 0) return;
      const x = t * speed + u * (1 - corr) * 3.17;
      const v = 0.5 + 0.5 * fbm(x + corr * 0, hash2(sel.seed, corr < 1 ? 0 : 1), 2);
      out[i] = mn + (mx - mn) * v;
    });
    return out;
  }
  const s = ev(sel.start, 'start'), e = ev(sel.end, 'end'), o = ev(sel.offset, 'offset');
  const amount = ev(sel.amount, 'amount') / 100;
  let a = ((s + o) / 100) * n, b = ((e + o) / 100) * n;
  if (a > b) [a, b] = [b, a];
  const perm = sel.randomize ? permutation(n, sel.seed) : null;
  layout.glyphs.forEach((g, i) => {
    let u = unitOf(g, sel.basedOn);
    if (u < 0) return;
    if (perm) u = perm[u];
    let w: number;
    if (sel.shape === 'square') w = Math.max(0, Math.min(1, Math.min(b, u + 1) - Math.max(a, u)));
    else {
      const c = u + 0.5;
      const span = b - a;
      const x = span > 1e-9 ? (c - a) / span : c >= a ? 2 : -1;
      const inside = x >= 0 && x <= 1;
      switch (sel.shape) {
        case 'rampUp': w = x <= 0 ? 0 : x >= 1 ? 1 : x; break;
        case 'rampDown': w = x <= 0 ? 1 : x >= 1 ? 0 : 1 - x; break;
        case 'triangle': w = inside ? 1 - Math.abs(2 * x - 1) : 0; break;
        case 'round': w = inside ? Math.sqrt(Math.max(0, 1 - (2 * x - 1) ** 2)) : 0; break;
        default: w = inside ? 0.5 - 0.5 * Math.cos(2 * Math.PI * x) : 0;
      }
    }
    out[i] = w * amount;
  });
  return out;
}

/** Combined weight of an animator for each glyph. */
export function animatorWeights(comp: Comp, layer: Layer, an: TextAnimator, layout: Layout, t: number): number[] {
  const env: Env = { comp, layer, path: '' };
  if (!an.selectors.length) return layout.glyphs.map(() => 1);
  let total = layout.glyphs.map(() => 0);
  an.selectors.forEach((s, si) => {
    const w = selectorWeights(s, layout, t, env, `text.animators.${an.id}.selectors.${si}`);
    total = si === 0 && s.mode !== 'intersect' ? (s.mode === 'subtract' ? total.map((_, i) => Math.max(0, 1 - w[i])) : w.slice())
      : total.map((x, i) => (s.mode === 'add' ? Math.min(1, x + w[i]) : s.mode === 'subtract' ? Math.max(0, x - w[i]) : x * w[i]));
  });
  return total;
}

const SETS = ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'];
/** Character offset animator: shifts letters/digits within their set (decoder look). */
export function offsetChar(ch: string, by: number): string {
  const n = Math.round(by);
  if (!n) return ch;
  for (const s of SETS) {
    const i = s.indexOf(ch);
    if (i >= 0) return s[(((i + n) % s.length) + s.length) % s.length];
  }
  return ch;
}

/** Deterministic per-glyph random in [0,1) (for decoder flicker etc.). */
export const glyphRandom = (seed: number, i: number, frame: number) => rnd(hash2(seed, frame), i);
