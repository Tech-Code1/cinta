// MCP cases of the desenfoque effects: rendered pixels through comp_frame.
export default async ({ test, call, assert, imgOf, isColor, W, ff }) => {
  const MP = W('desenfoque.cinta');
  let made = false;
  const project = async () => { if (!made) { await call('project_new', { path: MP, width: 320, height: 180, fps: 30 }); made = true; } };
  const frame = async (comp) => { const r = await call('comp_frame', { project: MP, comp, time: 0, width: 320 }); assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`); return imgOf(r); };
  const comp = (name, bg = '#000000') => call('comp_new', { project: MP, name, width: 320, height: 180, fps: 30, duration: 1, bg });
  const solid = async (c, color, width = 320, height = 180, name) => (await call('layer_add', { project: MP, comp: c, type: 'solid', color, width, height, ...(name ? { name } : {}) })).layer.id;
  const fx = async (c, layer, effect, values = {}) => (await call('effect_add', { project: MP, comp: c, layer, effect, values })).effect.id;
  const unfx = (c, layer, effect) => call('effect_remove', { project: MP, comp: c, layer, effect });
  const px = (im, x, y) => im.at(x / 320, y / 180);

  await test('desenfoque: claves de color y de luminancia como After Effects (azul por defecto, más oscura, bordes)', async () => {
    await project();
    await comp('Claves', '#ff0000');
    const blue = await solid('Claves', '#0000ff', 160, 180);
    await call('prop_set', { project: MP, comp: 'Claves', layer: blue, path: 'position', value: [80, 90] });
    // Color Key's default key colour is blue: tolerance 0 keys out exactly #0000ff (the red background shows)
    const ck = await fx('Claves', blue, 'colorKey');
    let im = await frame('Claves');
    assert(isColor(px(im, 40, 90), [255, 0, 0]), `azul eliminado con los valores por defecto: ${px(im, 40, 90)}`);
    await unfx('Claves', blue, ck);
    im = await frame('Claves');
    assert(isColor(px(im, 40, 90), [0, 0, 255]), 'sin la clave vuelve el azul');
    // Luma Key, «key out darker» with threshold 0 changes nothing; with 60 the dark blue (luma ≈ 29) goes
    const lk = await fx('Claves', blue, 'lumaKey');
    im = await frame('Claves');
    assert(isColor(px(im, 40, 90), [0, 0, 255]), 'umbral 0: nada eliminado');
    await call('effect_set', { project: MP, comp: 'Claves', layer: blue, effect: lk, values: { threshold: 60 } });
    im = await frame('Claves');
    assert(isColor(px(im, 40, 90), [255, 0, 0]), `umbral 60: azul eliminado (${px(im, 40, 90)})`);
    // Key Out Brighter with the same threshold keeps it
    await call('effect_set', { project: MP, comp: 'Claves', layer: blue, effect: lk, values: { type: 'light' } });
    im = await frame('Claves');
    assert(isColor(px(im, 40, 90), [0, 0, 255]), 'clave más brillante: el azul oscuro se queda');
  });

  await test('desenfoque: desenfoques con los valores por defecto de After Effects y al aplicarlos', async () => {
    await project();
    await comp('Blur');
    const sq = await solid('Blur', '#ffffff', 80, 80);
    // the defaults leave the layer unchanged (blurriness 0, length 0, amount 0)
    for (const e of ['gaussianBlur', 'directionalBlur', 'sharpen', 'boxBlur', 'channelBlur', 'median', 'minimax']) {
      const id = await fx('Blur', sq, e);
      const im = await frame('Blur');
      assert(isColor(px(im, 160, 90), [255, 255, 255]) && isColor(px(im, 110, 90), [0, 0, 0]) && isColor(px(im, 195, 90), [255, 255, 255]), `${e} por defecto no cambia nada`);
      await unfx('Blur', sq, id);
    }
    // Box Blur radius 10, 3 iterations: the edge (x = 120) is grey, the centre stays white
    let id = await fx('Blur', sq, 'boxBlur', { radius: 10, repeat: false });
    let im = await frame('Blur');
    const e = px(im, 120, 90)[0];
    assert(e > 60 && e < 200 && px(im, 160, 90)[0] > 240, `borde ${e}, centro ${px(im, 160, 90)[0]}`);
    await unfx('Blur', sq, id);
    // horizontal only: the top edge stays sharp
    id = await fx('Blur', sq, 'boxBlur', { radius: 10, dims: 'h', repeat: false });
    im = await frame('Blur');
    assert(px(im, 160, 48)[0] < 10 && px(im, 160, 54)[0] > 240 && px(im, 120, 90)[0] > 60, 'solo horizontal');
    await unfx('Blur', sq, id);
    // Channel Blur: only red is blurred (with the transparent outside) → inside the edge red drops, green stays
    id = await fx('Blur', sq, 'channelBlur', { red: 30, repeat: false });
    im = await frame('Blur');
    const q = px(im, 123, 90);
    assert(q[0] < 220 && q[1] > 250, `borde sin rojo ${q}`);
    await unfx('Blur', sq, id);
    // on an adjustment layer (the whole frame): Minimax maximum of 10 px grows the white square, minimum shrinks it
    const adj = (await call('layer_add', { project: MP, comp: 'Blur', type: 'adjustment' })).layer.id;
    id = await fx('Blur', adj, 'minimax', { radius: 10 });
    im = await frame('Blur');
    assert(isColor(px(im, 115, 90), [255, 255, 255]) && isColor(px(im, 105, 90), [0, 0, 0]), 'máximo: el cuadrado crece 10 px');
    await call('effect_set', { project: MP, comp: 'Blur', layer: adj, effect: id, values: { op: 'min' } });
    im = await frame('Blur');
    assert(isColor(px(im, 125, 90), [0, 0, 0]) && isColor(px(im, 160, 90), [255, 255, 255]), 'mínimo: el cuadrado encoge');
    await unfx('Blur', adj, id);
    // Channel Blur of red only: a red fringe outside the square, no green there
    id = await fx('Blur', adj, 'channelBlur', { red: 30 });
    im = await frame('Blur');
    const f = px(im, 115, 90);
    assert(f[0] > 20 && f[1] < 5, `franja roja ${f}`);
    await unfx('Blur', adj, id);
  });

  await test('desenfoque: canales (cambiar, establecer, aritmética, compuesto sólido)', async () => {
    await project();
    await comp('Canal', '#000000');
    const L = await solid('Canal', '#ff8000');
    // Shift Channels: red from blue → blue is 0 → no red; blue from red → 255
    let id = await fx('Canal', L, 'shiftChannels', { red: 'blue', blue: 'red' });
    let im = await frame('Canal');
    assert(isColor(px(im, 160, 90), [0, 128, 255]), `canales cambiados ${px(im, 160, 90)}`);
    await unfx('Canal', L, id);
    // Set Channels with no layers: the same image; red from Full → 255
    id = await fx('Canal', L, 'setChannels', { green: 'off' });
    im = await frame('Canal');
    assert(isColor(px(im, 160, 90), [255, 0, 0]), `verde desactivado ${px(im, 160, 90)}`);
    await unfx('Canal', L, id);
    // Arithmetic: the default (Xor with 0) changes nothing; Subtract 128 on green → 0
    id = await fx('Canal', L, 'arithmetic');
    im = await frame('Canal');
    assert(isColor(px(im, 160, 90), [255, 128, 0]), 'Xor 0: igual');
    await call('effect_set', { project: MP, comp: 'Canal', layer: L, effect: id, values: { op: 'subtract', green: 128, blue: 0 } });
    im = await frame('Canal');
    assert(px(im, 160, 90)[1] < 6 && px(im, 160, 90)[0] > 250, `restar ${px(im, 160, 90)}`);
    await unfx('Canal', L, id);
    // Solid Composite: source at 50 % over white
    id = await fx('Canal', L, 'solidComposite', { sourceOpacity: 50 });
    im = await frame('Canal');
    assert(isColor(px(im, 160, 90), [255, 191, 128], 20), `sobre blanco al 50 % ${px(im, 160, 90)}`);
    await unfx('Canal', L, id);
  });

  await test('desenfoque: incrustación (clave de color lineal, extraer, mate de diferencia)', async () => {
    await project();
    await comp('Inc', '#ff0000');
    const blue = await solid('Inc', '#0000ff', 160, 180);
    await call('prop_set', { project: MP, comp: 'Inc', layer: blue, path: 'position', value: [80, 90] });
    const white = await solid('Inc', '#ffffff', 160, 180, 'Blanco');
    await call('prop_set', { project: MP, comp: 'Inc', layer: white, path: 'position', value: [240, 90] });
    // Linear Color Key keys out its default blue (red background shows), the matte view is black there
    let id = await fx('Inc', blue, 'linearColorKey');
    let im = await frame('Inc');
    assert(isColor(px(im, 80, 90), [255, 0, 0]), `azul eliminado ${px(im, 80, 90)}`);
    await call('effect_set', { project: MP, comp: 'Inc', layer: blue, effect: id, values: { operation: 'keep' } });
    im = await frame('Inc');
    assert(isColor(px(im, 80, 90), [0, 0, 255]), 'conservar colores: el azul se queda');
    await unfx('Inc', blue, id);
    // Extract: white point 200 removes the white layer, black point 30 removes the dark blue
    id = await fx('Inc', white, 'extract', { white: 200 });
    im = await frame('Inc');
    assert(isColor(px(im, 240, 90), [255, 0, 0]), 'blanco extraído');
    await unfx('Inc', white, id);
    // Difference Matte against itself-like plate: a blue layer vs the blue layer → transparent
    id = await fx('Inc', white, 'differenceMatte', { layer: blue });
    im = await frame('Inc');
    assert(isColor(px(im, 240, 90), [255, 255, 255]), 'blanco frente a azul: se queda');
    await call('effect_set', { project: MP, comp: 'Inc', layer: white, effect: id, values: { view: 'matte' } });
    im = await frame('Inc');
    assert(isColor(px(im, 240, 90), [255, 255, 255]), 'mate blanco donde difiere');
    await unfx('Inc', white, id);
  });

  await test('desenfoque: ruido HLS, ruido alfa, mediana y polvo y rascaduras', async () => {
    await project();
    await comp('Ruido', '#000000');
    const L = await solid('Ruido', '#808080');
    const spread = (im) => { let lo = 255, hi = 0; for (let x = 20; x < 300; x += 7) for (let y = 20; y < 160; y += 7) { const v = px(im, x, y)[0]; lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
    let id = await fx('Ruido', L, 'noiseHLS');
    let im = await frame('Ruido');
    assert(spread(im) < 4, 'Ruido HLS por defecto (0 %): igual');
    await call('effect_set', { project: MP, comp: 'Ruido', layer: L, effect: id, values: { lightness: 80 } });
    im = await frame('Ruido');
    const s = spread(im);
    assert(s > 60, `luminosidad 80 %: ruido ${s}`);
    // median of 3 px cleans it (much less spread)
    const md = await fx('Ruido', L, 'median', { radius: 3 });
    im = await frame('Ruido');
    assert(spread(im) < s * 0.8, `mediana: ${spread(im)} < ${s}`);
    await unfx('Ruido', L, md);
    // Dust & Scratches (threshold 0) also replaces the noisy pixels by their median
    const du = await fx('Ruido', L, 'dustScratches', { radius: 3 });
    im = await frame('Ruido');
    assert(spread(im) < s * 0.8, `polvo y rascaduras: ${spread(im)} < ${s}`);
    await unfx('Ruido', L, du);
    await unfx('Ruido', L, id);
    // Noise Alpha (Add, 100 %) over the black background: some pixels darker
    id = await fx('Ruido', L, 'noiseAlpha', { amount: 100, original: 'scale' });
    im = await frame('Ruido');
    assert(spread(im) > 40, `alfa con ruido ${spread(im)}`);
    await unfx('Ruido', L, id);
  });

  await test('desenfoque (ronda 2): Cálculos, Fusionar, Combinador de canales, Niveles alfa, Aritmética compuesta', async () => {
    await project();
    await comp('Canal2', '#000000');
    const L = await solid('Canal2', '#ff8000');
    const B = await solid('Canal2', '#0000ff', 40, 40, 'Azul');
    await call('prop_set', { project: MP, comp: 'Canal2', layer: B, path: 'position', value: [20, 20] });
    const c = () => frame('Canal2').then((im) => px(im, 160, 90));
    // Calculations: the red channel as grey, then the luminance; the blue layer (stretched) at 100 % over it
    let id = await fx('Canal2', L, 'calculations');
    assert(isColor(await c(), [255, 128, 0]), 'Cálculos por defecto: igual');
    await call('effect_set', { project: MP, comp: 'Canal2', layer: L, effect: id, values: { inChannel: 'red' } });
    assert(isColor(await c(), [255, 255, 255]), 'canal rojo');
    await call('effect_set', { project: MP, comp: 'Canal2', layer: L, effect: id, values: { inChannel: 'gray' } });
    assert(isColor(await c(), [151, 151, 151], 6), `gris ${await c()}`);
    await call('effect_set', { project: MP, comp: 'Canal2', layer: L, effect: id, values: { inChannel: 'rgba', layer: B, layerOpacity: 100, mode: 'add' } });
    assert(isColor(await c(), [255, 128, 255]), `añadir la segunda capa ${await c()}`);
    await unfx('Canal2', L, id);
    // Blend: 100 % original by default; crossfade to the (centred) blue layer at 0 % and 50 %
    id = await fx('Canal2', L, 'blend', { layer: B });
    assert(isColor(await c(), [255, 128, 0]), 'Fusionar por defecto: igual');
    await call('effect_set', { project: MP, comp: 'Canal2', layer: L, effect: id, values: { original: 0 } });
    assert(isColor(await c(), [0, 0, 255]), `fundido cruzado total ${await c()}`);
    await call('effect_set', { project: MP, comp: 'Canal2', layer: L, effect: id, values: { original: 50 } });
    assert(isColor(await c(), [128, 64, 128], 8), `fundido al 50 % ${await c()}`);
    await unfx('Canal2', L, id);
    // Channel Combiner's default, RGB to HLS: orange is hue 30° (21), lightness 0.5, saturation 1
    id = await fx('Canal2', L, 'channelCombiner');
    assert(isColor(await c(), [21, 128, 255], 4), `RGB a HLS ${await c()}`);
    await unfx('Canal2', L, id);
    // Alpha Levels: output white 100 over black
    id = await fx('Canal2', L, 'alphaLevels', { outWhite: 100 });
    assert(isColor(await c(), [100, 50, 0], 4), `niveles alfa ${await c()}`);
    await unfx('Canal2', L, id);
    // Compound Arithmetic: Add with the blue layer, clipped
    id = await fx('Canal2', L, 'compoundArithmetic', { layer: B, op: 'add' });
    assert(isColor(await c(), [255, 128, 255]), `sumar ${await c()}`);
    await unfx('Canal2', L, id);
  });

  await test('desenfoque (ronda 2): Clave de diferencia de color, Rango de color, Supresor de derrames', async () => {
    await project();
    await comp('Inc2', '#ff0000');
    const blue = await solid('Inc2', '#0000ff', 160, 180);
    await call('prop_set', { project: MP, comp: 'Inc2', layer: blue, path: 'position', value: [80, 90] });
    const sp = await solid('Inc2', '#4060ff', 160, 180, 'Derrame');
    await call('prop_set', { project: MP, comp: 'Inc2', layer: sp, path: 'position', value: [240, 90] });
    let id = await fx('Inc2', blue, 'colorDifferenceKey');
    let im = await frame('Inc2');
    assert(isColor(px(im, 80, 90), [255, 0, 0]), `azul eliminado ${px(im, 80, 90)}`);
    await call('effect_set', { project: MP, comp: 'Inc2', layer: blue, effect: id, values: { view: 'matteCorrected' } });
    im = await frame('Inc2');
    assert(isColor(px(im, 80, 90), [0, 0, 0]), 'mate negro');
    await unfx('Inc2', blue, id);
    id = await fx('Inc2', blue, 'colorRange');
    im = await frame('Inc2');
    assert(isColor(px(im, 80, 90), [0, 0, 255]), 'Rango de color por defecto (gris medio): el azul se queda');
    await call('effect_set', { project: MP, comp: 'Inc2', layer: blue, effect: id, values: { space: 'rgb', min1: 0, max1: 20, min2: 0, max2: 20, min3: 230, max3: 255 } });
    im = await frame('Inc2');
    assert(isColor(px(im, 80, 90), [255, 0, 0]), 'azul dentro del rango: eliminado');
    await unfx('Inc2', blue, id);
    // Keylight: its default screen colour is black (keys nothing); with a blue screen the blue layer goes
    id = await fx('Inc2', blue, 'keylight');
    im = await frame('Inc2');
    assert(isColor(px(im, 80, 90), [0, 0, 255]), `Keylight por defecto: nada eliminado ${px(im, 80, 90)}`);
    await call('effect_set', { project: MP, comp: 'Inc2', layer: blue, effect: id, values: { screen: '#0000ff' } });
    im = await frame('Inc2');
    assert(isColor(px(im, 80, 90), [255, 0, 0], 12), `Keylight azul: eliminado ${px(im, 80, 90)}`);
    await unfx('Inc2', blue, id);
    // Inner/Outer Key with two masks (mode None): kept inside the foreground one, removed outside the background one
    await comp('IOK', '#ff0000');
    const wl = await solid('IOK', '#ffffff');
    await call('mask_add', { project: MP, comp: 'IOK', layer: wl, shape: 'rect', x: 100, y: 40, width: 120, height: 100, mode: 'none', name: 'Dentro' });
    await call('mask_add', { project: MP, comp: 'IOK', layer: wl, shape: 'rect', x: 60, y: 20, width: 200, height: 140, mode: 'none', name: 'Fuera' });
    im = await frame('IOK');
    assert(isColor(px(im, 20, 90), [255, 255, 255]), 'máscaras sin modo: la capa entera');
    id = await fx('IOK', wl, 'innerOuterKey', { fg: 'Dentro', bg: 'Fuera' });
    im = await frame('IOK');
    assert(isColor(px(im, 20, 90), [255, 0, 0]) && isColor(px(im, 160, 90), [255, 255, 255]), `fuera eliminado ${px(im, 20, 90)}, dentro ${px(im, 160, 90)}`);
    await unfx('IOK', wl, id);
    id = await fx('Inc2', sp, 'spillSuppression');
    im = await frame('Inc2');
    assert(isColor(px(im, 240, 90), [64, 96, 96], 4), `azul limitado al verde ${px(im, 240, 90)}`);
    await unfx('Inc2', sp, id);
  });

  await test('desenfoque (ronda 2): Añadir / Quitar granulado y desenfoques CC', async () => {
    await project();
    await comp('Grano', '#000000');
    const G = await solid('Grano', '#808080');
    const spread = (im, x0, x1, y0, y1) => { let lo = 255, hi = 0; for (let x = x0; x < x1; x += 5) for (let y = y0; y < y1; y += 5) { const v = px(im, x, y)[0]; lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
    // Add Grain's Preview: grain inside the 200 × 200 box in the middle, untouched outside
    let id = await fx('Grano', G, 'addGrain');
    let im = await frame('Grano');
    assert(spread(im, 80, 240, 20, 160) > 30 && isColor(px(im, 20, 90), [128, 128, 128], 2), `granulado en el cuadro ${spread(im, 80, 240, 20, 160)}, fuera ${px(im, 20, 90)}`);
    await call('effect_set', { project: MP, comp: 'Grano', layer: G, effect: id, values: { view: 'final' } });
    im = await frame('Grano');
    const s = spread(im, 4, 316, 4, 176);
    assert(s > 30 && spread(im, 4, 50, 4, 176) > 20, `salida final: en toda la capa ${s}`);
    // Remove Grain (final output) smooths it
    const rg = await fx('Grano', G, 'removeGrain', { view: 'final', reduction: 5 });
    im = await frame('Grano');
    assert(spread(im, 4, 316, 4, 176) < s * 0.7, `quitar granulado: ${spread(im, 4, 316, 4, 176)} < ${s}`);
    await unfx('Grano', G, rg);
    await unfx('Grano', G, id);
    // CC blurs on a white square (120…200 × 50…130) over black: inside the layer its edges get the transparent outside
    await comp('CC');
    const sq = await solid('CC', '#ffffff', 80, 80);
    const at = (im, x, y) => px(im, x, y)[0];
    // Radial Fast Blur with its centre right of the layer: the right part streaks towards the (empty) outside
    id = await fx('CC', sq, 'ccRadialFastBlur', { center: [200, 40] });
    im = await frame('CC');
    assert(at(im, 196, 90) < 235 && at(im, 125, 90) > 245, `CC Radial Fast Blur: estela ${at(im, 196, 90)}, lejos ${at(im, 125, 90)}`);
    await unfx('CC', sq, id);
    id = await fx('CC', sq, 'ccCrossBlur', { radiusX: 20, repeat: false });
    im = await frame('CC');
    assert(at(im, 198, 90) < 235 && at(im, 160, 52) > 245, `CC Cross Blur: horizontal ${at(im, 198, 90)}, vertical ${at(im, 160, 52)}`);
    await unfx('CC', sq, id);
    id = await fx('CC', sq, 'ccRadialBlur');
    im = await frame('CC');
    assert(at(im, 198, 90) > 250, 'CC Radial Blur cantidad 0: igual');
    await call('effect_set', { project: MP, comp: 'CC', layer: sq, effect: id, values: { type: 'centeredZoom', amount: 50 } });
    im = await frame('CC');
    assert(at(im, 198, 90) < 235, `CC Radial Blur zoom ${at(im, 198, 90)}`);
    await unfx('CC', sq, id);
    id = await fx('CC', sq, 'ccVectorBlur', { amount: 30, type: 'directionCenter' });
    im = await frame('CC');
    assert(at(im, 198, 90) < 235 && at(im, 125, 90) > 245, `CC Vector Blur: borde ${at(im, 198, 90)}`);
    await unfx('CC', sq, id);
    // CC Simple Wire Removal on a thin white wire: between A and B it is gone, beyond them it stays
    const wire = await solid('CC', '#ffffff', 4, 180, 'Cable');
    await call('prop_set', { project: MP, comp: 'CC', layer: wire, path: 'position', value: [300, 90] });
    id = await fx('CC', wire, 'ccSimpleWireRemoval', { thickness: 8 });
    im = await frame('CC');
    assert(at(im, 300, 90) < 30 && at(im, 300, 10) > 240, `cable quitado ${at(im, 300, 90)}, fuera del tramo ${at(im, 300, 10)}`);
    await unfx('CC', wire, id);
  });

  await test('desenfoque: CC Force Motion Blur promedia la capa de composición a lo largo del obturador', async () => {
    // inside: an 8 px white square crossing at 144 px/s (10 fps); outside: the comp layer, which doesn't move
    await project();
    const pre = (await call('comp_new', { project: MP, name: 'FmbIn', width: 64, height: 48, fps: 10, duration: 1, bg: '#000000' })).comp.id;
    await call('comp_new', { project: MP, name: 'Fmb', width: 64, height: 48, fps: 10, duration: 1, bg: '#000000' });
    const sq = (await call('layer_add', { project: MP, comp: 'FmbIn', type: 'solid', color: '#ffffff', width: 8, height: 8 })).layer.id;
    await call('prop_set', { project: MP, comp: 'FmbIn', layer: sq, path: 'position', keys: [{ t: 0, v: [-40, 24] }, { t: 1, v: [104, 24] }] });
    const L = (await call('layer_add', { project: MP, comp: 'Fmb', type: 'comp', comp_id: pre })).layer.id;
    // the row through the square: its centre of mass and how many pixels are lit
    const at = async () => {
      const r = await call('comp_frame', { project: MP, comp: 'Fmb', time: 0.5, width: 64 });
      assert(!r.layerErrors, JSON.stringify(r.layerErrors));
      const im = imgOf(r), row = Array.from({ length: 64 }, (_, x) => im.at((x + 0.5) / 64, 0.5)[0]), sum = row.reduce((a, v) => a + v, 0);
      return { c: row.reduce((a, v, x) => a + v * (x + 0.5), 0) / sum, lit: row.filter((v) => v > 8).length, sum, row };
    };
    const sharp = await at();
    assert(Math.abs(sharp.c - 31.5) < 1 && sharp.lit === 8, `sin el efecto: cuadrado de 8 px (centro ${sharp.c.toFixed(1)}, ${sharp.lit} px)`);
    // default: 8 samples over 180° (0.05 s) at now + k/8 of it: the square travels 7.2 px to the right — a ramp twice as
    // wide whose centre moves 3.5/8 × 7.2 px on, with the same light
    const id = (await call('effect_add', { project: MP, comp: 'Fmb', layer: L, effect: 'ccForceMotionBlur' })).effect.id;
    let b = await at();
    assert(Math.abs(b.c - sharp.c - 3.15) < 0.5 && b.lit >= 13 && b.lit <= 16 && Math.abs(b.sum / sharp.sum - 1) < 0.05, `estela hacia delante: centro ${b.c.toFixed(1)}, ${b.lit} px (${b.row.slice(26, 44).join(' ')})`);
    // phase −180°: the samples start half a frame earlier: centre 4.5/8 × 7.2 px to the left
    await call('effect_set', { project: MP, comp: 'Fmb', layer: L, effect: id, values: { shutterPhase: -180 } });
    b = await at();
    assert(Math.abs(sharp.c - b.c - 4.05) < 0.5 && b.lit >= 13, `fase −180°: estela hacia atrás, centro ${b.c.toFixed(1)}`);
    // one sample: no blur at all
    await call('effect_set', { project: MP, comp: 'Fmb', layer: L, effect: id, values: { shutterPhase: 0, samples: 1 } });
    b = await at();
    assert(b.lit === 8 && Math.abs(b.c - sharp.c) < 0.2, `una muestra: nítido (${b.lit} px)`);
  });

  await test('desenfoque: Aplicar granulado mide el grano de la capa de origen (intensidad, tamaño, monocromo) y lo compensa', async () => {
    await project();
    // grain sources: fine grey grain (uniform ±35 → σ ≈ 20) and the same kind three times bigger (nearest upscale)
    const grain = "geq=lum='128+70*(random(1)-0.5)'";
    ff('-f', 'lavfi', '-i', `color=c=gray:s=160x120,format=gray,${grain}`, '-frames:v', '1', W('mg-fine.png'));
    ff('-f', 'lavfi', '-i', `color=c=gray:s=54x40,format=gray,${grain},scale=162:120:flags=neighbor,crop=160:120:0:0`, '-frames:v', '1', W('mg-big.png'));
    await call('comp_new', { project: MP, name: 'MG', width: 160, height: 120, fps: 10, duration: 1, bg: '#000000' });
    const fine = (await call('layer_add', { project: MP, comp: 'MG', type: 'image', media_path: W('mg-fine.png'), name: 'Fino' })).layer.id;
    const big = (await call('layer_add', { project: MP, comp: 'MG', type: 'image', media_path: W('mg-big.png'), name: 'Grueso' })).layer.id;
    await call('layer_set', { project: MP, comp: 'MG', layer: fine, hidden: true });
    await call('layer_set', { project: MP, comp: 'MG', layer: big, hidden: true });
    // a copy of the fine grain (a layer can't be its own noise source)
    const fine2 = (await call('layer_add', { project: MP, comp: 'MG', type: 'image', media_path: W('mg-fine.png'), name: 'Fino 2' })).layer.id;
    await call('layer_set', { project: MP, comp: 'MG', layer: fine2, hidden: true });
    const tgt = (await call('layer_add', { project: MP, comp: 'MG', type: 'solid', color: '#808080', width: 160, height: 120, name: 'T' })).layer.id;
    /** grain statistics of the frame's middle: σ per channel, neighbour correlation, max channel difference */
    const stats = async () => {
      const r = await call('comp_frame', { project: MP, comp: 'MG', time: 0, width: 160 });
      assert(!r.layerErrors, JSON.stringify(r.layerErrors));
      const im = imgOf(r), px = [];
      for (let y = 20; y < 100; y++) for (let x = 20; x < 140; x++) px.push(im.at((x + 0.5) / 160, (y + 0.5) / 120));
      const ch = [0, 1, 2].map((c) => px.map((q) => q[c])), m = ch.map((v) => v.reduce((a, b) => a + b, 0) / v.length);
      const sd = ch.map((v, c) => Math.sqrt(v.reduce((a, b) => a + (b - m[c]) ** 2, 0) / v.length));
      let a = 0; for (let i = 0; i + 1 < ch[0].length; i++) if ((i + 1) % 120) a += (ch[0][i] - m[0]) * (ch[0][i + 1] - m[0]);
      return { sd, mean: m, rho: a / (ch[0].length - 80) / (sd[0] ** 2 || 1), mono: Math.max(...px.map((q) => Math.abs(q[0] - q[1]) + Math.abs(q[1] - q[2]))) };
    };
    // the source itself: what Match Grain should reproduce
    await call('layer_set', { project: MP, comp: 'MG', layer: tgt, hidden: true });
    await call('layer_set', { project: MP, comp: 'MG', layer: fine, hidden: false });
    const ref = await stats();
    await call('layer_set', { project: MP, comp: 'MG', layer: fine, hidden: true });
    await call('layer_set', { project: MP, comp: 'MG', layer: tgt, hidden: false });
    const id = (await call('effect_add', { project: MP, comp: 'MG', layer: tgt, effect: 'matchGrain', values: { source: fine, view: 'final' } })).effect.id;
    const a = await stats();
    assert(Math.abs(a.sd[0] / ref.sd[0] - 1) < 0.15 && a.mono <= 3 && ref.mono <= 3 && Math.abs(a.mean[0] - 128) < 4, `grano fino: σ ${a.sd.map((v) => v.toFixed(1))} (origen ${ref.sd.map((v) => v.toFixed(1))}), monocromo (${a.mono}; origen ${ref.mono}), media ${a.mean[0].toFixed(0)}`);
    // the big grain: much more correlated neighbours
    await call('effect_set', { project: MP, comp: 'MG', layer: tgt, effect: id, values: { source: big } });
    const b = await stats();
    assert(b.rho > a.rho + 0.3 && Math.abs(b.sd[0] / ref.sd[0] - 1) < 0.25, `grano grueso: correlación ${b.rho.toFixed(2)} (fino ${a.rho.toFixed(2)}), σ ${b.sd[0].toFixed(1)}`);
    // the grainy layer matched to its own grain: Compensate 100 % adds nothing, 0 % doubles the variance
    await call('effect_remove', { project: MP, comp: 'MG', layer: tgt, effect: id });
    await call('layer_set', { project: MP, comp: 'MG', layer: tgt, hidden: true });
    await call('layer_set', { project: MP, comp: 'MG', layer: fine, hidden: false });
    const id2 = (await call('effect_add', { project: MP, comp: 'MG', layer: fine, effect: 'matchGrain', values: { source: big, view: 'final', compensate: 0 } })).effect.id;
    const c0 = await stats();
    await call('effect_set', { project: MP, comp: 'MG', layer: fine, effect: id2, values: { source: fine2, compensate: 0 } });
    const c1 = await stats();
    await call('effect_set', { project: MP, comp: 'MG', layer: fine, effect: id2, values: { compensate: 100 } });
    const c2 = await stats();
    assert(Math.abs(c1.sd[0] / ref.sd[0] - Math.SQRT2) < 0.2 && Math.abs(c2.sd[0] / ref.sd[0] - 1) < 0.08 && c0.sd[0] > ref.sd[0] * 1.2, `compensar: 0 % → σ ×${(c1.sd[0] / ref.sd[0]).toFixed(2)}, 100 % → ×${(c2.sd[0] / ref.sd[0]).toFixed(2)}`);
    // Preview (the default) only inside the 200 × 200 box round the centre: here, all of the layer
    await call('effect_set', { project: MP, comp: 'MG', layer: fine, effect: id2, values: { view: 'preview', compensate: 0, boxW: 50, boxH: 50 } });
    const r = await call('comp_frame', { project: MP, comp: 'MG', time: 0, width: 160 });
    const im = imgOf(r), sdAt = (x0, y0) => { const v = []; for (let y = y0; y < y0 + 16; y++) for (let x = x0; x < x0 + 16; x++) v.push(im.at((x + 0.5) / 160, (y + 0.5) / 120)[0]); const m = v.reduce((p, q) => p + q, 0) / v.length; return Math.sqrt(v.reduce((p, q) => p + (q - m) ** 2, 0) / v.length); };
    assert(sdAt(72, 52) > sdAt(4, 4) * 1.2, `previsualización: grano solo dentro de la caja (${sdAt(72, 52).toFixed(1)} frente a ${sdAt(4, 4).toFixed(1)})`);
  });
};
