// MCP cases of «canal3d»: the 3D Channel effects on EXR footage (Z depth, object ID, normals written by the test)
// and on Cinta's own 3D render (an adjustment layer over 3D layers at two depths), and the Refine mattes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export default async ({ test, call, assert, imgOf, W, root }) => {
  const P = W('canal3d.cinta');
  const { exr } = createRequire(import.meta.url)(join(root, 'dist', 'core', 'index.js'));
  const frame = async (comp, t = 0, width) => { const r = await call('comp_frame', { project: P, comp, time: t, width }); assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`); return imgOf(r); };

  await test('canal3d: Extraer Canal 3D, Mate de profundidad, Niebla 3D, ID de mate y Profundidad de campo leen los canales EXR', async () => {
    await call('project_new', { path: P, width: 80, height: 40, fps: 10, overwrite: true });
    // 80×40: red on the left half, blue on the right; Z = 10 × x; object 1 / 2; normals facing the viewer
    const EW = 80, EH = 40, F = () => new Float32Array(EW * EH);
    const R = F(), G = F(), B = F(), A = F(), Z = F(), NX = F(), NY = F(), NZ = F(), oid = new Uint32Array(EW * EH);
    for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) { const i = y * EW + x, left = x < 40; R[i] = left ? 1 : 0; B[i] = left ? 0 : 1; A[i] = 1; Z[i] = x * 10; oid[i] = left ? 1 : 2; NZ[i] = 1; }
    mkdirSync(W('canal3d'), { recursive: true });
    const file = W('canal3d/render.exr');
    writeFileSync(file, exr.writeExr(EW, EH, [{ name: 'R', type: 2, data: R }, { name: 'G', type: 2, data: G }, { name: 'B', type: 2, data: B }, { name: 'A', type: 2, data: A }, { name: 'depth.Z', type: 2, data: Z },
      { name: 'objectId', type: 0, data: oid }, { name: 'N.X', type: 2, data: NX }, { name: 'N.Y', type: 2, data: NY }, { name: 'N.Z', type: 2, data: NZ }], { compression: 3 }));
    const im = await call('exr_import', { project: P, path: file });
    await call('comp_new', { project: P, name: 'X', width: 80, height: 40, fps: 10, duration: 1, bg: '#000000' });
    const l = (await call('layer_add', { project: P, comp: 'X', type: 'image', media_id: im.media.id })).layer.id;
    const at = async (x) => (await frame('X', 0, 80)).at(x / 80, 0.5);
    const with1 = async (effect, values, fn) => { const f = (await call('effect_add', { project: P, comp: 'X', layer: l, effect, values })).effect.id; try { await fn(f); } finally { await call('effect_remove', { project: P, comp: 'X', layer: l, effect: f }); } };
    // Z depth between black 0 and white 800 (x = 60 → 600 / 800); inverted; normals (0, 0, 1) → (128, 128, 255)
    await with1('channel3dExtract', { blackPoint: 0, whitePoint: 800 }, async (f) => {
      const v = await at(60.5);
      assert(Math.abs(v[0] - (600 / 800) * 255) < 5 && v[0] === v[2], `Profundidad-Z: ${v} (≈ ${Math.round(0.75 * 255)})`);
      await call('effect_set', { project: P, comp: 'X', layer: l, effect: f, values: { invert: 1 } });
      const iv = await at(60.5);
      assert(Math.abs(iv[0] - 0.25 * 255) < 5, `invertido: ${iv}`);
      await call('effect_set', { project: P, comp: 'X', layer: l, effect: f, values: { channel: 'normals', invert: 0 } });
      const nv = await at(20);
      assert(Math.abs(nv[0] - 128) < 4 && Math.abs(nv[1] - 128) < 4 && nv[2] > 250, `Superficie normal: ${nv}`);
      await call('effect_set', { project: P, comp: 'X', layer: l, effect: f, values: { channel: 'objectId' } });
      const a = await at(20), b = await at(60);
      assert(Math.abs(a[0] - 128) < 4 && b[0] > 250, `ID del objeto (1 y 2 de 2): ${a} / ${b}`);
    });
    // Depth Matte at 400: the nearer left half goes (black background), the right stays; Invert swaps them
    await with1('depthMatte', { depth: 400 }, async (f) => {
      const a = await at(20), b = await at(60);
      assert(a[0] < 10 && b[2] > 240, `Mate de profundidad: ${a} / ${b}`);
      await call('effect_set', { project: P, comp: 'X', layer: l, effect: f, values: { invert: 1 } });
      const ia = await at(20), ib = await at(60);
      assert(ia[0] > 240 && ib[2] < 10, `invertido: ${ia} / ${ib}`);
    });
    // Fog 3D from 0 to 790: more fog farther away; start = end (its default) leaves the layer
    await with1('fog3d', {}, async () => { const a = await at(20); assert(a[0] > 240 && a[1] < 10, `Niebla 3D por defecto: ${a}`); });
    await with1('fog3d', { start: 0, end: 790 }, async () => {
      const near = await at(5), far = await at(75);
      assert(near[1] < 60 && far[1] > 150 && far[1] > near[1] + 90, `Niebla 3D: cerca ${near}, lejos ${far}`);
    });
    // ID Matte: object 2 only
    await with1('idMatte', { id: 2 }, async () => { const a = await at(20), b = await at(60); assert(a[0] < 10 && b[2] > 240, `ID de mate: ${a} / ${b}`); });
    // Depth of Field: with the focal plane on the colour edge (Z 400) it stays sharp; focused at 0 it blurs
    const edge = async (vals) => { let v; await with1('depthOfField', vals, async () => { v = await at(41.5); }); return v; };
    const sharp = await edge({ focalPlane: 400, maxRadius: 16 }), soft = await edge({ focalPlane: 0, maxRadius: 16 });
    assert(sharp[0] < 20 && soft[0] > 40, `Profundidad de campo: enfocado ${sharp}, desenfocado ${soft}`);
  });

  await test('canal3d: en una capa de ajuste, los efectos leen la profundidad e ID del render 3D de la composición', async () => {
    // default camera (zoom 278 at 200 px wide): a red 3D square at z = 0 in front of a green 3D plane at z = 500
    await call('comp_new', { project: P, name: 'C', width: 200, height: 200, fps: 10, duration: 1, bg: '#000000' });
    const back = (await call('layer_add', { project: P, comp: 'C', type: 'solid', color: '#00ff00', width: 1000, height: 1000, position: [100, 100, 500] })).layer.id;
    const front = (await call('layer_add', { project: P, comp: 'C', type: 'solid', color: '#ff0000', width: 60, height: 60, position: [100, 100, 0] })).layer.id;
    for (const id of [back, front]) await call('layer_set', { project: P, comp: 'C', layer: id, three_d: true });
    const adj = (await call('layer_add', { project: P, comp: 'C', type: 'adjustment', width: 200, height: 200 })).layer.id;
    const add = async (effect, values) => (await call('effect_add', { project: P, comp: 'C', layer: adj, effect, values })).effect.id;
    const rm = (f) => call('effect_remove', { project: P, comp: 'C', layer: adj, effect: f });
    const at = async (x, y) => (await frame('C', 0, 200)).at(x / 200, y / 200);
    const base = [await at(100, 100), await at(20, 20)];
    assert(base[0][0] > 240 && base[1][1] > 240, `escena: ${base}`);
    // depth as grey (0…1000): front 278, back 778
    let f = await add('channel3dExtract', { blackPoint: 0, whitePoint: 1000 });
    const zf = await at(100, 100), zb = await at(20, 20);
    assert(Math.abs(zf[0] - 0.278 * 255) < 6 && Math.abs(zb[0] - 0.778 * 255) < 6, `profundidad de la comp.: ${zf} / ${zb}`);
    await rm(f);
    // Depth Matte at 500: the nearer red square goes, the green plane stays
    f = await add('depthMatte', { depth: 500 });
    const dm = [await at(100, 100), await at(20, 20)];
    assert(dm[0][0] < 20 && dm[1][1] > 240, `Mate de profundidad en la comp.: ${dm}`);
    await rm(f);
    // Fog 3D 300 → 800: the back plane fogged white, the front square clear
    f = await add('fog3d', { start: 300, end: 800 });
    const fg = [await at(100, 100), await at(20, 20)];
    assert(fg[0][1] < 30 && fg[1][0] > 150, `Niebla 3D en la comp.: ${fg}`);
    await rm(f);
    // ID Matte: layer 2 (the red square; the adjustment layer is layer 1)
    f = await add('idMatte', { id: 2 });
    const im = [await at(100, 100), await at(20, 20)];
    assert(im[0][0] > 240 && im[1][1] < 20, `ID de mate en la comp.: ${im}`);
    await rm(f);
  });

  await test('canal3d: Perfeccionar mate fuerte y suave (calado, retraer, desplazar borde, ver región, depurar)', async () => {
    await call('comp_new', { project: P, name: 'M', width: 200, height: 200, fps: 10, duration: 1, bg: '#000000' });
    const l = (await call('layer_add', { project: P, comp: 'M', type: 'solid', color: '#ffffff', width: 200, height: 200 })).layer.id;
    await call('mask_add', { project: P, comp: 'M', layer: l, shape: 'path', path: [50, 50, 150, 50, 150, 150, 50, 150], mode: 'add', name: 'M' });
    const at = async (x, y) => (await frame('M', 0, 200)).at(x / 200, y / 200)[0];
    const add = async (effect, values) => (await call('effect_add', { project: P, comp: 'M', layer: l, effect, values })).effect.id;
    const rm = (f) => call('effect_remove', { project: P, comp: 'M', layer: l, effect: f });
    assert((await at(52, 100)) > 240 && (await at(46, 100)) < 10, 'cuadrado de 100 px');
    // Choke 100 %: the edge moves 10 px in
    let f = await add('refineHardMatte', { choke: 100, decontaminate: 0 });
    assert((await at(55, 100)) < 20 && (await at(65, 100)) > 240, 'Retraer');
    await rm(f);
    // Feather 100 %: a soft ramp across the edge
    f = await add('refineHardMatte', { feather: 100 });
    const e = await at(50, 100);
    assert(e > 60 && e < 200 && (await at(100, 100)) > 240, `Calado: ${e}`);
    await rm(f);
    // Shift Edge +100 %: the edge grows outwards (white: decontamination keeps the solid colour)
    f = await add('refineSoftMatte', { shiftEdge: 100, edgeDetails: 0 });
    assert((await at(47, 100)) > 200, 'Desplazamiento de borde');
    await rm(f);
    // View Edge Region: an opaque grey image with the band (yellowish) round the edge
    f = await add('refineSoftMatte', { viewEdge: 1 });
    const out = await frame('M', 0, 200), band = out.at(50 / 200, 0.5), inside = out.at(0.5, 0.5), outside = out.at(10 / 200, 0.5);
    assert(inside[0] > 240 && outside[0] < 10 && band[2] < 60 && band[0] > 100, `Ver región de borde: ${band} / ${inside} / ${outside}`);
    await rm(f);
    // a mask moving 100 px/s right: Use Motion Blur spreads its edges over the shutter (180° at 10 fps: 5 px),
    // Reduce Chatter averages the edge with the frames before and after
    const mk = await call('mask_add', { project: P, comp: 'M', layer: l, shape: 'path', path: [20, 160, 80, 160, 80, 190, 20, 190], mode: 'add', name: 'Mov' });
    const mid = mk.mask?.id ?? mk.id;
    await call('prop_set', { project: P, comp: 'M', layer: l, path: `masks.${mid}.path`, keys: [0, 100].map((dx, i) => ({ t: i, v: [20, 160, 80, 160, 80, 190, 20, 190].flatMap((q, k) => (k % 2 ? [q, 0, 0, 0, 0] : [q + dx])) })) });
    const sharpE = await (async () => { const im = await frame('M', 0.5, 200); return im.at(129 / 200, 175 / 200)[0]; })();
    f = await add('refineHardMatte', { useMotionBlur: 1, decontaminate: 0 });
    const blurE = (await frame('M', 0.5, 200)).at(129 / 200, 175 / 200)[0];
    assert(sharpE > 240 && blurE > 40 && blurE < 225, `desenfoque de movimiento del mate: ${sharpE} → ${blurE}`);
    await call('effect_set', { project: P, comp: 'M', layer: l, effect: f, values: { useMotionBlur: 0, reduceChatter: 100 } });
    const chat = (await frame('M', 0.5, 200)).at(129 / 200, 175 / 200)[0];
    assert(chat > 40 && chat < 225, `reducir inestabilidad: ${chat}`);
    await rm(f);
  });
};
