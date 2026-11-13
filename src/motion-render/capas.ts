// «capas» in the compositor: variable mask feather (feather points along the edge), the region of interest of the
// preview and the Wiggle Transform shape operator as a matrix.
import { featherContour, featherRadii, sampleMask, wiggleTransformAt } from '../core/motion/capas';
import type { Comp, Layer, Mask, ShapeItem } from '../core/motion/model';
import { blurCanvas, ctx2d, mk } from './fx';

/** Alpha map (white, opacity `op`) of a mask with feather points, in a W×H canvas whose pixel (0, 0) is layer point
 *  (ox, oy) at `res` pixels per layer px. Nested contours of the feathered outline at alpha levels 1/K … 1, each
 *  filled with its level and kept by "lighten": the alpha of a pixel is the deepest level that contains it. */
export function variableFeatherMask(W: number, H: number, flat: number[], m: Pick<Mask, 'featherPts'>, view: { ox: number; oy: number; res: number }, op: number, expansion: number): HTMLCanvasElement {
  const out = mk(W, H);
  const g = ctx2d(out);
  const { pts, length, area } = sampleMask(flat, 24);
  if (pts.length < 3) return out;
  const radii = featherRadii(pts, length, m.featherPts ?? []);
  const maxR = Math.max(0, ...radii.map(Math.abs)) * view.res;
  const K = Math.max(1, Math.min(48, Math.ceil(maxR / 1.5)));
  g.globalCompositeOperation = 'lighten';
  for (let i = 1; i <= K; i++) {
    const a = i / K;
    const c = featherContour(pts, radii, area, a, expansion);
    g.beginPath();
    for (let j = 0; j < c.length; j += 2) { const X = (c[j] - view.ox) * view.res, Y = (c[j + 1] - view.oy) * view.res; if (j) g.lineTo(X, Y); else g.moveTo(X, Y); }
    g.closePath();
    const v = Math.round(255 * a * op);
    g.fillStyle = `rgba(${v},${v},${v},1)`;
    g.fill('nonzero');
  }
  // grey levels → alpha (white with that opacity), softened by one level's width to hide the steps
  const d = g.getImageData(0, 0, W, H);
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) { px[i + 3] = px[i]; px[i] = px[i + 1] = px[i + 2] = 255; }
  g.globalCompositeOperation = 'source-over';
  g.putImageData(d, 0, 0);
  return K > 1 ? blurCanvas(out, Math.max(0.5, maxR / K / 2)) : out;
}

/** Leaves only the region of interest of a rendered frame (comp px rect, output scale s). */
export function clipToRoi(g: CanvasRenderingContext2D, W: number, H: number, rect: number[], s: number) {
  const x = Math.round(rect[0] * s), y = Math.round(rect[1] * s), x1 = Math.round((rect[0] + rect[2]) * s), y1 = Math.round((rect[1] + rect[3]) * s);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, y); g.clearRect(0, y1, W, H - y1); g.clearRect(0, y, x, y1 - y); g.clearRect(x1, y, W - x1, y1 - y);
  g.restore();
}

/** The group's transform with this copy's wiggle added (anchor, position, scale %, rotation). */
export function wiggledMatrix(comp: Comp, l: Layer, s: ShapeItem, t: number, copy: number, a: number[], pos: number[], sc: number[], rot: number): DOMMatrix {
  const w = wiggleTransformAt(comp, l, s, t, copy);
  const n = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return new DOMMatrix().translate(n(pos?.[0]) + w.position[0], n(pos?.[1]) + w.position[1]).rotate(rot + w.rotation)
    .scale((n(sc?.[0], 100) + w.scale[0]) / 100, (n(sc?.[1], 100) + w.scale[1]) / 100).translate(-(n(a?.[0]) + w.anchor[0]), -(n(a?.[1]) + w.anchor[1]));
}
