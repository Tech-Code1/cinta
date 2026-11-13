// Editing operations of 3D model layers (Opciones de modelo / Configuración del modelo), with undo.
import type { Editor } from '../ops';
import { findComp, findLayer, P, type Comp } from './model';
import { newModelOptions } from './model3d';

export interface ModelPatch {
  clip?: string;
  loop?: boolean;
  /** comp px per model unit */
  unit?: number;
  speed?: number;
  offset?: number;
  /** material overrides: a value sets it, null goes back to the file's */
  metalness?: number | null;
  roughness?: number | null;
  emissive?: string | null;
  emissiveIntensity?: number;
}

export const MODEL_OPS = {
  modelSet(e: Editor, compId: string, layerId: string, o: ModelPatch) {
    return e.mutate('Opciones de modelo', (p) => {
      const c: Comp = findComp(p.comps, compId);
      const l = findLayer(c, layerId);
      if (l.type !== 'model') throw new Error(`«${l.name}» no es una capa de modelo 3D.`);
      const info = p.media.find((m) => m.id === l.mediaId)?.model;
      const m = (l.model ??= newModelOptions(info, c.height));
      if (o.clip !== undefined) {
        if (o.clip && info && !info.clips.some((x) => x.name === o.clip)) throw new Error(`El modelo no tiene la animación «${o.clip}». Tiene: ${info.clips.map((x) => x.name).join(', ') || 'ninguna'}.`);
        m.clip = o.clip;
      }
      if (o.loop !== undefined) m.loop = o.loop;
      if (o.unit !== undefined) {
        if (!(o.unit > 0)) throw new Error('La escala del modelo debe ser mayor que 0.');
        // the anchor (a point of the model) follows the new size, so the model stays where it was
        const k = o.unit / (m.unit || 1);
        l.transform.anchor.v = l.transform.anchor.v.map((v) => v * k);
        m.unit = o.unit;
      }
      if (o.speed !== undefined) { m.speed.v = o.speed; delete m.speed.k; }
      if (o.offset !== undefined) { m.offset.v = o.offset; delete m.offset.k; }
      for (const k of ['metalness', 'roughness'] as const) {
        const v = o[k];
        if (v === null) delete m[k];
        else if (v !== undefined) m[k] = P(Math.max(0, Math.min(100, v)));
      }
      if (o.emissive === null) { delete m.emissive; delete m.emissiveIntensity; }
      else if (o.emissive !== undefined) { m.emissive = P(o.emissive); m.emissiveIntensity ??= P(100); }
      if (o.emissiveIntensity !== undefined) { m.emissive ??= P('#ffffff'); m.emissiveIntensity = P(Math.max(0, o.emissiveIntensity)); }
      return l;
    });
  },
};
