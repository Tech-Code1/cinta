// MCP cases of «capas»: guide layers are never rendered (nor nested, nor in Lottie), crop comp to the work area /
// region of interest, protected regions of a nested time-stretched comp keep their speed (pixels), a duration change
// keeps them, RotoBezier rounds a square mask, feather points soften one side, Wiggle Transform moves the shape.
import { readFileSync } from 'node:fs';

export default async ({ test, call, callErr, assert, imgOf, near, W }) => {
  const CP = W('capas.cinta');
  const frame = async (comp, time, width = 200) => imgOf(await call('comp_frame', { project: CP, comp, time, width }));
  /** x of the centre of the white pixels on row fy (fraction of the height) */
  const whiteX = (im, w, fy = 0.5) => { let s = 0, n = 0; for (let x = 0; x < w; x++) { const p = im.at((x + 0.5) / w, fy); if (p[0] > 200 && p[1] > 200) { s += x; n++; } } return n ? s / n : -1; };

  await test('capas: proyecto propio', async () => { await call('project_new', { path: CP, width: 640, height: 360, fps: 10 }); });

  await test('capas: una capa de guía no se procesa, ni anidada, ni en Lottie; al quitarla vuelve a verse', async () => {
    await call('comp_new', { project: CP, name: 'Guia', width: 200, height: 100, fps: 10, duration: 1, bg: '#000000' });
    const g = (await call('layer_add', { project: CP, comp: 'Guia', type: 'solid', color: '#ffffff', width: 60, height: 60, position: [100, 50] })).layer.id;
    const r = await call('layer_guide', { project: CP, comp: 'Guia', layers: [g] });
    assert(r.guide === true, JSON.stringify(r));
    const get = await call('comp_get', { project: CP, comp: 'Guia' });
    assert(get.comp.layers[0].guide === true, 'comp_get muestra guide');
    assert(near((await frame('Guia', 0)).at(0.5, 0.5)[0], 0, 5), 'no se procesa');
    await call('comp_new', { project: CP, name: 'GuiaPadre', width: 200, height: 100, fps: 10, duration: 1, bg: '#000000' });
    await call('layer_add', { project: CP, comp: 'GuiaPadre', type: 'comp', comp_id: 'Guia' });
    assert(near((await frame('GuiaPadre', 0)).at(0.5, 0.5)[0], 0, 5), 'no se ve anidada');
    const lot = await call('comp_export_lottie', { project: CP, comp: 'Guia', output: W('guia.json') });
    assert(lot.layers === 0 && JSON.parse(readFileSync(lot.file, 'utf8')).layers.length === 0, `Lottie ${lot.layers}`);
    await call('layer_guide', { project: CP, comp: 'Guia', layers: [g], guide: false });
    assert((await frame('Guia', 0)).at(0.5, 0.5)[0] > 240, 'visible otra vez');
  });

  await test('capas: comp_crop work_area (Ctrl+Mayús+X) y roi; comp_roi no cambia el render', async () => {
    await call('comp_new', { project: CP, name: 'Recorte', width: 400, height: 200, fps: 10, duration: 10, bg: '#000000' });
    const s = (await call('layer_add', { project: CP, comp: 'Recorte', type: 'solid', color: '#ffffff', width: 40, height: 40, position: [300, 150] })).layer.id;
    await call('prop_set', { project: CP, comp: 'Recorte', layer: s, path: 'opacity', keys: [{ t: 4, v: 0 }, { t: 6, v: 100 }] });
    await call('comp_set', { project: CP, comp: 'Recorte', work_area: [4, 8] });
    const w = await call('comp_crop', { project: CP, comp: 'Recorte', to: 'work_area' });
    assert(w.comp.duration === 4 && w.comp.workArea.join() === '0,4', JSON.stringify(w.comp));
    const g = await call('comp_get', { project: CP, comp: 'Recorte' });
    assert(g.comp.layers[0].animated['transform.opacity'], `claves conservadas ${JSON.stringify(g.comp.layers[0].animated)}`);
    const roi = await call('comp_roi', { project: CP, comp: 'Recorte', roi: [200, 100, 200, 100] });
    assert(roi.roi.on && roi.roi.rect.join() === '200,100,200,100', JSON.stringify(roi));
    // the region of interest is only for the window's previews: renders draw the whole comp
    const full = await frame('Recorte', 3, 400);
    assert(full.at(0.75, 0.75)[0] > 240 && near(full.at(0.1, 0.1)[0], 0, 5), 'render completo');
    const c = await call('comp_crop', { project: CP, comp: 'Recorte', to: 'roi' });
    assert(c.comp.width === 200 && c.comp.height === 100, JSON.stringify(c.comp));
    // the square (centre 300, 150) is now at the centre of the 200×100 comp
    assert((await frame('Recorte', 3, 200)).at(0.5, 0.5)[0] > 240, 'capa en su sitio');
    const e = await callErr('comp_crop', { project: CP, comp: 'Recorte', to: 'roi' });
    assert(/región de interés/.test(e), e);
  });

  await test('capas: zonas protegidas — la intro de una comp. anidada estirada al 200 % conserva su velocidad', async () => {
    await call('comp_new', { project: CP, name: 'Sub', width: 200, height: 100, fps: 10, duration: 4, bg: '#000000' });
    const s = (await call('layer_add', { project: CP, comp: 'Sub', type: 'solid', color: '#ffffff', width: 10, height: 10, position: [10, 50] })).layer.id;
    await call('prop_set', { project: CP, comp: 'Sub', layer: s, path: 'position', keys: [{ t: 0, v: [10, 50] }, { t: 4, v: [170, 50] }] });
    const r = await call('responsive_time', { project: CP, comp: 'Sub', action: 'intro', time: 1 });
    assert(r.created[0].protected && r.created[0].dur === 1, JSON.stringify(r));
    await call('comp_new', { project: CP, name: 'Padre', width: 200, height: 100, fps: 10, duration: 10, bg: '#000000' });
    const l = (await call('layer_add', { project: CP, comp: 'Padre', type: 'comp', comp_id: 'Sub' })).layer.id;
    await call('layer_set', { project: CP, comp: 'Padre', layer: l, stretch: 2, out: 8 });
    // intro (protected): source time = parent time → x = 10 + 40 t
    const x05 = whiteX(await frame('Padre', 0.5), 200);
    assert(Math.abs(x05 - 30) < 3, `intro x ${x05} (sin protección sería 20)`);
    // the rest (3 s of the sub comp) fills 7 s: at parent t = 5, source 1 + 4·3/7
    const x5 = whiteX(await frame('Padre', 5), 200), want = 10 + 40 * (1 + 4 * 3 / 7);
    assert(Math.abs(x5 - want) < 3, `centro x ${x5}, esperado ${want.toFixed(1)}`);
    // the marker can be switched off: plain 200 % stretch again
    await call('comp_marker', { project: CP, comp: 'Sub', action: 'set', index: 0, protected: false });
    const x05b = whiteX(await frame('Padre', 0.5), 200);
    assert(Math.abs(x05b - 20) < 3, `sin protección x ${x05b}`);
    const list = await call('comp_marker', { project: CP, comp: 'Sub', action: 'list' });
    assert(list.markers.length === 1 && !list.markers[0].protected, JSON.stringify(list));
  });

  await test('capas: cambiar la duración conserva intro y outro protegidas (claves alrededor)', async () => {
    await call('comp_new', { project: CP, name: 'Dur', width: 100, height: 100, fps: 10, duration: 10, bg: '#000000' });
    const s = (await call('layer_add', { project: CP, comp: 'Dur', type: 'solid', color: '#ffffff' })).layer.id;
    await call('prop_set', { project: CP, comp: 'Dur', layer: s, path: 'opacity', keys: [{ t: 1, v: 0 }, { t: 9, v: 100 }] });
    await call('responsive_time', { project: CP, comp: 'Dur', action: 'intro', time: 2 });
    await call('responsive_time', { project: CP, comp: 'Dur', action: 'outro', time: 8 });
    await call('comp_set', { project: CP, comp: 'Dur', duration: 20 });
    const m = (await call('comp_marker', { project: CP, comp: 'Dur', action: 'list' })).markers;
    assert(m.map((x) => `${x.t}+${x.dur}`).join() === '0+2,18+2', JSON.stringify(m));
    // the last key (9 s, inside the outro) is 1 s before the end: 19 s; at 19 s the layer is fully opaque
    assert((await frame('Dur', 19.05, 100)).at(0.5, 0.5)[0] > 240, 'clave final en 19 s');
    assert((await frame('Dur', 1, 100)).at(0.5, 0.5)[0] < 10, 'clave inicial en 1 s');
  });

  await test('capas: RotoBézier redondea una máscara cuadrada; un punto de calado suaviza solo su lado', async () => {
    await call('comp_new', { project: CP, name: 'Mascara', width: 200, height: 200, fps: 10, duration: 1, bg: '#000000' });
    const s = (await call('layer_add', { project: CP, comp: 'Mascara', type: 'solid', color: '#ffffff', width: 200, height: 200 })).layer.id;
    const m = (await call('mask_add', { project: CP, comp: 'Mascara', layer: s, shape: 'rect', x: 40, y: 40, width: 120, height: 120 })).mask.id;
    const before = await frame('Mascara', 0);
    assert(before.at(0.215, 0.215)[0] > 240 && before.at(0.5, 0.15)[0] < 15, 'cuadrado');
    const r = await call('mask_options', { project: CP, comp: 'Mascara', layer: s, mask: m, roto_bezier: true });
    assert(r.mask.rotoBezier, JSON.stringify(r));
    const roto = await frame('Mascara', 0);
    // the curve passes through the vertices (corners stay) and bulges past the edge midpoints (y 25 at 33 %)
    assert(roto.at(0.215, 0.215)[0] > 240 && roto.at(0.5, 0.5)[0] > 240, `vértice ${roto.at(0.215, 0.215)}`);
    assert(roto.at(0.5, 0.15)[0] > 200 && roto.at(0.5, 0.1)[0] < 15, `abombada ${roto.at(0.5, 0.15)} ${roto.at(0.5, 0.1)}`);
    assert(roto.at(0.17, 0.17)[0] < 15, `fuera de la esquina ${roto.at(0.17, 0.17)}`);
    await call('mask_options', { project: CP, comp: 'Mascara', layer: s, mask: m, roto_bezier: false });
    // feather point on the top edge, 30 px outward: soft above the top edge, the bottom edge still hard
    const f = await call('mask_options', { project: CP, comp: 'Mascara', layer: s, mask: m, add_feather_point: { segment: 0, t: 0.5, radius: 30 } });
    assert(f.mask.featherPoints.length === 1 && f.mask.featherPoints[0].radius === 30, JSON.stringify(f.mask));
    await call('mask_options', { project: CP, comp: 'Mascara', layer: s, mask: m, add_feather_point: { segment: 2, t: 0.5, radius: 0 } });
    const fe = await frame('Mascara', 0);
    const above = fe.at(0.5, 0.15)[0], below = fe.at(0.5, 0.85)[0];
    assert(above > 40 && above < 230, `calado arriba ${above}`);
    assert(below < 15, `abajo duro ${below}`);
    await call('mask_options', { project: CP, comp: 'Mascara', layer: s, mask: m, feather_points: null });
    assert((await frame('Mascara', 0)).at(0.5, 0.15)[0] < 15, 'sin puntos de calado');
  });

  await test('capas: Transformación de ondulación mueve la forma (determinista) y se quita', async () => {
    await call('comp_new', { project: CP, name: 'Onda', width: 200, height: 100, fps: 10, duration: 4, bg: '#000000' });
    const sh = await call('shape_add', { project: CP, comp: 'Onda', kind: 'rect', width: 20, height: 20, color: '#ffffff' });
    const base = whiteX(await frame('Onda', 1.3), 200);
    const w = await call('shape_operator', { project: CP, comp: 'Onda', layer: sh.layer.id, shape: sh.shape.id, operator: 'wiggle_transform' });
    assert(w.wiggleTransform.speed === 2 && w.wiggleTransform.correlation === 50 && w.wiggleTransform.position.join() === '0,0', JSON.stringify(w));
    assert(Math.abs(whiteX(await frame('Onda', 1.3), 200) - base) < 1, 'sin cantidades no se mueve');
    await call('shape_operator', { project: CP, comp: 'Onda', layer: sh.layer.id, shape: sh.shape.id, operator: 'wiggle_transform', position: [60, 0] });
    const xs = [];
    for (const t of [0.4, 1.3, 2.2, 3.1]) xs.push(whiteX(await frame('Onda', t), 200));
    assert(xs.some((x) => Math.abs(x - base) > 4) && xs.every((x) => Math.abs(x - base) <= 61), `posiciones ${xs.map((x) => x.toFixed(1))}`);
    assert(Math.abs(whiteX(await frame('Onda', 1.3), 200) - xs[1]) < 0.5, 'determinista');
    await call('shape_operator', { project: CP, comp: 'Onda', layer: sh.layer.id, shape: sh.shape.id, operator: 'wiggle_transform', remove: true });
    assert(Math.abs(whiteX(await frame('Onda', 1.3), 200) - base) < 1, 'quitada');
  });
};
