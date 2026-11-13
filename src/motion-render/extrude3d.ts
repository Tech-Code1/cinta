// «extrusion» in the renderer: extruded 3D text and shape layers (After Effects' Opciones de geometría) as three.js
// meshes drawn by scene3d.ts through the MeshProvider API, in the same scene as 3D models (same camera, lights,
// shadows and per-pixel depth with the other 3D layers). The meshes come from core/motion/extrude.ts: text from the
// font file's glyph outlines (one mesh per character, posed every frame by the text animators), shapes from the
// outlines the shape renderer draws (fills as regions with holes, strokes as their outline ring).
import * as THREE from 'three';
import { valueAt } from '../core/motion/anim';
import { extrude, flattenBezier, mul, pathToContours, rotX, rotY, rotZ, scaleM, solidsFromRings, strokeSolids, subtractSolids, translate, type GeomAt, type Mat4, type Solid } from '../core/motion';
import { SURFACE_KEYS, type SurfaceKey } from '../core/motion/extrude';
import type { OTFont } from '../core/motion/fontfile';
import type { Comp, Layer, Prop } from '../core/motion/model';
import type { MeshProvider } from './scene3d';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ───────────────────────── materials ─────────────────────────
/** A layer's material at t (After Effects' Material Options: ambient / diffuse / specular %, shininess, metal). */
export interface MatAt { lit: boolean; ambient: number; diffuse: number; specular: number; shininess: number; metal: number }
export function materialAt(comp: Comp, l: Layer, t: number, defaultLighting: boolean): MatAt {
  const mt = l.material, ev = (p: Prop | undefined, k: string, d: number) => (p ? num(valueAt(p, t, { comp, layer: l, path: `material.${k}` }), d) : d) / 100;
  // without comp lights the scene's default lighting shows the colours as they are (ambient + diffuse at full)
  return {
    lit: mt?.acceptsLights ?? true,
    ambient: defaultLighting ? 1 : ev(mt?.ambient, 'ambient', 100), diffuse: defaultLighting ? 1 : ev(mt?.diffuse, 'diffuse', 50),
    specular: ev(mt?.specular, 'specular', 50), shininess: ev(mt?.shininess, 'shininess', 5), metal: ev(mt?.metal, 'metal', 100),
  };
}
/** Phong with After Effects' weights: ambient light × Ambient, direct light × Diffuse (as Cinta's own 3D layers). */
function litMaterial(): THREE.MeshPhongMaterial {
  const m = new THREE.MeshPhongMaterial({ side: THREE.DoubleSide });
  const u = { uAmbK: { value: 1 }, uDifK: { value: 1 } };
  m.userData.k = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'uniform float uAmbK; uniform float uDifK;\nvoid main() {')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n\treflectedLight.indirectDiffuse *= uAmbK; reflectedLight.directDiffuse *= uDifK;');
  };
  m.customProgramCacheKey = () => 'cinta-ae-phong';
  return m;
}
/** The four surface materials of one mesh (front, bevel, side, back), lit and unlit. */
interface Mats { lit: THREE.MeshPhongMaterial[]; flat: THREE.MeshBasicMaterial[] }
const newMats = (): Mats => ({ lit: [0, 1, 2, 3].map(litMaterial), flat: [0, 1, 2, 3].map(() => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })) });
const tmp = new THREE.Color();
function setMats(mesh: THREE.Mesh, ms: Mats, colors: string[], opacity: number, m: MatAt, offset = 0) {
  const arr = m.lit ? ms.lit : ms.flat;
  arr.forEach((x, i) => {
    x.color.set(colors[i]);
    x.opacity = opacity;
    x.transparent = opacity < 0.999;
    x.depthWrite = true;
    if (offset) { x.polygonOffset = true; x.polygonOffsetFactor = -offset; x.polygonOffsetUnits = -offset; }
    const p = x as THREE.MeshPhongMaterial;
    if (p.isMeshPhongMaterial) {
      // highlights: white for plastic, the surface colour for metal (Metal %)
      tmp.set(colors[i]);
      p.specular.setRGB(1, 1, 1).lerp(tmp, m.metal).multiplyScalar(m.specular);
      p.shininess = 1 + m.shininess * 99;
      const u = p.userData.k as { uAmbK: { value: number }; uDifK: { value: number } };
      u.uAmbK.value = m.ambient; u.uDifK.value = m.diffuse;
    }
  });
  mesh.material = arr;
}
function geometryOf(solids: Solid[], g: GeomAt): THREE.BufferGeometry {
  const m = extrude(solids, g);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
  for (const gr of m.groups) geo.addGroup(gr.start, gr.count, gr.surface);
  geo.computeBoundingSphere();
  return geo;
}
const gkey = (g: GeomAt) => `${g.style}|${g.bevel.toFixed(3)}|${g.hole.toFixed(4)}|${g.depth.toFixed(3)}`;
/** The surface colours set on the layer (Opciones de material), over the automatic ones. */
function surfaceColors(comp: Comp, l: Layer, t: number, auto: Record<SurfaceKey, string>): string[] {
  return SURFACE_KEYS.map((k) => { const p = l.material?.[k]; return p ? String(valueAt(p, t, { comp, layer: l, path: `material.${k}` })) : auto[k]; });
}
function mixColor(a: string, b: string, w: number): string {
  const A = new THREE.Color(a), B = new THREE.Color(b);
  return `#${A.lerp(B, Math.max(0, Math.min(1, w))).getHexString()}`;
}

