// Unit tests of the color effects (fidelity with After Effects).
export default ({ test, ok, near, M, core }) => {
  const fx = (id) => M.FX.find((f) => f.id === id);
  const def = (id, p) => fx(id).params.find((q) => q.id === p);
  const ids = (id) => fx(id).params.map((q) => q.id).join(',');

  test('color: Tono/Saturación, Niveles, Exposición, Tritono y Filtro de fotografía como en After Effects', () => {
    // Hue_Sat: master hue / saturation / lightness ±100, Colorize hue 0°, saturation 25 (0…100), lightness ±100
    ok(def('hueSat', 'sat').min === -100 && def('hueSat', 'light').max === 100 && def('hueSat', 'colorize').def === 0, 'Tono/Saturación: maestros ±100, colorear desactivado');
    ok(def('hueSat', 'cHue').def === 0 && def('hueSat', 'cSat').def === 25 && def('hueSat', 'cSat').max === 100 && def('hueSat', 'cLight').min === -100, 'Tono/Saturación: coloreado 0°, 25, luminosidad ±100');
    ok(['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'].every((k) => def('hueSat', `${k}Hue`) && def('hueSat', `${k}Sat`).def === 0), 'Tono/Saturación: los seis rangos de color');
    // Levels2: gamma 0…5, default 1
    ok(def('levels', 'gamma').def === 1 && def('levels', 'gamma').max === 5 && def('levelsRGB', 'rGamma').max === 5, 'Niveles: gamma hasta 5');
    // Exposure: Master | Individual Channels, exposure slider ±4, offset ±2, gamma 0.1…10, bypass off
    const ch = def('exposure', 'channels');
    ok(ch.choices.length === 2 && ch.def === 'master' && def('exposure', 'exposure').max === 4 && def('exposure', 'offset').min === -2 && def('exposure', 'gamma').max === 10 && def('exposure', 'bypass').def === 0, 'Exposición: canales, ±4, ±2, gamma 0,1…10');
    ok(['r', 'g', 'b'].every((k) => def('exposure', `${k}Exposure`) && def('exposure', `${k}Gamma`).def === 1), 'Exposición: grupos por canal');
    // Tritone: white / (127, 100, 70) / black
    ok(def('tritone', 'high').def === '#ffffff' && def('tritone', 'mid').def === '#7f6446' && def('tritone', 'low').def === '#000000' && def('tritone', 'blend').def === 0, 'Tritono: colores de After Effects');
    // Photo Filter: 19 filters + custom (warming 85), density 25 %, preserve luminosity on
    const f = def('photoFilter', 'filter');
    ok(f.choices.length === 19 && f.def === 'warming85' && def('photoFilter', 'density').def === 25 && def('photoFilter', 'preserve').def === 1, 'Filtro de fotografía: 19 filtros, cálido (85), 25 %, conservar luminosidad');
    ok(M.PHOTO_FILTERS.find((q) => q[0] === 'warming85')[2] === '#ec8a00', 'Filtro cálido (85) = #ec8a00');
    ok(ids('hueSat').startsWith('hue,sat,light,colorize,cHue,cSat'), 'ids anteriores de Tono/Saturación conservados');
  });

  test('color: Brillo y contraste, Blanco y negro, Intensidad, Posterizar, Umbral, Sombras/Iluminaciones, Cambiar a color e Invertir', () => {
    // PSL_Adjustments: Brightness & Contrast 2 (±150 / ±100, legacy on), Black & White weights and tint, Vibrance 0
    ok(def('brightnessContrast', 'brightness').max === 150 && def('brightnessContrast', 'contrast').min === -100 && def('brightnessContrast', 'legacy').def === 1, 'Brillo y contraste: ±150, ±100, heredado activado');
    ok(['reds', 40, 'yellows', 60, 'greens', 40, 'cyans', 60, 'blues', 20, 'magentas', 80].every((v, i, a) => i % 2 || (def('blackWhite', v).def === a[i + 1] && def('blackWhite', v).min === -200 && def('blackWhite', v).max === 300)), 'Blanco y negro: pesos de Photoshop (−200…300)');
    ok(def('blackWhite', 'tint').def === 0 && def('blackWhite', 'tintColor').def === '#e1d3b3', 'Blanco y negro: tinta (225, 211, 179)');
    ok(def('vibrance', 'vibrance').def === 0 && def('vibrance', 'saturation').def === 0, 'Intensidad: 0 y 0');
    ok(def('posterize', 'levels').def === 7 && def('posterize', 'levels').max === 255 && def('threshold', 'level').def === 127, 'Posterizar 7 (2…255), umbral 127');
    ok(def('shadowHighlight', 'shadowRadius').max === 100 && def('shadowHighlight', 'highlightRadius').def === 30, 'Sombras/Iluminaciones: radios 0…100 (30)');
    ok(def('changeToColor', 'change').choices.map((c) => c.id).join() === 'hue,hueLight,hueSat,hueLightSat' && def('changeToColor', 'changeBy').def === 'set', 'Cambiar a color: orden de After Effects, ajustar al color');
    ok(def('invert', 'channel').choices.length === 13 && def('invert', 'channel').def === 'rgb', 'Invertir: 13 canales, RGB');
    ok(def('threeWay', 'shadowThreshold').def === 64 && def('threeWay', 'shadowSoftness').def === 10 && def('threeWay', 'highlightThreshold').def === 192 && def('threeWay', 'highlightThreshold').max === 253 && def('threeWay', 'masterSat').max === 200, '3 vías: definición del rango tonal 64 / 10 / 192 / 10');
    ok(def('equalize', 'mode').def === 'photoshop' && def('leaveColor', 'tolerance').def === 15 && def('autoColor', 'blackClip').def === 0.1, 'Ecualizar, Conservar color y Color automático sin cambios (comprobados)');
  });

  test('color: efectos nuevos de Corrección de color y Utilidad', () => {
    ok(def('hdrCompander', 'mode').def === 'compress' && def('hdrCompander', 'gain').min === 0.01 && def('hdrCompander', 'gamma').max === 10, 'Compansor HDR (Exposure)');
    ok(def('colorBalanceHLS', 'lightness').min === -100 && def('colorBalanceHLS', 'saturation').max === 100, 'Equilibrio de color (HLS)');
    ok(def('gammaPedestalGain', 'blackStretch').def === 1 && def('gammaPedestalGain', 'blackStretch').max === 4 && def('gammaPedestalGain', 'gGamma').max === 3 && def('gammaPedestalGain', 'bGain').def === 1 && def('gammaPedestalGain', 'rPedestal').min === -2, 'Gamma/Pedestal/Ganancia (Gpg)');
    ok(def('broadcastColors', 'locale').def === 'ntsc' && def('broadcastColors', 'method').def === 'luma' && def('broadcastColors', 'ire').def === 110 && def('broadcastColors', 'ire').min === 90 && def('broadcastColors', 'ire').max === 120, 'Colores de emisión: NTSC, reducir luminancia, 110 IRE (90…120)');
    ok(fx('selectiveColor').params.length === 37 && def('selectiveColor', 'method').def === 'relative' && def('selectiveColor', 'blacksK').min === -100, 'Color selectivo: relativo, 9 colores × CMYK');
    ok(def('colorLink', 'sample').def === 'average' && def('colorLink', 'clip').def === 5 && def('colorLink', 'clip').max === 50 && def('colorLink', 'stencil').def === 0 && def('colorLink', 'opacity').def === 100 && def('colorLink', 'mode').def === 'normal', 'Vínculo de color (ColorLink)');
    ok(def('cineonConverter', 'type').def === 'logToLin' && def('cineonConverter', 'black10').def === 95 && def('cineonConverter', 'white10').def === 685 && def('cineonConverter', 'gamma').def === 1.7 && def('cineonConverter', 'rolloff').def === 20, 'Convertidor Cineon (CineonEffect)');
    ok(def('ccToner', 'tones').def === 'tritone' && def('ccToner', 'midtones').def === '#806446' && def('ccToner', 'brights').def === '#c0aa78' && def('ccToner', 'darktones').def === '#40320a', 'CC Toner (Toner)');
    ok(def('ccColorOffset', 'overflow').choices.length === 3 && def('ccKernel', 'k22').def === 1 && def('ccKernel', 'k11').def === 0 && def('ccKernel', 'divider').def === 1, 'CC Color Offset y CC Kernel');
    ok(def('ccColorNeutralizer', 'midtonesUnbalance').def === '#7f7f7f' && def('ccColorNeutralizer', 'shR').min === -100, 'CC Color Neutralizer');
    ok(['hdrCompander', 'cineonConverter', 'ccKernel'].every((id) => fx(id).cat === 'Utilidad'), 'categoría Utilidad');
  });
  test('color (ronda 2): Lumetri, Niveles, Limitador de vídeo, Ampliar límites, CC Overbrights, PS Mapa arbitrario', () => {
    // Lumetri's parameter table (valid ranges): temperature / tint ±300, exposure ±7, tone ±150, saturation 0…300
    ok(def('lumetri', 'temperature').min === -300 && def('lumetri', 'exposure').max === 7 && def('lumetri', 'contrast').min === -150 && def('lumetri', 'saturation').max === 300 && def('lumetri', 'saturation').def === 100, 'Lumetri: rangos básicos');
    ok(def('lumetri', 'faded').max === 150 && def('lumetri', 'sharpen').min === -100 && def('lumetri', 'creativeSat').max === 300 && def('lumetri', 'tintBalance').max === 150 && def('lumetri', 'vigAmount').max === 5 && def('lumetri', 'vigFeather').def === 50, 'Lumetri: creativa y viñeta');
    // Levels2: Clip To Output Black / White: On | Off | Off for 32 bpc Color (default)
    ok(['levels', 'levelsRGB'].every((id) => def(id, 'clipBlack').choices.length === 3 && def(id, 'clipWhite').def === 'off32'), 'Niveles: recortar a negro / blanco de salida');
    // VideoLimiter: 103 IRE of 4, compression None of 5, gamut warning off, (240, 10, 220)
    ok(def('videoLimiter', 'clip').choices.length === 4 && def('videoLimiter', 'clip').def === '103' && def('videoLimiter', 'compression').choices.length === 5 && def('videoLimiter', 'gamutWarning').def === 0 && def('videoLimiter', 'warningColor').def === '#f00adc', 'Limitador de vídeo');
    ok(def('growBounds', 'pixels').def === 10 && def('growBounds', 'pixels').max === 10000, 'Ampliar límites: 10 píxeles (0…10000)');
    ok(def('ccOverbrights', 'channel').choices.length === 6 && def('ccOverbrights', 'channel').def === 'rgbClip' && def('ccOverbrights', 'clipColor').def === '#ff0000', 'CC Overbrights: RGB recortado, rojo');
    ok(def('psArbMap', 'phase').def === 0 && def('psArbMap', 'alphaPhase').def === 0 && def('colorBalanceLegacy', 'red').min === -100, 'PS Mapa arbitrario y Equilibrio de color heredado');
  });

  test('color: afinación temporal y detección de escenas de Niveles / Contraste / Color automáticos', () => {
    // Auto Levels / Contrast / Color: temporal smoothing 0 (0–10 s), scene detect off, clips 0.1 (0–10), blend 0 %
    for (const id of ['autoLevels', 'autoContrast', 'autoColor']) {
      const s = def(id, 'smoothing'), d = def(id, 'sceneDetect');
      ok(s.def === 0 && s.min === 0 && s.max === 10 && s.name === 'Afinación temporal (segundos)' && d.def === 0 && d.name === 'Detección de escenas', id);
      ok(ids(id).startsWith('smoothing,sceneDetect,blackClip,whiteClip') && def(id, 'blackClip').def === 0.1 && def(id, 'whiteClip').max === 10, `${id}: ${ids(id)}`);
    }
  });

  test('color: Lumetri — HSL secundario, look e intensidad, HDR (tabla de parámetros de Lumetri)', () => {
    const q = (k) => def('lumetri', k);
    ok(q('hslTemperature').min === -300 && q('hslTint').max === 300 && q('hslContrast').min === -150 && q('hslSharpen').max === 100 && q('hslSaturation').def === 100 && q('hslSaturation').max === 300, 'HSL secundario: corrección');
    ok(q('hslDenoise').max === 100 && q('hslBlur').max === 1000 && q('hslMaskMode').choices.map((c) => c.name).join('|') === 'Color/gris|Color/negro|Blanco/negro' && q('hslHMax').def === 360, 'HSL secundario: clave, máscara, ajustar');
    ok(q('lookIntensity').def === 100 && q('lookIntensity').max === 200 && q('lut').type === 'text', 'look .cube e intensidad 0…200');
    ok(q('hdr').def === 0 && q('hdrWhite').min === 100 && q('hdrWhite').max === 1000 && q('hdrSpecular').min === -150 && q('hdrRange').max === 10000 && q('wheelsHdrWhite').def === 100, 'HDR blanco / especular / rango');
    const i = (k) => fx('lumetri').params.findIndex((x) => x.id === k);
    ok(i('saturation') < i('lut') && i('lut') < i('faded') && i('wheelHigh') < i('hslSet') && i('hslSaturation') < i('vigAmount'), 'orden del panel: básica, look, creativa, curvas, ruedas, HSL secundario, viñeta');
  });
};
