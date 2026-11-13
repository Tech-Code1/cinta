// 3D views of the Composition panel (After Effects: View ▸ Switch 3D View): the active camera, six orthographic
// views (front, left, top, back, right, bottom) and three custom perspective views, each with its own orbit / pan /
// dolly state. A view is rendered by the normal engine through a synthetic camera: orthographic views use a camera
// very far away with a matching zoom (no perspective left), so every renderer feature works unchanged in them.
// Also the wireframes of cameras and lights drawn in the views other than the active camera, and the camera tools'
// moves of a camera layer.
import { valueAt } from './anim';
import { apply, cameraAt, project, worldMatrix, type Mat4 } from './geom';
import { defaultZoom, newLayer, P, type Comp, type Layer } from './model';

export type View3D = 'active' | 'front' | 'left' | 'top' | 'back' | 'right' | 'bottom' | 'custom1' | 'custom2' | 'custom3';
/** menu names (View ▸ Switch 3D View) and the label shown in the view (After Effects 2024, Spanish) */
export const VIEWS_3D: { id: View3D; name: string; label: string }[] = [
  { id: 'active', name: 'Cámara activa (por defecto)', label: 'Cámara activa' },
  { id: 'front', name: 'Parte frontal', label: 'Frente' },
  { id: 'left', name: 'Izquierda', label: 'Izquierda' },
  { id: 'top', name: 'Parte superior', label: 'Superior' },
  { id: 'back', name: 'Parte trasera', label: 'Atrás' },
  { id: 'right', name: 'Derecha', label: 'Derecha' },
  { id: 'bottom', name: 'Parte inferior', label: 'Inferior' },
  { id: 'custom1', name: 'Personalizar vista 1', label: 'Vista personalizada 1' },
  { id: 'custom2', name: 'Personalizar vista 2', label: 'Vista personalizada 2' },
  { id: 'custom3', name: 'Personalizar vista 3', label: 'Vista personalizada 3' },
];
/** Select View Layout (the Composition panel's button bar) */
export const VIEW_LAYOUTS: { n: 1 | 2 | 4; name: string }[] = [{ n: 1, name: '1 Vista' }, { n: 2, name: '2 Vistas' }, { n: 4, name: '4 Vistas' }];
/** views of each pane when a layout is chosen (After Effects: 2 views = Left + Active Camera; 4 = Top, Front, Right
 *  and the Active Camera) */
export const LAYOUT_VIEWS: Record<1 | 2 | 4, View3D[]> = { 1: ['active'], 2: ['left', 'active'], 4: ['top', 'front', 'right', 'active'] };

export const isOrtho = (v: View3D) => v !== 'active' && !v.startsWith('custom');
/** orbit / pan / dolly state of a view: what it looks at, from where, and how big */
export interface ViewState { target: [number, number, number]; yaw: number; pitch: number; dist: number; scale: number }
/** forward direction of the orthographic views and the roll that puts After Effects' "up" at the top */
const ORTHO: Record<string, { fwd: [number, number, number]; roll: number }> = {
  front: { fwd: [0, 0, 1], roll: 0 }, back: { fwd: [0, 0, -1], roll: 0 }, left: { fwd: [1, 0, 0], roll: 0 }, right: { fwd: [-1, 0, 0], roll: 0 },
  top: { fwd: [0, 1, 0], roll: 180 }, bottom: { fwd: [0, -1, 0], roll: 0 },
};
const CUSTOM: Record<string, [number, number]> = { custom1: [-45, 30], custom2: [0, 30], custom3: [45, 30] };
/** distance of the camera of an orthographic view (inside the GL far plane of 100000): perspective left is depth / 90000 */
export const ORTHO_DIST = 90000;

/** Points that should fit in a view: the comp frame at z = 0, 3D layers' anchors, cameras and lights. */
function scenePoints(comp: Comp, t: number): number[][] {
  const W = comp.width, H = comp.height;
  const pts: number[][] = [[0, 0, 0], [W, 0, 0], [0, H, 0], [W, H, 0]];
  for (const l of comp.layers) {
    if (!l.threeD || l.hidden) continue;
    const m = worldMatrix(comp, l, t), a = l.transform.anchor.v as number[];
    pts.push(apply(m, a[0] ?? 0, a[1] ?? 0, a[2] ?? 0).slice(0, 3));
    if (l.type === 'camera') pts.push(vec3(valueAt(l.camera?.poi, t, { comp, layer: l, path: 'camera.poi' }), [W / 2, H / 2, 0]));
  }
  return pts;
}
const vec3 = (v: unknown, d: number[]): number[] => (Array.isArray(v) ? [Number(v[0] ?? d[0]), Number(v[1] ?? d[1]), Number(v[2] ?? d[2] ?? 0)] : d);

