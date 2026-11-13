// MCP tools of the advanced mode (After Effects-style compositions). Editing works on the .cinta file like the
// other tools; pictures (comp_frame, comp_render, comps placed in the simple timeline) are drawn by the Cinta
// app itself in a hidden window (`Cinta --render-comp`), because the canvas engine needs Chromium.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as z from 'zod';
import { cacheDir, motionCached, touchCached, Editor, motion, type Project } from '../core';
import { compHash, COMP_FORMATS } from '../core/motion-io';
import { trackLayer, trackMask } from '../core/tracker';
import { audioToKeys } from '../core/audiokeys';
import { psdImport } from '../core/psd';
import { cameraTrack } from '../core/cameratrack';
import { aiImport } from '../core/ai';
import { compToLottie } from '../core/lottie';
import { createFootageProxy } from '../core/proxy';
import { DiskCache } from '../core/diskcache';
import { exrImport, findSequence } from '../core/exrimport';
import { cryptoLayers, exrLayers, readExrHeader, EXR_COMPRESSION } from '../core/exr';
import { dirname } from 'node:path';
import { registerPaintTools, PAINT_CATALOGS } from './paint-tools';
import { registerVectorTools } from './vector-tools';
import { importProjectFile, registerImportTools } from './import-tools';
import { registerTextoTools } from './texto-tools';
import { registerCapasTools } from './capas-tools';

type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: never) => Promise<void>; signal: AbortSignal };
type ToolFn = <S extends z.ZodRawShape>(name: string, title: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>, extra: Extra) => Promise<CallToolResult> | CallToolResult, o?: { readOnly?: boolean; destructive?: boolean }) => void;
export interface Host {
  tool: ToolFn;
  edit: <T>(project: string | undefined, fn: (e: Editor) => T | Promise<T>) => Promise<{ e: Editor; out: T }>;
  ok: (data: Record<string, unknown>, images?: { data: string; mimeType: string }[]) => CallToolResult;
  projectPath: (p?: string) => string;
  P: { project: z.ZodOptional<z.ZodString> };
}

const M = motion;
// checkboxes (bool params) are stored as 1 / 0: true / false are accepted too
const val = z.union([z.number(), z.array(z.number()), z.string(), z.boolean()]);
const easeEnum = z.enum(['easy', 'in', 'out', 'linear', 'hold', 'bezier']);
const keySchema = z.object({
  t: z.number().min(0).describe('Comp time (s).'),
  v: val.describe('Value: number, [x, y(, z)] or "#rrggbb" / text.'),
  ease: easeEnum.optional().describe('easy = Easy Ease (F9), in / out = ease in/out, linear, hold, bezier (with eo/ei).'),
  eo: z.tuple([z.number(), z.number()]).optional().describe('Out handle [influence 0..1, speed] of the segment leaving this key.'),
  ei: z.tuple([z.number(), z.number()]).optional().describe('In handle of the segment arriving at this key.'),
});
const C = { comp: z.string().optional().describe('Composition id or name (default: the first one).') };
const L = { layer: z.string().describe('Layer id, name or 1-based index.') };

function pickComp(p: Project, id?: string) {
  const list = p.comps ?? [];
  if (!list.length) throw new Error('El proyecto no tiene composiciones: créela con comp_new o comp_template.');
  return id ? M.findComp(list, id) : list[0];
}
const layerId = (c: motion.Comp, x: string) => M.findLayer(c, /^\d+$/.test(x) ? Number(x) : x).id;

// ───────────────────────── rendering through the app ─────────────────────────
function appCommand(): { cmd: string; args: string[] } {
  const exe = process.env.CINTA_EXE ?? process.execPath;
  const packaged = /app\.asar/.test(__dirname);
  return { cmd: exe, args: packaged ? [] : [resolve(__dirname, '..', '..')] };
}
export async function renderViaApp(job: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const dir = cacheDir('mcp-jobs');
  const file = join(dir, `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`);
  writeFileSync(file, JSON.stringify(job));
  const { cmd, args } = appCommand();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // a separate profile so it never collides with an open Cinta window
  env.CINTA_USER_DATA = join(dir, 'profile');
  env.CINTA_CACHE = process.env.CINTA_CACHE ?? cacheDir();
  await new Promise<void>((ok, ko) => {
    const child = spawn(cmd, [...args, '--render-comp', file], { env, windowsHide: true, stdio: 'ignore' });
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort);
    child.on('error', ko);
    child.on('exit', () => { signal?.removeEventListener('abort', onAbort); ok(); });
  });
  const resFile = `${file}.result`;
  if (!existsSync(resFile)) throw new Error('El motor de render de Cinta no respondió.');
  const r = JSON.parse(readFileSync(resFile, 'utf8')) as Record<string, unknown>;
  rmSync(file, { force: true });
  rmSync(resFile, { force: true });
  if (r.error) throw new Error(String(r.error));
  return r;
}

/** Re-renders compositions used as clips in the simple timeline when they changed (export / preview_frame). */
export async function ensureCompMediaViaApp(path: string, signal?: AbortSignal): Promise<boolean> {
  const e = Editor.load(path, true);
  let changed = false;
  for (const m of e.project.media) {
    if (!m.compId) continue;
    const c = e.project.comps?.find((x) => x.id === m.compId);
    if (!c) continue;
    const h = compHash(e.project, c.id);
    if (m.compHash === h && existsSync(m.path)) { touchCached(m.path); continue; }
    const out = motionCached(`comp_${h}.mov`);
    if (!existsSync(out)) await renderViaApp({ project: path, compId: c.id, output: out, format: 'mov-alpha' }, signal);
    m.path = out;
    m.compHash = h;
    m.duration = c.duration;
    m.width = c.width; m.height = c.height; m.fps = c.fps;
    changed = true;
  }
  if (changed) e.save(e.path, true);
  return changed;
}

