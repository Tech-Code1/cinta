// Editing operations of extruded 3D text and shape layers (Opciones de geometría, per-surface colours), with undo.
import type { Editor } from '../ops';
import { findComp, findLayer, newMaterial, P, type Layer } from './model';
import { BEVEL_STYLES, GEOMETRY_RANGE, newGeometry, SURFACE_KEYS, type BevelStyle, type SurfaceKey } from './extrude';

export interface GeometryPatch {
  bevelStyle?: BevelStyle;
  bevelDepth?: number;
  holeBevelDepth?: number;
  extrusionDepth?: number;
  /** per-surface colours: a colour sets it, null goes back to automatic */
  frontColor?: string | null;
  bevelColor?: string | null;
  sideColor?: string | null;
  backColor?: string | null;
  /** make the layer 3D too (geometry only shows on 3D layers) */
  threeD?: boolean;
}

/** The colour a surface has when it is not set: front and back the fill; bevel and side the stroke when there is
 *  one, else the fill (shape layers: the first fill / stroke). */
export function autoSurfaceColor(l: Layer, k: SurfaceKey): string {
  let fill = '#ffffff', stroke: string | null = null;
  if (l.text) { fill = String(l.text.fill.v); if (Number(l.text.strokeWidth.v) > 0) stroke = String(l.text.stroke.v); }
  else if (l.shapes?.length) {
    const f = l.shapes.find((s) => s.fill?.on), s = l.shapes.find((x) => x.stroke?.on);
    if (f) fill = String(f.fill.color.v);
    if (s) stroke = String(s.stroke.color.v);
    if (!f && s) fill = String(s.stroke.color.v);
  }
  return k === 'frontColor' || k === 'backColor' ? fill : stroke ?? fill;
}

export const EXTRUDE_OPS = {
  geometrySet(e: Editor, compId: string, layerId: string, o: GeometryPatch): Layer {
    return e.mutate('Opciones de geometría', (p) => {
      const l = findLayer(findComp(p.comps, compId), layerId);
      if (l.type !== 'text' && l.type !== 'shape') throw new Error(`«${l.name}» no es una capa de texto ni de forma: solo esas se extruyen.`);
      const g = (l.geometry ??= newGeometry());
      if (o.threeD !== undefined) l.threeD = o.threeD;
      if (o.bevelStyle !== undefined) {
        if (!BEVEL_STYLES.some((x) => x.id === o.bevelStyle)) throw new Error(`Estilo de bisel desconocido «${o.bevelStyle}». Hay: ${BEVEL_STYLES.map((x) => x.id).join(', ')}.`);
        g.bevelStyle = o.bevelStyle;
      }
      for (const k of ['bevelDepth', 'holeBevelDepth', 'extrusionDepth'] as const) {
        const v = o[k];
        if (v === undefined) continue;
        if (!Number.isFinite(v)) throw new Error(`${k} debe ser un número.`);
        const [a, b] = GEOMETRY_RANGE[k];
        g[k] = P(Math.max(a, Math.min(b, v)));
      }
      for (const k of SURFACE_KEYS) {
        const v = o[k];
        if (v === null) { if (l.material) delete l.material[k]; }
        else if (v !== undefined) { l.material ??= newMaterial(); l.material[k] = P(v); }
      }
      return l;
    });
  },
};