/** The view's starting state: orthographic views framed to show the whole scene, custom views at 2× the 50 mm
 *  distance from upper left / front / upper right. */
export function defaultViewState(comp: Comp, view: View3D, t = 0): ViewState {
  const W = comp.width, H = comp.height, target: [number, number, number] = [W / 2, H / 2, 0];
  if (view.startsWith('custom')) { const [yaw, pitch] = CUSTOM[view]; return { target, yaw, pitch, dist: defaultZoom(W) * 2, scale: 1 }; }
  if (!isOrtho(view)) return { target, yaw: 0, pitch: 0, dist: defaultZoom(W), scale: 1 };
  // fit: the largest extent of the scene across the view, around the comp centre
  const st: ViewState = { target, yaw: 0, pitch: 0, dist: ORTHO_DIST, scale: 1 };
  const cam = viewCamera(comp, view, st);
  const fake = synthComp(comp, cam);
  const { view: m } = cameraAt(fake, t);
  let ex = 1, ey = 1;
  for (const p of scenePoints(comp, t)) {
    const c = apply(m, p[0] - target[0], p[1] - target[1], p[2] - target[2]);
    const o = apply(m, 0, 0, 0);
    ex = Math.max(ex, Math.abs(c[0] - o[0])); ey = Math.max(ey, Math.abs(c[1] - o[1]));
  }
  st.scale = Math.max(0.02, Math.min(1, Math.min((W * 0.45) / ex, (H * 0.45) / ey)));
  return st;
}

export interface ViewCamera { eye: number[]; poi: number[]; zoom: number; roll: number }
/** Where the synthetic camera of a view stands. */
export function viewCamera(comp: Comp, view: View3D, s: ViewState): ViewCamera {
  const tg = s.target;
  if (isOrtho(view)) {
    const o = ORTHO[view], D = ORTHO_DIST;
    return { eye: [tg[0] - o.fwd[0] * D, tg[1] - o.fwd[1] * D, tg[2] - o.fwd[2] * D], poi: [...tg], zoom: D * s.scale, roll: o.roll };
  }
  const y = (s.yaw * Math.PI) / 180, p = (Math.max(-89, Math.min(89, s.pitch)) * Math.PI) / 180;
  return { eye: [tg[0] + s.dist * Math.sin(y) * Math.cos(p), tg[1] - s.dist * Math.sin(p), tg[2] - s.dist * Math.cos(y) * Math.cos(p)], poi: [...tg], zoom: defaultZoom(comp.width), roll: 0 };
}

const SYNTH = '__vista3d';
/** The comp seen through a camera: its cameras switched off and a synthetic one on top. */
function synthComp(comp: Comp, cam: ViewCamera): Comp {
  const l = newLayer('camera', comp, { id: SYNTH, name: 'Vista 3D' });
  l.in = -1e9; l.out = 1e9;
  l.transform.position = P(cam.eye);
  l.transform.rotation = P(cam.roll);
  l.camera = { zoom: P(cam.zoom), poi: P(cam.poi) };
  return { ...comp, layers: [l, ...comp.layers.map((x) => (x.type === 'camera' ? { ...x, hidden: true } : x))] };
}
/** The comp to render for a 3D view (the comp itself for the active camera). */
export function viewComp(comp: Comp, view: View3D, s?: ViewState, t = 0): Comp {
  if (view === 'active') return comp;
  return synthComp(comp, viewCamera(comp, view, s ?? defaultViewState(comp, view, t)));
}
/** View matrix and zoom a view projects with (the active camera's, or the view's own). */
export function viewProjection(comp: Comp, view: View3D, s: ViewState | undefined, t: number): { view: Mat4; zoom: number } {
  const c = cameraAt(view === 'active' ? comp : viewComp(comp, view, s, t), t);
  return { view: c.view, zoom: c.zoom };
}

// ───────────────────────── orbit / pan / dolly of a view ─────────────────────────
/** The camera tools in a view other than the active camera: orbit (custom views only, like After Effects), pan
 *  (the scene follows the pointer) and dolly (closer / farther; orthographic views magnify). dx, dy: screen px. */
