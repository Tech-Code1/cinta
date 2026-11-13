// The 3D scene of a composition drawn with three.js (After Effects' «Advanced 3D»): 3D model layers today, and any
// other mesh later (extruded text and shapes) through the same MeshProvider API. The comp camera and lights come
// from core/motion/model3d.ts (exact conversions of Cinta's own); each provider is rendered to its own RGBA image in
// comp space plus a depth image with the same depth equation as the GL compositing of 3D layers (gl.ts), so the
// compositor can place it among the other layers and intersect it per pixel with 3D planes.
//
//   const s = scene3d();
//   await s.prepare([provider…], [envSource…]);           // loads files (once)
//   const out = s.render(frame, [provider…]);              // Map id → { color, depth }
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { valueAt } from '../core/motion/anim';
import { defaultLights, modelClipTime, modelWorld, sceneLights, threeCamera, type SceneLight } from '../core/motion/model3d';
import type { Comp, Layer, Prop } from '../core/motion/model';
import type { Project } from '../core/model';
import { mediaUrl } from './sources';

// ───────────────────────── API ─────────────────────────
/** Something drawn in the 3D scene. Its object is built once per (id, version) and posed every frame. */
export interface MeshProvider {
  /** stable id (layer key): the object is kept between frames */
  id: string;
  /** the object is rebuilt when this changes (file, geometry parameters…) */
  version: string;
  /** builds the object in its own units */
  build(): Promise<THREE.Object3D> | THREE.Object3D;
  /** poses it for this frame (animation, material overrides…); called before every render */
  update?(obj: THREE.Object3D): void;
  /** object → world (comp px, y down, z into the screen), column-major */
  matrix: ArrayLike<number>;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** casts shadows but is not seen (After Effects' Casts Shadows: Only) */
  shadowOnly?: boolean;
}
/** An image lighting the scene and reflected by it (Luz de entorno): equirectangular .hdr / .exr / 8-bit image. */
export interface EnvSource { key: string; path: string }
/** One frame of the scene: output size (px), the comp camera and lights (model3d.ts) and the environment. */
export interface Scene3DFrame {
  W: number;
  H: number;
  camera: ReturnType<typeof threeCamera>;
  lights: SceneLight[];
  env?: { key: string; intensity: number; rotation: number } | null;
}
/** A provider rendered alone (lit and shadowed by the whole scene): premultiplied colour, and depth as 24-bit window
 *  depth in RGB (bottom row first, 1 = empty), the same depth as gl.ts's 3D layers. */
export interface Rendered { color: HTMLCanvasElement; depth: Uint8Array; W: number; H: number }

// ───────────────────────── shaders of the read-back passes ─────────────────────────
const VS = `in vec3 position; out vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
// linear premultiplied (the render target) → sRGB premultiplied (the canvas)
const COPY_FS = `precision highp float; in vec2 vUv; uniform sampler2D tColor; out vec4 outColor;
vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
void main() { vec4 c = texture(tColor, vUv); float a = clamp(c.a, 0.0, 1.0); vec3 rgb = a > 0.0 ? max(c.rgb, 0.0) / a : vec3(0.0); outColor = vec4(clamp(srgb(rgb), 0.0, 1.0) * a, a); }`;
// window depth → 24 bits in RGB (1.0 × 16777215 + 0.5 rounds up to 2^24 in float: clamped, so empty stays 1)
const DEPTH_FS = `precision highp float; in vec2 vUv; uniform sampler2D tDepth; out vec4 outColor;
void main() { float v = min(floor(clamp(texture(tDepth, vUv).r, 0.0, 1.0) * 16777215.0 + 0.5), 16777215.0); float r = floor(v / 65536.0); v -= r * 65536.0; float g = floor(v / 256.0); float b = v - g * 256.0; outColor = vec4(r, g, b, 255.0) / 255.0; }`;

interface Inst { version: string; root: THREE.Group; obj: THREE.Object3D }

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera();
  private insts = new Map<string, Inst>();
  private building = new Map<string, Promise<void>>();
  private lights = new Map<string, THREE.Light>();
  private envs = new Map<string, Promise<THREE.Texture | null>>();
  private envReady = new Map<string, THREE.Texture | null>();
  private pmrem: THREE.PMREMGenerator;
  private rt: THREE.WebGLRenderTarget | null = null;
  private drt: THREE.WebGLRenderTarget | null = null;
  private post = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private copyMat: THREE.RawShaderMaterial;
  private depthMat: THREE.RawShaderMaterial;
  private quad: THREE.Mesh;
  /** errors of the last prepare (file: message) */
  errors: string[] = [];

  constructor() {
    const canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.cam.matrixAutoUpdate = false;
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.copyMat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: COPY_FS, uniforms: { tColor: { value: null } }, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
    this.depthMat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: DEPTH_FS, uniforms: { tDepth: { value: null } }, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
    this.quad = new THREE.Mesh(tri, this.copyMat);
    this.quad.frustumCulled = false;
    this.post.add(this.quad);
  }

  /** Builds the objects of new providers and loads environment images (both once). */
  async prepare(providers: MeshProvider[], envs: EnvSource[] = []): Promise<void> {
    this.errors = [];
    await Promise.all([
      ...providers.map((p) => {
        const have = this.insts.get(p.id);
        if (have?.version === p.version) return Promise.resolve();
        const key = `${p.id}|${p.version}`;
        let job = this.building.get(key);
        if (!job) {
          job = (async () => {
            try {
              const obj = await p.build();
              const old = this.insts.get(p.id);
              if (old) { this.scene.remove(old.root); dispose(old.root); }
              const root = new THREE.Group();
              root.matrixAutoUpdate = false;
              root.add(obj);
              this.scene.add(root);
              this.insts.set(p.id, { version: p.version, root, obj });
            } catch (e) { this.errors.push(`${p.id}: ${(e as Error)?.message ?? e}`); }
            finally { this.building.delete(key); }
          })();
          this.building.set(key, job);
        }
        return job;
      }),
      ...envs.map(async (e) => {
        if (!this.envs.has(e.key)) this.envs.set(e.key, this.loadEnv(e.path).catch((err) => { this.errors.push(`${e.path}: ${err?.message ?? err}`); return null; }));
        this.envReady.set(e.key, await this.envs.get(e.key)!);
      }),
    ]);
  }
  /** Is the provider's object ready (prepare done without errors)? */
  has(id: string) { return this.insts.has(id); }

  /** Renders every provider alone (the others still cast their shadows on it) at this frame. */
  render(frame: Scene3DFrame, providers: MeshProvider[]): Map<string, Rendered> {
    const { W, H } = frame, r = this.renderer;
    this.size(W, H);
    // camera: Cinta's view and zoom, as matrices (model3d.ts threeCamera)
    const c = frame.camera;
    this.cam.matrix.fromArray(Array.from(c.matrixWorld));
    this.cam.matrixWorldNeedsUpdate = true;
    this.cam.updateMatrixWorld(true);
    this.cam.projectionMatrix.fromArray(Array.from(c.projection));
    this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();
    this.cam.near = c.near; this.cam.far = c.far;
    // objects of this frame: placed and posed; others hidden
    const live = new Set<string>();
    for (const p of providers) {
      const it = this.insts.get(p.id);
      if (!it) continue;
      live.add(p.id);
      it.root.matrix.fromArray(Array.from(p.matrix));
      it.root.matrixWorldNeedsUpdate = true;
      p.update?.(it.obj);
      it.root.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        o.castShadow = !!p.castShadow; o.receiveShadow = p.receiveShadow ?? true;
        for (const m of mats(o as THREE.Mesh)) { m.colorWrite = !p.shadowOnly; m.depthWrite = !p.shadowOnly; }
      });
    }
    for (const [id, it] of this.insts) it.root.visible = live.has(id);
    const shadows = this.setLights(frame, providers);
    this.scene.updateMatrixWorld(true);
    const out = new Map<string, Rendered>();
    const ids = providers.map((p) => p.id).filter((id) => live.has(id));
    // shadow maps once with every object, then each object alone
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = shadows;
    if (shadows && ids.length > 1) { r.setRenderTarget(this.rt); r.clear(); r.render(this.scene, this.cam); r.shadowMap.needsUpdate = false; }
    for (const id of ids) {
      for (const i of ids) this.insts.get(i)!.root.visible = i === id;
      r.setRenderTarget(this.rt);
      r.clear();
      r.render(this.scene, this.cam);
      r.shadowMap.needsUpdate = false;
      out.set(id, this.readBack(W, H));
    }
    for (const i of ids) this.insts.get(i)!.root.visible = true;
    return out;
  }

  private size(W: number, H: number) {
    if (this.rt && this.rt.width === W && this.rt.height === H) return;
    this.rt?.dispose(); this.drt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(W, H, { samples: 4, type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
    this.drt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: false });
    this.renderer.setSize(W, H, false);
  }
  /** The render target as a premultiplied sRGB canvas and packed depth. */
  private readBack(W: number, H: number): Rendered {
    const r = this.renderer;
    this.quad.material = this.depthMat;
    this.depthMat.uniforms.tDepth.value = this.rt!.depthTexture;
    r.setRenderTarget(this.drt);
    r.render(this.post, this.postCam);
    const depth = new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(this.drt!, 0, 0, W, H, depth);
    this.quad.material = this.copyMat;
    this.copyMat.uniforms.tColor.value = this.rt!.texture;
    r.setRenderTarget(null);
    r.setViewport(0, 0, W, H);
    r.render(this.post, this.postCam);
    const color = document.createElement('canvas');
    color.width = W; color.height = H;
    color.getContext('2d')!.drawImage(r.domElement, 0, 0);
    return { color, depth, W, H };
  }

  // ───────────────────────── lights ─────────────────────────
  /** The comp lights as three.js lights (pooled by id); returns whether any casts shadows. */
  private setLights(frame: Scene3DFrame, providers: MeshProvider[]): boolean {
    const seen = new Set<string>();
    let shadows = false;
    // the scene's extent, for the shadow cameras of parallel lights
    const box = new THREE.Box3();
    for (const p of providers) { const it = this.insts.get(p.id); if (it) { it.root.updateMatrixWorld(true); box.expandByObject(it.root); } }
    const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1000) : box.getBoundingSphere(new THREE.Sphere());
    const R = Math.max(1, sphere.radius);
    for (const L of frame.lights) {
      if (L.type === 'environment') continue;
      const kind = L.type === 'ambient' ? 'A' : L.type === 'parallel' ? 'D' : L.type === 'point' ? 'P' : 'S';
      const key = `${L.id}|${kind}`;
      seen.add(key);
      let l = this.lights.get(key);
      if (!l) {
        l = kind === 'A' ? new THREE.AmbientLight() : kind === 'D' ? new THREE.DirectionalLight() : kind === 'P' ? new THREE.PointLight() : new THREE.SpotLight();
        if ((l as THREE.DirectionalLight).target) this.scene.add((l as THREE.DirectionalLight).target);
        this.scene.add(l);
        this.lights.set(key, l);
      }
      l.visible = true;
      l.color.set(L.color);
      l.intensity = L.intensity;
      const tgt = new THREE.Vector3(L.target[0], L.target[1], L.target[2]), pos = new THREE.Vector3(L.pos[0], L.pos[1], L.pos[2]);
      if (kind === 'D') {
        // only the direction matters: the light sits outside the scene along it (its shadow camera covers the scene)
        const dir = tgt.clone().sub(pos).normalize();
        if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
        const d = l as THREE.DirectionalLight;
        d.target.position.copy(sphere.center);
        d.position.copy(sphere.center).addScaledVector(dir, -2 * R);
        const sc = d.shadow.camera;
        sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = Math.max(0.1, R * 0.5); sc.far = R * 4;
        sc.updateProjectionMatrix();
      } else if (kind !== 'A') {
        l.position.copy(pos);
        const pl = l as THREE.PointLight | THREE.SpotLight;
        pl.distance = L.distance; pl.decay = L.decay;
        if (kind === 'S') { const s = l as THREE.SpotLight; s.target.position.copy(tgt); s.angle = L.angle; s.penumbra = L.penumbra; }
        const far = pos.distanceTo(sphere.center) + R * 2;
        const sc = (l as THREE.SpotLight).shadow.camera as THREE.PerspectiveCamera;
        sc.near = Math.max(1, (pos.distanceTo(sphere.center) - R) * 0.5); sc.far = Math.max(sc.near + 1, far);
        sc.updateProjectionMatrix();
      }
      if (kind !== 'A') {
        const sl = l as THREE.DirectionalLight;
        sl.castShadow = L.castShadow;
        if (L.castShadow) {
          shadows = true;
          sl.shadow.mapSize.set(2048, 2048);
          sl.shadow.intensity = L.shadowDarkness;
          sl.shadow.radius = L.shadowRadius;
          sl.shadow.bias = -0.0005;
          sl.shadow.normalBias = R * 0.004;
          if (sl.shadow.map) sl.shadow.needsUpdate = true;
        }
      }
      l.updateMatrixWorld(true);
      (l as THREE.DirectionalLight).target?.updateMatrixWorld(true);
    }
    for (const [k, l] of this.lights) if (!seen.has(k)) l.visible = false;
    // environment (Luz de entorno): reflections and image-based lighting
    const env = frame.env ? this.envReady.get(frame.env.key) ?? null : null;
    this.scene.environment = env;
    this.scene.environmentIntensity = frame.env?.intensity ?? 1;
    this.scene.environmentRotation.set(0, ((frame.env?.rotation ?? 0) * Math.PI) / 180, 0);
    return shadows;
  }

  private async loadEnv(path: string): Promise<THREE.Texture | null> {
    const url = mediaUrl(path), ext = path.toLowerCase().split('.').pop();
    const tex: THREE.Texture = ext === 'hdr' ? await new HDRLoader().loadAsync(url) : ext === 'exr' ? await new EXRLoader().loadAsync(url) : await new THREE.TextureLoader().loadAsync(url);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    if (ext !== 'hdr' && ext !== 'exr') tex.colorSpace = THREE.SRGBColorSpace;
    const rt = this.pmrem.fromEquirectangular(tex);
    tex.dispose();
    return rt.texture;
  }

  // ───────────────────────── thumbnails ─────────────────────────
  /** A small picture of a model (Project panel): framed, lit from the front, transparent background. */
  async thumbnail(path: string, size = 96): Promise<string> {
    const m = await loadModel(path);
    const obj = cloneSkinned(m.scene);
    const sc = new THREE.Scene();
    sc.add(obj, new THREE.AmbientLight(0xffffff, 0.4 * Math.PI));
    const key = new THREE.DirectionalLight(0xffffff, 0.8 * Math.PI);
    key.position.set(-1, 1.5, 2);
    sc.add(key);
    const box = new THREE.Box3().setFromObject(obj), s = box.getBoundingSphere(new THREE.Sphere());
    const cam = new THREE.PerspectiveCamera(30, 1, Math.max(1e-4, s.radius * 0.01), s.radius * 100);
    const d = s.radius / Math.sin((15 * Math.PI) / 180);
    cam.position.copy(s.center).add(new THREE.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(d));
    cam.lookAt(s.center);
    const r = this.renderer;
    this.rt?.dispose(); this.drt?.dispose(); this.rt = this.drt = null;
    r.setRenderTarget(null);
    r.setSize(size, size, false);
    r.setViewport(0, 0, size, size);
    r.clear();
    r.render(sc, cam);
    const url = r.domElement.toDataURL('image/png');
    dispose(obj);
    return url;
  }
}

function mats(m: THREE.Mesh): THREE.Material[] { return Array.isArray(m.material) ? m.material : [m.material]; }
function dispose(o: THREE.Object3D) {
  o.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh) { m.geometry?.dispose(); for (const mt of mats(m)) mt.dispose(); } });
}

let single: Scene3D | null = null;
/** The renderer's one three.js scene (one WebGL context). */
export function scene3d(): Scene3D { return (single ??= new Scene3D()); }

// ───────────────────────── model files ─────────────────────────
interface Loaded { scene: THREE.Object3D; clips: THREE.AnimationClip[] }
const models = new Map<string, Promise<Loaded>>();
/** Folder of a file as a cinta-media URL prefix: relative URIs inside the model resolve next to it. */
const baseUrl = (path: string) => { const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')); return mediaUrl(path.slice(0, i + 1)); };
/** Loads a .glb / .gltf / .obj (+ .mtl) with its textures (every texture has arrived when this resolves). */
export function loadModel(path: string): Promise<Loaded> {
  let p = models.get(path);
  if (!p) {
    p = (async (): Promise<Loaded> => {
      const res = await fetch(mediaUrl(path));
      if (!res.ok) throw new Error(`no se pudo leer ${path}`);
      const ext = path.toLowerCase().split('.').pop();
      if (ext === 'obj') {
        const text = await res.text(), base = baseUrl(path);
        const manager = tracker();
        const loader = new OBJLoader(manager.m);
        const lib = /^\s*mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
        if (lib) {
          try {
            const mt = await (await fetch(base + encodeURIComponent(lib))).text();
            const mc = new MTLLoader(manager.m).setResourcePath(base).parse(mt, base);
            mc.preload();
            loader.setMaterials(mc);
          } catch { /* without its materials */ }
        }
        const obj = loader.parse(text);
        await manager.done();
        obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = Array.isArray(m.material) ? m.material.map(toStandard) : toStandard(m.material); });
        return { scene: obj, clips: [] };
      }
      const buf = await res.arrayBuffer();
      const g = await new GLTFLoader().parseAsync(buf, baseUrl(path));
      return { scene: g.scene, clips: g.animations };
    })();
    p.catch(() => models.delete(path));
    models.set(path, p);
  }
  return p;
}
/** A LoadingManager whose pending files (MTL textures) can be awaited. */
function tracker() {
  let pending = 0, ok: () => void = () => {};
  const all = new Promise<void>((r) => { ok = r; });
  const m = new THREE.LoadingManager();
  m.itemStart = ((orig) => (url: string) => { pending++; orig.call(m, url); })(m.itemStart);
  m.itemEnd = ((orig) => (url: string) => { orig.call(m, url); if (--pending <= 0) ok(); })(m.itemEnd);
  m.itemError = ((orig) => (url: string) => { orig.call(m, url); })(m.itemError);
  return { m, done: () => (pending > 0 ? Promise.race([all, new Promise<void>((r) => setTimeout(r, 15000))]) : Promise.resolve()) };
}
/** OBJ / MTL materials (Phong) as physically based ones, like the glTF ones (and reflecting the environment). */
function toStandard(m: THREE.Material): THREE.Material {
  const p = m as THREE.MeshPhongMaterial;
  if (!p.isMeshPhongMaterial) return m;
  const s = new THREE.MeshStandardMaterial({
    name: p.name, color: p.color, map: p.map, normalMap: p.normalMap, bumpMap: p.bumpMap, alphaMap: p.alphaMap, emissive: p.emissive, emissiveMap: p.emissiveMap,
    transparent: p.transparent, opacity: p.opacity, side: p.side, vertexColors: p.vertexColors, flatShading: p.flatShading,
    roughness: Math.sqrt(2 / (Math.max(0, p.shininess) + 2)), metalness: 0,
  });
  p.dispose();
  return s;
}

// ───────────────────────── model layers ─────────────────────────
interface Pose { mixer: THREE.AnimationMixer; clips: THREE.AnimationClip[]; rest: { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3; morph?: number[] }[]; unlit: Map<THREE.Mesh, THREE.Material | THREE.Material[]>; lit: Map<THREE.Mesh, THREE.Material | THREE.Material[]> }
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** A model layer as a mesh provider at comp time t (null when its file is not a model). */
export function modelProvider(project: Project, comp: Comp, l: Layer, t: number, kp: string): MeshProvider | null {
  const media = project.media.find((m) => m.id === l.mediaId);
  if (!media || media.kind !== 'model') return null;
  const o = l.model, mt = l.material;
  const ev = (p: Prop | undefined, k: string, d: number) => (p ? num(valueAt(p, t, { comp, layer: l, path: `model.${k}` }), d) : null);
  return {
    id: `${kp}${l.id}`,
    version: media.path,
    build: async () => {
      const m = await loadModel(media.path);
      const obj = cloneSkinned(m.scene);
      const pose: Pose = { mixer: new THREE.AnimationMixer(obj), clips: m.clips, rest: [], unlit: new Map(), lit: new Map() };
      obj.traverse((x) => {
        pose.rest.push({ o: x, p: x.position.clone(), q: x.quaternion.clone(), s: x.scale.clone(), morph: (x as THREE.Mesh).morphTargetInfluences?.slice() });
        const me = x as THREE.Mesh;
        if (!me.isMesh) return;
        // own materials per layer (overrides change them), the file's values kept
        me.material = Array.isArray(me.material) ? me.material.map((y) => keep(y.clone())) : keep(me.material.clone());
        me.frustumCulled = false;
        pose.lit.set(me, me.material);
        const unl = (y: THREE.Material) => { const s = y as THREE.MeshStandardMaterial; return new THREE.MeshBasicMaterial({ color: s.color ?? 0xffffff, map: s.map ?? null, transparent: y.transparent, opacity: y.opacity, side: y.side, vertexColors: y.vertexColors }); };
        pose.unlit.set(me, Array.isArray(me.material) ? me.material.map(unl) : unl(me.material));
      });
      obj.userData.cinta = pose;
      return obj;
    },
    update: (obj) => {
      const pose = obj.userData.cinta as Pose | undefined;
      if (!pose) return;
      // the rest pose, then the clip at its time (deterministic: absolute time, no deltas)
      for (const r of pose.rest) { r.o.position.copy(r.p); r.o.quaternion.copy(r.q); r.o.scale.copy(r.s); if (r.morph) (r.o as THREE.Mesh).morphTargetInfluences!.splice(0, r.morph.length, ...r.morph); }
      pose.mixer.stopAllAction();
      const clip = o?.clip ? pose.clips.find((c) => c.name === o.clip) ?? pose.clips[pose.clips.findIndex((_, i) => `Animación_${i + 1}` === o.clip)] : undefined;
      if (clip) {
        const a = pose.mixer.clipAction(clip);
        a.reset();
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
        a.play();
        pose.mixer.setTime(Math.min(clip.duration - 1e-6, Math.max(0, modelClipTime(comp, l, t, clip.duration))));
      }
      const lit = mt?.acceptsLights ?? true;
      const metal = ev(o?.metalness, 'metalness', 0), rough = ev(o?.roughness, 'roughness', 50);
      const emis = o?.emissive ? String(valueAt(o.emissive, t, { comp, layer: l, path: 'model.emissive' })) : null, emisK = ev(o?.emissiveIntensity, 'emissiveIntensity', 100);
      obj.traverse((x) => {
        const me = x as THREE.Mesh;
        if (!me.isMesh) return;
        me.material = (lit ? pose.lit.get(me) : pose.unlit.get(me)) ?? me.material;
        for (const m of mats(me)) {
          const s = m as THREE.MeshStandardMaterial, f = m.userData.file as { metalness: number; roughness: number; emissive: number; emissiveIntensity: number } | undefined;
          if (!s.isMeshStandardMaterial || !f) continue;
          s.metalness = metal !== null ? metal / 100 : f.metalness;
          s.roughness = rough !== null ? rough / 100 : f.roughness;
          if (emis) { s.emissive.set(emis); s.emissiveIntensity = (emisK ?? 100) / 100; } else { s.emissive.setHex(f.emissive); s.emissiveIntensity = f.emissiveIntensity; }
        }
      });
    },
    matrix: modelWorld(comp, l, t),
    castShadow: !!mt && mt.castsShadows !== 'off',
    receiveShadow: mt?.acceptsShadows ?? true,
    shadowOnly: mt?.castsShadows === 'only',
  };
}
function keep(m: THREE.Material): THREE.Material {
  const s = m as THREE.MeshStandardMaterial;
  if (s.isMeshStandardMaterial) m.userData.file = { metalness: s.metalness, roughness: s.roughness, emissive: s.emissive.getHex(), emissiveIntensity: s.emissiveIntensity };
  return m;
}

/** The frame description of a comp at time t: camera, lights (or the default lighting) and its environment light. */
export function compFrame(project: Project, comp: Comp, t: number, W: number, H: number): { frame: Scene3DFrame; envs: EnvSource[] } {
  const all = sceneLights(comp, t);
  const envL = all.find((x) => x.type === 'environment' && x.envLayer);
  const envs: EnvSource[] = [];
  let env: Scene3DFrame['env'] = null;
  if (envL) {
    const src = comp.layers.find((x) => x.id === envL.envLayer), m = project.media.find((x) => x.id === src?.mediaId);
    // EXR footage keeps its full range in the original file
    const path = m ? m.exr?.source ?? m.path : undefined;
    if (path) { envs.push({ key: path, path }); env = { key: path, intensity: envL.intensity / Math.PI, rotation: envL.envRotation ?? 0 }; }
  }
  const lights = all.filter((x) => x.type !== 'environment');
  return { frame: { W, H, camera: threeCamera(comp, t), lights: lights.length || env ? lights : defaultLights(comp, t), env }, envs };
}
