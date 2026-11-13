// The advanced-mode compositor: renders a composition at time t into a canvas. The same code draws the preview
// in the window and every frame of the export (hidden window), so what you see is what you get.
//
// Per layer: source (media, solid, text, shapes, nested comp) → masks → effects (layer space) → transform
// (2D affine, or 3D through the camera with WebGL) → track matte → blend mode. Motion blur averages sub-frames.
import { parseColor, valueAt, type Env } from '../core/motion/anim';
import { apply, cameraAt, flattenBezier, invert, mul, outlineBounds, project, rotX, rotY, rotZ, scaleM, shapeOutline, translate, trimOutline, worldMatrix, layerTransform, type Mat4 } from '../core/motion/geom';
import { animatorWeights, layoutText, offsetChar } from '../core/motion/text';
import { FAUX_BOLD, FAUX_ITALIC, layoutExtras } from '../core/motion/textstyle';
import { hashStr } from '../core/motion/anim';
import type { Comp, Layer, Prop, PVal } from '../core/motion/model';
import type { MediaItem, Project } from '../core/model';
import { blurCanvas, ctx2d, fxGrowth, mk, runFx, type FxCtx, type FxScene } from './fx';
import { FloatComp } from './linear';
import { applyStyles, styleGrowth } from './styles';
import { echoCombine } from './fx-groups/estilizar';
import { rollingShutterRepair } from './fx-groups/distorsion';
import { autoFrame, type AutoFrame } from './fx-groups/color';
import { opticalFlow, pixelMotion } from './flow';
import { pixelMotionBlur, cameraShakeDeblur, lenteFrames, upscalePad } from './fx-groups/lente';
import { drawPaint, type PaintSrc } from './paint';
import type { FxInstance } from '../core/motion/model';
import type { PaintStroke } from '../core/motion/paint';
import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import { forEachProp, resolveProp } from '../core/motion/ops';
import { GLLit, GLMesh, GLQuad, quadWeights, type LitCaster, type LitLight } from './gl';
import { deformMesh, meshDistances, puppetMesh } from '../core/motion/puppet';
import { useProjectData } from '../core/motion/data';
import { axesAt, fontOf, glyphPath2D, loadFont, measureAxes, placedOutlines, prepareFonts, usesAxes, type GlyphOutline } from './textpaths';
import { warpStabFx } from './warpstab';
import { rotoBrushFx } from './roto';
import { compFrame, modelProvider, scene3d, type EnvSource, type MeshProvider, type Rendered } from './scene3d';
import { depthOfZ, modelWorld, sceneLights } from '../core/motion/model3d';
import { geometryAt, mayExtrude } from '../core/motion/extrude';
import { materialAt, shapeMeshProvider, textMeshProvider, type ExtPiece } from './extrude3d';
import { stabSpan } from '../core/motion/warpstab';
import { canal3dChannels } from '../core/motion/fx-groups/canal3d';
import { layerDepth, matteTimes, rasterDepth, type Depth3D, type DepthItem, type MatteWindow } from './fx-groups/canal3d';
import { TIME_TIEMPO, timeBlendStep } from './fx-groups/tiempo';
import { layerSourceTime, rotoFlat } from '../core/motion/capas';
import { clipToRoi, variableFeatherMask, wiggledMatrix } from './capas';

export interface Need { key: string; mediaId: string; path: string; kind: 'video' | 'image' | 'audio' | 'aux'; time: number }
/** EXR channels of one frame (3D Channel effects): 32-bit words per channel, float channels as float bits */
export interface Aux { w: number; h: number; names: string[]; get(name: string): { bits: Uint32Array; f: Float32Array; type: number } | null; ids?: Set<number> }
/** decoded sound of a file: mono samples */
export interface Pcm { data: Float32Array; rate: number }
export interface Sources {
  /** loads/seeks everything the next draw needs */
  prepare(needs: Need[]): Promise<void>;
  /** prepared frame for a layer key, or null */
  frame(key: string): CanvasImageSource | null;
  /** decoded audio of a file prepared with a kind 'audio' need */
  audio?(path: string): Pcm | null;
  /** EXR channels prepared with a kind 'aux' need */
  aux?(key: string): Aux | null;
}

interface Content { cv: HTMLCanvasElement; ox: number; oy: number; res: number }

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over', add: 'lighter', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  'color-dodge': 'color-dodge', 'color-burn': 'color-burn', 'hard-light': 'hard-light', 'soft-light': 'soft-light', difference: 'difference',
  exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};