export function moveView(comp: Comp, view: View3D, s: ViewState, tool: 'orbit' | 'pan' | 'dolly', dx: number, dy: number, t = 0): ViewState {
  const n: ViewState = { ...s, target: [...s.target] };
  if (tool === 'orbit') {
    if (isOrtho(view)) return n;
    n.yaw = s.yaw + dx * 0.4;
    n.pitch = Math.max(-89, Math.min(89, s.pitch + dy * 0.4));
    return n;
  }
  if (tool === 'dolly') {
    const f = Math.exp((dx - dy) * 0.005);
    if (isOrtho(view)) n.scale = Math.max(0.005, Math.min(20, s.scale * f));
    else n.dist = Math.max(20, s.dist / f);
    return n;
  }
  // pan: screen axes of the view in world space; px → world units at the target
  const { view: m, zoom } = viewProjection(comp, view, s, t);
  const right = [m[0], m[4], m[8]], down = [m[1], m[5], m[9]];
  const k = isOrtho(view) ? 1 / s.scale : s.dist / zoom;
  for (let i = 0; i < 3; i++) n.target[i] = s.target[i] - (dx * right[i] + dy * down[i]) * k;
  return n;
}

/** The camera tools on a camera layer (the active camera view): new position and point of interest.
 *  orbit turns the camera around its point of interest, pan moves both, dolly moves the camera along its line of sight. */
export function moveCamera(pos: number[], poi: number[], m: Mat4, zoom: number, tool: 'orbit' | 'pan' | 'dolly', dx: number, dy: number): { pos: number[]; poi: number[] } {
  const right = [m[0], m[4], m[8]], down = [m[1], m[5], m[9]];
  const d = [pos[0] - poi[0], pos[1] - poi[1], pos[2] - poi[2]];
  const dist = Math.hypot(d[0], d[1], d[2]) || 1;
  if (tool === 'pan') {
    const k = dist / (zoom || 1);
    const off = [0, 1, 2].map((i) => -(dx * right[i] + dy * down[i]) * k);
    return { pos: pos.map((v, i) => v + off[i]), poi: poi.map((v, i) => v + off[i]) };
  }
  if (tool === 'dolly') {
    const nd = Math.max(10, dist - (dx - dy) * dist * 0.005);
    return { pos: [0, 1, 2].map((i) => poi[i] + (d[i] / dist) * nd), poi: [...poi] };
  }
  // orbit: yaw around the world Y axis, pitch around the camera's right axis
  const rot = (v: number[], ax: number[], a: number) => {
    const c = Math.cos(a), s = Math.sin(a), dot = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
    const cr = [ax[1] * v[2] - ax[2] * v[1], ax[2] * v[0] - ax[0] * v[2], ax[0] * v[1] - ax[1] * v[0]];
    return [0, 1, 2].map((i) => v[i] * c + cr[i] * s + ax[i] * dot * (1 - c));
  };
  let v = rot(d, [0, 1, 0], (-dx * 0.4 * Math.PI) / 180);
  const r = rot(right, [0, 1, 0], (-dx * 0.4 * Math.PI) / 180);
  const rl = Math.hypot(r[0], r[1], r[2]) || 1;
  const v2 = rot(v, r.map((x) => x / rl), (dy * 0.4 * Math.PI) / 180);
  // never over the pole (the camera would flip)
  if (Math.abs(v2[1]) / dist < 0.995) v = v2;
  return { pos: [0, 1, 2].map((i) => poi[i] + v[i]), poi: [...poi] };
}

