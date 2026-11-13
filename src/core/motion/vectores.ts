// «vectores»: After Effects' Create Shapes from Text / Create Masks from Text (Layer > Create), Auto-trace (Layer >
// Auto-trace…) and variable-font axes of text layers. The outlines come from the renderer (the font file's glyphs
// where the canvas draws them, or the traced pixels); these operations turn them into layers, shapes and masks.
import type { Editor } from '../ops';
import type { Project } from '../model';
import { P, findComp, findLayer, newLayer, newMask, newShape, type Comp, type Key, type Layer, type Mask, type Prop } from './model';
import type { TraceOptions, TracedPath } from './autotrace';

const compsOf = (p: Project) => (p.comps ??= []);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Outlines of a text layer as the renderer computed them (layer pixels, flat closed beziers). */
export interface TextOutlines { glyphs: { ch: string; contours: number[][] }[]; fill: string; stroke: string; strokeWidth: number }

/** Signed area of a flat bezier's vertices (enough to tell outer outlines from counters). */
function area(flat: number[]): number {
  let a = 0;
  const n = flat.length / 6;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += flat[i * 6] * flat[j * 6 + 1] - flat[j * 6] * flat[i * 6 + 1]; }
  return a / 2;
}
const shift = (flat: number[], dx: number, dy: number) => flat.map((v, i) => (i % 6 === 0 ? v + dx : i % 6 === 1 ? v + dy : v));
const addToProp = (p: Prop, d: number[]) => {
  const plus = (v: unknown) => (Array.isArray(v) ? v.map((x, i) => (typeof x === 'number' && i < d.length ? x + d[i] : x)) : v);
  p.v = plus(p.v) as never;
  for (const k of p.k ?? []) k.v = plus(k.v) as never;
};

/** A new layer that takes the place of `src` exactly: same timing, parent, 3D and transform (keyframes included). */
function twin(c: Comp, src: Layer, type: 'shape' | 'solid', name: string): Layer {
  const l = newLayer(type, c, { name, w: c.width, h: c.height });
  l.transform = clone(src.transform);
  for (const k of ['start', 'in', 'out', 'stretch', 'parent', 'threeD', 'motionBlur', 'blend', 'shy', 'locked', 'label'] as const) if (src[k] !== undefined) (l as unknown as Record<string, unknown>)[k] = clone(src[k]);
  l.locked = false;
  return l;
}
/** Origin-at-zero layers (text, shape, null…) have no size: a solid that replaces them is comp-sized, its anchor
 *  moved by half the size so its layer pixels are the source's plus that half. */
const zeroOrigin = (l: Layer) => l.type === 'text' || l.type === 'shape' || l.type === 'null';

