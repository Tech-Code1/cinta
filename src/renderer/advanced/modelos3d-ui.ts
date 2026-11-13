// 3D model layers in the advanced-mode interface: thumbnails of model items in the Project panel, «Opciones de
// modelo» in the timeline (animation clip, loop, scale, speed, offset, material overrides), the layer menu entries
// (shadows, lights, time remapping) and the light type menu with the environment light (Luz de entorno).
import type { Comp, Layer } from '../../core/motion/model';
import { LIGHT_TYPES } from '../../core/motion/model';
import type { MediaItem } from '../../core/model';
import { h, store } from '../store';
import { mop } from './state';

// ───────────────────────── Project panel ─────────────────────────
const thumbs = new Map<string, Promise<string | null>>();
/** A small rendered picture of a model item (three.js, made once per file). */
export function modelThumb(m: MediaItem): HTMLElement {
  const img = h('img', { class: 'mthumb', alt: '', dataset: { test: 'model-thumb' }, style: { width: '28px', height: '28px', objectFit: 'contain', verticalAlign: 'middle', marginRight: '4px' } }) as HTMLImageElement;
  if (!thumbs.has(m.path)) thumbs.set(m.path, import('../../motion-render/scene3d').then((s) => s.scene3d().thumbnail(m.path, 64)).catch(() => null));
  void thumbs.get(m.path)!.then((u) => { if (u) { img.src = u; img.dataset.ready = '1'; } });
  return img;
}
/** Meta line of a model item: meshes, triangles, clips. */
export function modelMeta(m: MediaItem): string {
  const i = m.model;
  if (!i) return 'Modelo 3D';
  return `${i.format.toUpperCase()} · ${i.triangles} triángulos${i.clips.length ? ` · ${i.clips.length} animación${i.clips.length > 1 ? 'es' : ''}` : ''}`;
}

// ───────────────────────── timeline ─────────────────────────
type AddProp = (path: string, depth: number, label: string) => void;
type AddAction = (el: HTMLElement, depth: number) => void;
/** Rows of «Opciones de modelo» under an open model layer. */
export function modelRows(c: Comp, l: Layer, addProp: AddProp, addAction: AddAction) {
  const o = l.model;
  if (!o) return;
  const info = store.project.media.find((m) => m.id === l.mediaId)?.model;
  const set = (patch: Record<string, unknown>) => void mop('modelSet', c.id, l.id, patch);
  const clip = h('select', { title: 'Animación incrustada que se reproduce', dataset: { test: 'model-clip' } },
    h('option', { value: '', selected: !o.clip }, '(ninguna: pose de reposo)'),
    ...(info?.clips ?? []).map((x) => h('option', { value: x.name, selected: x.name === o.clip }, `${x.name} (${x.duration.toFixed(2)} s)`))) as HTMLSelectElement;
  clip.onchange = () => set({ clip: clip.value });
  const loop = h('input', { type: 'checkbox', checked: o.loop, title: 'Repetir la animación', dataset: { test: 'model-loop' } }) as HTMLInputElement;
  loop.onchange = () => set({ loop: loop.checked });
  addAction(h('span', { class: 'seltools' }, h('span', { class: 'nm' }, 'Animación'), clip, h('label', {}, loop, 'Bucle')), 2);
  const unit = h('input', { type: 'number', min: '0.001', step: 'any', value: String(o.unit), style: { width: '70px' }, title: 'Píxeles de composición por unidad del modelo', dataset: { test: 'model-unit' } }) as HTMLInputElement;
  unit.onchange = () => { const v = Number(unit.value); if (v > 0) set({ unit: v }); };
  addAction(h('span', { class: 'seltools' }, h('span', { class: 'nm' }, 'Escala del modelo'), unit, 'px por unidad'), 2);
  addProp('model.speed', 2, 'Velocidad de animación');
  addProp('model.offset', 2, 'Desplazamiento de animación (s)');
  // material overrides: off = the file's values
  const ov = (k: 'metalness' | 'roughness' | 'emissive', name: string, value: unknown) => {
    const on = h('input', { type: 'checkbox', checked: !!o[k], title: `Sustituir ${name.toLowerCase()} del archivo`, dataset: { test: `model-ov-${k}` } }) as HTMLInputElement;
    on.onchange = () => set({ [k]: on.checked ? value : null });
    addAction(h('span', { class: 'seltools' }, h('label', {}, on, name)), 2);
    if (o[k]) addProp(`model.${k}`, 3, name);
    if (k === 'emissive' && o.emissive) addProp('model.emissiveIntensity', 3, 'Intensidad emisiva');
  };
  ov('metalness', 'Metálico', 100);
  ov('roughness', 'Rugosidad', 50);
  ov('emissive', 'Emisivo', '#ffffff');
}

// ───────────────────────── layer menu ─────────────────────────
type Item = { label: string; fn: () => void; disabled?: boolean; kbd?: string } | { sep: true };
/** Material switches (Opciones de material) and time remapping of a model layer. */
export function modelMenuItems(c: Comp, l: Layer, open: (e: MouseEvent, items: Item[]) => void, e: MouseEvent): Item[] {
  if (l.type !== 'model') return [];
  const mt = l.material, cs = mt?.castsShadows ?? 'off';
  const mat = (patch: Record<string, unknown>) => void mop('layerSet', c.id, l.id, { material: patch });
  return [
    { label: 'Proyecta sombras ▸', fn: () => open(e, ([['off', 'Desactivado'], ['on', 'Activado'], ['only', 'Solo']] as const).map(([v, n]) => ({ label: `${cs === v ? '✓ ' : ''}${n}`, fn: () => mat({ castsShadows: v }) }))) },
    { label: `${mt?.acceptsShadows ?? true ? '✓ ' : ''}Acepta sombras`, fn: () => mat({ acceptsShadows: !(mt?.acceptsShadows ?? true) }) },
    { label: `${mt?.acceptsLights ?? true ? '✓ ' : ''}Acepta luces`, fn: () => mat({ acceptsLights: !(mt?.acceptsLights ?? true) }) },
    { label: l.timeRemap ? 'Reasignación de tiempo (activa)' : 'Activar reasignación de tiempo', disabled: !!l.timeRemap, fn: () => void mop('propSet', c.id, l.id, 'timeRemap', {}) },
  ];
}
/** Light type (Opciones de luz ▸ Tipo de luz) and the source image of an environment light. */
export function lightMenuItems(c: Comp, l: Layer, open: (e: MouseEvent, items: Item[]) => void, e: MouseEvent): Item[] {
  if (!l.light) return [];
  const o = l.light;
  const srcs = c.layers.filter((y) => y.type === 'image' || y.type === 'video');
  return [
    { label: 'Tipo de luz ▸', fn: () => open(e, LIGHT_TYPES.map((x) => ({ label: `${o.type === x.id ? '✓ ' : ''}${x.id === 'environment' ? 'Luz de entorno' : x.name}`, fn: () => void mop('layerSet', c.id, l.id, { light: { type: x.id } }) }))) },
    ...(o.type === 'environment' ? [{ label: 'Origen del entorno ▸', disabled: !srcs.length, fn: () => open(e, srcs.map((y) => ({ label: `${o.envLayer === y.id ? '✓ ' : ''}${y.name}`, fn: () => void mop('layerSet', c.id, l.id, { light: { envLayer: y.id } }) }))) }] : []),
    { label: `${o.castsShadows ? '✓ ' : ''}Proyecta sombras`, disabled: o.type === 'ambient' || o.type === 'environment', fn: () => void mop('layerSet', c.id, l.id, { light: { castsShadows: !o.castsShadows } }) },
  ];
}
