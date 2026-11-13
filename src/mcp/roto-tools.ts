// MCP tools of «ia»: After Effects 2024's Roto Brush & Refine Edge (roto_brush: strokes, propagation, span, freeze,
// matte report) and Content-Aware Fill (content_aware_fill: fill layer from a layer's transparent areas). All local.
import * as z from 'zod';
import { motion } from '../core';
import { rotoJob, rotoPropagate } from '../core/roto-analyze';
import { cafReferenceFrame, contentAwareFill } from '../core/caf';
import type { Host } from './motion-tools';

const M = motion;
const val = z.union([z.number(), z.array(z.number()), z.string(), z.boolean()]);
function pickComp(p: { comps?: motion.Comp[] }, id?: string) {
  const list = p.comps ?? [];
  if (!list.length) throw new Error('El proyecto no tiene composiciones: créela con comp_new o comp_template.');
  return id ? M.findComp(list, id) : list[0];
}
const layerId = (c: motion.Comp, x: string) => M.findLayer(c, /^\d+$/.test(x) ? Number(x) : x).id;
type Extra = { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (n: never) => Promise<void> };
const progress = (extra: Extra) => {
  const token = extra._meta?.progressToken;
  let last = 0;
  return (msg: string, f: number) => {
    if (token === undefined || Date.now() - last < 400) return;
    last = Date.now();
    void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(f * 100), total: 100, message: msg } } as never).catch(() => {});
  };
};

