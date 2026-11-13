// «vectores» work that needs the canvas engine: a text layer's glyph outlines and the auto-trace of a layer's pixels.
// Used by the window (menus, dialog) and by the hidden render window for the MCP server (render-page.ts).
import { P, type Comp, type Layer } from '../core/motion/model';
import { autoTraceImage, TRACE_DEFAULTS, type TraceOptions, type TracedPath } from '../core/motion/autotrace';
import type { Project } from '../core/model';
import type { MotionRenderer } from './render';
import { ctx2d } from './fx';

const MAX_PIXELS = 4e6;

/** The layer alone, untransformed, drawn so its layer pixel (x, y) lands at (x + ox, y + oy) of a W×H comp. */
function isolate(comp: Comp, l: Layer): { c: Comp; ox: number; oy: number } {
  const zero = l.type === 'text' || l.type === 'shape' || l.type === 'null';
  const W = zero ? comp.width * 2 : (l.solid?.width ?? comp.width), H = zero ? comp.height * 2 : (l.solid?.height ?? comp.height);
  const ox = zero ? comp.width : 0, oy = zero ? comp.height : 0;
  const tl: Layer = JSON.parse(JSON.stringify(l));
  tl.transform = { anchor: P([0, 0, 0]), position: P([ox, oy, 0]), scale: P([100, 100, 100]), rotation: P(0), rotationX: P(0), rotationY: P(0), opacity: P(100) };
  Object.assign(tl, { parent: undefined, matte: undefined, threeD: false, motionBlur: false, hidden: false, solo: false, blend: 'normal' });
  return { c: { ...comp, width: Math.round(W), height: Math.round(H), layers: [tl], transparent: true, motionBlur: { ...comp.motionBlur, on: false } }, ox, oy };
}

/** Auto-trace of a layer at t: outlines in the layer's own pixels. */
export async function traceLayer(r: MotionRenderer, project: Project, comp: Comp, l: Layer, t: number, o0: Partial<TraceOptions> = {}): Promise<TracedPath[]> {
  const o = { ...TRACE_DEFAULTS, ...o0 };
  const { c, ox, oy } = isolate(comp, l);
  const s = Math.min(1, Math.sqrt(MAX_PIXELS / (c.width * c.height)));
  const cv = await r.render(project, c, t, { scale: s, proxies: 'none' });
  const img = ctx2d(cv).getImageData(0, 0, cv.width, cv.height);
  const paths = autoTraceImage(img.data, cv.width, cv.height, { ...o, blur: o.blur * s, tolerance: o.tolerance * s, minArea: o.minArea * s * s });
  // image pixels → layer pixels (vertices offset, tangents only scaled)
  const kx = c.width / cv.width, ky = c.height / cv.height;
  return paths.map((p) => ({ ...p, area: p.area * kx * ky, path: p.path.map((v, i) => (i % 6 === 0 ? v * kx - ox : i % 6 === 1 ? v * ky - oy : i % 2 === 0 ? v * kx : v * ky)) }));
}

/** Frame times of an auto-trace: the current frame, or every frame of the work area. */
export function traceTimes(comp: Comp, t: number, workArea: boolean): number[] {
  if (!workArea) return [t];
  const [a, b] = comp.workArea, out: number[] = [];
  for (let f = Math.round(a * comp.fps); f / comp.fps < b - 1e-6; f++) out.push(f / comp.fps);
  return out.length ? out : [t];
}

export type VectorTask =
  | { kind: 'textOutlines'; layer: string; t: number }
  | { kind: 'autoTrace'; layer: string; times: number[]; options?: Partial<TraceOptions> };

export async function runVectorTask(r: MotionRenderer, project: Project, comp: Comp, task: VectorTask): Promise<unknown> {
  const l = comp.layers.find((x) => x.id === task.layer || x.name === task.layer);
  if (!l) throw new Error(`No existe la capa «${task.layer}».`);
  if (task.kind === 'textOutlines') return r.textOutlines(project, comp, l, task.t);
  const frames: { t: number; paths: TracedPath[] }[] = [];
  for (const t of task.times) frames.push({ t, paths: await traceLayer(r, project, comp, l, t, task.options) });
  return { frames };
}
