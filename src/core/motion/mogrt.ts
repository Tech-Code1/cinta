// Motion Graphics templates (the Essential Graphics "Export as template" of After Effects, in Cinta's own format):
// a composition with the comps it nests, the media it uses and its exposed properties, in one JSON file that
// another project imports and edits only through those properties.
import type { Editor } from '../ops';
import { uid, type MediaItem, type Project } from '../model';
import { findComp, type Comp } from './model';
import { comps, essentialDefault } from './ops';

export const TEMPLATE_FORMAT = 'cinta-plantilla';
export interface MotionTemplate {
  format: typeof TEMPLATE_FORMAT;
  version: 1;
  name: string;
  /** id of the main comp among `comps` */
  main: string;
  comps: Comp[];
  media: MediaItem[];
  /** the exposed properties of the main comp, for a quick look without opening it */
  essential: { name: string; path: string; value: unknown }[];
}

/** The main comp, every comp it nests and the media they use (Media Replacement choices included). */
export function templateExport(p: Project, compId: string): MotionTemplate {
  const main = findComp(comps(p), compId);
  if (!main.essential?.length) throw new Error(`«${main.name}» no expone propiedades en gráficos esenciales: añádalas con essential_props antes de exportarla como plantilla.`);
  const seen = new Map<string, Comp>(), media = new Map<string, MediaItem>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    const c = findComp(comps(p), id);
    seen.set(id, c);
    for (const l of c.layers) {
      if (l.type === 'sequence') throw new Error(`«${l.name}» es la línea de tiempo del modo sencillo: no puede ir en una plantilla.`);
      if (l.compId) walk(l.compId);
      const ids = [l.mediaId, ...(l.overrides ?? []).map((o) => o.prop.v)];
      for (const m of p.media) if (ids.includes(m.id)) media.set(m.id, m);
    }
  };
  walk(main.id);
  return {
    format: TEMPLATE_FORMAT, version: 1, name: main.name, main: main.id,
    comps: JSON.parse(JSON.stringify([...seen.values()])) as Comp[],
    media: JSON.parse(JSON.stringify([...media.values()])) as MediaItem[],
    essential: main.essential.map((x) => ({ name: x.name, path: x.path, value: essentialDefault(main, x) })),
  };
}

/** Adds a template's comps and media to the project (new ids; media already in it by path are reused). */
export function templateImport(e: Editor, t: MotionTemplate, o: { name?: string } = {}): Comp {
  if (t?.format !== TEMPLATE_FORMAT || !Array.isArray(t.comps) || !t.comps.some((c) => c.id === t.main)) throw new Error('El archivo no es una plantilla de Cinta.');
  return e.mutate('Importar plantilla', (p) => {
    const mediaIds = new Map<string, string>();
    for (const m of t.media ?? []) {
      const have = p.media.find((x) => x.path.toLowerCase() === m.path.toLowerCase());
      if (have) { mediaIds.set(m.id, have.id); continue; }
      const id = uid('m');
      p.media.push({ ...m, id });
      mediaIds.set(m.id, id);
    }
    const compIds = new Map(t.comps.map((c) => [c.id, uid('k')]));
    const taken = new Set(comps(p).map((c) => c.name.toLowerCase()));
    const unique = (n: string) => { let x = n, i = 2; while (taken.has(x.toLowerCase())) x = `${n} ${i++}`; taken.add(x.toLowerCase()); return x; };
    let main: Comp | undefined;
    for (const c0 of t.comps) {
      const c = JSON.parse(JSON.stringify(c0)) as Comp;
      c.id = compIds.get(c0.id)!;
      c.name = unique(c0.id === t.main && o.name ? o.name : c0.name);
      for (const l of c.layers) {
        if (l.compId) l.compId = compIds.get(l.compId) ?? l.compId;
        if (l.mediaId) l.mediaId = mediaIds.get(l.mediaId) ?? l.mediaId;
        for (const ov of l.overrides ?? []) if (typeof ov.prop.v === 'string' && mediaIds.has(ov.prop.v)) ov.prop.v = mediaIds.get(ov.prop.v)!;
      }
      comps(p).push(c);
      if (c0.id === t.main) main = c;
    }
    return main!;
  });
}
