// «vectores» in the renderer: the font files behind text layers (asked to the main process, parsed here), glyph
// outlines placed exactly where the canvas draws each character (Create Shapes / Masks from Text) and variable-font
// axes (Chromium's canvas has no font-variation-settings, so a text layer with axes draws its glyphs from the
// outlines of the font file with those axis values).
import { OTFont, pathToContours } from '../core/motion/fontfile';
import { valueAt } from '../core/motion/anim';
import type { Comp, Layer, TextDoc } from '../core/motion/model';
import type { Project } from '../core/model';

const bridge = () => (window as unknown as { cinta: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).cinta;

const key = (d: Pick<TextDoc, 'font' | 'weight' | 'italic'>) => `${d.font}|${d.weight}|${d.italic ? 1 : 0}`;
const loaded = new Map<string, OTFont | null>();
const pending = new Map<string, Promise<OTFont | null>>();
const files = new Map<string, OTFont>();

/** The parsed font file of a text style (null: not installed / unreadable; undefined: not asked yet). */
export const fontOf = (d: Pick<TextDoc, 'font' | 'weight' | 'italic'>): OTFont | null | undefined => loaded.get(key(d));

export function loadFont(d: Pick<TextDoc, 'font' | 'weight' | 'italic'>): Promise<OTFont | null> {
  const k = key(d);
  if (loaded.has(k)) return Promise.resolve(loaded.get(k)!);
  let p = pending.get(k);
  if (!p) {
    p = (async () => {
      let f: OTFont | null = null;
      try {
        const r = await bridge().invoke('font:get', d.font, d.weight, d.italic) as { path: string; index: number; bytes?: Uint8Array } | null;
        if (r) {
          const fk = `${r.path}#${r.index}`;
          f = files.get(fk) ?? null;
          if (!f && r.bytes) { f = new OTFont(new Uint8Array(r.bytes), r.index); files.set(fk, f); }
          if (!f) { const r2 = await bridge().invoke('font:get', d.font, d.weight, d.italic, true) as { bytes: Uint8Array } | null; if (r2?.bytes) { f = new OTFont(new Uint8Array(r2.bytes), r.index); files.set(fk, f); } }
        }
      } catch { f = null; }
      loaded.set(k, f);
      pending.delete(k);
      return f;
    })();
    pending.set(k, p);
  }
  return p;
}

/** Does this text layer draw with variation axes of its own? */
export const usesAxes = (l: Layer) => !!l.text?.axes && Object.keys(l.text.axes).length > 0;

/** Loads the fonts of the text layers with axes (also inside nested comps) before a frame is drawn. */
export async function prepareFonts(project: Project, comp: Comp, seen = new Set<string>()): Promise<void> {
  if (seen.has(comp.id)) return;
  seen.add(comp.id);
  const wait: Promise<unknown>[] = [];
  for (const l of comp.layers) {
    if (l.type === 'text' && usesAxes(l) && fontOf(l.text!) === undefined) wait.push(loadFont(l.text!));
    if (l.compId) { const c = project.comps?.find((x) => x.id === l.compId); if (c) wait.push(prepareFonts(project, c, seen)); }
  }
  await Promise.all(wait);
}

/** Axis values of a text layer at t: the font's defaults, wght from the style's weight (as CSS does with a variable
 *  font), then the layer's own axes. */
export function axesAt(comp: Comp, l: Layer, t: number, f: OTFont): Record<string, number> {
  const d = l.text!, out: Record<string, number> = {};
  for (const a of f.axes) out[a.tag] = a.def;
  if (f.axes.some((a) => a.tag === 'wght')) out.wght = d.weight;
  for (const [tag, p] of Object.entries(d.axes ?? {})) {
    const v = valueAt(p, t, { comp, layer: l, path: `text.axes.${tag}` });
    if (typeof v === 'number' && Number.isFinite(v)) out[tag] = v;
  }
  return out;
}

/** Path2D of a glyph in pixels: origin at the left of the baseline, y down (cached per font / axes / size). */
const p2d = new Map<string, Path2D>();
export function glyphPath2D(f: OTFont, ch: string, size: number, axes: Record<string, number>): Path2D {
  const k = `${f.info.fullName}|${ch}|${size}|${JSON.stringify(axes)}`;
  let p = p2d.get(k);
  if (p) return p;
  p = new Path2D();
  for (const c of pathToContours(f.path(f.glyphId(ch), f.axes.length ? axes : undefined), size / f.unitsPerEm, 0, 0)) {
    const n = c.length / 6;
    for (let i = 0; i < n; i++) {
      const x = c[i * 6], y = c[i * 6 + 1];
      if (!i) { p.moveTo(x, y); continue; }
      const q = (i - 1) * 6;
      p.bezierCurveTo(c[q] + c[q + 4], c[q + 1] + c[q + 5], x + c[i * 6 + 2], y + c[i * 6 + 3], x, y);
    }
    const q = (n - 1) * 6;
    p.bezierCurveTo(c[q] + c[q + 4], c[q + 1] + c[q + 5], c[0] + c[2], c[1] + c[3], c[0], c[1]);
    p.closePath();
  }
  if (p2d.size > 4000) p2d.clear();
  p2d.set(k, p);
  return p;
}

/** Advance width (px) of a string with axes (no kerning, as the outlines are drawn). */
export function measureAxes(f: OTFont, s: string, size: number, axes: Record<string, number>): number {
  let w = 0;
  for (const ch of s) w += f.advance(f.glyphId(ch), f.axes.length ? axes : undefined);
  return (w * size) / f.unitsPerEm;
}

export interface GlyphOutline { ch: string; contours: number[][] }
/** Outlines of placed glyphs (layer pixels), drawn as MotionRenderer.text draws them: about the centre (px, py) of
 *  the glyph's box, turned by a degrees, the glyph's origin at (−w/2, −pivotY). */
export function placedOutlines(f: OTFont, glyphs: { ch: string; px: number; py: number; a: number; w: number }[], size: number, pivotY: number, axes: Record<string, number>): GlyphOutline[] {
  const k = size / f.unitsPerEm;
  return glyphs.map((g) => {
    const cmds = f.path(f.glyphId(g.ch), f.axes.length ? axes : undefined);
    const a = (g.a * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const lx = -g.w / 2, ly = -pivotY;
    return { ch: g.ch, contours: pathToContours(cmds, k, g.px + lx * c - ly * s, g.py + lx * s + ly * c, a) };
  });
}
