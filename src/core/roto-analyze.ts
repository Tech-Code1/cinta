// Propagation of the Roto Brush («Propagación de Pincel tipo rotoscopia»): the layer's footage is read at a working
// size (480 px wide at Standard, 960 at Best), the base frame — the frame of the first stroke — is segmented from
// its strokes, and the matte travels forwards to the end of the span and backwards to its start, frame by frame
// (segment.ts); strokes on other frames correct the matte there and from there on, away from the base frame, as in
// After Effects. The Refine Edge region painted with the Refine Edge tool travels with the subject the same way.
import type { Editor } from './ops';
import { runFfmpeg } from './ffmpeg';
import { findComp, findLayer, type Comp } from './motion';
import { rleEncode, rotoKey, rotoSpan, type RotoData, type RotoSeg, type RotoStroke } from './motion/roto';
import { dampMotion, edgeBand, rasterStroke, segmentFrame, subjectMotion, toGray, warpMask, type Img } from './segment';

/** RGB frames of a video from `start` (s), `count` frames at `fps`, scaled to w×h (frame i is the one on screen at
 *  start + i/fps, like grayFrames). A still image gives one frame. */
export async function rgbFrames(path: string, start: number, count: number, fps: number, w: number, h: number, still: boolean, signal?: AbortSignal): Promise<Uint8Array[]> {
  const args = still ? ['-i', path, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area,format=rgb24`]
    : ['-ss', start.toFixed(4), '-i', path, '-frames:v', String(count), '-vf', `fps=${fps}:round=up,scale=${w}:${h}:flags=area,format=rgb24`];
  const r = await runFfmpeg([...args, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdout: 'buffer', signal });
  const size = w * h * 3, out: Uint8Array[] = [];
  for (let i = 0; i + size <= r.stdout.length; i += size) out.push(new Uint8Array(r.stdout.subarray(i, i + size)));
  return out;
}

/** Frames read on demand in chunks (the span can be long), a few chunks kept. */
export class FrameReader {
  private chunks = new Map<number, Uint8Array[]>();
  constructor(private path: string, private t0: number, private n: number, private fps: number, readonly w: number, readonly h: number, private still: boolean, private signal?: AbortSignal, private CH = 48) {}
  async get(i: number): Promise<Img | null> {
    if (this.still) i = 0;
    if (i < 0 || i >= this.n) return null;
    const c = Math.floor(i / this.CH);
    let ch = this.chunks.get(c);
    if (!ch) {
      if (this.signal?.aborted) throw new Error('Propagación cancelada.');
      ch = await rgbFrames(this.path, this.t0 + (c * this.CH) / this.fps, Math.min(this.CH, this.n - c * this.CH), this.fps, this.w, this.h, this.still, this.signal);
      this.chunks.set(c, ch);
      if (this.chunks.size > 4) this.chunks.delete(this.chunks.keys().next().value!);
    }
    const d = ch[i - c * this.CH] ?? ch[ch.length - 1];
    return d ? { w: this.w, h: this.h, d } : null;
  }
}

export interface RotoJob {
  path: string; still: boolean; W: number; H: number;
  span: { srcIn: number; count: number; fps: number };
  strokes: RotoStroke[];
  params: { quality: string; searchRadius: number; motionThreshold: number; motionDamping: number; edgeDetection: string; altColor: boolean };
}
export interface PropagateOptions { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; /** frames already read (tests) */ frames?: (i: number) => Promise<Img | null> }

/** Working size: 480 px wide (Standard) or 960 (Best), never more than the footage. */
export function workSize(W: number, H: number, quality: string): [number, number] {
  const k = Math.min(1, (quality === 'best' ? 960 : 480) / Math.max(W, H));
  return [Math.max(16, Math.round((W * k) / 2) * 2), Math.max(16, Math.round((H * k) / 2) * 2)];
}

/** Runs the propagation: the mattes (RLE) of every frame of the span reached from the base frame. */
export async function propagateRoto(job: RotoJob, o: PropagateOptions = {}): Promise<Omit<RotoSeg, 'key'>> {
  const { span, strokes } = job, n = span.count;
  const [w, h] = workSize(job.W, job.H, job.params.quality);
  const sx = w / job.W, sy = h / job.H;
  const reader = o.frames ? null : new FrameReader(job.path, span.srcIn, n, span.fps, w, h, job.still, o.signal);
  const frame = (i: number) => (o.frames ? o.frames(i) : reader!.get(i));
  const idxOf = (s: RotoStroke) => (job.still ? 0 : Math.round((s.s - span.srcIn) * span.fps));
  const inSpan = strokes.filter((s) => { const i = idxOf(s); return i >= 0 && i < n; });
  const m: (string | null)[] = new Array(n).fill(null), r: (string | null)[] = new Array(n).fill(null);
  if (!inSpan.some((s) => s.kind === 'fg')) return { w, h, W: job.W, H: job.H, t0: span.srcIn, fps: span.fps, n, m, r, base: -1 };
  const base = idxOf(inSpan.find((s) => s.kind === 'fg')!);
  const R = Math.max(2, Math.min(Math.round(w / 6), Math.round((job.params.searchRadius / 50) * (w / 40))));
  const seg = { quality: job.params.quality as 'standard' | 'best', radius: R, edges: job.params.edgeDetection, altColor: job.params.altColor };
  const thr = (job.params.motionThreshold / 10) * (w / 480), damp = job.params.motionDamping / 100;
  const masks = (i: number) => {
    const fg = new Uint8Array(w * h), bg = new Uint8Array(w * h), ref = new Uint8Array(w * h), unref = new Uint8Array(w * h);
    let any = false, anyRef = false;
    for (const s of inSpan) {
      if (idxOf(s) !== i) continue;
      const pts = s.pts.map((v, k) => (k % 2 ? v * sy : v * sx)), rad = (s.d / 2) * sx;
      if (s.kind === 'fg') { rasterStroke(fg, w, h, pts, rad); rasterStroke(bg, w, h, pts, rad, 0); any = true; }
      else if (s.kind === 'bg') { rasterStroke(bg, w, h, pts, rad); rasterStroke(fg, w, h, pts, rad, 0); any = true; }
      else if (s.kind === 'refine') { rasterStroke(ref, w, h, pts, rad); rasterStroke(unref, w, h, pts, rad, 0); anyRef = true; }
      else { rasterStroke(unref, w, h, pts, rad); rasterStroke(ref, w, h, pts, rad, 0); anyRef = true; }
    }
    return { fg, bg, ref, unref, any, anyRef };
  };
  const total = job.still ? 1 : n;
  let done = 0;
  const tick = () => { done++; o.onProgress?.(done, total); if (o.signal?.aborted) throw new Error('Propagación cancelada.'); };
  // the refine region: painted on a frame, kept on the edge, carried by the subject's motion
  const refineAt = (k: ReturnType<typeof masks>, prevRef: Uint8Array | null, mat: Uint8Array, A: number[] | null) => {
    let reg = prevRef ? warpMask(prevRef, w, h, A) : new Uint8Array(w * h);
    if (k.anyRef) for (let i = 0; i < reg.length; i++) reg[i] = (reg[i] || k.ref[i]) && !k.unref[i] ? 1 : 0;
    if (!reg.some((v) => v)) return null;
    const band = edgeBand(mat, w, h, Math.max(2, Math.round(R / 2)));
    reg = reg.map((v, i) => (v && band[i] ? 1 : 0));
    return reg.some((v) => v) ? reg : null;
  };
  // base frame
  const img0 = await frame(base);
  if (!img0) throw new Error('No se pudieron leer fotogramas del metraje de la capa.');
  const k0 = masks(base);
  const m0 = segmentFrame(img0, k0.fg, k0.bg, null, seg);
  const ref0 = refineAt(k0, null, m0, null);
  m[base] = rleEncode(m0);
  r[base] = ref0 ? rleEncode(ref0) : null;
  tick();
  if (job.still) return { w, h, W: job.W, H: job.H, t0: span.srcIn, fps: span.fps, n, m, r, base };
  // forwards, then backwards
  for (const dir of [1, -1]) {
    let prevImg = img0, prevMask = m0, prevRef = ref0, prevGray = toGray(img0);
    for (let i = base + dir; i >= 0 && i < n; i += dir) {
      const img = await frame(i);
      if (!img) break;
      const gray = toGray(img);
      let A = prevMask.some((v) => v) ? subjectMotion(prevGray, gray, w, h, prevMask) : null;
      if (A) A = dampMotion(A, w, h, thr, damp);
      const pred = warpMask(prevMask, w, h, A);
      const k = masks(i);
      const cur = pred.some((v) => v) || k.any ? segmentFrame(img, k.fg, k.bg, pred.some((v) => v) ? pred : null, seg) : pred;
      const ref = refineAt(k, prevRef, cur, A);
      m[i] = rleEncode(cur);
      r[i] = ref ? rleEncode(ref) : null;
      prevImg = img; prevMask = cur; prevRef = ref; prevGray = gray;
      tick();
    }
    void prevImg;
  }
  return { w, h, W: job.W, H: job.H, t0: span.srcIn, fps: span.fps, n, m, r, base };
}

/** What a Roto Brush on a layer propagates: its footage, span, strokes and Propagation parameters. */
export function rotoJob(project: { media: { id: string; path: string; kind?: string; width?: number; height?: number; fps?: number }[]; comps?: Comp[] }, compId: string, layerId: string): { job: RotoJob; key: string; fxId: string } {
  const c = findComp(project.comps, compId), l = findLayer(c, layerId);
  const f = l.effects.find((x) => x.fx === 'rotoBrush');
  if (!f) throw new Error(`«${l.name}» no tiene el efecto Pincel rotoscopia y Perf. borde.`);
  const mm = project.media.find((x) => x.id === l.mediaId);
  if (!mm?.path || !mm.width || !mm.height) throw new Error('No se encuentra el metraje de la capa.');
  const span = rotoSpan(l, mm, c.fps, f.roto);
  const v = (k: string) => f.params[k]?.v;
  const job: RotoJob = {
    path: mm.path, still: span.still, W: mm.width, H: mm.height, span, strokes: (f.roto as RotoData | undefined)?.strokes ?? [],
    params: { quality: String(v('quality') ?? 'standard'), searchRadius: Number(v('searchRadius') ?? 50), motionThreshold: Number(v('motionThreshold') ?? 10), motionDamping: Number(v('motionDamping') ?? 20), edgeDetection: String(v('edgeDetection') ?? 'balanced'), altColor: !!Number(v('altColor') ?? 0) },
  };
  return { job, key: rotoKey(f, mm.path, span), fxId: f.id };
}

/** Propagates the layer's Roto Brush and stores the mattes in the effect (one undo step); nothing to do when the
 *  stored result is up to date (unless force) or the effect is frozen. */
export async function rotoPropagate(e: Editor, compId: string, layerId: string, o: PropagateOptions & { force?: boolean } = {}): Promise<{ frames: number; propagated: boolean; seconds: number; key: string; frozen: boolean }> {
  const t0 = Date.now();
  const { job, key, fxId } = rotoJob(e.project as never, compId, layerId);
  const cur = () => findLayer(findComp((e.project as unknown as { comps?: Comp[] }).comps, compId), layerId).effects.find((x) => x.id === fxId);
  const f = cur()!;
  if (f.roto?.frozen) return { frames: f.roto.seg?.m.filter(Boolean).length ?? 0, propagated: false, seconds: 0, key, frozen: true };
  if (!o.force && f.roto?.seg?.key === key) return { frames: f.roto.seg.m.filter(Boolean).length, propagated: false, seconds: 0, key, frozen: false };
  const res = await propagateRoto(job, o);
  e.mutate('Propagación de Pincel tipo rotoscopia', () => {
    const g = cur();
    if (!g) throw new Error('El efecto ya no existe.');
    g.roto ??= { strokes: [] };
    if (!job.strokes.length) delete g.roto.seg;
    else g.roto.seg = { ...res, key };
  });
  return { frames: res.m.filter(Boolean).length, propagated: true, seconds: Math.round((Date.now() - t0) / 100) / 10, key, frozen: false };
}
