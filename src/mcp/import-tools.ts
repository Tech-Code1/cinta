// MCP tools of «importacion»: image sequences and other footage After Effects imports (footage_import), Interpret
// Footage (footage_interpret), Premiere Pro projects and Maya cameras (premiere_import, maya_import; import_as_comp
// also takes .prproj and .ma).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as z from 'zod';
import type { MediaItem } from '../core';
import { importFootage, interpretFootage, type Interpretation } from '../core/footage';
import { prprojImport, readPrproj } from '../core/prproj';
import { mayaImport } from '../core/mayacam';
import type { Host } from './motion-tools';

const alphaEnum = z.enum(['straight', 'premultiplied', 'ignore']);
const brief = (m: MediaItem) => ({ id: m.id, name: m.footage?.name, path: m.path, kind: m.kind, width: m.width, height: m.height, duration: m.duration, fps: m.fps, hasAudio: m.hasAudio, footage: m.footage ? { source: m.footage.source, format: m.footage.format, hasAlpha: m.footage.hasAlpha, interpret: m.footage.interpret, ...(m.footage.sequence ? { frames: m.footage.sequence.last - m.footage.sequence.first + 1, missing: m.footage.sequence.missing } : {}), ...(m.footage.notes ? { notes: m.footage.notes } : {}) } : undefined });
const exists = (p: string) => { const f = resolve(p); if (!existsSync(f)) throw new Error(`No existe el archivo: ${f}`); return f; };

export async function importProjectFile(H: Host, a: { project?: string; path: string; name?: string; target?: 'comps' | 'timeline'; sequence?: string; audio?: boolean; comp?: string; origin?: 'corner' | 'center' }) {
  const file = exists(a.path);
  if (/\.prproj$/i.test(file)) {
    const { e, out } = await H.edit(a.project, (e) => prprojImport(e, file, { target: a.target, sequence: a.sequence, audio: a.audio }));
    return H.ok({ project: e.path, comps: out.comps.map((c) => ({ id: c.id, name: c.name, width: c.width, height: c.height, fps: c.fps, duration: c.duration, layers: c.layers.length })), clips: out.clips, layers: out.layers, ...(out.missing.length ? { missing: out.missing } : {}), ...(out.warnings.length ? { warnings: out.warnings } : {}), canUndo: e.canUndo });
  }
  const { e, out } = await H.edit(a.project, (e) => mayaImport(e, file, { compId: a.comp, origin: a.origin, name: a.name }));
  const cam = out.comp.layers.find((l) => l.id === out.cameras[0]);
  return H.ok({ project: e.path, comp: { id: out.comp.id, name: out.comp.name, width: out.comp.width, height: out.comp.height, fps: out.comp.fps, duration: out.comp.duration }, cameras: out.cameras, nulls: out.nulls, frames: out.frames, camera: cam ? { name: cam.name, position: cam.transform.position.k?.length ?? 0, zoom: cam.camera?.zoom.k?.length ? `${cam.camera.zoom.k.length} keys` : cam.camera?.zoom.v } : undefined, ...(out.warnings.length ? { warnings: out.warnings } : {}), canUndo: e.canUndo });
}

