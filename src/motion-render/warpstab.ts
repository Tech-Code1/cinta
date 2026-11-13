// Warp Stabilizer drawing: the layer's frame goes through the stabilisation of its analysis (a dense triangle mesh
// on the GPU: the homography or similarity of the frame plus the local mesh of Subspace Warp), then the framing
// (crop, auto-scale, synthesised edges), the track points and After Effects' banner across the layer while the
// footage is analysed or when it needs analysing again.
import type { FxInstance } from '../core/motion/model';
import { meshAt, stabFrame, stabilize, ap3, STAB_DEFAULTS, type StabParams } from '../core/motion/warpstab';
import { ctx2d, mk, type FxCtx, type Params } from './fx';
import { GLMesh } from './gl';

/** analysis in progress per effect id (set by the window while the main process analyses) */
export const stabStatus = new Map<string, { phase: 1 | 2; frac: number }>();
/** banners drawn (self-test) */
export const stabStats = { analysing: 0, warnings: 0 };

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
let gl: GLMesh | null = null;

export function stabParams(p: Params): StabParams {
  return {
    result: String(p.result ?? STAB_DEFAULTS.result), smoothness: num(p.smoothness, 50), method: String(p.method ?? STAB_DEFAULTS.method), preserveScale: !!num(p.preserveScale),
    framing: String(p.framing ?? STAB_DEFAULTS.framing), maxScale: num(p.maxScale, 150), actionSafe: num(p.actionSafe), additionalScale: num(p.additionalScale, 100),
    rollingShutter: String(p.rollingShutter ?? 'auto'), cropSmooth: num(p.cropSmooth, 50),
  };
}

export interface StabLayer { video: boolean; srcTime: number; W: number; H: number; key: string | null }

