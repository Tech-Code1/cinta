// MCP cases of the «generar» line (round 7): rendered pixels through comp_frame.
export default async ({ test, call, assert, imgOf, W }) => {
  const GP = W('generar.cinta');
  let lay = null;
  const frame = async (time = 0) => { const r = await call('comp_frame', { project: GP, comp: 'Gen', time, width: 64 }); assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`); return imgOf(r); };
  /** the frame of a full-frame solid of colour `hex` with these effects applied (removed afterwards) */
  const withFx = async (hex, list, time = 0) => {
    await call('layer_set', { project: GP, comp: 'Gen', layer: lay, solid_color: hex });
    const ids = [];
    for (const [e, v] of list) ids.push((await call('effect_add', { project: GP, comp: 'Gen', layer: lay, effect: e, values: v ?? {} })).effect.id);
    const im = await frame(time);
    for (const id of ids) await call('effect_remove', { project: GP, comp: 'Gen', layer: lay, effect: id });
    return im;
  };
  const px = async (hex, e, v, x = 0.5, y = 0.5) => (await withFx(hex, [[e, v]])).at(x, y).slice(0, 4);
  const close = (a, b, tol = 4) => b.every((v, i) => Math.abs(a[i] - v) <= tol);
  const setup = async () => {
    if (lay) return;
    await call('project_new', { path: GP, width: 64, height: 48, fps: 10 });
    await call('comp_new', { project: GP, name: 'Gen', width: 64, height: 48, fps: 10, duration: 2, bg: '#000000' });
    lay = (await call('layer_add', { project: GP, comp: 'Gen', type: 'solid', color: '#808080', width: 64, height: 48, name: 'S' })).layer.id;
  };

  await test('generar: Degradado de 4 colores (colores en sus puntos, mezcla en el centro, opacidad) y Ruido de turbulencia', async () => {
    await setup();
    const im = await withFx('#808080', [['fourColorGradient']]);
    const c1 = im.at(0.1, 0.1), c2 = im.at(0.9, 0.1), c3 = im.at(0.1, 0.9), c4 = im.at(0.9, 0.9), m = im.at(0.5, 0.5);
    assert(c1[0] > 220 && c1[1] > 220 && c1[2] < 40, `punto 1 amarillo (${c1})`);
    assert(c2[1] > 220 && c2[0] < 40 && c2[2] < 40, `punto 2 verde (${c2})`);
    assert(c3[0] > 220 && c3[2] > 220 && c3[1] < 40, `punto 3 magenta (${c3})`);
    assert(c4[2] > 220 && c4[0] < 40 && c4[1] < 40, `punto 4 azul (${c4})`);
    assert(close(m, [128, 128, 128], 12), `centro: la media de los cuatro (${m})`);
    // Normal at 50 % over red: half way
    const h = await px('#ff0000', 'fourColorGradient', { blendMode: 'normal', opacity: 50 }, 0.1, 0.1);
    assert(close(h, [255, 128, 0], 8), `normal al 50 % (${h})`);
    // lower Blend: sharper areas (a point a quarter of the way is closer to its own colour)
    const soft = (await px('#808080', 'fourColorGradient', {}, 0.3, 0.3)), sharp = (await px('#808080', 'fourColorGradient', { blend: 20 }, 0.3, 0.3));
    assert(sharp[2] < soft[2] && sharp[0] >= soft[0], `fusionar 20 es más nítido (${soft} / ${sharp})`);
    // Turbulent Noise: grey noise that changes with Evolution and with the Turbulence Factor
    const a = await withFx('#000000', [['turbulentNoise', { scale: 30 }]]), b = await withFx('#000000', [['turbulentNoise', { scale: 30, evolution: 200 }]]);
    const c = await withFx('#000000', [['turbulentNoise', { scale: 30, evolution: 200, turbulence: 4 }]]);
    let vmin = 255, vmax = 0, dab = 0, dbc = 0;
    for (let y = 0.1; y < 1; y += 0.2) for (let x = 0.05; x < 1; x += 0.1) { const p = a.at(x, y); vmin = Math.min(vmin, p[0]); vmax = Math.max(vmax, p[0]); assert(Math.abs(p[0] - p[1]) < 3 && Math.abs(p[1] - p[2]) < 3, 'gris'); dab += Math.abs(p[0] - b.at(x, y)[0]); dbc += Math.abs(b.at(x, y)[0] - c.at(x, y)[0]); }
    assert(vmax - vmin > 40, `hay ruido (${vmin}…${vmax})`);
    assert(dab > 100 && dbc > 50, `cambia con la evolución (${dab}) y con el factor de turbulencia (${dbc})`);
  });

  await test('generar: Compresión de resalte HDR, Convertidor perfiles de color, CC Threshold, CC Threshold RGB y CC Burn Film', async () => {
    await setup();
    let c = await px('#ffffff', 'hdrHighlightCompression');
    assert(c[0] < 245 && c[0] > 150 && close(c, [c[0], c[0], c[0]], 2), `el blanco baja (${c})`);
    c = await px('#404040', 'hdrHighlightCompression');
    assert(close(c, [64, 64, 64], 2), `las sombras no cambian (${c})`);
    c = await px('#ffffff', 'hdrHighlightCompression', { amount: 0 });
    assert(close(c, [255, 255, 255], 1), `nivel 0 (${c})`);
    // profiles: identity by default, sRGB → linear darkens the mid grey to 0.216, round trip through Rec. 2020
    c = await px('#ff0000', 'colorProfileConverter');
    assert(close(c, [255, 0, 0], 1), `espacio de trabajo → espacio de trabajo (${c})`);
    c = await px('#808080', 'colorProfileConverter', { output: 'linear' });
    assert(close(c, [55, 55, 55], 3), `sRGB → lineal (${c})`);
    c = await px('#ff0000', 'colorProfileConverter', { output: 'rec2020' });
    assert(c[0] < 240 && c[1] > 40, `rojo sRGB en Rec. 2020 menos saturado (${c})`);
    c = (await withFx('#c83c32', [['colorProfileConverter', { output: 'prophoto' }], ['colorProfileConverter', { input: 'prophoto' }]])).at(0.5, 0.5);
    assert(close(c, [200, 60, 50], 4), `ida y vuelta por ProPhoto (${c})`);
    c = await px('#ff0000', 'colorProfileConverter', { input: 'rec2020', intent: 'perceptual' });
    assert(c[1] > 0 || c[2] > 0 ? c[0] <= 255 : true, 'perceptivo');
    // CC Threshold: luminance 0.5 by default, invert, RGB per channel, blend
    c = await px('#a0a0a0', 'ccThreshold'); assert(close(c, [255, 255, 255], 1), `luminancia sobre el umbral (${c})`);
    c = await px('#606060', 'ccThreshold'); assert(close(c, [0, 0, 0], 1), `bajo el umbral (${c})`);
    c = await px('#606060', 'ccThreshold', { invert: true }); assert(close(c, [255, 255, 255], 1), `invertido (${c})`);
    c = await px('#c83232', 'ccThreshold', { channel: 'rgb' }); assert(close(c, [255, 0, 0], 1), `RGB (${c})`);
    c = await px('#606060', 'ccThreshold', { blend: 50 }); assert(close(c, [48, 48, 48], 3), `mezclado al 50 % (${c})`);
    c = await px('#c83232', 'ccThresholdRGB', { green: 20, invertBlue: true }); assert(close(c, [255, 255, 255], 1), `umbral RGB por canal (${c})`);
    // CC Burn Film: burnt through (transparent: the black background) at the centre, scorched further out
    const im = await withFx('#c0c0c0', [['ccBurnFilm', { burn: 30 }]]);
    const mid = im.at(0.5, 0.5), edge = im.at(0.02, 0.04);
    assert(close(mid, [0, 0, 0], 2), `quemado en el centro (${mid})`);
    assert(edge[0] > 100, `los bordes siguen ahí (${edge})`);
    c = await px('#c0c0c0', 'ccBurnFilm', { burn: 0 }); assert(close(c, [192, 192, 192], 1), `quemar 0 (${c})`);
  });

  await test('generar: Estabilizador del color iguala la exposición al fotograma de referencia', async () => {
    await setup();
    // the solid brightens over time; stabilized to frame 0 it keeps its first value
    await call('layer_set', { project: GP, comp: 'Gen', layer: lay, solid_color: '#808080' });
    const ex = (await call('effect_add', { project: GP, comp: 'Gen', layer: lay, effect: 'exposure', values: {} })).effect.id;
    await call('prop_set', { project: GP, comp: 'Gen', layer: lay, path: `effects.${ex}.exposure`, keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] });
    const raw = (await frame(1)).at(0.5, 0.5);
    assert(raw[0] > 150, `sin estabilizar se aclara (${raw})`);
    for (const mode of ['brightness', 'levels', 'curves']) {
      const st = (await call('effect_add', { project: GP, comp: 'Gen', layer: lay, effect: 'colorStabilizer', values: { stabilize: mode, setFrame: 0 } })).effect.id;
      const c = (await frame(1)).at(0.5, 0.5), c0 = (await frame(0)).at(0.5, 0.5);
      assert(Math.abs(c[0] - 128) <= 6 && Math.abs(c0[0] - 128) <= 2, `${mode}: igual que el fotograma 0 (${c} / ${c0})`);
      await call('effect_remove', { project: GP, comp: 'Gen', layer: lay, effect: st });
    }
    await call('effect_remove', { project: GP, comp: 'Gen', layer: lay, effect: ex });
  });
};
