// Editing operations of «capas» (guide layers, crop comp, region of interest, Responsive Design – Time markers,
// RotoBezier, variable mask feather, Wiggle Transform), with undo. Names and defaults as After Effects 2024.
import type { Editor } from '../ops';
import { findComp, findLayer, type Comp, type CompMarker, type FeatherPoint, type Layer } from './model';
import { newMarker, newWiggleTransform, retimeProtected, ROTO_TENSION, shiftLayerSpace, shiftLayerTime } from './capas';

const comps = (p: { comps?: Comp[] }) => (p.comps ??= []);
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const pickMask = (l: Layer, key: string) => {
  const m = l.masks.find((x) => x.id === key || x.name === key) ?? (/^\d+$/.test(key) ? l.masks[Number(key) - 1] : undefined);
  if (!m) throw new Error(`«${l.name}» no tiene la máscara «${key}». Tiene: ${l.masks.map((x) => x.name).join(', ') || 'ninguna'}.`);
  return m;
};
const pickMarker = (c: Comp, i: number) => {
  const m = c.markers[i];
  if (!m) throw new Error(`«${c.name}» no tiene el marcador ${i + 1} (tiene ${c.markers.length}).`);
  return m;
};
const sortMarkers = (c: Comp) => c.markers.sort((a, b) => a.t - b.t);

export interface MarkerPatch { t?: number; name?: string; dur?: number; protected?: boolean }
export interface WiggleTransformPatch { remove?: boolean; speed?: number; correlation?: number; temporalPhase?: number; spatialPhase?: number; seed?: number; anchor?: number[]; position?: number[]; scale?: number[]; rotation?: number }
export interface FeatherPatch { add?: Partial<FeatherPoint> & { seg: number; u: number }; set?: Partial<FeatherPoint> & { index: number }; remove?: number; points?: FeatherPoint[] | null }