// ───────────────────────── text ─────────────────────────
/** One character of a text layer at t: its glyph, where it goes and its animator state. */
export interface ExtGlyph {
  ch: string; w: number;
  place: { x: number; y: number; a: number };
  st: { dx: number; dy: number; dz: number; sx: number; sy: number; rot: number; rotY: number; rotX: number; op: number; fill: string; stroke: string };
  /** animator colours of the surfaces (Animar ▸ Frontal / Bisel / Lateral / Posterior ▸ Color): [value, amount] */
  faces?: Partial<Record<SurfaceKey, [string, number]>>;
}
export interface ExtText { glyphs: ExtGlyph[]; size: number; pivotY: number; sw: number; fill: string; stroke: string; axes?: Record<string, number> }

/** Outline solids of a glyph around its pivot (as MotionRenderer draws the character). */
function glyphSolids(f: OTFont, ch: string, w: number, size: number, pivotY: number, axes?: Record<string, number>): Solid[] {
  const cs = pathToContours(f.path(f.glyphId(ch), f.axes.length ? axes : undefined), size / f.unitsPerEm, -w / 2, -pivotY);
  const tol = Math.max(0.15, Math.min(1, size / 200));
  return solidsFromRings(cs.map((c) => flattenBezier(c, true, tol)), 'nonzero');
}
/** A text layer as an extruded mesh provider (one child per visible character). */
export function textMeshProvider(id: string, comp: Comp, l: Layer, t: number, g: GeomAt, x: ExtText, font: () => Promise<OTFont | null>, world: Mat4, mat: MatAt, shadow: { cast: boolean; receive: boolean; only: boolean }): MeshProvider {
  const vis = x.glyphs.map((gl, i) => ({ gl, i })).filter(({ gl }) => gl.ch.trim());
  const auto: Record<SurfaceKey, string> = { frontColor: x.fill, backColor: x.fill, bevelColor: x.sw > 0 ? x.stroke : x.fill, sideColor: x.sw > 0 ? x.stroke : x.fill };
  const base = surfaceColors(comp, l, t, auto);
  return {
    id,
    version: `text|${gkey(g)}|${x.size}|${x.pivotY}|${JSON.stringify(x.axes ?? {})}|${vis.map(({ gl }) => `${gl.ch}:${gl.w.toFixed(2)}`).join(',')}`,
    build: async () => {
      const f = await font();
      if (!f) throw new Error(`No se pueden adquirir los contornos de la fuente «${l.text?.font}».`);
      const grp = new THREE.Group();
      const geos = new Map<string, THREE.BufferGeometry>();
      for (const { gl } of vis) {
        const k = `${gl.ch}|${gl.w}`;
        let geo = geos.get(k);
        if (!geo) { geo = geometryOf(glyphSolids(f, gl.ch, gl.w, x.size, x.pivotY, x.axes), g); geos.set(k, geo); }
        const mesh = new THREE.Mesh(geo);
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        mesh.userData.mats = newMats();
        grp.add(mesh);
      }
      return grp;
    },
    update: (obj) => {
      obj.children.forEach((c, k) => {
        const it = vis[k];
        if (!it) return;
        const { gl } = it, s0 = gl.st, mesh = c as THREE.Mesh;
        mesh.visible = s0.op > 0.001;
        const M = mul(translate(gl.place.x + s0.dx, gl.place.y + s0.dy, s0.dz), mul(rotZ(s0.rot + gl.place.a), mul(rotY(s0.rotY), mul(rotX(s0.rotX), scaleM(s0.sx, s0.sy, 1)))));
        mesh.matrix.fromArray(Array.from(M));
        // the fill / stroke animated per character move the automatic colours; face animators override them
        const cols = SURFACE_KEYS.map((key, i) => {
          let c0 = l.material?.[key] ? base[i] : key === 'frontColor' || key === 'backColor' ? s0.fill : x.sw > 0 ? s0.stroke : s0.fill;
          const f = gl.faces?.[key];
          if (f) c0 = mixColor(c0, f[0], f[1]);
          return c0;
        });
        setMats(mesh, mesh.userData.mats as Mats, cols, Math.min(1, s0.op), mat);
      });
    },
    matrix: world,
    castShadow: shadow.cast, receiveShadow: shadow.receive, shadowOnly: shadow.only,
  };
}

