// Editing operations of «texto»: After Effects' Character / Paragraph attributes on a whole text layer or on a range
// of its characters, text orientation, point ↔ paragraph text and editing the source text keeping the styled runs.
import type { Editor } from '../ops';
import { keyedAt, setKey } from './anim';
import { findComp, findLayer, newLayer, type CharStyle, type Layer, type TextDoc } from './model';
import { applyRunStyle, shiftRuns } from './textstyle';

/** Character attributes (null: back to the layer's / default). */
export type CharPatch = { [K in keyof CharStyle]?: CharStyle[K] | null };
export interface ParagraphPatch {
  align?: TextDoc['align'];
  /** justify the lines of paragraph text (last line left / centre / right, or all); null = not justified */
  justify?: TextDoc['justify'] | null;
  indentLeft?: number;
  indentRight?: number;
  indentFirst?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  hyphenate?: boolean;
  composer?: 'every' | 'single';
}
export interface TextFormat {
  character?: CharPatch;
  /** [start, end) UTF-16 offsets of the source text the character attributes go to (default: all of it) */
  range?: [number, number] | null;
  paragraph?: ParagraphPatch;
  /** Orientación del texto */
  vertical?: boolean;
  /** Alineación latina vertical estándar */
  romanStd?: boolean;
  /** Dígitos hindi */
  hindiDigits?: boolean;
  /** comp time whose source text `range` refers to (keyframed source text) */
  t?: number;
}

