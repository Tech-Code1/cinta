// Cinta's MCP server (stdio): every editor function as a tool, so an AI can edit videos.
// Runs as plain Node (ELECTRON_RUN_AS_NODE=1 Cinta.exe dist/main/mcp.js). Works on .cinta project files:
// each call loads the project, edits it, saves it atomically (with undo history next to it) and returns a
// short summary. A Cinta window that has the project open reloads it automatically.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import * as z from 'zod';
import {
  ANIMATIONS, ASPECTS, AUDIO_EFFECTS, AUDIO_ENHANCE, CALLOUTS, EQ_PRESETS, EXPORT_PRESETS, FILTERS, GENERATED, MASKS, MEDIA_EXT, PAN_ZOOM, PIP_LAYOUTS, STICKERS, TITLE_ANIMS, TITLES, TRANSITIONS,
  Editor, addMusic, autoSubtitles, clipSummary, detectBeatsMarkers, detectScenesSplit, exportProject, exportSubtitles, findIn, findWhisperModel, generateMedia, importSubtitles, mediaInfo,
  newProject, probeMedia, projectDuration, reframe, removeSilences, renderFrame, slideshow, stabilizeClip, syncAudio, toMlt,
  addSubtitleTrack, buildTranscript, chaptersText, cuesIn, cuesToTrack, findFillers, listVoices, phraseRanges, removeTimeRanges, setChapters, shortsFromRanges, speak, subtitleCues,
  timelineWords, transcriptLines, transcriptView, wordRanges, cacheDir,
  type Clip, type ColorAdjust,
} from '../core';
import { MOTION_CATALOGS, ensureCompMediaViaApp, registerMotionTools, renderViaApp } from './motion-tools';
import { registerVelocityTools } from './velocity-tools';
import { registerScriptTools } from './script-tools';
import { registerAnalysisTools } from './analysis-tools';
import { registerPanelesTools } from './paneles-tools';
import { registerRotoTools } from './roto-tools';

const VERSION = '1.0.0';
type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>; signal: AbortSignal };

const state: { current: string | null } = { current: process.env.CINTA_PROJECT ?? null };

const server = new McpServer(
  { name: 'cinta', version: VERSION },
  {
    instructions: `Cinta is a video editor (a functional clone of Movavi Video Editor) driven by these tools.
Workflow: project_new (or project_open) → media_import / clip_add → edit (clip_split, clip_trim, clip_delete, transitions, titles, filters, music…) → preview_frame to look at the result → export.
- Every tool takes "project" (path of a .cinta file); after project_new/project_open it can be omitted (the last one is used).
- Times are seconds on the timeline. The main video track is magnetic: clips butt against each other and transitions overlap them.
- clip ids come from project_get / the result of each tool. catalog_list tells you the ids of filters, transitions, title styles, stickers, export presets…
- AI helpers: remove_silences, auto_subtitles (local Whisper), reframe (9:16, 1:1…), music_add (with ducking), join_files, slideshow_create.
- AI editing — you do the thinking, Cinta the cutting: transcript_build → transcript_get → transcript_cut (edit by text), fillers_find/fillers_remove, subtitles_get → subtitles_update / subtitles_add_language (translations), chapters_set, voiceover_tts (Windows voices) and shorts_create (best moments → vertical shorts). Ready-made prompts: quitar-muletillas, editar-por-texto, traducir-subtitulos, capitulos-youtube, shorts-de-una-clase.
- undo / redo work across calls. open_in_editor shows the project in the Cinta window (it reloads on every change).
- ADVANCED MODE (After Effects-style motion graphics): comp_new or comp_template → layer_add (text, shape, solid, null, adjustment, camera, video…) → prop_set (keyframes with ease 'easy', expressions like wiggle/loopOut/inertia) / text_animator_add / shape_add / mask_add / effect_add / preset_apply → comp_frame to look at it → comp_render to a file, or comp_to_timeline to use it in the simple editor. comp_get shows the layers and what is animated. catalog_list kinds motion_effects, motion_presets, motion_templates, blend_modes, comp_formats. Paint tools (Brush, Clone Stamp, Eraser): paint_stroke / paint_list / paint_edit / paint_options, catalog paint_tips. Data-driven animation: data_import (JSON/MGJSON/CSV/TSV) + expressions with footage("file.csv").dataValue([col, row]); After Effects scripts (.jsx): run_script.`,
  },
);

function projectPath(p?: string): string {
  const path = p ? resolve(p) : state.current;
  if (!path) throw new Error('Indique "project" (ruta del archivo .cinta) o cree uno con project_new.');
  if (!existsSync(path)) throw new Error(`No existe el proyecto: ${path}`);
  state.current = path;
  return path;
}

/** Load → edit → save (with history). */
async function edit<T>(project: string | undefined, fn: (e: Editor) => T | Promise<T>): Promise<{ e: Editor; out: T }> {
  const e = Editor.load(projectPath(project), true);
  const out = await e.batch(async () => fn(e));
  e.save(e.path, true);
  return { e, out };
}

const brief = (e: Editor) => ({ project: e.path, duration: projectDuration(e.project), clips: e.project.clips.length, canUndo: e.canUndo });

function ok(data: Record<string, unknown>, images: { data: string; mimeType: string }[] = []): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 1) }, ...images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))],
    structuredContent: data,
  };
}

function progress(extra: Extra, what: string) {
  const token = extra._meta?.progressToken;
  let last = 0;
  return (f: number) => {
    if (token === undefined || Date.now() - last < 400) return;
    last = Date.now();
    void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(f * 100), total: 100, message: what } }).catch(() => {});
  };
}

type Shape = z.ZodRawShape;
function tool<S extends Shape>(name: string, title: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>, extra: Extra) => Promise<CallToolResult> | CallToolResult, o: { readOnly?: boolean; destructive?: boolean } = {}) {
  server.registerTool(name, {
    title,
    description,
    inputSchema: shape,
    annotations: { title, readOnlyHint: !!o.readOnly, destructiveHint: !!o.destructive, openWorldHint: false },
  }, (async (a: z.infer<z.ZodObject<S>>, extra: Extra) => fn(a, extra)) as never);
}

const P = { project: z.string().optional().describe('Path of the .cinta project (optional after project_new/project_open).') };
const sec = (d: string) => z.number().min(0).describe(d);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Colour "#rrggbb".');
const pos01 = z.number().min(-1).max(2);

// ───────────────────────────── project ─────────────────────────────
tool('project_new', 'Nuevo proyecto', 'Create a new empty project file (.cinta). Default 1920×1080 30 fps; "aspect" picks 16:9, 9:16, 1:1, 4:5, 4:3 or 21:9.', {
  path: z.string().describe('Where to save the .cinta file.'),
  aspect: z.string().optional(),
  width: z.number().int().min(16).max(7680).optional(),
  height: z.number().int().min(16).max(4320).optional(),
  fps: z.number().min(1).max(120).optional(),
  background: color.optional(),
  name: z.string().optional(),
  overwrite: z.boolean().optional(),
}, (a) => {
  const path = resolve(a.path.toLowerCase().endsWith('.cinta') ? a.path : `${a.path}.cinta`);
  if (existsSync(path) && !a.overwrite) throw new Error(`Ya existe ${path}. Use overwrite:true o project_open.`);
  const asp = a.aspect ? findIn(ASPECTS, a.aspect, 'Relación de aspecto') : undefined;
  const e = new Editor(newProject({ width: a.width ?? asp?.width, height: a.height ?? asp?.height, fps: a.fps, background: a.background, name: a.name }));
  e.save(path, true);
  state.current = e.path;
  return ok({ ...brief(e), settings: e.project.settings, tracks: e.project.tracks });
});

tool('project_open', 'Abrir proyecto', 'Open a .cinta project and make it the current one. Returns the full timeline and lists missing media files.', { path: z.string() }, (a) => {
  const e = Editor.load(projectPath(a.path), true);
  return ok({ ...e.summary(), missing: e.missingMedia().map((m) => ({ id: m.id, path: m.path })) });
}, { readOnly: true });

tool('project_get', 'Ver proyecto', 'Everything about the project: settings, tracks with their clips (ids, times, effects), media bin, markers, duration.', { ...P }, (a) => {
  const e = Editor.load(projectPath(a.project), true);
  return ok(e.summary() as unknown as Record<string, unknown>);
}, { readOnly: true });

tool('project_set', 'Configuración del proyecto', 'Change resolution / aspect, frame rate, background colour or name. Clips keep their aspect (letterboxed); use reframe to fill a new aspect.', {
  ...P, aspect: z.string().optional(), width: z.number().int().min(16).max(7680).optional(), height: z.number().int().min(16).max(4320).optional(),
  fps: z.number().min(1).max(120).optional(), sample_rate: z.number().int().optional(), background: color.optional(), name: z.string().optional(),
}, async (a) => {
  const { e } = await edit(a.project, (e) => e.setSettings({ aspect: a.aspect, width: a.width, height: a.height, fps: a.fps, sampleRate: a.sample_rate, background: a.background, name: a.name }));
  return ok({ ...brief(e), settings: e.project.settings });
});

