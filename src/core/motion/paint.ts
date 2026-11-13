// Paint tools of the advanced mode (After Effects' Brush, Clone Stamp and Eraser). Like After Effects, painting
// adds one «Pintura» effect to the layer that holds the strokes: each stroke is its own item with Stroke Options
// and a Transform, all animatable, and its path in layer pixels. Names follow After Effects' Spanish UI.
// Pure TypeScript: the maths here (dab spacing, hardness falloff, write-on timing) is shared by the renderer,
// the operations and the unit tests.
import { uid } from '../model';
import { P, findComp, findLayer, BLEND_MODES, type BlendMode, type Comp, type FxInstance, type Layer, type Prop, type PVal } from './model';
import { newFx } from './effects';
import type { Editor } from '../ops';
import type { Project } from '../model';

export type PaintTool = 'brush' | 'clone' | 'eraser';
/** Canales: RGBA | RGB | Alfa */
export type PaintChannels = 'rgba' | 'rgb' | 'alpha';
/** Duración: Constante | Simulación de escritura | Un fotograma | Personalizar */
export type PaintDuration = 'constant' | 'writeOn' | 'single' | 'custom';
/** Borrar: Origen de capa y pintar | Sólo pintar | Sólo último trazo */
export type EraseMode = 'all' | 'paint' | 'last';

export interface PaintStroke {
  id: string;
  name: string;
  kind: PaintTool;
  /** Modo de fusión of the stroke (brush and clone) */
  mode: BlendMode;
  /** eraser: what it erases; 'last' erases only the stroke `target` */
  erase?: EraseMode;
  target?: string;
  /** visible span in layer time (s from the layer's start), like the stroke's duration bar in After Effects */
  in: number;
  out: number;
  /** Trazado: points [x, y, x, y…] in layer pixels, in drawing order */
  path: Prop<number[]>;
  start: Prop<number>;
  end: Prop<number>;
  color: Prop<string>;
  diameter: Prop<number>;
  angle: Prop<number>;
  hardness: Prop<number>;
  roundness: Prop<number>;
  spacing: Prop<number>;
  /** 'rgba' | 'rgb' | 'alpha' */
  channels: Prop<string>;
  opacity: Prop<number>;
  flow: Prop<number>;
  transform: { anchor: Prop<number[]>; position: Prop<number[]>; scale: Prop<number[]>; rotation: Prop<number> };
  /** clone strokes: Clonar origen (layer id, '' = this layer), Clonar posición (the source point under the stroke's
   *  first point), Clonar cambio de tiempo (s) or, with Bloquear tiempo de origen, Clonar tiempo (source comp time) */
  clone?: { source: string; position: Prop<number[]>; timeShift: Prop<number>; lock: boolean; time: Prop<number> };
}

export const PAINT_FX = 'paint';
export const STROKE_NAMES: Record<PaintTool, string> = { brush: 'Pincelar', clone: 'Clonar', eraser: 'Borrador' };
export const TOOL_NAMES: Record<PaintTool, string> = { brush: 'Herramienta Pincel', clone: 'Herramienta tampón de clonar', eraser: 'Herramienta borrador' };
export const PAINT_CHANNELS: { id: PaintChannels; name: string }[] = [{ id: 'rgba', name: 'RGBA' }, { id: 'rgb', name: 'RGB' }, { id: 'alpha', name: 'Alfa' }];
export const PAINT_DURATIONS: { id: PaintDuration; name: string }[] = [{ id: 'constant', name: 'Constante' }, { id: 'writeOn', name: 'Simulación de escritura' }, { id: 'single', name: 'Un fotograma' }, { id: 'custom', name: 'Personalizar' }];
export const ERASE_MODES: { id: EraseMode; name: string }[] = [{ id: 'all', name: 'Origen de capa y pintar' }, { id: 'paint', name: 'Sólo pintar' }, { id: 'last', name: 'Sólo último trazo' }];
/** blend modes a stroke can use (Cinta's layer modes, named like After Effects') */
export const PAINT_MODES = BLEND_MODES;

/** A brush tip of the Brushes panel. */
export interface BrushTip { name: string; diameter: number; angle: number; roundness: number; hardness: number; spacing: number }
const tip = (d: number, hard: boolean): BrushTip => ({ name: `${hard ? 'Circular definido' : 'Circular difuso'} ${d} píxeles`, diameter: d, angle: 0, roundness: 100, hardness: hard ? 100 : 0, spacing: 25 });
/** Default brush tips (After Effects' Reset Brush Tips: hard and soft round tips, spacing 25 %) */
export const BRUSH_TIPS: BrushTip[] = [
  ...[1, 3, 5, 9, 13, 19].map((d) => tip(d, true)),
  ...[5, 9, 13, 17, 21, 27, 35, 45, 65, 100, 200, 300].map((d) => tip(d, false)),
];

