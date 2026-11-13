// MCP cases of the «lente» effects: rendered pixels through comp_frame.
export default async ({ test, call, assert, imgOf, isColor, W }) => {
  const MP = W('lente.cinta');
  let made = false;
  const project = async () => { if (!made) { await call('project_new', { path: MP, width: 200, height: 200, fps: 10 }); made = true; } };
  const frame = async (comp, time = 0, width = 200) => { const r = await call('comp_frame', { project: MP, comp, time, width }); assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`); return imgOf(r); };
  const comp = (name, bg = '#000000', duration = 1) => call('comp_new', { project: MP, name, width: 200, height: 200, fps: 10, duration, bg });
  const solid = async (c, color, width = 200, height = 200, name) => (await call('layer_add', { project: MP, comp: c, type: 'solid', color, width, height, ...(name ? { name } : {}) })).layer.id;
  const fx = async (c, layer, effect, values = {}) => (await call('effect_add', { project: MP, comp: c, layer, effect, values })).effect.id;
  const set = (c, layer, effect, values) => call('effect_set', { project: MP, comp: c, layer, effect, values });
  const unfx = (c, layer, effect) => call('effect_remove', { project: MP, comp: c, layer, effect });
  const px = (im, x, y) => im.at((x + 0.5) / 200, (y + 0.5) / 200);
  const L = (q) => (q[0] * 0.299 + q[1] * 0.587 + q[2] * 0.114) / 255;

  await test('lente: Desenfoque de lente de cámara: forma y rotación del iris, resaltes y mapa de desenfoque', async () => {
    await project();
    await comp('Bokeh');
    // a transparent layer the size of the comp with a small bright dot in the middle (a 4 × 4 white solid inside a
    // precomp would do too; an adjustment layer blurs the whole comp below it)
    const dot = await solid('Bokeh', '#ffffff', 16, 16, 'Punto');
    const adj = (await call('layer_add', { project: MP, comp: 'Bokeh', type: 'adjustment' })).layer.id;
    // square iris of radius 30, not linear (the spread light stays visible): a diamond (a corner points up)
    const id = await fx('Bokeh', adj, 'cameraLensBlur', { radius: 30, shape: 'square', linear: false });
    let im = await frame('Bokeh');
    const c = L(px(im, 100, 100)), up = L(px(im, 100, 100 - 22)) / c, diag = L(px(im, 100 + 22, 100 - 22)) / c, far = L(px(im, 100, 100 - 45)) / c;
    assert(c > 0.05 && up > 0.7 && diag < 0.2 && far < 0.2, `rombo: arriba ${up.toFixed(2)}, diagonal ${diag.toFixed(2)}, fuera ${far.toFixed(2)}`);
    // rotated 45°: an upright square, the diagonal is inside
    await set('Bokeh', adj, id, { rotation: 45 });
    im = await frame('Bokeh');
    const diag2 = L(px(im, 100 + 14, 100 - 14)) / L(px(im, 100, 100));
    assert(diag2 > 0.75, `cuadrado girado: diagonal ${diag2.toFixed(2)}`);
    // Highlight gain lifts the dot (brighter than the threshold) before the blur: the bokeh gets brighter
    await set('Bokeh', adj, id, { rotation: 0, shape: 'hexagon' });
    const plain = L(px(await frame('Bokeh'), 100, 110));
    await set('Bokeh', adj, id, { gain: 60 });
    const lit = L(px(await frame('Bokeh'), 100, 110));
    assert(plain > 0.02 && lit > plain * 3, `resaltes: ${plain.toFixed(2)} → ${lit.toFixed(2)}`);
    await unfx('Bokeh', adj, id);
    // blur map: a hidden horizontal ramp, black on the left, white on the right; two dots at a quarter and three
    // quarters of the way: with focal distance 64 (≈ 0.25) the left one stays sharp, the right one is blurred
    await call('layer_set', { project: MP, comp: 'Bokeh', layer: dot, hidden: true });
    const a = await solid('Bokeh', '#ffffff', 8, 8, 'A'), b = await solid('Bokeh', '#ffffff', 8, 8, 'B');
    await call('prop_set', { project: MP, comp: 'Bokeh', layer: a, path: 'position', value: [50, 100] });
    await call('prop_set', { project: MP, comp: 'Bokeh', layer: b, path: 'position', value: [150, 100] });
    const map = await solid('Bokeh', '#000000', 200, 200, 'Mapa');
    await fx('Bokeh', map, 'gradientRamp', { start: [0, 100], end: [200, 100] });
    await call('layer_set', { project: MP, comp: 'Bokeh', layer: map, hidden: true });
    await call('layer_arrange', { project: MP, comp: 'Bokeh', action: 'reorder', layers: [adj], index: 1 });
    const mid = await fx('Bokeh', adj, 'cameraLensBlur', { radius: 30, map: 'Mapa', focal: 64, linear: false });
    im = await frame('Bokeh');
    const sharpA = L(px(im, 50, 100)), haloA = L(px(im, 50, 112)), coreB = L(px(im, 150, 100)), haloB = L(px(im, 150, 112));
    assert(sharpA > 0.8 && haloA < 0.05, `en la distancia focal: nítido ${sharpA.toFixed(2)}, ${haloA.toFixed(2)}`);
    assert(coreB < 0.5 && haloB > 0.01, `fuera de foco: ${coreB.toFixed(2)}, halo ${haloB.toFixed(2)}`);
    // Invert: now the right one is sharp and the left one blurred
    await set('Bokeh', adj, mid, { mapInvert: true });
    im = await frame('Bokeh');
    assert(L(px(im, 150, 100)) > 0.9 && L(px(im, 50, 100)) < 0.6, `invertido: ${L(px(im, 150, 100)).toFixed(2)}, ${L(px(im, 50, 100)).toFixed(2)}`);
  });

  await test('lente: Desenfoque rápido (heredado) = Desenfoque gaussiano con el mismo valor', async () => {
    await project();
    await comp('Rapido');
    const sq = await solid('Rapido', '#ffffff', 80, 80);
    const g = await fx('Rapido', sq, 'gaussianBlur', { amount: 12, repeat: false });
    const a = await frame('Rapido');
    await unfx('Rapido', sq, g);
    const f = await fx('Rapido', sq, 'fastBlur', { blurriness: 12, repeat: false });
    const b = await frame('Rapido');
    for (const xx of [55, 60, 65, 100]) assert(Math.abs(px(a, xx, 100)[0] - px(b, xx, 100)[0]) < 3, `x = ${xx}: ${px(a, xx, 100)[0]} frente a ${px(b, xx, 100)[0]}`);
    assert(px(b, 60, 100)[0] > 40 && px(b, 60, 100)[0] < 220, `borde desenfocado ${px(b, 60, 100)[0]}`);
    await set('Rapido', sq, f, { blurriness: 0 });
    assert(isColor(px(await frame('Rapido'), 61, 100), [255, 255, 255]), '0: sin cambios');
  });

  // a noise texture sliding right 16 px per frame (Fractal Noise moved by Offset)
  const texture = async (name, moving = true, duration = 3) => {
    await comp(name, '#000000', duration);
    const l = await solid(name, '#000000');
    await fx(name, l, 'fractalNoise', { contrast: 200, scale: 30 });
    const o = await fx(name, l, 'offset');
    if (moving) await call('prop_set', { project: MP, comp: name, layer: l, path: `effects.${o}.shift`, keys: [{ t: 0, v: [100, 100] }, { t: 2, v: [420, 100] }] });
    return l;
  };
  // mean horizontal and vertical gradients of the middle of a frame
  const grads = (im) => {
    let gx = 0, gy = 0;
    for (let y = 40; y < 160; y += 2) for (let x = 40; x < 160; x += 2) { gx += Math.abs(L(px(im, x + 1, y)) - L(px(im, x, y))); gy += Math.abs(L(px(im, x, y + 1)) - L(px(im, x, y))); }
    return { gx, gy };
  };

  await test('lente: Desenfoque de movimiento de píxeles: desenfoca a lo largo del movimiento medido (flujo óptico)', async () => {
    await project();
    const l = await texture('Pmb');
    const sharp = grads(await frame('Pmb', 1));
    const id = await fx('Pmb', l, 'pixelMotionBlur');
    const blur = grads(await frame('Pmb', 1));
    // horizontal motion: the horizontal detail goes, the vertical detail stays
    assert(blur.gx < sharp.gx * 0.75 && blur.gx / sharp.gx < (blur.gy / sharp.gy) * 0.8, `gx ${sharp.gx.toFixed(1)} → ${blur.gx.toFixed(1)}, gy ${sharp.gy.toFixed(1)} → ${blur.gy.toFixed(1)}`);
    // a wider shutter blurs more; angle 0 not at all
    await set('Pmb', l, id, { shutterAngle: 360 });
    const wide = grads(await frame('Pmb', 1));
    assert(wide.gx < blur.gx * 0.95, `360°: ${wide.gx.toFixed(1)} frente a ${blur.gx.toFixed(1)}`);
    await set('Pmb', l, id, { shutterAngle: 0 });
    const none = grads(await frame('Pmb', 1));
    assert(Math.abs(none.gx - sharp.gx) < sharp.gx * 0.02, 'ángulo 0: nítido');
    // Automatic follows the layer's motion blur switch (off by default): nothing
    await set('Pmb', l, id, { shutterAngle: 180, shutterControl: 'auto' });
    const auto = grads(await frame('Pmb', 1));
    assert(Math.abs(auto.gx - sharp.gx) < sharp.gx * 0.02, `automático sin el conmutador de capa: nítido (${auto.gx.toFixed(1)})`);
    // a still layer is left as it is
    const s = await texture('PmbQuieto', false);
    const s0 = grads(await frame('PmbQuieto', 1));
    await fx('PmbQuieto', s, 'pixelMotionBlur');
    const s1 = grads(await frame('PmbQuieto', 1));
    assert(Math.abs(s1.gx - s0.gx) < s0.gx * 0.02, 'capa quieta: igual');
  });

  await test('lente: Estabilización del desenfoque de temblores: el fotograma borroso toma el detalle de sus vecinos', async () => {
    await project();
    const l = await texture('Deblur', false);
    // frame 1 s (and only it) is blurred, as if the camera shook
    const gb = await fx('Deblur', l, 'gaussianBlur', { amount: 0 });
    await call('prop_set', { project: MP, comp: 'Deblur', layer: l, path: `effects.${gb}.amount`, keys: [{ t: 0.9, v: 0, ease: 'hold' }, { t: 1, v: 8, ease: 'hold' }, { t: 1.1, v: 0, ease: 'hold' }] });
    const sharp = grads(await frame('Deblur', 0.5)), blurry = grads(await frame('Deblur', 1));
    assert(blurry.gx < sharp.gx * 0.6, `fotograma borroso: ${blurry.gx.toFixed(1)} frente a ${sharp.gx.toFixed(1)}`);
    const id = await fx('Deblur', l, 'cameraShakeDeblur');
    const fixed = grads(await frame('Deblur', 1)), still = grads(await frame('Deblur', 0.5));
    assert(fixed.gx > blurry.gx * 1.5 && fixed.gx > sharp.gx * 0.7, `recuperado: ${blurry.gx.toFixed(1)} → ${fixed.gx.toFixed(1)} (nítido ${sharp.gx.toFixed(1)})`);
    assert(Math.abs(still.gx - sharp.gx) < sharp.gx * 0.03, 'los fotogramas nítidos no cambian');
    // Strength 0: nothing
    await set('Deblur', l, id, { strength: 0 });
    const zero = grads(await frame('Deblur', 1));
    assert(Math.abs(zero.gx - blurry.gx) < blurry.gx * 0.03, 'intensidad 0: sin cambios');
  });

  await test('lente: Conservar detalles (ampliación): escala desde el centro, ajustar a ancho de comp. y bordes nítidos', async () => {
    await project();
    await comp('Up');
    const sq = await solid('Up', '#ff0000', 40, 40);
    let im = await frame('Up');
    assert(isColor(px(im, 125, 100), [0, 0, 0]), 'sin efecto: 40 px');
    const id = await fx('Up', sq, 'upscale', { scale: 200 });
    im = await frame('Up');
    assert(isColor(px(im, 136, 100), [255, 0, 0]) && isColor(px(im, 64, 64), [255, 0, 0]) && isColor(px(im, 145, 100), [0, 0, 0]) && isColor(px(im, 55, 100), [0, 0, 0]), `200 %: 80 px centrado (${Array.from({ length: 200 }, (_, x) => px(im, x, 100)[0] > 128 ? 1 : 0).join('')})`);
    // Fit to Comp Width: 40 → 200 px, the whole comp
    await set('Up', sq, id, { fitWidth: true });
    im = await frame('Up');
    assert(isColor(px(im, 3, 100), [255, 0, 0]) && isColor(px(im, 196, 196), [255, 0, 0]), `ajustar a ancho de comp.: ${px(im, 3, 100)}`);
  });
};