export function registerMotionTools(H: Host) {
  const { tool, edit, ok, projectPath, P } = H;
  const summary = (e: Editor, c: motion.Comp) => ({ project: e.path, canUndo: e.canUndo, comp: M.compSummary(e.project, c) });

  tool('comp_new', 'Nueva composición', 'Advanced mode (After Effects-style): create a composition — a canvas with layers you animate with keyframes, expressions, effects, text animators, shapes, masks, 3D camera and motion blur. Defaults to the project size/fps, 10 s.', {
    ...P, name: z.string().optional(), width: z.number().int().min(16).max(7680).optional(), height: z.number().int().min(16).max(4320).optional(),
    fps: z.number().min(1).max(120).optional(), duration: z.number().min(0.1).max(3600).optional(), bg: z.string().optional().describe('Background "#rrggbb".'), transparent: z.boolean().optional().describe('Transparent background (exports with alpha).'),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => M.motionOps.compNew(e, { name: a.name, width: a.width, height: a.height, fps: a.fps, duration: a.duration, bg: a.bg, transparent: a.transparent }));
    return ok(summary(e, out));
  });

  tool('comp_template', 'Plantilla de composición', `Create a ready-made animated composition you can then edit: ${M.TEMPLATES.map((t) => `${t.id} (${t.desc})`).join('; ')}.`, {
    ...P, template: z.string(), name: z.string().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => M.templateBuild(e, a.template, { name: a.name }));
    return ok(summary(e, out));
  });

  tool('comp_get', 'Ver composición', 'A composition: size, fps, duration, work area, motion blur and its layers (ids, type, timing, switches, parent, matte, text animators, shapes, effects, masks and which properties are animated). Without comp: the list of compositions.', { ...P, ...C }, (a) => {
    const e = Editor.load(projectPath(a.project), true);
    if (!a.comp) return ok({ comps: (e.project.comps ?? []).map((c) => ({ id: c.id, name: c.name, width: c.width, height: c.height, fps: c.fps, duration: c.duration, layers: c.layers.length })), first: e.project.comps?.[0] ? M.compSummary(e.project, e.project.comps[0]) : null });
    return ok(summary(e, pickComp(e.project, a.comp)));
  }, { readOnly: true });

  tool('color_settings', 'Configuración de color del proyecto', 'Project colour settings of the advanced mode (After Effects Project Settings > Color). depth: bits per channel of the compositing (8, 16 or 32; at 32 bpc values over 1 survive from layer to layer, so added highlights keep their energy). linear_blend: Blend Colors Using 1.0 Gamma (layers blend in linear light: soft edges, glows and transparencies mix as light does). Applies to every composition of the project.', {
    ...P, depth: z.union([z.literal(8), z.literal(16), z.literal(32)]).optional(), linear_blend: z.boolean().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => M.motionOps.colorSettings(e, { depth: a.depth, blendGamma1: a.linear_blend }));
    return ok({ project: e.path, canUndo: e.canUndo, color: out });
  });

  tool('comp_set', 'Configuración de composición', 'Rename or change size, fps, duration, background, transparency, work area [from, to] or motion blur (on, shutter angle, phase, samples) of a composition.', {
    ...P, ...C, name: z.string().optional(), width: z.number().int().min(16).max(7680).optional(), height: z.number().int().min(16).max(4320).optional(),
    fps: z.number().min(1).max(120).optional(), duration: z.number().min(0.1).max(3600).optional(), bg: z.string().optional(), transparent: z.boolean().optional(),
    work_area: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
    motion_blur: z.object({ on: z.boolean().optional(), shutter: z.number().min(0).max(720).optional(), phase: z.number().min(-360).max(360).optional(), samples: z.number().int().min(2).max(64).optional() }).optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => M.motionOps.compSet(e, pickComp(e.project, a.comp).id, { name: a.name, width: a.width, height: a.height, fps: a.fps, duration: a.duration, bg: a.bg, transparent: a.transparent, workArea: a.work_area, motionBlur: a.motion_blur }));
    return ok(summary(e, out));
  });

  tool('comp_delete', 'Eliminar composición', 'Delete a composition (and the layers that nest it in other compositions).', { ...P, comp: z.string() }, async (a) => {
    const { e } = await edit(a.project, (e) => M.motionOps.compDelete(e, pickComp(e.project, a.comp).id));
    return ok({ project: e.path, comps: (e.project.comps ?? []).map((c) => c.name) });
  }, { destructive: true });

  tool('layer_add', 'Nueva capa', 'Add a layer on top of a composition: text, shape (empty — then shape_add), solid, null, adjustment (its effects apply to everything below), camera (3D), light (3D light: light_type parallel|spot|point|ambient — lights only affect 3D layers; animate light.intensity / light.color / light.coneAngle / light.poi…), video/image/audio (media_id from media_list, or media_path to import), model (a 3D model: .glb / .gltf / .obj by media_id or media_path; always 3D, sized to half the comp height, anchored at its centre; then model_set), comp (nest another composition: comp_id) or sequence (the simple-mode timeline).', {
    ...P, ...C, type: z.enum(['text', 'shape', 'solid', 'null', 'adjustment', 'camera', 'light', 'video', 'image', 'audio', 'comp', 'sequence', 'model']),
    light_type: z.enum(['parallel', 'spot', 'point', 'ambient', 'environment']).optional(),
    name: z.string().optional(), text: z.string().optional(), size: z.number().min(1).optional().describe('Text size px.'), font: z.string().optional(), color: z.string().optional().describe('Text fill / solid colour.'),
    media_id: z.string().optional(), media_path: z.string().optional(), comp_id: z.string().optional(),
    width: z.number().int().min(1).optional(), height: z.number().int().min(1).optional(), start: z.number().min(0).optional(), duration: z.number().min(0.01).optional(),
    position: z.array(z.number()).min(2).max(3).optional(), index: z.number().int().min(1).optional().describe('1 = top (default).'),
  }, async (a) => {
    const { e, out } = await edit(a.project, async (e) => {
      let mediaId = a.media_id;
      if (!mediaId && a.media_path) mediaId = (await e.importMedia([a.media_path]))[0].id;
      const c = pickComp(e.project, a.comp);
      const sub = a.comp_id ? pickComp(e.project, a.comp_id).id : undefined;
      const l = M.motionOps.layerAdd(e, c.id, a.type, { name: a.name, text: a.text, size: a.size, font: a.font, color: a.color, mediaId, compId: sub, width: a.width, height: a.height, start: a.start, duration: a.duration, position: a.position, index: a.index });
      if (a.type === 'light' && a.color) M.motionOps.propSet(e, c.id, l.id, 'light.color', { value: a.color });
      if (a.type === 'light' && a.light_type) return M.motionOps.layerSet(e, c.id, l.id, { light: { type: a.light_type } });
      return l;
    });
    return ok({ layer: { id: out.id, name: out.name, type: out.type }, ...summary(e, pickComp(e.project, a.comp)) });
  });

  tool('layer_set', 'Propiedades de capa', 'Layer switches and timing: name, in/out (visible span, comp seconds), start (comp time of source 0), stretch (1 = 100 %, -1 reverse), hidden, solo, locked, three_d, motion_blur, blend mode (normal, add, multiply, screen, overlay, soft-light, hard-light, color-dodge, color-burn, darken, lighten, difference, exclusion, hue, saturation, color, luminosity), parent (layer or null), matte {layer, mode alpha|alphaInv|luma|lumaInv} or null, solid_color, text_style {font, weight, italic, leading, align, all_caps, per_char_3d (After Effects Enable Per-character 3D: makes the layer 3D and every character a card in 3D — animator position [x, y, z], rotationX, rotationY, rotation, seen through the camera, lit, hiding each other per pixel)}; light {type, falloff none|smooth|inverseSquare, casts_shadows} for light layers; material {casts_shadows off|on|only, accepts_shadows, accepts_lights} for 3D layers (animate material.ambient|diffuse|specular|shininess|metal %); dof true/false on a camera (animate camera.dof.focus|aperture|blur).', {
    ...P, ...C, ...L, name: z.string().optional(), in: z.number().min(0).optional(), out: z.number().min(0).optional(), start: z.number().optional(), stretch: z.number().optional(),
    hidden: z.boolean().optional(), solo: z.boolean().optional(), locked: z.boolean().optional(), three_d: z.boolean().optional(), motion_blur: z.boolean().optional(), frame_blend: z.union([z.boolean(), z.enum(['mix', 'pixel'])]).optional().describe('Video layers slowed down / time-remapped: mix (or true) cross-fades the two nearest frames, pixel builds the in-between frame from the motion of every pixel (Pixel Motion); false = off.'),
    blend: z.string().optional(), parent: z.string().nullable().optional(), matte: z.object({ layer: z.string(), mode: z.enum(['alpha', 'alphaInv', 'luma', 'lumaInv']) }).nullable().optional(),
    light: z.object({ type: z.enum(['parallel', 'spot', 'point', 'ambient', 'environment']).optional(), falloff: z.enum(['none', 'smooth', 'inverseSquare']).optional(), casts_shadows: z.boolean().optional(), env_source: z.string().nullable().optional().describe('Environment light (type environment): the image / video layer (an equirectangular HDRI: .hdr, .exr or an image) that lights 3D models and is reflected by them; turn it with the light layer rotationY.') }).optional(),
    material: z.object({ casts_shadows: z.enum(['off', 'on', 'only']).optional(), accepts_shadows: z.boolean().optional(), accepts_lights: z.boolean().optional() }).optional(),
    dof: z.boolean().optional(),
    solid_color: z.string().optional(), text_style: z.object({ font: z.string().optional(), weight: z.number().optional(), italic: z.boolean().optional(), leading: z.number().optional(), align: z.enum(['left', 'center', 'right']).optional(), all_caps: z.boolean().optional(), per_char_3d: z.boolean().optional(), box: z.array(z.number()).length(2).nullable().optional().describe('Paragraph text: [width, height] box centred on the layer; words wrap, overflow hides. null = point text.'), path: z.object({ mask: z.string(), reverse: z.boolean().optional(), perpendicular: z.boolean().optional(), force_align: z.boolean().optional(), open: z.boolean().optional().describe('The mask as an open path (its last vertex does not join the first): for lines and waves.'), first_margin: z.number().optional(), last_margin: z.number().optional() }).nullable().optional().describe('Text on a path: a mask of the text layer (mask_add first); animate text.path.firstMargin to make it run along. null = off.') }).optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp);
      if (a.blend && !M.BLEND_MODES.some((b) => b.id === a.blend)) throw new Error(`Modo de fusión desconocido «${a.blend}». Hay: ${M.BLEND_MODES.map((b) => b.id).join(', ')}.`);
      const ts = a.text_style;
      return M.motionOps.layerSet(e, c.id, layerId(c, a.layer), {
        name: a.name, in: a.in, out: a.out, start: a.start, stretch: a.stretch, hidden: a.hidden, solo: a.solo, locked: a.locked, threeD: a.three_d, motionBlur: a.motion_blur, frameBlend: a.frame_blend, blend: a.blend as never,
        parent: a.parent === undefined ? undefined : a.parent === null ? null : layerId(c, a.parent),
        matte: a.matte === undefined ? undefined : a.matte === null ? null : { layer: layerId(c, a.matte.layer), mode: a.matte.mode },
        solidColor: a.solid_color, text: ts ? { font: ts.font, weight: ts.weight, italic: ts.italic, leading: ts.leading, align: ts.align, allCaps: ts.all_caps, perChar3D: ts.per_char_3d, box: ts.box, path: ts.path === undefined ? undefined : ts.path === null ? null : { mask: ts.path.mask, reverse: ts.path.reverse, perpendicular: ts.path.perpendicular, forceAlign: ts.path.force_align, open: ts.path.open, firstMargin: ts.path.first_margin, lastMargin: ts.path.last_margin } } : undefined,
        light: a.light ? { type: a.light.type, falloff: a.light.falloff, castsShadows: a.light.casts_shadows, envLayer: a.light.env_source === undefined ? undefined : a.light.env_source === null ? null : layerId(c, a.light.env_source) } : undefined,
        material: a.material ? { castsShadows: a.material.casts_shadows, acceptsShadows: a.material.accepts_shadows, acceptsLights: a.material.accepts_lights } : undefined,
        dof: a.dof,
      });
    });
    return ok({ layer: { id: out.id, name: out.name }, ...summary(e, pickComp(e.project, a.comp)) });
  });

  tool('geometry_set', 'Opciones de geometría', 'Extrude and bevel a 3D text or shape layer (After Effects Advanced 3D «Opciones de geometría»): bevel_style none|angular|concave|convex, bevel_depth (px, default 2), hole_bevel_depth (% of the bevel for holes, 1–100, default 100), extrusion_depth (px, default 0 = flat). With depth 0 and no bevel the layer stays flat as before. Per-surface colours (Opciones de material; null = automatic: front/back = fill, bevel/side = stroke if any else fill): front_color, bevel_color, side_color, back_color. three_d: true makes the layer 3D (geometry only applies to 3D layers). Animate with prop_set geometry.extrusionDepth / geometry.bevelDepth / geometry.holeBevelDepth / material.sideColor…; per character with text_animator_add props frontColor / bevelColor / sideColor / backColor. Shadows and lights: layer_set material.', {
    ...P, ...C, ...L, bevel_style: z.enum(['none', 'angular', 'concave', 'convex']).optional(), bevel_depth: z.number().min(0).optional(), hole_bevel_depth: z.number().optional(), extrusion_depth: z.number().min(0).optional(),
    front_color: z.string().nullable().optional(), bevel_color: z.string().nullable().optional(), side_color: z.string().nullable().optional(), back_color: z.string().nullable().optional(), three_d: z.boolean().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp);
      return M.motionOps.geometrySet(e, c.id, layerId(c, a.layer), { bevelStyle: a.bevel_style, bevelDepth: a.bevel_depth, holeBevelDepth: a.hole_bevel_depth, extrusionDepth: a.extrusion_depth, frontColor: a.front_color, bevelColor: a.bevel_color, sideColor: a.side_color, backColor: a.back_color, threeD: a.three_d });
    });
    return ok({ layer: { id: out.id, name: out.name, threeD: out.threeD }, geometry: M.geometrySummary(out), ...summary(e, pickComp(e.project, a.comp)) });
  });

  tool('model_set', 'Opciones de modelo', 'Options of a 3D model layer (After Effects 2024 3D models): clip (embedded animation to play, by name — comp_get lists them; "" = rest pose), speed (1 = as authored; animate with prop_set model.speed), offset (seconds into the clip at the layer start; model.offset), loop, unit (comp px per model unit: the model size, keeping it in place), material overrides metalness / roughness (0–100 %, null = from the file), emissive colour and emissive_intensity (%). Shadows and lights: layer_set material {casts_shadows, accepts_shadows, accepts_lights}. Time remapping (prop_set timeRemap) drives the clip time too.', {
    ...P, ...C, ...L, clip: z.string().optional(), speed: z.number().optional(), offset: z.number().optional(), loop: z.boolean().optional(), unit: z.number().positive().optional(),
    metalness: z.number().min(0).max(100).nullable().optional(), roughness: z.number().min(0).max(100).nullable().optional(), emissive: z.string().nullable().optional(), emissive_intensity: z.number().min(0).optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp);
      return M.motionOps.modelSet(e, c.id, layerId(c, a.layer), { clip: a.clip, speed: a.speed, offset: a.offset, loop: a.loop, unit: a.unit, metalness: a.metalness, roughness: a.roughness, emissive: a.emissive, emissiveIntensity: a.emissive_intensity });
    });
    const c = pickComp(e.project, a.comp);
    return ok({ layer: { id: out.id, name: out.name }, model: M.modelSummary(e.project.media.find((m) => m.id === out.mediaId)?.model, out), ...summary(e, c) });
  });

  tool('layer_delete', 'Eliminar capas', 'Delete layers from a composition.', { ...P, ...C, layers: z.array(z.string()).min(1) }, async (a) => {
    const { e } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); M.motionOps.layerDelete(e, c.id, a.layers.map((x) => layerId(c, x))); });
    return ok(summary(e, pickComp(e.project, a.comp)));
  }, { destructive: true });

  tool('layer_arrange', 'Organizar capas', 'reorder (index 1 = top), duplicate, split at a time (Ctrl+Shift+D), or precompose several layers into a new composition (name).', {
    ...P, ...C, action: z.enum(['reorder', 'duplicate', 'split', 'precompose']), layers: z.array(z.string()).min(1), index: z.number().int().min(1).optional(), time: z.number().min(0).optional(), name: z.string().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp);
      const ids = a.layers.map((x) => layerId(c, x));
      if (a.action === 'reorder') { if (!a.index) throw new Error('Indique index.'); M.motionOps.layerReorder(e, c.id, ids[0], a.index); return null; }
      if (a.action === 'duplicate') return ids.map((id) => M.motionOps.layerDuplicate(e, c.id, id).id);
      if (a.action === 'split') { if (a.time === undefined) throw new Error('Indique time.'); return ids.map((id) => M.motionOps.layerSplit(e, c.id, id, a.time!).id); }
      const r = M.motionOps.layerPrecompose(e, c.id, ids, a.name);
      return { comp: r.comp.id, layer: r.layer.id };
    });
    return ok({ result: out as never, ...summary(e, pickComp(e.project, a.comp)) });
  });

  tool('prop_set', 'Animar propiedad', `Set or animate any layer property. path examples: position, scale ([x,y] %), rotation, opacity, anchor, rotationX, rotationY (3D), text.text, text.size, text.fill, text.tracking, effects.<effect name|id>.<param>, masks.<mask>.feather|opacity|expansion|path, shapes.<shape>.size|roundness|points|outerRadius|innerRadius|fill.color|stroke.width|trim.start|trim.end|trim.offset|repeater.copies|wiggle.size|wiggle.speed|zigzag.size|pucker.amount|roundCorners.radius|twist.angle|offset.amount|gradient.start|stroke.gradient.start|transform.position, styles.<style>.<param>, text.animators.<animator>.props.<prop>, text.animators.<animator>.selectors.0.start|end|offset, camera.zoom, camera.poi, camera.dof.focus|aperture|blur, light.intensity|color|coneAngle|coneFeather|radius|falloffDistance|shadowDarkness|shadowDiffusion|poi, material.ambient|diffuse|specular|shininess|metal, audio.level, timeRemap, essential.<name> (on a comp layer: a Master Property exposed by the nested comp with essential_props; the value replaces it inside, animated in this comp time; for Media Replacement the value is a media id).
- value (static) — or value + t to set/create a keyframe at t.
- keys: replace all keyframes [{t, v, ease}] — ease "easy" gives smooth professional motion; position follows a curved path automatically.
- expression: JavaScript like After Effects: wiggle(freq, amp), loopOut('cycle'|'pingpong'|'offset'|'continue'), loopIn(), inertia(amp, freq, decay) (bounce after keys), time, value, linear/ease(t, tMin, tMax, v1, v2), random, seedRandom, valueAtTime, thisComp.layer("name").position (vectors of other layers have .valueAtTime(t), for trails and delays), effect("name")("param"), posterizeTime(fps), add/sub/mul for arrays (JS has no array +). null removes it.
- clear_keys: drop the keyframes (keeps the value at t).`, {
    ...P, ...C, ...L, path: z.string(), value: val.optional(), t: z.number().min(0).optional(), keys: z.array(keySchema).optional(), ease: easeEnum.optional(),
    expression: z.string().nullable().optional(), clear_keys: z.boolean().optional(),
    path_points: z.boolean().optional().describe('For shapes.<shape>.path / masks.<mask>.path: values are plain [x, y, x, y…] points instead of 6-number bezier vertices. Shape path keys may have DIFFERENT vertex counts: Cinta morphs between them (egg → ball → flame).'),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.propSet(e, c.id, layerId(c, a.layer), a.path, { value: a.value, t: a.t, keys: a.keys, expression: a.expression, clearKeys: a.clear_keys, pathPoints: a.path_points, ease: a.ease }); });
    const c = pickComp(e.project, a.comp);
    const err = [...M.exprErrors.entries()].find(([k]) => k.startsWith(layerId(c, a.layer)))?.[1];
    return ok({ ...out, ...(err ? { expressionError: err } : {}), project: e.path, canUndo: e.canUndo });
  });

  tool('keyframe_edit', 'Fotogramas clave', 'Change keyframes of a property: ease them (easy = Easy Ease F9, in, out, linear, hold, or bezier with out_handle/in_handle [influence 0..1, speed]) or remove them. times: which keys (default all).', {
    ...P, ...C, ...L, path: z.string(), action: z.enum(['ease', 'remove']), kind: easeEnum.optional(), times: z.array(z.number()).optional(),
    out_handle: z.tuple([z.number(), z.number()]).optional(), in_handle: z.tuple([z.number(), z.number()]).optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp);
      const id = layerId(c, a.layer);
      if (a.action === 'remove') return { removed: M.motionOps.keyframeRemove(e, c.id, id, a.path, a.times ?? 'all') };
      return { eased: M.motionOps.keyframeEase(e, c.id, id, a.path, a.kind ?? 'easy', a.times ?? 'all', { eo: a.out_handle, ei: a.in_handle }) };
    });
    return ok({ ...out, project: e.path, canUndo: e.canUndo });
  });

  tool('keyframe_assist', 'Asistente de fotogramas clave', 'easyAll (Easy Ease on every key of the layers), wiggler (random keys: frequency per s, magnitude), smoother (remove redundant keys, tolerance), reverse (time-reverse key values in [from, to]), bake (convert an expression into keyframes, one per frame), sequence (place layers one after another, overlap s), exponentialScale (path scale: between its first and last keys in [from, to] one key per frame with constant-feeling zoom), sketch (Motion Sketch: points [t, x, y, …] in comp px become position keys; smoothing px thins them).', {
    ...P, ...C, kind: z.enum(['easyAll', 'wiggler', 'smoother', 'reverse', 'bake', 'sequence', 'exponentialScale', 'sketch']), points: z.array(z.number()).optional(), smoothing: z.number().min(0).optional(), layers: z.array(z.string()).optional(), path: z.string().optional(),
    from: z.number().min(0).optional(), to: z.number().min(0).optional(), frequency: z.number().min(0.1).optional(), magnitude: z.number().optional(), overlap: z.number().optional(), tolerance: z.number().min(0).optional(), seed: z.number().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.keyframeAssist(e, c.id, { kind: a.kind, layers: a.layers?.map((x) => layerId(c, x)), path: a.path, from: a.from, to: a.to, frequency: a.frequency, magnitude: a.magnitude, overlap: a.overlap, tolerance: a.tolerance, seed: a.seed, points: a.points, smoothing: a.smoothing }); });
    return ok({ result: out, ...summary(e, pickComp(e.project, a.comp)) });
  });

  tool('effect_add', 'Añadir efecto', 'Apply an advanced-mode effect to a layer (catalog_list kind "motion_effects" lists ids and parameters): blurs, colour, glow, drop shadow, outline, gradients, fractal noise, particles, rain, snow, light rays, lens flare, transitions (linearWipe, radialWipe, venetianBlinds, ccScaleWipe… animate "completion"; iris animates "outerRadius"), chromatic aberration, glitch, keys, echo, corner pin, expression controls, and effects that read ANOTHER layer (displacementMap, gradientWipe, setMatte, compoundBlur: give the layer name, id or index; the input layer can stay hidden)… values sets parameters; animate them with prop_set path effects.<name>.<param>. On an adjustment layer they affect everything below.', {
    ...P, ...C, ...L, effect: z.string(), values: z.record(z.string(), val).optional(),
  }, async (a) => {
    const values = { ...(a.values ?? {}) };
    // Apply Color LUT: a .cube path is read here and stored in the project (it travels with it)
    // PS Arbitrary Map: a Photoshop .amp file is stored as hex
    if (a.effect === 'psArbMap' && typeof values.file === 'string') { values.map = readFileSync(values.file).toString('hex'); delete values.file; }
    if (typeof values.file === 'string') { const txt = readFileSync(values.file, 'utf-8'); if (!/LUT_3D_SIZE/i.test(txt)) throw new Error('Solo LUT 3D en formato .cube (con LUT_3D_SIZE).'); values.lut = txt; delete values.file; }
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.effectAdd(e, c.id, layerId(c, a.layer), a.effect, values); });
    return ok({ effect: out, project: e.path, canUndo: e.canUndo });
  });
  tool('effect_set', 'Cambiar efecto', 'Turn an effect on/off, rename, reorder (index) or set static parameter values.', { ...P, ...C, ...L, effect: z.string(), on: z.boolean().optional(), name: z.string().optional(), index: z.number().int().min(1).optional(), values: z.record(z.string(), val).optional() }, async (a) => {
    const { e } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); M.motionOps.effectSet(e, c.id, layerId(c, a.layer), a.effect, { on: a.on, name: a.name, index: a.index, values: a.values }); });
    return ok({ project: e.path, canUndo: e.canUndo });
  });
  tool('effect_remove', 'Quitar efecto', 'Remove an effect from a layer.', { ...P, ...C, ...L, effect: z.string() }, async (a) => {
    const { e } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); M.motionOps.effectRemove(e, c.id, layerId(c, a.layer), a.effect); });
    return ok({ project: e.path, canUndo: e.canUndo });
  }, { destructive: true });

  tool('motion_track', 'Rastrear movimiento', 'Motion tracker like After Effects: follows feature points of a VIDEO layer frame by frame and applies the track. points: [[x, y], …] in comp px at time at (pick spots with texture/contrast: a corner, a mark — not a flat area). apply: null (default: a new null follows the point — parent layers to it), position (target layer follows), cornerPin (4 points tl, tr, br, bl: target layer pinned to them, e.g. a screen replacement), stabilize (the video layer moves so the point stays still; rotate_scale with 2 points also locks rotation and scale), none (just report). feature / search: half sizes in source px (default 16 / 40: raise search for fast motion). Returns frames, lost (frames with match < 0.5) and minConfidence.', {
    ...P, ...C, ...L, points: z.array(z.array(z.number()).length(2)).min(1).max(8), at: z.number().min(0).optional(), to: z.number().min(0).optional(),
    apply: z.enum(['null', 'position', 'cornerPin', 'stabilize', 'none']).optional(), target: z.string().optional(), rotate_scale: z.boolean().optional(),
    feature: z.number().min(2).max(200).optional(), search: z.number().min(2).max(800).optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, async (e) => {
      const c = pickComp(e.project, a.comp);
      return trackLayer(e, c.id, layerId(c, a.layer), { points: a.points, at: a.at ?? 0, to: a.to, apply: a.apply, target: a.target ? layerId(c, a.target) : undefined, rotateScale: a.rotate_scale, feature: a.feature, search: a.search });
    });
    return ok({ ...out, project: e.path, canUndo: e.canUndo });
  });
  tool('audio_to_keys', 'Convertir audio en fotogramas clave', 'Like the Convert Audio to Keyframes assistant of After Effects: adds a null «Amplitud de audio» with sliders «Canal izquierdo», «Canal derecho» and «Ambos canales» keyed on every frame with the loudness (0…100) of the audio of the comp (all audio / video layers, or the given ones). Drive anything with it, e.g. scale expression: s = thisComp.layer("Amplitud de audio").effect("Ambos canales")("value"); [100 + s, 100 + s].', {
    ...P, ...C, layers: z.array(z.string()).optional(), from: z.number().min(0).optional(), to: z.number().min(0).optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, async (e) => { const c = pickComp(e.project, a.comp); return audioToKeys(e, c.id, { layers: a.layers?.map((x) => layerId(c, x)), from: a.from, to: a.to }); });
    return ok({ ...out, project: e.path, canUndo: e.canUndo });
  });
  tool('camera_track', 'Rastreador de cámara 3D', 'After Effects 3D Camera Tracker: analyses a 2D VIDEO layer (from at to to, comp seconds), solves the camera that filmed it and the 3D position of the tracked points (structure from motion), and creates «Cámara 3D rastreada» with position, point of interest and roll keyframes plus track-point 3D nulls (nulls, default 12): add 3D layers and they sit in the shot. The angle of view is searched unless zoom (px) is given. The video needs camera movement with parallax (a pure zoom or a pan from a fixed spot cannot be solved). Returns the mean reprojection error in px.', {
    ...P, ...C, ...L, at: z.number().min(0).optional(), to: z.number().min(0).optional(), zoom: z.number().positive().optional(), nulls: z.number().int().min(0).max(200).optional(),
  }, async (a, extra) => {
    const { e, out } = await edit(a.project, async (e) => { const c = pickComp(e.project, a.comp); return cameraTrack(e, c.id, layerId(c, a.layer), { at: a.at, to: a.to, zoom: a.zoom, nulls: a.nulls, signal: extra.signal }); });
    return ok({ ...out, project: e.path, canUndo: e.canUndo });
  });
  tool('mask_track', 'Seguimiento de máscara', 'Mask tracker like After Effects: the mask follows what is inside it in a VIDEO layer (it picks the detailed spots inside the mask and fits the motion per frame), creating keyframes of the mask path. method: position (default), similarity (position, scale and rotation) or perspective (planar tracking like Mocha: up to 40 points and a homography per frame with RANSAC; follows a flat surface seen in perspective). With perspective and target (a layer), the result is Corner Pin keyframes on that layer instead (screen replacement): the mask first four vertices are the surface corners top-left, top-right, bottom-right, bottom-left. From at to to (comp seconds).', {
    ...P, ...C, ...L, mask: z.string(), at: z.number().min(0).optional(), to: z.number().min(0).optional(), method: z.enum(['position', 'similarity', 'perspective']).optional(), target: z.string().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, async (e) => { const c = pickComp(e.project, a.comp); return trackMask(e, c.id, layerId(c, a.layer), a.mask, { at: a.at ?? 0, to: a.to, method: a.method, target: a.target ? layerId(c, a.target) : undefined }); });
    return ok({ ...out, project: e.path, canUndo: e.canUndo });
  });
  tool('puppet_pin', 'Marioneta', 'Puppet tool like After Effects: pins bend a layer (its opaque area becomes a mesh; each part follows the nearest pins, turning without shearing). add {at [x, y]} puts a pin there (comp px, or layer px with layer_space); move {pin, to [x, y], t, ease} moves it — with t it sets a keyframe (animate it); remove {pin}; density (mesh triangle size px, default 12) / expansion (px past the edge, default 3) / on. Pins that never move change nothing: pin what must stay (feet), move what must bend (an arm). Animate later with prop_set puppet.<pin>.position (layer px).', {
    ...P, ...C, ...L, action: z.enum(['add', 'move', 'remove', 'set']), at: z.array(z.number()).length(2).optional(), to: z.array(z.number()).length(2).optional(), pin: z.string().optional(), name: z.string().optional(),
    t: z.number().min(0).optional(), ease: easeEnum.optional(), layer_space: z.boolean().optional().describe('at / to are layer px instead of comp px.'),
    density: z.number().optional(), expansion: z.number().optional(), on: z.boolean().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp);
      const lid = layerId(c, a.layer);
      const l = c.layers.find((x) => x.id === lid)!;
      // comp px → layer px at the time of the edit
      const local = (p: number[]) => { if (a.layer_space) return p; const inv = M.invert(M.worldMatrix(c, l, a.t ?? 0)); const r = M.apply(inv, p[0], p[1], 0); return [r[0], r[1]]; };
      if (a.action === 'add') { if (!a.at) throw new Error('Indique at [x, y].'); return M.motionOps.puppetSet(e, c.id, lid, { add: { at: local(a.at), name: a.name } }); }
      if (a.action === 'remove') { if (!a.pin) throw new Error('Indique pin.'); return M.motionOps.puppetSet(e, c.id, lid, { remove: a.pin }); }
      if (a.action === 'move') {
        if (!a.pin || !a.to) throw new Error('Indique pin y to [x, y].');
        const pin = l.puppet?.pins.find((x) => x.id === a.pin || x.name === a.pin);
        if (!pin) throw new Error(`No existe el pin «${a.pin}».`);
        return M.motionOps.propSet(e, c.id, lid, `puppet.${pin.id}.position`, { value: local(a.to), t: a.t, ease: a.ease });
      }
      return M.motionOps.puppetSet(e, c.id, lid, { density: a.density, expansion: a.expansion, on: a.on });
    });
    return ok({ ...out, project: e.path, canUndo: e.canUndo });
  });
  tool('layer_style', 'Estilo de capa', 'Layer styles like After Effects / Photoshop (drawn after masks and effects, one of each per layer): dropShadow {color, opacity, angle, distance, spread, size}, innerShadow {color, opacity, angle, distance, choke, size}, outerGlow {color, opacity, spread, size}, innerGlow {color, opacity, source edge|center, choke, size}, bevel {style inner|outer|emboss|pillow, depth, direction up|down, size, soften, angle, altitude, highlightColor, highlightOpacity, shadowColor, shadowOpacity}, colorOverlay {color, opacity}, gradientOverlay {startColor, endColor, opacity, type linear|radial, angle, scale, reverse}, stroke {color, size, opacity, position outside|inside|center}. Calling it again changes values; on false hides it; remove true deletes it. Animate with prop_set styles.<style>.<param> (e.g. styles.dropShadow.distance).', {
    ...P, ...C, ...L, style: z.enum(['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'bevel', 'colorOverlay', 'gradientOverlay', 'stroke']), values: z.record(z.string(), val).optional(), on: z.boolean().optional(), remove: z.boolean().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.styleSet(e, c.id, layerId(c, a.layer), a.style, { values: a.values, on: a.on, remove: a.remove }); });
    return ok({ style: out, project: e.path, canUndo: e.canUndo });
  });
  tool('import_as_comp', 'Importar como composición', 'Import a layered Illustrator (.ai saved with PDF compatibility, or a vector .pdf) or Photoshop (.psd) file as a composition (a Premiere Pro .prproj or a Maya .ma scene also works: see premiere_import / maya_import). Illustrator: like After Effects Import As Composition + Create Shapes from Vector Layer, each Illustrator layer becomes a shape layer whose paths keep fill, stroke, width, caps, joins, dashes, opacity and compound holes (live text, images, gradients and clipping are reported in warnings: outline text in Illustrator first). Photoshop: like After Effects Import As: Composition - Retain Layer Sizes: each pixel layer is an image layer at its own size and place (its raster mask baked into the alpha), groups become nested comps, and blend mode, opacity, visibility, clipping masks (alpha mattes), vector masks (masks), layer effects (layer styles) and adjustment layers (adjustment layer + Levels / Curves / Hue-Saturation / Brightness-Contrast / Exposure / Vibrance / Color Balance / Black & White / Photo Filter / Invert / Posterize / Threshold) stay editable. editable_text: text layers become Cinta text layers instead of pictures. The layer pictures are saved as PNG in a "<file> capas" folder next to the project.', {
    ...P, path: z.string(), name: z.string().optional(), editable_text: z.boolean().optional(),
  }, async (a) => {
    const file = resolve(a.path);
    if (!existsSync(file)) throw new Error(`No existe el archivo: ${file}`);
    // Premiere Pro projects and Maya scenes (import-tools.ts)
    if (/\.(prproj|ma)$/i.test(file)) return importProjectFile(H, { project: a.project, path: file, name: a.name });
    if (/\.(ai|pdf)$/i.test(file)) {
      const { e, out } = await edit(a.project, (e) => aiImport(e, file, { name: a.name }));
      return ok({ ...summary(e, out.comp), layers: out.layers, paths: out.paths, ...(out.warnings.length ? { warnings: out.warnings } : {}) });
    }
    if (!/\.psd$/i.test(file)) throw new Error('Formato no admitido: use un .psd, un .ai o un .pdf.');
    const { e, out } = await edit(a.project, (e) => psdImport(e, file, { name: a.name, editableText: a.editable_text }));
    return ok({ ...summary(e, out.comp), layers: out.layers, nestedComps: out.comps - 1, folder: out.folder, ...(out.warnings.length ? { warnings: out.warnings } : {}) });
  });
  tool('comp_export_lottie', 'Exportar a Lottie', 'Export a composition as Lottie (Bodymovin JSON, for web and apps: lottie-web, lottie-ios, lottie-android). Exports nested comps, solids, images (embedded), nulls, shapes (rect, ellipse, star, polygon, path, compound paths, fill, gradient, stroke, dashes, trim, repeater, round corners, pucker, twist, zigzag, offset, merge), text, masks, track mattes, parenting, blend modes, time remap and markers. Keyframe eases and curved motion paths are kept; expressions are baked one key per frame. warnings lists what Lottie cannot carry (effects, layer styles, 3D, video, audio, text animators).', {
    ...P, ...C, output: z.string().describe('Path of the .json file.'),
  }, (a) => {
    const e = Editor.load(projectPath(a.project), true);
    const r = compToLottie(e.project, pickComp(e.project, a.comp).id);
    const file = resolve(/\.json$/i.test(a.output) ? a.output : `${a.output}.json`);
    const text = JSON.stringify(r.json);
    writeFileSync(file, text);
    return ok({ file, bytes: text.length, layers: (r.json.layers as unknown[]).length, assets: (r.json.assets as unknown[]).length, ...(r.warnings.length ? { warnings: r.warnings } : {}) });
  }, { readOnly: true });
  tool('essential_props', 'Gráficos esenciales', 'Essential Graphics (After Effects): expose properties of the layers of a comp so every comp layer that nests it can change them without opening it (Master Properties), and so it can be exported as a template. action add: comp + layer + path (any prop_set path, e.g. text.text, text.fill, effects.Brillo.radius, shapes.Caja.fill.color, position; or "source" on an image / video layer for Media Replacement) + optional name / index. remove / rename (name) / move (index 1 = first): key = exposed name, id or 1-based index. list: the exposed properties and the layers that nest the comp with their overrides. reset: on a comp layer of comp (layer), drop the override key (all without key) and use the nested comp value again. To change a value: prop_set on the nesting layer with path essential.<name>.', {
    ...P, ...C, action: z.enum(['add', 'remove', 'rename', 'move', 'list', 'reset']), layer: z.string().optional(), path: z.string().optional(), key: z.string().optional(), name: z.string().optional(), index: z.number().int().min(1).optional(),
  }, async (a) => {
    const need = <T>(x: T | undefined, what: string): T => { if (x === undefined || x === '') throw new Error(`Indique ${what}.`); return x; };
    const { e, out } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp);
      switch (a.action) {
        case 'add': return M.motionOps.essentialAdd(e, c.id, layerId(c, need(a.layer, 'layer')), need(a.path, 'path'), { name: a.name, index: a.index });
        case 'remove': M.motionOps.essentialRemove(e, c.id, need(a.key, 'key')); return null;
        case 'rename': return M.motionOps.essentialSet(e, c.id, need(a.key, 'key'), { name: need(a.name, 'name') });
        case 'move': return M.motionOps.essentialSet(e, c.id, need(a.key, 'key'), { index: need(a.index, 'index') });
        case 'reset': return { reset: M.motionOps.essentialReset(e, c.id, layerId(c, need(a.layer, 'layer (la capa de composición)')), a.key) };
        default: return null;
      }
    });
    const c = pickComp(e.project, a.comp);
    const used = (e.project.comps ?? []).flatMap((x) => x.layers.filter((l) => l.type === 'comp' && l.compId === c.id).map((l) => ({ comp: x.name, layer: l.name, id: l.id, overrides: Object.fromEntries((l.overrides ?? []).map((o) => [o.name, o.prop.k?.length ? `${o.prop.k.length} claves` : o.prop.v])) })));
    return ok({ result: out, comp: c.name, essential: (c.essential ?? []).map((x, i) => ({ index: i + 1, id: x.id, name: x.name, layer: c.layers.find((y) => y.id === x.layer)?.name ?? '(capa eliminada)', path: x.path, value: c.layers.some((y) => y.id === x.layer) ? M.essentialDefault(c, x) : null })), nestedIn: used, project: e.path, canUndo: e.canUndo });
  });
  tool('template_export', 'Exportar plantilla de animación', 'Export a comp with Essential Graphics as a Motion Graphics template (Cinta template file, .cintaplantilla: the comp, the comps it nests, its media paths and its exposed properties). Import it in any project with template_import.', {
    ...P, ...C, output: z.string().describe('Path of the .cintaplantilla file.'),
  }, (a) => {
    const e = Editor.load(projectPath(a.project), true);
    const t = M.templateExport(e.project, pickComp(e.project, a.comp).id);
    const file = resolve(/\.cintaplantilla$/i.test(a.output) ? a.output : `${a.output}.cintaplantilla`);
    writeFileSync(file, JSON.stringify(t, null, 1));
    return ok({ file, name: t.name, comps: t.comps.length, media: t.media.map((m) => m.path), essential: t.essential });
  }, { readOnly: true });
  tool('template_import', 'Importar plantilla de animación', 'Import a Motion Graphics template (.cintaplantilla from template_export): adds its comps and media to the project. With into (comp id or name) it also places it as a comp layer on top of that comp; then change its exposed properties with prop_set path essential.<name> on that layer.', {
    ...P, file: z.string(), name: z.string().optional().describe('Name for the main comp.'), into: z.string().optional(), start: z.number().min(0).optional(),
  }, async (a) => {
    let t: motion.MotionTemplate;
    try { t = JSON.parse(readFileSync(resolve(a.file), 'utf8')) as motion.MotionTemplate; } catch (err) { throw new Error(`No se pudo leer la plantilla: ${(err as Error).message}`); }
    const missing = (t.media ?? []).filter((m) => !existsSync(m.path)).map((m) => m.path);
    const { e, out } = await edit(a.project, (e) => {
      const c = M.templateImport(e, t, { name: a.name });
      const layer = a.into ? M.motionOps.layerAdd(e, pickComp(e.project, a.into).id, 'comp', { compId: c.id, start: a.start }) : null;
      return { c, layer };
    });
    return ok({ comp: { id: out.c.id, name: out.c.name }, layer: out.layer ? { id: out.layer.id, name: out.layer.name } : null, essential: (out.c.essential ?? []).map((x) => x.name), ...(missing.length ? { missingMedia: missing } : {}), project: e.path, canUndo: e.canUndo });
  });

  tool('mask_add', 'Nueva máscara', 'Mask a layer (layer pixels): shape rect / ellipse (x, y, width, height) or path ([x, y, x, y…] points), mode add|subtract|intersect|none, feather, expansion, opacity, inverted. Animate with prop_set masks.<name>.feather / path.', {
    ...P, ...C, ...L, shape: z.enum(['rect', 'ellipse', 'path']).optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().positive().optional(), height: z.number().positive().optional(),
    path: z.array(z.number()).optional(), bezier: z.boolean().optional().describe('path is [x, y, inX, inY, outX, outY…] (tangents relative to each vertex) instead of [x, y…] points.'), mode: z.enum(['add', 'subtract', 'intersect', 'none']).optional(), feather: z.number().min(0).optional(), expansion: z.number().optional(), opacity: z.number().min(0).max(100).optional(), inverted: z.boolean().optional(), name: z.string().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.maskAdd(e, c.id, layerId(c, a.layer), { shape: a.shape, x: a.x, y: a.y, width: a.width, height: a.height, path: a.path, bezier: a.bezier, mode: a.mode, feather: a.feather, expansion: a.expansion, opacity: a.opacity, inverted: a.inverted, name: a.name }); });
    return ok({ mask: { id: out.id, name: out.name }, project: e.path, canUndo: e.canUndo });
  });
  tool('mask_interpolate', 'Interpolación inteligente de máscaras', 'Smart Mask Interpolation (After Effects keyframe assistant): adds mask-path keyframes between consecutive keys of a mask (in [from, to], default all) so the outline morphs smoothly, even between shapes with different vertex counts. Vertices are matched by the least work of stretching and bending one outline into the other. Options with the assistant defaults: rate (keyframes/s, default the comp rate), fields (doubles it), linear (true: vertices move in straight lines; false: they travel on curved paths, for parts that turn), bending (0-100, 50), quality (0 first-to-first … 100 any pair, 50), add_vertices {mode pixels|total|percent, value} (default 9 pixels between vertices; false to use only the given vertices), matching auto|curve|polyline, one_to_one (vertex k to vertex k), first_match (true; false tries every starting vertex, slow).', {
    ...P, ...C, ...L, mask: z.string(), from: z.number().min(0).optional(), to: z.number().min(0).optional(), rate: z.number().min(1).max(120).optional(), fields: z.boolean().optional(), linear: z.boolean().optional(),
    bending: z.number().min(0).max(100).optional(), quality: z.number().min(0).max(100).optional(),
    add_vertices: z.union([z.literal(false), z.object({ mode: z.enum(['pixels', 'total', 'percent']), value: z.number().min(0.04).max(10000) })]).optional(),
    matching: z.enum(['auto', 'curve', 'polyline']).optional(), one_to_one: z.boolean().optional(), first_match: z.boolean().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.maskInterpolate(e, c.id, layerId(c, a.layer), a.mask, { from: a.from, to: a.to, rate: a.rate, fields: a.fields, linear: a.linear, bending: a.bending, quality: a.quality, addVertices: a.add_vertices, matching: a.matching, oneToOne: a.one_to_one, firstMatch: a.first_match }); });
    return ok({ ...out, message: `Se añadieron ${out.keys} fotogramas clave de trazado de máscara`, project: e.path, canUndo: e.canUndo });
  });
  tool('mask_set', 'Cambiar máscara', 'Change mask mode / inverted / name, or remove it.', { ...P, ...C, ...L, mask: z.string(), mode: z.enum(['add', 'subtract', 'intersect', 'none']).optional(), inverted: z.boolean().optional(), name: z.string().optional(), remove: z.boolean().optional() }, async (a) => {
    const { e } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); M.motionOps.maskSet(e, c.id, layerId(c, a.layer), a.mask, { mode: a.mode, inverted: a.inverted, name: a.name, remove: a.remove }); });
    return ok({ project: e.path, canUndo: e.canUndo });
  });

  tool('shape_add', 'Nueva forma', 'Add a vector shape: rect (roundness), ellipse, star (points, innerRadius), polygon, or path ([x, y…] points, closed). Fill color (null = none) or gradient {type linear|radial, colors}, stroke + strokeWidth + dash, trim {start, end, offset} (animate end 0→100 to draw it on), repeater {copies, position, scale, rotation, startOpacity, endOpacity}, wiggle paths {size px, detail = features along the outline, speed wiggles/s, phase, seed, smooth false = sharp corners (rock, ice)} for organic / liquid / flame edges, zigzag {size, ridges, smooth}; path operators like After Effects: pucker {amount}, round_corners {radius}, twist {angle, center}, offset {amount, join, miter_limit}; stroke_gradient {type, colors}. kind merge (Combinar trazados) with merge_mode add|subtract|intersect|exclude replaces the closed shapes below it with their boolean result, drawn with the color / stroke of the merge item. position is relative to the comp centre. Without layer a new shape layer is created; with layer the new shape is drawn ON TOP of the existing ones (like After Effects), so add the base first and the details after.', {
    ...P, ...C, layer: z.string().optional(), kind: z.enum(['rect', 'ellipse', 'star', 'polygon', 'path', 'merge']), width: z.number().positive().optional(), height: z.number().positive().optional(),
    color: z.string().nullable().optional(), stroke: z.string().optional(), stroke_width: z.number().min(0).optional(), dash: z.array(z.number()).optional(), points: z.number().int().min(3).max(100).optional(), inner_radius: z.number().optional(), roundness: z.number().min(0).optional(),
    path: z.array(z.number()).optional(), bezier: z.boolean().optional().describe('path given as bezier vertices [x, y, inX, inY, outX, outY…] (curves) instead of [x, y…] points.'), closed: z.boolean().optional(), position: z.array(z.number()).length(2).optional(), name: z.string().optional(),
    gradient: z.object({ type: z.enum(['linear', 'radial']).optional(), colors: z.array(z.string()).min(2), start: z.array(z.number()).length(2).optional(), end: z.array(z.number()).length(2).optional() }).optional(),
    trim: z.object({ start: z.number().optional(), end: z.number().optional(), offset: z.number().optional() }).optional(),
    repeater: z.object({ copies: z.number().int().min(1).max(500), position: z.array(z.number()).length(2).optional(), scale: z.array(z.number()).length(2).optional(), rotation: z.number().optional(), startOpacity: z.number().optional(), endOpacity: z.number().optional() }).optional(),
    wiggle: z.object({ size: z.number().optional(), detail: z.number().int().min(2).max(2000).optional(), speed: z.number().optional(), phase: z.number().optional(), seed: z.number().int().optional(), smooth: z.boolean().optional() }).optional(),
    zigzag: z.object({ size: z.number().optional(), ridges: z.number().int().min(1).max(2000).optional(), smooth: z.boolean().optional() }).optional(),
    pucker: z.object({ amount: z.number().optional() }).nullable().optional().describe('Contraer y engordar: amount % (+ bloat = petals, − pucker = spikes).'),
    round_corners: z.object({ radius: z.number().min(0).optional() }).nullable().optional(),
    twist: z.object({ angle: z.number().optional(), center: z.array(z.number()).length(2).optional() }).nullable().optional(),
    offset: z.object({ amount: z.number().optional(), join: z.enum(['miter', 'round', 'bevel']).optional(), miter_limit: z.number().min(1).optional() }).nullable().optional().describe('Desplazar trazados: amount px (+ grows, − shrinks).'),
    merge_mode: z.enum(['add', 'subtract', 'intersect', 'exclude']).optional().describe('For kind merge: boolean of the closed shapes BELOW it (since the previous merge): add = union, subtract = the bottom one minus the others, intersect, exclude = xor.'),
    stroke_gradient: z.object({ type: z.enum(['linear', 'radial']).optional(), colors: z.array(z.string()).min(2), start: z.array(z.number()).length(2).optional(), end: z.array(z.number()).length(2).optional() }).nullable().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp);
      return M.motionOps.shapeAdd(e, c.id, a.layer ? layerId(c, a.layer) : undefined, { kind: a.kind, width: a.width, height: a.height, color: a.color, stroke: a.stroke, strokeWidth: a.stroke_width, dash: a.dash, points: a.points, innerRadius: a.inner_radius, roundness: a.roundness, path: a.path, bezier: a.bezier, closed: a.closed, position: a.position, gradient: a.gradient, trim: a.trim, repeater: a.repeater, wiggle: a.wiggle, zigzag: a.zigzag, name: a.name, pucker: a.pucker ?? undefined, roundCorners: a.round_corners ?? undefined, twist: a.twist ?? undefined, offset: a.offset ? { amount: a.offset.amount, join: a.offset.join, miterLimit: a.offset.miter_limit } : undefined, mergeMode: a.merge_mode, strokeGradient: a.stroke_gradient ?? undefined });
    });
    return ok({ layer: { id: out.layer.id, name: out.layer.name }, shape: { id: out.shape.id, name: out.shape.name }, project: e.path, canUndo: e.canUndo });
  });

  tool('shape_set', 'Cambiar forma', 'Change an existing shape: fill / stroke on or off, cap, join, dash, closed; add or change trim paths {start, end, offset} and repeater {copies, position, scale, rotation, startOpacity, endOpacity}; gradient {type, colors, start, end}; wiggle paths {size, detail, speed, phase, seed, smooth}; zigzag {size, ridges, smooth}; pucker, round_corners, twist, offset, stroke_gradient, merge_mode; to_path: true converts a rect / ellipse / star / polygon into an editable path (then animate shapes.<shape>.path, morphing between keys of any vertex count); pass null to remove trim / repeater / gradient / wiggle / zigzag / pucker / round_corners / twist / offset / stroke_gradient; remove: true deletes the shape. Animate values afterwards with prop_set (shapes.<shape>.trim.end…).', {
    ...P, ...C, ...L, shape: z.string(), name: z.string().optional(), fill: z.boolean().optional(), stroke: z.boolean().optional(),
    cap: z.enum(['butt', 'round', 'square']).optional(), join: z.enum(['miter', 'round', 'bevel']).optional(), dash: z.array(z.number()).optional(), closed: z.boolean().optional(), to_path: z.boolean().optional(),
    trim: z.object({ start: z.number().optional(), end: z.number().optional(), offset: z.number().optional() }).nullable().optional(),
    repeater: z.object({ copies: z.number().int().min(1).max(500).optional(), position: z.array(z.number()).length(2).optional(), scale: z.array(z.number()).length(2).optional(), rotation: z.number().optional(), startOpacity: z.number().optional(), endOpacity: z.number().optional() }).nullable().optional(),
    gradient: z.object({ type: z.enum(['linear', 'radial']).optional(), colors: z.array(z.string()).min(2), start: z.array(z.number()).length(2).optional(), end: z.array(z.number()).length(2).optional() }).nullable().optional(),
    wiggle: z.object({ size: z.number().optional(), detail: z.number().int().min(2).max(2000).optional(), speed: z.number().optional(), phase: z.number().optional(), seed: z.number().int().optional(), smooth: z.boolean().optional() }).nullable().optional(),
    zigzag: z.object({ size: z.number().optional(), ridges: z.number().int().min(1).max(2000).optional(), smooth: z.boolean().optional() }).nullable().optional(),
    pucker: z.object({ amount: z.number().optional() }).nullable().optional().describe('Contraer y engordar: amount % (+ bloat = petals, − pucker = spikes).'),
    round_corners: z.object({ radius: z.number().min(0).optional() }).nullable().optional(),
    twist: z.object({ angle: z.number().optional(), center: z.array(z.number()).length(2).optional() }).nullable().optional(),
    offset: z.object({ amount: z.number().optional(), join: z.enum(['miter', 'round', 'bevel']).optional(), miter_limit: z.number().min(1).optional() }).nullable().optional().describe('Desplazar trazados: amount px (+ grows, − shrinks).'),
    merge_mode: z.enum(['add', 'subtract', 'intersect', 'exclude']).optional().describe('For kind merge: boolean of the closed shapes BELOW it (since the previous merge): add = union, subtract = the bottom one minus the others, intersect, exclude = xor.'),
    stroke_gradient: z.object({ type: z.enum(['linear', 'radial']).optional(), colors: z.array(z.string()).min(2), start: z.array(z.number()).length(2).optional(), end: z.array(z.number()).length(2).optional() }).nullable().optional(),
    remove: z.boolean().optional(),
  }, async (a) => {
    const { e } = await edit(a.project, (e) => {
      const c = pickComp(e.project, a.comp);
      const lid = layerId(c, a.layer);
      if (a.remove) { M.motionOps.shapeRemove(e, c.id, lid, a.shape); return; }
      M.motionOps.shapeSet(e, c.id, lid, a.shape, { name: a.name, fill: a.fill, stroke: a.stroke, cap: a.cap, join: a.join, dash: a.dash, closed: a.closed, toPath: a.to_path, trim: a.trim, repeater: a.repeater, gradient: a.gradient, wiggle: a.wiggle, zigzag: a.zigzag, pucker: a.pucker, roundCorners: a.round_corners, twist: a.twist, offset: a.offset ? { amount: a.offset.amount, join: a.offset.join, miterLimit: a.offset.miter_limit } : a.offset, mergeMode: a.merge_mode, strokeGradient: a.stroke_gradient });
    });
    return ok(summary(e, pickComp(e.project, a.comp)));
  });

  tool('text_animator_remove', 'Quitar animador de texto', 'Remove a text animator (id or name) from a text layer.', { ...P, ...C, ...L, animator: z.string() }, async (a) => {
    const { e } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); M.motionOps.textAnimatorRemove(e, c.id, layerId(c, a.layer), a.animator); });
    return ok(summary(e, pickComp(e.project, a.comp)));
  }, { destructive: true });

  tool('text_animator_add', 'Animador de texto', 'Animate text per character, word or line (After Effects text animators). props: any of position [x,y] ([x,y,z] with per-character 3D), scale [x,y] %, rotation, rotationY, rotationX (per-character 3D), opacity, fill, stroke, tracking, blur, skew, charOffset, and for extruded 3D text frontColor / bevelColor / sideColor / backColor — the value applied at full selection. selector: range {start, end, offset (%), amount, basedOn chars|charsNoSpace|words|lines, shape square|rampUp|rampDown|triangle|round|smooth, randomize, seed} or {type: wiggly, maxAmount, minAmount, speed, correlation}. Animate the selector with prop_set (e.g. text.animators.<name>.selectors.0.offset keys -30 → 100 with shape rampUp = characters arrive one after another). Or use preset_apply for ready-made text animations.', {
    ...P, ...C, ...L, name: z.string().optional(), props: z.record(z.string(), val),
    selector: z.object({ type: z.enum(['range', 'wiggly']).optional(), start: z.number().optional(), end: z.number().optional(), offset: z.number().optional(), amount: z.number().optional(), basedOn: z.enum(['chars', 'charsNoSpace', 'words', 'lines']).optional(), shape: z.enum(['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth']).optional(), mode: z.enum(['add', 'subtract', 'intersect']).optional(), randomize: z.boolean().optional(), seed: z.number().optional(), maxAmount: z.number().optional(), minAmount: z.number().optional(), speed: z.number().optional(), correlation: z.number().optional() }).nullable().optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.motionOps.textAnimatorAdd(e, c.id, layerId(c, a.layer), { name: a.name, props: a.props as never, selector: a.selector }); });
    return ok({ animator: { id: out.id, name: out.name }, project: e.path, canUndo: e.canUndo });
  });

  tool('preset_apply', 'Ajuste preestablecido', `Apply a Cinta animation preset (catalog_list kind "motion_presets"): behaviours (fadeIn, slideInLeft, popIn, elasticScale, dropBounce, squashBounce (endless bounce with squash & stretch; the layer's position is the floor contact, amount = jump height px, duration = one bounce), wiggle…, float, shake, swing, kenBurns), text (typewriter, fadeUpChars, dropChars, blurInWords, decode, wave, flipChars…), transitions (linearWipeIn/Out, irisIn…), backgrounds (bgGradient, bgParticles, bgNoise, bgGrid, bgSnow, bgRain, lightLeak — create their own layer) and camera (cameraPush, cameraOrbit). at / duration (s) override the timing; amount, color, colors tune some presets.`, {
    ...P, ...C, preset: z.string(), layers: z.array(z.string()).optional(), at: z.number().min(0).optional(), duration: z.number().min(0.01).optional(), amount: z.number().optional(), color: z.string().optional(), colors: z.array(z.string()).optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => { const c = pickComp(e.project, a.comp); return M.presetApply(e, c.id, a.preset, (a.layers ?? []).map((x) => layerId(c, x)), { at: a.at, duration: a.duration, amount: a.amount, color: a.color, colors: a.colors }); });
    return ok({ layers: out, ...summary(e, pickComp(e.project, a.comp)) });
  });

  tool('comp_frame', 'Ver fotograma de composición', 'Render one frame of a composition (exactly as exported) and return it as an image so you can check the animation (default 960 px wide).', {
    ...P, ...C, time: z.number().min(0), width: z.number().int().min(64).max(7680).optional(), output: z.string().optional(),
  }, async (a, extra) => {
    const path = projectPath(a.project);
    const e = Editor.load(path);
    const c = pickComp(e.project, a.comp);
    const out = resolve(a.output ?? join(cacheDir('frames'), `comp_${c.id}_${Math.round(a.time * 1000)}_${Date.now()}.png`));
    mkdirSync(resolve(out, '..'), { recursive: true });
    const r = await renderViaApp({ project: path, compId: c.id, output: out, still: a.time, scale: (a.width ?? 960) / c.width }, extra.signal);
    return ok({ path: out, time: a.time, comp: c.name, ...((r.errors as string[])?.length ? { layerErrors: r.errors } : {}) }, [{ data: readFileSync(out).toString('base64'), mimeType: 'image/png' }]);
  }, { readOnly: true });

  tool('comp_render', 'Exportar composición', `Render a composition to a file (the work area unless from/to). formats: ${COMP_FORMATS.map((f) => `${f.id} (${f.name})`).join(', ')}. Sound of video/audio/nested layers is mixed in. scale 0.5 renders half size.`, {
    ...P, ...C, output: z.string(), format: z.string().optional(), from: z.number().min(0).optional(), to: z.number().min(0).optional(), scale: z.number().min(0.1).max(4).optional(), quality: z.enum(['high', 'medium', 'low']).optional(),
  }, async (a, extra) => {
    const path = projectPath(a.project);
    const c = pickComp(Editor.load(path).project, a.comp);
    const r = await renderViaApp({ project: path, compId: c.id, output: resolve(a.output), format: a.format, from: a.from, to: a.to, scale: a.scale, quality: a.quality }, extra.signal);
    return ok(r);
  });

  const settingsSchema = z.object({
    resolution: z.number().min(0.05).max(4).optional().describe('1 full, 0.5 half, 0.3333 third, 0.25 quarter.'),
    span: z.union([z.enum(['workArea', 'comp']), z.tuple([z.number().min(0), z.number().min(0)])]).optional().describe('workArea (default), comp (whole length) or [from, to] seconds.'),
    fps: z.number().min(1).max(120).nullable().optional().describe('Frame rate (null: the comp rate).'),
    motion_blur: z.enum(['comp', 'off']).optional(), proxies: z.enum(['none', 'current', 'all', 'comps']).optional().describe('none (default, final quality), current (proxies switched on), all, comps (comp proxies only).'),
    quality: z.enum(['best', 'draft']).optional(),
  }).optional();
  const outputSchema = z.object({ format: z.string().optional(), path: z.string().optional().describe('File or template ([projectName] [compName] [width] [height] [frameRate] [fileExtension] [date]); relative to the project folder. Default [compName].[fileExtension].'), audio: z.boolean().optional(), quality: z.enum(['high', 'medium', 'low']).optional() });
  const toSettings = (s: z.infer<typeof settingsSchema>) => s && Object.fromEntries(Object.entries({ resolution: s.resolution, span: s.span, fps: s.fps, motionBlur: s.motion_blur, proxies: s.proxies, quality: s.quality }).filter(([, v]) => v !== undefined));
  const queueView = (p: Project) => (p.renderQueue ?? []).map((it, i) => ({ index: i + 1, id: it.id, comp: p.comps?.find((c) => c.id === it.compId)?.name ?? '(eliminada)', status: it.status, settings: it.settings, outputs: it.outputs.map((o, j) => ({ index: j + 1, id: o.id, format: o.format, path: o.path, audio: o.audio })), ...(it.log ? { log: it.log } : {}) }));
  tool('render_queue', 'Cola de render', `The render queue (After Effects): items render in order, each with Render Settings and one or more Output Modules; every frame is drawn once and encoded into all of the item outputs at the same time. action add: comp + settings + outputs (default one MP4 named [compName].[fileExtension] next to the project). set: item (id or 1-based index) + status queued|unqueued / settings / outputs (replace) / add_output / remove_output / index (move). remove: items (or ["done"]). list. render: renders the queued items (or items) and records status (done / failed) and a log per item. Output formats: ${COMP_FORMATS.map((f) => f.id).join(', ')}.`, {
    ...P, action: z.enum(['add', 'set', 'remove', 'list', 'render']), comp: z.string().optional(), item: z.string().optional(), items: z.array(z.string()).optional(),
    status: z.enum(['queued', 'unqueued']).optional(), settings: settingsSchema, outputs: z.array(outputSchema).optional(), add_output: outputSchema.optional(), remove_output: z.string().optional(), index: z.number().int().min(1).optional(),
  }, async (a, extra) => {
    const path = projectPath(a.project);
    if (a.action === 'list') return ok({ queue: queueView(Editor.load(path, true).project) });
    if (a.action === 'render') {
      const p0 = Editor.load(path, true).project;
      const ids = a.items?.length ? a.items.map((k) => (p0.renderQueue ?? [])[Number(k) - 1]?.id ?? k) : (p0.renderQueue ?? []).filter((x) => x.status === 'queued').map((x) => x.id);
      if (!ids.length) throw new Error('No hay elementos en cola: añádalos con render_queue add (o márquelos queued).');
      const results = (await renderViaApp({ project: path, queue: ids }, extra.signal)) as unknown as { id: string; status: 'done' | 'failed' | 'stopped'; log: motion.RenderItem['log'] }[];
      const { e } = await edit(path, (e) => { for (const r of results) M.motionOps.queueSet(e, r.id, { status: r.status, log: r.log }); });
      return ok({ rendered: results.map((r) => ({ id: r.id, status: r.status, files: r.log?.files, seconds: r.log?.seconds, ...(r.log?.error ? { error: r.log.error } : {}) })), queue: queueView(e.project) });
    }
    const need = <T>(x: T | undefined, what: string): T => { if (x === undefined) throw new Error(`Indique ${what}.`); return x; };
    const { e, out } = await edit(path, (e) => {
      switch (a.action) {
        case 'add': return M.motionOps.queueAdd(e, pickComp(e.project, a.comp).id, { settings: toSettings(a.settings) as never, outputs: a.outputs });
        case 'set': return M.motionOps.queueSet(e, need(a.item, 'item'), { status: a.status, settings: toSettings(a.settings) as never, outputs: a.outputs, addOutput: a.add_output, removeOutput: a.remove_output, index: a.index });
        default: return { removed: M.motionOps.queueRemove(e, a.items?.[0] === 'done' ? 'done' : need(a.items, 'items')) };
      }
    });
    return ok({ result: 'id' in (out as object) ? { id: (out as motion.RenderItem).id } : out, queue: queueView(e.project), project: e.path, canUndo: e.canUndo });
  });

  tool('proxy', 'Proxy', 'Proxies (After Effects: Create Proxy / Set Proxy). target media (media id or file path of a video or image in the project): create renders a smaller copy (scale 0.5 default) into a «Proxies» folder next to the project; the advanced mode draws it at the original size while on. target comp: create renders the comp (with alpha) once and every layer nesting it draws that movie instead of computing it (pre-render). set: use an existing file (path). on / off: switch. remove. Renders and comp_render use no proxies unless asked (render_queue settings.proxies).', {
    ...P, action: z.enum(['create', 'set', 'on', 'off', 'remove']), media: z.string().optional(), comp: z.string().optional(), scale: z.number().min(0.05).max(1).optional(), path: z.string().optional(),
  }, async (a, extra) => {
    const path = projectPath(a.project);
    const dir = join(dirname(path), 'Proxies');
    if (!a.media === !a.comp) throw new Error('Indique media o comp (uno de los dos).');
    if (a.media) {
      if (a.action === 'create') {
        const m = Editor.load(path, true).project.media.find((x) => x.id === a.media || resolve(x.path) === resolve(a.media!));
        if (!m) throw new Error(`No existe el archivo «${a.media}» en el proyecto.`);
        const px = await createFootageProxy(m, dir, a.scale ?? 0.5);
        const { out } = await edit(path, (e) => M.motionOps.mediaProxySet(e, m.id, { path: px.path, width: px.width, height: px.height, on: true }));
        return ok({ media: out.id, proxy: out.proxy });
      }
      const { out } = await edit(path, (e) => M.motionOps.mediaProxySet(e, a.media!, a.action === 'set' ? { path: resolve(a.path ?? ''), on: true } : a.action === 'remove' ? { remove: true } : { on: a.action === 'on' }));
      return ok({ media: out.id, proxy: out.proxy ?? null });
    }
    const c = pickComp(Editor.load(path, true).project, a.comp);
    if (a.action === 'create') {
      const r = (await renderViaApp({ project: path, compId: c.id, compProxy: { dir, scale: a.scale ?? 1 } }, extra.signal)) as unknown as { path: string; hash: string };
      const { out } = await edit(path, (e) => M.motionOps.compProxySet(e, c.id, { path: r.path, hash: r.hash, on: true }));
      return ok({ comp: out.name, proxy: out.proxy });
    }
    const { e, out } = await edit(path, (e) => M.motionOps.compProxySet(e, c.id, a.action === 'set' ? { path: resolve(a.path ?? ''), on: true } : a.action === 'remove' ? { remove: true } : { on: a.action === 'on' }));
    // a comp proxy does not follow later changes (as in After Effects): say when it is out of date
    return ok({ comp: out.name, proxy: out.proxy ?? null, ...(out.proxy?.hash && out.proxy.hash !== compHash(e.project, out.id) ? { outdated: true } : {}) });
  });

  tool('disk_cache', 'Caché de disco', 'Disk cache of preview frames (After Effects Disk Cache): frames are kept as PNG keyed by the comp, its nested comps, its media files, the frame, preview resolution and motion-blur samples, so they are reused across sessions and after undo, and redrawn after any change. action info: folder, size, frames. status: which frames of comp (at res, default 0.5) are cached. fill: Cache Work Area in Background (from / to seconds, default the work area). clear: empty it. Used by this server cache; the Cinta window keeps its own.', {
    ...P, ...C, action: z.enum(['info', 'status', 'fill', 'clear']), res: z.number().min(0.05).max(2).optional(), from: z.number().min(0).optional(), to: z.number().min(0).optional(),
  }, async (a, extra) => {
    const dir = join(cacheDir(), 'diskcache');
    if (a.action === 'info' || a.action === 'clear') {
      const dc = new DiskCache(dir, 10 * 1024 ** 3, '');
      if (a.action === 'clear') return ok({ cleared: dc.clear(), dir });
      return ok(dc.info());
    }
    const path = projectPath(a.project), c = pickComp(Editor.load(path, true).project, a.comp);
    const res = a.res ?? 0.5, mbSamples = Math.min(c.motionBlur.samples, res < 1 ? 8 : c.motionBlur.samples);
    const r = await renderViaApp({ project: path, compId: c.id, cache: { action: a.action, res, mbSamples, from: a.from, to: a.to } }, extra.signal);
    return ok({ comp: c.name, res, ...r });
  }, { readOnly: true });

  tool('exr_info', 'Canales EXR', 'Channels of an OpenEXR file (as After Effects / ProEXR list them): layers and their channels, compression, Cryptomatte layers with the object names of their manifest, and the sequence the file belongs to.', {
    path: z.string(), names: z.number().int().min(0).max(5000).optional().describe('How many manifest names to list per Cryptomatte layer (default 200).'),
  }, (a) => {
    const file = resolve(a.path);
    const h = readExrHeader(readFileSync(file));
    const seq = findSequence(file);
    return ok({ file, width: h.displayWindow[2] - h.displayWindow[0] + 1, height: h.displayWindow[3] - h.displayWindow[1] + 1, compression: EXR_COMPRESSION[h.compression] ?? h.compression,
      layers: exrLayers(h.channels.map((c) => c.name)), cryptomatte: cryptoLayers(h).map((c) => ({ name: c.name, channels: c.channels, names: c.manifest ? Object.keys(c.manifest).slice(0, a.names ?? 200) : null })),
      ...(seq ? { sequence: { pattern: seq.pattern, first: seq.first, last: seq.last, frames: seq.count } } : {}) });
  }, { readOnly: true });
  tool('exr_import', 'Importar EXR', 'Import an OpenEXR file or numbered sequence (shot.0001.exr …) as footage, like After Effects: the beauty (RGBA) becomes viewable footage, and every other channel — depth, normals, object IDs, Cryptomatte — stays readable by the 3D Channel effects added with effect_add: extractor (EXtractoR: any channels to RGBA, black/white point, unmult), identifier (IDentifier: object ID colours, luma or alpha matte of one id, raw) and cryptomatte (matte of objects by name, wildcards with the manifest; output colors|mattedColors|mattedRGBA|matte). Compressions read for the extra channels: none, RLE, ZIPS, ZIP. sequence false imports only that file; fps for sequences (default the project).', {
    ...P, path: z.string(), sequence: z.boolean().optional(), fps: z.number().min(1).max(120).optional(),
  }, async (a) => {
    const file = resolve(a.path);
    if (!existsSync(file)) throw new Error(`No existe el archivo: ${file}`);
    const { e, out } = await edit(a.project, (e) => exrImport(e, file, { sequence: a.sequence, fps: a.fps }));
    return ok({ media: { id: out.media.id, path: out.media.path, kind: out.media.kind, width: out.media.width, height: out.media.height, duration: out.media.duration }, exr: out.info, project: e.path, canUndo: e.canUndo });
  });

  tool('comp_to_timeline', 'Composición al modo simple', 'Put a composition in the simple-mode timeline as a clip (rendered with transparency; it is re-rendered automatically when the composition changes before export). track_id / at like clip_add.', {
    ...P, ...C, track_id: z.string().optional(), at: z.number().min(0).optional(),
  }, async (a, extra) => {
    const path = projectPath(a.project);
    let e = Editor.load(path, true);
    const c = pickComp(e.project, a.comp);
    const h = compHash(e.project, c.id);
    const out = motionCached(`comp_${h}.mov`);
    if (!existsSync(out)) await renderViaApp({ project: path, compId: c.id, output: out, format: 'mov-alpha' }, extra.signal);
    const r = await edit(path, async (ed) => {
      let m = ed.project.media.find((x) => x.compId === c.id);
      if (!m) {
        [m] = await ed.importMedia([out]);
        ed.mutate('Composición', (p) => { const mm = p.media.find((x) => x.id === m!.id)!; mm.compId = c.id; mm.compHash = h; });
      }
      return ed.addClip(m.id, { trackId: a.track_id, at: a.at });
    });
    e = r.e;
    return ok({ clip: { id: r.out.id, start: r.out.start, duration: r.out.out - r.out.in }, project: e.path, canUndo: e.canUndo });
  });
  registerPaintTools(H);
  registerVectorTools(H, renderViaApp);
  registerImportTools(H);
  registerTextoTools(H);
  registerCapasTools(H);
}

/** Catalogue entries of the advanced mode. */
export const MOTION_CATALOGS: Record<string, () => unknown[]> = {
  motion_effects: () => M.FX.map((f) => ({ id: f.id, name: f.name, category: f.cat, params: f.params.map((p) => ({ id: p.id, name: p.name, type: p.type, default: p.def, ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.choices ? { choices: p.choices.map((c) => c.id) } : {}) })) })),
  motion_presets: () => M.PRESETS.map((p) => ({ id: p.id, name: p.name, category: p.cat, description: p.desc, ...(p.text ? { textOnly: true } : {}), ...(p.makesLayer ? { createsLayer: true } : {}), ...(p.out ? { exit: true } : {}) })),
  motion_templates: () => M.TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.desc })),
  blend_modes: () => M.BLEND_MODES,
  comp_formats: () => [...COMP_FORMATS],
  ...PAINT_CATALOGS,
};
