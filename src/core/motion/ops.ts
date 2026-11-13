// Editing operations of the advanced mode. They go through Editor.mutate, so every call is one undo step and
// works the same from the window (IPC "motion") and from the MCP server.
import { baseOutline } from './geom';
import type { Editor } from '../ops';
import { uid, type MediaItem, type Project } from '../model';
import { easeKeys, keyedAt, segmentProgress, setKey, valueAt, isSpatial, rnd, EASE_IN, EASE_OUT } from './anim';
import { smartMaskPair, type SmartMaskOptions } from './maskinterp';
import { easeKeysAE, isSeparated, joinPosition, keyVelocity, separatePosition, setKeyVelocity, type EaseKind, type SideIn } from './velocity';
import { forEachStrokeProp, pickStroke, strokeProp, PAINT_OPS } from './paint';
import { DATA_OPS } from './data-ops';
import { VECTOR_OPS } from './vectores';
import { MODEL_OPS } from './model3d-ops';
import { EXTRUDE_OPS, autoSurfaceColor } from './extrude-ops';
import { TEXT_OPS } from './texto-ops';
import { ROTO_OPS } from './roto';
import { CAPAS_OPS, durationChanged } from './capas-ops';
import { GEOMETRY_KEYS, SURFACE_KEYS, geometrySummary, newGeometry, type SurfaceKey } from './extrude';
import { modelSummary, modelToLayer, newModelOptions } from './model3d';
import { fxDef, newFx } from './effects';
import { newStyle, styleDef } from './styles';
import {
  defaultZoom, ellipsePath, findComp, findLayer, LIGHT_TYPES, newComp, newLayer, newMask, newMaterial, newShape, P, rectPath,
  type Comp, type Key, type Layer, type MatteMode, type LayerType, type Mask, type Prop, type PVal, type Selector, type ShapeItem, type ShapeKind, type TextAnimator,
  type LightOptions, type LightType, type Material, type MergeMode, type EssentialProp, type RenderItem, type RenderSettings, type OutputModule,
  BEST_SETTINGS, DEFAULT_OUTPUT,
} from './model';

export const comps = (p: Project) => (p.comps ??= []);

// ───────────────────────── property paths ─────────────────────────
const ALIAS: Record<string, string> = {
  position: 'transform.position', anchor: 'transform.anchor', anchorPoint: 'transform.anchor', scale: 'transform.scale',
  rotation: 'transform.rotation', opacity: 'transform.opacity', rotationX: 'transform.rotationX', rotationY: 'transform.rotationY',
  xRotation: 'transform.rotationX', yRotation: 'transform.rotationY', zRotation: 'transform.rotation', sourceText: 'text.text',
  positionX: 'transform.positionX', positionY: 'transform.positionY', positionZ: 'transform.positionZ', xPosition: 'transform.positionX', yPosition: 'transform.positionY', zPosition: 'transform.positionZ',
};
export const canonPath = (path: string) => ALIAS[path] ?? path;

const pick = <T extends { id: string; name: string }>(list: T[], key: string, what: string): T => {
  const i = /^\d+$/.test(key) ? Number(key) : -1;
  const k = key.toLowerCase();
  // effects can also be named by their catalogue id ("glow", "gradientRamp"): the first one of that kind
  const x = (i >= 0 && list[i]) || list.find((y) => y.id === key || y.name === key || y.name.toLowerCase() === k)
    || list.find((y) => (y as { fx?: string }).fx?.toLowerCase() === k);
  if (!x) throw new Error(`No existe ${what} «${key}». Hay: ${list.map((y) => ((y as { fx?: string }).fx ? `${y.name} (${(y as { fx?: string }).fx})` : y.name)).join(', ') || 'ninguno'}.`);
  return x;
};

/** Resolves a property path inside a layer to its Prop (creating optional ones such as animator properties). */
export function resolveProp(l: Layer, path0: string, create = true): Prop {
  const path = canonPath(path0);
  const parts = path.split('.');
  const bad = () => new Error(`Propiedad desconocida «${path0}» en la capa «${l.name}». Ejemplos: position, scale, rotation, opacity, anchor, rotationX, text.size, text.fill, effects.<efecto>.<parámetro>, masks.<máscara>.feather, shapes.<forma>.size, camera.zoom, audio.level, timeRemap.`);
  const asProp = (x: unknown): Prop => { if (x && typeof x === 'object' && 'v' in (x as object)) return x as Prop; throw bad(); };
  switch (parts[0]) {
    case 'transform': return asProp((l.transform as unknown as Record<string, unknown>)[parts[1]]);
    case 'text': {
      if (!l.text) throw new Error(`«${l.name}» no es una capa de texto.`);
      if (parts[1] === 'animators') {
        const an = pick(l.text.animators, parts[2], 'el animador');
        if (parts[3] === 'selectors') {
          const s = an.selectors[Number(parts[4])] as unknown as Record<string, unknown>;
          if (!s) throw bad();
          return asProp(s[parts[5]]);
        }
        const k = parts[3] === 'props' ? parts[4] : parts[3];
        const props = an.props as Record<string, Prop | undefined>;
        if (!props[k]) {
          if (!create) throw bad();
          props[k] = P(animDefault(k));
        }
        return props[k]!;
      }
      if (parts[1] === 'axes') { const ax = l.text.axes?.[parts[2]]; if (!ax) throw new Error(`«${l.name}» no tiene el eje «${parts[2]}»: añádalo con text_font_axes.`); return ax; }
      if (parts[1] === 'path') { if (!l.text.path) throw new Error(`«${l.name}» no tiene texto en trazado: use layer_set text_style.path.`); return asProp((l.text.path as unknown as Record<string, unknown>)[parts[2]]); }
      return asProp((l.text as unknown as Record<string, unknown>)[parts[1]]);
    }
    case 'effects': {
      const fx = pick(l.effects, parts[1], 'el efecto');
      if (parts[2] === 'strokes' && fx.strokes) return strokeProp(fx, parts.slice(2));
      const key = Object.keys(fx.params).find((k) => k === parts[2] || k.toLowerCase() === (parts[2] ?? '').toLowerCase());
      if (!key) throw new Error(`El efecto «${fx.name}» no tiene «${parts[2]}». Tiene: ${Object.keys(fx.params).join(', ')}.`);
      return fx.params[key];
    }
    case 'styles': {
      const st = (l.styles ?? []).find((x) => x.id === parts[1] || x.fx === parts[1] || x.name.toLowerCase() === (parts[1] ?? '').toLowerCase());
      if (!st) throw new Error(`«${l.name}» no tiene el estilo «${parts[1]}»: añádalo con layer_style.`);
      return asProp(st.params[parts[2]]);
    }
    case 'puppet': {
      const pin = l.puppet?.pins.find((x) => x.id === parts[1] || x.name === parts[1]);
      if (!pin) throw new Error(`«${l.name}» no tiene el pin «${parts[1]}»: añádalo con puppet_pin.`);
      return pin.position;
    }
    case 'masks': return asProp((pick(l.masks, parts[1], 'la máscara') as unknown as Record<string, unknown>)[parts[2]]);
    case 'shapes': {
      const s = pick(l.shapes ?? [], parts[1], 'la forma') as unknown as Record<string, unknown>;
      let o: unknown = s;
      for (const p of parts.slice(2)) o = (o as Record<string, unknown> | undefined)?.[p];
      return asProp(o);
    }
    case 'camera': {
      if (!l.camera) throw bad();
      if (parts[1] === 'dof') { l.camera.dof ??= { on: false, focus: P(Number(l.camera.zoom.v) || 1000), aperture: P(25), blur: P(100) }; return asProp((l.camera.dof as unknown as Record<string, unknown>)[parts[2]]); }
      return asProp((l.camera as unknown as Record<string, unknown>)[parts[1]]);
    }
    case 'light': if (!l.light) throw bad(); return asProp((l.light as unknown as Record<string, unknown>)[parts[1]]);
    case 'material': {
      l.material ??= newMaterial();
      // per-surface colours of extruded layers (extrude.ts) start from the automatic colour
      if ((SURFACE_KEYS as readonly string[]).includes(parts[1]) && !l.material[parts[1] as SurfaceKey]) { if (!create) throw bad(); l.material[parts[1] as SurfaceKey] = P(autoSurfaceColor(l, parts[1] as SurfaceKey)); }
      return asProp((l.material as unknown as Record<string, unknown>)[parts[1]]);
    }
    case 'geometry': {
      if (l.type !== 'text' && l.type !== 'shape') throw new Error(`«${l.name}»: las opciones de geometría son de capas de texto y de forma 3D.`);
      if (!(GEOMETRY_KEYS as readonly string[]).includes(parts[1])) throw bad();
      if (!l.geometry) { if (!create) throw bad(); l.geometry = newGeometry(); }
      return l.geometry[parts[1] as (typeof GEOMETRY_KEYS)[number]];
    }
    case 'model': {
      if (!l.model) throw new Error(`«${l.name}» no es una capa de modelo 3D.`);
      const k = parts[1] as 'speed' | 'offset' | 'metalness' | 'roughness' | 'emissive' | 'emissiveIntensity';
      if (!['speed', 'offset', 'metalness', 'roughness', 'emissive', 'emissiveIntensity'].includes(k)) throw bad();
      // the material overrides start from neutral values when first set
      if (!l.model[k]) { if (!create) throw bad(); (l.model as unknown as Record<string, Prop>)[k] = P(k === 'emissive' ? '#000000' : k === 'emissiveIntensity' ? 100 : k === 'roughness' ? 50 : 0); }
      return l.model[k]!;
    }
    case 'audio': return l.audio.level;
    case 'essential': {
      const k = parts.slice(1).join('.'), o = (l.overrides ?? []).find((x) => x.id === k || x.name === k || x.name.toLowerCase() === k.toLowerCase());
      if (!o) throw new Error(`«${l.name}» no tiene la propiedad esencial «${k}» cambiada${l.overrides?.length ? ` (cambiadas: ${l.overrides.map((x) => x.name).join(', ')})` : ''}: dele un valor con prop_set path "essential.${k}".`);
      return o.prop;
    }
    case 'timeRemap': if (!l.timeRemap) { if (!create) throw bad(); l.timeRemap = P(0); l.timeRemap.k = [{ t: l.in, v: (l.in - l.start) / l.stretch }, { t: l.out, v: (l.out - l.start) / l.stretch }]; } return l.timeRemap;
    default: throw bad();
  }
}
/** Path used for seeds and expression lookups (stable ids instead of names). */
export function stablePath(l: Layer, path0: string): string {
  const parts = canonPath(path0).split('.');
  if (parts[0] === 'effects') { const fx = pick(l.effects, parts[1], 'el efecto'); parts[1] = fx.id; if (parts[2] === 'strokes' && fx.strokes) parts[3] = pickStroke(fx, parts[3] ?? '').id; }
  if (parts[0] === 'masks') parts[1] = pick(l.masks, parts[1], 'la máscara').id;
  if (parts[0] === 'shapes') parts[1] = pick(l.shapes ?? [], parts[1], 'la forma').id;
  if (parts[0] === 'text' && parts[1] === 'animators') { parts[2] = pick(l.text!.animators, parts[2], 'el animador').id; if (parts[3] !== 'selectors' && parts[3] !== 'props') parts.splice(3, 0, 'props'); }
  if (parts[0] === 'essential') { const k = parts.slice(1).join('.'); return `essential.${(l.overrides ?? []).find((x) => x.id === k || x.name.toLowerCase() === k.toLowerCase())?.id ?? k}`; }
  return parts.join('.');
}