tool('project_save', 'Guardar proyecto', 'Save as another file ("as"), or as a portable project ("portable_dir": copies every media file into that folder).', {
  ...P, as: z.string().optional(), portable_dir: z.string().optional(),
}, (a) => {
  const e = Editor.load(projectPath(a.project), true);
  const path = a.portable_dir ? e.savePortable(a.portable_dir) : e.save(a.as ?? e.path, true);
  state.current = path;
  return ok({ saved: path, media: e.project.media.length });
});

tool('project_append', 'Adjuntar proyecto', 'Append another .cinta project at the end of this one.', { ...P, other: z.string() }, async (a) => {
  const other = Editor.load(resolve(a.other)).project;
  const { e } = await edit(a.project, (e) => e.append(other));
  return ok(brief(e));
});

tool('project_relink', 'Reubicar archivo', 'Point a missing media file (id or old path) to its new location.', { ...P, media: z.string(), new_path: z.string() }, async (a) => {
  const { e } = await edit(a.project, (e) => e.relink(a.media, a.new_path));
  return ok({ ...brief(e), missing: e.missingMedia().map((m) => m.path) });
});

// ───────────────────────────── media ─────────────────────────────
const resolveMediaPaths = (paths: string[]) => paths.flatMap((p) => {
  const abs = resolve(p);
  if (existsSync(abs) && statSync(abs).isDirectory()) return readdirSync(abs).filter((f) => MEDIA_EXT.includes(extname(f).toLowerCase())).sort().map((f) => join(abs, f));
  return [abs];
});

tool('media_import', 'Importar', 'Add video, audio or image files (or whole folders) to the media bin. add_to_timeline:true also puts them on the timeline in order (video/images → main track, audio → audio track).', {
  ...P, paths: z.array(z.string()).min(1), add_to_timeline: z.boolean().optional(),
}, async (a) => {
  const files = resolveMediaPaths(a.paths);
  if (!files.length) throw new Error('No hay archivos multimedia compatibles en esas rutas');
  const { e, out } = await edit(a.project, async (e) => {
    const items = await e.importMedia(files);
    const clips = a.add_to_timeline ? items.map((m) => e.addClip(m.id).id) : [];
    return { items, clips };
  });
  return ok({ ...brief(e), media: out.items.map((m) => ({ id: m.id, path: m.path, kind: m.kind, duration: m.duration, width: m.width, height: m.height, hasAudio: m.hasAudio })), clips: out.clips });
});

tool('media_list', 'Contenedor de medios', 'Files in the project media bin and whether each one is used / missing.', { ...P }, (a) => {
  const e = Editor.load(projectPath(a.project));
  return ok({ media: e.project.media.map((m) => ({ ...m, used: e.project.clips.filter((c) => c.mediaId === m.id).length, missing: !existsSync(m.path) })) });
}, { readOnly: true });

tool('media_info', 'Información del archivo', 'Probe any media file: kind, duration, size, fps, audio.', { path: z.string() }, async (a) => ok(await probeMedia(a.path) as unknown as Record<string, unknown>), { readOnly: true });

tool('media_generate', 'Generar música o sonido', `Create royalty-free media with Cinta's own synthesizer: music beds (${GENERATED.music.join(', ')}), sound effects (${GENERATED.sfx.join(', ')}) or a test tone (name = frequency). Optionally adds it to the project at "at".`, {
  ...P, kind: z.enum(['music', 'sfx', 'tone']), name: z.string(), duration: z.number().min(0.1).max(3600).optional(), output: z.string().optional(), at: z.number().min(0).optional(),
}, async (a) => {
  const path = await generateMedia(a.kind, a.name, { duration: a.duration, output: a.output });
  if (a.at === undefined) return ok({ path });
  const { e, out } = await edit(a.project, async (e) => {
    const [m] = await e.importMedia([path]);
    return e.addClip(m.id, { at: a.at });
  });
  return ok({ ...brief(e), path, clip: out.id });
});

// ───────────────────────────── clips ─────────────────────────────
async function mediaId(e: Editor, ref: string) {
  try { return e.media(ref).id; } catch { /* not in the bin yet */ }
  const [m] = await e.importMedia([ref]);
  return m.id;
}

tool('clip_add', 'Añadir clip', 'Put a media file (bin id or path — imported automatically) on the timeline. Video/images go to the main track at the end (or at "at", snapped to a clip boundary); audio goes to the audio track. track_id puts it on an overlay/title/audio track at "at". in/out pick a part of the source; duration sets how long an image lasts.', {
  ...P, media: z.string(), track_id: z.string().optional(), at: z.number().min(0).optional(), in: z.number().min(0).optional(), out: z.number().min(0).optional(), duration: z.number().min(0.04).optional(),
}, async (a) => {
  const { e, out } = await edit(a.project, async (e) => e.addClip(await mediaId(e, a.media), { trackId: a.track_id, at: a.at, in: a.in, out: a.out, duration: a.duration }));
  return ok({ ...brief(e), clip: clipSummary(e.project, e.clip(out.id)) });
});

tool('color_clip_add', 'Añadir fondo de color', 'Add a solid colour or gradient ("gradient:#rrggbb,#rrggbb") clip, e.g. a title card background.', {
  ...P, fill: z.string(), duration: z.number().min(0.04).max(3600).optional(), track_id: z.string().optional(), at: z.number().min(0).optional(),
}, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.addColorClip(a.fill, a.duration ?? 4, { trackId: a.track_id, at: a.at }));
  return ok({ ...brief(e), clip: out.id });
});

tool('clip_split', 'Dividir', 'Cut clips in two at a timeline time: the given clips, or every clip under that time.', { ...P, time: sec('Timeline time'), clip_ids: z.array(z.string()).optional() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.split(a.time, a.clip_ids));
  return ok({ ...brief(e), new_clips: out.map((c) => c.id) });
});

tool('clip_trim', 'Recortar', 'Change which part of the source a clip plays (in/out in source seconds) or its duration on the timeline; "start" moves clips on free tracks.', {
  ...P, clip_id: z.string(), in: z.number().min(0).optional(), out: z.number().min(0).optional(), duration: z.number().min(0.04).optional(), start: z.number().min(0).optional(),
}, async (a) => {
  const { e } = await edit(a.project, (e) => e.trim(a.clip_id, { in: a.in, out: a.out, duration: a.duration, start: a.start }));
  return ok({ ...brief(e), clip: clipSummary(e.project, e.clip(a.clip_id)) });
});

tool('clip_move', 'Mover clip', 'Move a clip to another time and/or track. On the main track "index" (0-based) or "start" reorders the clips.', {
  ...P, clip_id: z.string(), start: z.number().min(0).optional(), track_id: z.string().optional(), index: z.number().int().min(0).optional(),
}, async (a) => {
  const { e } = await edit(a.project, (e) => e.move(a.clip_id, { start: a.start, trackId: a.track_id, index: a.index }));
  return ok({ ...brief(e), clip: clipSummary(e.project, e.clip(a.clip_id)) });
});

tool('clip_duplicate', 'Clonar clip', 'Duplicate a clip right after itself.', { ...P, clip_id: z.string() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.duplicate(a.clip_id));
  return ok({ ...brief(e), clip: out.id });
});

tool('clip_delete', 'Eliminar', 'Delete clips. The main track closes the gap (ripple) unless empty space is enabled on it.', { ...P, clip_ids: z.array(z.string()).min(1) }, async (a) => {
  const { e } = await edit(a.project, (e) => e.remove(a.clip_ids));
  return ok(brief(e));
}, { destructive: true });

