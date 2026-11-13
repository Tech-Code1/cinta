// MCP cases of the color effects: rendered pixels through comp_frame.
export default async ({ test, call, callErr, assert, imgOf, decodePng, isColor, near, ff, probe, W, FF, root }) => {
  const CP = W('color.cinta');
  let lay = null;
  /** centre pixel of a full-frame solid of colour `hex` with one effect applied */
  const px = async (hex, effect, values = {}, extra = []) => {
    await call('layer_set', { project: CP, comp: 'Col', layer: lay, solid_color: hex });
    const ids = [];
    for (const [e, v] of [...extra, [effect, values]]) ids.push((await call('effect_add', { project: CP, comp: 'Col', layer: lay, effect: e, values: v })).effect.id);
    const r = await call('comp_frame', { project: CP, comp: 'Col', time: 0, width: 64 });
    assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`);
    for (const id of ids) await call('effect_remove', { project: CP, comp: 'Col', layer: lay, effect: id });
    return imgOf(r).at(0.5, 0.5).slice(0, 3);
  };
  const close = (a, b, tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const setup = async () => {
    if (lay) return;
    await call('project_new', { path: CP, width: 64, height: 48, fps: 30 });
    await call('comp_new', { project: CP, name: 'Col', width: 64, height: 48, fps: 30, duration: 1, bg: '#000000' });
    lay = (await call('layer_add', { project: CP, comp: 'Col', type: 'solid', color: '#808080', width: 64, height: 48, name: 'S' })).layer.id;
  };

  await test('color: Tono/Saturación por rangos y coloreado, Exposición en luz lineal, Tritono y Filtro de fotografía', async () => {
    await setup();
    // the Reds range turned 120°: red becomes green, cyan is left alone
    let c = await px('#c83232', 'hueSat', { redHue: 120 });
    assert(close(c, [50, 200, 50], 5), `rojos +120° → verde (${c})`);
    c = await px('#32c8c8', 'hueSat', { redHue: 120 });
    assert(close(c, [50, 200, 200], 3), `el cian no está en los rojos (${c})`);
    // master saturation −100: grey with the HSL lightness; lightness +100: white
    c = await px('#c83232', 'hueSat', { sat: -100 });
    assert(close(c, [125, 125, 125], 3), `saturación −100 (${c})`);
    c = await px('#c83232', 'hueSat', { light: 100 });
    assert(close(c, [255, 255, 255], 2), `luminosidad +100 (${c})`);
    // Colorize with After Effects' defaults (0°, 25 %): grey 50 % → (159, 96, 96)
    c = await px('#808080', 'hueSat', { colorize: true });
    assert(close(c, [160, 96, 96], 4), `colorear por defecto (${c})`);
    // Exposure +1 in linear light: sRGB 128 → linear 0.216 ×2 → 176; bypassed: ×2 on the encoded value
    c = await px('#808080', 'exposure', { exposure: 1 });
    assert(close(c, [176, 176, 176], 3), `exposición +1 lineal (${c})`);
    c = await px('#404040', 'exposure', { exposure: 1, bypass: true });
    assert(close(c, [128, 128, 128], 2), `exposición +1 sin conversión (${c})`);
    c = await px('#808080', 'exposure', { channels: 'individual', rExposure: 1 });
    assert(close(c, [176, 128, 128], 3), `exposición solo del rojo (${c})`);
    // Tritone's default midtones (127, 100, 70) on 50 % grey
    c = await px('#808080', 'tritone');
    assert(close(c, [128, 101, 71], 4), `tritono: medios tonos (${c})`);
    // Photo Filter, Warming (85) at 25 % on white, luminosity preserved
    c = await px('#ffffff', 'photoFilter');
    assert(close(c, [255, 252, 218], 4), `filtro cálido (85) (${c})`);
    c = await px('#ffffff', 'photoFilter', { filter: 'custom', color: '#0000ff', density: 100, preserve: false });
    assert(close(c, [0, 0, 255], 2), `filtro personalizado azul al 100 % (${c})`);
  });

  await test('color: Cambiar a color (ajustar / transformar), Invertir por canales y Compansor HDR', async () => {
    await setup();
    // a red a little off the From colour: Setting takes the target hue exactly, Transforming moves it by To − From
    let c = await px('#c83c32', 'changeToColor', { from: '#c83232', to: '#32c832' });
    assert(c[1] > c[0] && c[1] > c[2] && Math.abs(c[0] - c[2]) < 6, `ajustar al color: tono del verde (${c})`);
    c = await px('#c83232', 'changeToColor', { from: '#c83232', to: '#3232c8', changeBy: 'transform' });
    assert(close(c, [50, 50, 200], 6), `transformar al color (${c})`);
    // Invert: RGB, one channel, hue (+180°), lightness, luminance (YIQ) and blend
    c = await px('#c83232', 'invert');
    assert(close(c, [55, 205, 205], 2), `invertir RGB (${c})`);
    c = await px('#c83232', 'invert', { channel: 'green' });
    assert(close(c, [200, 205, 50], 2), `invertir verde (${c})`);
    c = await px('#c83232', 'invert', { channel: 'hue' });
    assert(close(c, [50, 200, 200], 3), `invertir tono (${c})`);
    c = await px('#c83232', 'invert', { channel: 'lightness' });
    assert(close(c, [205, 55, 55], 3), `invertir luminosidad (${c})`);
    c = await px('#808080', 'invert', { channel: 'luminance' });
    assert(close(c, [127, 127, 127], 3), `invertir luminancia del gris medio (${c})`);
    c = await px('#c83232', 'invert', { blend: 50 });
    assert(close(c, [128, 128, 128], 3), `invertir mezclado al 50 % (${c})`);
    // HDR Compander: compress (v / 2) then expand back
    c = await px('#808080', 'hdrCompander', { gain: 2 });
    assert(close(c, [64, 64, 64], 2), `comprimir con ganancia 2 (${c})`);
    c = await px('#808080', 'hdrCompander', { mode: 'expand', gain: 2 }, [['hdrCompander', { gain: 2 }]]);
    assert(close(c, [128, 128, 128], 3), `comprimir y expandir devuelve el valor (${c})`);
  });

  await test('color: Brillo y contraste, Blanco y negro y los efectos nuevos (HLS, GPG, emisión, selectivo, vínculo, Cineon, CC)', async () => {
    await setup();
    let c = await px('#808080', 'brightnessContrast', { brightness: 20 });
    assert(close(c, [179, 179, 179], 3), `brillo heredado +20 (${c})`);
    c = await px('#808080', 'brightnessContrast', { brightness: 150, legacy: false });
    assert(close(c, [181, 181, 181], 3), `brillo nuevo +150 conserva los extremos (${c})`);
    // #c83232 (luma 82) is a midtone for the default tonal ranges (shadows < 64, highlights > 192)
    c = await px('#c83232', 'threeWay', { midBalance: '#4040ff' });
    assert(c[2] > 100 && c[0] < 180, `3 vías: medios tonos hacia el azul (${c})`);
    c = await px('#c83232', 'threeWay', { shadowBalance: '#4040ff' });
    assert(close(c, [200, 50, 50], 2), `3 vías: las sombras no tocan los medios tonos (${c})`);
    c = await px('#ffffff', 'brightnessContrast', { brightness: -150, legacy: false });
    assert(close(c, [255, 255, 255], 1), `brillo nuevo: el blanco se queda (${c})`);
    c = await px('#c83232', 'blackWhite');
    assert(close(c, [110, 110, 110], 3), `blanco y negro: rojos al 40 % (${c})`);
    c = await px('#ffff00', 'blackWhite');
    assert(close(c, [153, 153, 153], 3), `blanco y negro: amarillos al 60 % (${c})`);
    c = await px('#c83232', 'blackWhite', { tint: true });
    assert(close(c, [117, 110, 93], 4), `blanco y negro con tinta (${c})`);
    c = await px('#c83232', 'colorBalanceHLS', { hue: 120 });
    assert(close(c, [50, 200, 50], 4), `equilibrio HLS: tono +120° (${c})`);
    c = await px('#808080', 'gammaPedestalGain', { rGain: 0.5 });
    assert(close(c, [64, 128, 128], 3), `GPG: ganancia del rojo 0,5 (${c})`);
    c = await px('#ffff00', 'broadcastColors');
    assert(close(c, [212, 212, 0], 4), `colores de emisión: amarillo bajado a 110 IRE (${c})`);
    c = await px('#ffff00', 'broadcastColors', { method: 'keyUnsafe' });
    assert(close(c, [0, 0, 0], 2), `colores de emisión: eliminar zonas no seguras (${c})`);
    c = await px('#808080', 'selectiveColor', { neutralsC: 100 });
    assert(close(c, [1, 128, 128], 3), `color selectivo: cian en los neutros (${c})`);
    c = await px('#c83232', 'colorLink', { mode: 'multiply' });
    assert(close(c, [157, 10, 10], 4), `vínculo de color: su propio promedio multiplicado (${c})`);
    c = await px('#808080', 'cineonConverter');
    assert(close(c, [136, 136, 136], 4), `Cineon logarítmico a lineal (${c})`);
    c = await px('#808080', 'ccToner');
    assert(close(c, [128, 100, 70], 4), `CC Toner: medios tonos (${c})`);
    c = await px('#808080', 'ccColorOffset', { red: 180 });
    assert(close(c, [1, 128, 128], 3), `CC Color Offset: rojo media vuelta (${c})`);
    c = await px('#646464', 'ccKernel', { k22: 2 });
    assert(close(c, [200, 200, 200], 2), `CC Kernel: centro ×2 (${c})`);
    c = await px('#9f6f5f', 'ccColorNeutralizer', { midtonesUnbalance: '#9f6f5f' });
    assert(Math.abs(c[0] - c[1]) < 6 && Math.abs(c[1] - c[2]) < 6, `CC Color Neutralizer: el color muestreado queda gris (${c})`);
  });
  await test('color: Lumetri, Niveles sin recorte, Limitador de vídeo, PS Mapa arbitrario, Equilibrio heredado, Ampliar límites y CC Overbrights', async () => {
    await setup();
    // Lumetri: exposure up to ±7, creative sharpen does not move a flat colour
    let c = await px('#404040', 'lumetri', { exposure: 6 });
    assert(c[0] > 250, `Lumetri: exposición +6 (${c})`);
    c = await px('#808080', 'lumetri', { sharpen: 80 });
    assert(close(c, [128, 128, 128], 2), `Lumetri: enfocar deja igual un color plano (${c})`);
    // Levels with output black 100: clipped (default for 8 bits) the black stays at 100; with Clip To Output Black off
    // the values under input black 50 go below it
    c = await px('#141414', 'levels', { inBlack: 50, outBlack: 100 });
    assert(close(c, [100, 100, 100], 2), `niveles: recorte al negro de salida (${c})`);
    c = await px('#141414', 'levels', { inBlack: 50, outBlack: 100, clipBlack: 'off' });
    assert(c[0] > 70 && c[0] < 90, `niveles sin recorte: por debajo del negro de salida (${c})`);
    // Video Limiter at 100 IRE: pure yellow's composite signal (Y 0.89 + C 0.44) is over, its chroma comes down;
    // grey is left alone; gamut warning paints what changes
    c = await px('#ffff00', 'videoLimiter', { clip: '100' });
    assert(c[2] > 60 && c[0] < 255, `limitador: amarillo desaturado (${c})`);
    c = await px('#808080', 'videoLimiter', { clip: '100', gamutWarning: true });
    assert(close(c, [128, 128, 128], 1), `limitador: el gris es legal (${c})`);
    c = await px('#ffff00', 'videoLimiter', { clip: '100', gamutWarning: true });
    assert(close(c, [240, 10, 220], 2), `limitador: advertencia de gama (${c})`);
    // PS Arbitrary Map: identity by default; an inverting map (768 bytes: red, green, blue) inverts; phase 180° shifts
    c = await px('#c83232', 'psArbMap');
    assert(close(c, [200, 50, 50], 1), `mapa arbitrario: identidad (${c})`);
    const inv = Array.from({ length: 256 }, (_, i) => (255 - i).toString(16).padStart(2, '0')).join('');
    c = await px('#c83232', 'psArbMap', { map: inv + inv + inv });
    assert(close(c, [55, 205, 205], 1), `mapa arbitrario: invertir (${c})`);
    c = await px('#c83232', 'psArbMap', { phase: 180 });
    assert(close(c, [72, 178, 178], 1), `mapa arbitrario: fase 180° (${c})`);
    c = await px('#808080', 'colorBalanceLegacy', { red: 50, blue: -50 });
    assert(close(c, [255, 128, 0], 2), `equilibrio de color heredado (${c})`);
    // Grow Bounds: a small shape blurred with repeated edges stays inside its box; 30 more pixels let the blur out
    await call('comp_new', { project: CP, name: 'GB', width: 120, height: 120, fps: 30, duration: 1, bg: '#000000' });
    const sh = (await call('shape_add', { project: CP, comp: 'GB', kind: 'rect', width: 40, height: 40, color: '#ffffff' })).layer.id;
    await call('effect_add', { project: CP, comp: 'GB', layer: sh, effect: 'gaussianBlur', values: { amount: 12 } });
    const out0 = imgOf(await call('comp_frame', { project: CP, comp: 'GB', time: 0 })).at(0.5, 32 / 120)[0];
    await call('effect_add', { project: CP, comp: 'GB', layer: sh, effect: 'growBounds', values: { pixels: 30 } });
    const out1 = imgOf(await call('comp_frame', { project: CP, comp: 'GB', time: 0 })).at(0.5, 32 / 120)[0];
    assert(out0 < 5 && out1 > 15, `ampliar límites: el desenfoque sale de la caja (${out0} → ${out1})`);
    await call('comp_delete', { project: CP, comp: 'GB' });
    // CC Overbrights at 32 bpc: two 0.6 greys added make 1.2, painted red; at 8 bpc there is nothing over 1
    await call('comp_new', { project: CP, name: 'OB', width: 64, height: 48, fps: 30, duration: 1, bg: '#000000' });
    await call('layer_add', { project: CP, comp: 'OB', type: 'solid', color: '#999999' });
    const top = (await call('layer_add', { project: CP, comp: 'OB', type: 'solid', color: '#999999' })).layer.id;
    await call('layer_set', { project: CP, comp: 'OB', layer: top, blend: 'add' });
    const adj = (await call('layer_add', { project: CP, comp: 'OB', type: 'adjustment' })).layer.id;
    await call('effect_add', { project: CP, comp: 'OB', layer: adj, effect: 'ccOverbrights' });
    const ob8 = imgOf(await call('comp_frame', { project: CP, comp: 'OB', time: 0 })).at(0.5, 0.5).slice(0, 3);
    await call('color_settings', { project: CP, depth: 32 });
    const ob32 = imgOf(await call('comp_frame', { project: CP, comp: 'OB', time: 0 })).at(0.5, 0.5).slice(0, 3);
    await call('color_settings', { project: CP, depth: 8 });
    assert(close(ob8, [255, 255, 255], 2) && close(ob32, [255, 0, 0], 2), `CC Overbrights: 8 bpc ${ob8}, 32 bpc ${ob32}`);
    await call('comp_delete', { project: CP, comp: 'OB' });
  });

  await test('color: Niveles automáticos con afinación temporal y detección de escenas', async () => {
    await setup();
    // a 2 s clip at 10 fps: a dark ramp (0…100) for 1 s, then a bright one (100…255)
    const src = W('auto-ramps.mp4');
    ff('-f', 'lavfi', '-i', "color=black:s=64x48:r=10:d=2,format=gray,geq=lum='if(lt(T\,0.95)\,X*100/W\,100+X*155/W)'", '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv444p', src);
    await call('comp_new', { project: CP, name: 'Auto', width: 64, height: 48, fps: 10, duration: 2, bg: '#000000' });
    const v = (await call('layer_add', { project: CP, comp: 'Auto', type: 'video', media_path: src })).layer.id;
    const id = (await call('effect_add', { project: CP, comp: 'Auto', layer: v, effect: 'autoLevels', values: { blackClip: 0, whiteClip: 0 } })).effect.id;
    const edge = async (t) => { const r = await call('comp_frame', { project: CP, comp: 'Auto', time: t, width: 64 }); assert(!r.layerErrors, JSON.stringify(r.layerErrors)); return imgOf(r).at(62.5 / 64, 0.5)[0]; };
    // each frame on its own: the dark ramp is stretched to white at its right end
    const own = await edge(0.8);
    assert(own > 235, `sin afinación: extremo derecho blanco (${own})`);
    // 1 s of smoothing: frames 0.3…1.3 s, five of them bright, so the white point rises and the edge darkens
    await call('effect_set', { project: CP, comp: 'Auto', layer: v, effect: id, values: { smoothing: 1 } });
    const sm = await edge(0.8);
    assert(sm < own - 40, `afinación temporal 1 s: ${sm} (frente a ${own})`);
    // Scene Detect stops the window at the cut: the dark shot alone again
    await call('effect_set', { project: CP, comp: 'Auto', layer: v, effect: id, values: { sceneDetect: true } });
    const sc = await edge(0.8);
    assert(Math.abs(sc - own) < 8, `detección de escenas: ${sc} (como ${own})`);
  });

  await test('color: Lumetri — HSL secundario (clave, máscara, corrección), look .cube con intensidad y HDR', async () => {
    await setup();
    // the key set on red: a red solid loses its saturation, a blue one is left alone
    let c = await px('#c83232', 'lumetri', { hslSet: '#c83232', hslSaturation: 0 });
    assert(Math.max(...c) - Math.min(...c) < 6, `rojo en la clave → gris (${c})`);
    c = await px('#3250c8', 'lumetri', { hslSet: '#c83232', hslSaturation: 0 });
    assert(close(c, [50, 80, 200], 3), `azul fuera de la clave (${c})`);
    // the same key from the sliders (hue 340…20°), shown as White/Black, and inverted
    c = await px('#c83232', 'lumetri', { hslHMin: 340, hslHMax: 20, hslShowMask: true, hslMaskMode: 'whiteBlack' });
    assert(c.every((v) => v > 250), `máscara: rojo blanco (${c})`);
    c = await px('#3250c8', 'lumetri', { hslHMin: 340, hslHMax: 20, hslShowMask: true, hslMaskMode: 'whiteBlack' });
    assert(c.every((v) => v < 5), `máscara: azul negro (${c})`);
    c = await px('#3250c8', 'lumetri', { hslHMin: 340, hslHMax: 20, hslInvert: true, hslTemperature: 100 });
    assert(c[0] > 50 + 5 && c[2] < 200 - 5, `invertida: el azul se corrige (${c})`);
    // Color/Gray: what is out of the key turns grey
    c = await px('#3250c8', 'lumetri', { hslHMin: 340, hslHMax: 20, hslShowMask: true });
    assert(close(c, [128, 128, 128], 2), `Color/gris (${c})`);
    // a 2-point .cube that inverts: the look at 100 % inverts, at 50 % meets in the middle
    const inv = ['LUT_3D_SIZE 2', '1 1 1', '0 1 1', '1 0 1', '0 0 1', '1 1 0', '0 1 0', '1 0 0', '0 0 0'].join('\n');
    c = await px('#c83232', 'lumetri', { lut: inv });
    assert(close(c, [55, 205, 205], 3), `look invertido (${c})`);
    c = await px('#c83232', 'lumetri', { lut: inv, lookIntensity: 50 });
    assert(close(c, [128, 128, 128], 3), `look al 50 % (${c})`);
    // HDR Specular lifts what is above the diffuse white (only with High Dynamic Range on)
    const base = await px('#e6e6e6', 'lumetri', { hdrSpecular: 100 }), hdr = await px('#e6e6e6', 'lumetri', { hdr: true, hdrSpecular: 100 });
    assert(close(base, [230, 230, 230], 2) && hdr[0] > base[0] + 8, `HDR especular: ${base[0]} → ${hdr[0]}`);
  });
};