/** Share of the layer covered by the matte at some comp times (what the propagation found). */
function coverage(c: motion.Comp, l: motion.Layer, times: number[]) {
  const f = M.rotoFx(l), seg = f?.roto?.seg;
  if (!seg) return [];
  return times.map((t) => {
    const i = M.rotoFrame(seg, (t - l.start) / (l.stretch || 1));
    const m = i >= 0 && seg.m[i] ? M.rleDecode(seg.m[i]!, seg.w * seg.h) : null;
    if (!m) return { time: t, frame: i, coverage: null };
    let n = 0, sx = 0, sy = 0, x0 = seg.w, y0 = seg.h, x1 = -1, y1 = -1;
    for (let k = 0; k < m.length; k++) if (m[k]) { const x = k % seg.w, y = (k / seg.w) | 0; n++; sx += x; sy += y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const kx = seg.W / seg.w, ky = seg.H / seg.h, r = (v: number) => Math.round(v * 10) / 10;
    return { time: t, frame: i, coverage: Math.round((n / m.length) * 1000) / 1000, refine: !!seg.r[i], ...(n ? { centroid: [r(((sx / n) + 0.5) * kx), r(((sy / n) + 0.5) * ky)], bounds: [r(x0 * kx), r(y0 * ky), r((x1 + 1) * kx), r((y1 + 1) * ky)] } : {}) };
  });
  void c;
}

export function registerRotoTools(H: Host) {
  const { tool, edit, ok, P } = H;
  const C = { comp: z.string().optional().describe('Composition id or name (default: the first one).') };
  const stroke = z.object({
    kind: z.enum(['fg', 'bg', 'refine', 'unrefine']).describe('fg: Roto Brush foreground (green); bg: background (red, Alt in AE); refine: Refine Edge (over hair-like edges); unrefine: erase refinement (Alt).'),
    time: z.number().describe('Comp time (s) of the frame painted on.'),
    points: z.array(z.array(z.number()).min(2)).min(1).describe('Stroke points in LAYER pixels [[x, y], …].'),
    diameter: z.number().positive().optional().describe('Brush diameter in layer px (default 25; refine 10).'),
  });

  tool('roto_brush', 'Pincel tipo rotoscopia', 'After Effects\' Roto Brush & Refine Edge (Alt+W tools; effect «rotoBrush», «Pincel rotoscopia y Perf. borde») on a video or image layer, all local (classic colour-model + random-walker segmentation, no cloud): paints strokes (fg/bg Roto Brush, refine/unrefine Refine Edge) on frames, the first stroke\'s frame is the base frame; the matte is propagated forwards and backwards through the span (default the layer; span [from,to] comp seconds, null resets) and stored in the effect; the layer is then cut by it (invert in values). values sets effect params: quality standard|best, searchRadius, motionThreshold %, motionDamping %, viewSearch, edgeDetection predicted|balanced|current, altColor, invert, rbFineTune + rbFeather/rbContrast/rbShift/rbChatter, renderRefine, baseRadius, reFineTune + reSmooth/reFeather/reContrast/reShift/reChatterMode off|detailed|smoother/reChatter, reDecontaminate, reDeconAmount, reDeconExtend, reDeconRadius, reDeconView. clear all|<comp time> removes strokes, deleteStroke an id/name, freeze true/false locks the propagation. Reports strokes, status and the matte coverage / bounds (layer px) at report times.', {
    ...P, ...C, layer: z.string().describe('Layer id, name or 1-based index.'),
    strokes: z.array(stroke).optional(), values: z.record(z.string(), val).optional(),
    clear: z.union([z.literal('all'), z.number()]).optional(), deleteStroke: z.string().optional(),
    span: z.union([z.array(z.number()).length(2), z.null()]).optional(), freeze: z.boolean().optional(),
    propagate: z.boolean().optional().describe('Propagate now when stale (default true).'), force: z.boolean().optional(),
    report: z.array(z.number()).optional().describe('Comp times to report the matte at (default: base frame, layer in, middle and last frame).'),
  }, async (a, extra) => {
    const prog = progress(extra as unknown as Extra);
    const { e, out } = await edit(a.project, async (e) => {
      const c = pickComp(e.project, a.comp), lid = layerId(c, a.layer);
      const L = () => M.findLayer(M.findComp(e.project.comps, c.id), lid);
      if (a.freeze === false) M.motionOps.rotoEdit(e, c.id, lid, { freeze: false });
      if (a.clear !== undefined && M.rotoFx(L())) M.motionOps.rotoEdit(e, c.id, lid, a.clear === 'all' ? { clearAll: true } : { clearFrame: a.clear });
      if (a.deleteStroke) M.motionOps.rotoEdit(e, c.id, lid, { deleteStroke: a.deleteStroke });
      for (const s of a.strokes ?? []) M.motionOps.rotoStroke(e, c.id, lid, { kind: s.kind, t: s.time, points: s.points, diameter: s.diameter });
      if (!M.rotoFx(L())) {
        M.rotoLayerCheck(L());
        e.mutate('Aplicar el efecto Pincel rotoscopia y Perf. borde', (p) => { M.ensureRoto(M.findLayer(M.findComp(p.comps, c.id), lid)); });
      }
      const fx = M.rotoFx(L())!;
      if (a.values && Object.keys(a.values).length) M.motionOps.effectSet(e, c.id, lid, fx.id, { values: a.values });
      if (a.span !== undefined) M.motionOps.rotoEdit(e, c.id, lid, { span: a.span as [number, number] | null });
      let prop: Awaited<ReturnType<typeof rotoPropagate>> | null = null;
      if (a.propagate !== false && (L().effects.find((x) => x.id === fx.id)?.roto?.strokes.length ?? 0)) prop = await rotoPropagate(e, c.id, lid, { signal: extra.signal, force: a.force, onProgress: (d, n) => prog(`Propagación de Pincel tipo rotoscopia ${d} de ${n}`, d / n) });
      if (a.freeze === true) M.motionOps.rotoEdit(e, c.id, lid, { freeze: true });
      const l = L(), f = l.effects.find((x) => x.id === fx.id)!, d = f.roto;
      const { key, job } = rotoJob(e.project as never, c.id, lid);
      const seg = d?.seg;
      const fps = c.fps;
      const times = a.report ?? (seg ? [...new Set([seg.base >= 0 ? l.start + (seg.t0 + seg.base / seg.fps) * (l.stretch || 1) : l.in, l.in, (l.in + l.out) / 2, l.out - 1 / fps].map((t) => Math.round(t * 1000) / 1000))] : []);
      return {
        effect: { id: f.id, name: f.name }, status: M.rotoStatus(f, key), frozen: !!d?.frozen,
        strokes: (d?.strokes ?? []).map((s) => ({ id: s.id, name: s.name, kind: s.kind, time: Math.round((l.start + s.s * (l.stretch || 1)) * 1000) / 1000, diameter: s.d, points: s.pts.length / 2 })),
        span: { from: Math.round((l.start + job.span.srcIn * (l.stretch || 1)) * 1000) / 1000, frames: job.span.count, fps: Math.round(job.span.fps * 1000) / 1000 },
        ...(prop ? { propagated: prop.propagated, seconds: prop.seconds } : {}),
        ...(seg ? { matteSize: [seg.w, seg.h], framesWithMatte: seg.m.filter(Boolean).length, baseFrame: seg.base } : {}),
        matte: coverage(c, l, times),
      };
    });
    return ok({ ...out, project: e.path });
  });

  tool('content_aware_fill', 'Relleno según el contenido', 'After Effects\' Content-Aware Fill panel («Generar capa de relleno»), local: fills the transparent areas of a video/image layer (made by its masks — e.g. one in Subtract mode around the object to remove — or a Roto Brush matte) over the range and adds the fill (PNG image sequence in a «Rellenos» folder next to the project, played as a WebM with alpha) as a layer «Rellenar <layer>» right above, with the same transform. method object (default: borrows what other frames saw, background aligned by tracked homographies, patch-based completion for the rest) | surface (one filled frame carried along) | edge (blend from the border); lighting subtle|moderate|strong (Corrección de la luz; omit = off); expansion px (Expansión de alfa, default 5); range workArea (default) | all | [from, to] comp seconds. referenceFrame <comp time> first creates «Fotograma de referencia» (that frame filled, a one-frame image layer the fill then prefers; replace its PNG with an edited one if wanted); referenceOnly true stops there.', {
    ...P, ...C, layer: z.string().describe('Layer id, name or 1-based index.'),
    method: z.enum(['object', 'surface', 'edge']).optional(), lighting: z.enum(['subtle', 'moderate', 'strong']).optional(),
    expansion: z.number().min(-100).max(200).optional(), range: z.union([z.enum(['workArea', 'all']), z.array(z.number()).length(2)]).optional(),
    referenceFrame: z.number().optional(), referenceOnly: z.boolean().optional(),
  }, async (a, extra) => {
    const prog = progress(extra as unknown as Extra);
    const { e, out } = await edit(a.project, async (e) => {
      const c = pickComp(e.project, a.comp), lid = layerId(c, a.layer);
      const o = { method: a.method, lighting: a.lighting ?? null, expansion: a.expansion, range: a.range as 'workArea' | 'all' | [number, number] | undefined, signal: extra.signal, onProgress: prog };
      let reference: { layer: { id: string; name: string }; file: string } | undefined;
      if (a.referenceFrame !== undefined) reference = await cafReferenceFrame(e, c.id, lid, a.referenceFrame, o);
      if (a.referenceOnly) return { reference };
      const r = await contentAwareFill(e, c.id, lid, o);
      return { ...r, ...(reference ? { reference } : {}) };
    });
    return ok({ ...out, project: e.path });
  });
}
