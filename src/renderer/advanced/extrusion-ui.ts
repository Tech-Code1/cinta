// Extruded 3D text and shapes in the advanced-mode timeline: «Opciones de geometría» (Estilo de bisel, Profundidad de
// bisel, Profundidad de bisel de hueco, Profundidad de extrusión) and the per-surface colours of «Opciones de material»
// (Color frontal, de bisel, lateral, de fondo), shown on 3D text and shape layers like After Effects' Advanced 3D.
import type { Comp, Layer } from '../../core/motion/model';
import { BEVEL_STYLES, GEOMETRY_RANGE, SURFACE_KEYS, SURFACE_NAMES } from '../../core/motion/extrude';
import { autoSurfaceColor } from '../../core/motion/extrude-ops';
import { h } from '../store';
import { mop } from './state';
import type { EditorSpec } from './widgets';

type AddProp = (path: string, depth: number, label: string, spec?: EditorSpec) => void;
type AddAction = (el: HTMLElement, depth: number) => void;

/** Text and shape layers get the geometry options when they are 3D. */
export const extrudable = (l: Layer) => l.threeD && (l.type === 'text' || l.type === 'shape');

/** Rows of «Opciones de geometría» (an open group); the options are created with After Effects' defaults. */
export function geometryRows(c: Comp, l: Layer, addProp: AddProp, addAction: AddAction) {
  const g = l.geometry;
  if (!g) { queueMicrotask(() => void mop('geometrySet', c.id, l.id, {})); return; }
  const style = h('select', { title: 'Estilo de bisel', dataset: { test: 'geo-bevel-style' } }, ...BEVEL_STYLES.map((b) => h('option', { value: b.id, selected: b.id === g.bevelStyle }, b.name))) as HTMLSelectElement;
  style.onchange = () => void mop('geometrySet', c.id, l.id, { bevelStyle: style.value });
  addAction(h('span', { class: 'seltools' }, h('span', { class: 'nm' }, 'Estilo de bisel'), style), 2);
  const r = GEOMETRY_RANGE;
  addProp('geometry.bevelDepth', 2, 'Profundidad de bisel', { type: 'number', min: r.bevelDepth[0], max: r.bevelDepth[1], step: 0.1 });
  addProp('geometry.holeBevelDepth', 2, 'Profundidad de bisel de hueco', { type: 'number', unit: '%', min: r.holeBevelDepth[0], max: r.holeBevelDepth[1], step: 1 });
  addProp('geometry.extrusionDepth', 2, 'Profundidad de extrusión', { type: 'number', min: r.extrusionDepth[0], max: r.extrusionDepth[1], step: 1 });
}

/** Rows of the surface colours (Opciones de material): each automatic until switched on, then animatable. */
export function surfaceRows(c: Comp, l: Layer, addProp: AddProp, addAction: AddAction) {
  for (const k of SURFACE_KEYS) {
    const on = !!l.material?.[k];
    const box = h('input', { type: 'checkbox', checked: on, title: `${SURFACE_NAMES[k]} propio (si no, automático: el relleno o el trazo)`, dataset: { test: `geo-${k}` } }) as HTMLInputElement;
    box.onchange = () => void mop('geometrySet', c.id, l.id, { [k]: box.checked ? autoSurfaceColor(l, k) : null });
    addAction(h('span', { class: 'seltools' }, h('label', {}, box, on ? SURFACE_NAMES[k] : `${SURFACE_NAMES[k]} (automático)`)), 2);
    if (on) addProp(`material.${k}`, 3, SURFACE_NAMES[k], { type: 'color' });
  }
}
