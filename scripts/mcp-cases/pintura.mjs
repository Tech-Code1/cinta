// MCP cases of the paint tools (Brush, Clone Stamp, Eraser on the «Pintura» effect): rendered pixels through comp_frame.
export default async ({ test, call, callErr, assert, imgOf, isColor, W }) => {
  const P = W('pintura.cinta');
  let n = 0;
  /** a 200×100 comp with a blue solid; returns its name and the layer id */
  const setup = async (o = {}) => {
    const comp = `P${++n}`;
    await call('comp_new', { project: P, name: comp, width: 200, height: 100, fps: 30, duration: 2, bg: '#000000' });
    const l = (await call('layer_add', { project: P, comp, type: 'solid', color: o.color ?? '#3366cc', width: 200, height: 100 })).layer.id;
    return { comp, l };
  };
  const frame = async (comp, t = 0) => {
    const r = await call('comp_frame', { project: P, comp, time: t, width: 200 });
    assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`);
    const im = imgOf(r);
    return (x, y) => im.at((x + 0.5) / 200, (y + 0.5) / 100);
  };
  const line = (y = 50) => [[20, y], [60, y], [100, y], [140, y], [180, y]];

  await test('pintura: proyecto propio', async () => { await call('project_new', { path: P, width: 640, height: 360, fps: 30 }); });

  await test('pintura: el Pincel añade el efecto «Pintura» y pinta su color; Dureza 100 % da un borde nítido', async () => {
    const { comp, l } = await setup();
    const r = await call('paint_stroke', { project: P, comp, layer: l, tool: 'brush', points: line(), color: '#ff0000', diameter: 20, hardness: 100 });
    assert(r.stroke.name === 'Pincelar 1', `nombre ${r.stroke.name}`);
    const list = await call('paint_list', { project: P, comp, layer: l });
    assert(list.effect?.name === 'Pintura' && list.strokes.length === 1 && list.strokes[0].diameter === 20 && list.strokes[0].spacing === 25 && list.strokes[0].end === 100, `lista ${JSON.stringify(list).slice(0, 300)}`);
    const px = await frame(comp);
    assert(isColor(px(100, 50), [255, 0, 0], 20) && isColor(px(100, 57), [255, 0, 0], 30), `rojo dentro: ${px(100, 50)} ${px(100, 57)}`);
    assert(isColor(px(100, 30), [0x33, 0x66, 0xcc], 20) && isColor(px(100, 63), [0x33, 0x66, 0xcc], 30), `azul fuera: ${px(100, 30)} ${px(100, 63)}`);
  });

  await test('pintura: Dureza 0 % cae suavemente del centro al borde; opacidad 50 % mezcla', async () => {
    const { comp, l } = await setup({ color: '#000000' });
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'brush', points: [[100, 50]], color: '#ffffff', diameter: 40, hardness: 0 });
    const px = await frame(comp);
    const c = px(100, 50)[0], m = px(110, 50)[0], e = px(118, 50)[0];
    assert(c > 230 && m > 60 && m < 220 && e < 40 && c > m && m > e, `caída: centro ${c}, r=10 ${m}, r=18 ${e}`);
    const k = await setup({ color: '#000000' });
    await call('paint_stroke', { project: P, comp: k.comp, layer: k.l, tool: 'brush', points: [[100, 50]], color: '#ffffff', diameter: 40, hardness: 100, opacity: 50 });
    const q = await frame(k.comp);
    assert(Math.abs(q(100, 50)[0] - 128) < 14, `opacidad 50 %: ${q(100, 50)}`);
  });

  await test('pintura: Borrador (Origen de capa y pintar / Sólo pintar / Sólo último trazo) y deshacer', async () => {
    const { comp, l } = await setup();
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'brush', points: line(), color: '#ff0000', diameter: 30, hardness: 100 });
    // Paint Only: the blue source comes back where the paint was
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'eraser', points: [[40, 50], [80, 50]], diameter: 20, hardness: 100, erase: 'paint' });
    // Layer Source & Paint: transparent (black background)
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'eraser', points: [[130, 50], [150, 50]], diameter: 20, hardness: 100, erase: 'all' });
    let px = await frame(comp);
    assert(isColor(px(60, 50), [0x33, 0x66, 0xcc], 30), `Sólo pintar devuelve el origen: ${px(60, 50)}`);
    assert(isColor(px(140, 50), [0, 0, 0], 20) && isColor(px(140, 20), [0x33, 0x66, 0xcc], 30), `Origen de capa y pintar: ${px(140, 50)} / ${px(140, 20)}`);
    assert(isColor(px(100, 50), [255, 0, 0], 30), `el resto del trazo sigue: ${px(100, 50)}`);
    // Last Stroke Only: a new green stroke, erased only where it is (the red under it stays)
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'brush', points: [[100, 30], [100, 70]], color: '#00ff00', diameter: 16, hardness: 100 });
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'eraser', points: [[90, 50], [110, 50]], diameter: 14, hardness: 100, erase: 'last' });
    px = await frame(comp);
    assert(isColor(px(100, 50), [255, 0, 0], 30) && isColor(px(100, 34), [0, 255, 0], 30), `Sólo último trazo: ${px(100, 50)} / ${px(100, 34)}`);
    const list = await call('paint_list', { project: P, comp, layer: l });
    assert(list.strokes.map((s) => s.name).join() === 'Pincelar 1,Borrador 1,Borrador 2,Pincelar 2,Borrador 3' && list.strokes[4].target === list.strokes[3].id, `nombres ${list.strokes.map((s) => s.name)}`);
    await call('undo', { project: P });
    assert((await call('paint_list', { project: P, comp, layer: l })).strokes.length === 4, 'deshacer quita el último trazo');
    // delete a stroke and reorder
    await call('paint_edit', { project: P, comp, layer: l, stroke: 'Pincelar 2', delete: true });
    await call('paint_edit', { project: P, comp, layer: l, stroke: 'Pincelar 1', index: 3 });
    const l2 = await call('paint_list', { project: P, comp, layer: l });
    assert(l2.strokes.map((s) => s.name).join() === 'Borrador 1,Borrador 2,Pincelar 1', `orden ${l2.strokes.map((s) => s.name)}`);
    px = await frame(comp);
    assert(isColor(px(60, 50), [255, 0, 0], 30) && isColor(px(140, 50), [255, 0, 0], 30), `el pincel encima de los borradores: ${px(60, 50)} ${px(140, 50)}`);
    const err = await callErr('paint_edit', { project: P, comp, layer: l, stroke: 'Pincelar 9', name: 'x' });
    assert(/No existe el trazo/.test(err), err);
  });

  await test('pintura: Tampón de clonar copia la capa de origen (posición, desplazamiento de tiempo, otra capa)', async () => {
    // a ramp: black on the left, white on the right; the clone at x 30 copies x 170
    const { comp, l } = await setup();
    await call('effect_add', { project: P, comp, layer: l, effect: 'gradientRamp', values: { type: 'linear', start: [0, 50], end: [200, 50], startColor: '#000000', endColor: '#ffffff' } });
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'clone', points: [[30, 50], [30, 60]], diameter: 16, hardness: 100, clone_position: [170, 50] });
    let px = await frame(comp);
    assert(px(30, 52)[0] > 200 && px(30, 30)[0] < 70, `clon de la propia capa: ${px(30, 52)} / ${px(30, 30)}`);
    // another (hidden) layer as source, read at now + 1 s: its colour animates red → green
    const s = (await call('layer_add', { project: P, comp, type: 'solid', color: '#ffffff', width: 200, height: 100 })).layer.id;
    await call('layer_set', { project: P, comp, layer: s, hidden: true });
    await call('effect_add', { project: P, comp, layer: s, effect: 'gradientRamp', values: { startColor: '#ff0000', endColor: '#ff0000' } });
    const fxs = (await call('comp_get', { project: P, comp })).comp.layers.find((x) => x.id === s).effects[0].id;
    for (const k of ['startColor', 'endColor']) await call('prop_set', { project: P, comp, layer: s, path: `effects.${fxs}.${k}`, keys: [{ t: 0, v: '#ff0000', ease: 'hold' }, { t: 1, v: '#00ff00', ease: 'hold' }] });
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'clone', points: [[100, 20], [100, 80]], diameter: 16, hardness: 100, clone_source: s, clone_offset: [0, 0] });
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'clone', points: [[150, 20], [150, 80]], diameter: 16, hardness: 100, clone_source: s, clone_offset: [0, 0], clone_time_shift: 1 });
    px = await frame(comp, 0);
    assert(isColor(px(100, 50), [255, 0, 0], 30), `clon de otra capa: ${px(100, 50)}`);
    assert(isColor(px(150, 50), [0, 255, 0], 30), `cambio de tiempo +1 s: ${px(150, 50)}`);
  });

  await test('pintura: Simulación de escritura anima Fin de 0 a 100 % durante el dibujo (mitad a mitad de tiempo)', async () => {
    const { comp, l } = await setup();
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'brush', points: line(), color: '#ff0000', diameter: 12, hardness: 100, duration: 'writeOn', draw_time: 1, at: 0.5 });
    const st = (await call('paint_list', { project: P, comp, layer: l })).strokes[0];
    assert(st.end.keys?.length === 2 && st.end.keys[0].t === 0.5 && st.end.keys[0].v === 0 && st.end.keys[1].t === 1.5 && st.end.keys[1].v === 100, `claves de Fin ${JSON.stringify(st.end)}`);
    const px = await frame(comp, 1);
    assert(isColor(px(50, 50), [255, 0, 0], 30) && isColor(px(150, 50), [0x33, 0x66, 0xcc], 30), `a mitad: ${px(50, 50)} / ${px(150, 50)}`);
    const p0 = await frame(comp, 0.2);
    assert(isColor(p0(25, 50), [0x33, 0x66, 0xcc], 30), `antes de pintar no hay trazo: ${p0(25, 50)}`);
    // Single Frame: only at its frame
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'brush', points: [[100, 85]], color: '#00ff00', diameter: 10, hardness: 100, duration: 'single', at: 1 });
    assert(isColor((await frame(comp, 1))(100, 85), [0, 255, 0], 30) && !isColor((await frame(comp, 1.1))(100, 85), [0, 255, 0], 30), 'un fotograma');
    // the stroke's properties animate with prop_set
    await call('prop_set', { project: P, comp, layer: l, path: 'effects.Pintura.strokes.Pincelar 1.transform.position', value: [100, 80] });
    assert(isColor((await frame(comp, 1.9))(100, 80), [255, 0, 0], 30), 'posición del trazo');
  });

  await test('pintura: opciones de pintura (intercambiar colores, puntas) y catálogo', async () => {
    const o = await call('paint_options', {});
    assert(o.options.fg === '#000000' && o.options.bg === '#ffffff' && o.options.brush.spacing === 25 && o.options.duration === 'constant' && o.options.erase === 'all', JSON.stringify(o.options));
    const s = await call('paint_options', { swap: true, tip: 3 });
    assert(s.options.fg === '#ffffff' && s.options.brush.diameter === 5 && s.options.brush.hardness === 100, JSON.stringify(s.options));
    const { comp, l } = await setup({ color: '#000000' });
    await call('paint_stroke', { project: P, comp, layer: l, tool: 'brush', points: [[100, 50]], diameter: 20, hardness: 100 });
    assert((await frame(comp))(100, 50)[0] > 230, 'el primer plano blanco pinta');
    await call('paint_options', { reset: true });
    const cat = await call('catalog_list', { kind: 'paint_tips' });
    assert(JSON.stringify(cat).includes('Circular difuso 21'), 'puntas en el catálogo');
  });
};
