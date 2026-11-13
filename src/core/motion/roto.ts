// Roto Brush & Refine Edge (After Effects' «Pincel rotoscopia y Perf. borde», match name «ADBE Samurai»): strokes
// painted on the layer's footage with the Roto Brush tool (foreground green, Alt = background red) and the Refine
// Edge tool (Alt = erase refinement) mark what is the subject on a few frames; the segmentation is propagated
// forwards and backwards from the base frame through the span (src/core/roto-analyze.ts, src/core/segment.ts) and the
// result — one matte per frame — is kept in the effect, like AE's cache; the Roto Brush Matte and Refine Edge Matte
// groups are applied when the layer is drawn (src/motion-render/roto.ts), so they can change without propagating.
//
// Parameter names are those of AE 2024's Spanish interface; defaults follow Adobe's documentation of the effect (Search Radius 50, Motion
// Threshold 10 %, Motion Damping 20 %, Edge Detection Balanced; the matte groups neutral; Render Refine Edge on;
// decontamination on, 100 %).
import type { Editor } from '../ops';
import type { Project } from '../model';
import type { FxDef } from './effects';
import { newFx } from './effects';
import { n, pc, bo, ch } from './fxparams';
import { findComp, findLayer, type Comp, type FxInstance, type Layer } from './model';

export const ROTO_FX = 'rotoBrush';
export const ROTO_QUALITY: [string, string][] = [['standard', 'Estándar'], ['best', 'Mejor']];
export const ROTO_EDGE: [string, string][] = [['predicted', 'Priorizar bordes previstos'], ['balanced', 'Equilibrado'], ['current', 'Priorizar bordes actuales']];
export const ROTO_CHATTER: [string, string][] = [['off', 'Desactivado'], ['detailed', 'Más detallado'], ['smoother', 'Más suave (más lento)']];

const PR = 'Propagación', RB = 'Mate de pincel tipo rotoscopia', RE = 'Perfeccionar mate de borde';
export const FX_ROTO: FxDef[] = [
  // still: on a layer without strokes (or not footage) the effect leaves it as it is
  { id: ROTO_FX, name: 'Pincel rotoscopia y Perf. borde', cat: 'Mate', still: true, params: [
    ch('version', 'Versión', [['2', '2.0'], ['1', '1.0 (Cásica)']], '2'), ch('quality', 'Calidad', ROTO_QUALITY, 'standard'),
    n('searchRadius', `${PR}: Radio de búsqueda`, 50, 0, 400), pc('motionThreshold', `${PR}: Umbral de movimiento`, 10), pc('motionDamping', `${PR}: Atenuación de movimiento`, 20),
    bo('viewSearch', `${PR}: Ver región de búsqueda`), ch('edgeDetection', `${PR}: Detección de bordes`, ROTO_EDGE, 'balanced'), bo('altColor', `${PR}: Cálculo de color alternativo`),
    bo('invert', 'Invertir primer plano/fondo'),
    bo('rbFineTune', 'Ajustar Mate pincel rotoscopia'),
    pc('rbFeather', `${RB}: Calado`, 0), pc('rbContrast', `${RB}: Contraste`, 0), pc('rbShift', `${RB}: Desplazamiento de borde`, 0, -100, 100), pc('rbChatter', `${RB}: Reducir inestabilidad`, 0),
    bo('renderRefine', 'Procesar perfec. de borde', true), n('baseRadius', 'Radio de borde de perfec. base', 0, 0, 100),
    bo('reFineTune', 'Ajustar Perfec. mate de borde'),
    n('reSmooth', `${RE}: Suave`, 0, 0, 100), pc('reFeather', `${RE}: Calado`, 0), pc('reContrast', `${RE}: Contraste`, 0), pc('reShift', `${RE}: Desplazamiento de borde`, 0, -100, 100),
    ch('reChatterMode', `${RE}: Reducción de la inestabilidad`, ROTO_CHATTER, 'detailed'), pc('reChatter', `${RE}: Reducir inestabilidad`, 0),
    bo('reDecontaminate', `${RE}: Depurar colores de bordes`, true), pc('reDeconAmount', `${RE}: Depuración: cantidad`, 100), bo('reDeconExtend', `${RE}: Depuración: ampliar en zona de suavizado`, true),
    n('reDeconRadius', `${RE}: Depuración: aumentar radio`, 0, 0, 100), bo('reDeconView', `${RE}: Depuración: ver mapa`),
  ] },
];
/** parameters the propagation depends on (a change asks for a new propagation) */
export const ROTO_PROPAGATION_PARAMS = ['quality', 'searchRadius', 'motionThreshold', 'motionDamping', 'edgeDetection', 'altColor'];