/** Paint and Brushes panels: the settings new strokes take. */
export interface PaintOptions {
  fg: string;
  bg: string;
  opacity: number;
  flow: number;
  mode: BlendMode;
  channels: PaintChannels;
  duration: PaintDuration;
  /** Personalizar: length of the stroke in frames */
  frames: number;
  erase: EraseMode;
  brush: { diameter: number; angle: number; roundness: number; hardness: number; spacing: number };
  clone: { preset: number; source: string; aligned: boolean; lockTime: boolean; time: number; timeShift: number; offset: [number, number]; overlay: boolean; overlayOpacity: number; difference: boolean };
}
export function defaultPaintOptions(): PaintOptions {
  return {
    fg: '#000000', bg: '#ffffff', opacity: 100, flow: 100, mode: 'normal', channels: 'rgba', duration: 'constant', frames: 1, erase: 'all',
    brush: { diameter: 21, angle: 0, roundness: 100, hardness: 0, spacing: 25 },
    clone: { preset: 1, source: '', aligned: true, lockTime: false, time: 0, timeShift: 0, offset: [0, 0], overlay: false, overlayOpacity: 50, difference: false },
  };
}

// ───────────────────────── maths ─────────────────────────
/** Distance between two dabs (layer px): Spacing is a share of the diameter (After Effects: 1…1000 %). */
export function dabStep(diameter: number, spacing: number): number {
  return Math.max(0.25, (Math.max(0.1, diameter) * Math.max(1, spacing)) / 100);
}

/** Coverage of one dab at distance d from its centre (0…1). Hardness is the share of the radius that is fully
 *  painted; beyond it the edge falls off smoothly to 0 at the radius. */
export function dabAlpha(d: number, radius: number, hardness: number): number {
  if (radius <= 0) return 0;
  const r = d / radius;
  if (r >= 1) return 0;
  const inner = Math.max(0, Math.min(1, hardness / 100));
  if (r <= inner) return 1;
  const u = (r - inner) / (1 - inner);
  return 0.5 * (1 + Math.cos(Math.PI * u));
}

/** Length of a polyline [x, y, x, y…]. */
export function pathLength(pts: number[]): number {
  let L = 0;
  for (let i = 2; i + 1 < pts.length; i += 2) L += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return L;
}

/** Centres of the dabs along a polyline, one every `step` px, between start and end (0…100 % of its length).
 *  A single point (a click) is one dab. Returns [x, y, x, y…]. */
export function dabCenters(pts: number[], step: number, start = 0, end = 100): number[] {
  const n = Math.floor(pts.length / 2);
  if (!n) return [];
  const L = pathLength(pts);
  const a = Math.max(0, Math.min(1, start / 100)) * L, b = Math.max(0, Math.min(1, end / 100)) * L;
  if (n === 1 || L < 1e-9) return end > start || (end >= 100 && start <= 0) ? [pts[0], pts[1]] : [];
  if (b < a || (b === a && end <= start)) return [];
  const out: number[] = [];
  let seg = 0, segStart = 0;
  for (let s = a; s <= b + 1e-9; s += Math.max(1e-3, step)) {
    while (seg < n - 2 && segStart + Math.hypot(pts[seg * 2 + 2] - pts[seg * 2], pts[seg * 2 + 3] - pts[seg * 2 + 1]) < s) {
      segStart += Math.hypot(pts[seg * 2 + 2] - pts[seg * 2], pts[seg * 2 + 3] - pts[seg * 2 + 1]);
      seg++;
    }
    const x0 = pts[seg * 2], y0 = pts[seg * 2 + 1], x1 = pts[seg * 2 + 2], y1 = pts[seg * 2 + 3];
    const sl = Math.hypot(x1 - x0, y1 - y0) || 1, u = Math.max(0, Math.min(1, (s - segStart) / sl));
    out.push(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u);
  }
  return out;
}

/** The stroke's points after its own Transform (anchor, position, scale %, rotation °), in layer px. */
export function strokePoints(pts: number[], tr: { anchor: number[]; position: number[]; scale: number[]; rotation: number }): number[] {
  const [ax, ay] = tr.anchor, [px, py] = tr.position, sx = (tr.scale[0] ?? 100) / 100, sy = (tr.scale[1] ?? tr.scale[0] ?? 100) / 100;
  const r = (tr.rotation * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  if (ax === px && ay === py && sx === 1 && sy === 1 && !tr.rotation) return pts;
  const out = new Array<number>(pts.length);
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = (pts[i] - ax) * sx, y = (pts[i + 1] - ay) * sy;
    out[i] = px + x * c - y * s;
    out[i + 1] = py + x * s + y * c;
  }
  return out;
}

