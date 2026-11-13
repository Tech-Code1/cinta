// MCP tools of «vectores»: Create Shapes / Masks from Text, Auto-trace and variable font axes. The outlines are
// computed by the Cinta app (hidden render window: the canvas layout and the font files), then applied as edits.
import * as z from 'zod';
import { Editor, motion, type Project } from '../core';
import { findFont, fontBytes } from '../core/fontfind';
import type { Host } from './motion-tools';

const M = motion;
const pickComp = (p: Project, id?: string) => {
  const list = p.comps ?? [];
  if (!list.length) throw new Error('El proyecto no tiene composiciones: créela con comp_new o comp_template.');
  return id ? M.findComp(list, id) : list[0];
};
const layerOf = (c: motion.Comp, x: string) => M.findLayer(c, /^\d+$/.test(x) ? Number(x) : x);
const C = { comp: z.string().optional().describe('Composition id or name (default: the first one).') };
const L = { layer: z.string().describe('Layer id, name or 1-based index.') };

export function registerVectorTools(H: Host, renderViaApp: (job: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>) {
  const { tool, edit, ok, projectPath, P } = H;

  tool('text_to_shapes', 'Crear formas / máscaras a partir del texto', 'After Effects\' Layer > Create > Create Shapes from Text (mode shapes: a new shape layer "<name> contornos" with one group per character, named after it, filled and stroked like the text) or Create Masks from Text (mode masks: a solid with one mask per character outline, counters subtract). Outlines come from the real font file, placed exactly over the text (tracking, leading, alignment, paragraph box, text on a path) at `time`; the new layer copies the text\'s transform and parent, and the text layer\'s video switch goes off.', {
    ...P, ...C, ...L, mode: z.enum(['shapes', 'masks']).optional().describe('shapes (default) or masks.'), time: z.number().min(0).optional().describe('Comp time of the text to convert (default 0).'),
  }, async (a, extra) => {
    const path = projectPath(a.project);
    const e0 = Editor.load(path, true);
    const c = pickComp(e0.project, a.comp), l = layerOf(c, a.layer);
    const r = await renderViaApp({ project: path, compId: c.id, task: { kind: 'textOutlines', layer: l.id, t: a.time ?? 0 } }, extra.signal) as unknown as motion.TextOutlines & { font: string };
    const { e, out } = await edit(a.project, (e) => (a.mode === 'masks' ? M.motionOps.textToMasks : M.motionOps.textToShapes)(e, c.id, l.id, r));
    return ok({ project: e.path, canUndo: e.canUndo, layer: { id: out.id, name: out.name, type: out.type }, font: r.font, characters: r.glyphs.map((g) => g.ch).join(''), groups: out.shapes?.map((s) => ({ id: s.id, name: s.name, contours: 1 + (s.contours?.length ?? 0) })), masks: out.masks.map((m) => ({ id: m.id, name: m.name, mode: m.mode })) });
  });

  tool('auto_trace', 'Trazado automático', 'After Effects\' Layer > Auto-trace: masks that follow the outlines of a layer\'s channel (in layer pixels). Current frame (default) or the work area (work_area: one hold key per frame on every mask path). Options and defaults as in After Effects: channel alpha, invert false, blur 1 px before tracing (0 = off), tolerance 1 px, threshold 50 %, minimum area 10 px, corner roundness 50 % (0 = straight segments), new_layer false (true: on a new solid "Trazado automático <name>" in the layer\'s place). Holes come as Subtract masks.', {
    ...P, ...C, ...L, time: z.number().min(0).optional().describe('Comp time of "current frame" (default 0).'), work_area: z.boolean().optional(),
    channel: z.enum(['alpha', 'red', 'green', 'blue', 'luminance']).optional(), invert: z.boolean().optional(), blur: z.number().min(0).max(100).optional(),
    tolerance: z.number().min(0.1).max(100).optional(), threshold: z.number().min(0).max(100).optional(), min_area: z.number().min(0).optional(), corner_roundness: z.number().min(0).max(100).optional(), new_layer: z.boolean().optional(),
  }, async (a, extra) => {
    const path = projectPath(a.project);
    const e0 = Editor.load(path, true);
    const c = pickComp(e0.project, a.comp), l = layerOf(c, a.layer);
    const options: Partial<motion.TraceOptions> = { channel: a.channel, invert: a.invert, blur: a.blur, tolerance: a.tolerance, threshold: a.threshold, minArea: a.min_area, cornerRoundness: a.corner_roundness };
    for (const k of Object.keys(options) as (keyof typeof options)[]) if (options[k] === undefined) delete options[k];
    const times: number[] = [];
    if (a.work_area) { const [s, t] = c.workArea; for (let f = Math.round(s * c.fps); f / c.fps < t - 1e-6; f++) times.push(f / c.fps); }
    if (!times.length) times.push(a.time ?? 0);
    const r = await renderViaApp({ project: path, compId: c.id, task: { kind: 'autoTrace', layer: l.id, times, options } }, extra.signal) as unknown as { frames: { t: number; paths: motion.TracedPath[] }[] };
    const { e, out } = await edit(a.project, (e) => M.motionOps.autoTraceApply(e, c.id, l.id, r.frames, { ...options, newLayer: a.new_layer }));
    const tl = M.findLayer(pickComp(e.project, c.id), out.layer);
    return ok({ project: e.path, canUndo: e.canUndo, layer: { id: tl.id, name: tl.name }, frames: times.length, masks: tl.masks.filter((m) => out.masks.includes(m.id)).map((m) => ({ id: m.id, name: m.name, mode: m.mode, vertices: (m.path.k?.[0]?.v as number[] ?? m.path.v).length / 6 })), outlines: r.frames[0].paths.map((p) => ({ area: Math.round(p.area * 10) / 10, depth: p.depth, hole: p.hole })) });
  });

  tool('text_font_axes', 'Ejes de fuente variable', 'Variable font axes of a text layer (weight wght, width wdth, slant slnt, optical size opsz, italic ital and the font\'s own axes): lists the axes of the layer\'s font file (min / default / max, named instances) and the layer\'s values; `axes` sets them ({"wght": 650, "wdth": 80}; null removes one, back to the font default). Once set, an axis is a text property text.axes.<tag> you can keyframe with prop_set. The style\'s weight drives wght when it is not set.', {
    ...P, ...C, ...L, axes: z.record(z.string(), z.number().nullable()).optional(),
  }, async (a) => {
    let e = Editor.load(projectPath(a.project), true);
    let c = pickComp(e.project, a.comp), l = layerOf(c, a.layer);
    if (!l.text) throw new Error(`«${l.name}» no es una capa de texto.`);
    const face = findFont(l.text.font, l.text.weight, l.text.italic);
    const font = face ? new M.OTFont(fontBytes(face.path), face.index) : null;
    if (a.axes) {
      if (!font?.axes.length) throw new Error(`La fuente «${l.text.font}» no es una fuente variable.`);
      for (const [tag, v] of Object.entries(a.axes)) { const ax = font.axes.find((x) => x.tag === tag); if (!ax) throw new Error(`La fuente no tiene el eje «${tag}». Tiene: ${font.axes.map((x) => x.tag).join(', ')}.`); if (v !== null) a.axes[tag] = Math.max(ax.min, Math.min(ax.max, v)); }
      const id = l.id;
      e = (await edit(a.project, (ed) => M.motionOps.textAxesSet(ed, c.id, id, a.axes!))).e;
      c = pickComp(e.project, c.id); l = layerOf(c, id);
    }
    return ok({ project: e.path, canUndo: e.canUndo, font: face ? { file: face.path, name: font?.info.fullName, variable: !!font?.axes.length } : null,
      axes: (font?.axes ?? []).map((x) => ({ tag: x.tag, name: x.name, min: x.min, default: x.def, max: x.max, hidden: x.hidden, value: l.text!.axes?.[x.tag] ? { v: l.text!.axes[x.tag].v, keys: l.text!.axes[x.tag].k?.length ?? 0 } : null })),
      instances: font?.instances.map((i) => ({ name: i.name, coords: i.coords })) ?? [] });
  });
}