// ───────────────────────── data ─────────────────────────
export type RotoKind = 'fg' | 'bg' | 'refine' | 'unrefine';
export const ROTO_KIND_NAMES: Record<RotoKind, string> = { fg: 'Primer plano', bg: 'Fondo', refine: 'Perfeccionamiento de borde', unrefine: 'Borrar perfeccionamiento de borde' };
export interface RotoStroke {
  id: string;
  name: string;
  kind: RotoKind;
  /** source time (s) of the frame it was painted on */
  s: number;
  /** brush diameter, layer px */
  d: number;
  /** points in layer px, flat x, y … */
  pts: number[];
}
export interface RotoSeg {
  /** what was propagated (see rotoKey): a different key means the result is stale */
  key: string;
  /** size of the mattes (working resolution) and layer size they cover */
  w: number; h: number; W: number; H: number;
  /** source time of frame 0, frames per second, frames */
  t0: number; fps: number; n: number;
  /** per frame: the matte (RLE, see rleEncode) or null outside what was propagated */
  m: (string | null)[];
  /** per frame: the Refine Edge region painted / propagated (RLE) or null */
  r: (string | null)[];
  /** base frame (index) */
  base: number;
}
export interface RotoData {
  strokes: RotoStroke[];
  /** Roto Brush span in source seconds (default: the layer's in…out) */
  span?: [number, number];
  /** frozen (ISO date): the propagation is locked («Guardar en caché y bloquear la propagación») */
  frozen?: string;
  seg?: RotoSeg;
}

// ───────────────────────── RLE of binary mattes ─────────────────────────
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64(bytes: number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0, k = (a << 16) | (b << 8) | c;
    s += B64[(k >> 18) & 63] + B64[(k >> 12) & 63] + (i + 1 < bytes.length ? B64[(k >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[k & 63] : '=');
  }
  return s;
}
function unb64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, ''), out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const k = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1] ?? 'A') << 12) | ((i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0) << 6) | (i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0);
    if (o < out.length) out[o++] = (k >> 16) & 255;
    if (o < out.length) out[o++] = (k >> 8) & 255;
    if (o < out.length) out[o++] = k & 255;
  }
  return out;
}
/** Binary matte (any value ≥ 0.5 / non-zero is in) → runs alternating out / in, as varints in base64. */
export function rleEncode(m: ArrayLike<number>): string {
  const bytes: number[] = [];
  const put = (v: number) => { while (v >= 128) { bytes.push((v & 127) | 128); v = Math.floor(v / 128); } bytes.push(v); };
  let cur = 0, run = 0;
  for (let i = 0; i < m.length; i++) {
    const v = m[i] >= 0.5 ? 1 : 0;
    if (v === cur) run++;
    else { put(run); cur = v; run = 1; }
  }
  put(run);
  return b64(bytes);
}
export function rleDecode(s: string, size: number): Uint8Array {
  const bytes = unb64(s), out = new Uint8Array(size);
  let i = 0, p = 0, cur = 0;
  while (i < bytes.length && p < size) {
    let v = 0, mul = 1;
    for (;;) { const b = bytes[i++]; v += (b & 127) * mul; if (b < 128 || i >= bytes.length) break; mul *= 128; }
    if (cur) out.fill(1, p, Math.min(size, p + v));
    p += v; cur ^= 1;
  }
  return out;
}

// ───────────────────────── spans and keys ─────────────────────────
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
export const rotoFx = (l: Layer): FxInstance | undefined => l.effects.find((f) => f.fx === ROTO_FX);
const pv = (f: FxInstance, k: string) => f.params[k]?.v;