tool('clip_set', 'Propiedades del clip', 'Clip properties: speed (0.1–10, keep_pitch), reverse, volume (0–4), muted, normalize, fade_in/fade_out (s), opacity (0–1), hidden, rotate (0/90/180/270), flip_h/flip_v, straighten (degrees), crop {x,y,w,h} (0–1 of the source), transform {x,y (centre, 0–1), scale, rotation} for overlays, volume_keys [{t,v}] (volume envelope).', {
  ...P, clip_id: z.string(),
  speed: z.number().min(0.1).max(10).optional(), keep_pitch: z.boolean().optional(), reverse: z.boolean().optional(),
  volume: z.number().min(0).max(4).optional(), muted: z.boolean().optional(), normalize: z.boolean().optional(),
  fade_in: z.number().min(0).optional(), fade_out: z.number().min(0).optional(), opacity: z.number().min(0).max(1).optional(), hidden: z.boolean().optional(),
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(), flip_h: z.boolean().optional(), flip_v: z.boolean().optional(),
  straighten: z.number().min(-45).max(45).optional(),
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) }).nullable().optional(),
  transform: z.object({ x: pos01, y: pos01, scale: z.number().min(0.01).max(10), rotation: z.number() }).partial().optional(),
  volume_keys: z.array(z.object({ t: z.number().min(0), v: z.number().min(0).max(4) })).nullable().optional(),
  name: z.string().optional(),
}, async (a) => {
  const patch: Partial<Clip> = {};
  const map: [keyof typeof a, keyof Clip][] = [['speed', 'speed'], ['keep_pitch', 'keepPitch'], ['reverse', 'reverse'], ['volume', 'volume'], ['muted', 'muted'], ['normalize', 'normalize'], ['fade_in', 'fadeIn'], ['fade_out', 'fadeOut'], ['opacity', 'opacity'], ['hidden', 'hidden'], ['rotate', 'rotate'], ['flip_h', 'flipH'], ['flip_v', 'flipV'], ['straighten', 'straighten'], ['crop', 'crop'], ['volume_keys', 'volumeKeys'], ['name', 'name']];
  for (const [k, ck] of map) if (a[k] !== undefined) (patch as Record<string, unknown>)[ck] = a[k];
  const { e } = await edit(a.project, (e) => {
    if (a.transform) {
      const c = e.clip(a.clip_id);
      patch.transform = { x: 0.5, y: 0.5, scale: c.type === 'sticker' || c.type === 'callout' ? 0.3 : 1, rotation: 0, ...c.transform, ...a.transform };
    }
    return e.set(a.clip_id, patch);
  });
  return ok({ ...brief(e), clip: clipSummary(e.project, e.clip(a.clip_id)) });
});

tool('clip_color', 'Ajustes de color', 'Colour correction: preset (auto-contrast, auto-saturation, white-balance, magic) and/or manual values -1..1 (brightness, contrast, saturation, temperature, tint, exposure, gamma, shadows, highlights), hue (degrees), sharpen/vignette (0..1), lut (path to a .cube file). reset:true clears it.', {
  ...P, clip_id: z.string(), reset: z.boolean().optional(),
  preset: z.enum(['auto-contrast', 'auto-saturation', 'white-balance', 'magic']).nullable().optional(),
  brightness: z.number().min(-1).max(1).optional(), contrast: z.number().min(-1).max(1).optional(), saturation: z.number().min(-1).max(1).optional(),
  hue: z.number().min(-180).max(180).optional(), temperature: z.number().min(-1).max(1).optional(), tint: z.number().min(-1).max(1).optional(),
  exposure: z.number().min(-1).max(1).optional(), gamma: z.number().min(-1).max(1).optional(), shadows: z.number().min(-1).max(1).optional(), highlights: z.number().min(-1).max(1).optional(),
  sharpen: z.number().min(0).max(1).optional(), vignette: z.number().min(0).max(1).optional(), lut: z.string().nullable().optional(),
}, async (a) => {
  const { project: _p, clip_id, reset, ...vals } = a;
  void _p;
  if (vals.lut && !existsSync(vals.lut)) throw new Error(`No existe el LUT: ${vals.lut}`);
  const { e } = await edit(a.project, (e) => {
    const cur: ColorAdjust = reset ? {} : { ...e.clip(clip_id).color };
    for (const [k, v] of Object.entries(vals)) {
      if (v === null) delete (cur as Record<string, unknown>)[k];
      else if (v !== undefined) (cur as Record<string, unknown>)[k] = k === 'lut' ? resolve(v as string) : v;
    }
    return e.set(clip_id, { color: Object.keys(cur).length ? cur : (null as never) });
  });
  return ok({ ...brief(e), color: e.clip(clip_id).color ?? null });
});

tool('clip_filter_add', 'Aplicar filtro', 'Apply a video filter from the catalogue (catalog_list kind "filters") with an intensity 0..1.', { ...P, clip_id: z.string(), filter: z.string(), amount: z.number().min(0).max(1).optional() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.addFilter(a.clip_id, a.filter, a.amount ?? 1));
  return ok({ ...brief(e), filter: out });
});

tool('clip_filter_set', 'Ajustar filtro', 'Change the intensity of an applied filter or switch it on/off (filter id or type).', { ...P, clip_id: z.string(), filter: z.string(), amount: z.number().min(0).max(1).optional(), enabled: z.boolean().optional() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.setFilter(a.clip_id, a.filter, { amount: a.amount, enabled: a.enabled }));
  return ok({ ...brief(e), filter: out });
});

tool('clip_filter_remove', 'Quitar filtro', 'Remove one applied filter (id or type) or all of them.', { ...P, clip_id: z.string(), filter: z.string().optional() }, async (a) => {
  const { e } = await edit(a.project, (e) => e.removeFilter(a.clip_id, a.filter));
  return ok({ ...brief(e), filters: e.clip(a.clip_id).filters });
});

tool('clip_audio', 'Edición de audio', 'Audio tools for a clip with sound: equalizer (eq_preset from catalog "eq_presets" or eq = 10 gains in dB for 31,62,125,250,500,1k,2k,4k,8k,16k Hz), compressor, noise gate, reverb, noise removal (denoise 0..1), auto enhance (studio | noisy | voice), effect (catalog "audio_effects": echo, robot, phone, radio, pitch…). null removes a setting; reset clears all.', {
  ...P, clip_id: z.string(), reset: z.boolean().optional(),
  eq_preset: z.string().nullable().optional(), eq: z.array(z.number().min(-20).max(20)).length(10).nullable().optional(),
  compressor: z.object({ threshold: z.number().max(0), ratio: z.number().min(1).max(20), attack: z.number().min(0.01).max(2000), release: z.number().min(0.01).max(9000), makeup: z.number().min(0).max(36), mix: z.number().min(0).max(1) }).partial().nullable().optional(),
  gate: z.object({ threshold: z.number().max(0), range: z.number(), attack: z.number().min(0.01), release: z.number().min(0.01) }).partial().nullable().optional(),
  reverb: z.object({ delay: z.number().min(1).max(2000), decay: z.number().min(0).max(1), wet: z.number().min(0).max(1) }).partial().nullable().optional(),
  denoise: z.number().min(0).max(1).nullable().optional(), enhance: z.enum(['studio', 'noisy', 'voice']).nullable().optional(), effect: z.string().nullable().optional(),
}, async (a) => {
  if (a.eq_preset) findIn(EQ_PRESETS, a.eq_preset, 'Preset de ecualizador');
  if (a.effect) findIn(AUDIO_EFFECTS, a.effect, 'Efecto de audio');
  const { e } = await edit(a.project, (e) => {
    const c = e.clip(a.clip_id);
    const cur: Record<string, unknown> = a.reset ? {} : { ...c.audio };
    const defs = { compressor: { threshold: -18, ratio: 3, attack: 20, release: 250, makeup: 2, mix: 1 }, gate: { threshold: -40, range: 30, attack: 10, release: 200 }, reverb: { delay: 60, decay: 0.4, wet: 0.4 } };
    for (const k of ['eq_preset', 'eq', 'compressor', 'gate', 'reverb', 'denoise', 'enhance', 'effect'] as const) {
      const key = k === 'eq_preset' ? 'eqPreset' : k;
      const v = a[k];
      if (v === null) delete cur[key];
      else if (v !== undefined) cur[key] = typeof v === 'object' && !Array.isArray(v) ? { ...defs[k as keyof typeof defs], ...(cur[key] as object), ...v } : v;
    }
    return e.set(a.clip_id, { audio: Object.keys(cur).length ? cur : (null as never) });
  });
  return ok({ ...brief(e), audio: e.clip(a.clip_id).audio ?? null });
});

tool('clip_detach_audio', 'Separar audio', 'Move the sound of a video clip to its own clip on the audio track (to edit or delete it separately).', { ...P, clip_id: z.string() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.detachAudio(a.clip_id));
  return ok({ ...brief(e), audio_clip: out.id });
});

tool('clip_freeze_frame', 'Insertar fotograma fijo', 'Insert a still of the frame at "time" (main track) lasting "duration" seconds.', { ...P, time: sec('Timeline time'), duration: z.number().min(0.1).max(60).optional() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.freezeFrame(a.time, a.duration ?? 3));
  return ok({ ...brief(e), clip: out.id });
});

tool('clip_chroma', 'Clave de croma', 'Make a colour transparent (green/blue screen) on an overlay clip. null removes it. tolerance 0.01–1, blend 0–1 (soft edge).', {
  ...P, clip_id: z.string(), color: color.nullable(), tolerance: z.number().min(0.01).max(1).optional(), blend: z.number().min(0).max(1).optional(), noise: z.number().min(0).max(1).optional(), edges: z.number().min(0).max(1).optional(), opacity: z.number().min(0).max(1).optional(),
}, async (a) => {
  const { e } = await edit(a.project, (e) => e.set(a.clip_id, { chroma: a.color === null ? (null as never) : { color: a.color, tolerance: a.tolerance ?? 0.15, blend: a.blend ?? 0.05, noise: a.noise ?? 0, edges: a.edges ?? 0, opacity: a.opacity ?? 1 } }));
  return ok({ ...brief(e), chroma: e.clip(a.clip_id).chroma ?? null, note: e.track(e.clip(a.clip_id).trackId).kind === 'main' ? 'La clave de croma se ve sobre lo que hay debajo: mueva el clip a una pista de vídeo superpuesto.' : undefined });
});