// ───────────────────────── render queue ─────────────────────────
function pickItem(q: RenderItem[], key: string): RenderItem {
  const it = (/^\d+$/.test(key) ? q[Number(key) - 1] : undefined) ?? q.find((x) => x.id === key);
  if (!it) throw new Error(`No existe el elemento «${key}» en la cola de render (hay ${q.length}).`);
  return it;
}
function newOutput(o: Partial<Omit<OutputModule, 'id'>>): OutputModule {
  return { id: uid('om'), format: o.format ?? 'mp4', path: o.path ?? DEFAULT_OUTPUT, audio: o.audio ?? true, ...(o.quality ? { quality: o.quality } : {}) };
}
function validSettings(s: RenderSettings) {
  if (!(s.resolution > 0 && s.resolution <= 4)) throw new Error('La resolución va de 0 a 4 (1 = completa, 0.5 = mitad).');
  if (Array.isArray(s.span) && !(s.span[1] > s.span[0])) throw new Error('El intervalo de tiempo debe ser [desde, hasta] con hasta > desde.');
  if (s.fps !== null && !(s.fps >= 1 && s.fps <= 120)) throw new Error('La velocidad de fotogramas va de 1 a 120.');
}

// ───────────────────────── Essential Graphics ─────────────────────────
/** An exposed property of a comp, by id, name or 1-based index. */
export function pickEssential(c: Comp, key: string): EssentialProp {
  const list = c.essential ?? [], k = key.toLowerCase();
  const x = (/^\d+$/.test(key) ? list[Number(key) - 1] : undefined) ?? list.find((y) => y.id === key || y.name === key || y.name.toLowerCase() === k);
  if (!x) throw new Error(`«${c.name}» no expone «${key}» en gráficos esenciales. ${list.length ? `Expone: ${list.map((y) => y.name).join(', ')}.` : 'Añada propiedades con essential_props add.'}`);
  return x;
}
/** Value the exposed property has inside its comp (its first key when animated): what an override starts from. */
export function essentialDefault(c: Comp, ep: EssentialProp): PVal {
  const l = c.layers.find((y) => y.id === ep.layer);
  if (!l) return 0;
  if (ep.path === 'source') return l.mediaId ?? '';
  const prop = resolveProp(l, ep.path, false);
  return JSON.parse(JSON.stringify(prop.k?.length ? prop.k[0].v : prop.v)) as PVal;
}
/** Before setting essential.<name> on a comp layer: create its override from the nested comp's current value. */
function ensureOverride(p: Project, l: Layer, path: string) {
  const parts = canonPath(path).split('.');
  if (parts[0] !== 'essential') return;
  if (l.type !== 'comp') throw new Error(`«${l.name}» no es una capa de composición: las propiedades esenciales se cambian en las capas que anidan una composición.`);
  const sub = findComp(comps(p), l.compId ?? '');
  const ep = pickEssential(sub, parts.slice(1).join('.'));
  l.overrides ??= [];
  if (!l.overrides.some((o) => o.id === ep.id)) l.overrides.push({ id: ep.id, name: ep.name, prop: P(essentialDefault(sub, ep)) });
}
/** Layers that nest comp `id`, in every comp of the project. */
const nesting = (p: Project, id: string) => comps(p).flatMap((c) => c.layers.filter((l) => l.type === 'comp' && l.compId === id));

function animDefault(k: string): PVal {
  return ({ position: [0, 0, 0], scale: [100, 100], rotation: 0, rotationY: 0, rotationX: 0, opacity: 100, fill: '#ffffff', stroke: '#000000', tracking: 0, blur: 0, skew: 0, charOffset: 0, frontColor: '#ffffff', bevelColor: '#ffffff', sideColor: '#ffffff', backColor: '#ffffff' } as Record<string, PVal>)[k] ?? 0;
}

/** Coerces user input to the shape of the current value (pads vectors, number → uniform scale…). */
export function coerce(cur: PVal, v: PVal | boolean): PVal { return coerceValue(cur, v); }
function coerceValue(cur: PVal, v: PVal | boolean): PVal {
  if (typeof v === 'boolean') return v ? 1 : 0; // checkboxes, given as true / false
  if (Array.isArray(cur)) {
    if (typeof v === 'number') return cur.map((_, i) => (i < 2 || cur.length === 2 ? v : cur[i]));
    // a 2D point given with z (per-character 3D animator positions created before) grows to 3D
    if (Array.isArray(v) && cur.length === 2 && v.length === 3 && v.every((x) => typeof x === 'number')) return v as number[];
    if (Array.isArray(v)) return cur.map((c, i) => (typeof v[i] === 'number' ? v[i] : c));
    throw new Error(`Se esperaba un número o una lista de números (actual: ${JSON.stringify(cur)}).`);
  }
  if (typeof cur === 'number') {
    const n = Array.isArray(v) ? v[0] : Number(v);
    if (!Number.isFinite(n)) throw new Error(`Se esperaba un número, no ${JSON.stringify(v)}.`);
    return n;
  }
  return typeof v === 'string' ? v : String(v);
}

// ───────────────────────── operations ─────────────────────────
type KeyIn = { t: number; v: PVal | boolean; ease?: 'easy' | 'in' | 'out' | 'linear' | 'hold' | 'bezier'; eo?: [number, number]; ei?: [number, number] };