const rgbaStr = (c: string, a = 1) => { const [r, g, b, al] = parseColor(c); return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${al * a})`; };

export interface RenderOpts {
  /** output pixels per comp pixel (preview resolution) */
  scale?: number;
  /** motion-blur sub-frames (default: the comp's) */
  mbSamples?: number;
  /** path of the rendered simple-mode timeline (sequence layers) */
  sequencePath?: string;
  /** draw the background even if the comp is transparent */
  checker?: boolean;
  /** proxies: 'current' (those switched on, the default), 'none' (final quality), 'all', 'comps' (comp proxies only) */
  proxies?: 'current' | 'none' | 'all' | 'comps';
  /** Composition panel: draw the comp's own guide layers (never nested ones; exports leave them out) */
  guides?: boolean;
  /** Composition panel's region of interest (comp px [x, y, w, h]): only that area is drawn */
  roi?: number[];
}

export class MotionRenderer {
  private gl: GLQuad | null = null;
  private project!: Project;
  private dry = false;
  private needs: Need[] = [];
  private opts: RenderOpts = {};
  private measureCtx = ctx2d(mk(4, 4));
  private measureCache = new Map<string, number>();
  /** wall time of the last render (ms) */
  lastMs = 0;
  /** accumulated ms per layer name (profiling) */
  profile: Record<string, number> = {};
  /** where each top-level layer was drawn in the last render (comp pixels, 4 corners) — viewer hit tests */
  boxes = new Map<string, [number, number][]>();
  /** layers that failed to draw in the last render ("name: message") */
  errors: string[] = [];
  prepMs = 0;

  constructor(private src: Sources) {}

  async render(project: Project, comp: Comp, t: number, opts: RenderOpts = {}): Promise<HTMLCanvasElement> {
    const t0 = performance.now();
    this.project = project;
    useProjectData(project); // footage("datos.csv") in expressions
    this.opts = opts;
    const s = opts.scale ?? 1;
    await prepareFonts(project, comp);
    this.dry = true;
    this.needs = [];
    this.modelProviders = []; this.modelEnvs = [];
    this.drawComp(comp, t, s, 0, '', false);
    this.dry = false;
    this.boxes.clear();
    this.errors = [];
    const tp = performance.now();
    // 3D models (scene3d.ts): their files are loaded with the media
    const s3 = this.modelProviders.length ? scene3d() : null;
    await Promise.all([this.src.prepare(this.needs), s3?.prepare(this.modelProviders, this.modelEnvs)]);
    this.prepMs += performance.now() - tp;
    this.modelMemo.clear();
    const out = this.drawComp(comp, t, s, 0, '', false);
    if (s3) this.errors.push(...s3.errors.map((e) => `Modelo 3D: ${e}`));
    this.lastMs = performance.now() - t0;
    return out;
  }

  // ───────────────────────── comp ─────────────────────────
  private drawComp(comp: Comp, t: number, s: number, depth: number, keyPrefix: string, nested: boolean): HTMLCanvasElement {
    const W = Math.max(1, Math.round(comp.width * s)), H = Math.max(1, Math.round(comp.height * s));
    const out = this.dry ? mk(1, 1) : mk(W, H);
    const g = ctx2d(out);
    if (!this.dry && !nested && !comp.transparent) { g.fillStyle = comp.bg; g.fillRect(0, 0, W, H); }
    if (depth > 8) return out;
    const solo = comp.layers.some((l) => l.solo && isVisual(l));
    const usedAsMatte = new Set(comp.layers.map((l) => l.matte?.layer).filter(Boolean) as string[]);
    // guide layers: only in the panel's own comp (never rendered, exported or seen by the comps that nest it)
    const visible = comp.layers.filter((l) => isVisual(l) && t >= l.in && t < l.out && (solo ? l.solo : !l.hidden) && !(usedAsMatte.has(l.id) && l.hidden) && !(l.guide && (depth > 0 || nested || !this.opts.guides)));
    // bottom → top; consecutive 3D layers are sorted by depth (farthest first)
    const order = [...visible].reverse();
    const cam = order.some((l) => l.threeD) ? cameraAt(comp, t) : null;
    const sorted: Layer[] = [];
    for (let i = 0; i < order.length;) {
      if (!order[i].threeD) { sorted.push(order[i++]); continue; }
      const run: Layer[] = [];
      while (i < order.length && order[i].threeD) run.push(order[i++]);
      if (cam) run.sort((a, b) => this.depthOf(comp, b, t, cam.view) - this.depthOf(comp, a, t, cam.view));
      sorted.push(...run);
    }
    // consecutive 3D layers with normal blending, no matte and no motion blur share one depth buffer, so a layer
    // that is behind another hides per pixel (a floor under a card), not by its anchor's depth
    const batchable = (l: Layer) => perChar3D(l) || (l.threeD && l.type !== 'adjustment' && !l.matte && (l.blend ?? 'normal') === 'normal' && !(comp.motionBlur.on && l.motionBlur));
    // project colour settings: layers blended in floating point (linear light with gamma 1.0, over-range at 32 bpc)
    const cset = this.project.motionColor;
    const fc = !this.dry && cset && (cset.blendGamma1 || cset.depth > 8) ? new FloatComp(W, H, cset) : null;
    if (fc && !nested && !comp.transparent) { const [r, gg, b] = parseColor(comp.bg); fc.fill([Math.round(r * 255), Math.round(gg * 255), Math.round(b * 255)]); }
    // with it, each layer is drawn on its own canvas and blended there; adjustment layers work on the result so far
    let lc: HTMLCanvasElement | null = null;
    const target = (l: Layer | null) => { if (!fc) return g; if (l?.type === 'adjustment') { fc.writeTo(out, true); return g; } lc = mk(W, H); return ctx2d(lc); };
    const done = (l: Layer | null) => { if (!fc) return; if (l?.type === 'adjustment') fc.readFrom(out); else if (lc) fc.blend(lc, l ? (l.blend ?? 'normal') : 'normal'); lc = null; };
    for (let i = 0; i < sorted.length;) {
      const l = sorted[i];
      if (!this.dry && batchable(l)) {
        const run: Layer[] = [];
        while (i < sorted.length && batchable(sorted[i])) run.push(sorted[i++]);
        if (run.length > 1 || run.some(perChar3D)) {
          const tl = performance.now();
          try { this.drawRun3D(target(null), comp, run, t, s, W, H, depth, keyPrefix); done(null); } catch (e) { console.warn('capas 3D:', e); this.errors.push(`3D: ${(e as Error)?.message ?? e}`); }
          if (!depth) this.profile['3D'] = (this.profile['3D'] ?? 0) + performance.now() - tl;
          continue;
        }
        i -= run.length;
      }
      i++;
      const tl = performance.now();
      try { this.drawLayer(target(l), comp, l, t, s, W, H, depth, keyPrefix); done(l); } catch (e) { if (!this.dry) { console.warn(`capa ${l.name}:`, e); this.errors.push(`${l.name}: ${(e as Error)?.message ?? e}`); } }
      if (!this.dry && !depth) this.profile[l.name] = (this.profile[l.name] ?? 0) + performance.now() - tl;
    }
    if (fc) fc.writeTo(out);
    if (!this.dry && !depth && !nested && this.opts.roi) clipToRoi(g, W, H, this.opts.roi, s);
    return out;
  }

  private depthOf(comp: Comp, l: Layer, t: number, view: Mat4): number {
    const w = mul(view, worldMatrix(comp, l, t));
    const a = l.transform.anchor.v;
    return apply(w, a[0] ?? 0, a[1] ?? 0, 0)[2];
  }

  private drawLayer(g: CanvasRenderingContext2D, comp: Comp, l: Layer, t: number, s: number, W: number, H: number, depth: number, kp: string) {
    if (l.type === 'adjustment') { if (!this.dry) this.adjust(g, comp, l, t, s, W, H, depth, kp); else for (const r of this.fxInputs(comp, l)) { this.paint(null, comp, r, t, s, W, H, depth, kp); this.needAudio(r); } return; }
    const mbOn = comp.motionBlur.on && l.motionBlur && !this.dry && !this.isMesh(comp, l, t);
    const times = mbOn ? this.subframes(comp, l, t, s) : [t];
    const needsLayerCanvas = !!l.matte || times.length > 1;
    if (this.dry) {
      this.paint(null, comp, l, t, s, W, H, depth, kp);
      if (l.matte) { const m = comp.layers.find((x) => x.id === l.matte!.layer); if (m) this.paint(null, comp, m, t, s, W, H, depth, kp); }
      // layers used as effect inputs (displacement map, set matte…) need their media too; audio effects their sound
      for (const r of this.fxInputs(comp, l)) { this.paint(null, comp, r, t, s, W, H, depth, kp); this.needAudio(r); }
      this.cloneInputs(comp, l, t, s, depth, kp);
      return;
    }
    if (!needsLayerCanvas) {
      g.save();
      g.globalCompositeOperation = BLEND[l.blend] ?? 'source-over';
      this.paint(g, comp, l, t, s, W, H, depth, kp);
      g.restore();
      return;
    }
    let lc: HTMLCanvasElement;
    if (times.length > 1) lc = this.motionBlurred(comp, l, times, s, W, H, depth, kp);
    else { lc = mk(W, H); this.paint(ctx2d(lc), comp, l, t, s, W, H, depth, kp); }
    if (l.matte) {
      const m = comp.layers.find((x) => x.id === l.matte!.layer);
      if (m && t >= m.in && t < m.out) {
        const mc = mk(W, H);
        this.paint(ctx2d(mc), comp, m, t, s, W, H, depth, kp);
        applyMatte(lc, mc, l.matte.mode);
      } else if (l.matte.mode === 'alpha' || l.matte.mode === 'luma') return; // matte absent → nothing shows
    }
    g.save();
    g.globalCompositeOperation = BLEND[l.blend] ?? 'source-over';
    g.drawImage(lc, 0, 0);
    g.restore();
  }

  private subframes(comp: Comp, l: Layer, t: number, s0 = 1): number[] {
    const fps = comp.fps, mb = comp.motionBlur;
    const n = Math.max(2, Math.min(64, this.opts.mbSamples ?? mb.samples));
    const start = t + (mb.phase / 360) / fps, span = (mb.shutter / 360) / fps;
    const t0 = start + span / (2 * n), t1 = start + span - span / (2 * n);
    // how far does the layer travel on screen during the shutter? (anchor and two points around it; the camera
    // counts for 3D layers)
    const a = l.transform.anchor.v;
    const pts = [[a[0] ?? 0, a[1] ?? 0], [(a[0] ?? 0) + 200, a[1] ?? 0], [a[0] ?? 0, (a[1] ?? 0) + 200]];
    const screen = (tt: number) => {
      const w = worldMatrix(comp, l, tt);
      if (!l.threeD) return pts.map(([x, y]) => apply(w, x, y));
      const cam = cameraAt(comp, tt);
      const m = mul(cam.view, w);
      return pts.map(([x, y]) => { const q = apply(m, x, y); return q[2] > 1 ? project(comp.width, comp.height, cam.zoom, q) : [0, 0, 0]; });
    };
    const A = screen(t0), B = screen(t1);
    let disp = 0;
    for (let i = 0; i < pts.length; i++) disp = Math.max(disp, Math.hypot(A[i][0] - B[i][0], A[i][1] - B[i][1]) * s0);
    const changing = contentChanges(comp, l, t0, t1, this.project);
    if (disp < 0.5 && !changing) return [t];
    // one sub-frame per ~1.5 output pixels of travel is enough to look continuous
    const k = changing ? n : Math.max(3, Math.min(n, Math.ceil(disp / 1.5)));
    return Array.from({ length: k }, (_, i) => start + (span * (i + 0.5)) / k);
  }

  private acc: Float32Array | null = null;
  private motionBlurred(comp: Comp, l: Layer, times: number[], s: number, W: number, H: number, depth: number, kp: string): HTMLCanvasElement {
    this.gl ??= new GLQuad();
    if (this.gl.canAccumulate) {
      // GPU: every sub-frame is a textured quad summed in half-float (exact, no 8-bit banding); the layer's
      // pixels are drawn once when only its transform moves during the shutter
      // content (text animators, shapes, nested comps…) is redrawn at most 4 times across the shutter; the
      // sub-frames in between reuse the nearest one. Static content is drawn once.
      const changing = contentChanges(comp, l, times[0], times[times.length - 1], this.project);
      const every = changing ? Math.max(1, Math.ceil(times.length / 4)) : Infinity;
      let cached: Content | null = null;
      const gl = this.gl;
      gl.beginAccum(W, H);
      for (let i = 0; i < times.length; i++) {
        const tt = times[i];
        const fresh = !cached || (every !== Infinity && i % every === 0);
        const pl = this.place(comp, l, tt, s, depth, kp, fresh ? null : cached);
        if (!pl) continue;
        cached = pl.content;
        if (!depth) this.boxes.set(l.id, pl.pts.map(([x, y]) => [x / s, y / s]));
        gl.addQuad(pl.content.cv, pl.pts, pl.q, pl.opacity / times.length);
      }
      const out = mk(W, H);
      ctx2d(out).drawImage(gl.endAccum(), 0, 0);
      return out;
    }
    // accumulate premultiplied colour, reading back only the area each sub-frame drew
    if (!this.acc || this.acc.length < W * H * 4) this.acc = new Float32Array(W * H * 4);
    const acc = this.acc;
    const tmp = mk(W, H);
    const tg = ctx2d(tmp, true);
    let ux0 = W, uy0 = H, ux1 = 0, uy1 = 0;
    for (const tt of times) {
      const bb = this.paint(tg, comp, l, tt, s, W, H, depth, kp);
      if (!bb) continue;
      const [x0, y0, x1, y1] = bb;
      const bw = x1 - x0, bh = y1 - y0;
      if (bw <= 0 || bh <= 0) continue;
      const d = tg.getImageData(x0, y0, bw, bh).data;
      tg.clearRect(x0, y0, bw, bh);
      if (x0 < ux0 || y0 < uy0 || x1 > ux1 || y1 > uy1) {
        // clear the newly covered part of the accumulator
        const nx0 = Math.min(ux0, x0), ny0 = Math.min(uy0, y0), nx1 = Math.max(ux1, x1), ny1 = Math.max(uy1, y1);
        for (let y = ny0; y < ny1; y++) for (let x = nx0; x < nx1; x++) if (x < ux0 || x >= ux1 || y < uy0 || y >= uy1) { const i = (y * W + x) * 4; acc[i] = acc[i + 1] = acc[i + 2] = acc[i + 3] = 0; }
        ux0 = nx0; uy0 = ny0; ux1 = nx1; uy1 = ny1;
      }
      for (let y = 0; y < bh; y++) {
        let i = ((y0 + y) * W + x0) * 4, j = y * bw * 4;
        for (let x = 0; x < bw; x++, i += 4, j += 4) {
          const a = d[j + 3];
          if (!a) continue;
          const k = a / 255;
          acc[i] += d[j] * k; acc[i + 1] += d[j + 1] * k; acc[i + 2] += d[j + 2] * k; acc[i + 3] += a;
        }
      }
    }
    if (ux1 <= ux0 || uy1 <= uy0) return tmp;
    const n = times.length;
    const uw = ux1 - ux0, uh = uy1 - uy0;
    const img = tg.createImageData(uw, uh);
    const o = img.data;
    for (let y = 0; y < uh; y++) {
      let i = ((uy0 + y) * W + ux0) * 4, j = y * uw * 4;
      for (let x = 0; x < uw; x++, i += 4, j += 4) {
        const a = acc[i + 3] / n;
        if (a > 0) { const k = 255 / a; o[j] = (acc[i] / n) * k; o[j + 1] = (acc[i + 1] / n) * k; o[j + 2] = (acc[i + 2] / n) * k; o[j + 3] = a; }
        acc[i] = acc[i + 1] = acc[i + 2] = acc[i + 3] = 0;
      }
    }
    tg.putImageData(img, ux0, uy0);
    return tmp;
  }

  /** Where the layer lands at time t: its content canvas and the 4 output-pixel corners (q = perspective weights). */
  private place(comp: Comp, l: Layer, t: number, s: number, depth: number, kp: string, reuse?: Content | null): { content: Content; pts: [number, number][]; q: number[]; opacity: number } | null {
    const world = worldMatrix(comp, l, t);
    const tr = layerTransform(comp, l, t);
    if (tr.opacity <= 0 && !this.dry) return null;
    // resolution: enough detail for the on-screen size (vectors), never above the source for media
    const sx = Math.hypot(world[0], world[1]), sy = Math.hypot(world[4], world[5]);
    let wsc = Math.max(0.05, Math.max(sx, sy));
    if (l.threeD) {
      // seen through the camera: as big as it appears on screen (perspective), not its nominal size
      const cam = cameraAt(comp, t);
      const a = l.transform.anchor.v;
      const z = apply(mul(cam.view, world), a[0] ?? 0, a[1] ?? 0, 0)[2];
      if (z > 1) wsc *= Math.min(4, Math.max(0.1, cam.zoom / z));
    }
    let content = reuse ?? this.content(comp, l, t, s * wsc, depth, kp, true);
    if (!content || this.dry) return null;
    if (l.threeD && !reuse) content = this.defocus(comp, l, t, s, world, content);
    const { cv, ox, oy, res } = content;
    if (l.threeD) {
      const cam = cameraAt(comp, t);
      const m = mul(cam.view, world);
      const corners: [number, number][] = [[ox, oy], [ox + cv.width / res, oy], [ox + cv.width / res, oy + cv.height / res], [ox, oy + cv.height / res]];
      const pts: [number, number][] = [];
      const q: number[] = [];
      for (const [x, y] of corners) {
        const p = apply(m, x, y, 0);
        if (p[2] < 1) return null; // behind the camera
        const pr = project(comp.width, comp.height, cam.zoom, p);
        pts.push([pr[0] * s, pr[1] * s]);
        q.push(1 / pr[2]);
      }
      return { content, pts, q, opacity: tr.opacity };
    }
    const full = mul(mul(scaleM(s, s), world), mul(translate(ox, oy), scaleM(1 / res, 1 / res)));
    const P = (x: number, y: number): [number, number] => [full[0] * x + full[4] * y + full[12], full[1] * x + full[5] * y + full[13]];
    return { content, pts: [P(0, 0), P(cv.width, 0), P(cv.width, cv.height), P(0, cv.height)], q: [1, 1, 1, 1], opacity: tr.opacity };
  }

  /** Draws the layer at time t onto g (null in the dry pass), applying transform and opacity. Returns the pixel box it covered. */
  private paint(g: CanvasRenderingContext2D | null, comp: Comp, l: Layer, t: number, s: number, W: number, H: number, depth: number, kp: string): [number, number, number, number] | null {
    if (this.isMesh(comp, l, t)) return this.paintModel(g, comp, l, t, s, W, H, depth, kp);
    const pl = this.place(comp, l, t, s, depth, kp);
    if (!pl || !g) return null;
    const { content: { cv }, pts, q, opacity } = pl;
    if (!depth) this.boxes.set(l.id, pts.map(([x, y]) => [x / s, y / s]));
    if (l.threeD) {
      const lit = this.lighting(comp, t, s, depth, kp);
      if (l.material?.castsShadows === 'only') return null; // casts shadows, is not seen
      if (lit.lights.length && (l.material?.acceptsLights ?? true)) {
        this.glLit ??= new GLLit();
        g.drawImage(this.litDraw(comp, l, t, pl, lit, W, H), 0, 0);
        return box(pts, W, H);
      }
      this.gl ??= new GLQuad();
      g.drawImage(this.gl.draw(cv, W, H, pts, q, opacity), 0, 0);
      return box(pts, W, H);
    }
    // affine: map the canvas corners (0,0)/(w,0)/(0,h) onto pts
    const [p0, p1, , p3] = pts;
    g.save();
    g.setTransform((p1[0] - p0[0]) / cv.width, (p1[1] - p0[1]) / cv.width, (p3[0] - p0[0]) / cv.height, (p3[1] - p0[1]) / cv.height, p0[0], p0[1]);
    g.globalAlpha *= opacity;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cv, 0, 0);
    g.restore();
    return box(pts, W, H);
  }

  // ───────────────────────── 3D lights, shadows and depth of field ─────────────────────────
  private glLit?: GLLit;
  private litMemo = new Map<string, { lights: LitLight[]; eye: number[]; casters: () => { id: string; caster: LitCaster }[] }>();
  /** Effects with a camera / light system (Shatter, Card Dance, CC Environment…): the comp camera and lights in the
   * layer's own pixels (the layer as a plane in the comp's 3D space, seen through the camera, back onto the layer). */
  private fxScene(comp: Comp, l: Layer, t: number, s: number, depth: number, kp: string): FxScene {
    const world = worldMatrix(comp, l, t), inv = invert(world), cam = cameraAt(comp, t);
    const proj = (x: number, y: number, z: number): [number, number, number] => {
      const w = apply(world, x, y, z), c = apply(cam.view, w[0], w[1], w[2]), q = project(comp.width, comp.height, cam.zoom, c), b = apply(inv, q[0], q[1], 0);
      return [b[0], b[1], c[2]];
    };
    const lights = this.lighting(comp, t, s, depth, kp).lights.map((L) => {
      const p = apply(inv, L.pos[0], L.pos[1], L.pos[2]), o = apply(inv, 0, 0, 0), d = apply(inv, L.dir[0], L.dir[1], L.dir[2]);
      const dv = [d[0] - o[0], d[1] - o[1], d[2] - o[2]], dl = Math.hypot(dv[0], dv[1], dv[2]) || 1;
      return { type: L.type, pos: [p[0], p[1], p[2]], dir: dv.map((v) => v / dl), color: L.color };
    });
    // the layer's axes in camera space (normalised) and the focal length in layer px
    const o = apply(cam.view, ...(apply(world, 0, 0, 0).slice(0, 3) as [number, number, number])), rot: number[] = [], len: number[] = [];
    for (const e of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) { const w = apply(world, e[0], e[1], e[2]), c = apply(cam.view, w[0], w[1], w[2]), v = [c[0] - o[0], c[1] - o[1], c[2] - o[2]], k = Math.hypot(v[0], v[1], v[2]) || 1; len.push(k); rot.push(...v.map((q) => q / k)); }
    // rows of a row-major 3×3 (columns were pushed): transpose
    const R = [rot[0], rot[3], rot[6], rot[1], rot[4], rot[7], rot[2], rot[5], rot[8]];
    return { camera: !!cam.layer, project: proj, lights, rot: R, zoom: cam.zoom / (len[0] || 1) };
  }
  /** The comp's lights at time t (world space), the camera position and (lazily) the shadow casters. */
  private lighting(comp: Comp, t: number, s: number, depth: number, kp: string) {
    const key = `${kp}${comp.id}@${t}@${s}`;
    const hit = this.litMemo.get(key);
    if (hit) return hit;
    if (this.litMemo.size > 16) this.litMemo.clear();
    const lights: LitLight[] = [];
    for (const l of comp.layers) {
      if (l.type !== 'light' || !l.light || l.hidden || t < l.in || t >= l.out) continue;
      const o = l.light, ev = (p: Prop | undefined, k: string) => valueAt(p, t, { comp, layer: l, path: `light.${k}` });
      const world = worldMatrix(comp, l, t);
      const pos = apply(world, l.transform.anchor.v[0] ?? 0, l.transform.anchor.v[1] ?? 0, l.transform.anchor.v[2] ?? 0).slice(0, 3);
      const poi = ev(o.poi, 'poi') as number[];
      const d = [num(poi?.[0]) - pos[0], num(poi?.[1]) - pos[1], num(poi?.[2]) - pos[2]], dl = Math.hypot(d[0], d[1], d[2]) || 1;
      const [r, g, b] = parseColor(String(ev(o.color, 'color') ?? '#ffffff')), k = num(ev(o.intensity, 'intensity'), 100) / 100;
      const half = (Math.max(0.5, Math.min(180, num(ev(o.coneAngle, 'coneAngle'), 90))) / 2) * (Math.PI / 180), feather = Math.max(0, Math.min(100, num(ev(o.coneFeather, 'coneFeather'), 50))) / 100;
      lights.push({
        // an environment light (Luz de entorno) reaches 3D layers as ambient light; models get its image (scene3d.ts)
        type: o.type === 'environment' ? 'ambient' : o.type, pos, dir: d.map((v) => v / dl), color: [r * k, g * k, b * k],
        cosOuter: Math.cos(half), cosInner: Math.cos(half * (1 - feather)),
        falloff: o.falloff, radius: num(ev(o.radius, 'radius'), 500), distance: num(ev(o.falloffDistance, 'falloffDistance'), 500),
        shadow: o.castsShadows && o.type !== 'ambient', darkness: Math.max(0, Math.min(1, num(ev(o.shadowDarkness, 'shadowDarkness'), 100) / 100)), diffusion: Math.max(0, num(ev(o.shadowDiffusion, 'shadowDiffusion'))),
      });
    }
    const cam = cameraAt(comp, t), vi = invert(cam.view);
    let cached: { id: string; caster: LitCaster }[] | null = null;
    const casters = () => {
      if (cached) return cached;
      cached = [];
      if (!lights.some((x) => x.shadow)) return cached;
      for (const l of comp.layers) {
        if (!l.threeD || !l.material || l.material.castsShadows === 'off' || l.hidden || t < l.in || t >= l.out || !isVisual(l)) continue;
        const c = this.content(comp, l, t, s, depth, kp, true);
        if (!c) continue;
        cached.push({ id: l.id, caster: { src: c.cv, inv: invert(worldMatrix(comp, l, t)), rect: [c.ox, c.oy, c.cv.width / c.res, c.cv.height / c.res] } });
      }
      return cached;
    };
    const out = { lights, eye: [vi[12], vi[13], vi[14]], casters };
    this.litMemo.set(key, out);
    return out;
  }
  /** Puppet pins: the layer's mesh bent by the pins at time t (rigid MLS), drawn with WebGL. */
  private puppet(comp: Comp, l: Layer, t: number, c: Content, grow: number): Content {
    const pp = l.puppet!;
    const from: number[] = [], to: number[] = [];
    let moved = false;
    for (const pin of pp.pins) {
      const v = valueAt(pin.position, t, { comp, layer: l, path: `puppet.${pin.id}.position` }) as number[];
      from.push(pin.rest[0], pin.rest[1]); to.push(num(v?.[0], pin.rest[0]), num(v?.[1], pin.rest[1]));
      if (Math.abs(to[to.length - 2] - pin.rest[0]) > 1e-6 || Math.abs(to[to.length - 1] - pin.rest[1]) > 1e-6) moved = true;
    }
    if (!moved) return c;
    const { cv, ox, oy, res } = c;
    const img = ctx2d(cv).getImageData(0, 0, cv.width, cv.height);
    const mesh = puppetMesh(img.data, cv.width, cv.height, ox, oy, res, pp.density, pp.expansion);
    if (!mesh.tris.length) return c;
    const def = deformMesh(mesh.rest, from, to, meshDistances(mesh, from));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < def.length; i += 2) { x0 = Math.min(x0, def[i]); x1 = Math.max(x1, def[i]); y0 = Math.min(y0, def[i + 1]); y1 = Math.max(y1, def[i + 1]); }
    // room for the effects and styles that come after (glows, shadows)
    const pad = grow + 2 / res, nox = x0 - pad, noy = y0 - pad;
    const W = Math.max(1, Math.ceil((x1 - x0 + pad * 2) * res)), H = Math.max(1, Math.ceil((y1 - y0 + pad * 2) * res));
    if (W * H > 64e6) return c;
    const pos = new Float32Array(def.length), uv = new Float32Array(def.length);
    for (let i = 0; i < def.length; i += 2) {
      pos[i] = (def[i] - nox) * res; pos[i + 1] = (def[i + 1] - noy) * res;
      uv[i] = ((mesh.rest[i] - ox) * res) / cv.width; uv[i + 1] = ((mesh.rest[i + 1] - oy) * res) / cv.height;
    }
    this.glMesh ??= new GLMesh();
    const out = mk(W, H);
    ctx2d(out).drawImage(this.glMesh.draw(cv, W, H, pos, uv, mesh.tris), 0, 0);
    return { cv: out, ox: nox, oy: noy, res };
  }
  private glMesh?: GLMesh;

  /** Draws a placed 3D layer with the GL lit renderer (lit, or as is when it does not take lights). */
  private litDraw(comp: Comp, l: Layer, t: number, pl: NonNullable<ReturnType<MotionRenderer['place']>>, lit: ReturnType<MotionRenderer['lighting']>, W: number, H: number): HTMLCanvasElement {
    const { content: { cv, ox, oy, res }, pts, q, opacity } = pl;
    const world = worldMatrix(comp, l, t);
    const corners = [[ox, oy], [ox + cv.width / res, oy], [ox + cv.width / res, oy + cv.height / res], [ox, oy + cv.height / res]].map(([x, y]) => apply(world, x, y, 0));
    const nz = [world[8], world[9], world[10]], nl = Math.hypot(nz[0], nz[1], nz[2]) || 1;
    // no material yet: After Effects' defaults
    const mt = l.material, ev = (p: Prop | undefined, k: string, d: number) => (p ? num(valueAt(p, t, { comp, layer: l, path: `material.${k}` }), d) : d) / 100;
    const mat = { ambient: ev(mt?.ambient, 'ambient', 100), diffuse: ev(mt?.diffuse, 'diffuse', 50), specular: ev(mt?.specular, 'specular', 50), shininess: ev(mt?.shininess, 'shininess', 5), metal: ev(mt?.metal, 'metal', 100), acceptsShadows: mt?.acceptsShadows ?? true };
    const takesLight = mt?.acceptsLights ?? true;
    const casters = takesLight ? lit.casters().filter((c) => c.id !== l.id).map((c) => c.caster) : [];
    return this.glLit!.draw(cv, W, H, pts, q, corners, nz.map((v) => v / nl), lit.eye, takesLight ? lit.lights : [], mat, casters, opacity);
  }
  /** A run of 3D layers through one depth buffer (see the frame loop). */
  private drawRun3D(g: CanvasRenderingContext2D, comp: Comp, run: Layer[], t: number, s: number, W: number, H: number, depth: number, kp: string) {
    const lit = this.lighting(comp, t, s, depth, kp);
    this.glLit ??= new GLLit();
    this.glLit.begin(W, H);
    for (const l of run) {
      if (l.material?.castsShadows === 'only') continue;
      if (this.isMesh(comp, l, t)) {
        // the model's own image with its depth: it intersects the other 3D layers of the run per pixel
        const r = this.modelRender(comp, l, t, s, W, H, kp), op = layerTransform(comp, l, t).opacity;
        if (!r || op <= 0) continue;
        if (!depth) this.boxes.set(l.id, this.modelBox(comp, l, t));
        this.glLit.drawDepthImage(r.color, r.depth, W, H, op, depthOfZ(Math.max(1.0001, this.depthOf(comp, l, t, cameraAt(comp, t).view))));
        continue;
      }
      if (perChar3D(l)) { this.chars3D(comp, l, t, s, lit, W, H, depth); continue; }
      const pl = this.place(comp, l, t, s, depth, kp);
      if (!pl) continue;
      if (!depth) this.boxes.set(l.id, pl.pts.map(([x, y]) => [x / s, y / s]));
      this.litDraw(comp, l, t, pl, lit, W, H);
    }
    g.drawImage(this.glLit.end(), 0, 0);
  }
  // ───────────────────────── 3D models (scene3d.ts) ─────────────────────────
  private modelProviders: MeshProvider[] = [];
  private modelEnvs: EnvSource[] = [];
  /** this frame's renders of the models of a comp (key: prefix, comp, time, scale) */
  private modelMemo = new Map<string, Map<string, Rendered>>();
  private modelLayers(comp: Comp, t: number) { return comp.layers.filter((y) => this.isMesh(comp, y, t) && !y.hidden && t >= y.in && t < y.out); }
  /** Drawn by three.js (scene3d.ts): 3D models, and 3D text / shapes with an extrusion or a bevel at t (extrude.ts). */
  private isMesh(comp: Comp, l: Layer, t: number) { return l.type === 'model' || (mayExtrude(l) && !!geometryAt(comp, l, t)); }
  /** The mesh of a model layer or of an extruded text / shape layer at t. */
  private meshProvider(comp: Comp, l: Layer, t: number, kp: string): MeshProvider | null {
    if (l.type === 'model') return modelProvider(this.project, comp, l, t, kp);
    const g = geometryAt(comp, l, t);
    if (!g) return null;
    const mt = l.material, shadow = { cast: !!mt && mt.castsShadows !== 'off', receive: mt?.acceptsShadows ?? true, only: mt?.castsShadows === 'only' };
    const mat = materialAt(comp, l, t, !sceneLights(comp, t).length);
    const world = worldMatrix(comp, l, t), id = `${kp}${l.id}`;
    if (l.type === 'text') {
      const gs = this.glyphs(comp, l, t);
      if (!gs) return null;
      const d = l.text!;
      return textMeshProvider(id, comp, l, t, g, {
        glyphs: gs.G.map((gl, i) => ({ ch: gl.space ? ' ' : gs.st[i].off ? offsetChar(gl.ch, gs.st[i].off) : gl.ch, w: gl.w, place: gs.place[i], st: gs.st[i], faces: gs.st[i].faces })),
        size: gs.size, pivotY: gs.pivotY, sw: gs.sw, fill: gs.fill, stroke: gs.stroke, axes: gs.vf?.axes,
      }, () => loadFont(d), world, mat, shadow);
    }
    const pieces: ExtPiece[] = this.shapePieces(comp, l, t).pieces.map((p) => {
      const k = Math.sqrt(Math.abs(p.m.a * p.m.d - p.m.b * p.m.c));
      return {
        pts: p.pts, closed: p.pts.map((_, i) => p.closed?.[i] ?? true), rule: p.rule === 'evenodd' ? 'evenodd' : 'nonzero', alpha: p.alpha,
        fill: p.fillCol ? { color: p.fillCol[0], opacity: p.fillCol[1] } : undefined,
        stroke: p.strokeCol && p.sw > 0 ? { color: p.strokeCol[0], opacity: p.strokeCol[1], width: p.sw * k, join: p.join === 'round' ? 'round' : p.join === 'bevel' ? 'bevel' : 'miter', cap: p.cap === 'round' ? 'round' : p.cap === 'square' ? 'square' : 'butt' } : undefined,
      };
    });
    return pieces.length ? shapeMeshProvider(id, comp, l, t, g, pieces, world, mat, shadow) : null;
  }
  /** Layer-space box of an extruded layer at t (selection box): its outlines and depth. */
  private extBox(comp: Comp, l: Layer, t: number): { min: number[]; max: number[] } | null {
    const g = geometryAt(comp, l, t);
    if (!g) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = 0;
    if (l.type === 'text') {
      const gs = this.glyphs(comp, l, t);
      gs?.G.forEach((gl, i) => { const s0 = gs.st[i], r = Math.max(gl.w, gs.size) * 0.6 * Math.max(Math.abs(s0.sx), Math.abs(s0.sy)), cx = gs.place[i].x + s0.dx, cy = gs.place[i].y + s0.dy; x0 = Math.min(x0, cx - r); x1 = Math.max(x1, cx + r); y0 = Math.min(y0, cy - r); y1 = Math.max(y1, cy + r); z0 = Math.min(z0, s0.dz); });
    } else ({ x0, y0, x1, y1 } = this.shapePieces(comp, l, t));
    if (!Number.isFinite(x0)) return null;
    return { min: [x0, y0, z0], max: [x1, y1, Math.max(g.depth, g.bevel)] };
  }
  /** A model layer: drawn by three.js (with the comp's camera and lights) and laid on g like a 2D image. */
  private paintModel(g: CanvasRenderingContext2D | null, comp: Comp, l: Layer, t: number, s: number, W: number, H: number, depth: number, kp: string): [number, number, number, number] | null {
    if (this.dry) {
      // every model of the comp is in the scene (they shadow each other), and its environment image
      const ids = new Set(this.modelProviders.map((p) => p.id));
      for (const y of this.modelLayers(comp, t)) { const p = this.meshProvider(comp, y, t, kp); if (p && !ids.has(p.id)) this.modelProviders.push(p); }
      if (!this.modelLayers(comp, t).some((y) => y.id === l.id)) { const p = this.meshProvider(comp, l, t, kp); if (p && !ids.has(p.id)) this.modelProviders.push(p); }
      this.modelEnvs.push(...compFrame(this.project, comp, t, 1, 1).envs);
      return null;
    }
    const op = layerTransform(comp, l, t).opacity;
    const r = op > 0 ? this.modelRender(comp, l, t, s, W, H, kp) : null;
    if (!r || !g) return null;
    if (!depth) this.boxes.set(l.id, this.modelBox(comp, l, t));
    g.save();
    g.globalAlpha *= op;
    g.drawImage(r.color, 0, 0, W, H);
    g.restore();
    return box(this.modelBox(comp, l, t).map(([x, y]) => [x * s, y * s]), W, H);
  }
  /** The renders of the comp's models at t (once per frame), and this layer's. */
  private modelRender(comp: Comp, l: Layer, t: number, s: number, W: number, H: number, kp: string): Rendered | null {
    const key = `${kp}${comp.id}@${t}@${s}`;
    let m = this.modelMemo.get(key);
    if (!m) {
      const s3 = scene3d();
      const layers = this.modelLayers(comp, t);
      if (!layers.includes(l)) layers.push(l);
      const provs = layers.map((y) => this.meshProvider(comp, y, t, kp)).filter((p): p is MeshProvider => !!p && s3.has(p.id));
      m = provs.length ? s3.render(compFrame(this.project, comp, t, W, H).frame, provs) : new Map();
      if (this.modelMemo.size > 8) this.modelMemo.clear();
      this.modelMemo.set(key, m);
    }
    return m.get(`${kp}${l.id}`) ?? null;
  }
  /** Where a model layer is on screen (comp px): the box of its 8 bounding-box corners. */
  private modelBox(comp: Comp, l: Layer, t: number): [number, number][] {
    const b = l.type === 'model' ? this.project.media.find((m) => m.id === l.mediaId)?.model?.bbox : this.extBox(comp, l, t);
    const cam = cameraAt(comp, t), M = mul(cam.view, l.type === 'model' ? modelWorld(comp, l, t) : worldMatrix(comp, l, t));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    if (b) for (let c = 0; c < 8; c++) {
      const q = apply(M, c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]);
      if (q[2] < 1) continue;
      const p = project(comp.width, comp.height, cam.zoom, q);
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
    if (!Number.isFinite(x0)) { const a = apply(cam.view, ...(apply(worldMatrix(comp, l, t), 0, 0, 0).slice(0, 3) as [number, number, number])), p = a[2] > 1 ? project(comp.width, comp.height, cam.zoom, a) : [0, 0]; x0 = x1 = p[0]; y0 = y1 = p[1]; }
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }

  /** Material of a 3D layer at t (After Effects' defaults when it has none). */
  private materialOf(comp: Comp, l: Layer, t: number) {
    const mt = l.material, ev = (p: Prop | undefined, k: string, d: number) => (p ? num(valueAt(p, t, { comp, layer: l, path: `material.${k}` }), d) : d) / 100;
    return { ambient: ev(mt?.ambient, 'ambient', 100), diffuse: ev(mt?.diffuse, 'diffuse', 50), specular: ev(mt?.specular, 'specular', 50), shininess: ev(mt?.shininess, 'shininess', 5), metal: ev(mt?.metal, 'metal', 100), acceptsShadows: mt?.acceptsShadows ?? true };
  }
  /** Per-character 3D text: every glyph is a card with its own matrix — layer × place on the line (or path) ×
   *  animator position (z too) × Z, Y, X rotation × scale — drawn lit into the run's depth buffer, so characters
   *  pass in front of and behind each other and of other 3D layers. */
  private chars3D(comp: Comp, l: Layer, t: number, s: number, lit: ReturnType<MotionRenderer['lighting']>, W: number, H: number, depth: number) {
    const tr = layerTransform(comp, l, t);
    if (tr.opacity <= 0) return;
    const gs = this.glyphs(comp, l, t);
    if (!gs) return;
    const { G, st, place, font, size, sw, pivotY } = gs;
    const world = worldMatrix(comp, l, t), cam = cameraAt(comp, t);
    const mat = this.materialOf(comp, l, t), takesLight = l.material?.acceptsLights ?? true;
    const casters = takesLight ? lit.casters().filter((c) => c.id !== l.id).map((c) => c.caster) : [];
    const box: [number, number][] = [];
    G.forEach((gl, i) => {
      const s0 = st[i];
      if (s0.op <= 0.001 || gl.space) return;
      const gk = gl.k ?? 1, ghs = gk * (gl.hs ?? 1), gvs = gk * (gl.vs ?? 1);
      const M = mul(world, mul(translate(place[i].x + s0.dx, place[i].y + s0.dy, s0.dz), mul(rotZ(s0.rot + place[i].a), mul(rotY(s0.rotY), mul(rotX(s0.rotX), scaleM(s0.sx * ghs, s0.sy * gvs, 1))))));
      const V = mul(cam.view, M), zc = apply(V, 0, 0, 0)[2];
      if (zc < 1) return;
      // the card's resolution: as big as it appears on screen
      const res = Math.max(0.25, Math.min(6, s * (cam.zoom / zc) * Math.max(Math.abs(s0.sx), Math.abs(s0.sy)) * Math.hypot(world[0], world[1])));
      const card = this.glyphCard(s0.off ? offsetChar(gl.ch, s0.off) : gl.ch, font, s0.fill, s0.stroke, sw, s0.blur, s0.skew + (gl.fi ? FAUX_ITALIC : 0), gl.w / ghs, size, pivotY, res, gl.fb ? FAUX_BOLD * size : 0);
      const corners = [[card.x0, card.y0], [card.x0 + card.w, card.y0], [card.x0 + card.w, card.y0 + card.h], [card.x0, card.y0 + card.h]];
      const pts: [number, number][] = [], q: number[] = [];
      for (const [x, y] of corners) {
        const p = apply(V, x, y, 0);
        if (p[2] < 1) return;
        const pr = project(comp.width, comp.height, cam.zoom, p);
        pts.push([pr[0] * s, pr[1] * s]); q.push(1 / pr[2]);
      }
      box.push(...pts);
      const nz = [M[8], M[9], M[10]], nl = Math.hypot(nz[0], nz[1], nz[2]) || 1;
      this.glLit!.draw(card.cv, W, H, pts, q, corners.map(([x, y]) => apply(M, x, y, 0)), nz.map((v) => v / nl), lit.eye, takesLight ? lit.lights : [], mat, casters, tr.opacity * Math.min(1, s0.op));
    });
    if (!depth && box.length) {
      const xs = box.map((p) => p[0] / s), ys = box.map((p) => p[1] / s), bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
      this.boxes.set(l.id, [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]]);
    }
  }
  private cards = new Map<string, { cv: HTMLCanvasElement; x0: number; y0: number; w: number; h: number }>();
  /** One glyph drawn on its own canvas (cached), in glyph units around its pivot. */
  private glyphCard(ch: string, font: string, fill: string, stroke: string, sw: number, blur: number, skew: number, w: number, size: number, pivotY: number, res: number, fb = 0) {
    const r = Math.round(res * 4) / 4;
    const key = `${ch}|${font}|${fill}|${stroke}|${sw}|${Math.round(blur * 4) / 4}|${Math.round(skew)}|${r}|${fb}|${w.toFixed(2)}`;
    let c = this.cards.get(key);
    if (c) return c;
    const pad = sw + fb + blur * 3 + size * 0.15 + Math.abs(Math.tan((skew * Math.PI) / 180)) * size;
    const x0 = -w / 2 - pad, y0 = -size * 0.75 - pad, cw = w + pad * 2, ch2 = size * 1.5 + pad * 2;
    const cv = mk(Math.max(1, cw * r), Math.max(1, ch2 * r));
    const g = ctx2d(cv);
    g.setTransform(r, 0, 0, r, -x0 * r, -y0 * r);
    if (skew) g.transform(1, 0, Math.tan((-skew * Math.PI) / 180), 1, 0, 0);
    g.font = font; g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.lineJoin = 'round';
    g.filter = blur > 0.2 ? `blur(${(blur * r) / 2}px)` : 'none';
    if (sw > 0) { g.strokeStyle = stroke; g.lineWidth = sw + fb; g.strokeText(ch, -w / 2, -pivotY); }
    if (fb) { g.strokeStyle = fill; g.lineWidth = fb; g.strokeText(ch, -w / 2, -pivotY); }
    g.fillStyle = fill;
    g.fillText(ch, -w / 2, -pivotY);
    c = { cv, x0, y0, w: cw, h: ch2 };
    if (this.cards.size > 600) this.cards.clear();
    this.cards.set(key, c);
    return c;
  }

  /** Depth of field: a 3D layer away from the camera's focus distance is blurred (circle of confusion at its anchor). */
  private defocus(comp: Comp, l: Layer, t: number, s: number, world: Mat4, c: Content): Content {
    const cam = cameraAt(comp, t);
    const dof = cam.layer?.camera?.dof;
    if (!dof?.on) return c;
    const ev = (p: Prop | undefined, k: string, d: number) => num(valueAt(p, t, { comp, layer: cam.layer!, path: `camera.dof.${k}` }), d);
    const a = l.transform.anchor.v;
    const z = apply(mul(cam.view, world), a[0] ?? 0, a[1] ?? 0, 0)[2];
    if (z <= 1) return c;
    const focus = ev(dof.focus, 'focus', cam.zoom), coc = ev(dof.aperture, 'aperture', 25) * (ev(dof.blur, 'blur', 100) / 100) * Math.abs(z - focus) / z;
    // the content canvas has res px per layer px; on screen one layer px is about zoom / z output px
    const sigma = (coc * s) * (c.res / Math.max(1e-3, s * (cam.zoom / z) * Math.hypot(world[0], world[1]))) / 2;
    if (sigma < 0.4) return c;
    const pad = Math.ceil(sigma * 3);
    const big = mk(c.cv.width + pad * 2, c.cv.height + pad * 2);
    ctx2d(big).drawImage(c.cv, pad, pad);
    return { cv: blurCanvas(big, sigma), ox: c.ox - pad / c.res, oy: c.oy - pad / c.res, res: c.res };
  }

  // ───────────────────────── layer content (layer space) ─────────────────────────
  private content(comp: Comp, l: Layer, t0: number, res0: number, depth: number, kp: string, withEcho: boolean): Content | null {
    const env = (path: string): Env => ({ comp, layer: l, path });
    const ev = (p: Prop | undefined, path: string): PVal => valueAt(p, t0, env(path));
    let t = t0;
    const post = l.effects.find((f) => f.on && f.fx === 'posterizeTime');
    if (post) { const f = Math.max(0.01, num(ev(post.params.fps, `effects.${post.id}.fps`), 24)); t = Math.floor(t * f + 1e-6) / f; }
    const evt = (p: Prop | undefined, path: string): PVal => valueAt(p, t, env(path));
    let srcTime = l.timeRemap ? num(evt(l.timeRemap, 'timeRemap')) : layerSourceTime(this.project.comps, l, t);
    // Timewarp: the source time comes from the speed (integrated from the layer's in point) or a source frame
    const tw = l.type === 'video' ? l.effects.find((f) => f.on && f.fx === 'timewarp') : undefined;
    if (tw) {
      const twp = (k: string, tt: number) => valueAt(tw.params[k], tt, env(`effects.${tw.id}.${k}`));
      const srcFps = this.mediaOf(l.mediaId)?.fps || comp.fps;
      if (twp('adjust', t) === 'frame') srcTime = num(twp('sourceFrame', t)) / srcFps;
      else {
        const dt = 1 / (comp.fps * 4);
        let s = (l.in - l.start) / (l.stretch || 1);
        for (let tt = l.in; tt < t - 1e-9; tt += dt) s += (num(twp('speed', Math.min(t, tt + dt / 2)), 50) / 100) * Math.min(dt, t - tt);
        srcTime = Math.max(0, s);
      }
    }

    // echo: composite earlier/later copies of this layer's content
    const echo = withEcho ? l.effects.find((f) => f.on && f.fx === 'echo') : undefined;
    if (echo && this.dry) {
      const dt = num(evt(echo.params.time, `effects.${echo.id}.time`), -1 / 30), n = Math.max(0, Math.min(50, Math.round(num(evt(echo.params.count, `effects.${echo.id}.count`), 1))));
      this.content(comp, l, t, res0, depth, kp, false);
      for (let k = n; k >= 1; k--) this.content(comp, l, t + dt * k, res0, depth, `${kp}e${k}/`, false);
      return null;
    }
    if (echo && !this.dry) {
      const p = (k: string) => evt(echo.params[k], `effects.${echo.id}.${k}`);
      const dt = num(p('time'), -1 / 30), n = Math.max(0, Math.min(50, Math.round(num(p('count'), 1))));
      const base = this.content(comp, l, t, res0, depth, kp, false);
      if (!base) return null;
      // the echoes placed on the current frame's canvas, then combined per pixel with the Echo Operator
      const place = (c: Content | null) => { if (!c) return null; const m = mk(base.cv.width, base.cv.height); ctx2d(m).drawImage(c.cv, (c.ox - base.ox) * base.res, (c.oy - base.oy) * base.res); return m; };
      const layers: (HTMLCanvasElement | null)[] = [base.cv];
      for (let k = 1; k <= n; k++) layers.push(place(this.content(comp, l, t + dt * k, res0, depth, `${kp}e${k}/`, false)));
      return { ...base, cv: echoCombine(layers, num(p('start'), 1), num(p('decay'), 1), String(p('op') ?? 'add')) };
    }

    // Auto Levels / Contrast / Color with Temporal Smoothing: this layer, up to the effect, at the frames around now
    if (!this.fxCut.has(l.id)) this.autoWindow(comp, l, t, res0, depth, kp);
    if (!this.fxCut.has(l.id)) this.matteWindow(comp, l, t, res0, depth, kp);
    // CC Time Blend FX: its buffer up to the frame before this one
    if (!this.fxCut.has(l.id)) this.timeBlendFxWindow(comp, l, t, res0, depth, kp);
    if (!this.fxCut.has(l.id)) this.stabRefs(comp, l, t, res0, depth, kp);

    // Pixel Motion Blur and Camera-Shake Deblur (lente): this layer (with its other effects) at the neighbouring source
    // frames, placed on the current frame's canvas
    const lf = withEcho ? l.effects.find((f) => f.on && (f.fx === 'pixelMotionBlur' || f.fx === 'cameraShakeDeblur')) : undefined;
    if (lf) {
      const fp = (k: string) => evt(lf.params[k], `effects.${lf.id}.${k}`), d = 1 / (this.mediaOf(l.mediaId)?.fps || comp.fps), offs = lenteFrames(lf.fx, fp);
      const near = offs.map((k) => this.content(comp, l, t + k * d, res0, depth, `${kp}L${k}/`, false));
      const base = this.content(comp, l, t, res0, depth, kp, false);
      if (this.dry || !base) return null;
      const place = (c: Content | null) => { if (!c) return null; const m = mk(base.cv.width, base.cv.height); ctx2d(m).drawImage(c.cv, (c.ox - base.ox) * base.res, (c.oy - base.oy) * base.res); return m; };
      const cs = near.map(place);
      if (lf.fx === 'pixelMotionBlur') return { ...base, cv: pixelMotionBlur(base.cv, cs[0], cs[1], fp, { on: comp.motionBlur.on && l.motionBlur, angle: comp.motionBlur.shutter, samples: comp.motionBlur.samples }) };
      return { ...base, cv: cameraShakeDeblur(base.cv, cs, fp) };
    }

    // time effects: the layer (with its other effects) at other moments — CC Wide Time averages them, CC Time
    // Blend accumulates them, Time Displacement picks one per pixel, Timewarp's motion blur spreads the shutter
    const tf = withEcho ? l.effects.find((f) => f.on && (f.fx === 'wideTime' || f.fx === 'timeBlend' || f.fx === 'timeDisplacement' || f.fx === 'rollingShutter' || f.fx === 'ccForceMotionBlur' || f.fx in TIME_TIEMPO)) : undefined;
    const twBlur = withEcho && tw && num(evt(tw.params.motionBlur, `effects.${tw.id}.motionBlur`));
    if (tf || twBlur) {
      const fp = (k: string) => (tf ? evt(tf.params[k], `effects.${tf.id}.${k}`) : undefined);
      const fps = comp.fps, at = (tt: number, k: string) => this.content(comp, l, tt, res0, depth, `${kp}${k}/`, false);
      // the moments to read, and how each pixel combines them
      let times: number[] = [];
      if (twBlur) { const n = Math.max(2, Math.min(64, Math.round(num(evt(tw!.params.shutterSamples, `effects.${tw!.id}.shutterSamples`), 5)))), sh = num(evt(tw!.params.shutterAngle, `effects.${tw!.id}.shutterAngle`), 180) / 360 / fps; times = Array.from({ length: n }, (_, i) => t - sh / 2 + (sh * (i + 0.5)) / n); }
      // Rolling Shutter Repair: the source frames just before and after (motion analysis)
      else if (tf!.fx === 'rollingShutter') { const d = 1 / (this.mediaOf(l.mediaId)?.fps || fps); times = [t - d, t + d]; }
      else if (tf!.fx === 'ccForceMotionBlur') {
        // CC Force Motion Blur: N samples from now + phase across the shutter (its own or the comp's); with native
        // motion blur each sample's slice of the shutter is covered too (two moments per sample)
        const own = num(fp('override'), 1), ang = own ? num(fp('shutterAngle'), 180) : comp.motionBlur.shutter, ph = own ? num(fp('shutterPhase')) : comp.motionBlur.phase;
        const n = Math.max(1, Math.min(255, Math.round(num(fp('samples'), 8)))), span = ang / 360 / fps, t0 = t + ph / 360 / fps;
        if (String(fp('native') ?? 'off') === 'on' && span > 0) for (let k = 0; k < 2 * n; k++) times.push(t0 + (span * (k + 0.5)) / (2 * n));
        else for (let k = 0; k < (span > 0 ? n : 1); k++) times.push(t0 + (span * k) / n);
      }
      else if (TIME_TIEMPO[tf!.fx]) times = TIME_TIEMPO[tf!.fx].times(fp, { t, fps, inPt: l.in, outPt: l.out, start: l.start, self: l.id });
      else if (tf!.fx === 'wideTime') { const fw = Math.round(num(fp('forward'), 1)), bw = Math.round(num(fp('backward'), 1)); for (let k = -bw; k <= fw; k++) times.push(t + k / fps); }
      else if (tf!.fx === 'timeBlend') {
        // the accumulation decays by its factor each frame: frames that would weigh under 1/255 are left out
        const a = Math.max(0, Math.min(1, num(fp('accumulation'), 0.75))), back = a <= 0 ? 0 : a >= 1 ? 120 : Math.min(120, Math.ceil(Math.log(1 / 255) / Math.log(a)));
        for (let k = back; k >= 0; k--) { const tt = t - k / fps; if (tt >= l.in - 1e-9) times.push(tt); }
      } else {
        const maxT = num(fp('maxTime'), 1), resF = Math.max(0.01, num(fp('resolution'), 60)), slices = Math.max(1, Math.min(32, Math.round(Math.abs(maxT) * 2 * resF)));
        for (let k = 0; k <= slices; k++) times.push(t + (k / slices * 2 - 1) * maxT);
      }
      const cs = times.map((tt, i) => at(tt, `t${i}`));
      if (this.dry) {
        this.content(comp, l, t, res0, depth, kp, false);
        // the time map is another layer: its sources too
        if (tf?.fx === 'timeDisplacement' && fp('map')) this.inputOf(comp, l, t, res0, depth, kp)(String(fp('map')));
        const o = tf && TIME_TIEMPO[tf.fx]?.other?.(fp, t, l.id); if (o) this.inputOf(comp, l, o.t, res0, depth, kp)(o.id);
        return null;
      }
      const base = this.content(comp, l, t, res0, depth, kp, false);
      if (!base) return null;
      const W = base.cv.width, H = base.cv.height;
      const place = (c: Content | null) => { if (!c) return null; const m = mk(W, H); ctx2d(m).drawImage(c.cv, (c.ox - base.ox) * base.res, (c.oy - base.oy) * base.res); return m; };
      const out = mk(W, H), g = ctx2d(out);
      if (twBlur || tf!.fx === 'wideTime' || tf!.fx === 'ccForceMotionBlur') {
        // equal-weight average of the samples (premultiplied, so edges stay clean)
        const acc = new Float32Array(W * H * 4); let n = 0;
        for (const c of cs) { const m = place(c); if (!m) continue; const d = ctx2d(m).getImageData(0, 0, W, H).data; for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; acc[i] += d[i] * a; acc[i + 1] += d[i + 1] * a; acc[i + 2] += d[i + 2] * a; acc[i + 3] += d[i + 3]; } n++; }
        const o = new ImageData(W, H);
        for (let i = 0; i < acc.length; i += 4) { const a = acc[i + 3] / n; o.data[i + 3] = a; if (a > 0) { o.data[i] = acc[i] / n / (a / 255); o.data[i + 1] = acc[i + 1] / n / (a / 255); o.data[i + 2] = acc[i + 2] / n / (a / 255); } }
        g.putImageData(o, 0, 0);
      } else if (tf!.fx === 'timeBlend') {
        const a = Math.max(0, Math.min(1, num(fp('accumulation'), 0.75))), mode = String(fp('mode') ?? 'blend');
        const op: Record<string, GlobalCompositeOperation> = { over: 'source-over', under: 'destination-over', screen: 'screen', add: 'lighter', softLight: 'soft-light', hardLight: 'hard-light', lighten: 'lighten', darken: 'darken', multiply: 'multiply', difference: 'difference', color: 'color', overlay: 'overlay', luminosity: 'luminosity', overClassic: 'source-over', underClassic: 'destination-over' };
        if (String(fp('clearTo')) === 'current') g.drawImage(place(cs[cs.length - 1]) ?? base.cv, 0, 0);
        // oldest first: the buffer fades by the accumulation factor and the next frame goes on top in the mode
        for (const c of cs) {
          const m = place(c); if (!m) continue;
          if (mode === 'blend' || mode === 'blendClassic') { const tmp = mk(W, H), tg = ctx2d(tmp); tg.globalAlpha = a; tg.drawImage(out, 0, 0); tg.globalAlpha = 1 - a; tg.globalCompositeOperation = 'lighter'; tg.drawImage(m, 0, 0); g.clearRect(0, 0, W, H); g.drawImage(tmp, 0, 0); }
          else { const tmp = mk(W, H), tg = ctx2d(tmp); tg.globalAlpha = a; tg.drawImage(out, 0, 0); tg.globalAlpha = 1; tg.globalCompositeOperation = op[mode] ?? 'source-over'; tg.drawImage(m, 0, 0); g.clearRect(0, 0, W, H); g.drawImage(tmp, 0, 0); }
        }
      } else if (TIME_TIEMPO[tf!.fx]) {
        // tiempo effects (fx-groups/tiempo.ts); another layer at another moment is stretched over this one
        const o = TIME_TIEMPO[tf!.fx].other?.(fp, t, l.id), oc = o ? this.inputOf(comp, l, o.t, base.res, depth, kp)(o.id) : null;
        let ov: HTMLCanvasElement | null = null;
        if (oc) { ov = mk(W, H); ctx2d(ov).drawImage(oc.cv, 0, 0, W, H); }
        const centred = l.type === 'text' || l.type === 'shape';
        g.drawImage(TIME_TIEMPO[tf!.fx].draw(base.cv, cs.map(place), fp, { g: { ox: base.ox, oy: base.oy, res: base.res, pox: centred ? comp.width / 2 : 0, poy: centred ? comp.height / 2 : 0 }, t, times, other: ov }), 0, 0);
      } else if (tf!.fx === 'rollingShutter') {
        g.drawImage(rollingShutterRepair(base.cv, place(cs[0]), place(cs[1]), (k) => fp(k)), 0, 0);
      } else {
        // Time Displacement: the map's brightness picks the moment for each pixel (white = +max, black = −max)
        const mapId = String(fp('map') ?? '');
        const map = mapId ? this.inputOf(comp, l, t, base.res, depth, kp)?.(mapId) ?? null : null;
        const md = mk(W, H), mg = ctx2d(md);
        if (map) { if (num(fp('stretch'), 1)) mg.drawImage(map.cv, 0, 0, W, H); else mg.drawImage(map.cv, (map.ox - base.ox) * base.res, (map.oy - base.oy) * base.res); }
        else { mg.fillStyle = '#808080'; mg.fillRect(0, 0, W, H); }
        const mdat = mg.getImageData(0, 0, W, H).data, slices = cs.map((c) => { const m = place(c); return m ? ctx2d(m).getImageData(0, 0, W, H).data : null; });
        const o = new ImageData(W, H), last = slices.length - 1;
        for (let i = 0; i < mdat.length; i += 4) {
          const v = (mdat[i] * 0.299 + mdat[i + 1] * 0.587 + mdat[i + 2] * 0.114) / 255, k = Math.max(0, Math.min(last, Math.round(v * last))), s = slices[k];
          if (s) { o.data[i] = s[i]; o.data[i + 1] = s[i + 1]; o.data[i + 2] = s[i + 2]; o.data[i + 3] = s[i + 3]; }
        }
        g.putImageData(o, 0, 0);
      }
      return { ...base, cv: out };
    }

    // effect parameters (evaluated once; needed for padding)
    const cut = this.fxCut.get(l.id), upTo = cut ? l.effects.slice(0, Math.max(0, l.effects.findIndex((f) => f.id === cut))) : l.effects;
    const fxs = upTo.filter((f) => f.on).map((f) => ({ f, fx: f.fx, on: true, p: Object.fromEntries(Object.entries(f.params).map(([k, v]) => [k, evt(v, `effects.${f.id}.${k}`)])),
      at: (k: string, tt: number): PVal => valueAt(f.params[k], tt, env(`effects.${f.id}.${k}`)) }));
    // layer styles (after the effects): their parameters at t, and the room they need around the layer
    const sts = (cut ? [] : l.styles ?? []).filter((y) => y.on).map((y) => ({ fx: y.fx, on: true, p: Object.fromEntries(Object.entries(y.params).map(([k, v]) => [k, evt(v, `styles.${y.id}.${k}`)])) }));
    this.stylesNow.set(l.id, sts);
    const grow = fxGrowth(fxs) + styleGrowth(sts);

    let w = 0, h = 0, ox = 0, oy = 0, res = res0;
    let draw: ((g: CanvasRenderingContext2D) => void) | null = null;
    const key = `${kp}${l.id}`;
    switch (l.type) {
      case 'solid': {
        w = l.solid!.width; h = l.solid!.height; res = Math.min(res0, 2);
        draw = (g) => { g.fillStyle = l.solid!.color; g.fillRect(0, 0, w, h); };
        break;
      }
      case 'video': case 'image': case 'sequence': {
        const m = l.type === 'sequence' ? null : this.mediaOf(l.mediaId);
        // footage proxy: the lighter file, drawn at the layer's (original) size
        const px = m?.proxy && this.useProxy(m.proxy.on, false) ? m.proxy : null;
        const path = l.type === 'sequence' ? this.opts.sequencePath : px?.path ?? m?.path;
        w = l.solid?.width ?? m?.width ?? comp.width; h = l.solid?.height ?? m?.height ?? comp.height;
        res = Math.min(1, res0);
        if (!path) return null;
        // frame blending: between two source frames both are fetched, then cross-faded (Frame Mix) or rebuilt from
        // the motion of each pixel (Pixel Motion); Timewarp's method wins over the layer switch
        const method = tw ? String(valueAt(tw.params.method, t, env(`effects.${tw.id}.method`)) ?? 'pixel') : l.frameBlend === 'pixel' ? 'pixel' : l.frameBlend ? 'mix' : 'whole';
        const fps = m?.fps || 0, mixT = method !== 'whole' && l.type === 'video' && fps > 0 ? srcTime * fps : NaN;
        const f0 = Math.floor(mixT), frac = mixT - f0, mix = Number.isFinite(mixT) && frac > 0.01 && frac < 0.99;
        if (this.dry && m?.exr && this.auxNeeds(l, m.exr).ch.length) {
          const an = this.auxNeeds(l, m.exr), x = m.exr;
          const file = x.pattern ? x.pattern.replace(/%0(\d+)d/, (_, pd) => String(Math.max(x.first ?? 0, Math.min(x.last ?? 0, (x.first ?? 0) + Math.floor(srcTime * (x.fps ?? fps) + 1e-6)))).padStart(Number(pd), '0')) : x.source;
          const url = `cinta-media://exr/?file=${encodeURIComponent(file)}&ch=${encodeURIComponent(an.ch.join(','))}${an.crypto ? `&crypto=${encodeURIComponent(an.crypto)}&sel=${encodeURIComponent(an.sel)}` : ''}`;
          this.needs.push({ key: url, mediaId: m.id, path: url, kind: 'aux', time: 0 });
        }
        if (this.dry) {
          const kind = l.type === 'image' ? 'image' : 'video', mediaId = l.mediaId ?? 'sequence';
          if (mix) { this.needs.push({ key, mediaId, path, kind, time: f0 / fps + 0.5 / fps }); this.needs.push({ key: `${key}#b`, mediaId, path, kind, time: (f0 + 1) / fps + 0.5 / fps }); }
          else this.needs.push({ key, mediaId, path, kind, time: Math.max(0, srcTime) });
          return null;
        }
        // EXR footage: the channels its 3D Channel effects read, for the frame shown
        if (m?.exr && this.auxNeeds(l, m.exr).ch.length) {
          const an = this.auxNeeds(l, m.exr), x = m.exr;
          const file = x.pattern ? x.pattern.replace(/%0(\d+)d/, (_, pd) => String(Math.max(x.first ?? 0, Math.min(x.last ?? 0, (x.first ?? 0) + Math.floor(srcTime * (x.fps ?? fps) + 1e-6)))).padStart(Number(pd), '0')) : x.source;
          const url = `cinta-media://exr/?file=${encodeURIComponent(file)}&ch=${encodeURIComponent(an.ch.join(','))}${an.crypto ? `&crypto=${encodeURIComponent(an.crypto)}&sel=${encodeURIComponent(an.sel)}` : ''}`;
          this.auxNow.set(key, url);
        }
        const fr = this.src.frame(key), fb = mix ? this.src.frame(`${key}#b`) : null;
        if (!fr) return null;
        // Media Replacement: other footage fills the placeholder's frame (scaled to cover it, centred, cropped)
        const fw = px?.width || m?.width || w, fh = px?.height || m?.height || h, k = l.fit === 'cover' ? Math.max(w / fw, h / fh) : 0;
        const blit = (g: CanvasRenderingContext2D, im: CanvasImageSource) => { if (k) g.drawImage(im, (fw - w / k) / 2, (fh - h / k) / 2, w / k, h / k, 0, 0, w, h); else g.drawImage(im, 0, 0, w, h); };
        if (fb && method === 'pixel') {
          // both frames at the layer's size, the flow between them, and the in-between frame
          const A = mk(w, h), B = mk(w, h);
          blit(ctx2d(A), fr); blit(ctx2d(B), fb);
          const ad = ctx2d(A).getImageData(0, 0, w, h), bd = ctx2d(B).getImageData(0, 0, w, h).data;
          const detail = tw ? num(valueAt(tw.params.vectorDetail, t, env(`effects.${tw.id}.vectorDetail`)), 20) : 20;
          const smooth = tw ? num(valueAt(tw.params.smoothing, t, env(`effects.${tw.id}.smoothing`)), 50) / 100 : 0.5;
          const flowKey = `${key}|${f0}|${detail}|${smooth}`;
          let flow = this.flowCache.get(flowKey);
          if (!flow) { flow = opticalFlow(ad.data, bd, w, h, detail, smooth); this.flowCache.clear(); this.flowCache.set(flowKey, flow); }
          const out = new ImageData(w, h);
          pixelMotion(ad.data, bd, w, h, frac, flow, out.data);
          const M = mk(w, h); ctx2d(M).putImageData(out, 0, 0);
          draw = (g) => g.drawImage(M, 0, 0, w, h);
          break;
        }
        draw = (g) => { blit(g, fr); if (fb) { g.globalAlpha = frac; blit(g, fb); g.globalAlpha = 1; } };
        break;
      }
      case 'comp': {
        const sub0 = this.project.comps?.find((c) => c.id === l.compId);
        if (!sub0) return null;
        // comp proxy: its pre-rendered movie, drawn like footage (no nested rendering)
        if (sub0.proxy && this.useProxy(sub0.proxy.on, true)) {
          const id = `proxy:${sub0.id}`;
          this.virtualMedia.set(id, { id, path: sub0.proxy.path, kind: 'video', duration: sub0.duration, width: sub0.width, height: sub0.height, fps: sub0.fps, hasAudio: false, hasVideo: true });
          return this.content(comp, { ...l, type: 'video', mediaId: id, solid: { color: '#000000', width: sub0.width, height: sub0.height } }, t0, res0, depth, kp, withEcho);
        }
        const sub = this.withOverrides(comp, l, sub0, t);
        w = sub.width; h = sub.height; res = Math.min(2, res0);
        const cv = this.drawComp(sub, srcTime, res, depth + 1, `${key}/`, true);
        if (this.dry) return null;
        draw = (g) => g.drawImage(cv, 0, 0, w, h);
        break;
      }
      case 'text': {
        if (this.dry) return null;
        return this.text(comp, l, t, res0, grow, fxs, kp);
      }
      case 'shape': {
        if (this.dry) return null;
        return this.shapes(comp, l, t, res0, grow, fxs, kp);
      }
      default: return null;
    }
    if (this.dry) return null;
    const pad = grow + upscalePad(fxs, w, h, comp.width, comp.height, grow);
    ox = -pad; oy = -pad;
    const cv = mk((w + pad * 2) * res, (h + pad * 2) * res);
    const g = ctx2d(cv);
    g.setTransform(res, 0, 0, res, pad * res, pad * res);
    draw!(g);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return this.finish(comp, l, t, { cv, ox, oy, res }, fxs, kp, depth);
  }

  /** EXR channel url of each layer key this frame (read by its 3D Channel effects in finish) */
  private auxNow = new Map<string, string>();
  /** The channels an EXR layer's effects read now: EXtractoR's four, IDentifier's ID channel, a Cryptomatte layer's ranks. */
  private auxNeeds(l: Layer, x: NonNullable<MediaItem['exr']>): { ch: string[]; crypto?: string; sel: string } {
    const ch = new Set<string>();
    let crypto: string | undefined, sel = '';
    const names = x.channels.map((c) => c.name);
    for (const f of l.effects) {
      if (!f.on) continue;
      const v = (k: string) => String(f.params[k]?.v ?? '');
      if (f.fx === 'extractor') for (const k of ['red', 'green', 'blue', 'alpha']) { const n = v(k); if (names.includes(n)) ch.add(n); }
      if (f.fx === 'identifier') { const n = v('channel') || names.find((c) => /(^|\.)(id|objectid|object_id|matid|material_id)$/i.test(c)) || ''; if (names.includes(n)) ch.add(n); }
      if (f.fx === 'cryptomatte') {
        const cl = x.crypto.find((c) => c.name === v('layer')) ?? x.crypto[0];
        if (cl) { crypto = cl.name; sel = v('selection'); for (const n of cl.channels) ch.add(n); }
      }
      for (const n of canal3dChannels(f.fx, v, names)) ch.add(n);
    }
    return { ch: [...ch], crypto, sel };
  }
  /** media by id (project files, or the movie of a comp proxy) */
  private virtualMedia = new Map<string, MediaItem>();
  /** what the Warp Stabilizer needs of its layer: source time, size and the key of the analysis it should have */
  private stabLayer(comp: Comp, l: Layer, t: number, detailed: boolean) {
    const m = l.type === 'video' ? this.mediaOf(l.mediaId) : undefined;
    const srcTime = l.timeRemap ? num(valueAt(l.timeRemap, t, { comp, layer: l, path: 'timeRemap' })) : (t - l.start) / (l.stretch || 1);
    return { video: !!m?.path, srcTime, W: l.solid?.width ?? m?.width ?? comp.width, H: l.solid?.height ?? m?.height ?? comp.height, key: m?.path ? stabSpan(l, m, comp.fps, detailed).key : null };
  }
  private mediaOf(id?: string): MediaItem | undefined { return id ? this.project.media.find((x) => x.id === id) ?? this.virtualMedia.get(id) : undefined; }
  private useProxy(on: boolean, isComp: boolean): boolean {
    const p = this.opts.proxies ?? 'current';
    return p === 'all' || (p === 'current' && on) || (p === 'comps' && isComp);
  }

  /** Essential Graphics: the nested comp with this layer's Master Properties (evaluated at the parent's time) in
   *  place of its own values. Only the layers that change are copied. */
  private withOverrides(comp: Comp, l: Layer, sub: Comp, t: number): Comp {
    if (!l.overrides?.length || !sub.essential?.length) return sub;
    const copies = new Map<string, Layer>();
    for (const o of l.overrides) {
      const ep = sub.essential.find((x) => x.id === o.id);
      const orig = ep && sub.layers.find((y) => y.id === ep.layer);
      if (!ep || !orig) continue;
      let y = copies.get(orig.id);
      if (!y) { y = structuredClone(orig); copies.set(orig.id, y); }
      const v = valueAt(o.prop, t, { comp, layer: l, path: `essential.${o.id}` });
      if (ep.path === 'source') {
        if (v !== orig.mediaId && this.project.media.some((x) => x.id === v)) { y.mediaId = String(v); y.fit = 'cover'; }
        continue;
      }
      try { const prop = resolveProp(y, ep.path, false); prop.v = v; delete prop.k; delete prop.x; } catch { /* the exposed property no longer exists */ }
    }
    return copies.size ? { ...sub, layers: sub.layers.map((y) => copies.get(y.id) ?? y) } : sub;
  }

  /** masks + effects */
  /** Other layers this layer's effects read (layer-type parameters). */
  private fxInputs(comp: Comp, l: Layer): Layer[] {
    const ids = new Set<string>();
    for (const f of l.effects) if (f.on) for (const p of Object.values(f.params)) if (typeof p.v === 'string' && p.v && p.v !== l.id) ids.add(p.v);
    return comp.layers.filter((x) => ids.has(x.id));
  }

  private needAudio(r: Layer) {
    if (r.type !== 'audio' && r.type !== 'video') return;
    const m = this.project.media.find((x) => x.id === r.mediaId);
    if (m?.path && m.hasAudio !== false) this.needs.push({ key: `audio:${m.path}`, mediaId: m.id, path: m.path, kind: 'audio', time: 0 });
  }
  /** Sound of another layer for an audio effect: its decoded samples and where its source is at comp time t. */
  private audioOf(comp: Comp, t: number) {
    return (id: string): { pcm: Pcm; time: number } | null => {
      const r = comp.layers.find((x) => x.id === id);
      if (!r || (r.type !== 'audio' && r.type !== 'video')) return null;
      const m = this.project.media.find((x) => x.id === r.mediaId);
      const pcm = m?.path ? this.src.audio?.(m.path) : null;
      return pcm ? { pcm, time: (t - r.start) / (r.stretch || 1) } : null;
    };
  }
  /** effects cut short: layer id → the effect whose input is being drawn (the effects from it on are left out) */
  private fxCut = new Map<string, string>();
  /** Temporal Smoothing windows of this frame's auto corrections (key: layer key / effect id) and the analyses of
   *  frames already seen (the same layer and effects up to it at that moment) */
  private autoNow = new Map<string, { frames: (AutoFrame | null)[]; at: number }>();
  private autoCache = new Map<string, AutoFrame>();
  /** Auto Levels / Contrast / Color with Temporal Smoothing: the frames within half the smoothing on each side of t
   *  (in the layer), each one the layer drawn up to the effect; the dry pass asks for those not analysed yet. */
  private autoWindow(comp: Comp, l: Layer, t: number, res: number, depth: number, kp: string) {
    l.effects.forEach((f, idx) => {
      if (!f.on || (f.fx !== 'autoLevels' && f.fx !== 'autoContrast' && f.fx !== 'autoColor')) return;
      const sm = num(valueAt(f.params.smoothing, t, { comp, layer: l, path: `effects.${f.id}.smoothing` }));
      const key = `${kp}${l.id}/${f.id}`;
      if (sm <= 0) { this.autoNow.delete(key); return; }
      const fps = comp.fps, half = Math.floor((Math.round(sm * fps) + 1) / 2), f0 = Math.round(t * fps);
      const sig = hashStr(JSON.stringify({ ...l, effects: l.effects.slice(0, idx) })) + `|${res}`;
      const frames: (AutoFrame | null)[] = [];
      let at = 0;
      for (let k = -half; k <= half; k++) {
        const tt = (f0 + k) / fps;
        if (tt < l.in - 1e-6 || tt >= l.out - 1e-6) continue;
        if (!k) { at = frames.length; frames.push(null); continue; }
        const ck = `${sig}|${f0 + k}`;
        let fr = this.autoCache.get(ck) ?? null;
        if (!fr) {
          this.fxCut.set(l.id, f.id);
          let c: Content | null = null;
          try { c = this.content(comp, l, tt, res, depth, `${kp}au${k}/`, false); } finally { this.fxCut.delete(l.id); }
          if (c && !this.dry) {
            fr = autoFrame(c.cv, false);
            if (this.autoCache.size > 3000) this.autoCache.clear();
            this.autoCache.set(ck, fr);
          }
        }
        if (fr) frames.push(fr);
      }
      if (!this.dry) this.autoNow.set(key, { frames, at });
    });
  }

  /** Refine mattes with Reduce Chatter / Use Motion Blur: the layer drawn up to the effect at the frames around t and
   *  across the shutter (fx-groups/canal3d.ts matteTimes); the dry pass asks for their sources. */
  private matteNow = new Map<string, MatteWindow>();
  private matteWindow(comp: Comp, l: Layer, t: number, res: number, depth: number, kp: string) {
    for (const f of l.effects) {
      if (!f.on || (f.fx !== 'refineHardMatte' && f.fx !== 'refineSoftMatte')) continue;
      const key = `${kp}${l.id}/${f.id}`, tm = matteTimes((k) => valueAt(f.params[k], t, { comp, layer: l, path: `effects.${f.id}.${k}` }), t, comp.fps);
      if (tm.prev === undefined && !tm.blur.length) { this.matteNow.delete(key); continue; }
      const at = (tt: number | undefined, k: string) => (tt === undefined || tt < l.in - 1e-6 || tt >= l.out - 1e-6 ? null : this.content(comp, l, tt, res, depth, `${kp}rm${k}/`, false));
      this.fxCut.set(l.id, f.id);
      try {
        const w: MatteWindow = { prev: at(tm.prev, 'p'), next: at(tm.next, 'n'), blur: tm.blur.map((tt, i) => at(tt, `b${i}`)) };
        if (!this.dry) this.matteNow.set(key, w);
      } finally { this.fxCut.delete(l.id); }
    }
  }
  /** Depth buffer of the comp below an adjustment layer (3D Channel effects on it): each layer's content where it is
   *  drawn, 3D models with their per-pixel depth, every layer's index as its object ID. */
  private compDepth(comp: Comp, self: Layer, t: number, s: number, W: number, H: number, depth: number, kp: string): Depth3D {
    const cam = cameraAt(comp, t), items: DepthItem[] = [];
    const solo = comp.layers.some((y) => y.solo && isVisual(y));
    const below = comp.layers.slice(comp.layers.indexOf(self) + 1).reverse();
    for (const y of below) {
      if (!isVisual(y) || y.type === 'adjustment' || t < y.in || t >= y.out || (solo ? !y.solo : y.hidden)) continue;
      const id = comp.layers.indexOf(y) + 1;
      if (this.isMesh(comp, y, t)) { const r = this.modelRender(comp, y, t, s, W, H, kp); if (r) items.push({ id, model: r }); continue; }
      const pl = this.place(comp, y, t, s, depth, kp);
      if (!pl) continue;
      const c = pl.content, m = mul(cam.view, worldMatrix(comp, y, t)), x1 = c.ox + c.cv.width / c.res, y1 = c.oy + c.cv.height / c.res;
      const z = [[c.ox, c.oy], [x1, c.oy], [x1, y1], [c.ox, y1]].map(([a, b]) => apply(m, a, b, 0)[2]);
      const o = apply(m, 0, 0, 0), e = apply(m, 0, 0, 1), nv = [e[0] - o[0], e[1] - o[1], e[2] - o[2]], nl = Math.hypot(nv[0], nv[1], nv[2]) || 1;
      items.push({ id, cv: c.cv, pts: pl.pts, z, n: nv.map((v) => v / nl), test: !!y.threeD });
    }
    return rasterDepth(W, H, items);
  }

  /** CC Time Blend FX: the buffer each Paste instance blends in (key: layer id / effect id), the layers whose window is
   *  being drawn, and the buffers already worked out (the layer as it was at the Copy instance at that frame) */
  private tbfxBuf = new Map<string, Content | null>();
  private tbfxBusy = new Set<string>();
  private tbfxCache = new Map<string, Content>();
  /** The first Paste instance's buffer at the frame before t: the layer up to the Copy instance below it (or to its
   *  end) frame after frame from where the accumulation has faded under 1/255 (60 frames at most), each frame's Paste
   *  blending the frame before — the effects between them feed back. The dry pass asks for those frames. */
  private timeBlendFxWindow(comp: Comp, l: Layer, t: number, res: number, depth: number, kp: string) {
    if (this.tbfxBusy.has(l.id)) return;
    const ins = (f: FxInstance) => (f.on && f.fx === 'ccTimeBlendFx' ? String(valueAt(f.params.instance, t, { comp, layer: l, path: `effects.${f.id}.instance` })) : '');
    const i = l.effects.findIndex((f) => ins(f) === 'paste');
    if (i < 0) return;
    const P = l.effects[i], C = l.effects.slice(i + 1).find((f) => ins(f) === 'copy');
    const a = Math.max(0, Math.min(1, num(valueAt(P.params.accumulation, t, { comp, layer: l, path: `effects.${P.id}.accumulation` }), 0.75)));
    const back = a <= 0 ? 0 : Math.min(60, Math.ceil(Math.log(1 / 255) / Math.log(Math.min(a, 0.999)))), fps = comp.fps, f0 = Math.round(t * fps);
    const sig = hashStr(JSON.stringify(l)) + `|${res}`, key = `${l.id}/${P.id}`;
    let buf: Content | null = null, from = back;
    // the latest frame already worked out (playback goes one frame at a time)
    if (!this.dry) for (let k = 1; k <= back; k++) { const hit = this.tbfxCache.get(`${sig}|${f0 - k}`); if (hit) { buf = hit; from = k - 1; break; } }
    this.tbfxBusy.add(l.id);
    try {
      for (let k = from; k >= 1; k--) {
        const fr = f0 - k, tt = fr / fps;
        if (tt < l.in - 1e-6) continue;
        this.tbfxBuf.set(key, buf);
        if (C) this.fxCut.set(l.id, C.id);
        let c: Content | null = null;
        try { c = this.content(comp, l, tt, res, depth, `${kp}tb${k}/`, false); } finally { if (C) this.fxCut.delete(l.id); }
        if (!this.dry) { buf = c; if (c) { if (this.tbfxCache.size > 400) this.tbfxCache.clear(); this.tbfxCache.set(`${sig}|${fr}`, c); } }
      }
    } finally { this.tbfxBusy.delete(l.id); }
    this.tbfxBuf.set(key, buf);
  }
  private timeBlendFxPaste(l: Layer, id: string, p: Record<string, unknown>, cv: HTMLCanvasElement, x: FxCtx): HTMLCanvasElement {
    const b = this.tbfxBuf.get(`${l.id}/${id}`) ?? null;
    let bc: HTMLCanvasElement | null = null;
    if (b) { bc = mk(cv.width, cv.height); const k = x.res / b.res; ctx2d(bc).drawImage(b.cv, (b.ox - x.ox) * x.res, (b.oy - x.oy) * x.res, b.cv.width * k, b.cv.height * k); }
    return timeBlendStep(bc, cv, num(p.accumulation, 0.75), String(p.mode ?? 'blend'), String(p.clearTo ?? 'transparent'));
  }
  /** Color Stabilizer: this layer drawn up to the effect at its Set Frame time (composition seconds), for p._ref */
  private stabNow = new Map<string, Content>();
  private stabRefs(comp: Comp, l: Layer, t: number, res: number, depth: number, kp: string) {
    l.effects.forEach((f) => {
      if (f.fx !== 'colorStabilizer') return;
      const key = `${kp}${l.id}/${f.id}`;
      this.stabNow.delete(key);
      if (!f.on) return;
      const tr = num(valueAt(f.params.setFrame, t, { comp, layer: l, path: `effects.${f.id}.setFrame` }));
      if (Math.abs(tr - t) < 1e-6 || tr < l.in - 1e-6 || tr >= l.out - 1e-6) return;
      this.fxCut.set(l.id, f.id);
      let c: Content | null = null;
      try { c = this.content(comp, l, tr, res, depth, `${kp}cs/`, false); } finally { this.fxCut.delete(l.id); }
      if (c && !this.dry) this.stabNow.set(key, c);
    });
  }

  /** Source of another layer for an effect input: its content (masks and effects, no transform) at time t. */
  private inputOf(comp: Comp, self: Layer, t: number, res: number, depth: number, kp: string) {
    return (id: string): Content | null => {
      if (!id || id === self.id || this.refDepth > 3) return null;
      const r = comp.layers.find((x) => x.id === id);
      if (!r) return null;
      this.refDepth++;
      try { return this.content(comp, r, t, res, depth, kp, true); } finally { this.refDepth--; }
    };
  }
  private refDepth = 0;

  // ───────────────────────── paint (paint.ts) ─────────────────────────
  /** layers whose paint is skipped while their own source is read for a clone stroke at another time */
  private noPaint = new Set<string>();
  private paintFx(comp: Comp, l: Layer, t: number, f: FxInstance, p: Record<string, unknown>, cv: HTMLCanvasElement, x: FxCtx, depth: number, kp: string): HTMLCanvasElement {
    if (this.noPaint.has(l.id)) return cv;
    const self: PaintSrc = { cv, ox: x.ox, oy: x.oy, res: x.res };
    return drawPaint(cv, f, !!num(p.onTransparent), x, {
      tl: t - l.start,
      ev: (pr, path) => valueAt(pr, t, { comp, layer: l, path }),
      source: (s, i) => this.cloneSource(comp, l, t, s, i, x.res, depth, kp, self),
    });
  }
  /** comp time a clone stroke reads its source at: Clonar tiempo when locked, else now + Clonar cambio de tiempo */
  private cloneTime(comp: Comp, l: Layer, t: number, s: PaintStroke, fxId: string): number {
    const c = s.clone!, b = `effects.${fxId}.strokes.${s.id}.clone`;
    return c.lock ? num(valueAt(c.time, t, { comp, layer: l, path: `${b}.time` }), t) : t + num(valueAt(c.timeShift, t, { comp, layer: l, path: `${b}.timeShift` }));
  }
  private cloneSource(comp: Comp, l: Layer, t: number, s: PaintStroke, i: number, res: number, depth: number, kp: string, self: PaintSrc | null): PaintSrc | null {
    const fx = l.effects.find((f) => f.fx === 'paint');
    if (!s.clone || !fx) return null;
    const tt = this.cloneTime(comp, l, t, s, fx.id), id = s.clone.source || l.id;
    if (id === l.id && Math.abs(tt - t) < 1e-6) return self;
    const r = comp.layers.find((y) => y.id === id);
    if (!r || this.refDepth > 3) return null;
    const own = id === l.id && !this.noPaint.has(l.id);
    this.refDepth++;
    if (own) this.noPaint.add(l.id);
    try { return this.content(comp, r, tt, res, depth, `${kp}cl${i}/`, true); } finally { this.refDepth--; if (own) this.noPaint.delete(l.id); }
  }
  /** dry pass: the media clone strokes read (other layers, other times) */
  private cloneInputs(comp: Comp, l: Layer, t: number, s: number, depth: number, kp: string) {
    const fx = l.effects.find((f) => f.on && f.fx === 'paint');
    fx?.strokes?.forEach((st, i) => { if (st.kind === 'clone' && t - l.start >= st.in - 1e-6 && t - l.start < st.out - 1e-6) this.cloneSource(comp, l, t, st, i, s, depth, kp, null); });
  }
  /** optical flow of the last pair of frames (Pixel Motion): consecutive in-between frames reuse it */
  private flowCache = new Map<string, ReturnType<typeof opticalFlow>>();
  /** layer styles evaluated by content() for finish() (same layer, same call) */
  private stylesNow = new Map<string, { fx: string; on: boolean; p: Record<string, unknown> }[]>();

  private finish(comp: Comp, l: Layer, t: number, c0: Content, fxs: { f: { id: string; fx: string }; fx: string; p: Record<string, unknown>; at?: (k: string, t: number) => PVal }[], kp: string, depth = 0): Content {
    let c = c0;
    if (l.masks.length) c = { ...c, cv: this.masks(comp, l, t, c) };
    if (l.puppet?.on && l.puppet.pins.length && !this.dry) c = this.puppet(comp, l, t, c, fxGrowth(fxs) + styleGrowth(this.stylesNow.get(l.id) ?? []));
    let { cv } = c;
    const centred = l.type === 'text' || l.type === 'shape';
    const auxUrl = this.auxNow.get(`${kp}${l.id}`);
    // the masks now, also those set to None (mask generators draw on them without cutting)
    const maskLines = l.masks.map((m) => ({ id: m.id, name: m.name, mode: m.mode, inverted: m.inverted, pts: flattenBezier(rotoFlat(m, (valueAt(m.path, t, { comp, layer: l, path: `masks.${m.id}.path` }) as number[]) ?? []), true) }));
    const x: FxCtx = { res: c.res, ox: c.ox, oy: c.oy, t, fps: comp.fps, seed: hashStr(l.id), pox: centred ? comp.width / 2 : 0, poy: centred ? comp.height / 2 : 0, layer: this.inputOf(comp, l, t, c.res, depth, kp), audio: this.audioOf(comp, t), aux: auxUrl ? this.src.aux?.(auxUrl) ?? null : null, masks: maskLines, scene: () => this.fxScene(comp, l, t, c.res, depth, kp) };
    x.compSize = [comp.width, comp.height];
    x.depth3d = (dc) => layerDepth(dc, x, comp.layers.indexOf(l) + 1);
    x.src = cv;
    for (const { f, fx, at, ...q } of fxs) {
      x.at = at;
      if (fx === 'ccTimeBlendFx') { if (String(q.p.instance) === 'paste') cv = this.timeBlendFxPaste(l, f.id, q.p, cv, x); continue; }
      const win = this.autoNow.get(`${kp}${l.id}/${f.id}`), sr = this.stabNow.get(`${kp}${l.id}/${f.id}`), mw = this.matteNow.get(`${kp}${l.id}/${f.id}`);
      const p = win || sr || mw ? { ...q.p, ...(win ? { _frames: win } : {}), ...(sr ? { _ref: sr } : {}), ...(mw ? { _matte: mw } : {}) } : q.p;
      if (fx === 'cornerPin') { cv = this.cornerPin(cv, p, x); continue; }
      if (fx === 'paint') { cv = this.paintFx(comp, l, t, f as FxInstance, p, cv, x, depth, kp); continue; }
      if (fx === 'warpStabilizer') { cv = warpStabFx(cv, f as FxInstance, p, x, this.stabLayer(comp, l, t, !!num(p.detailed))); continue; }
      if (fx === 'rotoBrush') { cv = rotoBrushFx(cv, f as FxInstance, p, x, (t - l.start) / (l.stretch || 1)); continue; }
      cv = runFx(fx, cv, p, x);
    }
    const sts = this.stylesNow.get(l.id);
    if (sts?.length) cv = applyStyles(cv, sts, x);
    return { ...c, cv };
  }

  private masks(comp: Comp, l: Layer, t: number, c: Content): HTMLCanvasElement {
    const act = l.masks.filter((m) => m.mode !== 'none');
    if (!act.length) return c.cv;
    const W = c.cv.width, H = c.cv.height;
    const M = mk(W, H);
    const mg = ctx2d(M);
    if (act[0].mode === 'subtract') { mg.fillStyle = '#fff'; mg.fillRect(0, 0, W, H); }
    for (const m of act) {
      const ev = (p: Prop, k: string) => valueAt(p, t, { comp, layer: l, path: `masks.${m.id}.${k}` });
      const flat = rotoFlat(m, ev(m.path, 'path') as number[]);
      const feather = num(ev(m.feather, 'feather')) * c.res, op = num(ev(m.opacity, 'opacity'), 100) / 100, exp = num(ev(m.expansion, 'expansion')) * c.res;
      const pts = flattenBezier(Array.isArray(flat) ? flat : [], true);
      let T: HTMLCanvasElement;
      if (m.featherPts?.length && Array.isArray(flat) && flat.length >= 18) {
        // variable feather (Herramienta Calado de máscara): the feather points' radii along the edge
        const F = variableFeatherMask(W, H, flat, m, c, m.inverted ? 1 : op, exp / c.res);
        if (m.inverted) { T = mk(W, H); const tg = ctx2d(T); tg.fillStyle = `rgba(255,255,255,${op})`; tg.fillRect(0, 0, W, H); tg.globalCompositeOperation = 'destination-out'; tg.drawImage(F, 0, 0); } else T = F;
      } else {
        T = mk(W, H);
        const tg = ctx2d(T);
        const path = new Path2D();
        for (let i = 0; i < pts.length; i += 2) { const X = (pts[i] - c.ox) * c.res, Y = (pts[i + 1] - c.oy) * c.res; if (i) path.lineTo(X, Y); else path.moveTo(X, Y); }
        path.closePath();
        tg.fillStyle = `rgba(255,255,255,${op})`;
        if (m.inverted) { tg.fillRect(0, 0, W, H); tg.globalCompositeOperation = 'destination-out'; tg.fillStyle = '#fff'; }
        tg.fill(path);
        if (exp) { tg.lineJoin = 'round'; tg.lineWidth = Math.abs(exp) * 2; if ((exp > 0) !== m.inverted) { tg.strokeStyle = m.inverted ? '#fff' : `rgba(255,255,255,${op})`; tg.stroke(path); } else { tg.globalCompositeOperation = m.inverted ? 'source-over' : 'destination-out'; tg.strokeStyle = m.inverted ? `rgba(255,255,255,${op})` : '#fff'; tg.stroke(path); } }
      }
      const src = feather > 0.3 ? blurCanvas(T, feather / 2) : T;
      mg.globalCompositeOperation = m.mode === 'add' ? 'source-over' : m.mode === 'subtract' ? 'destination-out' : 'destination-in';
      mg.drawImage(src, 0, 0);
    }
    const out = mk(W, H);
    const og = ctx2d(out);
    og.drawImage(c.cv, 0, 0);
    og.globalCompositeOperation = 'destination-in';
    og.drawImage(M, 0, 0);
    return out;
  }

  private cornerPin(cv: HTMLCanvasElement, p: Record<string, unknown>, x: FxCtx): HTMLCanvasElement {
    const P = (k: string): [number, number] => { const v = p[k] as number[]; return [((v?.[0] ?? 0) - (x.pox ?? 0) - x.ox) * x.res, ((v?.[1] ?? 0) - (x.poy ?? 0) - x.oy) * x.res]; };
    const pts: [number, number][] = [P('tl'), P('tr'), P('br'), P('bl')];
    this.gl ??= new GLQuad();
    const glc = this.gl.draw(cv, cv.width, cv.height, pts, quadWeights(pts));
    const out = mk(cv.width, cv.height);
    ctx2d(out).drawImage(glc, 0, 0);
    return out;
  }

  // ───────────────────────── text ─────────────────────────
  private measure(font: string, s: string): number {
    const k = `${font}|${s}`;
    let v = this.measureCache.get(k);
    if (v === undefined) {
      this.measureCtx.font = font;
      v = this.measureCtx.measureText(s).width;
      if (this.measureCache.size > 20000) this.measureCache.clear();
      this.measureCache.set(k, v);
    }
    return v;
  }

  /** Text layout and the state of every glyph at t (animators, tracking, text on a path). */
  private glyphs(comp: Comp, l: Layer, t: number) {
    const d = l.text!;
    const ev = (p: Prop | undefined, path: string) => valueAt(p, t, { comp, layer: l, path });
    let str = String(ev(d.text, 'text.text') ?? '');
    const size = Math.max(1, num(ev(d.size, 'text.size'), 96));
    const fill = String(ev(d.fill, 'text.fill')), stroke = String(ev(d.stroke, 'text.stroke')), sw = num(ev(d.strokeWidth, 'text.strokeWidth'));
    const tracking = num(ev(d.tracking, 'text.tracking'));
    const font = `${d.italic ? 'italic ' : ''}${d.weight} ${size}px "${d.font}", "Segoe UI", system-ui, sans-serif`;
    // variable-font axes: glyphs measured and drawn from the font file's outlines
    const vfont = usesAxes(l) ? fontOf(d) : null;
    const vf = vfont ? { f: vfont, axes: axesAt(comp, l, t, vfont) } : null;
    const layout = layoutText(str, { size, tracking, leading: d.leading, align: d.align, box: d.path ? undefined : d.box, ...layoutExtras(d) }, vf ? (s) => measureAxes(vf.f, s, size, vf.axes) : (s) => this.measure(font, s));
    const G = layout.glyphs;
    if (!G.length) return null;
    const st = G.map(() => ({ dx: 0, dy: 0, dz: 0, sx: 1, sy: 1, rot: 0, rotY: 0, rotX: 0, op: 1, fill, stroke, blur: 0, skew: 0, off: 0, track: 0, faces: undefined as Partial<Record<'frontColor' | 'bevelColor' | 'sideColor' | 'backColor', [string, number]>> | undefined }));
    for (const an of d.animators) {
      const w = animatorWeights(comp, l, an, layout, t);
      const P = an.props;
      const pv = (k: keyof typeof P) => (P[k] ? ev(P[k], `text.animators.${an.id}.props.${k}`) : undefined);
      const pos = pv('position') as number[] | undefined, sc = pv('scale') as number[] | undefined, rot = pv('rotation'), rotY = pv('rotationY'), rotX = pv('rotationX'), op = pv('opacity');
      const fl = pv('fill'), sk = pv('stroke'), tk = pv('tracking'), bl = pv('blur'), skw = pv('skew'), off = pv('charOffset');
      // extruded text: Animar ▸ Frontal / Bisel / Lateral / Posterior ▸ Color
      const faces = (['frontColor', 'bevelColor', 'sideColor', 'backColor'] as const).map((k) => [k, pv(k)] as const).filter(([, v]) => v !== undefined);
      G.forEach((_, i) => {
        const wi = w[i];
        if (!wi) return;
        const s0 = st[i];
        if (pos) { s0.dx += num(pos[0]) * wi; s0.dy += num(pos[1]) * wi; s0.dz += num(pos[2]) * wi; }
        if (sc) { s0.sx *= 1 + (num(sc[0], 100) / 100 - 1) * wi; s0.sy *= 1 + (num(sc[1] ?? sc[0], 100) / 100 - 1) * wi; }
        if (rot !== undefined) s0.rot += num(rot) * wi;
        if (rotY !== undefined) s0.rotY += num(rotY) * wi;
        if (rotX !== undefined) s0.rotX += num(rotX) * wi;
        if (op !== undefined) s0.op *= Math.max(0, 1 + (num(op, 100) / 100 - 1) * wi);
        if (fl !== undefined) s0.fill = mixColor(s0.fill, String(fl), wi);
        if (sk !== undefined) s0.stroke = mixColor(s0.stroke, String(sk), wi);
        if (tk !== undefined) s0.track += (num(tk) * size / 1000) * wi;
        if (bl !== undefined) s0.blur = Math.max(s0.blur, num(bl) * wi);
        if (skw !== undefined) s0.skew += num(skw) * wi;
        if (off !== undefined) s0.off += num(off) * wi;
        for (const [k, v] of faces) { const prev = s0.faces?.[k]; (s0.faces ??= {})[k] = prev ? [mixColor(prev[0], String(v), wi), Math.max(prev[1], wi)] : [String(v), wi]; }
      });
    }
    // animator tracking pushes the following characters of the line
    const shift = new Array<number>(G.length).fill(0);
    let lineStart = 0;
    for (let i = 0; i <= G.length; i++) {
      if (i === G.length || (i > lineStart && G[i].line !== G[i - 1].line)) {
        let acc = 0;
        for (let j = lineStart; j < i; j++) { shift[j] = acc; acc += st[j].track; }
        const total = acc - (i > lineStart ? st[i - 1].track : 0);
        const k = d.align === 'center' ? total / 2 : d.align === 'right' ? total : 0;
        for (let j = lineStart; j < i; j++) shift[j] -= k;
        lineStart = i;
      }
    }
    // where each glyph's centre goes (and how it turns): along its line, or along the path
    const pivotY = -size * 0.35;
    const place = layout.vertical
      ? G.map((gl, i) => ({ x: gl.x + gl.w / 2, y: gl.y + shift[i] + pivotY * (gl.k ?? 1) * (gl.vs ?? 1), a: gl.rot ?? 0 }))
      : G.map((gl, i) => ({ x: gl.x + shift[i] + gl.w / 2, y: gl.y + pivotY * (gl.k ?? 1) * (gl.vs ?? 1), a: gl.rot ?? 0 }));
    const tp = d.path, tm = tp ? l.masks.find((m) => m.id === tp.mask) : undefined;
    if (tp && tm) {
      let pts = flattenBezier(rotoFlat(tm, (ev(tm.path, `masks.${tm.id}.path`) as number[]) ?? [], !tp.open), !tp.open);
      if (pts.length >= 4) {
        if (tp.reverse) { const r: number[] = []; for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i], pts[i + 1]); pts = r; }
        const acc = [0];
        for (let i = 2; i < pts.length; i += 2) acc.push(acc[acc.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
        const total = acc[acc.length - 1] || 1;
        const along = (s: number): [number, number, number] => {
          const c = Math.max(0, Math.min(total, s));
          let k = 1; while (k < acc.length - 1 && acc[k] < c) k++;
          const f = (c - acc[k - 1]) / Math.max(1e-6, acc[k] - acc[k - 1]);
          const ax = pts[(k - 1) * 2], ay = pts[(k - 1) * 2 + 1], bx = pts[k * 2], by = pts[k * 2 + 1];
          // past the ends the text keeps going straight
          const over = s < 0 ? s : s > total ? s - total : 0, ang = Math.atan2(by - ay, bx - ax);
          return [ax + (bx - ax) * f + Math.cos(ang) * over, ay + (by - ay) * f + Math.sin(ang) * over, ang];
        };
        const fm = num(ev(tp.firstMargin, 'text.path.firstMargin')), lm = num(ev(tp.lastMargin, 'text.path.lastMargin'));
        // each line runs along the path from the first margin (left), centred between the margins, or ending at
        // the last margin (right); force alignment spreads it between both
        const lines = new Map<number, number[]>();
        G.forEach((gl, i) => { if (!lines.has(gl.line)) lines.set(gl.line, []); lines.get(gl.line)!.push(i); });
        for (const idx of lines.values()) {
          const xs = idx.map((i) => G[i].x + shift[i]), x0l = Math.min(...xs), wl = Math.max(...idx.map((i) => G[i].x + shift[i] + G[i].w)) - x0l;
          const span = total - fm - lm;
          const start = tp.forceAlign ? fm : d.align === 'left' ? fm : d.align === 'right' ? total - lm - wl : fm + (span - wl) / 2;
          const k = tp.forceAlign && wl > 0 ? span / wl : 1;
          for (const i of idx) {
            const s = start + (G[i].x + shift[i] - x0l + G[i].w / 2) * k;
            const [px, py, ang] = along(s);
            // the line's baseline offset (later lines below) goes along the normal
            const off = G[i].y + pivotY;
            place[i] = { x: px - Math.sin(ang) * off, y: py + Math.cos(ang) * off, a: tp.perpendicular ? (ang * 180) / Math.PI : 0 };
          }
        }
      }
    }
    return { G, st, place, font, size, sw, pivotY, vf, fill, stroke };
  }

  /** «Crear formas / máscaras a partir del texto»: every visible character's outline from the font file, where this
   *  renderer draws it at t (layout, tracking, alignment, paragraph box, text on a path; animators are not baked). */
  async textOutlines(project: Project, comp: Comp, l: Layer, t: number): Promise<{ glyphs: GlyphOutline[]; fill: string; stroke: string; strokeWidth: number; font: string } | null> {
    this.project = project;
    const d = l.text;
    if (!d) return null;
    const f = await loadFont(d);
    if (!f) throw new Error(`No se pueden adquirir los contornos de la fuente «${d.font}».`);
    const gs = this.glyphs(comp, l, t);
    if (!gs) return { glyphs: [], fill: '#ffffff', stroke: '#000000', strokeWidth: 0, font: f.info.fullName };
    const axes = gs.vf?.axes ?? axesAt(comp, { ...l, text: { ...d, axes: undefined } }, t, f);
    const list = gs.G.map((g, i) => ({ g, p: gs.place[i] })).filter((x) => !x.g.space).map(({ g, p }) => ({ ch: g.ch, px: p.x, py: p.y, a: p.a, w: g.w }));
    return { glyphs: placedOutlines(f, list, gs.size, gs.pivotY, axes), fill: gs.fill, stroke: gs.stroke, strokeWidth: gs.sw, font: f.info.fullName };
  }

  private text(comp: Comp, l: Layer, t: number, res0: number, grow: number, fxs: Parameters<MotionRenderer['finish']>[4], kp: string): Content | null {
    const gs = this.glyphs(comp, l, t);
    if (!gs) return null;
    const { G, st, place, font, size, sw, pivotY, vf } = gs;
    // bounds
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    G.forEach((gl, i) => {
      const s0 = st[i];
      if (s0.op <= 0.001 || gl.space) return;
      const cx = place[i].x + s0.dx, cy = place[i].y + s0.dy;
      const r = (Math.max(gl.w, size) * Math.max(Math.abs(s0.sx), Math.abs(s0.sy)) + s0.blur * 3 + sw) * 0.85;
      x0 = Math.min(x0, cx - r); x1 = Math.max(x1, cx + r); y0 = Math.min(y0, cy - r); y1 = Math.max(y1, cy + r);
    });
    if (!Number.isFinite(x0)) return null;
    const pad = grow + 4;
    const res = Math.min(res0, 4096 / Math.max(1, x1 - x0 + pad * 2), 4096 / Math.max(1, y1 - y0 + pad * 2));
    const ox = x0 - pad, oy = y0 - pad;
    const cv = mk((x1 - x0 + pad * 2) * res, (y1 - y0 + pad * 2) * res);
    const g = ctx2d(cv);
    g.font = font;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.lineJoin = 'round';
    G.forEach((gl, i) => {
      const s0 = st[i];
      if (s0.op <= 0.001 || gl.space) return;
      const ch = s0.off ? offsetChar(gl.ch, s0.off) : gl.ch;
      g.setTransform(res, 0, 0, res, -ox * res, -oy * res);
      g.translate(place[i].x + s0.dx, place[i].y + s0.dy);
      if (s0.rot || place[i].a) g.rotate(((s0.rot + place[i].a) * Math.PI) / 180);
      const skew = s0.skew + (gl.fi ? FAUX_ITALIC : 0);
      if (skew) g.transform(1, 0, Math.tan((-skew * Math.PI) / 180), 1, 0, 0);
      const ry = Math.cos((s0.rotY * Math.PI) / 180), rx = Math.cos((s0.rotX * Math.PI) / 180);
      const gk = gl.k ?? 1, ghs = gk * (gl.hs ?? 1), gvs = gk * (gl.vs ?? 1);
      g.scale(s0.sx * ry * ghs, s0.sy * rx * gvs);
      g.globalAlpha = Math.min(1, s0.op);
      g.filter = s0.blur > 0.2 ? `blur(${s0.blur * res * Math.max(0.2, Math.abs(s0.sx)) / 2}px)` : 'none';
      // the advance box is in layout pixels: undo the glyph's own scale to centre it
      const x = -gl.w / ghs / 2, y = -pivotY, fb = gl.fb ? FAUX_BOLD * size : 0;
      if (vf) {
        g.translate(x, y);
        const p = glyphPath2D(vf.f, ch, size, vf.axes);
        if (sw > 0) { g.strokeStyle = s0.stroke; g.lineWidth = sw + fb; g.stroke(p); }
        if (fb) { g.strokeStyle = s0.fill; g.lineWidth = fb; g.stroke(p); }
        g.fillStyle = s0.fill;
        g.fill(p);
        return;
      }
      if (sw > 0) { g.strokeStyle = s0.stroke; g.lineWidth = sw + fb; g.strokeText(ch, x, y); }
      if (fb) { g.strokeStyle = s0.fill; g.lineWidth = fb; g.strokeText(ch, x, y); }
      g.fillStyle = s0.fill;
      g.fillText(ch, x, y);
    });
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.filter = 'none';
    return this.finish(comp, l, t, { cv, ox, oy, res }, fxs, kp);
  }

  // ───────────────────────── shapes ─────────────────────────
  private shapes(comp: Comp, l: Layer, t: number, res0: number, grow: number, fxs: Parameters<MotionRenderer['finish']>[4], kp: string): Content | null {
    const { pieces, x0, y0, x1, y1 } = this.shapePieces(comp, l, t);
    if (!pieces.length || !Number.isFinite(x0)) return null;
    const pad = Math.max(grow, fxGrowth(fxs, Math.max(x1 - x0, y1 - y0))) + 2;
    const res = Math.min(res0, 6000 / Math.max(1, x1 - x0 + pad * 2), 6000 / Math.max(1, y1 - y0 + pad * 2));
    const ox = x0 - pad, oy = y0 - pad;
    const cv = mk((x1 - x0 + pad * 2) * res, (y1 - y0 + pad * 2) * res);
    const g = ctx2d(cv);
    for (const p of pieces) {
      g.setTransform(new DOMMatrix([res, 0, 0, res, -ox * res, -oy * res]).multiply(p.m));
      g.globalAlpha = p.alpha;
      if (p.fill) { g.fillStyle = typeof p.fill === 'function' ? p.fill(g) : p.fill; g.fill(p.path, p.rule ?? 'nonzero'); }
      if (p.stroke && p.sw > 0) { g.strokeStyle = typeof p.stroke === 'function' ? p.stroke(g) : p.stroke; g.lineWidth = p.sw; g.lineCap = p.cap; g.lineJoin = p.join; g.setLineDash(p.dash); g.stroke(p.path); }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    return this.finish(comp, l, t, { cv, ox, oy, res }, fxs, kp);
  }
  /** The drawn pieces of a shape layer at t (outlines in layer px, paints) and their bounds. */
  private shapePieces(comp: Comp, l: Layer, t: number) {
    type Paint = string | CanvasGradient | ((g: CanvasRenderingContext2D) => CanvasGradient);
    // flat colours of the paints (extruded shapes: a gradient gives its first colour)
    type Piece = { path: Path2D; pts: number[][]; m: DOMMatrix; fill?: Paint; stroke?: Paint; sw: number; cap: CanvasLineCap; join: CanvasLineJoin; dash: number[]; alpha: number; rule?: CanvasFillRule; closed?: boolean[]; fillCol?: [string, number]; strokeCol?: [string, number] };
    const gradientPaint = (gd: { type: 'linear' | 'radial'; start: Prop; end: Prop; colors: string[] }, base: string, ev: (p: Prop | undefined, k: string) => PVal, op: number): Paint => {
      const g0 = ev(gd.start, `${base}.start`) as number[], g1 = ev(gd.end, `${base}.end`) as number[];
      return (g: CanvasRenderingContext2D) => { const gr = gd.type === 'radial' ? g.createRadialGradient(g0[0], g0[1], 0, g0[0], g0[1], Math.hypot(g1[0] - g0[0], g1[1] - g0[1])) : g.createLinearGradient(g0[0], g0[1], g1[0], g1[1]); gd.colors.forEach((c, i) => gr.addColorStop(gd.colors.length > 1 ? i / (gd.colors.length - 1) : 0, rgbaStr(c, op))); return gr; };
    };
    let mergeFrom = 0; // pieces since the last «Combinar trazados»
    const pieces: Piece[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const items = [...(l.shapes ?? [])].reverse();
    for (const s of items) {
      const ev = (p: Prop | undefined, k: string) => valueAt(p, t, { comp, layer: l, path: `shapes.${s.id}.${k}` });
      const a = ev(s.transform.anchor, 'transform.anchor') as number[], pos = ev(s.transform.position, 'transform.position') as number[];
      const sc = ev(s.transform.scale, 'transform.scale') as number[], rot = num(ev(s.transform.rotation, 'transform.rotation')), op = num(ev(s.transform.opacity, 'transform.opacity'), 100) / 100;
      if (s.kind === 'merge') {
        // boolean of the closed outlines below (in layer space), drawn with this item's fill / stroke and transform
        const below = pieces.splice(mergeFrom);
        const polys: Polygon[] = [];
        for (const pc of below) pc.pts.forEach((p, i) => { if ((pc.closed?.[i] ?? true) && p.length >= 6) { const ring: [number, number][] = []; for (let k = 0; k < p.length; k += 2) ring.push([p[k], p[k + 1]]); ring.push(ring[0]); polys.push([ring]); } });
        mergeFrom = pieces.length;
        if (!polys.length) continue;
        const mode = s.merge?.mode ?? 'add';
        let mp: MultiPolygon = [];
        try {
          mp = mode === 'subtract' ? polygonClipping.difference(polys[0], ...polys.slice(1))
            : mode === 'intersect' ? polygonClipping.intersection(polys[0], ...polys.slice(1))
            : mode === 'exclude' ? polygonClipping.xor(polys[0], ...polys.slice(1))
            : polygonClipping.union(polys[0], ...polys.slice(1));
        } catch { mp = []; }
        const mpos = ev(s.transform.position, 'transform.position') as number[], msc = ev(s.transform.scale, 'transform.scale') as number[], ma = ev(s.transform.anchor, 'transform.anchor') as number[];
        const mm = new DOMMatrix().translate(num(mpos?.[0]), num(mpos?.[1])).rotate(num(ev(s.transform.rotation, 'transform.rotation'))).scale(num(msc?.[0], 100) / 100, num(msc?.[1], 100) / 100).translate(-num(ma?.[0]), -num(ma?.[1]));
        const mpath = new Path2D(), mpts: number[][] = [];
        for (const poly of mp) for (const ring of poly) { const flat: number[] = []; ring.forEach(([x, y], k) => { if (k) mpath.lineTo(x, y); else mpath.moveTo(x, y); flat.push(x, y); }); mpath.closePath(); const tp: number[] = []; for (let k = 0; k < flat.length; k += 2) { const q = mm.transformPoint({ x: flat[k], y: flat[k + 1] }); tp.push(q.x, q.y); } mpts.push(tp); }
        if (!mpts.length) continue;
        const mOp = num(ev(s.transform.opacity, 'transform.opacity'), 100) / 100;
        const msw = s.stroke.on ? num(ev(s.stroke.width, 'stroke.width'), 4) : 0;
        for (const p of mpts) { const [a0, b0, a1, b1] = outlineBounds(p); x0 = Math.min(x0, a0 - msw); y0 = Math.min(y0, b0 - msw); x1 = Math.max(x1, a1 + msw); y1 = Math.max(y1, b1 + msw); }
        const fo = num(ev(s.fill.opacity, 'fill.opacity'), 100) / 100, so = num(ev(s.stroke.opacity, 'stroke.opacity'), 100) / 100;
        pieces.push({ path: mpath, pts: mpts, m: mm, rule: 'evenodd', alpha: mOp, sw: msw, cap: s.stroke.cap, join: s.stroke.join, dash: s.stroke.dash,
          fillCol: s.fill.on ? [s.gradient?.colors[0] ?? String(ev(s.fill.color, 'fill.color')), fo] : undefined, strokeCol: s.stroke.on ? [s.stroke.gradient?.colors[0] ?? String(ev(s.stroke.color, 'stroke.color')), so] : undefined,
          fill: s.fill.on ? (s.gradient ? gradientPaint(s.gradient, 'gradient', ev, fo) : rgbaStr(String(ev(s.fill.color, 'fill.color')), fo)) : undefined,
          stroke: s.stroke.on ? (s.stroke.gradient ? gradientPaint(s.stroke.gradient, 'stroke.gradient', ev, so) : rgbaStr(String(ev(s.stroke.color, 'stroke.color')), so)) : undefined });
        mergeFrom = pieces.length;
        continue;
      }
      let parts = [shapeOutline(comp, l, s, t)];
      for (const cp of s.contours ?? []) parts.push(shapeOutline(comp, l, { ...s, path: { v: cp }, closed: true, contours: undefined }, t));
      if (s.trim) parts = parts.flatMap((o) => trimOutline(o, num(ev(s.trim!.start, 'trim.start')), num(ev(s.trim!.end, 'trim.end'), 100), num(ev(s.trim!.offset, 'trim.offset'))));
      if (!parts.length) continue;
      const path = new Path2D();
      for (const o of parts) { for (let i = 0; i < o.pts.length; i += 2) { if (i) path.lineTo(o.pts[i], o.pts[i + 1]); else path.moveTo(o.pts[i], o.pts[i + 1]); } if (o.closed) path.closePath(); }
      const base = new DOMMatrix().translate(num(pos?.[0]), num(pos?.[1])).rotate(rot).scale(num(sc?.[0], 100) / 100, num(sc?.[1], 100) / 100).translate(-num(a?.[0]), -num(a?.[1]));
      const fillOn = s.fill.on, strokeOn = s.stroke.on;
      const fOp = num(ev(s.fill.opacity, 'fill.opacity'), 100) / 100, sOp = num(ev(s.stroke.opacity, 'stroke.opacity'), 100) / 100;
      const sw = strokeOn ? num(ev(s.stroke.width, 'stroke.width'), 4) : 0;
      let fill: Piece['fill'];
      if (fillOn) {
        if (s.gradient) {
          const g0 = ev(s.gradient.start, 'gradient.start') as number[], g1 = ev(s.gradient.end, 'gradient.end') as number[];
          const cols = s.gradient.colors, type = s.gradient.type;
          fill = (g: CanvasRenderingContext2D) => { const gr = type === 'radial' ? g.createRadialGradient(g0[0], g0[1], 0, g0[0], g0[1], Math.hypot(g1[0] - g0[0], g1[1] - g0[1])) : g.createLinearGradient(g0[0], g0[1], g1[0], g1[1]); cols.forEach((c, i) => gr.addColorStop(cols.length > 1 ? i / (cols.length - 1) : 0, rgbaStr(c, fOp))); return gr; };
        } else fill = rgbaStr(String(ev(s.fill.color, 'fill.color')), fOp);
      }
      const stroke = strokeOn ? (s.stroke.gradient ? gradientPaint(s.stroke.gradient, 'stroke.gradient', ev, sOp) : rgbaStr(String(ev(s.stroke.color, 'stroke.color')), sOp)) : undefined;
      const copies: { m: DOMMatrix; alpha: number }[] = [];
      // Transformación de ondulación: each repeater copy wiggles on its own
      const wig = (i: number) => (s.wiggleTransform ? wiggledMatrix(comp, l, s, t, i, a, pos, sc, rot) : base);
      if (s.repeater) {
        const r = s.repeater;
        const n = Math.max(1, Math.min(500, Math.round(num(ev(r.copies, 'repeater.copies'), 3))));
        const rp = ev(r.position, 'repeater.position') as number[], rs = ev(r.scale, 'repeater.scale') as number[], rr = num(ev(r.rotation, 'repeater.rotation'));
        const so = num(ev(r.startOpacity, 'repeater.startOpacity'), 100) / 100, eo = num(ev(r.endOpacity, 'repeater.endOpacity'), 100) / 100;
        for (let i = 0; i < n; i++) {
          const k = i + r.offset;
          const m = new DOMMatrix().translate(num(rp?.[0]) * k, num(rp?.[1]) * k).rotate(rr * k).scale(Math.pow(num(rs?.[0], 100) / 100, k), Math.pow(num(rs?.[1], 100) / 100, k)).multiply(wig(i));
          copies.push({ m, alpha: op * (n > 1 ? so + (eo - so) * (i / (n - 1)) : so) });
        }
      } else copies.push({ m: wig(0), alpha: op });
      for (const c of copies) {
        const tp = parts.map((o) => { const out: number[] = []; for (let i = 0; i < o.pts.length; i += 2) { const p = c.m.transformPoint({ x: o.pts[i], y: o.pts[i + 1] }); out.push(p.x, p.y); } return out; });
        const scaleK = Math.sqrt(Math.abs(c.m.a * c.m.d - c.m.b * c.m.c));
        for (const p of tp) { const [a0, b0, a1, b1] = outlineBounds(p); const e = (sw * scaleK) / 2 + 2; x0 = Math.min(x0, a0 - e); y0 = Math.min(y0, b0 - e); x1 = Math.max(x1, a1 + e); y1 = Math.max(y1, b1 + e); }
        pieces.push({ path, pts: tp, m: c.m, fill, stroke, sw, cap: s.stroke.cap, join: s.stroke.join, dash: s.stroke.dash, alpha: c.alpha, closed: parts.map((o) => o.closed), rule: s.fill.rule,
          fillCol: fillOn ? [s.gradient?.colors[0] ?? String(ev(s.fill.color, 'fill.color')), fOp] : undefined, strokeCol: strokeOn ? [s.stroke.gradient?.colors[0] ?? String(ev(s.stroke.color, 'stroke.color')), sOp] : undefined });
      }
    }
    return { pieces, x0, y0, x1, y1 };
  }

  // ───────────────────────── adjustment layers ─────────────────────────
  private adjust(g: CanvasRenderingContext2D, comp: Comp, l: Layer, t: number, s: number, W: number, H: number, depth: number, kp: string) {
    const tr = layerTransform(comp, l, t);
    if (tr.opacity <= 0 || !l.effects.some((f) => f.on)) return;
    // footprint of the adjustment layer (its solid + masks), in output pixels
    const F = mk(W, H);
    const fg = ctx2d(F);
    const w = l.solid?.width ?? comp.width, h = l.solid?.height ?? comp.height;
    let foot = mk(w * s, h * s);
    const ff = ctx2d(foot);
    ff.fillStyle = '#fff';
    ff.fillRect(0, 0, foot.width, foot.height);
    if (l.masks.length) foot = this.masks(comp, l, t, { cv: foot, ox: 0, oy: 0, res: s });
    const world = worldMatrix(comp, l, t);
    const full = mul(mul(scaleM(s, s), world), scaleM(1 / s, 1 / s));
    fg.setTransform(full[0], full[1], full[4], full[5], full[12], full[13]);
    fg.globalAlpha = tr.opacity;
    fg.drawImage(foot, 0, 0);
    // effects on what is below, in comp space
    let below = mk(W, H);
    ctx2d(below).drawImage(g.canvas, 0, 0);
    const x: FxCtx = { res: s, ox: 0, oy: 0, t, fps: comp.fps, seed: hashStr(l.id), layer: this.inputOf(comp, l, t, s, depth, kp), audio: this.audioOf(comp, t) };
    let cd: Depth3D | null | undefined;
    x.depth3d = () => (cd === undefined ? (cd = this.compDepth(comp, l, t, s, W, H, depth, kp)) : cd);
    for (const f of l.effects) {
      if (!f.on) continue;
      const p = Object.fromEntries(Object.entries(f.params).map(([k, v]) => [k, valueAt(v, t, { comp, layer: l, path: `effects.${f.id}.${k}` })]));
      if (f.fx === 'cornerPin') { below = this.cornerPin(below, p, x); continue; }
      below = runFx(f.fx, below, p, x);
    }
    const bg = ctx2d(below);
    bg.globalCompositeOperation = 'destination-in';
    bg.drawImage(F, 0, 0);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(F, 0, 0);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(below, 0, 0);
    g.restore();
  }
}

function box(pts: [number, number][], W: number, H: number): [number, number, number, number] | null {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1), y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1);
  const x1 = Math.min(W, Math.ceil(Math.max(...xs)) + 1), y1 = Math.min(H, Math.ceil(Math.max(...ys)) + 1);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}