/** The footage a Roto Brush works on: the layer's video (or still) over its span, at the footage's rate (≤ 60 fps). */
export function rotoSpan(l: Layer, m: { path: string; kind?: string; fps?: number; width?: number; height?: number }, compFps: number, d?: RotoData) {
  const still = m.kind === 'image';
  const stretch = l.stretch || 1, fps = still ? compFps : Math.min(60, m.fps || compFps);
  const lin = Math.max(0, (l.in - l.start) / stretch), lout = Math.max(lin, (l.out - l.start) / stretch);
  const [a, b] = d?.span ?? [lin, lout];
  const srcIn = Math.max(0, Math.min(a, b)), srcOut = Math.max(srcIn, Math.max(a, b));
  const count = still ? 1 : Math.max(1, Math.min(3600, Math.round((srcOut - srcIn) * fps)));
  return { srcIn: still ? 0 : srcIn, srcOut, fps, count, still };
}
/** What a propagation is valid for: the footage, span, strokes and the Propagation parameters. */
export function rotoKey(f: FxInstance, path: string, span: { srcIn: number; count: number; fps: number }): string {
  const d = f.roto;
  const params = ROTO_PROPAGATION_PARAMS.map((k) => String(pv(f, k)));
  return hash(JSON.stringify([path, span.srcIn.toFixed(3), span.count, span.fps.toFixed(3), params, (d?.strokes ?? []).map((s) => [s.kind, s.s.toFixed(3), s.d, s.pts.map((v) => Math.round(v * 10))])]));
}
/** Index of the matte for a source time (-1 outside the propagated frames). */
export function rotoFrame(seg: RotoSeg, srcTime: number): number {
  if (seg.n === 1) return 0;
  const i = Math.round((srcTime - seg.t0) * seg.fps);
  return i >= 0 && i < seg.n ? i : -1;
}
export function rotoStatus(f: FxInstance, key: string | null): 'none' | 'stale' | 'ok' | 'frozen' {
  const d = f.roto;
  if (!d?.strokes.length) return 'none';
  if (d.frozen) return 'frozen';
  return d.seg && d.seg.key === key ? 'ok' : 'stale';
}

// ───────────────────────── operations (one undo step each) ─────────────────────────
const compsOf = (p: Project) => ((p as { comps?: Comp[] }).comps ??= []);
export function rotoLayerCheck(l: Layer) {
  if (l.type !== 'video' && l.type !== 'image') throw new Error(`«${l.name}» no es una capa de metraje: el Pincel tipo rotoscopia trabaja sobre el vídeo o la imagen de la capa.`);
  if ((l.stretch || 1) < 0) throw new Error('Los trazos del pincel tipo rotoscopia y de perfección de bordes no se pueden agregar a una capa de inversión temporal.');
  if (l.timeRemap) throw new Error('El Pincel tipo rotoscopia no admite capas con reasignación de tiempo.');
}
/** The layer's Roto Brush & Refine Edge effect, added first in the stack (AE applies it from the tool) when missing. */
export function ensureRoto(l: Layer): FxInstance {
  let f = rotoFx(l);
  if (!f) { f = newFx(ROTO_FX, 1, 1); l.effects.unshift(f); }
  f.roto ??= { strokes: [] };
  return f;
}
export interface RotoStrokeInput { kind: RotoKind; /** comp time of the frame */ t: number; points: number[][]; diameter?: number }