export function registerImportTools(H: Host) {
  const { tool, edit, ok, P } = H;
  tool('footage_import', 'Importar archivo', 'Import footage like After Effects File > Import > File: sequence true is the "PNG Sequence" checkbox (numbered files img_0001.png … with any padding, of PNG, JPEG, TIFF, Targa, OpenEXR, DPX, Cineon, BMP, WebP, SGI, Camera Raw or HEIF become ONE video footage item named img_[0001-0240].png; missing frames hold the previous frame and are reported; force_alphabetical imports every file of that type in the folder in name order). A folder path imports the largest numbered sequence inside it. Formats the app cannot show directly (Targa, SGI, DPX, Cineon, TIFF, Camera Raw, HEIF/HEIC, AVIF, MXF) are converted to a playable copy in "Material convertido" next to the project, keeping the original in footage.source. fps (sequences, default 30 as AE Preferences > Import), alpha, matte, invert_alpha and loop set the interpretation at once. add_to_timeline puts them on the simple-mode timeline too.', {
    ...P, paths: z.array(z.string()).min(1), sequence: z.boolean().optional(), force_alphabetical: z.boolean().optional(),
    fps: z.number().min(1).max(999).optional(), alpha: alphaEnum.optional(), matte: z.string().optional(), invert_alpha: z.boolean().optional(), loop: z.number().int().min(1).max(9999).optional(),
    add_to_timeline: z.boolean().optional(),
  }, async (a) => {
    const interpret: Interpretation = {};
    if (a.fps !== undefined) interpret.fps = a.fps;
    if (a.alpha) interpret.alpha = a.alpha;
    if (a.matte) interpret.matte = a.matte;
    if (a.invert_alpha !== undefined) interpret.invertAlpha = a.invert_alpha;
    if (a.loop !== undefined) interpret.loop = a.loop;
    const { e, out } = await edit(a.project, async (e) => {
      const r = await importFootage(e, a.paths.map((p) => resolve(p)), { sequence: a.sequence, alphabetical: a.force_alphabetical, interpret });
      const clips = a.add_to_timeline ? r.media.map((m) => e.addClip(m.id).id) : [];
      return { ...r, clips };
    });
    return ok({ project: e.path, media: out.media.map(brief), clips: out.clips, ...(out.notes.length ? { notes: out.notes } : {}), canUndo: e.canUndo });
  });
  tool('footage_interpret', 'Interpretar material de archivo', 'After Effects File > Interpret Footage > Main for a footage item (media id or path): fps = "Conform to frame rate" (sequences, or a video: its frames are played at that rate; null = the file\'s own rate), alpha straight ("Straight - Unmatted") | premultiplied ("Premultiplied - Matted With Color", matte "#rrggbb", default black) | ignore, invert_alpha, loop = how many times the footage repeats. The playable copy is rebuilt; layers and clips keep their timing and are trimmed if the footage got shorter. Works on converted footage and on ordinary videos and pictures.', {
    ...P, media: z.string(), fps: z.number().min(1).max(999).nullable().optional(), alpha: alphaEnum.optional(), matte: z.string().optional(), invert_alpha: z.boolean().optional(), loop: z.number().int().min(1).max(9999).optional(),
  }, async (a) => {
    const { e, out } = await edit(a.project, (e) => {
      const id = e.project.media.find((m) => m.id === a.media || resolve(m.path).toLowerCase() === resolve(a.media).toLowerCase() || (m.footage && resolve(m.footage.source).toLowerCase() === resolve(a.media).toLowerCase()))?.id;
      if (!id) throw new Error(`No existe el material «${a.media}» en el proyecto.`);
      const it: Interpretation = {};
      if (a.fps !== undefined) it.fps = a.fps ?? undefined;
      if (a.alpha) it.alpha = a.alpha;
      if (a.matte) it.matte = a.matte;
      if (a.invert_alpha !== undefined) it.invertAlpha = a.invert_alpha;
      if (a.loop !== undefined) it.loop = a.loop;
      return interpretFootage(e, id, it);
    });
    return ok({ project: e.path, media: brief(out), canUndo: e.canUndo });
  });
  tool('premiere_import', 'Importar proyecto de Adobe Premiere Pro', 'Import an Adobe Premiere Pro project (.prproj) like After Effects File > Import > Adobe Premiere Pro Project: target comps (default) turns every sequence (or only "sequence", by name) into a composition — video tracks as footage layers with their in/out points and speed, bottom track at the bottom, audio tracks as audio layers when audio is true (default), nested sequences as nested comps, missing files as grey "Falta:" solids; target timeline puts one sequence (default the first) into the simple-mode timeline (V1 → main track, V2… → overlay tracks, audio → audio tracks). list true only lists the sequences.', {
    ...P, path: z.string(), target: z.enum(['comps', 'timeline']).optional(), sequence: z.string().optional(), audio: z.boolean().optional(), list: z.boolean().optional(),
  }, async (a) => {
    if (a.list) { const { readFileSync } = await import('node:fs'); return ok({ sequences: readPrproj(readFileSync(exists(a.path))).sequences.map((s) => ({ id: s.id, name: s.name, width: s.width, height: s.height, fps: s.fps, duration: s.duration, tracks: s.tracks.map((t) => ({ kind: t.kind, clips: t.clips.length })) })) }); }
    return importProjectFile(H, a);
  });
  tool('maya_import', 'Importar escena Maya', 'Import the cameras of a Maya ASCII scene (.ma) like After Effects\' Maya importer: a composition sized like the scene\'s render resolution and frame rate, with one 3D camera layer per camera (position, point of interest, roll and zoom from the focal length and film gate, keyed on every frame of the playback range; parented and animated transforms are evaluated) and a 3D null per locator. One Maya unit = one pixel; Maya Y-up becomes After Effects Y-down; origin corner (default, AE\'s 3D origin) or center of the comp. comp adds them to an existing composition instead.', {
    ...P, path: z.string(), comp: z.string().optional(), origin: z.enum(['corner', 'center']).optional(), name: z.string().optional(),
  }, async (a) => importProjectFile(H, a));
}
