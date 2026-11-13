// 3D model layers (After Effects 2024's 3D models: .glb, .gltf, .obj): what a model file holds (meshes, animation
// clips, bounding box, the files it reads) read without three.js, the options of a model layer, and Cinta's camera
// and lights in three.js terms. Everything here is plain maths on Mat4 arrays, so it runs (and is tested) in Node;
// src/motion-render/scene3d.ts turns it into three.js objects.
import { parseColor, valueAt } from './anim';
import { apply, cameraAt, ident, invert, mul, scaleM, worldMatrix, type Mat4 } from './geom';
import type { Comp, Layer, LightOptions, Prop } from './model';

export const MODEL_EXT = ['.glb', '.gltf', '.obj'];
export const isModelPath = (p: string) => MODEL_EXT.some((x) => p.toLowerCase().endsWith(x));

/** What a model file contains (stored on the media item at import). Units and axes are the file's (y up). */
export interface ModelInfo {
  format: 'glb' | 'gltf' | 'obj';
  meshes: string[];
  clips: { name: string; duration: number }[];
  materials: string[];
  bbox: { min: number[]; max: number[] };
  vertices: number;
  triangles: number;
  /** other files it reads (buffers, textures, material libraries), relative to the model */
  files: string[];
}

/** Options of a model layer (Opciones de modelo). The material switches are the layer's `material` like other 3D layers. */
export interface ModelOptions {
  /** embedded animation played ('' = none: the rest pose) */
  clip: string;
  /** playback speed (1 = as authored, −1 backwards) */
  speed: Prop<number>;
  /** seconds into the clip at the layer's start */
  offset: Prop<number>;
  /** repeat the clip (otherwise it holds its last pose) */
  loop: boolean;
  /** comp pixels per model unit (Configuración del modelo ▸ Escala) */
  unit: number;
  /** material overrides (absent = from the file): metallic and roughness %, emissive colour and strength % */
  metalness?: Prop<number>;
  roughness?: Prop<number>;
  emissive?: Prop<string>;
  emissiveIntensity?: Prop<number>;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ───────────────────────── reading model files ─────────────────────────
interface GltfJson {
  scene?: number; scenes?: { nodes?: number[] }[];
  nodes?: { name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[];
  accessors?: { count: number; min?: number[]; max?: number[] }[];
  animations?: { name?: string; samplers: { input: number }[] }[];
  materials?: { name?: string }[];
  buffers?: { uri?: string }[];
  images?: { uri?: string }[];
}
/** The JSON of a .gltf or .glb file. */
export function gltfJson(bytes: Uint8Array): GltfJson {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 20 && dv.getUint32(0, true) === 0x46546c67) {
    const len = dv.getUint32(12, true), type = dv.getUint32(16, true);
    if (type !== 0x4e4f534a) throw new Error('GLB sin bloque JSON.');
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as GltfJson;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as GltfJson;
}
/** Node matrix (column-major) from matrix or translation / rotation (quaternion) / scale. */
function nodeMatrix(n: NonNullable<GltfJson['nodes']>[number]): Mat4 {
  if (n.matrix?.length === 16) return Float64Array.from(n.matrix);
  const [tx, ty, tz] = n.translation ?? [0, 0, 0], [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const m = ident();
  m[0] = (1 - 2 * (y * y + z * z)) * sx; m[1] = 2 * (x * y + z * w) * sx; m[2] = 2 * (x * z - y * w) * sx;
  m[4] = 2 * (x * y - z * w) * sy; m[5] = (1 - 2 * (x * x + z * z)) * sy; m[6] = 2 * (y * z + x * w) * sy;
  m[8] = 2 * (x * z + y * w) * sz; m[9] = 2 * (y * z - x * w) * sz; m[10] = (1 - 2 * (x * x + y * y)) * sz;
  m[12] = tx; m[13] = ty; m[14] = tz;
  return m;
}
export function gltfInfo(j: GltfJson, format: 'glb' | 'gltf'): ModelInfo {
  const acc = j.accessors ?? [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let vertices = 0, triangles = 0;
  const seenMesh = new Set<number>();
  const visit = (i: number, parent: Mat4, depth: number) => {
    const n = j.nodes?.[i];
    if (!n || depth > 64) return;
    const m = mul(parent, nodeMatrix(n));
    if (n.mesh !== undefined) {
      for (const pr of j.meshes?.[n.mesh]?.primitives ?? []) {
        const a = acc[pr.attributes.POSITION];
        if (!a) continue;
        if (!seenMesh.has(n.mesh)) { vertices += a.count; const ic = pr.indices !== undefined ? acc[pr.indices]?.count ?? 0 : a.count; if ((pr.mode ?? 4) === 4) triangles += Math.floor(ic / 3); }
        if (!a.min || !a.max) continue;
        for (let c = 0; c < 8; c++) {
          const p = apply(m, c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]);
          for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
        }
      }
      seenMesh.add(n.mesh);
    }
    for (const ch of n.children ?? []) visit(ch, m, depth + 1);
  };
  const roots = j.scenes?.[j.scene ?? 0]?.nodes ?? (j.nodes ?? []).map((_, i) => i);
  for (const r of roots) visit(r, ident(), 0);
  const ok = Number.isFinite(min[0]);
  const clips = (j.animations ?? []).map((a, i) => ({ name: a.name || `Animación_${i + 1}`, duration: Math.max(0, ...a.samplers.map((s) => num(acc[s.input]?.max?.[0]))) }));
  const external = (u?: string) => !!u && !/^data:/i.test(u);
  return {
    format,
    meshes: (j.meshes ?? []).map((m, i) => m.name || `Malla_${i + 1}`),
    clips,
    materials: (j.materials ?? []).map((m, i) => m.name || `Material_${i + 1}`),
    bbox: ok ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] },
    vertices, triangles,
    files: [...(j.buffers ?? []).map((b) => b.uri), ...(j.images ?? []).map((b) => b.uri)].filter(external).map((u) => decodeURIComponent(u!)),
  };
}
/** Wavefront OBJ: objects / groups, materials, size and its material libraries. */
export function objInfo(text: string): ModelInfo {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const meshes: string[] = [], materials: string[] = [], files: string[] = [];
  let vertices = 0, triangles = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const p = line.slice(2).trim().split(/\s+/).map(Number);
      vertices++;
      for (let k = 0; k < 3; k++) if (Number.isFinite(p[k])) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    } else if (line.startsWith('f ')) triangles += Math.max(0, line.slice(2).trim().split(/\s+/).length - 2);
    else if (/^[og]\s/.test(line)) { const n = line.slice(2).trim(); if (n && !meshes.includes(n)) meshes.push(n); }
    else if (line.startsWith('usemtl ')) { const n = line.slice(7).trim(); if (n && !materials.includes(n)) materials.push(n); }
    else if (line.startsWith('mtllib ')) files.push(line.slice(7).trim());
  }
  const ok = Number.isFinite(min[0]);
  return { format: 'obj', meshes: meshes.length ? meshes : ['Malla_1'], clips: [], materials, bbox: ok ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] }, vertices, triangles, files };
}
/** Texture files named by a .mtl material library. */
export function mtlTextures(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(map_\w+|bump|disp|norm|refl)\s+(.+)$/i.exec(raw);
    if (!m) continue;
    // options (-bm 1, -s 1 1 1…) come before the file name: it is the last token
    const f = m[2].trim().split(/\s+/).pop()!;
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

// ───────────────────────── model layers ─────────────────────────
/** Default scale: the model's largest side is half the comp height (Crear tamaño comp.). */
export function defaultModelUnit(info: ModelInfo | undefined, compH: number): number {
  const b = info?.bbox, d = b ? Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 0;
  if (!(d > 0)) return 100;
  const u = (compH * 0.5) / d;
  const p = Math.pow(10, Math.floor(Math.log10(u)) - 2);
  return Math.round(u / p) * p;
}
export function newModelOptions(info: ModelInfo | undefined, compH: number): ModelOptions {
  return { clip: info?.clips[0]?.name ?? '', speed: { v: 1 }, offset: { v: 0 }, loop: true, unit: defaultModelUnit(info, compH) };
}
/** Model units → layer pixels: scale by the unit and turn y up / z towards the viewer (the file) into Cinta's y down /
 *  z into the screen (a 180° turn about X, so the model is not mirrored). */
export const modelBasis = (unit: number): Mat4 => scaleM(unit, -unit, -unit);
/** Layer point (px) of a model point. */
export const modelToLayer = (unit: number, p: number[]) => [p[0] * unit, -p[1] * unit, -(p[2] ?? 0) * unit];
/** Model → comp (world) matrix of a model layer at time t. */
export function modelWorld(comp: Comp, l: Layer, t: number): Mat4 {
  return mul(worldMatrix(comp, l, t), modelBasis(l.model?.unit ?? 100));
}
/** Time inside the clip at comp time t: the layer's source time (or its time remapping) × speed + offset, looped or
 *  held at the ends. */
export function modelClipTime(comp: Comp, l: Layer, t: number, duration: number): number {
  const o = l.model;
  const src = l.timeRemap ? num(valueAt(l.timeRemap, t, { comp, layer: l, path: 'timeRemap' })) : (t - l.start) / (l.stretch || 1);
  const speed = o ? num(valueAt(o.speed, t, { comp, layer: l, path: 'model.speed' }), 1) : 1;
  const off = o ? num(valueAt(o.offset, t, { comp, layer: l, path: 'model.offset' })) : 0;
  const ct = src * speed + off;
  if (!(duration > 0)) return 0;
  if (o?.loop ?? true) return ((ct % duration) + duration) % duration;
  return Math.max(0, Math.min(duration, ct));
}

// ───────────────────────── camera ─────────────────────────
/** Same near / far as the GL compositing of 3D layers (gl.ts), so depths match and models intersect planes. */
export const NEAR = 1, FAR = 100000;
/** three.js's perspective projection (column-major), vertical fov in degrees. */
export function perspective(fovDeg: number, aspect: number, near = NEAR, far = FAR): Mat4 {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360), m = new Float64Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = -(far + near) / (far - near); m[11] = -1; m[14] = (-2 * far * near) / (far - near);
  return m;
}
/** Cinta's camera seen by three.js: camera space with y up and looking down −z (Cinta's has y down, z forward), and
 *  the zoom (px) as the vertical field of view of the comp frame. No camera layer = After Effects' default camera. */