tool('clip_pip', 'Imagen en imagen', `Place an overlay clip with a picture-in-picture layout: ${PIP_LAYOUTS.map((l) => l.id).join(', ')} (null = full frame).`, { ...P, clip_id: z.string(), layout: z.string().nullable() }, async (a) => {
  const { e } = await edit(a.project, (e) => e.set(a.clip_id, { pip: a.layout ?? (null as never), transform: null as never }));
  return ok({ ...brief(e), pip: e.clip(a.clip_id).pip ?? null });
});

tool('clip_pan_zoom', 'Panorámica y zoom', `Camera movement inside the frame: preset (${PAN_ZOOM.map((x) => x.id).join(', ')}) or manual from/to {x,y (centre 0–1), zoom ≥1}. null removes it.`, {
  ...P, clip_id: z.string(), preset: z.string().nullable().optional(),
  from: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), zoom: z.number().min(1).max(5) }).optional(),
  to: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), zoom: z.number().min(1).max(5) }).optional(),
}, async (a) => {
  const { e } = await edit(a.project, (e) => {
    if (a.preset === null) return e.set(a.clip_id, { panZoom: null as never });
    if (!a.preset && !(a.from && a.to)) throw new Error('Indique preset o from y to');
    return e.set(a.clip_id, { panZoom: { preset: a.preset ?? undefined, from: a.from ?? { x: 0.5, y: 0.5, zoom: 1 }, to: a.to ?? { x: 0.5, y: 0.5, zoom: 1.3 } } });
  });
  return ok({ ...brief(e), panZoom: e.clip(a.clip_id).panZoom ?? null });
});

tool('clip_mask', 'Resaltar y esconder', `Hide (blur, pixelate, black) or highlight (light, bright) an area of a main-track clip: preset (${MASKS.map((m) => m.id).join(', ')}), area x,y (centre) w,h in 0–1, feather, opacity, invert. "track": [{t,x,y}] follows a moving object (t = seconds from clip start). null removes it.`, {
  ...P, clip_id: z.string(), preset: z.string().nullable(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), w: z.number().min(0.01).max(1).optional(), h: z.number().min(0.01).max(1).optional(),
  feather: z.number().min(0).max(1).optional(), opacity: z.number().min(0).max(1).optional(), invert: z.boolean().optional(), shape: z.enum(['ellipse', 'rect']).optional(),
  track: z.array(z.object({ t: z.number().min(0), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).optional(),
}, async (a) => {
  const { project: _p, clip_id, preset, ...o } = a;
  void _p;
  const { e } = await edit(a.project, (e) => e.setMask(clip_id, preset, Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))));
  return ok({ ...brief(e), mask: e.clip(clip_id).mask ?? null });
});

tool('clip_animate', 'Animación', `Entry/exit animation of an overlay clip (title, sticker, PiP): ${ANIMATIONS.map((x) => x.id).join(', ')}. null removes.`, {
  ...P, clip_id: z.string(),
  in: z.object({ type: z.string(), duration: z.number().min(0.05).max(10).default(0.6) }).nullable().optional(),
  out: z.object({ type: z.string(), duration: z.number().min(0.05).max(10).default(0.6) }).nullable().optional(),
}, async (a) => {
  const { e } = await edit(a.project, (e) => e.set(a.clip_id, { ...(a.in !== undefined ? { animIn: a.in ?? (null as never) } : {}), ...(a.out !== undefined ? { animOut: a.out ?? (null as never) } : {}) }));
  const c = e.clip(a.clip_id);
  return ok({ ...brief(e), animIn: c.animIn ?? null, animOut: c.animOut ?? null });
});

tool('clip_keyframe', 'Fotogramas clave', 'Keyframe animation of an overlay clip: list of {t (s from clip start), x, y (centre 0–1), scale, rotation (deg), opacity}. mode "replace" (default), "add" or "clear".', {
  ...P, clip_id: z.string(), mode: z.enum(['replace', 'add', 'clear']).optional(),
  keyframes: z.array(z.object({ t: z.number().min(0), x: pos01.optional(), y: pos01.optional(), scale: z.number().min(0.01).max(10).optional(), rotation: z.number().optional(), opacity: z.number().min(0).max(1).optional() })).optional(),
}, async (a) => {
  const { e } = await edit(a.project, (e) => {
    const c = e.clip(a.clip_id);
    if (a.mode === 'clear') return e.set(a.clip_id, { keyframes: null as never });
    const list = [...(a.mode === 'add' ? c.keyframes ?? [] : []), ...(a.keyframes ?? [])].sort((x, y) => x.t - y.t);
    return e.set(a.clip_id, { keyframes: list });
  });
  return ok({ ...brief(e), keyframes: e.clip(a.clip_id).keyframes ?? [] });
});

tool('clip_stabilize', 'Estabilización', 'Remove camera shake from a video clip (vid.stab, two passes: analysis now, correction on export). accuracy 1–15, shakiness 1–10, smoothing (frames), crop keep|black, zoom %.', {
  ...P, clip_id: z.string(), accuracy: z.number().int().min(1).max(15).optional(), shakiness: z.number().int().min(1).max(10).optional(), smoothing: z.number().int().min(1).max(100).optional(), crop: z.enum(['keep', 'black']).optional(), zoom: z.number().min(-50).max(50).optional(), remove: z.boolean().optional(),
}, async (a, extra) => {
  if (a.remove) {
    const { e } = await edit(a.project, (e) => e.set(a.clip_id, { stabilize: null as never }));
    return ok(brief(e));
  }
  const { e, out } = await edit(a.project, (e) => stabilizeClip(e, a.clip_id, { ...a, onProgress: progress(extra, 'Estabilizando') }));
  return ok({ ...brief(e), ...out });
});

// ───────────────────────────── transitions, titles, graphics ─────────────────────────────
tool('transition_set', 'Transición', 'Transition from a main-track clip into the next one (catalog "transitions"; null removes). The clips overlap by its duration.', { ...P, clip_id: z.string(), type: z.string().nullable(), duration: z.number().min(0.1).max(10).optional() }, async (a) => {
  const { e } = await edit(a.project, (e) => e.setTransition(a.clip_id, a.type, a.duration ?? 1));
  return ok({ ...brief(e), transition: e.clip(a.clip_id).transition ?? null });
});

tool('transition_wizard', 'Asistente para transiciones', 'Add the same transition (or "random") between all main-track clips (or clip_ids); null removes them all. photo_duration sets how long photos last.', {
  ...P, type: z.string().nullable().optional(), duration: z.number().min(0.1).max(10).optional(), photo_duration: z.number().min(0.2).max(600).optional(), clip_ids: z.array(z.string()).optional(),
}, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.transitionWizard({ type: a.type === undefined ? 'random' : a.type, duration: a.duration, photoDuration: a.photo_duration, clipIds: a.clip_ids }));
  return ok({ ...brief(e), transitions: out });
});

const titleShape = {
  font: z.string().optional(), size: z.number().min(8).max(400).optional(), color: color.optional(), bold: z.boolean().optional(), italic: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']).optional(), outline: z.number().min(0).max(40).optional(), outline_color: color.optional(), shadow: z.number().min(0).max(40).optional(),
  background: z.boolean().optional(), background_color: color.optional(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(),
  anim: z.string().optional(), anim_speed: z.number().min(0.25).max(4).optional(), timer_from: z.number().int().min(0).max(3600).optional(),
  highlight: color.optional().describe('Karaoke animation: colour of the word being spoken.'), uppercase: z.boolean().optional(),
};
const titleProps = (a: Record<string, unknown>) => {
  const m: Record<string, string> = { outline_color: 'outlineColor', background_color: 'backgroundColor', anim_speed: 'animSpeed', timer_from: 'timerFrom' };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(titleShape)) if (a[k] !== undefined) out[m[k] ?? k] = a[k];
  if (out.anim) findIn(TITLE_ANIMS, out.anim as string, 'Animación de texto');
  return out;
};

tool('title_add', 'Añadir título', 'Add a text title on a title track (catalog "titles" for styles; "\\n" = new line). start/duration in seconds; font, size (px at 1080p), colours, outline, shadow, background box, position x/y (0–1), text animation (catalog "title_animations").', {
  ...P, text: z.string().min(1), style: z.string().optional(), start: z.number().min(0).optional(), duration: z.number().min(0.1).max(3600).optional(), track_id: z.string().optional(), ...titleShape,
}, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.addTitle(a.text, { style: a.style, start: a.start, duration: a.duration, trackId: a.track_id, ...titleProps(a) }));
  return ok({ ...brief(e), clip: clipSummary(e.project, e.clip(out.id)) });
});