export const VECTOR_OPS = {
  /** Crear formas a partir del texto: a shape layer «<name> contornos» with one group per character (named after it,
   *  its outlines filled and stroked like the text) above the text layer, whose video switch goes off. */
  textToShapes(e: Editor, compId: string, layerId: string, o: TextOutlines): Layer {
    return e.mutate('Crear formas a partir del texto', (p) => {
      const c = findComp(compsOf(p), compId);
      const t = findLayer(c, layerId);
      if (t.type !== 'text') throw new Error(`«${t.name}» no es una capa de texto.`);
      const glyphs = o.glyphs.filter((g) => g.contours.length);
      if (!glyphs.length) throw new Error('No se han podido crear contornos. Contenido vacío o no admitido.');
      const l = twin(c, t, 'shape', `${t.name} contornos`);
      l.shapes = glyphs.map((g) => {
        const s = newShape('path', { name: g.ch, path: g.contours[0], closed: true, color: o.fill, stroke: o.strokeWidth > 0 ? o.stroke : undefined, strokeWidth: o.strokeWidth });
        s.fill.on = true;
        s.fill.color.v = o.fill;
        s.fill.rule = 'nonzero';
        s.stroke.join = 'round'; s.stroke.cap = 'butt';
        if (g.contours.length > 1) s.contours = g.contours.slice(1);
        return s;
      });
      c.layers.splice(c.layers.indexOf(t), 0, l);
      t.hidden = true;
      return l;
    });
  },
  /** Crear máscaras a partir del texto: a solid «<name> contornos» (the text's colour) with one mask per outline of
   *  every character (counters subtract), above the text layer, whose video switch goes off. */
  textToMasks(e: Editor, compId: string, layerId: string, o: TextOutlines): Layer {
    return e.mutate('Crear máscaras a partir del texto', (p) => {
      const c = findComp(compsOf(p), compId);
      const t = findLayer(c, layerId);
      if (t.type !== 'text') throw new Error(`«${t.name}» no es una capa de texto.`);
      const glyphs = o.glyphs.filter((g) => g.contours.length);
      if (!glyphs.length) throw new Error('No se han podido crear contornos. Contenido vacío o no admitido.');
      const l = twin(c, t, 'solid', `${t.name} contornos`);
      l.solid = { color: /^#[0-9a-f]{6}/i.test(o.fill) ? o.fill.slice(0, 7) : '#ffffff', width: c.width, height: c.height };
      const dx = c.width / 2, dy = c.height / 2;
      addToProp(l.transform.anchor, [dx, dy]);
      for (const g of glyphs) {
        // the biggest outline sets which way "outer" turns; the opposite way is a counter
        const sign = Math.sign(g.contours.reduce((m, ct) => (Math.abs(area(ct)) > Math.abs(m) ? area(ct) : m), 0)) || 1;
        g.contours.forEach((ct, k) => {
          const m = newMask(shift(ct, dx, dy), k ? `${g.ch} ${k + 1}` : g.ch);
          if (Math.sign(area(ct)) !== sign) m.mode = 'subtract';
          l.masks.push(m);
        });
      }
      // counters after the outlines they cut (each character's own order is kept)
      l.masks = l.masks.filter((m) => m.mode === 'add').concat(l.masks.filter((m) => m.mode !== 'add'));
      c.layers.splice(c.layers.indexOf(t), 0, l);
      t.hidden = true;
      return l;
    });
  },
  /** Trazado automático: masks from traced outlines (one result per frame; several frames key the paths). Paths are
   *  in the layer's pixels. newLayer: on a new solid «Trazado automático <name>» that takes the layer's place. */
  autoTraceApply(e: Editor, compId: string, layerId: string, frames: { t: number; paths: TracedPath[] }[], o: { newLayer?: boolean } & Partial<TraceOptions> = {}): { layer: string; masks: string[] } {
    return e.mutate('Trazado automático', (p) => {
      const c = findComp(compsOf(p), compId);
      const src = findLayer(c, layerId);
      if (!frames.length || !frames.some((f) => f.paths.length)) throw new Error('El trazado automático no encontró contornos: pruebe otro canal o umbral.');
      let l = src, dx = 0, dy = 0;
      if (o.newLayer) {
        l = twin(c, src, 'solid', `Trazado automático ${src.name}`);
        const w = src.solid?.width ?? c.width, h = src.solid?.height ?? c.height;
        l.solid = { color: '#ffffff', width: zeroOrigin(src) ? c.width : w, height: zeroOrigin(src) ? c.height : h };
        if (zeroOrigin(src)) { dx = c.width / 2; dy = c.height / 2; addToProp(l.transform.anchor, [dx, dy]); }
        c.layers.splice(c.layers.indexOf(src), 0, l);
      }
      // slots: (depth, rank by area within that depth) so a frame's outlines go to the same masks
      const slots = new Map<string, Mask>();
      const order: string[] = [];
      const base = l.masks.length;
      for (const f of frames) {
        const rank = new Map<number, number>();
        for (const tp of f.paths) {
          const r = rank.get(tp.depth) ?? 0; rank.set(tp.depth, r + 1);
          const k = `${tp.depth}|${r}`;
          if (!slots.has(k)) { const m = newMask([], `Máscara ${base + slots.size + 1}`); m.mode = tp.hole ? 'subtract' : 'add'; slots.set(k, m); order.push(k); }
        }
      }
      const ordered = [...order].sort((a, b) => Number(a.split('|')[0]) - Number(b.split('|')[0]) || Number(a.split('|')[1]) - Number(b.split('|')[1]));
      ordered.forEach((k, i) => { slots.get(k)!.name = `Máscara ${base + i + 1}`; });
      for (const k of ordered) {
        const m = slots.get(k)!;
        const at = (f: { paths: TracedPath[] }) => { const [d, r] = k.split('|').map(Number); return f.paths.filter((x) => x.depth === d)[r]; };
        if (frames.length === 1) m.path.v = shift(at(frames[0])?.path ?? [], dx, dy);
        else {
          m.path.k = frames.map((f): Key => ({ t: f.t, v: shift(at(f)?.path ?? [], dx, dy), i: 'hold' }));
          m.path.v = m.path.k[0].v as number[];
        }
        l.masks.push(m);
      }
      return { layer: l.id, masks: ordered.map((k) => slots.get(k)!.id) };
    });
  },
  /** Variable font axes of a text layer: tag → value (null removes the axis, back to the font's default). */
  textAxesSet(e: Editor, compId: string, layerId: string, axes: Record<string, number | null>): Record<string, number> {
    return e.mutate('Ejes de fuente variable', (p) => {
      const l = findLayer(findComp(compsOf(p), compId), layerId);
      if (!l.text) throw new Error(`«${l.name}» no es una capa de texto.`);
      const cur = (l.text.axes ??= {});
      for (const [tag, v] of Object.entries(axes)) {
        if (!/^[\x20-\x7e]{4}$/.test(tag)) throw new Error(`«${tag}» no es una etiqueta de eje (4 caracteres: wght, wdth, slnt, opsz…).`);
        if (v === null) delete cur[tag];
        else if (cur[tag]) { if (cur[tag].k?.length) throw new Error(`El eje «${tag}» tiene fotogramas clave: cámbielo con prop_set text.axes.${tag}.`); cur[tag].v = v; }
        else cur[tag] = P(v);
      }
      if (!Object.keys(cur).length) delete l.text.axes;
      return Object.fromEntries(Object.entries(l.text.axes ?? {}).map(([k, v]) => [k, v.v]));
    });
  },
};

/** Spanish names of the registered axes (After Effects / Illustrator use these in the Character panel). */
export const AXIS_NAMES: Record<string, string> = { wght: 'Grosor', wdth: 'Anchura', slnt: 'Inclinación', ital: 'Cursiva', opsz: 'Tamaño óptico' };
