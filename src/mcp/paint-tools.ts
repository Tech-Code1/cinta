// MCP tools of the paint tools (After Effects' Brush, Clone Stamp and Eraser on a layer's «Pintura» effect).
import * as z from 'zod';
import { Editor, motion, type Project } from '../core';
import type { Host } from './motion-tools';

const M = motion;
const pickComp = (p: Project, id?: string) => {
  const list = p.comps ?? [];
  if (!list.length) throw new Error('El proyecto no tiene composiciones: créela con comp_new o comp_template.');
  return id ? M.findComp(list, id) : list[0];
};
const layerOf = (c: motion.Comp, x: string) => M.findLayer(c, /^\d+$/.test(x) ? Number(x) : x);
const modes = M.BLEND_MODES.map((m) => m.id) as [string, ...string[]];

/** Paint panel settings of this MCP session (the defaults paint_stroke takes; Cinta's window keeps its own). */
let opts: motion.PaintOptions = M.defaultPaintOptions();

const C = { comp: z.string().optional().describe('Composition id or name (default: the first one).') };
const L = { layer: z.string().describe('Layer id, name or 1-based index.') };

export function registerPaintTools(H: Host) {
  const { tool, edit, ok, projectPath, P } = H;
  const optShape = {
    color: z.string().optional().describe('Brush colour "#rrggbb" (default: the foreground colour of paint_options, black).'),
    diameter: z.number().min(0.1).max(2500).optional().describe('Brush diameter px (default 21).'),
    angle: z.number().optional().describe('Brush angle ° (elliptical tips).'),
    roundness: z.number().min(0).max(100).optional().describe('% (100 = round).'),
    hardness: z.number().min(0).max(100).optional().describe('% of the radius fully painted; the rest falls off (default 0 = soft).'),
    spacing: z.number().min(1).max(1000).optional().describe('Distance between dabs, % of the diameter (default 25).'),
    opacity: z.number().min(0).max(100).optional(), flow: z.number().min(0).max(100).optional().describe('Paint laid per dab % (dabs build up to the opacity).'),
    mode: z.enum(modes).optional().describe('Blend mode of the stroke (catalog_list blend_modes).'),
    channels: z.enum(['rgba', 'rgb', 'alpha']).optional().describe('RGBA, RGB (keeps the layer alpha) or Alpha (paints transparency: white opaque, black clear).'),
    duration: z.enum(['constant', 'writeOn', 'single', 'custom']).optional().describe('Constant (from at to the layer end), writeOn (End animates 0→100 % over draw_time), single (one frame), custom (frames).'),
    frames: z.number().int().min(1).optional().describe('custom duration: frames.'),
    erase: z.enum(['all', 'paint', 'last']).optional().describe('Eraser: all = Layer Source & Paint, paint = Paint Only (brings the source back), last = Last Stroke Only.'),
  };
  const merged = (a: Partial<Record<keyof typeof optShape, unknown>>) => ({
    color: (a.color as string) ?? opts.fg, diameter: (a.diameter as number) ?? opts.brush.diameter, angle: (a.angle as number) ?? opts.brush.angle, roundness: (a.roundness as number) ?? opts.brush.roundness,
    hardness: (a.hardness as number) ?? opts.brush.hardness, spacing: (a.spacing as number) ?? opts.brush.spacing, opacity: (a.opacity as number) ?? opts.opacity, flow: (a.flow as number) ?? opts.flow,
    mode: ((a.mode as string) ?? opts.mode) as motion.BlendMode, channels: ((a.channels as string) ?? opts.channels) as motion.PaintChannels,
    duration: ((a.duration as string) ?? opts.duration) as motion.PaintDuration, frames: (a.frames as number) ?? opts.frames, erase: ((a.erase as string) ?? opts.erase) as motion.EraseMode,
  });

  tool('paint_stroke', 'Pintar trazo', 'Paint on a layer like After Effects\' paint tools (Brush, Clone Stamp, Eraser — Ctrl+B in Cinta\'s window). The first stroke adds the «Pintura» (Paint) effect to the layer; every stroke is an item of it with animatable Stroke Options (start, end, color, diameter, angle, hardness, roundness, spacing, channels, opacity, flow), a Transform and its path (animate them with prop_set path effects.Pintura.strokes.<stroke>.<prop>, e.g. end or transform.position). points: [[x, y], …] in LAYER pixels (space "comp": comp pixels, mapped through the layer\'s transform at at). One point = one dab. Unset options come from paint_options. tool clone copies clone_source (default the layer itself) from clone_position (the source point under the first point) or clone_offset, at the same time + clone_time_shift s (or clone_time when clone_lock). Eraser modes: all, paint, last. draw_time: seconds the drawing takes (Write On).', {
    ...P, ...C, ...L, tool: z.enum(['brush', 'clone', 'eraser']), points: z.array(z.array(z.number()).min(2)).min(1).max(20000),
    space: z.enum(['layer', 'comp']).optional(), at: z.number().min(0).optional().describe('Comp time where it is painted (default 0).'),
    draw_time: z.number().min(0).optional(), name: z.string().optional(),
    clone_source: z.string().optional(), clone_position: z.array(z.number()).length(2).optional(), clone_offset: z.array(z.number()).length(2).optional(),
    clone_time_shift: z.number().optional(), clone_lock: z.boolean().optional(), clone_time: z.number().min(0).optional(),
    ...optShape,
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp), l = layerOf(c, a.layer), at = a.at ?? 0;
      let pts = a.points;
      if (a.space === 'comp') { const inv = M.invert(M.worldMatrix(c, l, at)); pts = pts.map(([x, y]) => { const q = M.apply(inv, x, y); return [q[0], q[1]]; }); }
      const m = merged(a);
      const cl = opts.clone;
      return M.motionOps.paintStroke(e, c.id, l.id, {
        kind: a.tool, points: pts, at, drawTime: a.draw_time, name: a.name, ...m,
        clone: a.tool === 'clone' ? { source: a.clone_source ?? (cl.source || undefined), position: a.clone_position, offset: a.clone_offset ?? (a.clone_position ? undefined : cl.offset), timeShift: a.clone_time_shift ?? cl.timeShift, lock: a.clone_lock ?? cl.lockTime, time: a.clone_time ?? (cl.lockTime ? cl.time : undefined) } : undefined,
      });
    });
    return ok({ ...out, project: e.path, canUndo: e.canUndo });
  });

  tool('paint_list', 'Ver trazos', 'The paint strokes of a layer (drawing order: later ones on top), with their kind, timing (comp s), blend mode, path bounds and Stroke Options (values or keys).', { ...P, ...C, ...L }, (a) => {
    const ed = Editor.load(projectPath(a.project), true);
    const c = pickComp(ed.project, a.comp), l = layerOf(c, a.layer), fx = M.paintFx(l);
    return ok({ layer: l.name, effect: fx ? { id: fx.id, name: fx.name, on: fx.on, paintOnTransparent: !!fx.params.onTransparent?.v } : null, strokes: (fx?.strokes ?? []).map((s, i) => M.strokeSummary(l, s, i)) });
  }, { readOnly: true });

  tool('paint_edit', 'Cambiar trazo', 'Change or delete a paint stroke (id, name or 1-based index): rename, blend mode, eraser mode, in/out (comp s: the stroke\'s duration bar), index (reorder; 1 = drawn first, under the others), static values of its properties (start, end, color, diameter, angle, hardness, roundness, spacing, channels, opacity, flow, transform.position…, clone.position, clone.timeShift, clone.time), clone_source / clone_lock, delete. Paint on Transparent: effect_set on the «Pintura» effect, values.onTransparent.', {
    ...P, ...C, ...L, stroke: z.string(), name: z.string().optional(), mode: z.enum(modes).optional(), erase: z.enum(['all', 'paint', 'last']).optional(),
    in: z.number().optional(), out: z.number().optional(), index: z.number().int().min(1).optional(),
    values: z.record(z.string(), z.union([z.number(), z.array(z.number()), z.string()])).optional(), clone_source: z.string().optional(), clone_lock: z.boolean().optional(), delete: z.boolean().optional(),
  }, async (a) => {
    const { e } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); M.motionOps.paintEdit(e, c.id, layerOf(c, a.layer).id, a.stroke, { name: a.name, mode: a.mode as motion.BlendMode | undefined, erase: a.erase, in: a.in, out: a.out, index: a.index, values: a.values, cloneSource: a.clone_source, cloneLock: a.clone_lock, delete: a.delete }); });
    return ok({ project: e.path, canUndo: e.canUndo });
  });

  tool('paint_options', 'Opciones de pintura', 'Paint and Brushes panels (defaults of the next paint_stroke calls in this session): foreground / background colours (swap, reset to black / white), opacity, flow, blend mode, channels, duration (+ frames), eraser mode, brush (diameter, angle, roundness, hardness, spacing, or tip: a brush tip name / index from catalog_list paint_tips) and clone options (source, aligned, lock_time, time, time_shift, offset). Without arguments: the current settings.', {
    fg: z.string().optional(), bg: z.string().optional(), swap: z.boolean().optional(), reset_colors: z.boolean().optional(),
    opacity: z.number().min(0).max(100).optional(), flow: z.number().min(0).max(100).optional(), mode: z.enum(modes).optional(), channels: z.enum(['rgba', 'rgb', 'alpha']).optional(),
    duration: z.enum(['constant', 'writeOn', 'single', 'custom']).optional(), frames: z.number().int().min(1).optional(), erase: z.enum(['all', 'paint', 'last']).optional(),
    tip: z.union([z.string(), z.number()]).optional(), diameter: z.number().min(0.1).max(2500).optional(), angle: z.number().optional(), roundness: z.number().min(0).max(100).optional(), hardness: z.number().min(0).max(100).optional(), spacing: z.number().min(1).max(1000).optional(),
    clone_source: z.string().optional(), aligned: z.boolean().optional(), lock_time: z.boolean().optional(), clone_time: z.number().optional(), time_shift: z.number().optional(), offset: z.array(z.number()).length(2).optional(),
    reset: z.boolean().optional().describe('Back to After Effects\' defaults.'),
  }, (a) => {
    if (a.reset) opts = M.defaultPaintOptions();
    if (a.reset_colors) { opts.fg = '#000000'; opts.bg = '#ffffff'; }
    if (a.swap) [opts.fg, opts.bg] = [opts.bg, opts.fg];
    if (a.fg) opts.fg = a.fg;
    if (a.bg) opts.bg = a.bg;
    for (const k of ['opacity', 'flow', 'frames'] as const) if (a[k] !== undefined) opts[k] = a[k]!;
    if (a.mode) opts.mode = a.mode as motion.BlendMode;
    if (a.channels) opts.channels = a.channels;
    if (a.duration) opts.duration = a.duration;
    if (a.erase) opts.erase = a.erase;
    if (a.tip !== undefined) {
      const t = typeof a.tip === 'number' ? M.BRUSH_TIPS[a.tip - 1] : M.BRUSH_TIPS.find((x) => x.name.toLowerCase() === String(a.tip).toLowerCase());
      if (!t) throw new Error(`No existe la punta «${a.tip}». Hay: ${M.BRUSH_TIPS.map((x, i) => `${i + 1} ${x.name}`).join(', ')}.`);
      opts.brush = { diameter: t.diameter, angle: t.angle, roundness: t.roundness, hardness: t.hardness, spacing: t.spacing };
    }
    for (const k of ['diameter', 'angle', 'roundness', 'hardness', 'spacing'] as const) if (a[k] !== undefined) opts.brush[k] = a[k]!;
    if (a.clone_source !== undefined) opts.clone.source = a.clone_source;
    if (a.aligned !== undefined) opts.clone.aligned = a.aligned;
    if (a.lock_time !== undefined) opts.clone.lockTime = a.lock_time;
    if (a.clone_time !== undefined) opts.clone.time = a.clone_time;
    if (a.time_shift !== undefined) opts.clone.timeShift = a.time_shift;
    if (a.offset) opts.clone.offset = [a.offset[0], a.offset[1]];
    return ok({ options: opts });
  });
}

/** Catalogue entries of the paint tools. */
export const PAINT_CATALOGS: Record<string, () => unknown[]> = {
  paint_tips: () => M.BRUSH_TIPS.map((t, i) => ({ index: i + 1, ...t })),
  paint_settings: () => [
    { id: 'channels', choices: M.PAINT_CHANNELS }, { id: 'duration', choices: M.PAINT_DURATIONS }, { id: 'erase', choices: M.ERASE_MODES },
    { id: 'modes', choices: M.PAINT_MODES }, { id: 'tools', choices: Object.entries(M.TOOL_NAMES).map(([id, name]) => ({ id, name, stroke: M.STROKE_NAMES[id as motion.PaintTool] })) },
    { id: 'defaults', value: M.defaultPaintOptions() },
  ],
};