/** Visible span of a new stroke (layer time) and, for Write On, the keys of End: 0 % when the drawing started,
 *  100 % when it ended (After Effects records the drawing time). t0: layer time where the stroke is drawn. */
export function strokeTiming(duration: PaintDuration, t0: number, o: { layerEnd: number; fps: number; frames?: number; drawTime?: number }): { in: number; out: number; endKeys?: { t: number; v: number }[] } {
  const f = 1 / (o.fps || 30);
  if (duration === 'single') return { in: t0, out: t0 + f };
  if (duration === 'custom') return { in: t0, out: t0 + Math.max(1, Math.round(o.frames ?? 1)) * f };
  const out = Math.max(t0 + f, o.layerEnd);
  if (duration === 'writeOn') return { in: t0, out, endKeys: [{ t: t0, v: 0 }, { t: t0 + Math.max(f, o.drawTime ?? f), v: 100 }] };
  return { in: t0, out };
}

// ───────────────────────── model ─────────────────────────
export interface StrokeInput {
  kind: PaintTool;
  /** points [[x, y], …] or flat [x, y, …], layer px */
  points: number[][] | number[];
  color?: string;
  diameter?: number; angle?: number; roundness?: number; hardness?: number; spacing?: number;
  opacity?: number; flow?: number; mode?: BlendMode; channels?: PaintChannels;
  duration?: PaintDuration; frames?: number;
  /** comp time where the stroke is drawn (default 0) */
  at?: number;
  /** seconds the drawing took (Write On) */
  drawTime?: number;
  erase?: EraseMode;
  clone?: { source?: string; position?: number[]; offset?: number[]; timeShift?: number; lock?: boolean; time?: number };
  name?: string;
}
const flat = (p: number[][] | number[]): number[] => (Array.isArray(p[0]) ? (p as number[][]).flatMap((q) => [Number(q[0]) || 0, Number(q[1]) || 0]) : (p as number[]).map((v) => Number(v) || 0));

export function paintFx(l: Layer): FxInstance | undefined { return l.effects.find((f) => f.fx === PAINT_FX); }

/** Builds a stroke for a layer (timing relative to the layer's start). */
export function newStroke(c: Comp, l: Layer, fx: FxInstance, o: StrokeInput): PaintStroke {
  const pts = flat(o.points);
  if (pts.length < 2) throw new Error('Un trazo necesita al menos un punto [x, y].');
  const d = defaultPaintOptions();
  const at = o.at ?? 0, t0 = at - l.start;
  const tm = strokeTiming(o.duration ?? 'constant', t0, { layerEnd: l.out - l.start, fps: c.fps, frames: o.frames, drawTime: o.drawTime });
  const list = fx.strokes ?? [];
  const nm = STROKE_NAMES[o.kind];
  let k = 1; while (list.some((s) => s.name === `${nm} ${k}`)) k++;
  const first = [pts[0], pts[1]];
  const s: PaintStroke = {
    id: uid('st'), name: o.name ?? `${nm} ${k}`, kind: o.kind, mode: o.mode ?? 'normal',
    in: tm.in, out: tm.out,
    path: P(pts), start: P(0), end: P(100),
    color: P(o.color ?? d.fg), diameter: P(o.diameter ?? d.brush.diameter), angle: P(o.angle ?? 0), hardness: P(o.hardness ?? d.brush.hardness),
    roundness: P(o.roundness ?? 100), spacing: P(o.spacing ?? 25), channels: P(o.channels ?? 'rgba'), opacity: P(o.opacity ?? 100), flow: P(o.flow ?? 100),
    transform: { anchor: P([...first]), position: P([...first]), scale: P([100, 100]), rotation: P(0) },
  };
  if (tm.endKeys) s.end.k = tm.endKeys.map((x) => ({ t: x.t + l.start, v: x.v }));
  if (o.kind === 'eraser') {
    s.erase = o.erase ?? 'all';
    if (s.erase === 'last') {
      const prev = [...list].reverse().find((x) => x.kind !== 'eraser');
      if (!prev) throw new Error('«Sólo último trazo» necesita un trazo de pincel o de clonación antes.');
      s.target = prev.id;
    }
  }
  if (o.kind === 'clone') {
    const cl = o.clone ?? {};
    const src = cl.source ? findLayer(c, /^\d+$/.test(cl.source) ? Number(cl.source) : cl.source).id : '';
    if (src && src !== l.id && c.layers.findIndex((x) => x.id === src) < 0) throw new Error(`No existe la capa «${cl.source}».`);
    const pos = cl.position ?? (cl.offset ? [first[0] + (cl.offset[0] ?? 0), first[1] + (cl.offset[1] ?? 0)] : [...first]);
    s.clone = { source: src === l.id ? '' : src, position: P([pos[0], pos[1]]), timeShift: P(cl.timeShift ?? 0), lock: !!cl.lock, time: P(cl.time ?? at) };
  }
  return s;
}