tool('title_set', 'Editar título', 'Change the text or any style property of a title clip.', { ...P, clip_id: z.string(), text: z.string().optional(), style: z.string().optional(), ...titleShape }, async (a) => {
  const { e } = await edit(a.project, (e) => {
    const c = e.clip(a.clip_id);
    if (!c.title) throw new Error('Ese clip no es un título');
    const base = a.style ? { ...findIn(TITLES, a.style, 'Estilo de título').style, style: a.style } : {};
    return e.set(a.clip_id, { title: { ...c.title, ...base, ...(a.text ? { text: a.text } : {}), ...titleProps(a) } });
  });
  return ok({ ...brief(e), clip: clipSummary(e.project, e.clip(a.clip_id)) });
});

const graphicShape = { start: z.number().min(0).optional(), duration: z.number().min(0.1).max(3600).optional(), x: pos01.optional(), y: pos01.optional(), scale: z.number().min(0.01).max(10).optional(), rotation: z.number().optional(), color: color.optional(), track_id: z.string().optional() };

tool('sticker_add', 'Añadir adhesivo', 'Add a sticker (catalog "stickers") at a position (x,y centre 0–1) and size (scale, 1 ≈ frame height).', { ...P, name: z.string(), ...graphicShape }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.addGraphic('sticker', a.name, { start: a.start, duration: a.duration, trackId: a.track_id, color: a.color, x: a.x, y: a.y, scale: a.scale, rotation: a.rotation }));
  return ok({ ...brief(e), clip: clipSummary(e.project, e.clip(out.id)) });
});

tool('callout_add', 'Añadir llamada', 'Add a callout (arrow, frame, shape, sign — catalog "callouts") in a colour, to point at something.', { ...P, shape: z.string(), ...graphicShape }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.addGraphic('callout', a.shape, { start: a.start, duration: a.duration, trackId: a.track_id, color: a.color, x: a.x, y: a.y, scale: a.scale, rotation: a.rotation }));
  return ok({ ...brief(e), clip: clipSummary(e.project, e.clip(out.id)) });
});

tool('logo_add', 'Añadir logotipo', 'Put an image (logo / watermark) over the whole video in a corner.', { ...P, path: z.string(), corner: z.enum(['tl', 'tr', 'bl', 'br', 'center']).optional(), scale: z.number().min(0.02).max(1).optional(), opacity: z.number().min(0).max(1).optional() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.addLogo(a.path, { corner: a.corner, scale: a.scale, opacity: a.opacity }));
  return ok({ ...brief(e), clip: out.id });
});

// ───────────────────────────── tracks, markers, history ─────────────────────────────
tool('track_add', 'Añadir pista', 'Add a track: title, overlay (extra video / PiP) or audio.', { ...P, kind: z.enum(['title', 'overlay', 'audio']), name: z.string().optional() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.addTrack(a.kind, a.name));
  return ok({ ...brief(e), track: out });
});

tool('track_set', 'Pista', 'Hide/show, mute, lock a track; gaps:true allows empty space on the main track; duck:true lowers an audio track while others have sound; linked:false lets a title/overlay track stay put when the main track is edited (by default its clips follow the picture they sit on).', {
  ...P, track_id: z.string(), hidden: z.boolean().optional(), muted: z.boolean().optional(), locked: z.boolean().optional(), gaps: z.boolean().optional(), duck: z.boolean().optional(), linked: z.boolean().optional(), name: z.string().optional(),
}, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.setTrack(a.track_id, { hidden: a.hidden, muted: a.muted, locked: a.locked, gaps: a.gaps, duck: a.duck, linked: a.linked, name: a.name }));
  return ok({ ...brief(e), track: out });
});

tool('track_remove', 'Eliminar pista', 'Delete a track and its clips (not the main track).', { ...P, track_id: z.string() }, async (a) => {
  const { e } = await edit(a.project, (e) => e.removeTrack(a.track_id));
  return ok(brief(e));
}, { destructive: true });

tool('timeline_close_gaps', 'Eliminar espacio vacío', 'Close the empty space between clips on one track or all.', { ...P, track_id: z.string().optional() }, async (a) => {
  const { e } = await edit(a.project, (e) => e.closeGaps(a.track_id));
  return ok(brief(e));
});

tool('marker_add', 'Agregar marcador', 'Add a named marker at a timeline time.', { ...P, time: sec('Time'), name: z.string().optional() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.addMarker(a.time, a.name));
  return ok({ ...brief(e), marker: out });
});

tool('marker_remove', 'Eliminar marcador', 'Remove a marker (or all markers when marker_id is omitted).', { ...P, marker_id: z.string().optional() }, async (a) => {
  const { e } = await edit(a.project, (e) => e.removeMarker(a.marker_id));
  return ok({ ...brief(e), markers: e.project.markers });
});

tool('undo', 'Deshacer', 'Undo the last change to the project.', { ...P }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.undo());
  if (!out) throw new Error('No hay nada que deshacer');
  return ok({ ...brief(e), canRedo: e.canRedo });
});

tool('redo', 'Rehacer', 'Redo the last undone change.', { ...P }, async (a) => {
  const { e, out } = await edit(a.project, (e) => e.redo());
  if (!out) throw new Error('No hay nada que rehacer');
  return ok({ ...brief(e), canRedo: e.canRedo });
});

// ───────────────────────────── analysis and AI helpers ─────────────────────────────
tool('detect_scenes', 'Detectar escenas', 'Find scene changes in a video clip and split it there.', { ...P, clip_id: z.string(), threshold: z.number().min(0.05).max(0.9).optional(), min_scene: z.number().min(0.2).optional() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => detectScenesSplit(e, a.clip_id, { threshold: a.threshold, minScene: a.min_scene }));
  return ok({ ...brief(e), ...out });
});

tool('detect_beats', 'Detectar compases', 'Find the beats of a music clip and add "Ritmo" markers (to cut on the beat).', { ...P, clip_id: z.string(), min_interval: z.number().min(0.1).max(5).optional() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => detectBeatsMarkers(e, a.clip_id, { minInterval: a.min_interval }));
  return ok({ ...brief(e), ...out });
});

tool('sync_audio', 'Sincronizar audio', 'Line up clip_b with clip_a by their sound (e.g. external mic with camera audio). Clips must be on different tracks; clip_b is moved.', { ...P, clip_a: z.string(), clip_b: z.string() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => syncAudio(e, a.clip_a, a.clip_b));
  return ok({ ...brief(e), ...out });
});

tool('remove_silences', 'Quitar silencios', 'Cut out pauses/silences from the main-track clips (or clip_ids): threshold_db (default -35), min_silence (s, default 0.6), padding kept around speech (s, default 0.12).', {
  ...P, clip_ids: z.array(z.string()).optional(), threshold_db: z.number().min(-80).max(-5).optional(), min_silence: z.number().min(0.1).max(10).optional(), padding: z.number().min(0).max(1).optional(),
}, async (a) => {
  const { e, out } = await edit(a.project, (e) => removeSilences(e, { clipIds: a.clip_ids, threshold: a.threshold_db, minSilence: a.min_silence, padding: a.padding }));
  return ok({ ...brief(e), ...out });
});

tool('auto_subtitles', 'Subtítulos automáticos', 'Transcribe the speech of the main track locally (Whisper, no internet) and add it as subtitles on a "Subtítulos" title track. style "subtitle" (classic), "subtitle-shorts" (big, few words) or "subtitle-karaoke" (shorts look, the spoken word lights up in gold); words = words per caption; language es/en/pt… (auto if omitted); srt_path also writes a .srt.', {
  ...P, language: z.string().optional(), style: z.string().optional(), max_chars: z.number().int().min(8).max(80).optional(), words: z.number().int().min(1).max(12).optional(), srt_path: z.string().optional(), model_dir: z.string().optional(), clip_ids: z.array(z.string()).optional(),
}, async (a, extra) => {
  if (!findWhisperModel(a.model_dir)) throw new Error('No hay ningún modelo Whisper instalado: copie un modelo sherpa-onnx-whisper y silero_vad.onnx en %APPDATA%\\Cinta\\models (o indique model_dir).');
  const { e, out } = await edit(a.project, (e) => autoSubtitles(e, { language: a.language, style: a.style, maxChars: a.max_chars, words: a.words, srtPath: a.srt_path, modelDir: a.model_dir, clipIds: a.clip_ids, onProgress: progress(extra, 'Transcribiendo') }));
  return ok({ ...brief(e), ...out });
});

tool('subtitles_import', 'Importar subtítulos', 'Load a .srt file as title clips on a "Subtítulos" track.', { ...P, path: z.string(), style: z.string().optional(), offset: z.number().optional() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => importSubtitles(e, a.path, { style: a.style, offset: a.offset }));
  return ok({ ...brief(e), ...out });
});