const CHAR_KEYS: (keyof CharStyle)[] = ['fauxBold', 'fauxItalic', 'allCaps', 'smallCaps', 'script', 'baselineShift', 'tsume', 'vScale', 'hScale', 'tcy'];
const RANGE: Partial<Record<keyof CharStyle | keyof ParagraphPatch, [number, number]>> = {
  baselineShift: [-10000, 10000], tsume: [0, 100], vScale: [1, 10000], hScale: [1, 10000],
  indentLeft: [-10000, 10000], indentRight: [-10000, 10000], indentFirst: [-10000, 10000], spaceBefore: [-10000, 10000], spaceAfter: [-10000, 10000],
};
const clampNum = (k: string, v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${k} debe ser un número.`);
  const r = RANGE[k as keyof typeof RANGE];
  return r ? Math.max(r[0], Math.min(r[1], n)) : n;
};
const NL = String.fromCharCode(10);
const textOf =(l: Layer) => { if (!l.text) throw new Error(`«${l.name}» no es una capa de texto.`); return l.text; };
const srcText = (d: TextDoc, t = 0) => String(keyedAt(d.text, t) ?? '');

/** Applies a format to a text document (exported for the UI's live preview and the tests). */
export function formatText(d: TextDoc, o: TextFormat, t = 0) {
  if (o.character) {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o.character)) {
      if (v === undefined) continue;
      if (!CHAR_KEYS.includes(k as keyof CharStyle)) throw new Error(`Atributo de carácter desconocido «${k}». Hay: ${CHAR_KEYS.join(', ')}.`);
      if (v === null) patch[k] = null;
      else if (k === 'script') { if (!['super', 'sub', 'none'].includes(String(v))) throw new Error('script es super, sub o none.'); patch[k] = v; }
      else if (typeof v === 'boolean') patch[k] = v;
      else patch[k] = clampNum(k, v);
    }
    const len = srcText(d, t).length;
    const [s, e] = o.range ? [Math.max(0, Math.min(len, o.range[0])), Math.max(0, Math.min(len, o.range[1]))] : [0, len];
    if (o.range && e <= s) throw new Error('El intervalo de caracteres está vacío.');
    applyRunStyle(d, s, o.range ? e : Math.max(1, len), patch, len);
  }
  const p = o.paragraph;
  if (p) {
    if (p.align !== undefined) { if (!['left', 'center', 'right'].includes(p.align)) throw new Error('align es left, center o right.'); d.align = p.align; }
    if (p.justify !== undefined) {
      if (p.justify === null) delete d.justify;
      else { if (!['left', 'center', 'right', 'all'].includes(p.justify)) throw new Error('justify es left, center, right o all.'); d.justify = p.justify; if (p.justify !== 'all') d.align = p.justify; }
    }
    for (const k of ['indentLeft', 'indentRight', 'indentFirst', 'spaceBefore', 'spaceAfter'] as const) if (p[k] !== undefined) { const v = clampNum(k, p[k]); if (v) d[k] = v; else delete d[k]; }
    if (p.hyphenate !== undefined) { if (p.hyphenate) d.hyphenate = true; else delete d.hyphenate; }
    if (p.composer !== undefined) { if (p.composer !== 'every' && p.composer !== 'single') throw new Error('composer es every o single.'); d.composer = p.composer; }
  }
  for (const k of ['vertical', 'romanStd', 'hindiDigits'] as const) if (o[k] !== undefined) { if (o[k]) d[k] = true; else delete d[k]; }
}

export const TEXT_OPS = {
  /** Character / Paragraph panel attributes on a text layer (or on a range of its characters). */
  textFormat(e: Editor, compId: string, layerId: string, o: TextFormat): Layer {
    return e.mutate(o.vertical !== undefined && !o.character && !o.paragraph ? 'Cambiar la orientación del texto' : o.paragraph && !o.character ? 'Cambiar párrafo' : 'Cambiar carácter', (p) => {
      const l = findLayer(findComp(p.comps, compId), layerId);
      formatText(textOf(l), o, o.t ?? 0);
      return l;
    });
  },
  /** Types new source text (at t when the text is keyframed), keeping styled runs on their characters and the
   *  layer's name when it followed the text. */
  textEdit(e: Editor, compId: string, layerId: string, value: string, t?: number): Layer {
    return e.mutate('Editar texto', (p) => {
      const l = findLayer(findComp(p.comps, compId), layerId);
      const d = textOf(l);
      const keyed = !!d.text.k?.length;
      const old = srcText(d, t ?? 0);
      if (keyed) setKey(d.text, Math.max(0, t ?? 0), value); else d.text.v = value;
      shiftRuns(d, old, value);
      if ((!old && l.name === 'Texto') || l.name === old.split('\n')[0].slice(0, 40)) l.name = value.split('\n')[0].slice(0, 40) || 'Texto';
      return l;
    });
  },
  /** Type tool: point text at `position` (comp px), or paragraph text in a `box` [w, h] centred there (every-line
   *  composer, aligned left as After Effects' Paragraph panel defaults); `vertical` = Vertical Type tool. */
  textCreate(e: Editor, compId: string, o: { position: number[]; size?: number; text?: string; vertical?: boolean; box?: number[] | null; font?: string; color?: string }): Layer {
    return e.mutate('Nueva capa', (p) => {
      const c = findComp(p.comps, compId);
      const l = newLayer('text', c, {});
      const d = l.text!;
      d.text.v = o.text ?? 'Texto';
      if (o.size) d.size.v = Math.max(1, o.size);
      if (o.font) d.font = o.font;
      if (o.color) d.fill.v = o.color;
      if (o.box) { d.box = [Math.max(1, Number(o.box[0]) || 1), Math.max(0, Number(o.box[1]) || 0)]; d.composer = 'every'; d.align = 'left'; }
      if (o.vertical) { d.vertical = true; d.align = 'left'; }
      l.name = String(d.text.v).split(NL)[0].slice(0, 40) || 'Texto';
      const pos = l.transform.position.v as number[];
      l.transform.position.v = [Number(o.position[0]) || 0, Number(o.position[1]) || 0, pos[2] ?? 0];
      l.start = l.in = Math.max(0, Math.min(c.duration, l.in));
      c.layers.unshift(l);
      return l;
    });
  },
  /** Convertir a texto de párrafo (box) / de punto (null): `anchorDelta` keeps the characters where they were;
   *  converting to point text, `ranges` [s, e) are the wrapped lines, joined with returns as After Effects does. */
  textConvert(e: Editor, compId: string, layerId: string, o: { box: number[] | null; anchorDelta?: number[]; ranges?: [number, number][]; t?: number }): Layer {
    return e.mutate(o.box ? 'Convertir a texto de párrafo' : 'Convertir a texto de punto', (p) => {
      const l = findLayer(findComp(p.comps, compId), layerId);
      const d = textOf(l);
      if (o.box) { d.box = [Math.max(1, Number(o.box[0]) || 1), Math.max(0, Number(o.box[1]) || 0)]; d.composer ??= 'every'; } else delete d.box;
      const [dx, dy] = [Number(o.anchorDelta?.[0]) || 0, Number(o.anchorDelta?.[1]) || 0];
      if (dx || dy) {
        const a = l.transform.anchor;
        const sh = (v: unknown) => { const q = [...(v as number[])]; q[0] += dx; q[1] += dy; return q; };
        a.v = sh(a.v);
        for (const k of a.k ?? []) k.v = sh(k.v);
      }
      if (!o.box && o.ranges?.length) {
        const src = srcText(d, o.t ?? 0);
        let at = 0;
        const map = o.ranges.map(([s, e2]) => { const r = { s, e: e2, at }; at += e2 - s + 1; return r; });
        const text = o.ranges.map(([s, e2]) => src.slice(s, e2)).join(NL);
        if (d.text.k?.length) setKey(d.text, Math.max(0, o.t ?? 0), text); else d.text.v = text;
        if (d.runs) {
          const runs: NonNullable<TextDoc['runs']> = [];
          for (const r of d.runs) for (const m of map) { const s = Math.max(r.s, m.s), e2 = Math.min(r.e, m.e); if (e2 > s) runs.push({ s: m.at + s - m.s, e: m.at + e2 - m.s, style: { ...r.style } }); }
          if (runs.length) d.runs = runs; else delete d.runs;
        }
      }
      return l;
    });
  },
};