export function threeCamera(comp: Comp, t: number) {
  const cam = cameraAt(comp, t);
  const W = comp.width, H = comp.height;
  const view = mul(scaleM(1, -1, -1), cam.view);
  const fov = (2 * Math.atan(H / 2 / Math.max(1e-6, cam.zoom)) * 180) / Math.PI;
  const matrixWorld = invert(view);
  return { view, matrixWorld, projection: perspective(fov, W / H), fov, aspect: W / H, near: NEAR, far: FAR, zoom: cam.zoom, eye: [matrixWorld[12], matrixWorld[13], matrixWorld[14]], cinta: cam };
}
/** Comp pixel of a world point through three.js's matrices (what the GPU does). */
export function threeProject(c: ReturnType<typeof threeCamera>, W: number, H: number, p: number[]): [number, number, number] {
  const v = apply(c.view, p[0], p[1], p[2]), q = apply(c.projection, v[0], v[1], v[2]);
  const x = q[0] / q[3], y = q[1] / q[3], z = q[2] / q[3];
  return [(x + 1) * W / 2, (1 - y) * H / 2, (z + 1) / 2];
}
/** Window depth (0..1) of a camera-space distance with NEAR / FAR, and back. */
export const depthOfZ = (z: number) => ((FAR + NEAR) / (FAR - NEAR) - (2 * FAR * NEAR) / ((FAR - NEAR) * z) + 1) / 2;
export const zOfDepth = (d: number) => (2 * FAR * NEAR) / ((FAR + NEAR) - (2 * d - 1) * (FAR - NEAR));