export const motionOps = {
  compNew(e: Editor, o: Partial<Pick<Comp, 'name' | 'width' | 'height' | 'fps' | 'duration' | 'bg' | 'transparent'>> = {}): Comp {
    return e.mutate('Nueva composición', (p) => {
      const s = p.settings;
      const list = comps(p);
      const c = newComp({ width: s.width, height: s.height, fps: s.fps, ...o, name: o.name ?? `Composición ${list.length + 1}` });
      list.push(c);
      return c;
    });
  },
  compSet(e: Editor, compId: string, patch: Partial<Pick<Comp, 'name' | 'width' | 'height' | 'fps' | 'duration' | 'bg' | 'transparent' | 'workArea'>> & { motionBlur?: Partial<Comp['motionBlur']> }): Comp {
    return e.mutate('Configuración de la composición', (p) => {
      const c = findComp(comps(p), compId);
      const { motionBlur, ...rest } = patch;
      const oldDur = c.duration;
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) (c as unknown as Record<string, unknown>)[k] = v;
      if (motionBlur) Object.assign(c.motionBlur, motionBlur);
      // Responsive Design – Time: with protected regions the contents are retimed around them
      if (patch.duration !== undefined && !patch.workArea && durationChanged(c, oldDur)) return c;
      if (patch.duration !== undefined && !patch.workArea) {
        c.workArea = [Math.min(c.workArea[0], c.duration), c.workArea[1] >= oldDur - 1e-6 ? c.duration : Math.min(c.workArea[1], c.duration)];
        for (const l of c.layers) if (l.out >= oldDur - 1e-6 && (l.type === 'text' || l.type === 'shape' || l.type === 'solid' || l.type === 'null' || l.type === 'adjustment' || l.type === 'camera' || l.type === 'image')) l.out = c.duration;
      }
      return c;
    });
  },
  /** Project colour settings of the advanced mode (depth in bits per channel, blending with gamma 1.0). */
  colorSettings(e: Editor, patch: { depth?: 8 | 16 | 32; blendGamma1?: boolean }): { depth: 8 | 16 | 32; blendGamma1: boolean } {
    return e.mutate('Configuración de color del proyecto', (p) => {
      const cur = p.motionColor ?? { depth: 8, blendGamma1: false };
      if (patch.depth !== undefined) { if (![8, 16, 32].includes(patch.depth)) throw new Error('La profundidad de color es 8, 16 o 32 bits por canal.'); cur.depth = patch.depth; }
      if (patch.blendGamma1 !== undefined) cur.blendGamma1 = patch.blendGamma1;
      if (cur.depth === 8 && !cur.blendGamma1) delete p.motionColor; else p.motionColor = cur;
      return { ...cur };
    });
  },
  /** Replaces a whole composition (the window commits its local edits with this: one undo step). */
  setComp(e: Editor, comp: Comp, label = 'Editar composición'): Comp {
    return e.mutate(label, (p) => {
      const list = comps(p);
      const i = list.findIndex((c) => c.id === comp.id);
      if (i < 0) list.push(comp); else list[i] = comp;
      return comp;
    });
  },
  compDelete(e: Editor, compId: string): void {
    e.mutate('Eliminar composición', (p) => {
      const c = findComp(comps(p), compId);
      p.comps = comps(p).filter((x) => x !== c);
      for (const o of p.comps) o.layers = o.layers.filter((l) => l.compId !== c.id);
    });
  },
  compDuplicate(e: Editor, compId: string): Comp {
    return e.mutate('Duplicar composición', (p) => {
      const c = JSON.parse(JSON.stringify(findComp(comps(p), compId))) as Comp;
      c.id = uid('k');
      c.name = `${c.name} 2`;
      comps(p).push(c);
      return c;
    });
  },

  // ── render queue (After Effects: Composition > Add to Render Queue) ──
  queueAdd(e: Editor, compId: string, o: { settings?: Partial<RenderSettings>; outputs?: Partial<Omit<OutputModule, 'id'>>[] } = {}): RenderItem {
    return e.mutate('Añadir a la cola de render', (p) => {
      const c = findComp(comps(p), compId);
      const it: RenderItem = { id: uid('rq'), compId: c.id, status: 'queued', settings: { ...BEST_SETTINGS, ...o.settings }, outputs: [] };
      for (const om of o.outputs?.length ? o.outputs : [{}]) it.outputs.push(newOutput(om));
      validSettings(it.settings);
      (p.renderQueue ??= []).push(it);
      return it;
    });
  },
  /** Changes an item: status (queued / unqueued…), render settings, its output modules (replaced), its place. */
  queueSet(e: Editor, itemId: string, o: { status?: RenderItem['status']; settings?: Partial<RenderSettings>; outputs?: Partial<Omit<OutputModule, 'id'>>[]; addOutput?: Partial<Omit<OutputModule, 'id'>>; removeOutput?: string; index?: number; log?: RenderItem['log'] }): RenderItem {
    return e.mutate('Cola de render', (p) => {
      const q = p.renderQueue ?? [];
      const it = pickItem(q, itemId);
      if (o.status) it.status = o.status;
      if (o.settings) { it.settings = { ...it.settings, ...o.settings }; validSettings(it.settings); }
      if (o.outputs) it.outputs = o.outputs.map(newOutput);
      if (o.addOutput) it.outputs.push(newOutput(o.addOutput));
      if (o.removeOutput) { if (it.outputs.length < 2) throw new Error('Un elemento necesita al menos un módulo de salida.'); it.outputs = it.outputs.filter((x) => x.id !== o.removeOutput && String(it.outputs.indexOf(x) + 1) !== o.removeOutput); }
      if (o.log) it.log = o.log;
      if (o.index !== undefined) { q.splice(q.indexOf(it), 1); q.splice(Math.max(0, Math.min(q.length, o.index - 1)), 0, it); }
      return it;
    });
  },
  queueRemove(e: Editor, itemIds: string[] | 'done'): number {
    return e.mutate('Quitar de la cola de render', (p) => {
      const q = p.renderQueue ?? [], before = q.length;
      const drop = itemIds === 'done' ? q.filter((x) => x.status === 'done') : itemIds.map((x) => pickItem(q, x));
      p.renderQueue = q.filter((x) => !drop.includes(x));
      return before - p.renderQueue.length;
    });
  },
  // ── proxies (After Effects: File > Set Proxy / Create Proxy) ──
  /** Footage proxy: set a file (already made), switch it on / off, or remove it. */
  mediaProxySet(e: Editor, mediaId: string, o: { path?: string; width?: number; height?: number; on?: boolean; remove?: boolean }): MediaItem {
    return e.mutate('Proxy de metraje', (p) => {
      const m = p.media.find((x) => x.id === mediaId || x.path === mediaId);
      if (!m) throw new Error(`No existe el archivo «${mediaId}» en el proyecto.`);
      if (o.remove) { delete m.proxy; return m; }
      if (o.path) m.proxy = { path: o.path, width: o.width ?? m.width, height: o.height ?? m.height, on: o.on ?? true };
      else if (!m.proxy) throw new Error(`«${m.path.split(/[\\/]/).pop()}» no tiene proxy: créelo primero.`);
      if (o.on !== undefined) m.proxy.on = o.on;
      return m;
    });
  },
  /** Comp proxy: a rendered movie drawn instead of the comp wherever it is nested. */
  compProxySet(e: Editor, compId: string, o: { path?: string; hash?: string; on?: boolean; remove?: boolean }): Comp {
    return e.mutate('Proxy de composición', (p) => {
      const c = findComp(comps(p), compId);
      if (o.remove) { delete c.proxy; return c; }
      if (o.path) c.proxy = { path: o.path, on: o.on ?? true, hash: o.hash };
      else if (!c.proxy) throw new Error(`«${c.name}» no tiene proxy: créelo primero.`);
      if (o.on !== undefined) c.proxy.on = o.on;
      return c;
    });
  },

  /** Essential Graphics: expose a property of a layer of this comp (Add Property to Essential Graphics). */
  essentialAdd(e: Editor, compId: string, layerId: string, path: string, o: { name?: string; index?: number } = {}): EssentialProp {
    return e.mutate('Añadir a gráficos esenciales', (p) => {
      const c = findComp(comps(p), compId), l = findLayer(c, layerId);
      let sp = 'source';
      if (canonPath(path) === 'source') { if (l.type !== 'image' && l.type !== 'video') throw new Error(`Sustitución de medios: «${l.name}» no es una capa de imagen o de vídeo.`); }
      else { if (canonPath(path).startsWith('essential.')) throw new Error('Exponga la propiedad de dentro de la composición, no una propiedad esencial.'); resolveProp(l, path, false); sp = stablePath(l, path); }
      c.essential ??= [];
      if (c.essential.some((x) => x.layer === l.id && x.path === sp)) throw new Error(`«${path}» de «${l.name}» ya está en gráficos esenciales.`);
      const last = sp === 'source' ? '' : sp.split('.').pop()!;
      const name = (o.name ?? (sp === 'source' ? l.name : sp === 'text.text' ? l.name : `${l.name} ${last}`)).trim();
      if (!name) throw new Error('El nombre no puede estar vacío.');
      if (c.essential.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`Ya hay una propiedad esencial llamada «${name}»: indique name.`);
      const ep: EssentialProp = { id: uid('ep'), name, layer: l.id, path: sp };
      c.essential.splice(Math.max(0, Math.min(c.essential.length, (o.index ?? c.essential.length + 1) - 1)), 0, ep);
      return ep;
    });
  },
  /** Removes an exposed property, and the overrides of it in the layers that nest the comp. */
  essentialRemove(e: Editor, compId: string, key: string): void {
    e.mutate('Quitar de gráficos esenciales', (p) => {
      const c = findComp(comps(p), compId), ep = pickEssential(c, key);
      c.essential = c.essential!.filter((x) => x !== ep);
      if (!c.essential.length) delete c.essential;
      for (const l of nesting(p, c.id)) { l.overrides = l.overrides?.filter((o) => o.id !== ep.id); if (!l.overrides?.length) delete l.overrides; }
    });
  },
  /** Renames and / or moves an exposed property (the overrides follow). */
  essentialSet(e: Editor, compId: string, key: string, o: { name?: string; index?: number }): EssentialProp {
    return e.mutate('Gráficos esenciales', (p) => {
      const c = findComp(comps(p), compId), ep = pickEssential(c, key);
      if (o.name !== undefined) {
        const name = o.name.trim();
        if (!name) throw new Error('El nombre no puede estar vacío.');
        if (c.essential!.some((x) => x !== ep && x.name.toLowerCase() === name.toLowerCase())) throw new Error(`Ya hay una propiedad esencial llamada «${name}».`);
        ep.name = name;
        for (const l of nesting(p, c.id)) for (const ov of l.overrides ?? []) if (ov.id === ep.id) ov.name = name;
      }
      if (o.index !== undefined) { const list = c.essential!.filter((x) => x !== ep); list.splice(Math.max(0, Math.min(list.length, o.index - 1)), 0, ep); c.essential = list; }
      return ep;
    });
  },
  /** Back to the nested comp's own value: drops one override (or all of them) of a comp layer. */
  essentialReset(e: Editor, compId: string, layerId: string, key?: string): number {
    return e.mutate('Restablecer propiedad esencial', (p) => {
      const l = findLayer(findComp(comps(p), compId), layerId);
      const before = l.overrides?.length ?? 0;
      if (key) { const k = key.toLowerCase(); l.overrides = l.overrides?.filter((o) => o.id !== key && o.name.toLowerCase() !== k); } else delete l.overrides;
      if (!l.overrides?.length) delete l.overrides;
      return before - (l.overrides?.length ?? 0);
    });
  },

  layerAdd(e: Editor, compId: string, type: LayerType, o: { name?: string; mediaId?: string; compId?: string; text?: string; color?: string; width?: number; height?: number; start?: number; duration?: number; index?: number; size?: number; font?: string; position?: number[] } = {}): Layer {
    return e.mutate('Nueva capa', (p) => {
      const c = findComp(comps(p), compId);
      let l: Layer;
      if (type === 'video' || type === 'image' || type === 'audio') {
        const m = p.media.find((x) => x.id === o.mediaId);
        if (!m) throw new Error('Indique mediaId de un archivo importado (media_import / media_list).');
        if (type !== 'audio' && !m.hasVideo && m.kind !== 'image') throw new Error('Ese archivo no tiene imagen: use una capa de audio.');
        const w = m.width || c.width, h = m.height || c.height;
        l = newLayer(type, c, { w, h, name: o.name ?? m.path.split(/[\\/]/).pop(), mediaId: m.id, solid: { color: '#000000', width: w, height: h } });
        const dur = m.kind === 'image' ? c.duration : m.duration;
        l.start = o.start ?? 0;
        l.in = l.start;
        l.out = Math.min(c.duration, l.start + (o.duration ?? dur));
      } else if (type === 'model') {
        const m = p.media.find((x) => x.id === o.mediaId);
        if (!m || m.kind !== 'model') throw new Error('Indique mediaId de un modelo 3D importado (.glb, .gltf u .obj: media_import).');
        l = newLayer('model', c, { name: o.name ?? m.path.split(/[\\/]/).pop(), mediaId: m.id });
        l.model = newModelOptions(m.model, c.height);
        // the anchor at the centre of the model's box, the box centred in the comp (Configuración del modelo)
        const b = m.model?.bbox;
        if (b) l.transform.anchor.v = modelToLayer(l.model.unit, [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2)).map((v) => Math.round(v * 1000) / 1000);
        l.material = newMaterial();
        if (o.start !== undefined) { l.start = o.start; l.in = o.start; }
        if (o.duration !== undefined) l.out = Math.min(c.duration, l.in + o.duration);
      } else if (type === 'comp') {
        const sub = findComp(comps(p), o.compId ?? '');
        if (sub.id === c.id || dependsOn(p, sub.id, c.id)) throw new Error('Una composición no puede contenerse a sí misma.');
        l = newLayer('comp', c, { w: sub.width, h: sub.height, name: o.name ?? sub.name, compId: sub.id, solid: { color: '#000000', width: sub.width, height: sub.height } });
        l.start = o.start ?? 0; l.in = l.start; l.out = Math.min(c.duration, l.start + (o.duration ?? sub.duration));
      } else if (type === 'sequence') {
        const s = p.settings;
        l = newLayer('sequence', c, { w: s.width, h: s.height, name: o.name ?? 'Secuencia (modo simple)', solid: { color: '#000000', width: s.width, height: s.height } });
      } else {
        l = newLayer(type, c, { w: o.width, h: o.height, name: o.name });
        if (type === 'solid' && o.color) l.solid!.color = o.color;
        if (type === 'text') {
          l.text!.text.v = o.text ?? 'Texto';
          if (o.size) l.text!.size.v = o.size;
          if (o.color) l.text!.fill.v = o.color;
          if (o.font) l.text!.font = o.font;
          l.name = o.name ?? (o.text ?? 'Texto').split('\n')[0].slice(0, 40);
        }
        if (o.start !== undefined) { l.start = o.start; l.in = o.start; }
        if (o.duration !== undefined) l.out = Math.min(c.duration, l.in + o.duration);
      }
      if (o.position) l.transform.position.v = coerce(l.transform.position.v, o.position) as number[];
      const idx = Math.max(0, Math.min(c.layers.length, (o.index ?? 1) - 1));
      c.layers.splice(idx, 0, l);
      return l;
    });
  },
  layerSet(e: Editor, compId: string, layerId: string, patch: Partial<Pick<Layer, 'name' | 'label' | 'start' | 'in' | 'out' | 'stretch' | 'hidden' | 'solo' | 'locked' | 'shy' | 'threeD' | 'motionBlur' | 'frameBlend' | 'blend'>> & { parent?: string | null; matte?: { layer: string; mode: MatteMode } | null; solidColor?: string; text?: Partial<{ font: string; weight: number; italic: boolean; leading: number; align: 'left' | 'center' | 'right'; allCaps: boolean; perChar3D: boolean; box: number[] | null; path: { mask: string; reverse?: boolean; perpendicular?: boolean; forceAlign?: boolean; open?: boolean; firstMargin?: number; lastMargin?: number } | null }>; light?: Partial<{ type: LightType; falloff: LightOptions['falloff']; castsShadows: boolean; envLayer: string | null }>; material?: Partial<{ castsShadows: Material['castsShadows']; acceptsShadows: boolean; acceptsLights: boolean }>; dof?: boolean }): Layer {
    return e.mutate('Propiedades de capa', (p) => {
      const c = findComp(comps(p), compId);
      const l = findLayer(c, layerId);
      const { parent, matte, solidColor, text, light, material, dof, ...rest } = patch;
      if (light) {
        if (!l.light) throw new Error(`«${l.name}» no es una capa de luz.`);
        if (light.type) { if (!LIGHT_TYPES.some((x) => x.id === light.type)) throw new Error(`Tipo de luz desconocido «${light.type}». Hay: ${LIGHT_TYPES.map((x) => x.id).join(', ')}.`); l.light.type = light.type; }
        if (light.falloff) l.light.falloff = light.falloff;
        if (light.castsShadows !== undefined) l.light.castsShadows = light.castsShadows;
        if (light.envLayer === null) delete l.light.envLayer;
        else if (light.envLayer !== undefined) {
          const src = findLayer(c, light.envLayer);
          if (src.type !== 'image' && src.type !== 'video') throw new Error(`El origen de la luz de entorno debe ser una capa de imagen o vídeo (HDRI); «${src.name}» es ${src.type}.`);
          l.light.envLayer = src.id;
          if (l.light.type !== 'environment') l.light.type = 'environment';
        }
      }
      if (material) {
        l.material ??= newMaterial();
        for (const [k, v] of Object.entries(material)) if (v !== undefined) (l.material as unknown as Record<string, unknown>)[k] = v;
        if (material.castsShadows && material.castsShadows !== 'off') l.threeD = true;
      }
      if (dof !== undefined) {
        if (!l.camera) throw new Error(`«${l.name}» no es una cámara.`);
        l.camera.dof ??= { on: false, focus: P(Number(l.camera.zoom.v) || defaultZoom(c.width)), aperture: P(25), blur: P(100) };
        l.camera.dof.on = dof;
      }
      // reversing (stretch changes sign): keep the same source span on screen, played backwards
      if (rest.stretch !== undefined && Math.sign(rest.stretch) !== Math.sign(l.stretch || 1) && rest.start === undefined) rest.start = l.in + l.out - l.start;
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) (l as unknown as Record<string, unknown>)[k] = v;
      if (rest.in !== undefined || rest.out !== undefined) { l.in = Math.max(0, Math.min(l.in, c.duration)); l.out = Math.max(l.in + 1 / c.fps, Math.min(l.out, c.duration)); }
      if (parent !== undefined) {
        if (parent === null) delete l.parent;
        else {
          const par = findLayer(c, parent);
          for (let q: Layer | undefined = par; q; q = q.parent ? c.layers.find((x) => x.id === q!.parent) : undefined) if (q.id === l.id) throw new Error('El primario crearía un ciclo.');
          l.parent = par.id;
        }
      }
      if (matte !== undefined) {
        if (matte === null) delete l.matte;
        else { const m = findLayer(c, matte.layer); if (m.id === l.id) throw new Error('Una capa no puede ser su propio mate.'); l.matte = { layer: m.id, mode: matte.mode }; m.hidden = true; }
      }
      if (solidColor && l.solid) l.solid.color = solidColor;
      if (text && l.text) {
        const { box, path, ...style } = text;
        for (const [k, v] of Object.entries(style)) if (v !== undefined) (l.text as unknown as Record<string, unknown>)[k] = v;
        // as in After Effects, per-character 3D makes the layer 3D
        if (style.perChar3D) l.threeD = true;
        if (box === null) delete l.text.box; else if (box) l.text.box = [Math.max(1, Number(box[0]) || 1), Math.max(0, Number(box[1]) || 0)];
        if (path === null) delete l.text.path;
        else if (path) {
          const m = l.masks.find((x) => x.id === path.mask || x.name === path.mask);
          if (!m) throw new Error(`«${l.name}» no tiene la máscara «${path.mask}»: dibújela primero (mask_add) y úsela como trazado.`);
          // like choosing it in After Effects: the mask becomes a path, it does not cut the text
          m.mode = 'none';
          const old = l.text.path;
          l.text.path = { mask: m.id, reverse: path.reverse ?? old?.reverse ?? false, perpendicular: path.perpendicular ?? old?.perpendicular ?? true, forceAlign: path.forceAlign ?? old?.forceAlign ?? false, open: path.open ?? old?.open ?? false, firstMargin: old?.firstMargin ?? P(0), lastMargin: old?.lastMargin ?? P(0) };
          if (path.firstMargin !== undefined) l.text.path.firstMargin.v = path.firstMargin;
          if (path.lastMargin !== undefined) l.text.path.lastMargin.v = path.lastMargin;
        }
      }
      if (l.threeD && l.transform.position.v.length < 3) l.transform.position.v.push(0);
      return l;
    });
  },
  layerDelete(e: Editor, compId: string, layerIds: string[]): void {
    e.mutate('Eliminar capas', (p) => {
      const c = findComp(comps(p), compId);
      const ids = new Set(layerIds.map((x) => findLayer(c, x).id));
      c.layers = c.layers.filter((l) => !ids.has(l.id));
      for (const l of c.layers) { if (l.parent && ids.has(l.parent)) delete l.parent; if (l.matte && ids.has(l.matte.layer)) delete l.matte; }
    });
  },
  layerReorder(e: Editor, compId: string, layerId: string, index: number): void {
    e.mutate('Reordenar capas', (p) => {
      const c = findComp(comps(p), compId);
      const l = findLayer(c, layerId);
      c.layers.splice(c.layers.indexOf(l), 1);
      c.layers.splice(Math.max(0, Math.min(c.layers.length, index - 1)), 0, l);
    });
  },
  layerDuplicate(e: Editor, compId: string, layerId: string): Layer {
    return e.mutate('Duplicar capa', (p) => {
      const c = findComp(comps(p), compId);
      const l = findLayer(c, layerId);
      const d = reId(JSON.parse(JSON.stringify(l)) as Layer);
      d.name = nextName(c, l.name);
      c.layers.splice(c.layers.indexOf(l), 0, d);
      return d;
    });
  },
  /** Splits a layer at t (Ctrl+Shift+D): the original ends at t, the copy starts there. */
  layerSplit(e: Editor, compId: string, layerId: string, t: number): Layer {
    return e.mutate('Dividir capa', (p) => {
      const c = findComp(comps(p), compId);
      const l = findLayer(c, layerId);
      if (t <= l.in + 1e-6 || t >= l.out - 1e-6) throw new Error('El instante debe estar dentro de la capa.');
      const d = reId(JSON.parse(JSON.stringify(l)) as Layer);
      l.out = t;
      d.in = t;
      d.name = nextName(c, l.name);
      c.layers.splice(c.layers.indexOf(l), 0, d);
      return d;
    });
  },
  /** Moves layers into a new composition and puts a composition layer in their place. */
  layerPrecompose(e: Editor, compId: string, layerIds: string[], name?: string): { comp: Comp; layer: Layer } {
    return e.mutate('Precomponer', (p) => {
      const c = findComp(comps(p), compId);
      const ls = layerIds.map((x) => findLayer(c, x));
      if (!ls.length) throw new Error('Seleccione al menos una capa.');
      const sub = newComp({ name: name ?? `${ls[0].name} Composición 1`, width: c.width, height: c.height, fps: c.fps, duration: c.duration, bg: c.bg, transparent: true });
      const top = Math.min(...ls.map((l) => c.layers.indexOf(l)));
      sub.layers = c.layers.filter((l) => ls.includes(l));
      c.layers = c.layers.filter((l) => !ls.includes(l));
      comps(p).push(sub);
      const layer = newLayer('comp', c, { w: sub.width, h: sub.height, name: sub.name, compId: sub.id, solid: { color: '#000000', width: sub.width, height: sub.height } });
      c.layers.splice(top, 0, layer);
      return { comp: sub, layer };
    });
  },

  /** Sets a property: static value, keyframes, expression, or clears keys. */
  propSet(e: Editor, compId: string, layerId: string, path: string, o: { value?: PVal | boolean; t?: number; keys?: KeyIn[]; expression?: string | null; clearKeys?: boolean; ease?: KeyIn['ease']; pathPoints?: boolean }): { path: string; value: PVal; keys: number; expression?: string } {
    return e.mutate('Cambiar propiedad', (p) => {
      const c = findComp(comps(p), compId);
      const l = findLayer(c, layerId);
      ensureOverride(p, l, path);
      if (canonPath(path) === 'transform.position' && isSeparated(l) && (o.value !== undefined || o.keys)) throw new Error(`«${l.name}» tiene las dimensiones de la posición separadas: anime positionX / positionY / positionZ (o únalas con separate_dimensions).`);
      const prop = resolveProp(l, path);
      // bezier paths keep their own length (keys may differ: shapes morph between them)
      const coerce = /\.path$/.test(canonPath(path)) ? (_cur: PVal, v: PVal | boolean) => pathValue(v as PVal, o.pathPoints) : coerceValue;
      if (o.clearKeys) { const v = keyedAt(prop, o.t ?? 0, isSpatial(canonPath(path))); delete prop.k; prop.v = v; }
      if (o.keys) {
        if (!o.clearKeys) delete prop.k;
        for (const k of o.keys) addKey(prop, k.t, coerce(prop.v, k.v), k);
        if (prop.k?.length) prop.v = prop.k[0].v;
      }
      if (o.value !== undefined) {
        const v = coerce(prop.v, o.value);
        if (o.t !== undefined) addKey(prop, o.t, v, { ease: o.ease });
        else if (prop.k?.length) throw new Error(`«${path}» tiene fotogramas clave: indique t para crear o cambiar la clave en ese instante, o clearKeys.`);
        else prop.v = v;
      }
      if (o.expression !== undefined) { if (o.expression === null || o.expression === '') delete prop.x; else { prop.x = o.expression; delete prop.xOff; } }
      return { path: canonPath(path), value: valueAt(prop, o.t ?? 0, { comp: c, layer: l, path: stablePath(l, path) }), keys: prop.k?.length ?? 0, expression: prop.x };
    });
  },
  keyframeRemove(e: Editor, compId: string, layerId: string, path: string, times: number[] | 'all'): number {
    return e.mutate('Eliminar fotogramas clave', (p) => {
      const c = findComp(comps(p), compId);
      const l = findLayer(c, layerId);
      const prop = resolveProp(l, path, false);
      const before = prop.k?.length ?? 0;
      if (times === 'all') { if (prop.k?.length) prop.v = prop.k[0].v; delete prop.k; return before; }
      prop.k = (prop.k ?? []).filter((k) => !times.some((t) => Math.abs(k.t - t) < 1e-3));
      if (!prop.k.length) delete prop.k;
      return before - (prop.k?.length ?? 0);
    });
  },
  keyframeEase(e: Editor, compId: string, layerId: string, path: string, kind: 'easy' | 'in' | 'out' | 'linear' | 'hold' | 'bezier', times: number[] | 'all' = 'all', handles?: { eo?: [number, number]; ei?: [number, number] }): number {
    return e.mutate('Interpolación de fotogramas clave', (p) => {
      const c = findComp(comps(p), compId);
      const prop = resolveProp(findLayer(c, layerId), path, false);
      const keys = (prop.k ?? []).filter((k) => times === 'all' || times.some((t) => Math.abs(k.t - t) < 1e-3));
      if (!keys.length) throw new Error(`«${path}» no tiene fotogramas clave en esos instantes.`);
      easeKeys(keys, kind, handles);
      return keys.length;
    });
  },
  /** Keyframe assistants: easy ease on everything, wiggler, smoother, reverse, bake expression, sequence layers. */
  keyframeAssist(e: Editor, compId: string, o: { kind: 'easyAll' | 'wiggler' | 'smoother' | 'reverse' | 'bake' | 'sequence' | 'exponentialScale' | 'sketch'; layers?: string[]; path?: string; from?: number; to?: number; frequency?: number; magnitude?: number; overlap?: number; tolerance?: number; seed?: number; points?: number[]; smoothing?: number }): string {
    return e.mutate('Asistente de fotogramas clave', (p) => {
      const c = findComp(comps(p), compId);
      const ls = (o.layers?.length ? o.layers : c.layers.map((l) => l.id)).map((x) => findLayer(c, x));
      if (o.kind === 'sequence') {
        const ov = o.overlap ?? 0;
        let t = ls[0]?.in ?? 0;
        for (const l of ls) { const shift = t - l.in; l.in += shift; l.out += shift; l.start += shift; t = l.out - ov; }
        return `${ls.length} capas en secuencia`;
      }
      if (o.kind === 'easyAll') {
        let n = 0;
        for (const l of ls) forEachProp(l, (prop) => { if (prop.k?.length) { easeKeys(prop.k, 'easy'); n += prop.k.length; } });
        return `${n} fotogramas clave con suavizado`;
      }
      if (!o.path) throw new Error('Indique path (propiedad).');
      let total = 0;
      for (const l of ls) {
        ensureOverride(p, l, o.path);
        const prop = resolveProp(l, o.path);
        const sp = stablePath(l, o.path);
        const env = { comp: c, layer: l, path: sp };
        const a = o.from ?? l.in, b = o.to ?? l.out;
        if (o.kind === 'wiggler') {
          const f = o.frequency ?? 5, mag = o.magnitude ?? 20, n = Math.max(2, Math.round((b - a) * f) + 1);
          const seed = (o.seed ?? 1) * 7919;
          const base = keyedAt(prop, a, isSpatial(sp));
          delete prop.k;
          for (let i = 0; i < n; i++) {
            const t = a + ((b - a) * i) / (n - 1);
            const cur = keyedAt({ v: base }, t);
            const r = (d: number) => rnd(seed + d * 131, i) * 2 - 1;
            const v = typeof cur === 'number' ? cur + r(0) * mag : Array.isArray(cur) ? cur.map((x, d) => x + r(d) * mag) : cur;
            setKey(prop, t, v, { i: 'bezier', eo: [...EASE_OUT], ei: [...EASE_IN] });
          }
          total += n;
        } else if (o.kind === 'smoother') {
          const ks = prop.k ?? [];
          if (ks.length < 3) continue;
          const tol = o.tolerance ?? 1;
          const keep: Key[] = [ks[0]];
          for (let i = 1; i < ks.length - 1; i++) {
            const prev = keep[keep.length - 1], next = ks[i + 1];
            const f = (ks[i].t - prev.t) / (next.t - prev.t);
            const lin = typeof prev.v === 'number' ? prev.v + ((next.v as number) - prev.v) * f : (prev.v as number[]).map((x, d) => x + ((next.v as number[])[d] - x) * f);
            const dev = typeof lin === 'number' ? Math.abs(lin - (ks[i].v as number)) : Math.hypot(...lin.map((x, d) => x - (ks[i].v as number[])[d]));
            if (dev > tol) keep.push(ks[i]);
          }
          keep.push(ks[ks.length - 1]);
          total += ks.length - keep.length;
          prop.k = keep;
          easeKeys(prop.k.slice(1, -1), 'easy');
        } else if (o.kind === 'exponentialScale') {
          // Exponential Scale: between two scale keys, one key per frame so the zoom feels constant (s0 · (s1/s0)^f)
          const ks = (prop.k ?? []).filter((k) => k.t >= a - 1e-6 && k.t <= b + 1e-6);
          if (ks.length < 2) throw new Error('Escala exponencial: hacen falta dos fotogramas clave de escala en el tramo.');
          const k0 = ks[0], k1 = ks[ks.length - 1], v0 = k0.v as number[], v1 = k1.v as number[];
          if (!Array.isArray(v0) || v0.some((x) => x <= 0) || v1.some((x) => x <= 0)) throw new Error('Escala exponencial: las escalas deben ser positivas.');
          prop.k = (prop.k ?? []).filter((k) => k.t < k0.t - 1e-6 || k.t > k1.t + 1e-6);
          const n = Math.max(2, Math.round((k1.t - k0.t) * c.fps) + 1);
          for (let i = 0; i < n; i++) { const f = i / (n - 1); setKey(prop, k0.t + (k1.t - k0.t) * f, v0.map((x, d) => x * Math.pow(v1[d] / x, f)), { i: 'linear' }); }
          total += n;
        } else if (o.kind === 'sketch') {
          // Motion Sketch: points [t, x, y, …] captured over time become position keys, thinned by «smoothing»
          const pts = o.points ?? [];
          if (pts.length < 6) throw new Error('Motion Sketch: pase al menos 2 puntos [t, x, y, …].');
          const tol = Math.max(0, o.smoothing ?? 2);
          const raw: Key[] = [];
          for (let i = 0; i + 2 < pts.length; i += 3) raw.push({ t: pts[i], v: [pts[i + 1], pts[i + 2], ...((prop.v as number[]).length > 2 ? [(prop.v as number[])[2]] : [])] });
          const keep: Key[] = [raw[0]];
          for (let i = 1; i < raw.length - 1; i++) {
            const pv = keep[keep.length - 1], nx = raw[i + 1], f = (raw[i].t - pv.t) / Math.max(1e-6, nx.t - pv.t);
            const lin = (pv.v as number[]).map((x, d) => x + ((nx.v as number[])[d] - x) * f);
            if (Math.hypot(lin[0] - (raw[i].v as number[])[0], lin[1] - (raw[i].v as number[])[1]) > tol) keep.push(raw[i]);
          }
          keep.push(raw[raw.length - 1]);
          delete prop.k;
          for (const k of keep) setKey(prop, k.t, k.v, { i: 'bezier', eo: [...EASE_OUT], ei: [...EASE_IN] });
          total += keep.length;
        } else if (o.kind === 'reverse') {
          const ks = (prop.k ?? []).filter((k) => k.t >= a - 1e-6 && k.t <= b + 1e-6);
          const vals = ks.map((k) => k.v).reverse();
          ks.forEach((k, i) => { k.v = vals[i]; });
          total += ks.length;
        } else if (o.kind === 'bake') {
          const vals: [number, PVal][] = [];
          for (let f = Math.round(a * c.fps); f <= Math.round(b * c.fps); f++) vals.push([f / c.fps, valueAt(prop, f / c.fps, env)]);
          delete prop.x;
          delete prop.k;
          for (const [t, v] of vals) setKey(prop, t, v, { i: 'linear' });
          total += vals.length;
        }
      }
      return `${total} fotogramas clave`;
    });
  },

  /** Keyframe Velocity (After Effects' dialog, Ctrl+Shift+K): read, or set, incoming / outgoing speed (units per
   *  second; along the path for spatial properties) and influence (%) of keys, and the Continuous lock. */
  keyframeVelocity(e: Editor, compId: string, layerId: string, path: string, o: { times?: number[]; set?: { in?: SideIn; out?: SideIn; continuous?: boolean } } = {}) {
    const run = (p: Project) => {
      const c = findComp(comps(p), compId);
      const l = findLayer(c, layerId);
      const prop = resolveProp(l, path, false);
      const sp = isSpatial(canonPath(path));
      const ks = prop.k ?? [];
      if (!ks.length) throw new Error(`«${path}» no tiene fotogramas clave.`);
      const idxs = ks.map((_, i) => i).filter((i) => !o.times || o.times.some((t) => Math.abs(ks[i].t - t) < 1e-3));
      if (!idxs.length) throw new Error(`«${path}» no tiene fotogramas clave en esos instantes (los hay en ${ks.map((k) => k.t).join(', ')}).`);
      if (o.set) for (const i of idxs) setKeyVelocity(prop, i, sp, o.set);
      return idxs.map((i) => keyVelocity(prop, i, sp));
    };
    if (!o.set) return run(e.project);
    return e.mutate('Velocidad de fotograma clave', run);
  },
  /** Keyframe interpolation buttons of the graph editor: easy (F9), in (Shift+F9), out (Ctrl+Shift+F9), linear, hold, auto (auto-bezier). */
  keyframeInterp(e: Editor, compId: string, layerId: string, path: string, kind: EaseKind, times: number[] | 'all' = 'all'): number {
    return e.mutate('Interpolación de fotogramas clave', (p) => {
      const c = findComp(comps(p), compId);
      const prop = resolveProp(findLayer(c, layerId), path, false);
      const ks = prop.k ?? [];
      const idxs = ks.map((_, i) => i).filter((i) => times === 'all' || times.some((t) => Math.abs(ks[i].t - t) < 1e-3));
      if (!idxs.length) throw new Error(`«${path}» no tiene fotogramas clave en esos instantes.`);
      easeKeysAE(prop, idxs, kind, isSpatial(canonPath(path)));
      return idxs.length;
    });
  },
  /** Separar dimensiones of Position (on) or join X / Y / Z back (off); the motion stays the same. */
  separateDimensions(e: Editor, compId: string, layerId: string, on: boolean): { separated: boolean; keys: Record<string, number> } {
    return e.mutate(on ? 'Separar dimensiones' : 'Unir dimensiones', (p) => {
      const l = findLayer(findComp(comps(p), compId), layerId);
      if (on) separatePosition(l); else joinPosition(l);
      const tr = l.transform;
      return { separated: isSeparated(l), keys: (on ? { positionX: tr.positionX?.k?.length ?? 0, positionY: tr.positionY?.k?.length ?? 0, positionZ: tr.positionZ?.k?.length ?? 0 } : { position: tr.position.k?.length ?? 0 }) as Record<string, number> };
    });
  },

  effectAdd(e: Editor, compId: string, layerId: string, fx: string, values: Record<string, PVal | boolean> = {}): { id: string; name: string } {
    return e.mutate('Añadir efecto', (p) => {
      const c = findComp(comps(p), compId);
      const l = findLayer(c, layerId);
      const [w, h] = layerSize(p, c, l);
      const inst = newFx(fx, w, h, layerRefs(c, l, fx, values));
      const same = l.effects.filter((f) => f.fx === inst.fx).length;
      if (same) inst.name = `${inst.name} ${same + 1}`;
      l.effects.push(inst);
      return { id: inst.id, name: inst.name };
    });
  },
  effectSet(e: Editor, compId: string, layerId: string, fxId: string, o: { on?: boolean; name?: string; values?: Record<string, PVal | boolean>; index?: number }): void {
    e.mutate('Cambiar efecto', (p) => {
      const c = findComp(comps(p), compId);
      const l = findLayer(c, layerId);
      const fx = pick(l.effects, fxId, 'el efecto');
      if (o.on !== undefined) fx.on = o.on;
      if (o.name) fx.name = o.name;
      for (const [k, v] of Object.entries(layerRefs(c, l, fx.fx, o.values ?? {}))) {
        const prop = fx.params[k];
        if (!prop) throw new Error(`«${fx.name}» no tiene «${k}». Tiene: ${Object.keys(fx.params).join(', ')}.`);
        if (prop.k?.length) throw new Error(`«${k}» tiene fotogramas clave: use prop_set con t.`);
        prop.v = coerce(prop.v, v);
      }
      if (o.index) { l.effects.splice(l.effects.indexOf(fx), 1); l.effects.splice(Math.max(0, o.index - 1), 0, fx); }
    });
  },
  /** Puppet tool: add a pin at a layer point, remove one, or change the mesh (density, expansion, on). */
  puppetSet(e: Editor, compId: string, layerId: string, o: { add?: { at: number[]; name?: string }; remove?: string; on?: boolean; density?: number; expansion?: number }): { pin?: { id: string; name: string } } {
    return e.mutate('Marioneta', (p) => {
      const l = findLayer(findComp(comps(p), compId), layerId);
      if (l.type === 'camera' || l.type === 'light' || l.type === 'null' || l.type === 'audio' || l.type === 'adjustment') throw new Error(`«${l.name}» no se dibuja: no admite pines de marioneta.`);
      l.puppet ??= { on: true, density: 12, expansion: 3, pins: [] };
      const pp = l.puppet;
      if (o.on !== undefined) pp.on = o.on;
      if (o.density !== undefined) pp.density = Math.max(3, Math.min(200, o.density));
      if (o.expansion !== undefined) pp.expansion = Math.max(0, Math.min(200, o.expansion));
      if (o.remove) {
        const pin = pp.pins.find((x) => x.id === o.remove || x.name === o.remove);
        if (!pin) throw new Error(`No existe el pin «${o.remove}».`);
        pp.pins = pp.pins.filter((x) => x !== pin);
      }
      if (o.add) {
        const at = [Number(o.add.at[0]) || 0, Number(o.add.at[1]) || 0];
        const pin = { id: uid('p'), name: o.add.name ?? `Pin ${pp.pins.length + 1}`, rest: at, position: P(at) };
        pp.pins.push(pin);
        return { pin: { id: pin.id, name: pin.name } };
      }
      return {};
    });
  },
  /** Adds or changes a layer style (one per kind); on false switches it off, remove deletes it. */
  styleSet(e: Editor, compId: string, layerId: string, kind: string, o: { on?: boolean; remove?: boolean; values?: Record<string, PVal | boolean> } = {}): { id: string; name: string } | null {
    return e.mutate('Estilo de capa', (p) => {
      const l = findLayer(findComp(comps(p), compId), layerId);
      if (l.type === 'camera' || l.type === 'light' || l.type === 'null' || l.type === 'audio') throw new Error(`«${l.name}» no se dibuja: no admite estilos de capa.`);
      const d = styleDef(kind);
      l.styles ??= [];
      let st = l.styles.find((x) => x.fx === d.id);
      if (o.remove) { l.styles = l.styles.filter((x) => x !== st); return null; }
      if (!st) { st = newStyle(d.id, o.values ?? {}); l.styles.push(st); }
      else for (const [k, v] of Object.entries(o.values ?? {})) {
        const prop = st.params[k];
        if (!prop) throw new Error(`«${st.name}» no tiene «${k}». Tiene: ${Object.keys(st.params).join(', ')}.`);
        if (prop.k?.length) throw new Error(`«${k}» tiene fotogramas clave: use prop_set con t.`);
        prop.v = coerce(prop.v, v);
      }
      if (o.on !== undefined) st.on = o.on;
      return { id: st.id, name: st.name };
    });
  },
  effectRemove(e: Editor, compId: string, layerId: string, fxId: string): void {
    e.mutate('Quitar efecto', (p) => {
      const l = findLayer(findComp(comps(p), compId), layerId);
      const fx = pick(l.effects, fxId, 'el efecto');
      l.effects = l.effects.filter((f) => f !== fx);
    });
  },

  maskAdd(e: Editor, compId: string, layerId: string, o: { shape?: 'rect' | 'ellipse' | 'path'; x?: number; y?: number; width?: number; height?: number; path?: number[]; bezier?: boolean; mode?: Mask['mode']; feather?: number; inverted?: boolean; expansion?: number; opacity?: number; name?: string }): Mask {
    return e.mutate('Nueva máscara', (p) => {
      const c = findComp(comps(p), compId);
      const l = findLayer(c, layerId);
      const [w, h] = layerSize(p, c, l);
      const box = { x: o.x ?? w * 0.25, y: o.y ?? h * 0.25, w: o.width ?? w * 0.5, h: o.height ?? h * 0.5 };
      const path = o.shape === 'path' ? toBezier(o.path ?? [], o.bezier) : o.shape === 'ellipse' ? ellipsePath(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2) : rectPath(box.x, box.y, box.w, box.h);
      if (path.length < 18) throw new Error('Un trazado de máscara necesita al menos 3 puntos.');
      const m = newMask(path, o.name ?? `Máscara ${l.masks.length + 1}`);
      if (o.mode) m.mode = o.mode;
      if (o.feather !== undefined) m.feather.v = o.feather;
      if (o.inverted) m.inverted = true;
      if (o.expansion !== undefined) m.expansion.v = o.expansion;
      if (o.opacity !== undefined) m.opacity.v = o.opacity;
      l.masks.push(m);
      return m;
    });
  },
  /** Smart Mask Interpolation: keyframes between consecutive mask-path keys in [from, to] (all by default) so
   *  the outline morphs smoothly even with different vertex counts. The original keys keep their paths: they
   *  hold until the first in-between, and the last in-between holds until the next key (the vertex counts
   *  change only there). The in-betweens follow the original pair's temporal ease. */
  maskInterpolate(e: Editor, compId: string, layerId: string, maskId: string, o: SmartMaskOptions & { from?: number; to?: number } = {}): { pairs: number; keys: number } {
    return e.mutate('Interpolación inteligente de máscaras', (p) => {
      const c = findComp(comps(p), compId), l = findLayer(c, layerId), m = pick(l.masks, maskId, 'la máscara');
      const prop = m.path;
      const keys = (prop.k ?? []).filter((k) => k.t >= (o.from ?? -Infinity) - 1e-6 && k.t <= (o.to ?? Infinity) + 1e-6);
      if (keys.length < 2) throw new Error('Seleccione al menos 2 fotogramas clave consecutivos de trazado de máscara para interpolar entre ellos.');
      const rate = (o.rate ?? c.fps) * (o.fields ? 2 : 1);
      let added = 0;
      for (let i = 0; i + 1 < keys.length; i++) {
        const k0 = keys[i], k1 = keys[i + 1];
        const pair = smartMaskPair(k0.v as number[], k1.v as number[], true, o);
        // in-betweens strictly between the two keys, at the keyframe rate
        const times: number[] = [];
        for (let n = 1; k0.t + n / rate < k1.t - 1e-6; n++) times.push(k0.t + n / rate);
        if (!times.length) continue;
        const k0copy = { ...k0 };
        const made = times.map((t) => setKey(prop, t, pair.at(segmentProgress(k0copy, k1, t)), { i: 'linear' }));
        k0.i = 'hold'; delete k0.eo;
        made[made.length - 1].i = 'hold';
        delete k1.ei;
        added += made.length;
      }
      return { pairs: keys.length - 1, keys: added };
    });
  },
  maskSet(e: Editor, compId: string, layerId: string, maskId: string, o: { mode?: Mask['mode']; inverted?: boolean; name?: string; remove?: boolean }): void {
    e.mutate('Cambiar máscara', (p) => {
      const l = findLayer(findComp(comps(p), compId), layerId);
      const m = pick(l.masks, maskId, 'la máscara');
      if (o.remove) { l.masks = l.masks.filter((x) => x !== m); return; }
      if (o.mode) m.mode = o.mode;
      if (o.inverted !== undefined) m.inverted = o.inverted;
      if (o.name) m.name = o.name;
    });
  },

  /** Adds a shape to a shape layer (or creates the layer when layerId is omitted). */
  shapeAdd(e: Editor, compId: string, layerId: string | undefined, o: { kind: ShapeKind; width?: number; height?: number; color?: string | null; stroke?: string; strokeWidth?: number; points?: number; innerRadius?: number; roundness?: number; path?: number[]; bezier?: boolean; closed?: boolean; position?: number[]; gradient?: { type?: 'linear' | 'radial'; colors: string[]; start?: number[]; end?: number[] }; trim?: { start?: number; end?: number; offset?: number }; repeater?: { copies: number; position?: number[]; scale?: number[]; rotation?: number; startOpacity?: number; endOpacity?: number }; wiggle?: { size?: number; detail?: number; speed?: number; phase?: number; seed?: number; smooth?: boolean }; zigzag?: { size?: number; ridges?: number; smooth?: boolean }; name?: string; dash?: number[]; pucker?: { amount?: number } | null; roundCorners?: { radius?: number } | null; twist?: { angle?: number; center?: number[] } | null; offset?: { amount?: number; join?: 'miter' | 'round' | 'bevel'; miterLimit?: number } | null; mergeMode?: MergeMode; strokeGradient?: { type?: 'linear' | 'radial'; colors: string[]; start?: number[]; end?: number[] } | null; contours?: number[][]; fillRule?: 'nonzero' | 'evenodd'; cap?: 'butt' | 'round' | 'square'; join?: 'miter' | 'round' | 'bevel'; fillOpacity?: number; strokeOpacity?: number }): { layer: Layer; shape: ShapeItem } {
    return e.mutate('Nueva forma', (p) => {
      const c = findComp(comps(p), compId);
      let l: Layer;
      if (layerId) { l = findLayer(c, layerId); if (l.type !== 'shape') throw new Error(`«${l.name}» no es una capa de forma.`); }
      else { l = newLayer('shape', c, { name: o.name ?? 'Capa de forma' }); c.layers.unshift(l); }
      const s = newShape(o.kind, { w: o.width, h: o.height, color: o.color ?? undefined, stroke: o.stroke, strokeWidth: o.strokeWidth, points: o.points, name: o.name, path: o.path ? toBezier(o.path, o.bezier) : undefined, closed: o.closed });
      if (o.color === null) s.fill.on = false;
      if (o.innerRadius !== undefined) s.innerRadius.v = o.innerRadius;
      if (o.roundness !== undefined) s.roundness.v = o.roundness;
      if (o.position) s.transform.position.v = [o.position[0], o.position[1]];
      if (o.dash) s.stroke.dash = o.dash;
      // compound paths: more closed contours filled with the first by the fill rule
      if (o.contours?.length) s.contours = o.contours.map((c) => toBezier(c, o.bezier));
      if (o.fillRule) s.fill.rule = o.fillRule;
      if (o.cap) s.stroke.cap = o.cap;
      if (o.join) s.stroke.join = o.join;
      if (o.fillOpacity !== undefined) s.fill.opacity.v = o.fillOpacity;
      if (o.strokeOpacity !== undefined) s.stroke.opacity.v = o.strokeOpacity;
      if (o.gradient) {
        const [w] = s.size.v;
        s.gradient = { type: o.gradient.type ?? 'linear', colors: o.gradient.colors, start: P(o.gradient.start ?? [-w / 2, 0]), end: P(o.gradient.end ?? [w / 2, 0]) };
        s.fill.on = true;
      }
      if (o.trim) s.trim = { start: P(o.trim.start ?? 0), end: P(o.trim.end ?? 100), offset: P(o.trim.offset ?? 0) };
      if (o.repeater) s.repeater = { copies: P(o.repeater.copies), offset: 0, position: P(o.repeater.position ?? [100, 0]), scale: P(o.repeater.scale ?? [100, 100]), rotation: P(o.repeater.rotation ?? 0), startOpacity: P(o.repeater.startOpacity ?? 100), endOpacity: P(o.repeater.endOpacity ?? 100) };
      if (o.kind === 'merge') { s.merge = { mode: o.mergeMode ?? 'add' }; s.fill.on = o.color !== null; }
      setModifiers(s, { ...o, pucker: o.pucker ?? undefined, roundCorners: o.roundCorners ?? undefined, twist: o.twist ?? undefined, offset: o.offset ?? undefined, strokeGradient: o.strokeGradient ?? undefined });
      l.shapes!.unshift(s); // like After Effects: a new shape goes on top of the existing ones
      return { layer: l, shape: s };
    });
  },
  /** Changes the structure of a shape: fill/stroke on-off, caps, dashes, trim paths, repeater, gradient (null removes them). */
  shapeSet(e: Editor, compId: string, layerId: string, shapeId: string, o: { name?: string; fill?: boolean; stroke?: boolean; cap?: 'butt' | 'round' | 'square'; join?: 'miter' | 'round' | 'bevel'; dash?: number[]; closed?: boolean; toPath?: boolean; trim?: { start?: number; end?: number; offset?: number } | null; repeater?: { copies?: number; position?: number[]; scale?: number[]; rotation?: number; startOpacity?: number; endOpacity?: number } | null; gradient?: { type?: 'linear' | 'radial'; colors: string[]; start?: number[]; end?: number[] } | null; wiggle?: { size?: number; detail?: number; speed?: number; phase?: number; seed?: number; smooth?: boolean } | null; zigzag?: { size?: number; ridges?: number; smooth?: boolean } | null; pucker?: { amount?: number } | null; roundCorners?: { radius?: number } | null; twist?: { angle?: number; center?: number[] } | null; offset?: { amount?: number; join?: 'miter' | 'round' | 'bevel'; miterLimit?: number } | null; mergeMode?: MergeMode; strokeGradient?: { type?: 'linear' | 'radial'; colors: string[]; start?: number[]; end?: number[] } | null }): ShapeItem {
    return e.mutate('Cambiar forma', (p) => {
      const cc = findComp(comps(p), compId);
      const l = findLayer(cc, layerId);
      const s = pick(l.shapes ?? [], shapeId, 'la forma');
      if (o.toPath && s.kind !== 'path') {
        // like After Effects' «Convert to Bezier Path»: the current outline becomes editable vertices
        const pts = baseOutline(cc, l, s, 0).pts;
        const step = Math.max(1, Math.floor(pts.length / 2 / 48));
        const keep: number[] = [];
        for (let i = 0; i < pts.length / 2; i += step) keep.push(pts[i * 2], pts[i * 2 + 1]);
        s.kind = 'path'; s.closed = true; s.path = P(toBezier(keep)); delete s.path.k;
      }
      if (o.name) s.name = o.name;
      if (o.fill !== undefined) s.fill.on = o.fill;
      if (o.stroke !== undefined) s.stroke.on = o.stroke;
      if (o.cap) s.stroke.cap = o.cap;
      if (o.join) s.stroke.join = o.join;
      if (o.dash) s.stroke.dash = o.dash;
      if (o.closed !== undefined) s.closed = o.closed;
      if (o.trim === null) delete s.trim;
      else if (o.trim) { s.trim ??= { start: P(0), end: P(100), offset: P(0) }; if (o.trim.start !== undefined) s.trim.start.v = o.trim.start; if (o.trim.end !== undefined) s.trim.end.v = o.trim.end; if (o.trim.offset !== undefined) s.trim.offset.v = o.trim.offset; }
      if (o.repeater === null) delete s.repeater;
      else if (o.repeater) {
        s.repeater ??= { copies: P(3), offset: 0, position: P([100, 0]), scale: P([100, 100]), rotation: P(0), startOpacity: P(100), endOpacity: P(100) };
        const r = s.repeater, q = o.repeater;
        if (q.copies !== undefined) r.copies.v = q.copies;
        if (q.position) r.position.v = q.position;
        if (q.scale) r.scale.v = q.scale;
        if (q.rotation !== undefined) r.rotation.v = q.rotation;
        if (q.startOpacity !== undefined) r.startOpacity.v = q.startOpacity;
        if (q.endOpacity !== undefined) r.endOpacity.v = q.endOpacity;
      }
      if (o.gradient === null) delete s.gradient;
      else if (o.gradient) { const w = (s.size.v[0] ?? 200) / 2; s.gradient = { type: o.gradient.type ?? 'linear', colors: o.gradient.colors, start: P(o.gradient.start ?? [-w, 0]), end: P(o.gradient.end ?? [w, 0]) }; s.fill.on = true; }
      if (o.wiggle === null) delete s.wiggle;
      if (o.zigzag === null) delete s.zigzag;
      for (const k of ['pucker', 'roundCorners', 'twist', 'offset'] as const) if (o[k] === null) delete s[k];
      if (o.strokeGradient === null) delete s.stroke.gradient;
      if (o.mergeMode) { if (s.kind !== 'merge') throw new Error(`«${s.name}» no es un «Combinar trazados».`); s.merge = { mode: o.mergeMode }; }
      setModifiers(s, { wiggle: o.wiggle ?? undefined, zigzag: o.zigzag ?? undefined, pucker: o.pucker ?? undefined, roundCorners: o.roundCorners ?? undefined, twist: o.twist ?? undefined, offset: o.offset ?? undefined, strokeGradient: o.strokeGradient ?? undefined });
      return s;
    });
  },
  shapeRemove(e: Editor, compId: string, layerId: string, shapeId: string): void {
    e.mutate('Quitar forma', (p) => {
      const l = findLayer(findComp(comps(p), compId), layerId);
      const s = pick(l.shapes ?? [], shapeId, 'la forma');
      l.shapes = (l.shapes ?? []).filter((x) => x !== s);
    });
  },

  textAnimatorAdd(e: Editor, compId: string, layerId: string, o: { name?: string; props: Partial<Record<keyof TextAnimator['props'], PVal>>; selector?: Partial<{ type: 'range' | 'wiggly'; start: number; end: number; offset: number; amount: number; basedOn: Selector['basedOn']; shape: 'square' | 'rampUp' | 'rampDown' | 'triangle' | 'round' | 'smooth'; mode: 'add' | 'subtract' | 'intersect'; randomize: boolean; seed: number; maxAmount: number; minAmount: number; speed: number; correlation: number }> | null }): TextAnimator {
    return e.mutate('Animador de texto', (p) => {
      const l = findLayer(findComp(comps(p), compId), layerId);
      if (!l.text) throw new Error(`«${l.name}» no es una capa de texto.`);
      const an: TextAnimator = { id: uid('a'), name: o.name ?? `Animador ${l.text.animators.length + 1}`, props: {}, selectors: [] };
      for (const [k, v] of Object.entries(o.props)) {
        if (!['position', 'scale', 'rotation', 'rotationY', 'rotationX', 'opacity', 'fill', 'stroke', 'tracking', 'blur', 'skew', 'charOffset', 'frontColor', 'bevelColor', 'sideColor', 'backColor'].includes(k)) throw new Error(`Propiedad de animador desconocida «${k}».`);
        (an.props as Record<string, Prop>)[k] = P(coerce(animDefault(k), v as PVal));
      }
      if (o.selector !== null) an.selectors.push(makeSelector(o.selector ?? {}));
      l.text.animators.push(an);
      return an;
    });
  },
  textAnimatorRemove(e: Editor, compId: string, layerId: string, animatorId: string): void {
    e.mutate('Quitar animador', (p) => {
      const l = findLayer(findComp(comps(p), compId), layerId);
      const an = pick(l.text?.animators ?? [], animatorId, 'el animador');
      l.text!.animators = l.text!.animators.filter((a) => a !== an);
    });
  },
  // paint tools (paint.ts)
  ...PAINT_OPS,
  // data files (data-ops.ts)
  ...DATA_OPS,
  // text to shapes / masks, auto-trace, variable font axes (vectores.ts)
  ...VECTOR_OPS,
  // 3D model layers (model3d-ops.ts)
  ...MODEL_OPS,
  // extruded text and shapes: Opciones de geometría (extrude-ops.ts)
  ...EXTRUDE_OPS,
  // Character / Paragraph attributes, text orientation, editing with styled runs (texto-ops.ts)
  ...TEXT_OPS,
  // Roto Brush & Refine Edge strokes, span and freeze (roto.ts; the propagation itself: roto-analyze.ts)
  ...ROTO_OPS,
  // guide layers, crop comp, region of interest, protected regions, RotoBezier, mask feather, wiggle transform (capas-ops.ts)
  ...CAPAS_OPS,
};