export const CAPAS_OPS = {
  /** Capa ▸ Capa de guía: toggles (or sets) the guide switch of the layers. */
  layerGuide(e: Editor, compId: string, layerIds: string[], on?: boolean): boolean {
    return e.mutate('Capa de guía', (p) => {
      const c = findComp(comps(p), compId);
      const ls = layerIds.map((id) => findLayer(c, id));
      const v = on ?? !ls.every((l) => l.guide);
      for (const l of ls) { if (v) l.guide = true; else delete l.guide; }
      return v;
    });
  },
  /** Composición ▸ Separar comp. del entorno de trabajo (Ctrl+Mayús+X): the comp becomes its work area. */
  compCropWorkArea(e: Editor, compId: string): Comp {
    return e.mutate('Separar comp. del entorno de trabajo', (p) => {
      const c = findComp(comps(p), compId);
      const [a, b] = c.workArea;
      if (b - a < 1 / c.fps - 1e-9) throw new Error('El área de trabajo está vacía.');
      for (const l of c.layers) {
        shiftLayerTime(l, -a);
        l.in = Math.max(0, l.in); l.out = Math.min(b - a, l.out);
        if (l.out <= l.in) l.out = l.in + 1 / c.fps;
      }
      // markers outside the new span go; those that start before it are cut
      c.markers = c.markers.filter((m) => m.t - a >= 0 ? m.t - a <= b - a : m.t + (m.dur ?? 0) - a > 1e-9);
      for (const m of c.markers) {
        m.t -= a;
        if (m.t < 0) { m.dur = (m.dur ?? 0) + m.t; m.t = 0; }
        if (m.dur) m.dur = Math.min(m.dur, b - a - m.t);
      }
      c.duration = r6(b - a);
      c.workArea = [0, c.duration];
      return c;
    });
  },
  /** Composición ▸ Recortar comp. según región de interés: the comp takes the size of the region and the layers
   *  keep their place in the picture. */
  compCropRoi(e: Editor, compId: string, rect?: number[]): Comp {
    return e.mutate('Recortar comp. según región de interés', (p) => {
      const c = findComp(comps(p), compId);
      const r = rect ?? c.roi?.rect;
      if (!r) throw new Error('La composición no tiene región de interés: dibújela con el botón Región de interés del panel Composición.');
      let [x, y, w, h] = r.map((v) => Math.round(v));
      x = Math.max(0, Math.min(c.width - 1, x)); y = Math.max(0, Math.min(c.height - 1, y));
      w = Math.max(1, Math.min(c.width - x, w)); h = Math.max(1, Math.min(c.height - y, h));
      for (const l of c.layers) shiftLayerSpace(l, -x, -y);
      c.width = w; c.height = h;
      delete c.roi;
      return c;
    });
  },
  /** Región de interés of the Composition panel: rect (comp px) and/or on; null rect resets it (Alt+clic). */
  compRoi(e: Editor, compId: string, o: { rect?: number[] | null; on?: boolean }): Comp['roi'] | null {
    return e.mutate('Región de interés', (p) => {
      const c = findComp(comps(p), compId);
      if (o.rect === null) { delete c.roi; return null; }
      if (o.rect) {
        const [x0, y0, x1, y1] = [o.rect[0], o.rect[1], o.rect[0] + o.rect[2], o.rect[1] + o.rect[3]];
        const x = Math.max(0, Math.min(x0, x1)), y = Math.max(0, Math.min(y0, y1));
        const w = Math.min(c.width, Math.max(x0, x1)) - x, h = Math.min(c.height, Math.max(y0, y1)) - y;
        if (w < 1 || h < 1) throw new Error('La región de interés está fuera de la composición o no tiene tamaño.');
        c.roi = { rect: [Math.round(x), Math.round(y), Math.round(w), Math.round(h)], on: o.on ?? true };
      } else if (o.on !== undefined) {
        if (!c.roi) throw new Error('La composición no tiene región de interés: dé su rectángulo.');
        c.roi.on = o.on;
      }
      return c.roi ?? null;
    });
  },
  /** Composition marker (comment, duration, protected region). */
  markerAdd(e: Editor, compId: string, o: MarkerPatch & { t: number }): { index: number; marker: CompMarker } {
    return e.mutate('Añadir marcador', (p) => {
      const c = findComp(comps(p), compId);
      const m = newMarker(Math.max(0, Math.min(c.duration, o.t)), { name: o.name, dur: Math.max(0, Math.min(c.duration - o.t, o.dur ?? 0)), protected: o.protected });
      if (m.protected && !m.dur) throw new Error('Una zona protegida necesita duración.');
      c.markers.push(m);
      sortMarkers(c);
      return { index: c.markers.indexOf(m), marker: m };
    });
  },
  markerSet(e: Editor, compId: string, index: number, o: MarkerPatch & { remove?: boolean }): CompMarker | null {
    return e.mutate(o.remove ? 'Eliminar marcador' : 'Marcador', (p) => {
      const c = findComp(comps(p), compId);
      const m = pickMarker(c, index);
      if (o.remove) { c.markers.splice(index, 1); return null; }
      if (o.t !== undefined) m.t = Math.max(0, Math.min(c.duration, o.t));
      if (o.name !== undefined) m.name = o.name;
      if (o.dur !== undefined) { const d = Math.max(0, Math.min(c.duration - m.t, o.dur)); if (d) m.dur = d; else delete m.dur; }
      if (o.protected !== undefined) {
        if (o.protected) {
          // a marker without duration becomes a region up to the next marker (or the end of the comp)
          if (!m.dur) { const next = c.markers.filter((x) => x.t > m.t + 1e-9).sort((a, b) => a.t - b.t)[0]; m.dur = (next ? next.t : c.duration) - m.t; }
          if (!m.dur) throw new Error('Una zona protegida necesita duración.');
          m.protected = true;
        } else delete m.protected;
      }
      sortMarkers(c);
      return m;
    });
  },
  /** Composición ▸ Diseño interactivo: tiempo ▸ Crear Intro / Crear Outro / Crear zona protegida desde el área de
   *  trabajo / Habilitar zona protegida (every marker, from it to the next one). */
  responsiveTime(e: Editor, compId: string, kind: 'intro' | 'outro' | 'workArea' | 'markers', at?: number): CompMarker[] {
    const label = { intro: 'Crear Intro', outro: 'Crear Outro', workArea: 'Crear zona protegida desde el área de trabajo', markers: 'Habilitar zona protegida' }[kind];
    return e.mutate(label, (p) => {
      const c = findComp(comps(p), compId);
      const t = Math.max(0, Math.min(c.duration, at ?? 0));
      const add = (a: number, b: number, name: string) => {
        if (b - a < 1e-6) throw new Error(kind === 'intro' ? 'Sitúe el indicador de tiempo después del inicio: la intro va del inicio hasta él.' : kind === 'outro' ? 'Sitúe el indicador de tiempo antes del final: la outro va desde él hasta el final.' : 'La zona protegida no tiene duración.');
        const m = newMarker(a, { name, dur: b - a, protected: true });
        c.markers.push(m);
        return m;
      };
      let out: CompMarker[];
      if (kind === 'intro') out = [add(0, t, 'Intro')];
      else if (kind === 'outro') out = [add(t, c.duration, 'Outro')];
      else if (kind === 'workArea') out = [add(c.workArea[0], c.workArea[1], '')];
      else {
        const list = [...c.markers].sort((a, b) => a.t - b.t);
        if (!list.length) throw new Error('La composición no tiene marcadores: añádalos (* del teclado numérico) y vuelva a intentarlo.');
        list.forEach((m, i) => { if (!m.dur) m.dur = (list[i + 1]?.t ?? c.duration) - m.t; if (m.dur > 0) m.protected = true; });
        out = list.filter((m) => m.protected);
      }
      sortMarkers(c);
      return out;
    });
  },
  /** Capa ▸ Máscara y trazado de forma ▸ RotoBézier (on the given masks; tension per vertex, % or one for all). */
  maskRoto(e: Editor, compId: string, layerId: string, maskIds: string[] | 'all', on?: boolean, tension?: number | number[]): boolean {
    return e.mutate('RotoBézier', (p) => {
      const c = findComp(comps(p), compId), l = findLayer(c, layerId);
      const ms = maskIds === 'all' ? l.masks : maskIds.map((k) => pickMask(l, k));
      if (!ms.length) throw new Error(`«${l.name}» no tiene máscaras.`);
      const v = on ?? !ms.every((m) => m.rotoBezier);
      for (const m of ms) {
        if (v) m.rotoBezier = true; else { delete m.rotoBezier; delete m.tension; }
        if (v && tension !== undefined) {
          const n = Math.floor(((m.path.v as number[]) ?? []).length / 6);
          m.tension = Array.from({ length: n }, (_, i) => Math.max(0, Math.min(100, Array.isArray(tension) ? tension[i] ?? ROTO_TENSION : tension)));
        }
      }
      return v;
    });
  },
  /** Herramienta Calado de máscara: add / change / remove feather points (or replace them all). */
  maskFeather(e: Editor, compId: string, layerId: string, maskId: string, o: FeatherPatch): FeatherPoint[] {
    return e.mutate('Calado de máscara', (p) => {
      const c = findComp(comps(p), compId), l = findLayer(c, layerId), m = pickMask(l, maskId);
      const n = Math.floor(((m.path.v as number[]) ?? []).length / 6);
      const fix = (f: Partial<FeatherPoint>): FeatherPoint => {
        const seg = Math.max(0, Math.min(n - 1, Math.floor(f.seg ?? 0)));
        return { seg, u: Math.max(0, Math.min(1, f.u ?? 0)), r: f.r ?? 0, tension: Math.max(0, Math.min(100, f.tension ?? 0)) };
      };
      if (o.points === null) delete m.featherPts;
      else if (o.points) m.featherPts = o.points.map(fix);
      if (o.add) (m.featherPts ??= []).push(fix(o.add));
      if (o.set) {
        const f = m.featherPts?.[o.set.index];
        if (!f) throw new Error(`La máscara «${m.name}» no tiene el punto de calado ${o.set.index + 1}.`);
        Object.assign(f, fix({ ...f, ...Object.fromEntries(Object.entries(o.set).filter(([k, v]) => k !== 'index' && v !== undefined)) }));
      }
      if (o.remove !== undefined) {
        if (!m.featherPts?.[o.remove]) throw new Error(`La máscara «${m.name}» no tiene el punto de calado ${o.remove + 1}.`);
        m.featherPts.splice(o.remove, 1);
      }
      if (m.featherPts && !m.featherPts.length) delete m.featherPts;
      m.featherPts?.sort((a, b) => a.seg - b.seg || a.u - b.u);
      return m.featherPts ?? [];
    });
  },
  /** Añadir ▸ Transformación de ondulación on a shape group (or remove it). */
  shapeWiggleTransform(e: Editor, compId: string, layerId: string, shapeId: string, o: WiggleTransformPatch = {}): ReturnType<typeof newWiggleTransform> | null {
    return e.mutate('Transformación de ondulación', (p) => {
      const c = findComp(comps(p), compId), l = findLayer(c, layerId);
      const s = (l.shapes ?? []).find((x) => x.id === shapeId || x.name === shapeId);
      if (!s) throw new Error(`«${l.name}» no tiene la forma «${shapeId}». Tiene: ${(l.shapes ?? []).map((x) => x.name).join(', ') || 'ninguna'}.`);
      if (o.remove) { delete s.wiggleTransform; return null; }
      const w = (s.wiggleTransform ??= newWiggleTransform());
      if (o.speed !== undefined) w.speed.v = o.speed;
      if (o.correlation !== undefined) w.correlation.v = Math.max(0, Math.min(100, o.correlation));
      if (o.temporalPhase !== undefined) w.temporalPhase.v = o.temporalPhase;
      if (o.spatialPhase !== undefined) w.spatialPhase.v = o.spatialPhase;
      if (o.seed !== undefined) w.seed = Math.round(o.seed);
      if (o.anchor) w.anchor.v = [o.anchor[0] ?? 0, o.anchor[1] ?? 0];
      if (o.position) w.position.v = [o.position[0] ?? 0, o.position[1] ?? 0];
      if (o.scale) w.scale.v = [o.scale[0] ?? 0, o.scale[1] ?? o.scale[0] ?? 0];
      if (o.rotation !== undefined) w.rotation.v = o.rotation;
      return w;
    });
  },
};

/** compSet hook: a new duration keeps the timing of the protected regions (Responsive Design – Time). */
export function durationChanged(c: Comp, oldDur: number): boolean { return retimeProtected(c, oldDur, c.duration); }
