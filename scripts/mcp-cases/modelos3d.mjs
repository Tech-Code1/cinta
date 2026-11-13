// MCP cases of the 3D model layers (three.js): models written by the test itself (a red .gltf cube with an external
// .bin and a 1-second turn, the same as .glb, a green .obj + .mtl), imported, added and checked on rendered pixels —
// where the camera projects it, how comp lights and an environment light shade it, its animation, and 3D solids
// hiding it per pixel.
import { readFileSync, writeFileSync } from 'node:fs';

/** A unit cube (±0.5) with per-face normals, a red PBR material and a 1 s turn about Y, as glTF JSON + binary. */
export function cubeGltf(color = [1, 0, 0, 1]) {
  const P = [], N = [], I = [];
  const faces = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  for (const n of faces) {
    const [a, b] = n[0] ? [[0, 1, 0], [0, 0, 1]] : n[1] ? [[1, 0, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0]];
    const base = P.length / 3;
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) P.push(n[k] * 0.5 + a[k] * s * 0.5 + b[k] * t * 0.5);
      N.push(...n);
    }
    // counter-clockwise seen from outside
    const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const same = c[0] * n[0] + c[1] * n[1] + c[2] * n[2] > 0;
    I.push(...(same ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map((i) => base + i));
  }
  const times = [0, 0.25, 0.5, 0.75, 1], quats = [];
  for (const tt of times) { const h = (tt * 2 * Math.PI) / 2; quats.push(0, Math.sin(h), 0, Math.cos(h)); }
  const parts = [new Float32Array(P), new Float32Array(N), new Uint16Array(I), new Float32Array(times), new Float32Array(quats)];
  const views = [], chunks = [];
  let off = 0;
  for (const p of parts) { const b = Buffer.from(p.buffer); const pad = (4 - (b.length % 4)) % 4; views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); chunks.push(b, Buffer.alloc(pad)); off += b.length + pad; }
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'Cinta test' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Cubo', mesh: 0 }],
    meshes: [{ name: 'Cubo', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'Rojo', pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 1 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 3, componentType: 5126, count: 5, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 4, componentType: 5126, count: 5, type: 'VEC4' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length, uri: 'cubo.bin' }],
    animations: [{ name: 'Girar', samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }] }],
  };
  return { json, bin };
}
/** The same cube as one .glb (binary glTF). */
export function cubeGlb(color) {
  const { json, bin } = cubeGltf(color);
  delete json.buffers[0].uri;
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, js, bh, bin]);
}
const OBJ = `# Cinta test cube
mtllib verde.mtl
o Caja
v -0.5 -0.5 0.5
v 0.5 -0.5 0.5
v 0.5 0.5 0.5
v -0.5 0.5 0.5
v -0.5 -0.5 -0.5
v 0.5 -0.5 -0.5
v 0.5 0.5 -0.5
v -0.5 0.5 -0.5
usemtl Verde
f 1 2 3 4
f 6 5 8 7
f 2 6 7 3
f 5 1 4 8
f 4 3 7 8
f 5 6 2 1
`;
const MTL = 'newmtl Verde\nKd 0.0 1.0 0.0\nKa 0 0 0\nKs 0 0 0\nNs 10\n';