export function makeSelector(s: Partial<{ type: 'range' | 'wiggly'; start: number; end: number; offset: number; amount: number; basedOn: Selector['basedOn']; shape: 'square' | 'rampUp' | 'rampDown' | 'triangle' | 'round' | 'smooth'; mode: 'add' | 'subtract' | 'intersect'; randomize: boolean; seed: number; maxAmount: number; minAmount: number; speed: number; correlation: number }>): Selector {
  if (s.type === 'wiggly') return { type: 'wiggly', maxAmount: P(s.maxAmount ?? 100), minAmount: P(s.minAmount ?? -100), speed: P(s.speed ?? 2), correlation: P(s.correlation ?? 50), basedOn: s.basedOn ?? 'chars', mode: s.mode ?? 'intersect', seed: s.seed ?? 1 };
  return { type: 'range', start: P(s.start ?? 0), end: P(s.end ?? 100), offset: P(s.offset ?? 0), amount: P(s.amount ?? 100), basedOn: s.basedOn ?? 'chars', shape: s.shape ?? 'square', mode: s.mode ?? 'add', randomize: s.randomize ?? false, seed: s.seed ?? 1 };
}

/** Adds or updates the path modifiers of a shape (wiggle paths, zigzag). */
function setModifiers(s: ShapeItem, o: { wiggle?: { size?: number; detail?: number; speed?: number; phase?: number; seed?: number; smooth?: boolean }; zigzag?: { size?: number; ridges?: number; smooth?: boolean }; pucker?: { amount?: number }; roundCorners?: { radius?: number }; twist?: { angle?: number; center?: number[] }; offset?: { amount?: number; join?: 'miter' | 'round' | 'bevel'; miterLimit?: number }; strokeGradient?: { type?: 'linear' | 'radial'; colors: string[]; start?: number[]; end?: number[] } }) {
  if (o.pucker) { s.pucker ??= { amount: P(50) }; if (o.pucker.amount !== undefined) s.pucker.amount.v = o.pucker.amount; }
  if (o.roundCorners) { s.roundCorners ??= { radius: P(20) }; if (o.roundCorners.radius !== undefined) s.roundCorners.radius.v = Math.max(0, o.roundCorners.radius); }
  if (o.twist) { s.twist ??= { angle: P(90), center: P([0, 0]) }; if (o.twist.angle !== undefined) s.twist.angle.v = o.twist.angle; if (o.twist.center) s.twist.center.v = [o.twist.center[0], o.twist.center[1]]; }
  if (o.offset) {
    s.offset ??= { amount: P(10), join: 'miter', miterLimit: 4 };
    if (o.offset.amount !== undefined) s.offset.amount.v = o.offset.amount;
    if (o.offset.join) s.offset.join = o.offset.join;
    if (o.offset.miterLimit !== undefined) s.offset.miterLimit = Math.max(1, o.offset.miterLimit);
  }
  if (o.strokeGradient) {
    const w = (s.size.v[0] ?? 200) / 2, q = o.strokeGradient;
    s.stroke.gradient = { type: q.type ?? 'linear', colors: q.colors, start: P(q.start ?? [-w, 0]), end: P(q.end ?? [w, 0]) };
    s.stroke.on = true;
  }
  if (o.wiggle) {
    s.wiggle ??= { size: P(20), detail: P(8), speed: P(2), phase: P(0), seed: 1, smooth: true };
    const w = s.wiggle, q = o.wiggle;
    if (q.size !== undefined) w.size.v = q.size;
    if (q.detail !== undefined) w.detail.v = Math.max(2, Math.round(q.detail));
    if (q.speed !== undefined) w.speed.v = q.speed;
    if (q.phase !== undefined) w.phase.v = q.phase;
    if (q.seed !== undefined) w.seed = q.seed;
    if (q.smooth !== undefined) w.smooth = q.smooth;
  }
  if (o.zigzag) {
    s.zigzag ??= { size: P(10), ridges: P(12), smooth: false };
    const z = s.zigzag, q = o.zigzag;
    if (q.size !== undefined) z.size.v = q.size;
    if (q.ridges !== undefined) z.ridges.v = Math.max(1, Math.round(q.ridges));
    if (q.smooth !== undefined) z.smooth = q.smooth;
  }
}