/** Walks every animatable property of a paint effect's strokes. */
export function forEachStrokeProp(fx: FxInstance, fn: (p: Prop, path: string) => void) {
  for (const s of fx.strokes ?? []) {
    const b = `effects.${fx.id}.strokes.${s.id}`;
    for (const k of STROKE_PROPS) fn(s[k] as Prop, `${b}.${k}`);
    for (const k of ['anchor', 'position', 'scale', 'rotation'] as const) fn(s.transform[k] as Prop, `${b}.transform.${k}`);
    if (s.clone) { fn(s.clone.position, `${b}.clone.position`); fn(s.clone.timeShift, `${b}.clone.timeShift`); fn(s.clone.time, `${b}.clone.time`); }
  }
}
export const STROKE_PROPS = ['path', 'start', 'end', 'color', 'diameter', 'angle', 'hardness', 'roundness', 'spacing', 'channels', 'opacity', 'flow'] as const;
/** Spanish names of the stroke properties (After Effects' timeline) */
export const STROKE_PROP_NAMES: Record<string, string> = {
  path: 'Trazado', start: 'Inicio', end: 'Fin', color: 'Color', diameter: 'Diámetro', angle: 'Ángulo', hardness: 'Dureza', roundness: 'Redondez',
  spacing: 'Espaciado', channels: 'Canales', opacity: 'Opacidad', flow: 'Flujo', anchor: 'Punto de anclaje', position: 'Posición', scale: 'Escala', rotation: 'Rotación',
  'clone.source': 'Clonar origen', 'clone.position': 'Clonar posición', 'clone.timeShift': 'Clonar cambio de tiempo', 'clone.time': 'Clonar tiempo',
};

/** A stroke of a paint effect, by id, name or 1-based index (in drawing order). */
export function pickStroke(fx: FxInstance, key: string): PaintStroke {
  const list = fx.strokes ?? [];
  const s = (/^\d+$/.test(key) ? list[Number(key) - 1] : undefined) ?? list.find((x) => x.id === key || x.name === key || x.name.toLowerCase() === key.toLowerCase());
  if (!s) throw new Error(`No existe el trazo «${key}». Hay: ${list.map((x) => x.name).join(', ') || 'ninguno'}.`);
  return s;
}
/** Resolves effects.<fx>.strokes.<stroke>.<prop…> below a paint effect (parts from 'strokes' on). */
export function strokeProp(fx: FxInstance, parts: string[]): Prop {
  const s = pickStroke(fx, parts[1] ?? '');
  let o: unknown = s;
  for (const p of parts.slice(2)) o = (o as Record<string, unknown> | undefined)?.[p];
  if (!o || typeof o !== 'object' || !('v' in (o as object))) throw new Error(`El trazo «${s.name}» no tiene «${parts.slice(2).join('.')}». Tiene: ${[...STROKE_PROPS, 'transform.anchor', 'transform.position', 'transform.scale', 'transform.rotation', ...(s.clone ? ['clone.position', 'clone.timeShift', 'clone.time'] : [])].join(', ')}.`);
  return o as Prop;
}

/** Compact description of a stroke for the MCP. */
export function strokeSummary(l: Layer, s: PaintStroke, i: number) {
  const v = (p: Prop) => (p.k?.length ? { keys: p.k.map((k) => ({ t: k.t, v: k.v })) } : p.v);
  const pts = s.path.v;
  return {
    index: i + 1, id: s.id, name: s.name, kind: s.kind, mode: s.mode, in: s.in + l.start, out: s.out + l.start,
    points: pts.length / 2, bounds: pts.length ? [Math.min(...pts.filter((_, j) => j % 2 === 0)), Math.min(...pts.filter((_, j) => j % 2 === 1)), Math.max(...pts.filter((_, j) => j % 2 === 0)), Math.max(...pts.filter((_, j) => j % 2 === 1))] : [],
    start: v(s.start), end: v(s.end), color: v(s.color), diameter: v(s.diameter), angle: v(s.angle), hardness: v(s.hardness), roundness: v(s.roundness), spacing: v(s.spacing),
    channels: v(s.channels), opacity: v(s.opacity), flow: v(s.flow),
    ...(s.erase ? { erase: s.erase } : {}), ...(s.target ? { target: s.target } : {}),
    ...(s.clone ? { clone: { source: s.clone.source || '(capa actual)', position: v(s.clone.position), timeShift: v(s.clone.timeShift), lock: s.clone.lock, time: v(s.clone.time) } } : {}),
  };
}