export default async ({ test, call, callErr, assert, imgOf, isColor, ff, W }) => {
  const MP = W('modelos3d.cinta');
  writeFileSync(W('cubo.gltf'), JSON.stringify(cubeGltf().json));
  writeFileSync(W('cubo.bin'), cubeGltf().bin);
  writeFileSync(W('cubo.glb'), cubeGlb([0, 0, 1, 1]));
  writeFileSync(W('caja.obj'), OBJ);
  writeFileSync(W('verde.mtl'), MTL);
  const CW = 400, CH = 300;
  let shot = 0;
  /** a frame of the comp (also kept as modelos3d_<n>.png in the work folder, to look at when a case fails) */
  const frame = async (t, comp = 'M') => imgOf(await call('comp_frame', { project: MP, comp, time: t, width: CW, output: W(`modelos3d_${++shot}.png`) }));
  /** bounding box of the pixels that pass f, in comp px */
  const bboxOf = (img, f) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const p = img.at((x + 0.5) / img.width, (y + 0.5) / img.height); if (f(p)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); } }
    return [x0, y0, x1, y1];
  };
  const reddish = (p) => p[0] > 40 && p[0] > p[1] * 2 + 20 && p[0] > p[2] * 2 + 20;
  const px = (img, x, y) => img.at(x / CW, y / CH);
  /** After Effects' default camera (50 mm) projection of a comp point */
  const zoom = Math.round((CW / 2) / Math.tan((39.6 / 2) * (Math.PI / 180)));
  const proj = (x, y, z) => [CW / 2 + (zoom * (x - CW / 2)) / (z + zoom), CH / 2 + (zoom * (y - CH / 2)) / (z + zoom)];
  let cube, media;

  await test('modelos3d: importar .gltf (+ .bin), .glb y .obj (+ .mtl): mallas, animaciones y caja en comp_get', async () => {
    await call('project_new', { path: MP, width: CW, height: CH, fps: 30 });
    await call('comp_new', { project: MP, name: 'M', width: CW, height: CH, fps: 30, duration: 2, bg: '#000000' });
    const r = await call('media_import', { project: MP, paths: [W('cubo.gltf'), W('cubo.glb'), W('caja.obj')] });
    media = r.media;
    assert(media.length === 3 && media.every((m) => m.kind === 'model'), JSON.stringify(media));
    const l = await call('layer_add', { project: MP, comp: 'M', type: 'model', media_id: media[0].id });
    cube = l.layer.id;
    const g = await call('comp_get', { project: MP, comp: 'M' });
    const ml = g.comp.layers.find((x) => x.id === cube);
    assert(ml.type === 'model' && ml.threeD, JSON.stringify(ml));
    const m = ml.model;
    assert(m.meshes.join() === 'Cubo' && m.clips.length === 1 && m.clips[0].name === 'Girar' && Math.abs(m.clips[0].duration - 1) < 1e-6 && m.clip === 'Girar', JSON.stringify(m));
    assert(m.bbox.min.join() === '-0.5,-0.5,-0.5' && m.bbox.max.join() === '0.5,0.5,0.5' && m.triangles === 12 && m.unit === 150, JSON.stringify(m));
    // the model's centre is the anchor; its box in layer px
    assert(m.layerBox.min.join() === '-75,-75,-75' && m.layerBox.max.join() === '75,75,75', JSON.stringify(m.layerBox));
    const ob = await call('layer_add', { project: MP, comp: 'M', type: 'model', media_id: media[2].id, name: 'Caja' });
    const g2 = await call('comp_get', { project: MP, comp: 'M' });
    const om = g2.comp.layers.find((x) => x.id === ob.layer.id).model;
    assert(om.meshes.join() === 'Caja' && om.materials.join() === 'Verde' && om.clips.length === 0 && om.triangles === 12, JSON.stringify(om));
    await call('layer_delete', { project: MP, comp: 'M', layers: [ob.layer.id] });
    // a missing .bin is refused at import
    writeFileSync(W('roto.gltf'), JSON.stringify({ ...cubeGltf().json, buffers: [{ byteLength: 10, uri: 'no-existe.bin' }] }));
    const e = await callErr('media_import', { project: MP, paths: [W('roto.gltf')] });
    assert(/no-existe\.bin/.test(e), e);
  });

  await test('modelos3d: el cubo aparece donde lo proyecta la cámara por defecto (sus 8 esquinas)', async () => {
    await call('model_set', { project: MP, comp: 'M', layer: cube, clip: '' });
    await call('prop_set', { project: MP, comp: 'M', layer: cube, path: 'position', value: [130, 160, 0] });
    const img = await frame(0);
    const [x0, y0, x1, y1] = bboxOf(img, reddish);
    let ex0 = Infinity, ey0 = Infinity, ex1 = -Infinity, ey1 = -Infinity;
    for (let c = 0; c < 8; c++) { const p = proj(130 + (c & 1 ? 75 : -75), 160 + (c & 2 ? 75 : -75), c & 4 ? 75 : -75); ex0 = Math.min(ex0, p[0]); ex1 = Math.max(ex1, p[0]); ey0 = Math.min(ey0, p[1]); ey1 = Math.max(ey1, p[1]); }
    const d = Math.max(Math.abs(x0 - ex0), Math.abs(x1 - ex1), Math.abs(y0 - ey0), Math.abs(y1 - ey1));
    assert(d <= 2, `rojo en ${[x0, y0, x1, y1]}, esperado ${[ex0, ey0, ex1, ey1].map((v) => v.toFixed(1))}`);
    // with a camera layer moved and zoomed: the same projection maths
    const cam = await call('layer_add', { project: MP, comp: 'M', type: 'camera' });
    await call('prop_set', { project: MP, comp: 'M', layer: cam.layer.id, path: 'camera.zoom', value: 600 });
    await call('prop_set', { project: MP, comp: 'M', layer: cam.layer.id, path: 'position', value: [200, 150, -600] });
    const i2 = await frame(0);
    const [a0, b0, a1, b1] = bboxOf(i2, reddish);
    const pc = (x, y, z) => [200 + (600 * (x - 200)) / (z + 600), 150 + (600 * (y - 150)) / (z + 600)];
    let f0 = Infinity, g0 = Infinity, f1 = -Infinity, g1 = -Infinity;
    for (let c = 0; c < 8; c++) { const p = pc(130 + (c & 1 ? 75 : -75), 160 + (c & 2 ? 75 : -75), c & 4 ? 75 : -75); f0 = Math.min(f0, p[0]); f1 = Math.max(f1, p[0]); g0 = Math.min(g0, p[1]); g1 = Math.max(g1, p[1]); }
    assert(Math.max(Math.abs(a0 - f0), Math.abs(a1 - f1), Math.abs(b0 - g0), Math.abs(b1 - g1)) <= 2, `cámara: ${[a0, b0, a1, b1]} vs ${[f0, g0, f1, g1].map((v) => v.toFixed(1))}`);
    await call('layer_delete', { project: MP, comp: 'M', layers: [cam.layer.id] });
    await call('prop_set', { project: MP, comp: 'M', layer: cube, path: 'position', value: [200, 150, 0] });
  });

  await test('modelos3d: las luces de la composición lo iluminan (ambiente 100 % / 50 %, paralela de frente y de lado)', async () => {
    const amb = await call('layer_add', { project: MP, comp: 'M', type: 'light', light_type: 'ambient' });
    let img = await frame(0);
    let c = px(img, 200, 150);
    assert(isColor(c, [255, 0, 0], 20), `ambiente 100 %: ${c}`);
    await call('prop_set', { project: MP, comp: 'M', layer: amb.layer.id, path: 'light.intensity', value: 50 });
    img = await frame(0);
    c = px(img, 200, 150);
    // 50 % of linear red, in sRGB ≈ 188
    assert(Math.abs(c[0] - 188) < 8 && c[1] < 10 && c[2] < 10, `ambiente 50 %: ${c}`);
    await call('prop_set', { project: MP, comp: 'M', layer: amb.layer.id, path: 'light.intensity', value: 0 });
    // a parallel light straight from the camera lights the front face fully; from the side it does not
    const par = await call('layer_add', { project: MP, comp: 'M', type: 'light', light_type: 'parallel' });
    await call('prop_set', { project: MP, comp: 'M', layer: par.layer.id, path: 'position', value: [200, 150, -1000] });
    await call('prop_set', { project: MP, comp: 'M', layer: par.layer.id, path: 'light.poi', value: [200, 150, 0] });
    img = await frame(0);
    c = px(img, 200, 150);
    assert(c[0] > 240 && c[1] < 45 && c[2] < 45, `paralela de frente: ${c}`);
    await call('prop_set', { project: MP, comp: 'M', layer: par.layer.id, path: 'position', value: [1200, 150, 0] });
    img = await frame(0);
    c = px(img, 200, 150);
    assert(c[0] < 15, `paralela de lado (la cara frontal queda a oscuras): ${c}`);
    // the light's colour tints it: a green light on a red cube gives black
    await call('prop_set', { project: MP, comp: 'M', layer: par.layer.id, path: 'position', value: [200, 150, -1000] });
    await call('prop_set', { project: MP, comp: 'M', layer: par.layer.id, path: 'light.color', value: '#00ff00' });
    c = px(await frame(0), 200, 150);
    assert(c[0] < 15, `luz verde: ${c}`);
    await call('layer_delete', { project: MP, comp: 'M', layers: [par.layer.id] });
    await call('prop_set', { project: MP, comp: 'M', layer: amb.layer.id, path: 'light.intensity', value: 100 });
  });

  await test('modelos3d: la animación incrustada gira el cubo (velocidad, desplazamiento, reasignación) y es determinista', async () => {
    await call('model_set', { project: MP, comp: 'M', layer: cube, clip: 'Girar' });
    const w = async (t) => { const b = bboxOf(await frame(t), reddish); return b[2] - b[0]; };
    const w0 = await w(0), w45 = await w(0.125), w90 = await w(0.25);
    assert(w45 > w0 * 1.15 && Math.abs(w90 - w0) <= 2, `anchos 0° ${w0}, 45° ${w45}, 90° ${w90}`);
    // half speed: 45° at 0.25 s; offset 0.125 s: 45° at 0
    await call('model_set', { project: MP, comp: 'M', layer: cube, speed: 0.5 });
    assert(Math.abs((await w(0.25)) - w45) <= 2, 'velocidad 0,5');
    await call('model_set', { project: MP, comp: 'M', layer: cube, speed: 1, offset: 0.125 });
    assert(Math.abs((await w(0)) - w45) <= 2, 'desplazamiento');
    await call('model_set', { project: MP, comp: 'M', layer: cube, offset: 0 });
    // the same frame twice: the same pixels
    const a = await call('comp_frame', { project: MP, comp: 'M', time: 0.4, width: CW }), b = await call('comp_frame', { project: MP, comp: 'M', time: 0.4, width: CW });
    const da = a._content.find((x) => x.type === 'image').data, db = b._content.find((x) => x.type === 'image').data;
    assert(da === db, 'dos renders del mismo instante difieren');
    // time remapping drives the clip: held at 0.125 s of source → 45° all along
    await call('prop_set', { project: MP, comp: 'M', layer: cube, path: 'timeRemap', keys: [{ t: 0, v: 0.125 }, { t: 2, v: 0.125 }] });
    assert(Math.abs((await w(0.7)) - w45) <= 2, 'reasignación de tiempo');
    await call('prop_set', { project: MP, comp: 'M', layer: cube, path: 'timeRemap', keys: [] }).catch(() => {});
    await call('model_set', { project: MP, comp: 'M', layer: cube, clip: '' });
  });

  await test('modelos3d: sólidos 3D delante lo tapan y un plano que lo atraviesa lo corta por píxel', async () => {
    // a small blue 3D solid in front (z −200): blue at the centre
    const s1 = await call('layer_add', { project: MP, comp: 'M', type: 'solid', color: '#0000ff', width: 40, height: 40 });
    await call('layer_set', { project: MP, comp: 'M', layer: s1.layer.id, three_d: true });
    await call('prop_set', { project: MP, comp: 'M', layer: s1.layer.id, path: 'position', value: [200, 150, -200] });
    let img = await frame(0);
    assert(isColor(px(img, 200, 150), [0, 0, 255], 40) && reddish(px(img, 200, 110)), `delante: ${px(img, 200, 150)} / ${px(img, 200, 110)}`);
    // behind the cube (z +200, lower in the stack): hidden by it
    await call('prop_set', { project: MP, comp: 'M', layer: s1.layer.id, path: 'position', value: [200, 150, 200] });
    await call('layer_arrange', { project: MP, comp: 'M', action: 'reorder', layers: [s1.layer.id], index: 2 });
    img = await frame(0);
    assert(reddish(px(img, 200, 150)), `detrás: ${px(img, 200, 150)}`);
    await call('layer_delete', { project: MP, comp: 'M', layers: [s1.layer.id] });
    // a green strip turned 60° about Y through the cube's centre: in front of it on the right, behind on the left
    const s2 = await call('layer_add', { project: MP, comp: 'M', type: 'solid', color: '#00ff00', width: 400, height: 30 });
    await call('layer_set', { project: MP, comp: 'M', layer: s2.layer.id, three_d: true });
    await call('prop_set', { project: MP, comp: 'M', layer: s2.layer.id, path: 'rotationY', value: 60 });
    img = await frame(0);
    const L = px(img, 150, 150), R = px(img, 260, 150);
    assert(reddish(L) && isColor(R, [0, 255, 0], 60), `izquierda ${L} (cubo), derecha ${R} (plano)`);
    // no seam of the cube's antialiased edge over the strip in front of it
    for (let x = 280; x <= 295; x++) assert(isColor(px(img, x + 0.5, 150), [0, 255, 0], 60), `costura en x=${x}: ${px(img, x + 0.5, 150)}`);
    // outside the cube the strip shows on both sides
    assert(isColor(px(img, 60, 150), [0, 255, 0], 60) || isColor(px(img, 330, 150), [0, 255, 0], 60), 'el plano fuera del cubo');
    await call('layer_delete', { project: MP, comp: 'M', layers: [s2.layer.id] });
  });

  await test('modelos3d: .obj con .mtl (verde), .glb (azul) y opciones de material (metal, emisivo, no acepta luces)', async () => {
    const ob = await call('layer_add', { project: MP, comp: 'M', type: 'model', media_id: media[2].id });
    await call('layer_set', { project: MP, comp: 'M', layer: cube, hidden: true });
    let c = px(await frame(0), 200, 150);
    assert(c[1] > 200 && c[0] < 30 && c[2] < 30, `obj verde: ${c}`);
    await call('layer_delete', { project: MP, comp: 'M', layers: [ob.layer.id] });
    const gb = await call('layer_add', { project: MP, comp: 'M', type: 'model', media_id: media[1].id });
    c = px(await frame(0), 200, 150);
    assert(c[2] > 200 && c[0] < 30 && c[1] < 30, `glb azul: ${c}`);
    // emissive white at 100 % adds white light: the face goes to white
    await call('model_set', { project: MP, comp: 'M', layer: gb.layer.id, emissive: '#ffffff', emissive_intensity: 100 });
    c = px(await frame(0), 200, 150);
    assert(c[0] > 240 && c[1] > 240 && c[2] > 240, `emisivo: ${c}`);
    await call('model_set', { project: MP, comp: 'M', layer: gb.layer.id, emissive: null });
    // ambient at 0 %: black; not accepting lights: its own colour
    const g = await call('comp_get', { project: MP, comp: 'M' });
    const amb = g.comp.layers.find((x) => x.type === 'light');
    await call('prop_set', { project: MP, comp: 'M', layer: amb.id, path: 'light.intensity', value: 0 });
    c = px(await frame(0), 200, 150);
    assert(c[2] < 15, `sin luz: ${c}`);
    await call('layer_set', { project: MP, comp: 'M', layer: gb.layer.id, material: { accepts_lights: false } });
    c = px(await frame(0), 200, 150);
    assert(c[2] > 240, `no acepta luces: ${c}`);
    await call('layer_set', { project: MP, comp: 'M', layer: gb.layer.id, material: { accepts_lights: true } });
    await call('prop_set', { project: MP, comp: 'M', layer: amb.id, path: 'light.intensity', value: 100 });
    await call('layer_delete', { project: MP, comp: 'M', layers: [gb.layer.id] });
    await call('layer_set', { project: MP, comp: 'M', layer: cube, hidden: false });
  });

  await test('modelos3d: luz de entorno con una imagen HDRI: un cubo metálico pulido refleja su color', async () => {
    ff('-f', 'lavfi', '-i', 'color=c=0xffcc00:s=64x32', '-frames:v', '1', W('entorno.png'));
    const env = await call('layer_add', { project: MP, comp: 'M', type: 'image', media_path: W('entorno.png') });
    await call('layer_set', { project: MP, comp: 'M', layer: env.layer.id, hidden: true });
    const g = await call('comp_get', { project: MP, comp: 'M' });
    for (const l of g.comp.layers.filter((x) => x.type === 'light')) await call('layer_delete', { project: MP, comp: 'M', layers: [l.id] });
    const el = await call('layer_add', { project: MP, comp: 'M', type: 'light', light_type: 'environment' });
    await call('layer_set', { project: MP, comp: 'M', layer: el.layer.id, light: { env_source: env.layer.id } });
    await call('model_set', { project: MP, comp: 'M', layer: cube, metalness: 100, roughness: 0 });
    const g2 = await call('comp_get', { project: MP, comp: 'M' });
    assert(g2.comp.layers.find((x) => x.id === el.layer.id).light.type === 'environment', 'tipo entorno');
    // a chrome cube in a yellow world: yellow; red base colour × yellow = red-orange (metal tints by its colour)
    const c = px(await frame(0), 200, 150);
    assert(c[0] > 150 && c[2] < 40, `reflejo del entorno: ${c}`);
    const e = await callErr('layer_set', { project: MP, comp: 'M', layer: el.layer.id, light: { env_source: cube } });
    assert(/imagen o vídeo/.test(e), e);
    await call('model_set', { project: MP, comp: 'M', layer: cube, metalness: null, roughness: null });
    await call('layer_delete', { project: MP, comp: 'M', layers: [el.layer.id, env.layer.id] });
  });

  await test('modelos3d: comp_render da los mismos píxeles que comp_frame', async () => {
    await call('layer_add', { project: MP, comp: 'M', type: 'light', light_type: 'ambient' });
    await call('model_set', { project: MP, comp: 'M', layer: cube, clip: 'Girar' });
    const r = await call('comp_render', { project: MP, comp: 'M', output: W('modelos3d_render.png'), format: 'png', from: 0.1, to: 0.1 + 1 / 30 });
    const out = r.outputs?.[0]?.path ?? r.path;
    const file = String(out).replace('%05d', '00001');
    const a = imgOf({ _content: [{ type: 'image', data: readFileSync(file).toString('base64') }] });
    const b = await frame(0.1);
    let diff = 0;
    for (let y = 0; y < CH; y += 3) for (let x = 0; x < CW; x += 3) { const p = px(a, x, y), q = px(b, x, y); diff = Math.max(diff, Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])); }
    assert(diff <= 6, `diferencia máxima ${diff}`);
  });
};
