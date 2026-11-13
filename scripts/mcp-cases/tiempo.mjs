// MCP cases of the «tiempo» effects: rendered pixels through comp_frame. The effects that read other moments work on
// a composition layer whose content moves or flickers inside (a moving layer's own pixels don't change).
export default async ({ test, call, assert, imgOf, W }) => {
  const P = W('tiempo.cinta');
  let made = false;
  const project = async () => { if (!made) { await call('project_new', { path: P, width: 160, height: 90, fps: 10 }); made = true; } };
  const frame = async (comp, time) => { const r = await call('comp_frame', { project: P, comp, time, width: 160 }); assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`); return imgOf(r); };
  const comp = (name, bg = '#000000') => call('comp_new', { project: P, name, width: 160, height: 90, fps: 10, duration: 2, bg });
  const fx = async (c, layer, effect, values = {}) => (await call('effect_add', { project: P, comp: c, layer, effect, values })).effect.id;
  const set = (c, layer, effect, values) => call('effect_set', { project: P, comp: c, layer, effect, values });
  const px = (im, x, y) => im.at(x / 160, y / 90);
  // a precomp with a 20 px white square crossing at 100 px/s (y 45), placed in an outer comp
  const mover = async (name, opaque = false) => {
    await comp(`${name}In`);
    if (opaque) await call('layer_add', { project: P, comp: `${name}In`, type: 'solid', color: '#000000' });
    const sq = (await call('layer_add', { project: P, comp: `${name}In`, type: 'solid', color: '#ffffff', width: 20, height: 20 })).layer.id;
    await call('prop_set', { project: P, comp: `${name}In`, layer: sq, path: 'position', keys: [{ t: 0, v: [10, 45] }, { t: 2, v: [210, 45] }] });
    const id = (await call('comp_get', { project: P, comp: `${name}In` })).comp?.id ?? `${name}In`;
    await comp(name);
    return (await call('layer_add', { project: P, comp: name, type: 'comp', comp_id: id })).layer.id;
  };

  await test('tiempo: Diferencia de tiempo con la propia capa 0,2 s antes (gris 127 sin cambios; absoluta: negro) y sin destino', async () => {
    await project();
    const L = await mover('TD', true);
    const id = await fx('TD', L, 'timeDifference');
    // no target: flat «no difference» grey
    let im = await frame('TD', 1);
    assert(Math.abs(px(im, 20, 20)[0] - 127) < 3 && Math.abs(px(im, 110, 45)[0] - 127) < 3, `sin destino: gris (${px(im, 20, 20)})`);
    await set('TD', L, id, { target: L, offset: -0.2 });
    // at 1 s the square is at x 100…120, 0.2 s before at 80…100: now − then = +255 → white, −255 → black
    im = await frame('TD', 1);
    assert(px(im, 115, 45)[0] > 250 && px(im, 85, 45)[0] < 5 && Math.abs(px(im, 40, 20)[0] - 127) < 3, `diferencia: ${px(im, 115, 45)} / ${px(im, 85, 45)} / ${px(im, 40, 20)}`);
    await set('TD', L, id, { absolute: true });
    im = await frame('TD', 1);
    assert(px(im, 115, 45)[0] > 250 && px(im, 85, 45)[0] > 250 && px(im, 40, 20)[0] < 5, `absoluta: ${px(im, 115, 45)} / ${px(im, 85, 45)} / ${px(im, 40, 20)}`);
    // contrast 25: half as strong
    await set('TD', L, id, { contrast: 25 });
    im = await frame('TD', 1);
    assert(Math.abs(px(im, 115, 45)[0] - 127) < 4, `contraste 25: ${px(im, 115, 45)}`);
    // Lightness of Result: the original colours where it changed, transparent where not (black background)
    await set('TD', L, id, { contrast: 50, alpha: 'lightness' });
    im = await frame('TD', 1);
    assert(px(im, 115, 45)[0] > 250 && px(im, 40, 20)[0] < 5, `luminosidad del resultado: ${px(im, 115, 45)} / ${px(im, 40, 20)}`);
  });

  await test('tiempo: Eliminar parpadeo iguala la exposición de fotogramas alternos', async () => {
    await project();
    await comp('DFIn');
    await call('layer_add', { project: P, comp: 'DFIn', type: 'solid', color: '#000000' });
    const card = (await call('layer_add', { project: P, comp: 'DFIn', type: 'solid', color: '#c8c8c8' })).layer.id;
    await call('prop_set', { project: P, comp: 'DFIn', layer: card, path: 'opacity', keys: Array.from({ length: 20 }, (_, k) => ({ t: k / 10, v: k % 2 ? 60 : 100, ease: 'hold' })) });
    await comp('DF');
    const L = (await call('layer_add', { project: P, comp: 'DF', type: 'comp', comp_id: 'DFIn' })).layer.id;
    const swing = async () => Math.abs(px(await frame('DF', 1), 80, 45)[0] - px(await frame('DF', 1.1), 80, 45)[0]);
    const before = await swing();
    await fx('DF', L, 'deflicker', { frames: 6 });
    const after = await swing();
    assert(before > 70 && after < 6, `parpadeo ${before} → ${after}`);
  });

  await test('tiempo: CC Time Blend FX (Pegar … Copiar) deja una estela que se desvanece', async () => {
    await project();
    const L = await mover('TB');
    const paste = await fx('TB', L, 'ccTimeBlendFx', { instance: 'paste', accumulation: 0.5 });
    await fx('TB', L, 'ccTimeBlendFx', { instance: 'copy' });
    // at 1 s: square at 100…120 now, 90…110 one frame before, 80…100 two before
    const im = await frame('TB', 1);
    const a = px(im, 115, 45)[0], b = px(im, 95, 45)[0], c = px(im, 85, 45)[0], d = px(im, 40, 45)[0];
    // Blend: buffer × 0.5 + frame × 0.5: now 0.5 (128), one frame before 0.25, two 0.125: 96 at x 95, 48 at x 85
    assert(Math.abs(a - 128) < 6 && Math.abs(b - 96) < 6 && Math.abs(c - 48) < 6 && d < 5, `estela: ${a} ${b} ${c} ${d}`);
    // Transfer Composite Over (the frame over the faded buffer): the square stays whole, the trail fades behind
    await set('TB', L, paste, { mode: 'over' });
    const im2 = await frame('TB', 1);
    assert(px(im2, 115, 45)[0] > 250 && px(im2, 85, 45)[0] > 20 && px(im2, 85, 45)[0] < 250, `encima: ${px(im2, 115, 45)} ${px(im2, 85, 45)}`);
  });

  await test('tiempo: CC Block Load, CC Composite, Reducir parpadeo entrelazado, CC Ripple Pulse y CC Mr. Smoothie', async () => {
    await project();
    await comp('ST', '#000000');
    const S = (await call('layer_add', { project: P, comp: 'ST', type: 'solid', color: '#ffffff', width: 160, height: 90 })).layer.id;
    await fx('ST', S, 'gradientRamp', { startColor: '#000000', endColor: '#ffffff', start: [0, 45], end: [160, 45] });
    const ref = await frame('ST', 0);
    // Block Load: 0 % with Start Cleared is empty; 100 % is the image
    let id = await fx('ST', S, 'ccBlockLoad');
    let im = await frame('ST', 0);
    assert(px(im, 150, 45)[0] < 3, `0 %: vacía (${px(im, 150, 45)})`);
    await set('ST', S, id, { completion: 100 });
    im = await frame('ST', 0);
    assert(Math.abs(px(im, 150, 45)[0] - px(ref, 150, 45)[0]) < 3, 'al 100 %: la imagen');
    // 50 % of 4 passes: blocks of 4 px everywhere (a row of equal pixels)
    await set('ST', S, id, { completion: 50 });
    im = await frame('ST', 0);
    assert(px(im, 150, 45)[0] > 200 && px(im, 101, 45)[0] === px(im, 102, 45)[0], `al 50 %: bloques (${px(im, 100.5, 45)} ${px(im, 101.5, 45)})`);
    await call('effect_remove', { project: P, comp: 'ST', layer: S, effect: id });
    // CC Composite after Invert: In Front brings back the original; Difference shows |original − inverted|
    await fx('ST', S, 'invert');
    id = await fx('ST', S, 'ccComposite');
    im = await frame('ST', 0);
    // the original is the white solid before all its effects (the ramp too)
    assert(px(im, 20, 45)[0] > 252, `delante: el original (${px(im, 20, 45)})`);
    await set('ST', S, id, { mode: 'difference' });
    im = await frame('ST', 0);
    assert(Math.abs(px(im, 20, 45)[0] - px(ref, 20, 45)[0]) < 4, `diferencia: ${px(im, 20, 45)}`);
    await set('ST', S, id, { opacity: 0 });
    im = await frame('ST', 0);
    assert(Math.abs(px(im, 20, 45)[0] - (255 - px(ref, 20, 45)[0])) < 4, `opacidad 0: el invertido (${px(im, 20, 45)})`);
    // Reduce Interlace Flicker: softness 0 leaves a 30 px white band (y 30…60) alone; 3 softens its edges
    await comp('RF');
    const band = (await call('layer_add', { project: P, comp: 'RF', type: 'solid', color: '#ffffff', width: 160, height: 30, name: 'Banda' })).layer.id;
    const rf = await fx('RF', band, 'reduceInterlaceFlicker');
    im = await frame('RF', 0);
    assert(px(im, 80, 30.5)[0] > 250, 'suavizado 0: sin cambios');
    await set('RF', band, rf, { softness: 3 });
    im = await frame('RF', 0);
    // a 30 px band (y 30…60): its inner edge softens (row 31 darker than the middle), the middle stays white
    assert(px(im, 80, 45)[0] > 250 && px(im, 80, 30.5)[0] < 200, `banda suavizada: ${px(im, 80, 30.5)} / ${px(im, 80, 45)}`);
    // CC Ripple Pulse: a pulse level that jumps makes a ring that bends the gradient; the bump map shows it
    await comp('RP');
    const G = (await call('layer_add', { project: P, comp: 'RP', type: 'solid', color: '#ffffff' })).layer.id;
    await fx('RP', G, 'gradientRamp', { startColor: '#000000', endColor: '#ffffff', start: [0, 45], end: [160, 45] });
    const flat = await frame('RP', 1);
    const rp = await fx('RP', G, 'ccRipplePulse');
    im = await frame('RP', 1);
    assert(Math.abs(px(im, 120, 45)[0] - px(flat, 120, 45)[0]) < 2, 'nivel de pulso sin animar: nada');
    await call('prop_set', { project: P, comp: 'RP', layer: G, path: `effects.${rp}.pulse`, keys: [{ t: 0.5, v: 0 }, { t: 0.7, v: 100 }] });
    im = await frame('RP', 1);
    let moved = 0; for (let x = 82; x < 158; x += 2) moved = Math.max(moved, Math.abs(px(im, x, 45)[0] - px(flat, x, 45)[0]));
    assert(moved > 8, `onda: ${moved}`);
    await set('RP', G, rp, { bumpMap: true });
    im = await frame('RP', 1);
    assert(px(im, 80, 45)[0] > 240 && px(im, 2, 2)[0] < 140, `mapa de relieve: ${px(im, 80, 45)} / ${px(im, 2, 2)}`);
    // CC Mr. Smoothie on the gradient: luminance picks colours along A → B, AB vs BA swaps the ends
    const ms = await fx('RP', G, 'ccMrSmoothie');
    await call('effect_remove', { project: P, comp: 'RP', layer: G, effect: rp });
    im = await frame('RP', 1);
    const ab = px(im, 150, 45)[0];
    assert(Math.abs(ab - px(flat, 150, 45)[0]) > 20, `Mr. Smoothie cambia la rampa: ${ab} / ${px(flat, 150, 45)[0]}`);
    await set('RP', G, ms, { loop: 'BA' });
    im = await frame('RP', 1);
    assert(Math.abs(px(im, 150, 45)[0] - ab) > 40, `bucle AB / BA: ${ab} → ${px(im, 150, 45)[0]}`);
  });
};