tool('subtitles_export', 'Exportar subtítulos', 'Write the titles of a track (default: all title tracks) to a .srt file.', { ...P, path: z.string(), track_id: z.string().optional() }, (a) => {
  const e = Editor.load(projectPath(a.project));
  return ok(exportSubtitles(e, a.path, { trackId: a.track_id }));
}, { readOnly: true });

tool('reframe', 'Reencuadrar', 'Convert the project to another aspect (9:16 for Shorts/Reels/TikTok, 1:1, 4:5, 16:9…). mode "face" fills the frame and follows the face of the speaker (Windows face detection, smoothed); "blur" keeps the whole picture over a blurred copy; "crop" fills the frame (focus_x/focus_y choose what to keep); "fit" letterboxes.', {
  ...P, aspect: z.string(), mode: z.enum(['face', 'blur', 'crop', 'fit']).optional(), focus_x: z.number().min(0).max(1).optional(), focus_y: z.number().min(0).max(1).optional(),
}, async (a, extra) => {
  const { e, out } = await edit(a.project, (e) => reframe(e, { aspect: a.aspect, mode: a.mode, focusX: a.focus_x, focusY: a.focus_y, onProgress: progress(extra, 'Buscando caras') }));
  return ok({ ...brief(e), ...out });
});

tool('music_add', 'Añadir música', 'Background music under the whole project (looped to fit) on a "Música" track that ducks (gets quieter) while there is speech. path = audio file, or generated:<name> (see media_generate).', {
  ...P, path: z.string(), volume: z.number().min(0).max(2).optional(), duck: z.boolean().optional(), fade_in: z.number().min(0).optional(), fade_out: z.number().min(0).optional(), start: z.number().min(0).optional(), loop: z.boolean().optional(),
}, async (a) => {
  let path = a.path;
  const { e: probe } = { e: Editor.load(projectPath(a.project)) };
  if (path.startsWith('generated:')) path = await generateMedia('music', path.slice(10), { duration: Math.min(600, Math.max(10, projectDuration(probe.project) + 2)) });
  const { e, out } = await edit(a.project, (e) => addMusic(e, path, { volume: a.volume, duck: a.duck, fadeIn: a.fade_in, fadeOut: a.fade_out, start: a.start, loop: a.loop }));
  return ok({ ...brief(e), ...out, path });
});

tool('voiceover_add', 'Grabar voz (añadir)', 'Add a recorded voice-over file at a timeline time on a "Voz" audio track.', { ...P, path: z.string(), at: z.number().min(0).optional() }, async (a) => {
  const { e, out } = await edit(a.project, async (e) => {
    let t = e.project.tracks.find((x) => x.kind === 'audio' && x.name === 'Voz');
    if (!t) t = e.addTrack('audio', 'Voz');
    const [m] = await e.importMedia([a.path]);
    return e.addClip(m.id, { trackId: t.id, at: a.at ?? 0 });
  });
  return ok({ ...brief(e), clip: out.id });
});

tool('slideshow_create', 'Asistente de presentación', 'Build a slideshow from photos/videos: duration per photo, transitions (type or random), gentle pan & zoom, optional music.', {
  ...P, paths: z.array(z.string()).min(1), photo_duration: z.number().min(0.5).max(60).optional(), transition: z.string().optional(), transition_duration: z.number().min(0.1).max(5).optional(), pan_zoom: z.boolean().optional(), music: z.string().optional(),
}, async (a) => {
  const { e, out } = await edit(a.project, (e) => slideshow(e, resolveMediaPaths(a.paths), { photoDuration: a.photo_duration, transition: a.transition, transitionDuration: a.transition_duration, panZoom: a.pan_zoom, music: a.music }));
  return ok({ ...brief(e), ...out });
});

tool('join_files', 'Unir archivos', 'Join several video/audio files into one file in order (optionally with a transition between them). No project needed.', {
  paths: z.array(z.string()).min(1), output: z.string(), transition: z.string().optional(), transition_duration: z.number().min(0.1).max(5).optional(), preset: z.string().optional(), quality: z.enum(['draft', 'good', 'high']).optional(),
}, async (a, extra) => {
  const files = resolveMediaPaths(a.paths);
  const first = await probeMedia(files[0]);
  const e = new Editor(newProject({ width: first.width || 1920, height: first.height || 1080, fps: Math.round(first.fps) || 30 }));
  const items = await e.importMedia(files);
  for (const m of items) e.addClip(m.id);
  if (a.transition) e.transitionWizard({ type: a.transition, duration: a.transition_duration ?? 1 });
  const r = await exportProject(e.project, { output: a.output, preset: a.preset, quality: a.quality ?? 'good', onProgress: progress(extra, 'Uniendo'), signal: extra.signal });
  return ok({ ...r, files: files.length });
});

// ───────────────────────────── output ─────────────────────────────
tool('export', 'Exportar', 'Render the project to a file. preset from catalog "export_presets" (mp4, mp4-1080p, shorts, webm, gif, mp3, wav…) or inferred from the extension; quality draft|good|high; or custom crf / video_bitrate ("8M") with bitrate_mode cbr|vbr, codec_preset (ultrafast…veryslow), fps; from/to export only a range ("Exportar selección"); loudnorm:true normalises loudness to -14 LUFS (or a number).', {
  ...P, output: z.string(), preset: z.string().optional(), quality: z.enum(['draft', 'good', 'high']).optional(), crf: z.number().int().min(0).max(51).optional(),
  video_bitrate: z.string().regex(/^\d+(\.\d+)?[kKmM]?$/).optional(), bitrate_mode: z.enum(['auto', 'cbr', 'vbr']).optional(), audio_bitrate: z.string().regex(/^\d+[kK]$/).optional(),
  codec_preset: z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']).optional(), fps: z.number().min(1).max(120).optional(),
  from: z.number().min(0).optional(), to: z.number().min(0).optional(), loudnorm: z.union([z.boolean(), z.number().min(-40).max(-5)]).optional(),
  hardware: z.enum(['auto', 'off']).optional().describe('auto (default): encode H.264/H.265 on the graphics card (NVIDIA/Intel/AMD) when it works, else on the CPU.'),
}, async (a, extra) => {
  await ensureCompMediaViaApp(projectPath(a.project), extra.signal);
  const e = Editor.load(projectPath(a.project));
  const r = await exportProject(e.project, {
    output: a.output, preset: a.preset, quality: a.quality ?? 'good', crf: a.crf, videoBitrate: a.video_bitrate, bitrateMode: a.bitrate_mode, audioBitrate: a.audio_bitrate,
    codecPreset: a.codec_preset, fps: a.fps, from: a.from, to: a.to, loudnorm: a.loudnorm, hardware: a.hardware, onProgress: progress(extra, 'Exportando'), signal: extra.signal,
  });
  return ok({ ...r, info: mediaInfo(r.path) });
});

tool('export_mlt', 'Exportar a Shotcut/Kdenlive', 'Write the timeline as MLT XML (opens in Shotcut and Kdenlive). Lists what MLT cannot express.', { ...P, output: z.string() }, (a) => {
  const e = Editor.load(projectPath(a.project));
  const { xml, skipped } = toMlt(e.project);
  const out = resolve(a.output.toLowerCase().endsWith('.mlt') ? a.output : `${a.output}.mlt`);
  writeFileSync(out, xml, 'utf8');
  return ok({ path: out, skipped });
}, { readOnly: true });

tool('preview_frame', 'Vista previa', 'Render the frame at a timeline time and return it as an image so you can check the edit (default 960 px wide).', { ...P, time: sec('Timeline time'), width: z.number().int().min(160).max(3840).optional(), output: z.string().optional() }, async (a, extra) => {
  await ensureCompMediaViaApp(projectPath(a.project), extra.signal);
  const e = Editor.load(projectPath(a.project));
  const w = a.width ?? 960;
  const h = Math.round((w * e.project.settings.height) / e.project.settings.width / 2) * 2;
  const path = await renderFrame(e.project, a.time, { output: a.output, width: w, height: h });
  return ok({ path, time: a.time, width: w, height: h }, [{ data: readFileSync(path).toString('base64'), mimeType: 'image/png' }]);
}, { readOnly: true });

tool('snapshot', 'Guardar instantánea', 'Save the frame at a time as a full-resolution PNG ("Guarde una instantánea").', { ...P, time: sec('Timeline time'), output: z.string() }, async (a) => {
  const e = Editor.load(projectPath(a.project));
  const path = await renderFrame(e.project, a.time, { output: a.output.toLowerCase().endsWith('.png') ? a.output : `${a.output}.png` });
  return ok({ path, width: e.project.settings.width, height: e.project.settings.height });
}, { readOnly: true });

