// MCP tools of the «paneles» line: a composition seen from another 3D view (After Effects' Switch 3D View, with the
// wireframes of cameras and lights), the Flowchart as data, and the Media Browser / Metadata panels (folders and
// ffprobe metadata).
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as z from 'zod';
import { cacheDir, Editor, motion } from '../core';
import { fileMetadata, listFolder, mediaRoots } from '../core/medios';
import type { Host } from './motion-tools';

const M = motion;
const VIEW_IDS = M.VIEWS_3D.map((v) => v.id) as [string, ...string[]];
function pickComp(p: { comps?: motion.Comp[] }, id?: string) {
  const list = p.comps ?? [];
  if (!list.length) throw new Error('El proyecto no tiene composiciones: créela con comp_new o comp_template.');
  return id ? M.findComp(list, id) : list[0];
}

export function registerPanelesTools(H: Host, renderViaApp: (job: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>) {
  const { tool, ok, projectPath, P } = H;
  const C = { comp: z.string().optional().describe('Composition id or name (default: the first one).') };

  tool('comp_view_frame', 'Ver vista 3D', `Render one frame of a composition from a 3D view of the Composition panel (After Effects View ▸ Switch 3D View): ${M.VIEWS_3D.map((v) => `${v.id} (${v.name})`).join(', ')}. Orthographic views (front, left, top, back, right, bottom) are framed to show the whole scene; custom1-3 are perspective views from upper left / front / upper right. orbit [yaw, pitch] degrees, pan [x, y, z] target and dolly (distance for custom views, magnification for orthographic ones) move the view like the camera tools. Returns the image and the wireframes of cameras and lights in comp pixels.`, {
    ...P, ...C, view: z.enum(VIEW_IDS), time: z.number().min(0).optional(), width: z.number().int().min(64).max(3840).optional(),
    orbit: z.tuple([z.number(), z.number()]).optional(), target: z.tuple([z.number(), z.number(), z.number()]).optional(), dolly: z.number().positive().optional(), output: z.string().optional(),
  }, async (a, extra) => {
    const path = projectPath(a.project);
    const e = Editor.load(path);
    const c = pickComp(e.project, a.comp);
    const t = a.time ?? 0, view = a.view as motion.View3D;
    const s = M.defaultViewState(c, view, t);
    if (a.orbit) { s.yaw = a.orbit[0]; s.pitch = a.orbit[1]; }
    if (a.target) s.target = [...a.target];
    if (a.dolly) { if (M.isOrtho(view)) s.scale = a.dolly; else s.dist = a.dolly; }
    // a temporary copy of the project next to the original (relative media paths keep working) with the comp seen
    // through the view's camera
    const vc = M.viewComp(c, view, s, t);
    e.project.comps = (e.project.comps ?? []).map((x) => (x.id === c.id ? vc : x));
    const tmp = join(dirname(path), `.cinta-vista-${process.pid}-${Date.now()}.cinta`);
    e.save(tmp);
    const out = resolve(a.output ?? join(cacheDir('frames'), `vista_${c.id}_${view}_${Date.now()}.png`));
    try {
      const r = await renderViaApp({ project: tmp, compId: c.id, output: out, still: Math.min(t, c.duration - 1e-3), scale: (a.width ?? 960) / c.width }, extra.signal);
      const w = M.wireframes(c, view, s, t);
      const round = (p: number[]) => p.map((x) => Math.round(x * 10) / 10);
      return ok({ path: out, view, name: M.VIEWS_3D.find((v) => v.id === view)!.name, state: s, wireframes: view === 'active' ? [] : w.labels.map((l) => ({ name: l.text, at: round(l.at) })), segments: view === 'active' ? 0 : w.lines.length, ...((r.errors as string[])?.length ? { layerErrors: r.errors } : {}) },
        [{ data: readFileSync(out).toString('base64'), mimeType: 'image/png' }]);
    } finally { rmSync(tmp, { force: true }); }
  }, { readOnly: true });

  tool('comp_flowchart', 'Diagrama de flujo', 'The Flowchart panel as data (After Effects Composition Flowchart): nodes (comps, layers, footage, solids) and edges from sources to the comps that use them (nested comps flow into the layers that nest them). comp: only that comp and what it uses; omit for the whole project. layers/footage/solids/effects as the panel\'s show buttons.', {
    ...P, comp: z.string().optional(), layers: z.boolean().optional(), footage: z.boolean().optional(), solids: z.boolean().optional(), effects: z.boolean().optional(),
  }, (a) => {
    const e = Editor.load(projectPath(a.project));
    const root = a.comp ? pickComp(e.project, a.comp).id : undefined;
    const g = M.flowGraph(e.project, { root, layers: a.layers, footage: a.footage, solids: a.solids, effects: a.effects });
    return ok({ nodes: g.nodes.map((n) => ({ id: n.id, kind: n.kind, name: n.name, ...(n.type ? { type: n.type } : {}), ...(n.effects?.length ? { effects: n.effects } : {}) })), edges: g.edges });
  }, { readOnly: true });

  tool('media_browse', 'Navegador de medios', 'List a folder like the Media Browser panel: subfolders and the files Cinta can import (video, audio, image, model, project/data), with size. Without folder: the places (home folders and drives). all: also other files. Import with media_import.', {
    folder: z.string().optional(), all: z.boolean().optional(),
  }, (a) => (a.folder ? ok(listFolder(a.folder, { all: a.all })) : ok({ places: mediaRoots() })), { readOnly: true });

  tool('media_metadata', 'Metadatos', 'A file\'s metadata like the Metadata panel, as ffprobe reports it: file (size, dates), container (format, duration, bit rate, tags), each video / audio / subtitle stream (codec, size, frame rate, pixel format, colour, sample rate, channels, tags) and chapters.', {
    path: z.string(),
  }, async (a) => ok({ groups: await fileMetadata(a.path) }), { readOnly: true });
}