function addKey(prop: Prop, t: number, v: PVal, k: { ease?: KeyIn['ease']; eo?: [number, number]; ei?: [number, number] }) {
  const key = setKey(prop, Math.max(0, t), v);
  const kind = k.ease ?? (k.eo || k.ei ? 'bezier' : undefined);
  if (kind) easeKeys([key], kind, { eo: k.eo, ei: k.ei });
}

function pathValue(v: PVal, points = false): number[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('Un trazado es una lista de números.');
  if (points) { if (v.length < 4 || v.length % 2) throw new Error('Con path_points el trazado es [x, y, x, y…] (al menos 2 puntos).'); return toBezier(v); }
  if (v.length % 6) throw new Error('Un trazado bezier lleva 6 números por vértice (x, y, entradaX, entradaY, salidaX, salidaY); para dar solo puntos [x, y…] use path_points.');
  return v;
}

/** [x, y, x, y…] points, or (bezier = true) a flat bezier [x, y, inX, inY, outX, outY…] → flat bezier. */
function toBezier(pts: number[], bezier = false): number[] {
  if (bezier) { if (pts.length % 6) throw new Error('Un trazado bezier lleva 6 números por vértice: x, y, entradaX, entradaY, salidaX, salidaY.'); return pts; }
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) out.push(pts[i], pts[i + 1], 0, 0, 0, 0);
  return out;
}