const CATALOGS: Record<string, () => unknown[]> = {
  filters: () => FILTERS.map(({ id, name, category }) => ({ id, name, category })),
  transitions: () => TRANSITIONS.map(({ id, name, category }) => ({ id, name, category })),
  titles: () => TITLES.map(({ id, name, category, sample }) => ({ id, name, category, sample })),
  title_animations: () => TITLE_ANIMS,
  stickers: () => STICKERS.map(({ id, name, category, recolor }) => ({ id, name, category, recolor: !!recolor })),
  callouts: () => CALLOUTS.map(({ id, name, category }) => ({ id, name, category })),
  masks: () => MASKS,
  pip: () => PIP_LAYOUTS.map(({ id, name }) => ({ id, name })),
  pan_zoom: () => PAN_ZOOM.map(({ id, name, category }) => ({ id, name, category })),
  animations: () => ANIMATIONS,
  eq_presets: () => EQ_PRESETS,
  audio_effects: () => AUDIO_EFFECTS.map(({ id, name, category }) => ({ id, name, category })),
  audio_enhance: () => Object.entries(AUDIO_ENHANCE).map(([id, v]) => ({ id, name: v.name })),
  export_presets: () => EXPORT_PRESETS.map(({ id, name, category, ext, width, height }) => ({ id, name, category, ext, width, height })),
  aspects: () => ASPECTS,
  generated: () => [...GENERATED.music.map((id) => ({ id, kind: 'music' })), ...GENERATED.sfx.map((id) => ({ id, kind: 'sfx' }))],
  ...MOTION_CATALOGS,
};

tool('catalog_list', 'Catálogo', `Ids and names of everything you can apply: ${Object.keys(CATALOGS).join(', ')}. Optional category / search filter.`, {
  kind: z.enum(Object.keys(CATALOGS) as [string, ...string[]]), category: z.string().optional(), search: z.string().optional(),
}, (a) => {
  let list = CATALOGS[a.kind]() as { id: string; name?: string; category?: string }[];
  if (a.category) list = list.filter((x) => x.category?.toLowerCase() === a.category!.toLowerCase());
  if (a.search) { const q = a.search.toLowerCase(); list = list.filter((x) => `${x.id} ${x.name ?? ''}`.toLowerCase().includes(q)); }
  return ok({ kind: a.kind, count: list.length, items: list });
}, { readOnly: true });

// ───────────────────────────── AI workflows (Claude does the thinking, Cinta the editing) ─────────────────────────────
tool('transcript_build', 'Transcribir', 'Transcribe (locally, with Whisper) the speech of the main-track clips and keep it in the project: needed by transcript_get, transcript_cut, fillers_*, subtitles_from_transcript and shorts_create. Parts already transcribed are skipped unless force:true.', {
  ...P, language: z.string().optional().describe('es, pt, en… (auto when omitted)'), clip_ids: z.array(z.string()).optional(), force: z.boolean().optional(),
}, async (a, extra) => {
  if (!findWhisperModel()) throw new Error('No hay ningún modelo Whisper instalado: copie un modelo sherpa-onnx-whisper y silero_vad.onnx en %APPDATA%\\Cinta\\models.');
  const { e, out } = await edit(a.project, (e) => buildTranscript(e, { language: a.language, clipIds: a.clip_ids, force: a.force, onProgress: progress(extra, 'Transcribiendo') }));
  const v = transcriptView(e.project);
  return ok({ ...brief(e), ...out, words: v.words, sentences: v.sentences.length });
});

tool('transcript_get', 'Ver transcripción', 'The transcript of the main track in timeline time: sentences with start/end and the ids of their first/last word ("from"/"to", usable in transcript_cut). format "words" lists every word with its id. Ids change after any edit: ask again before cutting.', {
  ...P, format: z.enum(['sentences', 'words', 'lines']).optional(), from: z.number().min(0).optional(), to: z.number().min(0).optional(),
}, (a) => {
  const e = Editor.load(projectPath(a.project));
  const inside = (s: { start: number; end: number }) => (a.from === undefined || s.end >= a.from) && (a.to === undefined || s.start <= a.to);
  if (a.format === 'lines') return ok({ text: transcriptLines(e.project) });
  if (a.format === 'words') return ok({ words: timelineWords(e.project).filter(inside).map(({ id, w, start, end }) => ({ id, w, start, end })) });
  const v = transcriptView(e.project);
  if (!v.words) throw new Error('Todavía no hay transcripción: use transcript_build.');
  return ok({ words: v.words, sentences: v.sentences.filter(inside) });
}, { readOnly: true });

tool('transcript_cut', 'Editar con el texto', 'Cut parts of the video by their words: word ranges [{from, to}] (ids from transcript_get), exact phrases (every occurrence is removed) and/or timeline ranges [{start, end}]. The main track closes the gaps and linked titles follow. Use it to remove repetitions, false starts, off-topic parts…', {
  ...P, word_ranges: z.array(z.object({ from: z.string(), to: z.string().optional() })).optional(), phrases: z.array(z.string().min(1)).optional(),
  ranges: z.array(z.object({ start: z.number().min(0), end: z.number().min(0) })).optional(), pad: z.number().min(0).max(0.5).optional(),
}, async (a) => {
  const { e, out } = await edit(a.project, async (e) => {
    const r = [...(a.ranges ?? []), ...(a.word_ranges ? wordRanges(e.project, a.word_ranges) : []), ...(a.phrases ? phraseRanges(e.project, a.phrases) : [])];
    if (!r.length) throw new Error(a.phrases?.length ? 'No se encontró ninguna de esas frases en la transcripción.' : 'Indique word_ranges, phrases o ranges.');
    return removeTimeRanges(e, r, a.pad ?? 0.04);
  });
  return ok({ ...brief(e), ...out });
});

tool('fillers_find', 'Buscar muletillas', 'Filler words and hesitations in the transcript ("eh", "este", "o sea", "mmm", "né", "um", "you know"…; add your own with extra). Review them and remove with fillers_remove or transcript_cut.', { ...P, extra: z.array(z.string()).optional() }, (a) => {
  const e = Editor.load(projectPath(a.project));
  const hits = findFillers(e.project, a.extra);
  return ok({ count: hits.length, fillers: hits.map((h) => ({ from: h[0].id, to: h[h.length - 1].id, text: h.map((w) => w.w).join(' '), start: h[0].start, end: h[h.length - 1].end })) });
}, { readOnly: true });

tool('fillers_remove', 'Quitar muletillas', 'Cut every filler word found by fillers_find (or only the given word ranges).', { ...P, extra: z.array(z.string()).optional(), word_ranges: z.array(z.object({ from: z.string(), to: z.string().optional() })).optional(), pad: z.number().min(0).max(0.3).optional() }, async (a) => {
  const { e, out } = await edit(a.project, async (e) => {
    const ranges = a.word_ranges ? wordRanges(e.project, a.word_ranges) : findFillers(e.project, a.extra).map((h) => ({ start: h[0].start, end: h[h.length - 1].end }));
    if (!ranges.length) return { cuts: 0, removedSeconds: 0 };
    return removeTimeRanges(e, ranges, a.pad ?? 0.03);
  });
  return ok({ ...brief(e), ...out });
});

tool('subtitles_from_transcript', 'Subtítulos desde la transcripción', 'Create subtitles from the stored transcript (no new transcription): style subtitle | subtitle-shorts | subtitle-karaoke; words = words per caption.', { ...P, style: z.string().optional(), words: z.number().int().min(1).max(12).optional() }, async (a) => {
  const { e, out } = await edit(a.project, (e) => {
    const end = projectDuration(e.project);
    const cues = cuesIn(e.project, 0, end, a.words ?? (a.style === 'subtitle' || !a.style ? 8 : 3));
    if (!cues.length) throw new Error('No hay transcripción: use transcript_build.');
    return cuesToTrack(e, cues, { style: a.style ?? 'subtitle' });
  });
  return ok({ ...brief(e), captions: out });
});

tool('subtitles_get', 'Ver subtítulos', 'The captions of a subtitle/title track with their clip ids, times and texts (to correct or translate them).', { ...P, track_id: z.string().optional() }, (a) => {
  const e = Editor.load(projectPath(a.project));
  const { track, cues } = subtitleCues(e.project, a.track_id);
  return ok({ track: { id: track.id, name: track.name }, count: cues.length, cues });
}, { readOnly: true });

tool('subtitles_update', 'Corregir subtítulos', 'Replace the text of several captions at once [{clip_id, text}] (fix transcription mistakes, punctuation, names).', { ...P, cues: z.array(z.object({ clip_id: z.string(), text: z.string().min(1) })).min(1) }, async (a) => {
  const { e } = await edit(a.project, (e) => e.mutate('Corregir subtítulos', () => {
    for (const c of a.cues) { const cl = e.clip(c.clip_id); if (!cl.title) throw new Error(`${c.clip_id} no es un subtítulo`); cl.title = { ...cl.title, text: c.text }; }
  }));
  return ok({ ...brief(e), updated: a.cues.length });
});