/** Text layer with After Effects' per-character 3D on (drawn glyph by glyph in 3D). */
const perChar3D = (l: Layer) => l.type === 'text' && !!l.text?.perChar3D && l.threeD;
function isVisual(l: Layer) { return l.type !== 'camera' && l.type !== 'light' && l.type !== 'audio' && l.type !== 'null'; }
/** Does anything inside the layer (not its transform) change between t0 and t1? (expressions and keys) */
function contentChanges(comp: Comp, l: Layer, t0: number, t1: number, project?: Project): boolean {
  // video frames: one frame per render anyway
  if (l.type === 'video' || l.type === 'sequence' || l.type === 'image') return false;
  if (l.type === 'comp') {
    const sub = project?.comps?.find((c) => c.id === l.compId);
    return !!sub && (sub.layers.some((x) => x.type === 'video' || x.type === 'comp' || hasAnimation(x)) || !!l.overrides?.some((o) => o.prop.k?.length || o.prop.x));
  }
  // Transformación de ondulación moves with time without keys
  if (l.shapes?.some((s) => s.wiggleTransform)) return true;
  let changed = false;
  forEachProp(l, (p, path) => {
    if (changed || path.startsWith('transform.') || (!p.k?.length && !p.x)) return;
    const a = valueAt(p, t0, { comp, layer: l, path }), b = valueAt(p, t1, { comp, layer: l, path });
    if (JSON.stringify(a) !== JSON.stringify(b)) changed = true;
  });
  return changed;
}
function hasAnimation(l: Layer): boolean {
  let any = false;
  forEachProp(l, (p) => { if (p.k?.length || p.x) any = true; });
  return any;
}
function mixColor(a: string, b: string, w: number): string {
  if (w >= 0.999) return b;
  const x = parseColor(a), y = parseColor(b);
  return `rgba(${Math.round((x[0] + (y[0] - x[0]) * w) * 255)},${Math.round((x[1] + (y[1] - x[1]) * w) * 255)},${Math.round((x[2] + (y[2] - x[2]) * w) * 255)},${x[3] + (y[3] - x[3]) * w})`;
}
function applyMatte(lc: HTMLCanvasElement, mc: HTMLCanvasElement, mode: string) {
  const g = ctx2d(lc);
  if (mode === 'alpha' || mode === 'alphaInv') {
    g.globalCompositeOperation = mode === 'alpha' ? 'destination-in' : 'destination-out';
    g.drawImage(mc, 0, 0);
    g.globalCompositeOperation = 'source-over';
    return;
  }
  const mg = ctx2d(mc, true);
  const img = mg.getImageData(0, 0, mc.width, mc.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const L = ((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255) * (d[i + 3] / 255);
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = (mode === 'luma' ? L : 1 - L) * 255;
  }
  mg.putImageData(img, 0, 0);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(mc, 0, 0);
  g.globalCompositeOperation = 'source-over';
}

// helpers used by the viewer (gizmos)
export { worldMatrix, layerTransform, rotZ };