export function forEachProp(l: Layer, fn: (p: Prop, path: string) => void) {
  for (const [k, v] of Object.entries(l.transform)) fn(v as Prop, `transform.${k}`);
  for (const fx of l.effects) for (const [k, v] of Object.entries(fx.params)) fn(v, `effects.${fx.id}.${k}`);
  for (const fx of l.effects) if (fx.strokes) forEachStrokeProp(fx, fn);
  for (const m of l.masks) for (const k of ['path', 'feather', 'opacity', 'expansion'] as const) fn(m[k], `masks.${m.id}.${k}`);
  if (l.text) {
    for (const k of ['text', 'size', 'fill', 'stroke', 'strokeWidth', 'tracking'] as const) fn(l.text[k] as Prop, `text.${k}`);
    if (l.text.path) { fn(l.text.path.firstMargin, 'text.path.firstMargin'); fn(l.text.path.lastMargin, 'text.path.lastMargin'); }
    for (const [k, v] of Object.entries(l.text.axes ?? {})) fn(v, `text.axes.${k}`);
    for (const an of l.text.animators) {
      for (const [k, v] of Object.entries(an.props)) if (v) fn(v, `text.animators.${an.id}.props.${k}`);
      an.selectors.forEach((s, i) => { for (const [k, v] of Object.entries(s)) if (v && typeof v === 'object' && 'v' in v) fn(v as Prop, `text.animators.${an.id}.selectors.${i}.${k}`); });
    }
  }
  for (const s of l.shapes ?? []) {
    for (const k of ['size', 'roundness', 'points', 'outerRadius', 'innerRadius', 'path'] as const) fn(s[k], `shapes.${s.id}.${k}`);
    fn(s.fill.color, `shapes.${s.id}.fill.color`); fn(s.fill.opacity, `shapes.${s.id}.fill.opacity`);
    fn(s.stroke.color, `shapes.${s.id}.stroke.color`); fn(s.stroke.width, `shapes.${s.id}.stroke.width`); fn(s.stroke.opacity, `shapes.${s.id}.stroke.opacity`);
    for (const [k, v] of Object.entries(s.transform)) fn(v as Prop, `shapes.${s.id}.transform.${k}`);
    if (s.trim) for (const [k, v] of Object.entries(s.trim)) fn(v as Prop, `shapes.${s.id}.trim.${k}`);
    if (s.repeater) for (const [k, v] of Object.entries(s.repeater)) if (v && typeof v === 'object' && 'v' in v) fn(v as Prop, `shapes.${s.id}.repeater.${k}`);
    if (s.gradient) { fn(s.gradient.start, `shapes.${s.id}.gradient.start`); fn(s.gradient.end, `shapes.${s.id}.gradient.end`); }
    if (s.wiggle) for (const k of ['size', 'detail', 'speed', 'phase'] as const) fn(s.wiggle[k], `shapes.${s.id}.wiggle.${k}`);
    if (s.zigzag) for (const k of ['size', 'ridges'] as const) fn(s.zigzag[k], `shapes.${s.id}.zigzag.${k}`);
    if (s.pucker) fn(s.pucker.amount, `shapes.${s.id}.pucker.amount`);
    if (s.roundCorners) fn(s.roundCorners.radius, `shapes.${s.id}.roundCorners.radius`);
    if (s.twist) { fn(s.twist.angle, `shapes.${s.id}.twist.angle`); fn(s.twist.center, `shapes.${s.id}.twist.center`); }
    if (s.offset) fn(s.offset.amount, `shapes.${s.id}.offset.amount`);
    if (s.stroke.gradient) { fn(s.stroke.gradient.start, `shapes.${s.id}.stroke.gradient.start`); fn(s.stroke.gradient.end, `shapes.${s.id}.stroke.gradient.end`); }
    if (s.wiggleTransform) for (const k of ['speed', 'correlation', 'temporalPhase', 'spatialPhase', 'anchor', 'position', 'scale', 'rotation'] as const) fn(s.wiggleTransform[k], `shapes.${s.id}.wiggleTransform.${k}`);
  }
  if (l.camera) { fn(l.camera.zoom, 'camera.zoom'); fn(l.camera.poi, 'camera.poi'); if (l.camera.dof) for (const k of ['focus', 'aperture', 'blur'] as const) fn(l.camera.dof[k], `camera.dof.${k}`); }
  if (l.light) for (const k of ['color', 'intensity', 'coneAngle', 'coneFeather', 'radius', 'falloffDistance', 'shadowDarkness', 'shadowDiffusion', 'poi'] as const) fn(l.light[k] as Prop, `light.${k}`);
  if (l.material) for (const k of ['ambient', 'diffuse', 'specular', 'shininess', 'metal'] as const) fn(l.material[k], `material.${k}`);
  if (l.material) for (const k of SURFACE_KEYS) if (l.material[k]) fn(l.material[k]!, `material.${k}`);
  if (l.geometry) for (const k of GEOMETRY_KEYS) fn(l.geometry[k], `geometry.${k}`);
  if (l.model) for (const k of ['speed', 'offset', 'metalness', 'roughness', 'emissive', 'emissiveIntensity'] as const) if (l.model[k]) fn(l.model[k]!, `model.${k}`);
  for (const o of l.overrides ?? []) fn(o.prop, `essential.${o.id}`);
  for (const st of l.styles ?? []) for (const [k, p] of Object.entries(st.params)) fn(p, `styles.${st.id}.${k}`);
  for (const pin of l.puppet?.pins ?? []) fn(pin.position, `puppet.${pin.id}.position`);
  fn(l.audio.level, 'audio.level');
  if (l.timeRemap) fn(l.timeRemap, 'timeRemap');
}