tool('subtitles_add_language', 'Subtítulos en otro idioma', 'Add a subtitle track in another language with the same timing and style: give the translated texts in the same order as subtitles_get returns them. hide_source hides the original track.', {
  ...P, language: z.string().min(2).describe('e.g. pt, en'), texts: z.array(z.string()).min(1), source_track_id: z.string().optional(), hide_source: z.boolean().optional(),
}, async (a) => {
  const { e, out } = await edit(a.project, (e) => addSubtitleTrack(e, a.texts, { sourceTrackId: a.source_track_id, name: `Subtítulos (${a.language})`, hideSource: a.hide_source }));
  return ok({ ...brief(e), ...out });
});

tool('chapters_set', 'Capítulos', 'Set the chapters of the video [{time, title}] (markers named "Capítulo: …"); chapters_get returns them as text for the YouTube description.', { ...P, chapters: z.array(z.object({ time: z.number().min(0), title: z.string().min(1) })).min(1) }, async (a) => {
  const { e, out } = await edit(a.project, (e) => setChapters(e, a.chapters));
  return ok({ ...brief(e), chapters: out, youtube: chaptersText(e.project) });
});

tool('chapters_get', 'Ver capítulos', 'Chapters as YouTube description text ("00:00 Title" per line).', { ...P }, (a) => ok({ youtube: chaptersText(Editor.load(projectPath(a.project)).project) }), { readOnly: true });

tool('tts_voices', 'Voces', 'Voices installed in Windows for voiceover_tts (name, language).', {}, async () => ok({ voices: await listVoices() }), { readOnly: true });

tool('voiceover_tts', 'Voz en off desde texto', 'Turn a text into speech with a Windows voice (free, offline) and put it on the "Voz" track at "at". voice: name or language ("es", "en-US"); rate −10..10.', {
  ...P, text: z.string().min(1).max(5000), voice: z.string().optional(), rate: z.number().min(-10).max(10).optional(), at: z.number().min(0).optional(),
}, async (a) => {
  const wav = await speak(a.text, { output: join(cacheDir('tts'), `voz_${Date.now()}.wav`), voice: a.voice, rate: a.rate });
  const { e, out } = await edit(a.project, async (e) => {
    let t = e.project.tracks.find((x) => x.kind === 'audio' && x.name === 'Voz');
    if (!t) t = e.addTrack('audio', 'Voz');
    const [m] = await e.importMedia([wav]);
    return e.addClip(m.id, { trackId: t.id, at: a.at ?? 0 });
  });
  return ok({ ...brief(e), clip: out.id, duration: out.out - out.in, path: wav });
});

tool('shorts_create', 'Crear shorts', 'Make vertical shorts from chosen moments: each {start, end, title?} (timeline seconds, pick them with transcript_get) becomes its own project in output_dir — 9:16 following the face, word-by-word captions from the transcript, the title as a hook, optional music (path or "generated:calm") — and, with export:true, an MP4 next to it.', {
  ...P, shorts: z.array(z.object({ start: z.number().min(0), end: z.number().min(0), title: z.string().optional() })).min(1).max(30), output_dir: z.string(),
  aspect: z.string().optional(), faces: z.boolean().optional(), captions: z.boolean().optional(), music: z.string().nullable().optional(), export: z.boolean().optional(), quality: z.enum(['draft', 'good', 'high']).optional(),
}, async (a, extra) => {
  const e = Editor.load(projectPath(a.project));
  let music: string | null = a.music ?? null;
  if (music?.startsWith('generated:')) music = await generateMedia('music', music.slice(10), { duration: Math.max(...a.shorts.map((s) => s.end - s.start)) + 2 });
  const made = await shortsFromRanges(e.project, a.shorts, { dir: a.output_dir, aspect: a.aspect, faces: a.faces, captions: a.captions, music, onProgress: progress(extra, 'Creando shorts') });
  const results = [];
  for (const m of made) {
    if (!a.export) { results.push(m); continue; }
    const p = Editor.load(m.project).project;
    const r = await exportProject(p, { output: m.project.replace(/\.cinta$/i, '.mp4'), preset: 'shorts', quality: a.quality ?? 'good', loudnorm: true });
    results.push({ ...m, video: r.path, encoder: r.encoder });
  }
  return ok({ shorts: results });
});

// ───────────────────────────── prompts: ready-made AI workflows ─────────────────────────────
const prompt = (name: string, title: string, description: string, args: z.ZodRawShape, text: (a: Record<string, string | undefined>) => string) =>
  server.registerPrompt(name, { title, description, argsSchema: args }, ((a: Record<string, string | undefined>) => ({ messages: [{ role: 'user', content: { type: 'text', text: text(a) } }] })) as never);
const proj = { proyecto: z.string().optional().describe('Ruta del .cinta (por defecto, el actual)') };
prompt('quitar-muletillas', 'Quitar muletillas', 'Quita «eh», «este», «o sea», repeticiones y arranques en falso del vídeo.', proj, (a) =>
  `Con las herramientas de Cinta${a.proyecto ? ` (proyecto ${a.proyecto})` : ''}: 1) transcript_build si aún no hay transcripción; 2) fillers_find y transcript_get; 3) decide qué quitar: muletillas, palabras repetidas y frases empezadas y abandonadas (no quites contenido); 4) fillers_remove y/o transcript_cut con los word_ranges; 5) preview_frame en un par de cortes para comprobar y dime cuánto se acortó.`);
prompt('editar-por-texto', 'Editar con el texto', 'Edita el vídeo leyendo su transcripción, como un documento.', { ...proj, instrucciones: z.string().describe('Qué quiere quitar o dejar') }, (a) =>
  `Con Cinta${a.proyecto ? ` (${a.proyecto})` : ''}: usa transcript_build (si hace falta) y transcript_get, y aplica esto cortando con transcript_cut: «${a.instrucciones}». Pide la transcripción de nuevo antes de cada tanda de cortes (los ids cambian) y resume lo que quitaste.`);
prompt('traducir-subtitulos', 'Traducir subtítulos', 'Crea una pista de subtítulos traducida con los mismos tiempos.', { ...proj, idioma: z.string().describe('pt, en, fr…') }, (a) =>
  `En Cinta${a.proyecto ? ` (${a.proyecto})` : ''}: subtitles_get; traduce cada texto al idioma «${a.idioma}» con naturalidad y frases cortas (mismo número y orden); luego subtitles_add_language con language «${a.idioma}» y los textos. Si no hay subtítulos, créalos primero con transcript_build + subtitles_from_transcript.`);
prompt('capitulos-youtube', 'Capítulos para YouTube', 'Divide el vídeo en capítulos y prepara el texto de la descripción.', proj, (a) =>
  `En Cinta${a.proyecto ? ` (${a.proyecto})` : ''}: transcript_build si hace falta, transcript_get con format "lines"; elige entre 3 y 12 capítulos con títulos breves (el primero en 0) y guárdalos con chapters_set; muéstrame el texto de chapters_get.`);
prompt('shorts-de-una-clase', 'Shorts de una clase', 'Elige los mejores momentos y crea shorts verticales listos para publicar.', { ...proj, cantidad: z.string().optional().describe('Cuántos (por defecto 5)'), carpeta: z.string().describe('Dónde guardarlos') }, (a) =>
  `En Cinta${a.proyecto ? ` (${a.proyecto})` : ''}: transcript_build si hace falta y transcript_get con format "lines". Elige los ${a.cantidad ?? '5'} mejores momentos de 20 a 60 s que se entiendan solos y tengan gancho (empieza y termina en frases completas), escribe un título-gancho corto en mayúsculas para cada uno y llama a shorts_create con output_dir «${a.carpeta}», music "generated:calm" y export true. Al final, lista los archivos.`);

tool('open_in_editor', 'Abrir en Cinta', 'Show the project in the Cinta editor window (it reloads by itself after every change made with these tools).', { ...P }, (a) => {
  const path = projectPath(a.project);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const root = resolve(__dirname, '..', '..');
  const packaged = /app\.asar/.test(__dirname);
  const args = packaged ? [path] : [root, path];
  const child = spawn(process.env.CINTA_EXE ?? process.execPath, args, { detached: true, stdio: 'ignore', env, windowsHide: false });
  child.unref();
  return ok({ opened: path, pid: child.pid });
});

tool('cinta_status', 'Estado', 'Version, current project, ffmpeg in use and whether a Whisper model is installed for auto subtitles.', {}, () => {
  const model = findWhisperModel();
  return ok({ version: VERSION, current: state.current, whisper: model ? model.encoder : null });
}, { readOnly: true });

// ───────────────────────────── advanced mode ─────────────────────────────
registerMotionTools({ tool: tool as never, edit, ok, projectPath, P });
registerVelocityTools({ tool: tool as never, edit, ok, projectPath, P });
registerScriptTools({ tool: tool as never, edit, ok, projectPath, P });
registerAnalysisTools({ tool: tool as never, edit, ok, projectPath, P });
registerPanelesTools({ tool: tool as never, edit, ok, projectPath, P }, renderViaApp);
registerRotoTools({ tool: tool as never, edit, ok, projectPath, P });

async function main() {
  await server.connect(new StdioServerTransport());
}
void main();
