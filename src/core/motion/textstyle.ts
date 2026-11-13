// After Effects' Character / Paragraph attributes beyond font, size and colour: per-character styles (Faux bold,
// Faux italic, All caps, Small caps, Superscript, Subscript, baseline shift, tsume, vertical / horizontal scale,
// Tate-chu-yoko), runs of them over the source text, and syllable hyphenation for paragraph text.
import type { CharStyle, TextDoc } from './model';

/** Photoshop / After Effects text engine defaults: small caps at 70 %, super/subscript at 58.3 % size and ±33.3 %. */
export const SMALL_CAPS = 0.7;
export const SCRIPT_SIZE = 0.583;
export const SCRIPT_POS = 0.333;
/** Faux italic slant (degrees) and Faux bold extra stroke (fraction of the size, both sides). */
export const FAUX_ITALIC = 12;
export const FAUX_BOLD = 0.04;

const KEYS: (keyof CharStyle)[] = ['fauxBold', 'fauxItalic', 'allCaps', 'smallCaps', 'script', 'baselineShift', 'tsume', 'vScale', 'hScale', 'tcy'];

/** The layer-wide character style of a text document. */
export function baseStyle(d: TextDoc): CharStyle {
  const s: CharStyle = {};
  for (const k of KEYS) { const v = (d as unknown as Record<string, unknown>)[k]; if (v !== undefined && v !== null) (s as Record<string, unknown>)[k] = v; }
  return s;
}
export const hasCharExtras = (d: TextDoc) => KEYS.some((k) => k !== 'allCaps' && (d as unknown as Record<string, unknown>)[k] != null) || !!d.runs?.length || !!d.hindiDigits;

/** The layout options of a text document beyond size, tracking, leading, alignment and box (text.ts layoutText). */
export function layoutExtras(d: TextDoc) {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    allCaps: d.allCaps, hindiDigits: d.hindiDigits || undefined,
    style: KEYS.some((k) => k !== 'allCaps' && (d as unknown as Record<string, unknown>)[k] != null) || d.runs?.length ? styleResolver(d) : undefined,
    justify: d.justify ?? undefined, indentLeft: n(d.indentLeft), indentRight: n(d.indentRight), indentFirst: n(d.indentFirst), spaceBefore: n(d.spaceBefore), spaceAfter: n(d.spaceAfter),
    hyphenate: d.hyphenate || undefined, composer: d.composer ?? undefined, vertical: (!!d.vertical && !d.path) || undefined, romanStd: d.romanStd || undefined,
  };
}

/** Style of the character at UTF-16 offset i: the layer's, then every run covering it (later runs win). */
export function styleResolver(d: TextDoc): (i: number) => CharStyle {
  const base = baseStyle(d), runs = d.runs ?? [];
  if (!runs.length) return () => base;
  return (i) => {
    let s = base;
    for (const r of runs) if (i >= r.s && i < r.e) { s = s === base ? { ...base } : s; for (const [k, v] of Object.entries(r.style)) if (v !== undefined && v !== null) (s as Record<string, unknown>)[k] = v; }
    return s;
  };
}

/** Apply a style patch to [s, e) of a document's runs (null values remove the attribute there). Merges and drops
 *  empty runs; a range covering the whole text with no runs writes the layer attributes instead. */
export function applyRunStyle(d: TextDoc, s: number, e: number, patch: Partial<Record<keyof CharStyle, unknown>>, textLen: number) {
  if (e <= s) return;
  if (s <= 0 && e >= textLen) {
    // whole text: layer attributes, and the runs lose these keys
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) delete (d as unknown as Record<string, unknown>)[k]; else (d as unknown as Record<string, unknown>)[k] = v;
      for (const r of d.runs ?? []) delete (r.style as Record<string, unknown>)[k];
    }
    d.runs = (d.runs ?? []).filter((r) => Object.keys(r.style).length);
    if (!d.runs.length) delete d.runs;
    return;
  }
  // split the existing runs at s and e, then patch the ones inside and add one for the uncovered gaps
  const out: { s: number; e: number; style: CharStyle }[] = [];
  for (const r of d.runs ?? []) {
    const cuts = [r.s, Math.max(r.s, Math.min(r.e, s)), Math.max(r.s, Math.min(r.e, e)), r.e];
    for (let i = 0; i < 3; i++) if (cuts[i + 1] > cuts[i]) out.push({ s: cuts[i], e: cuts[i + 1], style: { ...r.style } });
  }
  const covered = out.filter((r) => r.s >= s && r.e <= e).sort((a, b) => a.s - b.s);
  let x = s;
  for (const r of covered) { if (r.s > x) out.push({ s: x, e: r.s, style: {} }); x = Math.max(x, r.e); }
  if (x < e) out.push({ s: x, e, style: {} });
  for (const r of out) if (r.s >= s && r.e <= e) for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // null on a run means "as the layer": remove the override
    if (v === null) delete (r.style as Record<string, unknown>)[k]; else (r.style as Record<string, unknown>)[k] = v;
  }
  out.sort((a, b) => a.s - b.s);
  const merged: typeof out = [];
  for (const r of out) {
    if (!Object.keys(r.style).length) continue;
    const p = merged[merged.length - 1];
    if (p && p.e === r.s && JSON.stringify(p.style) === JSON.stringify(r.style)) p.e = r.e; else merged.push(r);
  }
  if (merged.length) d.runs = merged; else delete d.runs;
}