function reId(l: Layer): Layer {
  l.id = uid('l');
  for (const f of l.effects) f.id = uid('f');
  for (const st of l.styles ?? []) st.id = uid('y');
  for (const pin of l.puppet?.pins ?? []) pin.id = uid('p');
  for (const m of l.masks) m.id = uid('m');
  for (const s of l.shapes ?? []) s.id = uid('s');
  for (const a of l.text?.animators ?? []) a.id = uid('a');
  return l;
}
function nextName(c: Comp, name: string): string {
  const base = name.replace(/ \d+$/, '');
  for (let i = 2; ; i++) if (!c.layers.some((l) => l.name === `${base} ${i}`)) return `${base} ${i}`;
}

/** Size of a layer's own pixel space (source size; comp size for text/shape/null). */
/** Layer-type effect parameters may be given by layer name, id or index (1 = top): stored as the layer id. */
function layerRefs(c: Comp, self: Layer, fx: string, values: Record<string, PVal | boolean>): Record<string, PVal | boolean> {
  const out = { ...values };
  for (const pd of fxDef(fx).params) {
    const v = out[pd.id];
    if (pd.type !== 'layer' || v === undefined || v === '') continue;
    const ref = findLayer(c, typeof v === 'number' ? v : String(v));
    // Time Difference compares the layer with itself at another moment
    if (ref.id === self.id && fx !== 'timeDifference') throw new Error(`«${pd.name}» no puede ser la misma capa del efecto.`);
    out[pd.id] = ref.id;
  }
  return out;
}