// ───────────────────────── operations (one undo step each) ─────────────────────────
const compsOf = (p: Project) => (p.comps ??= []);
function paintable(l: Layer) {
  if (l.type === 'camera' || l.type === 'light' || l.type === 'null' || l.type === 'audio' || l.type === 'adjustment') throw new Error(`«${l.name}» no se dibuja: no se puede pintar en ella.`);
}
/** The layer's paint effect, added (After Effects adds «Pintura» on the first stroke) when missing. */
function ensurePaint(l: Layer): FxInstance {
  let fx = paintFx(l);
  if (!fx) { fx = newFx(PAINT_FX, 1, 1); fx.strokes = []; l.effects.push(fx); }
  fx.strokes ??= [];
  return fx;
}

export const PAINT_OPS = {
  /** Paints a stroke on a layer (layer pixels): brush, clone stamp or eraser. */
  paintStroke(e: Editor, compId: string, layerId: string, o: StrokeInput): { effect: string; stroke: { id: string; name: string } } {
    return e.mutate(o.kind === 'eraser' ? 'Borrar' : o.kind === 'clone' ? 'Clonar' : 'Pintar', (p) => {
      const c = findComp(compsOf(p), compId);
      const l = findLayer(c, layerId);
      paintable(l);
      const fx = ensurePaint(l);
      const s = newStroke(c, l, fx, o);
      fx.strokes!.push(s);
      return { effect: fx.id, stroke: { id: s.id, name: s.name } };
    });
  },
  /** Changes a stroke: name, blend mode, erase mode, timing (comp time), order (1 = drawn first) or static values. */
  paintEdit(e: Editor, compId: string, layerId: string, strokeId: string, o: { name?: string; mode?: BlendMode; erase?: EraseMode; in?: number; out?: number; index?: number; values?: Record<string, PVal>; cloneSource?: string; cloneLock?: boolean; delete?: boolean }): void {
    e.mutate(o.delete ? 'Eliminar trazo' : 'Cambiar trazo', (p) => {
      const c = findComp(compsOf(p), compId);
      const l = findLayer(c, layerId);
      const fx = paintFx(l);
      if (!fx?.strokes?.length) throw new Error(`«${l.name}» no tiene trazos de pintura.`);
      const s = pickStroke(fx, strokeId);
      if (o.delete) {
        fx.strokes = fx.strokes.filter((x) => x !== s);
        // erasers of only that stroke go with it
        fx.strokes = fx.strokes.filter((x) => x.target !== s.id);
        return;
      }
      if (o.name) s.name = o.name;
      if (o.mode) { if (!BLEND_MODES.some((m) => m.id === o.mode)) throw new Error(`Modo desconocido «${o.mode}».`); s.mode = o.mode; }
      if (o.erase && s.kind === 'eraser') s.erase = o.erase;
      if (o.in !== undefined) s.in = o.in - l.start;
      if (o.out !== undefined) s.out = o.out - l.start;
      if (s.out <= s.in) throw new Error('El final del trazo debe ir después de su inicio.');
      if (o.cloneSource !== undefined && s.clone) s.clone.source = o.cloneSource ? findLayer(c, /^\d+$/.test(o.cloneSource) ? Number(o.cloneSource) : o.cloneSource).id : '';
      if (o.cloneLock !== undefined && s.clone) s.clone.lock = o.cloneLock;
      for (const [k, v] of Object.entries(o.values ?? {})) {
        const prop = strokeProp(fx, ['strokes', s.id, ...k.split('.')]);
        if (prop.k?.length) throw new Error(`«${k}» tiene fotogramas clave: use prop_set con t (path effects.${fx.id}.strokes.${s.id}.${k}).`);
        prop.v = Array.isArray(prop.v) ? (Array.isArray(v) ? (v as number[]) : prop.v) : typeof prop.v === 'number' ? Number(v) : String(v);
      }
      if (o.index) { fx.strokes.splice(fx.strokes.indexOf(s), 1); fx.strokes.splice(Math.max(0, Math.min(fx.strokes.length, o.index - 1)), 0, s); }
    });
  },
};
