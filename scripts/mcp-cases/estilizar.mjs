// MCP cases of the estilizar effects: rendered pixels through comp_frame.
export default async ({ test, call, callErr, assert, imgOf, decodePng, isColor, near, ff, probe, W, FF, root }) => {
  const P = W('estilizar.cinta');
  let n = 0;
  /** a 200×100 comp with one solid (a horizontal ramp from `a` to `b` unless `flat`), the effect on it, the frame at t */
  const shot = async (fx, values = {}, o = {}) => {
    const comp = `E${++n}`;
    await call('comp_new', { project: P, name: comp, width: 200, height: 100, fps: o.fps ?? 30, duration: 2, bg: o.bg ?? '#000000' });
    const l = (await call('layer_add', { project: P, comp, type: 'solid', color: o.color ?? '#3366cc', width: 200, height: 100 })).layer.id;
    if (!o.flat) await call('effect_add', { project: P, comp, layer: l, effect: 'gradientRamp', values: { type: 'linear', start: [0, 50], end: [200, 50], startColor: o.a ?? '#000000', endColor: o.b ?? '#ffffff' } });
    if (fx) await call('effect_add', { project: P, comp, layer: l, effect: fx, values });
    const r = await call('comp_frame', { project: P, comp, time: o.t ?? 0.5, width: 200 });
    assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`);
    const im = imgOf(r);
    await call('comp_delete', { project: P, comp });
    return { at: (x, y) => im.at((x + 0.5) / 200, (y + 0.5) / 100), mean: () => im.mean() };
  };
  const diff = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);

  await test('estilizar: proyecto propio', async () => { await call('project_new', { path: P, width: 640, height: 360, fps: 30 }); });

  await test('estilizar: Mosaico (bloques uniformes, colores nítidos) y Detectar bordes / Relieve como After Effects', async () => {
    // 10 blocks across 200 px: every pixel of a block has the same colour; the average of a ramp block is its middle
    const m = await shot('mosaic', { h: 10, v: 1 });
    assert(diff(m.at(21, 50), m.at(38, 50)) < 4 && diff(m.at(38, 50), m.at(41, 50)) > 10, `Mosaico: bloques ${m.at(21, 50)} ${m.at(38, 50)} ${m.at(41, 50)}`);
    assert(Math.abs(m.at(30, 50)[0] - 255 * 30 / 200) < 14, `Mosaico: media del bloque ${m.at(30, 50)}`);
    const s = await shot('mosaic', { h: 10, v: 1, sharp: true });
    assert(Math.abs(s.at(25, 50)[0] - m.at(25, 50)[0]) < 8, `Colores nítidos: centro del bloque ${s.at(25, 50)} / ${m.at(25, 50)}`);
    // a flat colour has no edges: Find Edges gives white (black inverted); Emboss gives 50 % grey
    const fe = await shot('findEdges', {}, { flat: true }), fi = await shot('findEdges', { invert: true }, { flat: true });
    assert(fe.at(100, 50).every((v) => v > 240) && fi.at(100, 50).every((v) => v < 15), `Detectar bordes: ${fe.at(100, 50)} / ${fi.at(100, 50)}`);
    const em = await shot('emboss', {}, { flat: true });
    assert(em.at(100, 50).every((v) => Math.abs(v - 128) < 6), `Relieve: gris ${em.at(100, 50)}`);
    // on a left-to-right ramp, light from 0° (the right) lifts the grey; from 180° it sinks
    const e0 = await shot('emboss', { direction: 0, relief: 2, contrast: 400 }), e1 = await shot('emboss', { direction: 180, relief: 2, contrast: 400 });
    assert(e0.at(100, 50)[0] > 135 && e1.at(100, 50)[0] < 121, `Relieve en rampa: ${e0.at(100, 50)} / ${e1.at(100, 50)}`);
  });

  await test('estilizar: Rampa de degradado (negro a blanco, intercambiar, dispersión), Cuadrícula y Tablero de ajedrez', async () => {
    // defaults: black at the top centre, white at the bottom
    const r = await shot('gradientRamp', {}, { flat: true });
    assert(r.at(100, 2)[0] < 15 && r.at(100, 97)[0] > 240 && Math.abs(r.at(100, 50)[0] - 128) < 12, `rampa: ${r.at(100, 2)} ${r.at(100, 50)} ${r.at(100, 97)}`);
    const sw = await shot('gradientRamp', { swap: true }, { flat: true });
    assert(sw.at(100, 2)[0] > 240 && sw.at(100, 97)[0] < 15, `intercambiar colores: ${sw.at(100, 2)}`);
    const sc = await shot('gradientRamp', { scatter: 100 }, { flat: true });
    let var_ = 0; for (let x = 90; x < 110; x++) var_ += Math.abs(sc.at(x, 50)[0] - sc.at(x + 1, 50)[0]);
    assert(var_ > 40, `dispersión: ${var_}`);
    // Grid at its defaults: Size From Corner Point (anchor 50 %, corner 60 % → 20 × 10 px cells), white 5 px lines on
    // nothing (blending None): a line through the anchor, transparent (black bg) in the middle of a cell
    const g = await shot('grid', {}, { flat: true });
    assert(g.at(100, 50).every((v) => v > 240) && g.at(110, 55).every((v) => v < 15) && g.at(120, 47)[0] > 240, `cuadrícula: ${g.at(100, 50)} / ${g.at(110, 55)} / ${g.at(120, 47)}`);
    const gi = await shot('grid', { invert: true, blendMode: 'normal' }, { flat: true, color: '#ff0000' });
    assert(gi.at(110, 55).every((v) => v > 240) && isColor(gi.at(100, 52), [255, 0, 0]), `cuadrícula invertida en normal: ${gi.at(110, 55)} / ${gi.at(100, 52)}`);
    // Checkerboard: 16 px squares from the centre, every other one white
    const c = await shot('checkerboard', {}, { flat: true });
    assert(c.at(108, 58)[0] > 240 && c.at(92, 58)[0] < 15 && c.at(92, 42)[0] > 240, `tablero: ${c.at(108, 58)} ${c.at(92, 58)} ${c.at(92, 42)}`);
    const cm = await shot('checkerboard', { blendMode: 'multiply', color: '#00ff00' }, { flat: true, color: '#ffff00' });
    assert(isColor(cm.at(108, 58), [0, 255, 0]) && isColor(cm.at(92, 58), [255, 255, 0]), `tablero multiplicar: ${cm.at(108, 58)} / ${cm.at(92, 58)}`);
  });

  await test('estilizar: Círculo (disco, anillo por grosor, calado exterior, invertir, modo de fusión)', async () => {
    const c = await shot('circle', {}, { flat: true });
    assert(c.at(100, 50).every((v) => v > 240) && c.at(3, 3).every((v) => v < 15), `disco de radio 75: ${c.at(100, 50)} / ${c.at(3, 3)}`);
    const ring = await shot('circle', { radius: 30, edge: 'thickness', thickness: 10 }, { flat: true });
    assert(ring.at(100, 50)[0] < 15 && ring.at(130, 50)[0] > 240 && ring.at(140, 50)[0] < 15, `anillo: ${ring.at(100, 50)} ${ring.at(130, 50)} ${ring.at(140, 50)}`);
    const f = await shot('circle', { radius: 30, feather: 20 }, { flat: true });
    assert(f.at(129, 50)[0] > 240 && f.at(140, 50)[0] > 60 && f.at(140, 50)[0] < 200 && f.at(152, 50)[0] < 15, `calado exterior: ${f.at(129, 50)} ${f.at(140, 50)} ${f.at(152, 50)}`);
    const inv = await shot('circle', { radius: 30, invert: true, blendMode: 'normal', color: '#000000' }, { flat: true, color: '#00ff00' });
    assert(isColor(inv.at(100, 50), [0, 255, 0]) && inv.at(10, 10).every((v) => v < 15), `invertido en normal: ${inv.at(100, 50)} / ${inv.at(10, 10)}`);
  });

  await test('estilizar: Destello de lente (tipos de lente) y Eco (operadores de After Effects)', async () => {
    const z = await shot('lensFlare', {}, { flat: true, color: '#000000' }), p = await shot('lensFlare', { lensType: 'prime105' }, { flat: true, color: '#000000' });
    assert(z.at(80, 40)[0] > 200 && z.at(100, 50)[0] > 20 && diff(z.at(130, 65), p.at(130, 65)) + diff(z.at(150, 70), p.at(150, 70)) > 20, `destello: ${z.at(80, 40)} / tipos ${z.at(130, 65)} ${p.at(130, 65)}`);
    const half = await shot('lensFlare', { blend: 100 }, { flat: true, color: '#000000' });
    assert(half.at(80, 40)[0] < 15, `mezclar con original 100 %: ${half.at(80, 40)}`);
    // a 6 px dot moving 20 px per 0.1 s inside the layer; Echo copies the layer's content 0.1 s and 0.2 s earlier
    const echo = async (values) => {
      const comp = `E${++n}`;
      await call('comp_new', { project: P, name: comp, width: 200, height: 100, fps: 10, duration: 2, bg: '#000000' });
      const l = (await call('layer_add', { project: P, comp, type: 'solid', color: '#000000', width: 200, height: 100 })).layer.id;
      const c = await call('effect_add', { project: P, comp, layer: l, effect: 'circle', values: { radius: 6, blendMode: 'normal' } });
      await call('prop_set', { project: P, comp, layer: l, path: `effects.${c.effect.id}.center`, keys: [{ t: 0, v: [40, 50] }, { t: 1, v: [240, 50] }] });
      await call('effect_add', { project: P, comp, layer: l, effect: 'echo', values });
      const im = imgOf(await call('comp_frame', { project: P, comp, time: 0.5, width: 200 }));
      await call('comp_delete', { project: P, comp });
      return (x) => im.at((x + 0.5) / 200, 0.505)[0];
    };
    // defaults: 1 echo 1/30 s back, Add — the dot is there now (x 140)
    const d = await echo({});
    assert(d(140) > 240, `eco por defecto: ${d(140)}`);
    const add = await echo({ time: -0.1, count: 2, decay: 0.5 });
    assert(add(140) > 240 && add(120) > 110 && add(120) < 150 && add(100) > 50 && add(100) < 80, `Añadir con disminución 0,5: ${add(140)} ${add(120)} ${add(100)}`);
    const mn = await echo({ time: -0.1, count: 2, op: 'min' });
    assert(mn(140) < 15 && mn(120) < 15, `Mínimo: ${mn(140)}`);
    const bl = await echo({ time: -0.1, count: 3, op: 'blend' });
    assert(Math.abs(bl(140) - 64) < 20 && Math.abs(bl(100) - 64) < 20, `Mezclar (media de 4): ${bl(140)} ${bl(100)}`);
  });

  await test('estilizar: CC Vignette, Patrón de celdas y Ruido fractal con los parámetros de After Effects', async () => {
    // CC Vignette: centre untouched, corners darker (cos⁴); a negative amount brightens them; Pin Highlights keeps white
    const v = await shot('vignette', { angleOfView: 90 }, { flat: true, color: '#808080' });
    assert(Math.abs(v.at(100, 50)[0] - 128) < 6 && v.at(2, 2)[0] < 110, `viñeta: ${v.at(100, 50)} / ${v.at(2, 2)}`);
    const vb = await shot('vignette', { angleOfView: 90, amount: -100 }, { flat: true, color: '#808080' });
    assert(vb.at(2, 2)[0] > 140, `viñeta negativa: ${vb.at(2, 2)}`);
    const vp = await shot('vignette', { angleOfView: 90, pinHighlights: 100 }, { flat: true, color: '#ffffff' });
    assert(vp.at(2, 2)[0] > 245, `fijar iluminaciones: ${vp.at(2, 2)}`);
    // Cell Pattern: every pattern draws something different; tiling repeats every 4 cells (4 × 20 px = 80 px)
    const seen = [];
    for (const type of ['bubbles', 'crystals', 'plates', 'pillow', 'tubular', 'mixedCrystals']) {
      const c = await shot('cellPattern', { type, size: 20 }, { flat: true });
      let s = 0; for (let x = 0; x < 200; x += 7) s += c.at(x, 40)[0];
      seen.push(Math.round(s));
    }
    assert(new Set(seen).size === seen.length, `patrones distintos: ${seen}`);
    const t = await shot('cellPattern', { size: 20, tiling: true, offset: [0, 0] }, { flat: true });
    assert(diff(t.at(10, 30), t.at(90, 30)) < 12 && diff(t.at(33, 47), t.at(113, 47)) < 12, `mosaico de celdas: ${t.at(10, 30)} ${t.at(90, 30)}`);
    // Fractal Noise: grey noise around 50 %; uniform scaling off with a tall height → vertical streaks
    const f = await shot('fractalNoise', {}, { flat: true });
    let lo = 255, hi = 0; for (let x = 0; x < 200; x += 5) { const g = f.at(x, 50)[0]; lo = Math.min(lo, g); hi = Math.max(hi, g); }
    assert(hi - lo > 40 && Math.abs(f.mean() - 128) < 50, `ruido: ${lo}–${hi}, media ${f.mean()}`);
    const st = await shot('fractalNoise', { uniform: false, scaleWidth: 20, scaleHeight: 400 }, { flat: true });
    let dx = 0, dy = 0; for (let i = 0; i < 30; i++) { dx += Math.abs(st.at(20 + i * 5, 50)[0] - st.at(22 + i * 5, 50)[0]); dy += Math.abs(st.at(100, 5 + i * 3)[0] - st.at(100, 7 + i * 3)[0]); }
    assert(dx > dy * 2, `vetas: ${dx} / ${dy}`);
    // every fractal type renders and they differ; evolution changes it; cycle 1 rev: evolution 360° = 0°
    const types = ['basic', 'turbulent', 'turbulentSharp', 'dynamic', 'max', 'rocky', 'strings', 'swirly'], m = [];
    for (const type of types) m.push(Math.round((await shot('fractalNoise', { type }, { flat: true })).mean()));
    assert(new Set(m).size >= types.length - 1, `tipos: ${m}`);
    const e1 = await shot('fractalNoise', { evolution: 90 }, { flat: true });
    assert(diff(e1.at(50, 50), f.at(50, 50)) + diff(e1.at(150, 30), f.at(150, 30)) > 15, 'evolución');
    const c0 = await shot('fractalNoise', { cycle: true }, { flat: true }), c1 = await shot('fractalNoise', { cycle: true, evolution: 360 }, { flat: true });
    assert(diff(c0.at(50, 50), c1.at(50, 50)) < 6 && diff(c0.at(150, 30), c1.at(150, 30)) < 6, `evolución cíclica: ${c0.at(50, 50)} / ${c1.at(50, 50)}`);
    // blending mode: Multiply over red keeps red hue
    const mu = await shot('fractalNoise', { blendMode: 'multiply' }, { flat: true, color: '#ff0000' });
    assert(mu.at(50, 50)[1] < 10 && mu.at(50, 50)[2] < 10, `multiplicar: ${mu.at(50, 50)}`);
  });

  await test('estilizar: Posterizar tiempo (24 fps por defecto) y CC Time Blend con sus 17 modos', async () => {
    // a dot moving 200 px/s: posterized to 2 fps, at 0.7 s it is where it was at 0.5 s
    const mv = async (fx, values, t) => {
      const comp = `E${++n}`;
      await call('comp_new', { project: P, name: comp, width: 200, height: 100, fps: 10, duration: 2, bg: '#000000' });
      const l = (await call('layer_add', { project: P, comp, type: 'solid', color: '#000000', width: 200, height: 100 })).layer.id;
      const c = await call('effect_add', { project: P, comp, layer: l, effect: 'circle', values: { radius: 6, blendMode: 'normal' } });
      await call('prop_set', { project: P, comp, layer: l, path: `effects.${c.effect.id}.center`, keys: [{ t: 0, v: [0, 50] }, { t: 1, v: [200, 50] }] });
      await call('effect_add', { project: P, comp, layer: l, effect: fx, values });
      const im = imgOf(await call('comp_frame', { project: P, comp, time: t, width: 200 }));
      await call('comp_delete', { project: P, comp });
      return (x) => im.at((x + 0.5) / 200, 0.505)[0];
    };
    const pt2 = await mv('posterizeTime', { fps: 2 }, 0.7);
    assert(pt2(100) > 240 && pt2(140) < 15, `posterizar a 2 fps: ${pt2(100)} / ${pt2(140)}`);
    const tb = await mv('timeBlend', { mode: 'lighten', accumulation: 0.9 }, 0.7);
    assert(tb(140) > 240 && tb(120) > 150 && tb(120) < 250 && tb(165) < 15, `CC Time Blend aclarar: ${tb(140)} ${tb(120)} ${tb(165)}`);
  });

  await test('estilizar (nuevos): Relieve de color, Dispersar, Luz estroboscópica, Pinceladas y Bordes irregulares', async () => {
    // Color Emboss keeps the colour of a flat solid (no relief), Emboss would turn it grey
    const ce = await shot('colorEmboss', {}, { flat: true, color: '#3366cc' });
    assert(isColor(ce.at(100, 50), [0x33, 0x66, 0xcc], 12), `relieve de color: ${ce.at(100, 50)}`);
    // Scatter: a ramp gets noisy (neighbours differ) but keeps its average
    const sc = await shot('scatter', { amount: 40 });
    let jit = 0; for (let x = 60; x < 140; x++) jit += Math.abs(sc.at(x, 50)[0] - sc.at(x + 1, 50)[0]);
    assert(jit > 150 && Math.abs(sc.at(100, 50)[0] - 128) < 40, `dispersar: ${jit}`);
    // Strobe Light: on in the first 0.5 s of each second (Copy white), off after
    const s1 = await shot('strobeLight', {}, { flat: true, t: 0.2 }), s2 = await shot('strobeLight', {}, { flat: true, t: 0.7 });
    assert(s1.at(100, 50).every((v) => v > 245) && isColor(s2.at(100, 50), [0x33, 0x66, 0xcc], 12), `estroboscópica: ${s1.at(100, 50)} / ${s2.at(100, 50)}`);
    const st = await shot('strobeLight', { strobe: 'transparent' }, { flat: true, t: 0.2, bg: '#00ff00' });
    assert(isColor(st.at(100, 50), [0, 255, 0]), `estroboscópica transparente: ${st.at(100, 50)}`);
    const sm = await shot('strobeLight', { operator: 'multiply', color: '#ff0000' }, { flat: true, t: 0.2, color: '#ffff00' });
    assert(isColor(sm.at(100, 50), [255, 0, 0]), `estroboscópica multiplicar: ${sm.at(100, 50)}`);
    // Brush Strokes: a flat colour stays the same colour; on black with low density the surface shows through
    const bs = await shot('brushStrokes', { length: 20, brushSize: 5 }, { flat: true });
    assert(isColor(bs.at(100, 50), [0x33, 0x66, 0xcc], 12), `pinceladas en color plano: ${bs.at(100, 50)}`);
    const bw = await shot('brushStrokes', { density: 0.3, surface: 'white' }, { flat: true });
    let white = 0; for (let x = 0; x < 200; x += 3) if (bw.at(x, 50).every((v) => v > 240)) white++;
    assert(white > 20 && white < 66, `pinceladas sobre blanco: ${white}`);
    // Roughen Edges: a 100×60 solid in the middle gets a ragged outline: the edge column alternates in and out
    const comp = `E${++n}`;
    await call('comp_new', { project: P, name: comp, width: 200, height: 100, fps: 30, duration: 1, bg: '#000000' });
    const l = (await call('layer_add', { project: P, comp, type: 'solid', color: '#ffffff', width: 100, height: 60 })).layer.id;
    await call('effect_add', { project: P, comp, layer: l, effect: 'roughenEdges', values: { border: 20, scale: 30 } });
    const im = imgOf(await call('comp_frame', { project: P, comp, time: 0, width: 200 }));
    let ins = 0, outs = 0; for (let y = 25; y < 75; y++) { const v = im.at(55.5 / 200, (y + 0.5) / 100)[0]; if (v > 200) ins++; else if (v < 50) outs++; }
    assert(ins > 3 && outs > 3 && im.at(0.5, 0.5)[0] > 240, `bordes irregulares: ${ins} dentro, ${outs} fuera`);
    await call('comp_delete', { project: P, comp });
  });

  await test('estilizar (nuevos): Elipse, Relleno de cuentagotas, CC Kaleida, CC HexTile, CC Light Burst, CC Light Sweep y CC Star Burst', async () => {
    // Ellipse 50 × 50 at the centre, thickness 8: the ring is at 25 px from the centre, pink inside the ring core
    const e = await shot('ellipse', {}, { flat: true });
    const ring = e.at(125, 50), mid = e.at(100, 50);
    assert(ring[0] > 200 && ring[1] > 120 && mid.every((v) => v < 10), `elipse: anillo ${ring}, centro ${mid}`);
    const ec = await shot('ellipse', { composite: true }, { flat: true, color: '#00ff00' });
    assert(isColor(ec.at(100, 50), [0, 255, 0]), `elipse sobre el original: ${ec.at(100, 50)}`);
    // Eyedropper Fill: the colour around the centre of a ramp (mid grey) fills the layer
    const ey = await shot('eyedropperFill', {});
    assert(Math.abs(ey.at(10, 10)[0] - 128) < 12 && Math.abs(ey.at(190, 90)[0] - 128) < 12, `cuentagotas: ${ey.at(10, 10)}`);
    // CC Kaleida: mirror symmetry around the centre (Flower, 6 wedges): opposite points match
    const k = await shot('ccKaleida', { size: 50 });
    assert(diff(k.at(120, 40), k.at(80, 40)) < 30 || diff(k.at(130, 50), k.at(70, 50)) < 30, `kaleida: ${k.at(120, 40)} / ${k.at(80, 40)}`);
    // CC HexTile (Tile): the same hexagon repeats: points one hexagon width apart match
    const h = await shot('ccHexTile', { radius: 20 });
    const hw = 20 * Math.sqrt(3);
    assert(diff(h.at(100 + 5, 50), h.at(100 + 5 + hw, 50)) < 20 && diff(h.at(100 + 5, 50), h.at(150, 50)) >= 0, `hextile: ${h.at(105, 50)} / ${h.at(105 + hw, 50)}`);
    // CC Light Burst: a bright layer shines past its edges (rays); CC Light Sweep: a bright band on a dark layer
    const comp = `E${++n}`;
    await call('comp_new', { project: P, name: comp, width: 200, height: 100, fps: 30, duration: 1, bg: '#000000' });
    // (rays stay inside the layer, as in After Effects: a full-size black layer with a white disc)
    const l = (await call('layer_add', { project: P, comp, type: 'solid', color: '#000000', width: 200, height: 100 })).layer.id;
    await call('effect_add', { project: P, comp, layer: l, effect: 'circle', values: { radius: 15, blendMode: 'normal' } });
    await call('effect_add', { project: P, comp, layer: l, effect: 'ccLightBurst', values: { rayLength: 150 } });
    const lb = imgOf(await call('comp_frame', { project: P, comp, time: 0, width: 200 }));
    await call('comp_delete', { project: P, comp });
    assert(lb.at(0.5, 0.5)[0] > 240 && lb.at(0.5, 0.5 + 0.28)[0] > 20, `light burst: rayos ${lb.at(0.5, 0.78)}`);
    const sw = await shot('ccLightSweep', { direction: 0, center: [100, 50], width: 40, sweepIntensity: 100 }, { flat: true, color: '#202020' });
    assert(sw.at(100, 50)[0] > 150 && sw.at(150, 50)[0] < 50, `light sweep: ${sw.at(100, 50)} / ${sw.at(150, 50)}`);
    const swc = await shot('ccLightSweep', { direction: 0, center: [100, 50], width: 40, sweepIntensity: 100, reception: 'cutout' }, { flat: true, color: '#202020', bg: '#0000ff' });
    assert(isColor(swc.at(150, 50), [0, 0, 255]), `light sweep recortar: ${swc.at(150, 50)}`);
    // CC Star Burst: dots of the layer's colour on transparent, changing with time
    const s0 = await shot('ccStarBurst', {}, { flat: true, color: '#ff0000', t: 0 }), s1 = await shot('ccStarBurst', {}, { flat: true, color: '#ff0000', t: 0.5 });
    let red = 0, ch = 0; for (let y = 5; y < 100; y += 6) for (let x = 3; x < 200; x += 6) { const a = s0.at(x, y), b = s1.at(x, y); if (a[0] > 100 && a[1] < 50) red++; ch += diff(a, b); }
    assert(red > 5 && ch > 500, `star burst: ${red} puntos rojos, cambio ${ch}`);
  });

  await test('estilizar: CC Light Rays (rayos desde el radio, color del origen, modo Ninguno)', async () => {
    // a ramp, rays from the light inside 40 px of (50, 25): brighter than the plain ramp away from the centre, along the rays
    const plain = await shot(null, {});
    const lr = await shot('lightRays', { center: [100, 50], radius: 30 });
    assert(lr.at(160, 50)[0] > plain.at(160, 50)[0] + 10, `rayos: ${lr.at(160, 50)} / ${plain.at(160, 50)}`);
    const none = await shot('lightRays', { center: [100, 50], radius: 30, transfer: 'none', colorFromSource: false, color: '#ff0000' }, { flat: true, color: '#ffffff', bg: '#0000ff' });
    assert(none.at(100, 50)[0] > 150 && none.at(100, 50)[1] < 60 && none.at(5, 5)[1] < 30 && none.at(5, 5)[2] > 60, `solo rayos rojos: ${none.at(100, 50)} / ${none.at(5, 5)}`);
  });

  await test('estilizar: Mosaico de movimiento (anchura, reflejar bordes y fase)', async () => {
    // tiles of 50 % width: the left quarter of the layer shows the middle-left of the ramp again
    const t = await shot('motionTile', { width: 50 });
    assert(Math.abs(t.at(10, 50)[0] - t.at(110, 50)[0]) < 8, `mosaico repetido: ${t.at(10, 50)} / ${t.at(110, 50)}`);
    const mi = await shot('motionTile', { width: 50, mirror: true });
    // the tile right of the centre one is flipped: the ramp goes down again
    assert(mi.at(160, 50)[0] > mi.at(190, 50)[0] + 30 && t.at(160, 50)[0] < t.at(190, 50)[0], `bordes reflejados: ${mi.at(160, 50)} > ${mi.at(190, 50)}`);
    // Horizontal Phase Shift 180°: every other row of tiles (the one above the centre row) moves half a tile
    const ph = await shot('motionTile', { width: 50, height: 50, phase: 180, hShift: true });
    const p0 = await shot('motionTile', { width: 50, height: 50 });
    assert(diff(ph.at(60, 40), p0.at(60, 40)) < 8 && diff(ph.at(60, 10), p0.at(60, 10)) > 20, `fase horizontal: ${ph.at(60, 10)} / ${p0.at(60, 10)}`);
  });

  await test('estilizar (ronda 2): vistas de alambre / borrador por defecto, dos fuerzas, Card Dance en grados y Vegas invertido', async () => {
    // Shatter's default view is «Wireframe + Forces»: black with white outlines and the force circle in red
    const sw = await shot('shatter', {}, { flat: true, t: 0 });
    let white = 0, black = 0; for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x += 3) { const q = sw.at(x, y); if (q.every((v) => v > 150)) white++; else if (q.every((v) => v < 30)) black++; }
    assert(white > 20 && black > 3000, `Estallido alambre: ${white} blancos, ${black} negros`);
    // force 2 alone (force 1 radius 0) breaks the right side only
    const f2 = await shot('shatter', { view: 'rendered', radius: 0, force2: [150, 50], force2Radius: 0.3, strength: 0 }, { flat: true, t: 1, bg: '#ff0000' });
    assert(f2.at(150, 50)[0] > 200 && f2.at(150, 50)[2] < 60 && f2.at(30, 50)[2] > 150, `Fuerza 2: ${f2.at(150, 50)} / ${f2.at(30, 50)}`);
    // Card Dance: rotation offsets are degrees (After Effects): 180° shows the (missing) back, 0° the card
    const c0 = await shot('cardDance', { yRotOff: 0 }, { flat: true, bg: '#ff0000' }), c1 = await shot('cardDance', { yRotOff: 180 }, { flat: true, bg: '#ff0000' });
    assert(c0.at(100, 50)[2] > 150 && c1.at(100, 50)[0] > 200 && c1.at(100, 50)[2] < 60, `Card Dance: ${c0.at(100, 50)} / ${c1.at(100, 50)}`);
    // Wave World: the default wireframe draws lines on black
    const ww = await shot('waveWorld', {}, { flat: true, t: 1 });
    let lines = 0; for (let y = 0; y < 100; y++) { const q = ww.at(100, y); if (q[2] > 120) lines++; }
    assert(lines > 2 && ww.at(2, 2).every((v) => v < 30), `Mundo de olas alambre: ${lines} líneas`);
    // Foam: Draft shows blue bubble outlines; CC Particle World «Black Matte» puts the particles on black
    const fo = await shot('foam', { rate: 5, size: 2 }, { flat: true, color: '#000000', t: 1 });
    let blue = 0; for (let y = 0; y < 100; y += 2) for (let x = 0; x < 200; x += 2) { const q = fo.at(x, y); if (q[2] > 120 && q[0] < 120) blue++; }
    assert(blue > 3, `Espuma borrador: ${blue} píxeles azules`);
    const pw = await shot('particleWorld', { transfer: 'blackMatte' }, { flat: true, color: '#ffffff', t: 0.5 });
    assert(pw.at(3, 3).every((v) => v < 30), `CC Particle World mate negro: ${pw.at(3, 3)}`);
    // Vegas around a layer's contours: the input inverted traces the other side (both must draw something)
    const vg = await shot('vegas', { segments: 6, length: 1, width: 4, endOpacity: 1, color: '#ff0000', blend: 'transparent', threshold: 128 }, { t: 0 });
    const vi = await shot('vegas', { segments: 6, length: 1, width: 4, endOpacity: 1, color: '#ff0000', blend: 'transparent', threshold: 128, invert: true, channel: 'value' }, { t: 0 });
    let r0 = 0, r1 = 0; for (let y = 0; y < 100; y += 2) for (let x = 0; x < 200; x += 2) { if (vg.at(x, y)[0] > 150) r0++; if (vi.at(x, y)[0] > 150) r1++; }
    assert(r0 > 5 && r1 > 5, `Vegas: ${r0} / ${r1} píxeles rojos`);
  });

  await test('estilizar (ronda 2): efectos nuevos dibujan como After Effects', async () => {
    const count = (s, f) => { let c = 0; for (let y = 1; y < 100; y += 2) for (let x = 1; x < 200; x += 2) if (f(s.at(x, y))) c++; return c; };
    // CC Rainfall / Snowfall over black: light streaks / flakes, different at another time (deterministic per frame)
    const ra = await shot('ccRainfall', { drops: 200000, opacity: 100 }, { flat: true, color: '#000000', t: 0.5 });
    const ra2 = await shot('ccRainfall', { drops: 200000, opacity: 100 }, { flat: true, color: '#000000', t: 0.5 });
    const sn = await shot('ccSnowfall', { flakes: 200000, opacity: 100 }, { flat: true, color: '#000000', t: 0.5 });
    const bright = (q) => q[0] > 40;
    assert(count(ra, bright) > 10 && count(sn, bright) > 10, `lluvia ${count(ra, bright)}, nieve ${count(sn, bright)}`);
    assert(diff(ra.at(50, 50), ra2.at(50, 50)) === 0 && diff(ra.at(150, 20), ra2.at(150, 20)) === 0, 'lluvia determinista');
    // Advanced Lightning on transparent: a white core between origin and direction, blue glow round it
    const al = await shot('advancedLightning', { origin: [100, 0], direction: [100, 100], glowRadius: 20 }, { flat: true, color: '#000000', bg: '#000000' });
    assert(count(al, (q) => q[0] > 150 && q[2] > 150) > 5 && count(al, (q) => q[2] > 60 && q[0] < q[2] - 20) > 5, `rayo: ${count(al, (q) => q[0] > 150)} núcleo`);
    // Timecode: a black box with white digits at (10 %, 10 %)
    const tc = await shot('timecode', { position: [100, 50], size: 20 }, { flat: true, color: '#3366cc' });
    assert(count(tc, (q) => q.every((v) => v < 30)) > 20 && count(tc, (q) => q.every((v) => v > 200)) > 5, 'código de tiempo');
    // Numbers: red digits on transparent
    const nu = await shot('numbers', { value: 42, size: 40, position: [100, 50] }, { flat: true, bg: '#000000' });
    assert(count(nu, (q) => q[0] > 180 && q[1] < 60) > 10 && nu.at(5, 5).every((v) => v < 20), 'Números');
    // Paint Bucket on a flat layer fills all of it red; with a tight tolerance on a ramp only a band
    const pb = await shot('paintBucket', { point: [100, 50] }, { flat: true });
    const pr = await shot('paintBucket', { point: [100, 50], tolerance: 10 });
    assert(pb.at(5, 5)[0] > 230 && pb.at(195, 95)[0] > 230 && pr.at(100, 50)[0] > 230 && pr.at(5, 50)[0] < 60, `cubo: ${pb.at(5, 5)} / ${pr.at(5, 50)}`);
    // Cartoon: a ramp becomes steps (neighbours inside a step equal) with black edges on a hard edge
    const ca = await shot('cartoon', { render: 'fill', steps: 4, smoothness: 1 });
    let changes = 0; for (let x = 10; x < 190; x++) if (Math.abs(ca.at(x, 50)[0] - ca.at(x + 1, 50)[0]) > 20) changes++;
    assert(changes >= 2 && changes <= 8, `caricatura: ${changes} saltos`);
    // CC Spotlight: lit at «To», dark far from it
    const so = await shot('ccSpotlight', { from: [100, 50], to: [100, 50], cone: 30 }, { flat: true, color: '#808080' });
    assert(so.at(100, 50)[0] > so.at(5, 5)[0] + 40, `spotlight: ${so.at(100, 50)} / ${so.at(5, 5)}`);
    // CC Glass / CC Plastic: a ramp rising to the right faces away from a light on the right, so it is darker; CC Threads leaves gaps
    const gl = await shot('ccGlass', { softness: 2, height: 100, lightDirection: 90 }), pl = await shot('ccPlastic', { softness: 2, height: 100, lightDirection: 90 }), plain = await shot(null);
    assert(diff(gl.at(100, 50), plain.at(100, 50)) > 10 && diff(pl.at(100, 50), plain.at(100, 50)) > 10, `vidrio ${gl.at(100, 50)} plástico ${pl.at(100, 50)} sin efecto ${plain.at(100, 50)}`);
    const th = await shot('ccThreads', { coverage: 40 }, { flat: true, bg: '#ff0000' });
    assert(count(th, (q) => q[0] > 200 && q[2] < 60) > 50 && count(th, (q) => q[2] > 150) > 50, 'hilos');
    // CC Pixel Polly before the start keeps the layer; later pieces fly off (the background shows)
    const p0 = await shot('ccPixelPolly', { start: 1 }, { flat: true, bg: '#ff0000', t: 0.5 }), p1 = await shot('ccPixelPolly', { force: 800 }, { flat: true, bg: '#ff0000', t: 1.5 });
    assert(count(p0, (q) => q[0] > 200 && q[2] < 60) === 0 && count(p1, (q) => q[0] > 200 && q[2] < 60) > 100, 'pixel polly');
    // CC Ball Action: balls with gaps; CC Bubbles: bubbles on transparent; CC Scatterize moves pixels; CC Drizzle ripples
    const ba = await shot('ccBallAction', { spacing: 10 }, { flat: true, bg: '#ff0000' });
    assert(count(ba, (q) => q[0] > 200 && q[2] < 60) > 50 && count(ba, (q) => q[2] > 100) > 100, 'ball action');
    const bu = await shot('ccBubbles', { amount: 400, size: 6 }, { flat: true, bg: '#ff0000' });
    assert(count(bu, (q) => q[0] > 200 && q[2] < 60) > 100 && count(bu, (q) => q[2] > 100) > 20, 'burbujas');
    const sc = await shot('ccScatterize', { scatter: 60 }, { bg: '#ff0000' });
    assert(count(sc, (q) => q[0] > 200 && q[1] < 60 && q[2] < 60) > 20, 'scatterize');
    const dz = await shot('ccDrizzle', { rate: 30, displacement: 200 }, { t: 0.5 });
    let dd = 0; for (let x = 0; x < 200; x += 2) dd += diff(dz.at(x, 50), plain.at(x, 50)); assert(dd > 200, `llovizna: ${dd}`);
  });

  await test('estilizar: CC Particle Systems II, CC Mr. Mercury, CC Hair, CC Glue Gun, CC Environment y Fractal', async () => {
    const count = (im, f) => { let k = 0; for (let y = 0; y < 100; y += 2) for (let x = 0; x < 200; x += 2) if (f(im.at(x, y))) k++; return k; };
    // Particle Systems II replaces the layer: yellow-red particles on the black background, the blue layer gone; the
    // same time gives the same frame; Black Matte / Line vs Shaded Sphere differ
    const ps = await shot('ccParticleSystems2', { birthRate: 8 }, { flat: true, t: 1 }), ps2 = await shot('ccParticleSystems2', { birthRate: 8 }, { flat: true, t: 1 });
    assert(count(ps, (q) => q[2] > 150 && q[0] < 80) === 0 && count(ps, (q) => q[0] > 80 && q[0] > q[2] + 40) > 10, `partículas: ${count(ps, (q) => q[0] > 80)}`);
    assert(diff(ps.at(100, 50), ps2.at(100, 50)) === 0 && diff(ps.at(120, 70), ps2.at(120, 70)) === 0, 'partículas deterministas');
    const sp = await shot('ccParticleSystems2', { birthRate: 8, particleType: 'shadedSphere', deathSize: 2 }, { flat: true, t: 1 });
    assert(count(sp, (q) => q[0] > 80) > count(ps, (q) => q[0] > 80), `esferas mayores que líneas: ${count(sp, (q) => q[0] > 80)}`);
    // origin colour: the particles take the layer's blue
    const oc = await shot('ccParticleSystems2', { birthRate: 8, colorMap: 'originConstant', particleType: 'fadedSphere', deathSize: 2 }, { flat: true, t: 1 });
    assert(count(oc, (q) => q[2] > 60 && q[2] > q[0] + 20) > 10, 'partículas con el color de origen');
    // Mr. Mercury: metal blobs around the producer on transparent (the layer is replaced)
    const mm = await shot('ccMrMercury', { birthRate: 6, blobBirthSize: 1, blobDeathSize: 1.5 }, { flat: true, t: 0.6 });
    assert(count(mm, (q) => q[0] + q[1] + q[2] > 60) > 20 && mm.at(3, 3).every((v) => v < 10), `mercurio: ${count(mm, (q) => q[0] + q[1] + q[2] > 60)}`);
    // Hair: brown strands over the layer change it in many places; more density changes more
    const plain = await shot(null, {}, { flat: true }), h1 = await shot('ccHair', { density: 100, opacity: 100 }, { flat: true }), h2 = await shot('ccHair', { density: 800, opacity: 100 }, { flat: true });
    const hd = (im) => count(im, (q) => diff(q, plain.at(0, 0)) > 30);
    assert(hd(h1) > 20 && hd(h2) > hd(h1), `pelo: ${hd(h1)} / ${hd(h2)}`);
    // Glue Gun: a bead at the brush, the layer elsewhere untouched
    const gg = await shot('ccGlueGun', { brush: [100, 50], strokeWidth: 8 }, { flat: true });
    assert(diff(gg.at(100, 50), plain.at(100, 50)) > 20 && diff(gg.at(5, 5), plain.at(5, 5)) < 4, `pegamento: ${gg.at(100, 50)}`);
    // Environment: a spherical map of the ramp; panning 180° swaps the left and right halves of the view
    const e0 = await shot('ccEnvironment', {}), e1 = await shot('ccEnvironment', { horizontalPan: 180 });
    assert(Math.abs(e0.at(100, 50)[0] - 128) < 30 && Math.abs(e1.at(100, 50)[0] - 128) > 60, `entorno: ${e0.at(100, 50)} / ${e1.at(100, 50)}`);
    // Fractal: the Mandelbrot set black in the middle (−0.703 is inside it), coloured outside; Julia inverse differs
    const fr = await shot('fractal', {}, { flat: true });
    assert(fr.at(100, 50).every((v) => v < 10) && count(fr, (q) => q[0] > 40) > 100, `fractal: ${fr.at(100, 50)} / ${count(fr, (q) => q[0] > 40)}`);
    const ft = await shot('fractal', { transparency: true, palette: 'hueWheel' }, { flat: true, bg: '#ff00ff' });
    assert(isColor(ft.at(100, 50), [255, 0, 255]), `fractal transparente: ${ft.at(100, 50)}`);
    const fj = await shot('fractal', { setChoice: 'julia' }, { flat: true });
    assert(count(fj, (q, i) => true) && diff(fj.at(60, 50), fr.at(60, 50)) + diff(fj.at(140, 30), fr.at(140, 30)) > 20, 'Julia');
  });

  await test('estilizar: Estallido y Card Dance con sistema de cámaras, iluminación y material de After Effects', async () => {
    const plain = await shot(null), red = (q) => q[0] > 200 && q[1] < 60 && q[2] < 60;
    // the default camera (Z 2, focal 70) and light (distant, ambient 0.25 + diffuse 0.75) leave the layer as it is
    const c0 = await shot('cardDance', {}), s0 = await shot('shatter', { view: 'rendered' }, { t: 0 });
    for (const [x, y] of [[10, 10], [100, 50], [190, 90], [57, 33]]) assert(diff(c0.at(x, y), plain.at(x, y)) < 12 && diff(s0.at(x, y), plain.at(x, y)) < 12, `identidad en ${x},${y}: ${c0.at(x, y)} / ${s0.at(x, y)} / ${plain.at(x, y)}`);
    // Z Position 4 shows the layer at half size (the background round it); focal length 140 at twice (corners off-screen)
    const far = await shot('cardDance', { camZ: 4 }, { bg: '#ff0000' });
    assert(red(far.at(20, 10)) && !red(far.at(100, 50)) && diff(far.at(100, 50), plain.at(100, 50)) < 15, `cámara lejos: ${far.at(20, 10)} / ${far.at(100, 50)}`);
    const zoom = await shot('cardDance', { focal: 140 }, { bg: '#ff0000' });
    assert(!red(zoom.at(2, 2)) && Math.abs(zoom.at(150, 50)[0] - plain.at(125, 50)[0]) < 20, `distancia focal: ${zoom.at(150, 50)} / ${plain.at(125, 50)}`);
    // Y Rotation turns the plane: one side nearer (bigger), the other farther; the background shows above the far side
    const ry = await shot('cardDance', { camRotY: 50 }, { bg: '#ff0000' });
    assert(red(ry.at(30, 4)) !== red(ry.at(170, 4)), `rotación Y de la cámara: ${ry.at(30, 4)} / ${ry.at(170, 4)}`);
    // Corner pins: the layer's corners go to the pins (here the top edge pulled to the middle)
    const cp = await shot('cardDance', { cameraSystem: 'cornerPins', pinUL: [60, 30], pinUR: [140, 30] }, { bg: '#ff0000' });
    assert(red(cp.at(20, 20)) && red(cp.at(180, 20)) && !red(cp.at(100, 40)) && !red(cp.at(5, 97)), `esquinas: ${cp.at(20, 20)} / ${cp.at(100, 40)}`);
    const cpa = await shot('cardDance', { cameraSystem: 'cornerPins', pinUL: [60, 30], pinUR: [140, 30], autoFocal: true }, { bg: '#ff0000' });
    assert(red(cpa.at(20, 20)) && !red(cpa.at(100, 40)), 'esquinas con distancia focal automática');
    // Lighting: no diffuse leaves only the ambient (a quarter); a point light near the layer lights the middle more than
    // the corners; a specular highlight brightens a flat card under a light straight in front
    const amb = await shot('cardDance', { diffuse: 0 }, { flat: true, color: '#ffffff' });
    assert(Math.abs(amb.at(100, 50)[0] - 64) < 12, `ambiente: ${amb.at(100, 50)}`);
    const pl = await shot('cardDance', { lightType: 'point', lightDepth: 0.2 }, { flat: true, color: '#808080' });
    assert(pl.at(100, 50)[0] > pl.at(3, 3)[0] + 15, `luz puntual: ${pl.at(100, 50)} / ${pl.at(3, 3)}`);
    const sp = await shot('cardDance', { specular: 1, diffuse: 0.5, sharpness: 5 }, { flat: true, color: '#404040' });
    assert(sp.at(100, 50)[0] > 120, `especular: ${sp.at(100, 50)}`);
    const lc = await shot('cardDance', { lightColor: '#ff0000', ambient: 0 }, { flat: true, color: '#ffffff' });
    assert(Math.abs(lc.at(100, 50)[0] - 191) < 15 && lc.at(100, 50)[2] < 40, `color de la luz: ${lc.at(100, 50)}`);
    // Rotation Order / Transformation Order: with position before rotation a Z turn swings the card round the centre
    const t1 = await shot('cardDance', { rows: 1, columns: 1, xPosOff: 0.3, zRotOff: 90, transformOrder: 'srp' }, { bg: '#ff0000' });
    const t2 = await shot('cardDance', { rows: 1, columns: 1, xPosOff: 0.3, zRotOff: 90, transformOrder: 'prs' }, { bg: '#ff0000' });
    assert(diff(t1.at(100, 50), t2.at(100, 50)) > 30 || red(t1.at(100, 95)) !== red(t2.at(100, 95)), 'orden de transformación');
    // Shatter: the camera turns the flying pieces too, and the lighting darkens the tumbling ones
    const sh = await shot('shatter', { view: 'rendered' }, { t: 1, bg: '#ff0000' }), shc = await shot('shatter', { view: 'rendered', camRotY: 40 }, { t: 1, bg: '#ff0000' });
    let d = 0; for (let x = 0; x < 200; x += 4) for (let y = 0; y < 100; y += 4) d += diff(sh.at(x, y), shc.at(x, y));
    assert(d > 5000, `estallido con cámara: ${d}`);
  });
};