export function layerSize(p: Project, c: Comp, l: Layer): [number, number] {
  if (l.solid) return [l.solid.width, l.solid.height];
  if (l.mediaId) { const m: MediaItem | undefined = p.media.find((x) => x.id === l.mediaId); if (m?.width) return [m.width, m.height]; }
  return [c.width, c.height];
}

/** true if comp `a` contains (directly or nested) comp `b`. */
export function dependsOn(p: Project, a: string, b: string, seen = new Set<string>()): boolean {
  if (a === b) return true;
  if (seen.has(a)) return false;
  seen.add(a);
  const c = comps(p).find((x) => x.id === a);
  return !!c?.layers.some((l) => l.type === 'comp' && l.compId && dependsOn(p, l.compId, b, seen));
}

/** Compact description of a composition for the MCP (ids, timing, animated properties). */
export function compSummary(_p: Project, c: Comp) {
  return {
    id: c.id, name: c.name, width: c.width, height: c.height, fps: c.fps, duration: c.duration, bg: c.bg, transparent: c.transparent,
    workArea: c.workArea, motionBlur: c.motionBlur,
    ...(c.markers.length ? { markers: c.markers } : {}), ...(c.roi ? { roi: c.roi } : {}),
    ...(c.essential?.length ? { essential: c.essential.map((x) => ({ id: x.id, name: x.name, layer: c.layers.find((y) => y.id === x.layer)?.name, path: x.path, value: essentialDefault(c, x) })) } : {}),
    layers: c.layers.map((l, i) => {
      const animated: Record<string, string> = {};
      forEachProp(l, (prop, path) => { if (prop.k?.length || prop.x) animated[path] = `${prop.k?.length ? `${prop.k.length} claves` : ''}${prop.x ? `${prop.k?.length ? ' + ' : ''}expresión` : ''}`; });
      return {
        index: i + 1, id: l.id, name: l.name, type: l.type, in: l.in, out: l.out, start: l.start, stretch: l.stretch,
        ...(l.hidden ? { hidden: true } : {}), ...(l.guide ? { guide: true } : {}), ...(l.solo ? { solo: true } : {}), ...(l.threeD ? { threeD: true } : {}), ...(l.motionBlur ? { motionBlur: true } : {}),
        ...(l.blend !== 'normal' ? { blend: l.blend } : {}), ...(l.parent ? { parent: c.layers.find((x) => x.id === l.parent)?.name } : {}),
        ...(l.matte ? { matte: { layer: c.layers.find((x) => x.id === l.matte!.layer)?.name, mode: l.matte.mode } } : {}),
        ...(l.text ? { text: l.text.text.v, animators: l.text.animators.map((a) => ({ id: a.id, name: a.name, props: Object.keys(a.props) })) } : {}),
        ...(l.shapes?.length ? { shapes: l.shapes.map((s) => ({ id: s.id, name: s.name, kind: s.kind, ...(s.wiggleTransform ? { wiggleTransform: true } : {}) })) } : {}),
        ...(l.effects.length ? { effects: l.effects.map((f) => ({ id: f.id, name: f.name, fx: f.fx, on: f.on })) } : {}),
        ...(l.masks.length ? { masks: l.masks.map((m) => ({ id: m.id, name: m.name, mode: m.mode, ...(m.rotoBezier ? { rotoBezier: true } : {}), ...(m.featherPts?.length ? { featherPoints: m.featherPts } : {}) })) } : {}),
        ...(l.overrides?.length ? { overrides: Object.fromEntries(l.overrides.map((o) => [o.name, o.prop.k?.length ? `${o.prop.k.length} claves` : o.prop.v])) } : {}),
        ...(l.transform.positionX ? { separated: true } : {}),
        ...(l.geometry ? { geometry: geometrySummary(l) } : {}),
        ...(l.type === 'model' ? { model: modelSummary(_p.media.find((m) => m.id === l.mediaId)?.model, l) } : {}),
        ...(l.light ? { light: { type: l.light.type, ...(l.light.envLayer ? { envLayer: c.layers.find((x) => x.id === l.light!.envLayer)?.name } : {}) } } : {}),
        position: l.transform.position.v, scale: l.transform.scale.v, rotation: l.transform.rotation.v, opacity: l.transform.opacity.v,
        animated,
      };
    }),
  };
}
