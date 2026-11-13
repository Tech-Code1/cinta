// MCP cases of extruded 3D text and shapes (After Effects «Opciones de geometría»): geometry_set / prop_set /
// comp_get, the side face of a rotated extruded letter in the side colour where the camera projects it, depth 0
// drawing exactly as before, a shape's hole kept, and extruded text crossing a 3D plane per pixel.
import { cpSync } from 'node:fs';

export default async ({ test, call, assert, imgOf, isColor, W }) => {
  // CINTA_KEEP=<folder>: keep the frames to look at
  const keep = () => { if (process.env.CINTA_KEEP) for (let i = 1; i <= shot; i++) cpSync(W(`extrusion_${i}.png`), `${process.env.CINTA_KEEP}/extrusion_${i}.png`); };
  const MP = W('extrusion.cinta');
  const CW = 400, CH = 300;
  let shot = 0;
  const frame = async (t = 0, comp = 'E') => imgOf(await call('comp_frame', { project: MP, comp, time: t, width: CW, output: W(`extrusion_${++shot}.png`) }));
  const px = (img, x, y) => img.at(x / CW, y / CH);
  const bboxOf = (img, f) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const p = img.at((x + 0.5) / img.width, (y + 0.5) / img.height); if (f(p)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); } }
    return [x0, y0, x1, y1];
  };
  const count = (img, f, x0, y0, x1, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (f(px(img, x + 0.5, y + 0.5))) n++; return n; };
  const white = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;
  const red = (p) => p[0] > 160 && p[1] < 80 && p[2] < 80;
  const blue = (p) => p[2] > 160 && p[0] < 80 && p[1] < 80;
  const green = (p) => p[1] > 160 && p[0] < 80 && p[2] < 80;
  // After Effects' default camera (50 mm) projection of a comp point
  const zoom = Math.round((CW / 2) / Math.tan((39.6 / 2) * (Math.PI / 180)));
  const proj = (x, y, z) => [CW / 2 + (zoom * (x - CW / 2)) / (z + zoom), CH / 2 + (zoom * (y - CH / 2)) / (z + zoom)];
  let txt;

  await test('extrusion: geometry_set en un texto 3D: valores de AE, comp_get los muestra, prop_set geometry.* anima', async () => {
    await call('project_new', { path: MP, width: CW, height: CH, fps: 30 });
    await call('comp_new', { project: MP, name: 'E', width: CW, height: CH, fps: 30, duration: 2, bg: '#000000' });
    const l = await call('layer_add', { project: MP, comp: 'E', type: 'text', text: 'I', size: 200, font: 'Arial', color: '#ffffff' });
    txt = l.layer.id;
    await call('layer_set', { project: MP, comp: 'E', layer: txt, text_style: { weight: 700 } });
    const r = await call('geometry_set', { project: MP, comp: 'E', layer: txt, three_d: true });
    assert(r.layer.threeD && r.geometry.bevelStyle === 'none' && r.geometry.bevelDepth === 2 && r.geometry.holeBevelDepth === 100 && r.geometry.extrusionDepth === 0 && !r.geometry.extruded, JSON.stringify(r.geometry));
    await call('prop_set', { project: MP, comp: 'E', layer: txt, path: 'geometry.extrusionDepth', keys: [{ t: 0, v: 0 }, { t: 1, v: 80 }] });
    const g = await call('comp_get', { project: MP, comp: 'E' });
    const gl = g.comp.layers.find((x) => x.id === txt);
    assert(gl.geometry?.extrusionDepth === '2 claves' && gl.geometry.extruded, JSON.stringify(gl.geometry));
    await call('prop_set', { project: MP, comp: 'E', layer: txt, path: 'geometry.extrusionDepth', keys: [] }).catch(() => {});
  });

  await test('extrusion: profundidad 0 y sin bisel se dibuja exactamente como antes (texto 3D y forma 2D)', async () => {
    await call('prop_set', { project: MP, comp: 'E', layer: txt, path: 'geometry.extrusionDepth', value: 0 });
    await call('prop_set', { project: MP, comp: 'E', layer: txt, path: 'rotationY', value: 30 });
    const a = await frame();
    // the same layer without any geometry options (an old project)
    const b0 = await call('comp_get', { project: MP, comp: 'E' });
    await call('layer_set', { project: MP, comp: 'E', layer: txt, three_d: false });
    await call('layer_set', { project: MP, comp: 'E', layer: txt, three_d: true });
    const plain = await frame();
    let diff = 0;
    for (let y = 0; y < CH; y += 2) for (let x = 0; x < CW; x += 2) { const p = px(a, x, y), q = px(plain, x, y); diff = Math.max(diff, Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])); }
    assert(diff === 0 && b0.comp.layers.find((x) => x.id === txt).geometry.extruded === false, `diferencia ${diff}`);
    // a bevel style with depth 0 on a 2D layer: still flat
    await call('geometry_set', { project: MP, comp: 'E', layer: txt, bevel_style: 'angular', three_d: false });
    const flat2d = await frame();
    let d2 = 0;
    await call('geometry_set', { project: MP, comp: 'E', layer: txt, bevel_style: 'none', three_d: true });
    await call('layer_set', { project: MP, comp: 'E', layer: txt, three_d: false });
    const ref2d = await frame();
    for (let y = 0; y < CH; y += 2) for (let x = 0; x < CW; x += 2) { const p = px(flat2d, x, y), q = px(ref2d, x, y); d2 = Math.max(d2, Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])); }
    assert(d2 === 0, `2D ${d2}`);
    await call('layer_set', { project: MP, comp: 'E', layer: txt, three_d: true });
    await call('prop_set', { project: MP, comp: 'E', layer: txt, path: 'rotationY', value: 0 });
  });

  await test('extrusion: «I» extruido 80 px y girado 60° en Y: su lateral (Color lateral rojo) aparece donde lo proyecta la cámara', async () => {
    // the flat letter seen from the front: its right edge in layer px
    const f0 = await frame();
    const [x0, y0, x1, y1] = bboxOf(f0, white);
    assert(Number.isFinite(x0) && x1 - x0 > 20, `letra ${[x0, y0, x1, y1]}`);
    const xr = x1 - CW / 2, ym = (y0 + y1) / 2;
    await call('geometry_set', { project: MP, comp: 'E', layer: txt, extrusion_depth: 80, side_color: '#ff0000' });
    await call('layer_set', { project: MP, comp: 'E', layer: txt, material: { accepts_lights: false } });
    // straight on: the front face covers the sides (still the same letter, white)
    const f1 = await frame();
    const b1 = bboxOf(f1, white);
    assert(Math.abs(b1[0] - x0) <= 1 && Math.abs(b1[2] - x1) <= 1, `de frente ${b1} vs ${[x0, y0, x1, y1]}`);
    await call('prop_set', { project: MP, comp: 'E', layer: txt, path: 'rotationY', value: 60 });
    const f2 = await frame();
    // a layer point (x, y, z) after Y 60°: X = cx + cos·x + sin·z, Z = −sin·x + cos·z
    const c = Math.cos(Math.PI / 3), s = Math.sin(Math.PI / 3);
    const at = (lx, lz) => proj(CW / 2 + c * lx + s * lz, ym, -s * lx + c * lz);
    const mid = at(xr, 40), front = at(xr - 6, 0);
    const pm = px(f2, mid[0], mid[1]), pf = px(f2, front[0], front[1]);
    assert(red(pm), `lateral en ${mid.map(Math.round)}: ${pm}`);
    assert(white(pf), `frontal en ${front.map(Math.round)}: ${pf}`);
    // the red side spans from the front edge to the back edge's projection
    const reds = bboxOf(f2, red), back = at(xr, 80), edge = at(xr, 0);
    assert(Math.abs(reds[0] - Math.min(edge[0], back[0])) <= 3 && Math.abs(reds[2] - Math.max(edge[0], back[0])) <= 3, `rojo ${reds} vs ${edge[0]}–${back[0]}`);
    // comp_get: the colour and the depth
    const g = await call('comp_get', { project: MP, comp: 'E' });
    const gg = g.comp.layers.find((x) => x.id === txt).geometry;
    assert(gg.extrusionDepth === 80 && gg.sideColor === '#ff0000' && gg.extruded, JSON.stringify(gg));
  });

  await test('extrusion: bisel convexo y animador «Lateral ▸ Color» por carácter; lit by a light', async () => {
    await call('geometry_set', { project: MP, comp: 'E', layer: txt, bevel_style: 'convex', bevel_depth: 6, side_color: null, bevel_color: '#0000ff' });
    const f = await frame();
    assert(count(f, blue, 0, 0, CW, CH) > 30, 'bisel azul');
    // without a side colour the side is the fill (white) — then an animator turns it green
    await call('text_animator_add', { project: MP, comp: 'E', layer: txt, props: { sideColor: '#00ff00' } });
    const g = await frame();
    assert(count(g, green, 0, 0, CW, CH) > 100, 'lateral verde por el animador');
    // lit by a parallel light from the left: the side facing it is brighter than with the light behind
    await call('layer_set', { project: MP, comp: 'E', layer: txt, material: { accepts_lights: true } });
    const lt = await call('layer_add', { project: MP, comp: 'E', type: 'light', light_type: 'parallel' });
    await call('prop_set', { project: MP, comp: 'E', layer: lt.layer.id, path: 'position', value: [-800, 150, -300] });
    await call('prop_set', { project: MP, comp: 'E', layer: lt.layer.id, path: 'light.poi', value: [200, 150, 0] });
    const lit = await frame();
    await call('prop_set', { project: MP, comp: 'E', layer: lt.layer.id, path: 'position', value: [1200, 150, 600] });
    const dark = await frame();
    const sum = (img) => { let t = 0; for (let y = 0; y < CH; y += 2) for (let x = 0; x < CW; x += 2) { const p = px(img, x, y); t += p[1]; } return t; };
    assert(sum(lit) > sum(dark) * 1.2, `luz ${sum(lit)} vs ${sum(dark)}`);
    await call('layer_delete', { project: MP, comp: 'E', layers: [lt.layer.id] });
    await call('layer_set', { project: MP, comp: 'E', layer: txt, hidden: true });
  });

  await test('extrusion: una forma con un hueco (combinar trazados: restar) extruida conserva el hueco', async () => {
    const a = await call('shape_add', { project: MP, comp: 'E', kind: 'rect', width: 200, height: 200, color: '#00ff00', name: 'Marco' });
    const sl = a.layer.id;
    await call('shape_add', { project: MP, comp: 'E', layer: sl, kind: 'rect', width: 80, height: 80, color: '#00ff00' });
    await call('shape_add', { project: MP, comp: 'E', layer: sl, kind: 'merge', merge_mode: 'subtract', color: '#00ff00' });
    const flat = await frame();
    assert(isColor(px(flat, 200, 150), [0, 0, 0], 30) && green(px(flat, 200 - 70, 150)), 'el hueco plano');
    await call('geometry_set', { project: MP, comp: 'E', layer: sl, three_d: true, extrusion_depth: 60, bevel_style: 'angular', bevel_depth: 4, side_color: '#ff0000' });
    await call('layer_set', { project: MP, comp: 'E', layer: sl, material: { accepts_lights: false } });
    await call('prop_set', { project: MP, comp: 'E', layer: sl, path: 'rotationX', value: 20 });
    const f = await frame();
    assert(isColor(px(f, 200, 150), [0, 0, 0], 30), `hueco ${px(f, 200, 150)}`);
    assert(green(px(f, 200 - 70, 150)) && green(px(f, 200 + 70, 150)), 'el marco');
    // tilted: the hole's inner wall (red) shows
    assert(count(f, red, 150, 100, 250, 200) > 20, 'pared interior del hueco');
    await call('layer_set', { project: MP, comp: 'E', layer: sl, hidden: true });
  });

  await test('extrusion: un trazo se extruye como su anillo (elipse sin relleno)', async () => {
    const a = await call('shape_add', { project: MP, comp: 'E', kind: 'ellipse', width: 160, height: 160, color: null, stroke: '#ffffff', stroke_width: 16 });
    await call('geometry_set', { project: MP, comp: 'E', layer: a.layer.id, three_d: true, extrusion_depth: 30 });
    await call('layer_set', { project: MP, comp: 'E', layer: a.layer.id, material: { accepts_lights: false } });
    const f = await frame();
    assert(white(px(f, 200 + 80, 150)) && isColor(px(f, 200, 150), [0, 0, 0], 30) && isColor(px(f, 200 + 100, 150), [0, 0, 0], 30), 'anillo');
    await call('layer_delete', { project: MP, comp: 'E', layers: [a.layer.id] });
  });

  await test('extrusion: texto extruido y un plano 3D girado se cortan por píxel', async () => {
    await call('layer_set', { project: MP, comp: 'E', layer: txt, hidden: false });
    await call('prop_set', { project: MP, comp: 'E', layer: txt, path: 'rotationY', value: 0 });
    await call('prop_set', { project: MP, comp: 'E', layer: txt, path: 'text.text', value: 'HHHH' });
    await call('prop_set', { project: MP, comp: 'E', layer: txt, path: 'text.size', value: 150 });
    await call('geometry_set', { project: MP, comp: 'E', layer: txt, bevel_style: 'none', extrusion_depth: 40, side_color: '#ffffff', bevel_color: null });
    const an = (await call('comp_get', { project: MP, comp: 'E' })).comp.layers.find((x) => x.id === txt).animators;
    for (const a of an ?? []) await call('text_animator_remove', { project: MP, comp: 'E', layer: txt, animator: a.id }).catch(() => {});
    const s2 = await call('layer_add', { project: MP, comp: 'E', type: 'solid', color: '#0000ff', width: 400, height: 40 });
    await call('layer_set', { project: MP, comp: 'E', layer: s2.layer.id, three_d: true });
    await call('prop_set', { project: MP, comp: 'E', layer: s2.layer.id, path: 'position', value: [200, 110, 0] });
    await call('prop_set', { project: MP, comp: 'E', layer: s2.layer.id, path: 'rotationY', value: 60 });
    const f = await frame();
    // left of the crossing the plane is behind the letters (white shows), right of it in front (only blue)
    const lw = count(f, white, 120, 95, 195, 125), rw = count(f, white, 206, 95, 280, 125), rb = count(f, blue, 206, 95, 280, 125), lb = count(f, blue, 120, 95, 195, 125);
    assert(lw > 40 && lb > 10, `izquierda: blanco ${lw}, azul ${lb}`);
    assert(rw < 5 && rb > 200, `derecha: blanco ${rw}, azul ${rb}`);
  });
  keep();
};
