// MCP tools of «análisis»: the Warp Stabilizer (effect_add adds «warpStabilizer»; warp_stabilize analyses the
// footage and reports how well it is stabilised) and the Lumetri Scopes of a comp frame (numbers and a picture).
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import * as z from 'zod';
import { cacheDir, Editor, motion } from '../core';
import { analyzeWarpStab, warpStabSpan } from '../core/warpstab-analyze';
import { encodePng } from '../core/png';
import { renderViaApp, type Host } from './motion-tools';

const M = motion;
function pickComp(p: { comps?: motion.Comp[] }, id?: string) {
  const list = p.comps ?? [];
  if (!list.length) throw new Error('El proyecto no tiene composiciones: créela con comp_new o comp_template.');
  return id ? M.findComp(list, id) : list[0];
}
const layerId = (c: motion.Comp, x: string) => M.findLayer(c, /^\d+$/.test(x) ? Number(x) : x).id;
const val = z.union([z.number(), z.array(z.number()), z.string(), z.boolean()]);

/** PNG (8-bit RGB / RGBA, not interlaced) → RGBA. */
export function decodePng(buf: Buffer): { w: number; h: number; px: Uint8ClampedArray } {
  let o = 8, w = 0, h = 0, ct = 6;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12]) throw new Error('PNG no admitido'); }
    if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error('PNG no admitido');
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, cur = new Uint8Array(stride), prev = new Uint8Array(stride), px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      cur[i] = (row[i] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    for (let x = 0; x < w; x++) { px[(y * w + x) * 4] = cur[x * bpp]; px[(y * w + x) * 4 + 1] = cur[x * bpp + 1]; px[(y * w + x) * 4 + 2] = cur[x * bpp + 2]; px[(y * w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255; }
    prev.set(cur);
  }
  return { w, h, px };
}

export function registerAnalysisTools(H: Host) {
  const { tool, edit, ok, projectPath, P } = H;
  const C = { comp: z.string().optional().describe('Composition id or name (default: the first one).') };

  tool('warp_stabilize', 'Estabilizador de deformación', 'After Effects\' Warp Stabilizer on a video layer: adds the «warpStabilizer» effect when the layer has none (values sets its parameters: result smooth|none, smoothness %, method position|similarity|perspective|subspace (default), preserveScale, framing stabilize|crop|cropScale (default)|synth, maxScale %, actionSafe %, additionalScale %, detailed, rollingShutter auto|enhanced, cropSmooth, synthRange, synthFeather, synthCrop*, hideWarning, showPoints, pointSize), analyses the footage (step 1: tracking, step 2: stabilisation; cached in the effect per layer span + Detailed Analysis, so it only runs again when they change) and reports the state: frames analysed, the Auto-scale it needs, and the residual frame-to-frame motion before / after (px). analyze false only reports (status).', {
    ...P, ...C, layer: z.string().describe('Layer id, name or 1-based index.'), effect: z.string().optional().describe('Effect id or name (default: the layer\'s first Warp Stabilizer, added if missing).'),
    values: z.record(z.string(), val).optional(), analyze: z.boolean().optional().describe('Analyse when the analysis is missing or stale (default true).'), force: z.boolean().optional().describe('Analyse again even if up to date.'),
  }, async (a, extra) => {
    const token = extra._meta?.progressToken;
    let last = 0;
    const prog = (phase: number, f: number) => {
      if (token === undefined || Date.now() - last < 400) return;
      last = Date.now();
      void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(f * 100), total: 100, message: phase === 1 ? 'Análisis en segundo plano (paso 1 de 2)' : 'Estabilización (paso 2 de 2)' } } as never).catch(() => {});
    };
    const { e, out } = await edit(a.project, async (e) => {
      const c = pickComp(e.project, a.comp), lid = layerId(c, a.layer), l = M.findLayer(c, lid);
      let f = a.effect ? l.effects.find((x) => x.id === a.effect || x.name === a.effect) : l.effects.find((x) => x.fx === 'warpStabilizer');
      if (a.effect && !f) throw new Error(`«${l.name}» no tiene el efecto «${a.effect}».`);
      let added = false;
      if (!f) { const r = M.motionOps.effectAdd(e, c.id, lid, 'warpStabilizer', a.values ?? {}); added = true; f = M.findLayer(M.findComp(e.project.comps, c.id), lid).effects.find((x) => x.id === r.id)!; }
      else if (a.values && Object.keys(a.values).length) M.motionOps.effectSet(e, c.id, lid, f.id, { values: a.values });
      const fxId = f.id;
      const span = warpStabSpan(e.project as never, c.id, lid, fxId);
      const cur = () => M.findLayer(M.findComp(e.project.comps, c.id), lid).effects.find((x) => x.id === fxId)!;
      let analysed = false, seconds = 0;
      if (a.analyze !== false && (a.force || cur().stab?.key !== span.key)) { const r = await analyzeWarpStab(e, c.id, lid, fxId, { signal: extra.signal, onProgress: prog }); analysed = true; seconds = r.seconds; }
      const fx = cur(), d = fx.stab;
      const base = { effect: { id: fx.id, name: fx.name }, added, analysed, ...(analysed ? { seconds } : {}) };
      if (!d) return { ...base, status: 'Haga clic en Analizar para comenzar.', analysedFrames: 0 };
      const stale = d.key !== span.key;
      const p = Object.fromEntries(Object.entries(fx.params).map(([k, v]) => [k, v.v]));
      const sp: motion.StabParams = { result: String(p.result), smoothness: Number(p.smoothness), method: String(p.method), preserveScale: !!Number(p.preserveScale), framing: String(p.framing), maxScale: Number(p.maxScale), actionSafe: Number(p.actionSafe), additionalScale: Number(p.additionalScale), rollingShutter: String(p.rollingShutter), cropSmooth: Number(p.cropSmooth) };
      const r = M.stabilize(d, sp), before = M.residualMotion(d, null), after = M.residualMotion(d, r);
      const W = span.width;
      return {
        ...base, status: stale ? 'Los nuevos fotogramas necesitan análisis; haga clic en Analizar.' : 'Estabilización finalizada', stale,
        analysedFrames: d.n, fps: d.fps, sourceSpan: [Math.round(d.t0 * 1000) / 1000, Math.round((d.t0 + (d.n - 1) / d.fps) * 1000) / 1000],
        trackPointsPerFrame: Math.round(d.inliers.reduce((s, v) => s + v, 0) / Math.max(1, d.n - 1)),
        autoScale: sp.framing === 'cropScale' ? Math.round((r.scale / (sp.additionalScale / 100 || 1)) * 1000) / 10 : null, scaleNeeded: Math.round(r.needed * 1000) / 10, overcropped: r.overcropped,
        crop: r.crop ? { width: Math.round(r.crop[0] * 2 * W), height: Math.round(r.crop[1] * 2 * W) } : null,
        residualMotionPx: { before: Math.round(before * W * 100) / 100, after: Math.round(after * W * 100) / 100, reduction: after > 1e-9 ? Math.round((before / after) * 10) / 10 : null },
      };
    });
    return ok({ ...out, project: e.path });
  });

  tool('comp_scopes', 'Ámbitos de Lumetri', 'Lumetri Scopes of a composition frame (AE\'s Window > Lumetri Scopes): histogram arrays (256 bins of R, G, B and luma), waveform min / max per column (columns, default 64) for luma and each channel, vectorscope stats (mean Cb/Cr, chroma, hue angle, share over the 75 % / 100 % targets, deviation from the skin-tone line), HLS means and luma range. image true also returns the scopes picture (preset or scopes list, waveform rgb|luma|yc|ycNoChroma, parade rgb|rgbWhite|yuv|yuvWhite, colorSpace auto|601|709|2020|2100hlg|2100pq, precision 8bit|float|hdr, clamp, brightness bright|normal|dimmed).', {
    ...P, ...C, time: z.number().min(0), columns: z.number().int().min(4).max(512).optional(), image: z.boolean().optional(),
    preset: z.enum(M.SCOPE_PRESETS.map((p) => p.id) as [string, ...string[]]).optional(), scopes: z.array(z.enum(['vectorYUV', 'vectorHLS', 'histogram', 'parade', 'waveform'])).optional(),
    waveform: z.enum(['rgb', 'luma', 'yc', 'ycNoChroma']).optional(), parade: z.enum(['rgb', 'rgbWhite', 'yuv', 'yuvWhite']).optional(),
    colorSpace: z.enum(['auto', '601', '709', '2020', '2100hlg', '2100pq']).optional(), precision: z.enum(['8bit', 'float', 'hdr']).optional(), clamp: z.boolean().optional(), brightness: z.enum(['bright', 'normal', 'dimmed']).optional(),
    width: z.number().int().min(160).max(1920).optional().describe('Width of the scopes picture (default 640).'),
  }, async (a, extra) => {
    const path = projectPath(a.project);
    const c = pickComp(Editor.load(path).project, a.comp);
    const dir = cacheDir('frames');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `scopes_${c.id}_${Date.now()}.png`);
    // the frame at ≤ 480 px wide: the scopes look at a downsampled copy, like the panel
    await renderViaApp({ project: path, compId: c.id, output: tmp, still: a.time, scale: Math.min(1, 480 / c.width) }, extra.signal);
    const { w, h, px } = decodePng(readFileSync(tmp));
    rmSync(tmp, { force: true });
    let s: motion.ScopeSettings = a.preset ? M.applyPreset(M.SCOPE_DEFAULTS, a.preset) : { ...M.SCOPE_DEFAULTS };
    s = { ...s, ...(a.scopes ? { scopes: a.scopes } : {}), ...(a.waveform ? { waveform: a.waveform } : {}), ...(a.parade ? { parade: a.parade } : {}), ...(a.colorSpace ? { colorSpace: a.colorSpace } : {}), ...(a.precision ? { precision: a.precision } : {}), ...(a.clamp !== undefined ? { clamp: a.clamp } : {}), ...(a.brightness ? { brightness: a.brightness } : {}) };
    const data = M.scopeData(px, w, h, s.colorSpace, a.columns ?? 64);
    const images: { data: string; mimeType: string }[] = [];
    if (a.image) {
      const W = a.width ?? 640, Hh = Math.round(W * 0.5625);
      images.push({ data: encodePng(W, Hh, M.rasterScopes(px, w, h, s, W, Hh)).toString('base64'), mimeType: 'image/png' });
    }
    return ok({ comp: c.name, time: a.time, frame: { width: w, height: h }, settings: s, ...data }, images);
  }, { readOnly: true });
}
