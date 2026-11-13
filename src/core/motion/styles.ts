// Layer styles of the advanced mode (After Effects' Layer ▸ Layer Styles, from Photoshop): drawn after masks and
// effects, in a fixed order — shadow and glow behind the layer, overlays, inner glow / shadow and bevel on it, stroke.
// One of each kind per layer; every parameter is a Prop (animatable). Drawn by src/motion-render/styles.ts.
import { uid } from '../model';
import type { FxDef, ParamDef } from './effects';
import { P, type FxInstance, type Prop, type PVal } from './model';

const n = (id: string, name: string, def: number, min?: number, max?: number): ParamDef => ({ id, name, type: 'number', def, min, max });
const pc = (id: string, name: string, def: number): ParamDef => ({ id, name, type: 'percent', def, min: 0, max: 100 });
const an = (id: string, name: string, def: number): ParamDef => ({ id, name, type: 'angle', def });
const co = (id: string, name: string, def: string): ParamDef => ({ id, name, type: 'color', def });
const ch = (id: string, name: string, choices: [string, string][]): ParamDef => ({ id, name, type: 'choice', def: choices[0][0], choices: choices.map(([i, nm]) => ({ id: i, name: nm })) });

export type StyleKind = 'dropShadow' | 'innerShadow' | 'outerGlow' | 'innerGlow' | 'bevel' | 'colorOverlay' | 'gradientOverlay' | 'stroke';
export const STYLES: (FxDef & { id: StyleKind })[] = [
  { id: 'dropShadow', name: 'Sombra paralela', cat: 'Estilos de capa', params: [co('color', 'Color', '#000000'), pc('opacity', 'Opacidad', 75), an('angle', 'Ángulo', 120), n('distance', 'Distancia', 5, 0, 30000), pc('spread', 'Extensión', 0), n('size', 'Tamaño', 5, 0, 250)] },
  { id: 'innerShadow', name: 'Sombra interior', cat: 'Estilos de capa', params: [co('color', 'Color', '#000000'), pc('opacity', 'Opacidad', 75), an('angle', 'Ángulo', 120), n('distance', 'Distancia', 5, 0, 30000), pc('choke', 'Reducir', 0), n('size', 'Tamaño', 5, 0, 250)] },
  { id: 'outerGlow', name: 'Resplandor exterior', cat: 'Estilos de capa', params: [co('color', 'Color', '#ffffbe'), pc('opacity', 'Opacidad', 75), pc('spread', 'Extensión', 0), n('size', 'Tamaño', 5, 0, 250)] },
  { id: 'innerGlow', name: 'Resplandor interior', cat: 'Estilos de capa', params: [co('color', 'Color', '#ffffbe'), pc('opacity', 'Opacidad', 75), ch('source', 'Origen', [['edge', 'Borde'], ['center', 'Centro']]), pc('choke', 'Reducir', 0), n('size', 'Tamaño', 5, 0, 250)] },
  { id: 'bevel', name: 'Bisel y relieve', cat: 'Estilos de capa', params: [ch('style', 'Estilo', [['inner', 'Bisel interior'], ['outer', 'Bisel exterior'], ['emboss', 'Relieve'], ['pillow', 'Relieve acolchado']]), n('depth', 'Profundidad', 100, 1, 1000), ch('direction', 'Dirección', [['up', 'Arriba'], ['down', 'Abajo']]), n('size', 'Tamaño', 5, 0, 250), n('soften', 'Suavizar', 0, 0, 16), an('angle', 'Ángulo', 120), an('altitude', 'Altitud', 30), co('highlightColor', 'Color de iluminación', '#ffffff'), pc('highlightOpacity', 'Opacidad de iluminación', 75), co('shadowColor', 'Color de sombra', '#000000'), pc('shadowOpacity', 'Opacidad de sombra', 75)] },
  { id: 'colorOverlay', name: 'Superposición de color', cat: 'Estilos de capa', params: [co('color', 'Color', '#ff0000'), pc('opacity', 'Opacidad', 100)] },
  { id: 'gradientOverlay', name: 'Superposición de degradado', cat: 'Estilos de capa', params: [co('startColor', 'Color inicial', '#000000'), co('endColor', 'Color final', '#ffffff'), pc('opacity', 'Opacidad', 100), ch('type', 'Estilo', [['linear', 'Lineal'], ['radial', 'Radial']]), an('angle', 'Ángulo', 90), n('scale', 'Escala', 100, 10, 150), { id: 'reverse', name: 'Invertir', type: 'bool', def: 0 }] },
  { id: 'stroke', name: 'Trazo', cat: 'Estilos de capa', params: [co('color', 'Color', '#ff0000'), n('size', 'Tamaño', 3, 1, 250), pc('opacity', 'Opacidad', 100), ch('position', 'Posición', [['outside', 'Fuera'], ['inside', 'Dentro'], ['center', 'Centro']])] },
];
/** Drawing order (behind the layer first). */
export const STYLE_ORDER: StyleKind[] = ['dropShadow', 'outerGlow', 'colorOverlay', 'gradientOverlay', 'innerGlow', 'innerShadow', 'bevel', 'stroke'];

export function styleDef(id: string): FxDef & { id: StyleKind } {
  const d = STYLES.find((s) => s.id === id || s.name.toLowerCase() === id.toLowerCase());
  if (!d) throw new Error(`No existe el estilo de capa «${id}». Hay: ${STYLES.map((s) => s.id).join(', ')}.`);
  return d;
}
export function newStyle(id: string, values: Record<string, PVal | boolean> = {}): FxInstance {
  const d = styleDef(id);
  const params: Record<string, Prop> = {};
  for (const p of d.params) { const v = values[p.id]; params[p.id] = P(v === undefined ? p.def : typeof v === 'boolean' ? (v ? 1 : 0) : v); }
  const unknown = Object.keys(values).filter((k) => !d.params.some((p) => p.id === k));
  if (unknown.length) throw new Error(`«${d.name}» no tiene ${unknown.join(', ')}. Tiene: ${d.params.map((p) => p.id).join(', ')}.`);
  return { id: uid('y'), fx: d.id, name: d.name, on: true, params };
}