// ───────────────────────── lights ─────────────────────────
/** A comp light in three.js terms. Positions are world (comp px, y down: three's world is Cinta's world, only the
 *  camera's own axes are flipped). intensity: 100 % = π, so a white light at 100 % facing a surface shows its colour. */
export interface SceneLight {
  id: string;
  type: LightOptions['type'];
  color: string;
  intensity: number;
  pos: number[];
  target: number[];
  /** spot: half cone (rad) and penumbra (0..1, three's = Cinta's cone feather) */
  angle: number;
  penumbra: number;
  /** three's cut-off distance (0 = none) and decay exponent */
  distance: number;
  decay: number;
  castShadow: boolean;
  /** 0..1 */
  shadowDarkness: number;
  /** soft shadow radius (px of the shadow map) */
  shadowRadius: number;
  /** environment: the layer whose image lights and is reflected, and its rotation (deg about Y) */
  envLayer?: string;
  envRotation?: number;
}
export function sceneLights(comp: Comp, t: number): SceneLight[] {
  const out: SceneLight[] = [];
  for (const l of comp.layers) {
    if (l.type !== 'light' || !l.light || l.hidden || t < l.in || t >= l.out) continue;
    const o = l.light, ev = (p: Prop | undefined, k: string, d: number) => num(valueAt(p, t, { comp, layer: l, path: `light.${k}` }), d);
    const world = worldMatrix(comp, l, t), a = l.transform.anchor.v;
    const pos = apply(world, a[0] ?? 0, a[1] ?? 0, a[2] ?? 0).slice(0, 3);
    const poi = valueAt(o.poi, t, { comp, layer: l, path: 'light.poi' }) as number[];
    const k = ev(o.intensity, 'intensity', 100) / 100;
    const half = (Math.max(0.5, Math.min(180, ev(o.coneAngle, 'coneAngle', 90))) / 2) * (Math.PI / 180);
    const radius = Math.max(0, ev(o.radius, 'radius', 500)), fd = Math.max(1, ev(o.falloffDistance, 'falloffDistance', 500));
    // falloff: smooth = gone at radius + distance; inverse square = 1 up to the radius then r² / d²
    const fall = o.type === 'point' || o.type === 'spot' ? o.falloff : 'none';
    const sq = fall === 'inverseSquare';
    out.push({
      id: l.id, type: o.type, color: String(valueAt(o.color, t, { comp, layer: l, path: 'light.color' }) ?? '#ffffff'),
      intensity: k * Math.PI * (sq ? Math.max(1, radius) ** 2 : 1),
      pos, target: [num(poi?.[0], comp.width / 2), num(poi?.[1], comp.height / 2), num(poi?.[2])],
      angle: half, penumbra: Math.max(0, Math.min(100, ev(o.coneFeather, 'coneFeather', 50))) / 100,
      distance: fall === 'smooth' ? radius + fd : 0, decay: sq ? 2 : 0,
      castShadow: o.castsShadows && o.type !== 'ambient' && o.type !== 'environment',
      shadowDarkness: Math.max(0, Math.min(1, ev(o.shadowDarkness, 'shadowDarkness', 100) / 100)),
      shadowRadius: Math.max(1, ev(o.shadowDiffusion, 'shadowDiffusion', 0) / 4 + 1),
      ...(o.type === 'environment' ? { envLayer: o.envLayer, envRotation: (valueAt(l.transform.rotationY, t, { comp, layer: l, path: 'transform.rotationY' }) as number) || 0 } : {}),
    });
  }
  return out;
}
/** Lighting when the comp has no lights: a soft fill and a light from the camera (models stay readable). */
export function defaultLights(comp: Comp, t: number): SceneLight[] {
  const c = threeCamera(comp, t), poi = c.cinta.layer ? (valueAt(c.cinta.layer.camera?.poi, t, { comp, layer: c.cinta.layer, path: 'camera.poi' }) as number[]) : [comp.width / 2, comp.height / 2, 0];
  const base = { color: '#ffffff', angle: 0, penumbra: 0, distance: 0, decay: 0, castShadow: false, shadowDarkness: 1, shadowRadius: 1, target: poi.slice(0, 3) };
  return [
    { ...base, id: 'default-ambient', type: 'ambient', intensity: 0.35 * Math.PI, pos: c.eye },
    { ...base, id: 'default-key', type: 'parallel', intensity: 0.75 * Math.PI, pos: [c.eye[0] - comp.width * 0.3, c.eye[1] - comp.height * 0.4, c.eye[2]] },
  ];
}
/** Linear RGB (three.js's working space) of a Cinta colour × a factor. */
export function linearRgb(c: string, k = 1): [number, number, number] {
  const [r, g, b] = parseColor(c), lin = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return [lin(r) * k, lin(g) * k, lin(b) * k];
}

/** Model facts for comp_get. */
export function modelSummary(info: ModelInfo | undefined, l: Layer) {
  const o = l.model;
  return {
    ...(info ? { meshes: info.meshes, clips: info.clips, materials: info.materials, bbox: info.bbox, vertices: info.vertices, triangles: info.triangles, format: info.format } : { missing: true }),
    clip: o?.clip ?? '', speed: o?.speed.v ?? 1, offset: o?.offset.v ?? 0, loop: o?.loop ?? true, unit: o?.unit ?? 100,
    ...(o?.metalness ? { metalness: o.metalness.v } : {}), ...(o?.roughness ? { roughness: o.roughness.v } : {}), ...(o?.emissive ? { emissive: o.emissive.v, emissiveIntensity: o.emissiveIntensity?.v ?? 100 } : {}),
    // where the model's box lands in the layer (px), for placing things around it
    layerBox: info ? { min: modelToLayer(o?.unit ?? 100, [info.bbox.min[0], info.bbox.max[1], info.bbox.max[2]]), max: modelToLayer(o?.unit ?? 100, [info.bbox.max[0], info.bbox.min[1], info.bbox.min[2]]) } : undefined,
  };
}