// ───────────────────────── wireframes ─────────────────────────
export interface Wire { lines: { a: [number, number]; b: [number, number]; color: string; layer?: string }[]; labels: { at: [number, number]; text: string; color: string }[] }
/** Wireframes of the cameras and lights (and the comp frame at z = 0) as seen from a view, in comp pixels. */
export function wireframes(comp: Comp, view: View3D, s: ViewState | undefined, t: number): Wire {
  const out: Wire = { lines: [], labels: [] };
  const W = comp.width, H = comp.height;
  const { view: m, zoom } = viewProjection(comp, view, s, t);
  const pr = (p: number[]): [number, number] | null => { const q = apply(m, p[0], p[1], p[2]); if (q[2] < 1) return null; const r = project(W, H, zoom, q); return [r[0], r[1]]; };
  const seg = (a: number[], b: number[], color: string, layer?: string) => { const A = pr(a), B = pr(b); if (A && B) out.lines.push({ a: A, b: B, color, layer }); };
  // the comp frame
  const fr = [[0, 0, 0], [W, 0, 0], [W, H, 0], [0, H, 0]];
  fr.forEach((p, i) => seg(p, fr[(i + 1) % 4], 'rgba(200,205,220,0.55)'));
  for (const l of comp.layers) {
    if ((l.type !== 'camera' && l.type !== 'light') || t < l.in || t >= l.out) continue;
    const wm = worldMatrix(comp, l, t), a = l.transform.anchor.v as number[];
    const pos = apply(wm, a[0] ?? 0, a[1] ?? 0, a[2] ?? 0).slice(0, 3);
    const color = l.hidden ? 'rgba(160,160,170,0.6)' : l.label || (l.type === 'camera' ? '#ff5fa2' : '#ffe08a');
    const lp = pr(pos);
    if (lp) out.labels.push({ at: [lp[0] + 8, lp[1] - 8], text: l.name, color });
    if (l.type === 'camera') camWire(comp, l, t, pos, (x, y) => seg(x, y, color, l.id));
    else lightWire(comp, l, t, pos, (x, y) => seg(x, y, color, l.id));
  }
  return out;
}
function camWire(comp: Comp, l: Layer, t: number, pos: number[], seg: (a: number[], b: number[]) => void) {
  const W = comp.width, H = comp.height;
  const poi = vec3(valueAt(l.camera?.poi, t, { comp, layer: l, path: 'camera.poi' }), [W / 2, H / 2, 0]);
  const zoom = Number(valueAt(l.camera?.zoom, t, { comp, layer: l, path: 'camera.zoom' })) || defaultZoom(W);
  // the camera's own axes (as the renderer builds its view)
  const solo: Comp = { ...comp, layers: [{ ...l, hidden: false, in: -1e9, out: 1e9 }] };
  const m = cameraAt(solo, t).view;
  const right = [m[0], m[4], m[8]], down = [m[1], m[5], m[9]], fwd = [m[2], m[6], m[10]];
  const at = (r: number, d: number, f: number) => [0, 1, 2].map((i) => pos[i] + right[i] * r + down[i] * d + fwd[i] * f);
  // body: a box behind the lens
  const s = Math.max(20, W * 0.02);
  const box = [[-1, -1, -2], [1, -1, -2], [1, 1, -2], [-1, 1, -2], [-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]].map(([r, d, f]) => at(r * s, d * s * 0.7, f * s));
  for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) seg(box[i], box[j]);
  // field of view: to the frame the camera sees at its zoom distance
  const fr = [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]].map(([r, d]) => at(r, d, zoom));
  fr.forEach((p, i) => { seg(pos, p); seg(p, fr[(i + 1) % 4]); });
  seg(pos, poi);
}
function lightWire(comp: Comp, l: Layer, t: number, pos: number[], seg: (a: number[], b: number[]) => void) {
  const W = comp.width, s = Math.max(15, W * 0.015);
  // a star of three axes at the light
  for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.7, 0.7, 0], [0.7, -0.7, 0]]) seg([pos[0] - d[0] * s, pos[1] - d[1] * s, pos[2] - d[2] * s], [pos[0] + d[0] * s, pos[1] + d[1] * s, pos[2] + d[2] * s]);
  const type = l.light?.type;
  if (type !== 'spot' && type !== 'parallel') return;
  const poi = vec3(valueAt(l.light?.poi, t, { comp, layer: l, path: 'light.poi' }), [comp.width / 2, comp.height / 2, 0]);
  seg(pos, poi);
  if (type !== 'spot') return;
  // the cone: four rays at the cone angle, a quarter of the way to the point of interest
  const d = [poi[0] - pos[0], poi[1] - pos[1], poi[2] - pos[2]], len = Math.hypot(d[0], d[1], d[2]) || 1, f = d.map((x) => x / len);
  const up = Math.abs(f[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const r = [up[1] * f[2] - up[2] * f[1], up[2] * f[0] - up[0] * f[2], up[0] * f[1] - up[1] * f[0]], rl = Math.hypot(r[0], r[1], r[2]) || 1;
  const rx = r.map((x) => x / rl), ry = [f[1] * rx[2] - f[2] * rx[1], f[2] * rx[0] - f[0] * rx[2], f[0] * rx[1] - f[1] * rx[0]];
  const ang = ((Number(valueAt(l.light?.coneAngle, t, { comp, layer: l, path: 'light.coneAngle' })) || 90) / 2) * (Math.PI / 180);
  const L = len * 0.5, rad = Math.tan(Math.min(ang, 1.4)) * L;
  const ring = [0, 1, 2, 3].map((i) => { const a = (i * Math.PI) / 2; return [0, 1, 2].map((k) => pos[k] + f[k] * L + (rx[k] * Math.cos(a) + ry[k] * Math.sin(a)) * rad); });
  ring.forEach((p, i) => { seg(pos, p); seg(p, ring[(i + 1) % 4]); });
}

/** Has the comp anything in 3D (views other than the active camera only make sense then)? */
export const has3D = (comp: Comp) => comp.layers.some((l) => l.threeD);
