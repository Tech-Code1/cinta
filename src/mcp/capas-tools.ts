// MCP tools of «capas»: guide layers, crop comp to the work area / region of interest, the region of interest,
// composition markers and Responsive Design – Time, RotoBezier and variable mask feather, Wiggle Transform.
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
const C = { comp: z.string().optional().describe('Composition id or name (default: the first one).') };
const L = { layer: z.string().describe('Layer id, name or 1-based index.') };
const rect = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]);

export function registerCapasTools(H: Host) {
  const { tool, edit, ok, P, projectPath } = H;

  tool('layer_guide', 'Capa de guía', 'After Effects\' Layer > Guide Layer: a guide layer shows in the Composition panel of its own comp (Cinta window) but is never rendered or exported (comp_frame, comp_render, render queue, Lottie, its sound) and never seen by the comps that nest it. guide true / false (default: toggle).', {
    ...P, ...C, layers: z.array(z.string()).min(1).describe('Layer ids, names or 1-based indexes.'), guide: z.boolean().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.layerGuide(e, c.id, a.layers.map((x) => layerOf(c, x).id), a.guide); });
    return ok({ guide: out, project: e.path, canUndo: e.canUndo });
  });

  tool('comp_crop', 'Recortar composición', 'After Effects\' Composition > Trim Comp to Work Area (to "work_area", Ctrl+Shift+X: the comp becomes its work area, layers and keys move back in time) or Crop Comp to Region of Interest (to "roi": the comp takes the size of the region — roi [x, y, width, height] in comp px, or the one set with comp_roi — and the layers keep their place in the picture).', {
    ...P, ...C, to: z.enum(['work_area', 'roi']), roi: rect.optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return a.to === 'work_area' ? M.motionOps.compCropWorkArea(e, c.id) : M.motionOps.compCropRoi(e, c.id, a.roi); });
    return ok({ comp: { id: out.id, name: out.name, width: out.width, height: out.height, duration: out.duration, workArea: out.workArea }, project: e.path, canUndo: e.canUndo });
  });

  tool('comp_roi', 'Región de interés', 'Region of interest of the Composition panel (After Effects): while on, the Cinta window\'s previews draw only that rectangle (faster); renders and exports are not affected. roi [x, y, width, height] comp px sets it (and switches it on), on switches it, reset removes it.', {
    ...P, ...C, roi: rect.optional(), on: z.boolean().optional(), reset: z.boolean().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.compRoi(e, c.id, { rect: a.reset ? null : a.roi, on: a.on }); });
    return ok({ roi: out, project: e.path, canUndo: e.canUndo });
  });

  tool('comp_marker', 'Marcadores de composición', 'Composition markers (After Effects): add {time, name, duration, protected}, set {index, …} or remove {index} (index 0-based, markers are kept in time order), list. A marker with a duration and protected true is a Responsive Design – Time protected region: when the comp is nested and time-stretched, or its duration is changed (comp_set), the protected regions keep their timing and only the rest stretches.', {
    ...P, ...C, action: z.enum(['add', 'set', 'remove', 'list']),
    index: z.number().int().min(0).optional(), time: z.number().min(0).optional(), name: z.string().optional(), duration: z.number().min(0).optional(), protected: z.boolean().optional(),
  }, async (a) => {
    if (a.action === 'list') {
      return ok({ markers: pickComp(Editor.load(projectPath(a.project), true).project, a.comp).markers });
    }
    if (a.action !== 'add' && a.index === undefined) throw new Error('Indique index (0 = el primer marcador).');
    const { e } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp);
      if (a.action === 'add') { if (a.time === undefined) throw new Error('Indique time (segundos de la composición).'); return M.motionOps.markerAdd(e, c.id, { t: a.time, name: a.name, dur: a.duration, protected: a.protected }); }
      return M.motionOps.markerSet(e, c.id, a.index!, { remove: a.action === 'remove', t: a.time, name: a.name, dur: a.duration, protected: a.protected });
    });
    return ok({ markers: pickComp(e.project, a.comp).markers, project: e.path, canUndo: e.canUndo });
  });

  tool('responsive_time', 'Diseño interactivo: tiempo', 'After Effects\' Composition > Responsive Design – Time: intro (protected region from 0 to time), outro (from time to the end), work_area (Create Protected Region from Work Area), markers (every marker becomes a protected region up to the next one). Protected regions keep their timing when the comp is nested and time-stretched (layer_set stretch) or its duration changes (comp_set duration).', {
    ...P, ...C, action: z.enum(['intro', 'outro', 'work_area', 'markers']), time: z.number().min(0).optional().describe('Current time for intro / outro.'),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.responsiveTime(e, c.id, a.action === 'work_area' ? 'workArea' : a.action, a.time); });
    return ok({ created: out, markers: pickComp(e.project, a.comp).markers, project: e.path, canUndo: e.canUndo });
  });

  tool('mask_options', 'RotoBézier y calado de máscara', 'Mask path options of After Effects: roto_bezier (Layer > Mask and Shape Path > RotoBezier: the curve passes smoothly through the vertices, tangents computed; tension % per vertex — 0 round, 33 default, 100 corner — one number or a list) and variable feather (Mask Feather tool): feather points on the mask edge at segment (from vertex `segment` to the next, 0-based) and t (0..1 along it), radius px (positive outward, negative inward) and tension %. add_feather_point, set_feather_point {index, …}, remove_feather_point (index), feather_points (replace all; null removes them). The mask\'s own feather is added on top.', {
    ...P, ...C, ...L, mask: z.string(), roto_bezier: z.boolean().optional(), tension: z.union([z.number().min(0).max(100), z.array(z.number().min(0).max(100))]).optional(),
    add_feather_point: z.object({ segment: z.number().int().min(0), t: z.number().min(0).max(1), radius: z.number(), tension: z.number().min(0).max(100).optional() }).optional(),
    set_feather_point: z.object({ index: z.number().int().min(0), segment: z.number().int().min(0).optional(), t: z.number().min(0).max(1).optional(), radius: z.number().optional(), tension: z.number().min(0).max(100).optional() }).optional(),
    remove_feather_point: z.number().int().min(0).optional(),
    feather_points: z.array(z.object({ segment: z.number().int().min(0), t: z.number().min(0).max(1), radius: z.number(), tension: z.number().min(0).max(100).optional() })).nullable().optional(),
  }, async (a) => {
    const fp = (x: { segment?: number; t?: number; radius?: number; tension?: number }) => ({ ...(x.segment !== undefined ? { seg: x.segment } : {}), ...(x.t !== undefined ? { u: x.t } : {}), ...(x.radius !== undefined ? { r: x.radius } : {}), ...(x.tension !== undefined ? { tension: x.tension } : {}) });
    const { e } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp), l = layerOf(c, a.layer);
      if (a.roto_bezier !== undefined || a.tension !== undefined) M.motionOps.maskRoto(e, c.id, l.id, [a.mask], a.roto_bezier ?? true, a.tension);
      const f = a.add_feather_point || a.set_feather_point || a.remove_feather_point !== undefined || a.feather_points !== undefined;
      if (f) M.motionOps.maskFeather(e, c.id, l.id, a.mask, {
        ...(a.add_feather_point ? { add: { seg: a.add_feather_point.segment, u: a.add_feather_point.t, r: a.add_feather_point.radius, tension: a.add_feather_point.tension ?? 0 } } : {}),
        ...(a.set_feather_point ? { set: { index: a.set_feather_point.index, ...fp(a.set_feather_point) } } : {}),
        ...(a.remove_feather_point !== undefined ? { remove: a.remove_feather_point } : {}),
        ...(a.feather_points !== undefined ? { points: a.feather_points === null ? null : a.feather_points.map((x) => ({ seg: x.segment, u: x.t, r: x.radius, tension: x.tension ?? 0 })) } : {}),
      });
    });
    const c = pickComp(e.project, a.comp), l = layerOf(c, a.layer), m = l.masks.find((x) => x.id === a.mask || x.name === a.mask);
    return ok({ mask: m && { id: m.id, name: m.name, rotoBezier: !!m.rotoBezier, tension: m.tension, featherPoints: (m.featherPts ?? []).map((x) => ({ segment: x.seg, t: x.u, radius: x.r, tension: x.tension })) }, project: e.path, canUndo: e.canUndo });
  });

  tool('shape_operator', 'Operador de forma', 'Shape operators of After Effects 2024\'s Add menu that have their own tool here: wiggle_transform (Transformación de ondulación): wiggles the shape group\'s transform at random — each Repeater copy on its own. Values with After Effects\' defaults: speed (wiggles/second, 2), correlation % (50: how alike the copies move), temporal_phase and spatial_phase (degrees, 0), seed (0), and the amounts anchor [x, y], position [x, y] px, scale [x, y] %, rotation ° (all 0). Animate them with prop_set shapes.<shape>.wiggleTransform.<property>. remove true takes it off. (The other operators — trim, repeater, wiggle paths, zig zag, pucker & bloat, round corners, offset, twist, merge — are in shape_add / shape_set.)', {
    ...P, ...C, ...L, shape: z.string(), operator: z.enum(['wiggle_transform']), remove: z.boolean().optional(),
    speed: z.number().optional(), correlation: z.number().min(0).max(100).optional(), temporal_phase: z.number().optional(), spatial_phase: z.number().optional(), seed: z.number().int().optional(),
    anchor: z.array(z.number()).optional(), position: z.array(z.number()).optional(), scale: z.array(z.number()).optional(), rotation: z.number().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.shapeWiggleTransform(e, c.id, layerOf(c, a.layer).id, a.shape, { remove: a.remove, speed: a.speed, correlation: a.correlation, temporalPhase: a.temporal_phase, spatialPhase: a.spatial_phase, seed: a.seed, anchor: a.anchor, position: a.position, scale: a.scale, rotation: a.rotation }); });
    return ok({ wiggleTransform: out && Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v && typeof v === 'object' && 'v' in v ? (v as { v: unknown }).v : v])), project: e.path, canUndo: e.canUndo });
  });
}