/** Keep runs on the same characters after the source text changes from `a` to `b` (one edited span). */
export function shiftRuns(d: TextDoc, a: string, b: string) {
  if (!d.runs?.length || a === b) return;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const oldEnd = a.length - q, delta = b.length - a.length;
  const map = (i: number, end: boolean) => (i <= p ? i : i >= oldEnd ? i + delta : end ? p + (b.length - q - p) : p);
  d.runs = d.runs.map((r) => ({ ...r, s: map(r.s, false), e: map(r.e, true) })).filter((r) => r.e > r.s);
  if (!d.runs.length) delete d.runs;
}

// ───────────────────────── hyphenation ─────────────────────────
const V = 'aeiouáéíóúüàèìòùâêîôûäëïöyAEIOUÁÉÍÓÚÜÀÈÌÒÙÂÊÎÔÛÄËÏÖY';
const STRONG = 'aeoáéíóúàèìòùAEOÁÉÍÓÚÀÈÌÒÙ';
const isV = (c: string) => V.includes(c);
const isL = (c: string) => /\p{L}/u.test(c);
/** inseparable consonant pairs (they start a syllable together) */
const ONSET = new Set(['pr', 'br', 'tr', 'dr', 'cr', 'gr', 'fr', 'kr', 'pl', 'bl', 'cl', 'gl', 'fl', 'kl', 'ch', 'll', 'rr', 'th', 'sh', 'ph', 'wh', 'qu']);

/** Syllable boundaries of a word (indices where a hyphen may go), by Spanish syllabification rules — they also give
 *  reasonable breaks in other Latin-script languages. Photoshop / After Effects limits: words of at least 7 letters,
 *  3 letters before and 3 after the break. */
export function hyphenPoints(word: string, o = { minWord: 7, before: 3, after: 3 }): number[] {
  const w = [...word];
  if (w.length < o.minWord || !w.every(isL)) return [];
  const low = w.map((c) => c.toLowerCase());
  const nuclei: [number, number][] = [];
  for (let i = 0; i < low.length;) {
    // y is a vowel only when not followed by a vowel (ya, yo are consonant + vowel)
    const vowel = (j: number) => isV(low[j]) && !(low[j] === 'y' && j + 1 < low.length && isV(low[j + 1])) && !(low[j] === 'u' && j > 0 && (low[j - 1] === 'q' || low[j - 1] === 'g') && j + 1 < low.length && 'eiéí'.includes(low[j + 1]));
    if (!vowel(i)) { i++; continue; }
    let j = i + 1;
    // diphthongs / triphthongs: two strong vowels split (hiatus), an accented weak one too
    while (j < low.length && vowel(j) && !(STRONG.includes(low[j - 1]) && STRONG.includes(low[j])) && !'íú'.includes(low[j]) && !'íú'.includes(low[j - 1])) j++;
    nuclei.push([i, j]);
    i = j;
  }
  const pts: number[] = [];
  for (let n = 0; n + 1 < nuclei.length; n++) {
    const a = nuclei[n][1], b = nuclei[n + 1][0], cons = low.slice(a, b).join('');
    let cut: number;
    if (cons.length === 0) cut = a;
    else if (cons.length === 1) cut = a;
    else if (cons.length === 2) cut = ONSET.has(cons) ? a : a + 1;
    else if (cons.length === 3) cut = ONSET.has(cons.slice(1)) ? a + 1 : a + 2;
    else cut = ONSET.has(cons.slice(-2)) ? b - 2 : b - 1;
    if (cut >= o.before && w.length - cut >= o.after) pts.push(cut);
  }
  // back to UTF-16 offsets
  return pts.map((k) => w.slice(0, k).join('').length);
}