// ───────────────────────── shapes ─────────────────────────
/** One drawn piece of a shape layer: its outlines (layer px), fill and stroke. */
export interface ExtPiece {
  pts: number[][]; closed: boolean[]; rule: 'nonzero' | 'evenodd';
  fill?: { color: string; opacity: number };
  stroke?: { color: string; opacity: number; width: number; join: 'miter' | 'round' | 'bevel'; cap: 'butt' | 'round' | 'square' };
  alpha: number;
}
/** A shape layer as an extruded mesh provider: each fill a region with holes, each stroke its outline ring. */
export function shapeMeshProvider(id: string, comp: Comp, l: Layer, t: number, g: GeomAt, pieces: ExtPiece[], world: Mat4, mat: MatAt, shadow: { cast: boolean; receive: boolean; only: boolean }): MeshProvider {
  const hash = pieces.map((p) => `${p.rule}${p.fill ? 'F' : ''}${p.stroke ? `S${p.stroke.width.toFixed(2)}${p.stroke.join}${p.stroke.cap}` : ''}:${p.pts.map((r, i) => `${p.closed[i] ? 'c' : 'o'}${r.map((v) => Math.round(v * 100)).join(' ')}`).join('/')}`).join('|');
  let h = 0;
  for (let i = 0; i < hash.length; i++) h = (Math.imul(h, 31) + hash.charCodeAt(i)) | 0;
  return {
    id,
    version: `shape|${gkey(g)}|${hash.length}|${h}`,
    build: () => {
      const grp = new THREE.Group();
      for (const p of pieces) {
        const strokeS = p.stroke ? p.pts.flatMap((r, i) => strokeSolids(r, p.closed[i], p.stroke!.width, p.stroke!.join, p.stroke!.cap)) : [];
        let fillS = p.fill ? solidsFromRings(p.pts.filter((_, i) => p.closed[i]), p.rule) : [];
        // the stroke's ring covers the fill's edge: cut it out (no two faces in one place)
        if (strokeS.length && fillS.length) fillS = subtractSolids(fillS, strokeS);
        for (const [kind, ss] of [['fill', fillS], ['stroke', strokeS]] as const) {
          // overlapping strokes of one path are joined
          if (!ss.length) { grp.add(new THREE.Group()); continue; }
          const mesh = new THREE.Mesh(geometryOf(ss, g));
          mesh.frustumCulled = false;
          mesh.userData.mats = newMats();
          mesh.userData.kind = kind;
          grp.add(mesh);
        }
      }
      return grp;
    },
    update: (obj) => {
      pieces.forEach((p, i) => {
        const auto = (strokeMesh: boolean): Record<SurfaceKey, string> => {
          const f = strokeMesh ? p.stroke!.color : p.fill?.color ?? '#ffffff', s = p.stroke?.color ?? f;
          return strokeMesh ? { frontColor: s, bevelColor: s, sideColor: s, backColor: s } : { frontColor: f, backColor: f, bevelColor: s, sideColor: s };
        };
        for (const k of [0, 1]) {
          const mesh = obj.children[i * 2 + k] as THREE.Mesh;
          if (!mesh?.isMesh) continue;
          const isStroke = k === 1;
          const op = p.alpha * (isStroke ? p.stroke!.opacity : p.fill!.opacity);
          mesh.visible = op > 0.001;
          // pieces drawn later (higher in the layer) win where they meet at the same depth
          setMats(mesh, mesh.userData.mats as Mats, surfaceColors(comp, l, t, auto(isStroke)), Math.min(1, op), mat, i * 2 + k);
        }
      });
    },
    matrix: world,
    castShadow: shadow.cast, receiveShadow: shadow.receive, shadowOnly: shadow.only,
  };
}