export const ROTO_OPS = {
  /** Paints a Roto Brush (fg / bg) or Refine Edge (refine / unrefine) stroke, in layer px, on the frame at comp time t. */
  rotoStroke(e: Editor, compId: string, layerId: string, o: RotoStrokeInput): { effect: string; stroke: { id: string; name: string } } {
    const label = o.kind === 'fg' ? 'Pincel tipo rotoscopia en primer plano' : o.kind === 'bg' ? 'Pincel tipo rotoscopia en fondo' : ROTO_KIND_NAMES[o.kind];
    return e.mutate(label, (p) => {
      const c = findComp(compsOf(p), compId), l = findLayer(c, layerId);
      rotoLayerCheck(l);
      if (!ROTO_KIND_NAMES[o.kind]) throw new Error(`Tipo de trazo desconocido «${o.kind}» (fg, bg, refine, unrefine).`);
      if (!o.points?.length) throw new Error('El trazo no tiene puntos.');
      const f = ensureRoto(l), d = f.roto!;
      if (d.frozen) throw new Error('La propagación de Pincel tipo rotoscopia y Perfeccionar borde está congelada. Descongelar para actualizarla.');
      if ((o.kind === 'refine' || o.kind === 'unrefine') && !d.strokes.some((s) => s.kind === 'fg')) throw new Error('Para utilizar Perfeccionar borde, pinte en los bordes de alfa creados, por ejemplo, con el Pincel tipo rotoscopia o las máscaras.');
      if (o.t < l.in - 1e-6 || o.t >= l.out - 1e-6) throw new Error('Ese instante está fuera de la capa.');
      const s = Math.round(((o.t - l.start) / (l.stretch || 1)) * 1e4) / 1e4;
      const same = d.strokes.filter((x) => x.kind === o.kind).length;
      const st: RotoStroke = { id: `rs${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, name: `${ROTO_KIND_NAMES[o.kind]} ${same + 1}`, kind: o.kind, s, d: Math.max(1, o.diameter ?? (o.kind === 'refine' || o.kind === 'unrefine' ? 10 : 25)), pts: o.points.flatMap((q) => [Math.round(q[0] * 100) / 100, Math.round(q[1] * 100) / 100]) };
      d.strokes.push(st);
      return { effect: f.id, stroke: { id: st.id, name: st.name } };
    });
  },
  /** Removes a stroke or the strokes of a frame (comp time), sets the span (comp times; null = the layer), freezes. */
  rotoEdit(e: Editor, compId: string, layerId: string, o: { deleteStroke?: string; clearFrame?: number; clearAll?: boolean; span?: [number, number] | null; freeze?: boolean }): { strokes: number; frozen: boolean } {
    const label = o.freeze !== undefined ? 'Cambio de congelación de pincel tipo rotoscopia' : o.span !== undefined ? 'Recortar el espacio de Pincel rotoscopia y Perf. borde' : 'Eliminar trazo';
    return e.mutate(label, (p) => {
      const c = findComp(compsOf(p), compId), l = findLayer(c, layerId), f = rotoFx(l);
      if (!f) throw new Error(`«${l.name}» no tiene el efecto Pincel rotoscopia y Perf. borde.`);
      const d = (f.roto ??= { strokes: [] });
      const editing = o.deleteStroke || o.clearFrame !== undefined || o.clearAll || o.span !== undefined;
      if (d.frozen && editing && o.freeze !== false) throw new Error('La propagación de Pincel tipo rotoscopia y Perfeccionar borde está congelada. Descongelar para actualizarla.');
      if (o.freeze === false) delete d.frozen;
      if (o.deleteStroke) {
        const s = d.strokes.find((x) => x.id === o.deleteStroke || x.name === o.deleteStroke);
        if (!s) throw new Error(`No existe el trazo «${o.deleteStroke}».`);
        d.strokes = d.strokes.filter((x) => x !== s);
      }
      if (o.clearFrame !== undefined) {
        const s = (o.clearFrame - l.start) / (l.stretch || 1);
        d.strokes = d.strokes.filter((x) => Math.abs(x.s - s) > 1e-3);
      }
      if (o.clearAll) { d.strokes = []; delete d.seg; }
      if (o.span !== undefined) {
        if (o.span === null) delete d.span;
        else { const st = l.stretch || 1, a = (Math.min(o.span[0], o.span[1]) - l.start) / st, b = (Math.max(o.span[0], o.span[1]) - l.start) / st; d.span = [Math.max(0, a), Math.max(0, b)]; }
      }
      if (o.freeze === true) {
        if (!d.seg) throw new Error('No hay propagación que congelar: pinte primero con el Pincel tipo rotoscopia.');
        d.frozen = new Date().toISOString();
      }
      if (!d.strokes.length) delete d.seg;
      return { strokes: d.strokes.length, frozen: !!d.frozen };
    });
  },
};