/** AE's banner: a band across the middle of the layer (blue while analysing, orange for a warning). */
function banner(cv: HTMLCanvasElement, x: FxCtx, L: StabLayer, text: string, warn: boolean, frac?: number) {
  const g = ctx2d(cv), cy = (L.H / 2 - x.oy) * x.res, cx = (L.W / 2 - x.ox) * x.res, bw = L.W * x.res, fs = Math.max(10, Math.round(L.H * x.res * 0.045));
  const bh = fs * 2.4;
  g.save();
  g.fillStyle = warn ? 'rgba(214,120,20,0.85)' : 'rgba(26,84,170,0.85)';
  g.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
  if (frac !== undefined) { g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(cx - bw / 2, cy + bh / 2 - fs * 0.25, bw * Math.max(0, Math.min(1, frac)), fs * 0.25); }
  g.fillStyle = '#fff';
  g.font = `600 ${fs}px "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, cx, cy, bw * 0.96);
  g.restore();
}

/** Draws the effect on the layer's content (layer space: canvas px = (layer px − origin) × res). */
export function warpStabFx(cv: HTMLCanvasElement, f: FxInstance, p: Params, x: FxCtx, L: StabLayer): HTMLCanvasElement {
  if (!L.video) return cv;
  const d = f.stab, st = stabStatus.get(f.id), hide = !!num(p.hideWarning);
  const stale = !d || (L.key !== null && d.key !== L.key);
  const i = d ? stabFrame(d, L.srcTime) : -1;
  let out = cv;
  let warning = '';
  if (d && i >= 0 && (!stale || hide || st)) {
    const r = stabilize(d, stabParams(p));
    const W = L.W, H = L.H, a = d.aspect;
    const synth = r.edges;
    // source vertices over the layer (beyond it with synthesised edges: the clamped texture stretches the border)
    const GX = 32, GY = Math.max(8, Math.round(32 * a)), ext = synth ? 0.25 : 0;
    const cl = synth ? num(p.synthCropLeft) : 0, ct = synth ? num(p.synthCropTop) : 0, cr = synth ? num(p.synthCropRight) : 0, cb = synth ? num(p.synthCropBottom) : 0;
    const nv = (GX + 1) * (GY + 1), pos = new Float32Array(nv * 2), uv = new Float32Array(nv * 2);
    let k = 0;
    for (let gy = 0; gy <= GY; gy++) for (let gx = 0; gx <= GX; gx++, k++) {
      const fu = -ext + (gx / GX) * (1 + 2 * ext), fv = -ext + (gy / GY) * (1 + 2 * ext);
      const X = fu * W, Y = fv * H;
      const u = (X - W / 2) / W, v = (Y - H / 2) / W;
      const [ou, ov] = ap3(r.fwd[i], u, v), [mu, mv] = meshAt(r, i, Math.max(-0.5, Math.min(0.5, u)), Math.max(-a / 2, Math.min(a / 2, v)), a);
      const OX = (ou + mu * r.scale) * W + W / 2, OY = (ov + mv * r.scale) * W + H / 2;
      pos[k * 2] = (OX - x.ox) * x.res; pos[k * 2 + 1] = (OY - x.oy) * x.res;
      // texture: the source pixel (clamped inside the edge cropping)
      const SX = Math.max(cl, Math.min(W - cr, X)), SY = Math.max(ct, Math.min(H - cb, Y));
      uv[k * 2] = ((SX - x.ox) * x.res) / cv.width; uv[k * 2 + 1] = ((SY - x.oy) * x.res) / cv.height;
    }
    const tris = new Uint32Array(GX * GY * 6);
    k = 0;
    for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
      const a0 = gy * (GX + 1) + gx, b0 = a0 + 1, c0 = a0 + GX + 1, d0 = c0 + 1;
      tris.set([a0, b0, c0, b0, d0, c0], k); k += 6;
    }
    try {
      gl ??= new GLMesh();
      const g = gl.draw(cv, cv.width, cv.height, pos, uv, tris);
      out = mk(cv.width, cv.height);
      const og = ctx2d(out);
      if (synth && num(p.synthFeather, 10) > 0) {
        // synthesised edges: the stretched border softened towards the inside (feather in layer px)
        og.filter = `blur(${Math.min(40, num(p.synthFeather, 10) * x.res * 0.5)}px)`;
        og.drawImage(g, 0, 0);
        og.filter = 'none';
        const inner = mk(cv.width, cv.height), ig = ctx2d(inner);
        ig.drawImage(g, 0, 0);
        // keep the sharp frame where the real footage lands
        ig.globalCompositeOperation = 'destination-in';
        ig.beginPath();
        const q = [[-0.5, -a / 2], [0.5, -a / 2], [0.5, a / 2], [-0.5, a / 2]].map(([u, v]) => ap3(r.fwd[i], u, v));
        q.forEach(([u, v], j) => { const X = (u * W + W / 2 - x.ox) * x.res, Y = (v * W + H / 2 - x.oy) * x.res; if (j) ig.lineTo(X, Y); else ig.moveTo(X, Y); });
        ig.closePath(); ig.fill();
        og.drawImage(inner, 0, 0);
      } else og.drawImage(g, 0, 0);
      if (r.crop) {
        // Stabilize, Crop: only the rectangle every frame covers is kept
        const [hw, hh] = r.crop;
        og.globalCompositeOperation = 'destination-in';
        og.fillStyle = '#000';
        og.fillRect((W / 2 - hw * W - x.ox) * x.res, (H / 2 - hh * W - x.oy) * x.res, 2 * hw * W * x.res, 2 * hh * W * x.res);
        og.globalCompositeOperation = 'source-over';
      }
    } catch (e) { console.warn('Estabilizador de deformación:', e); out = cv; }
    if (num(p.showPoints) && d.pts[i]) {
      const og = ctx2d(out), pts = d.pts[i], rad = Math.max(1.5, (W / 400) * (num(p.pointSize, 100) / 100) * x.res);
      og.save();
      og.lineWidth = Math.max(1, rad * 0.4);
      for (let j = 0; j + 1 < pts.length; j += 2) {
        const [ou, ov] = ap3(r.fwd[i], pts[j], pts[j + 1]);
        og.strokeStyle = `hsl(${(j * 37) % 360},90%,60%)`;
        og.beginPath(); og.arc((ou * W + W / 2 - x.ox) * x.res, (ov * W + H / 2 - x.oy) * x.res, rad, 0, Math.PI * 2); og.stroke();
      }
      og.restore();
    }
    if (r.overcropped) warning = 'Para evitar un recorte extremo, establezca Encuadre en Sólo estabilizar o ajuste otros parámetros.';
  }
  if (st) {
    if (out === cv) { out = mk(cv.width, cv.height); ctx2d(out).drawImage(cv, 0, 0); }
    stabStats.analysing++;
    banner(out, x, L, st.phase === 1 ? 'Análisis en segundo plano (paso 1 de 2)' : 'Estabilización (paso 2 de 2)', false, st.phase === 1 ? st.frac : undefined);
    return out;
  }
  if (!d) warning = 'Haga clic en Analizar para comenzar.';
  else if (stale && !hide) warning = 'Los nuevos fotogramas necesitan análisis; haga clic en Analizar.';
  else if (i < 0) warning = 'Fotograma no analizado para estabilización; haga clic en Analizar.';
  if (warning && !hide) {
    if (out === cv) { out = mk(cv.width, cv.height); ctx2d(out).drawImage(cv, 0, 0); }
    stabStats.warnings++;
    banner(out, x, L, warning, true);
  }
  return out;
}
