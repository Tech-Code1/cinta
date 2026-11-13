// Unit tests of the «generar» line (round 7): parameters as in After Effects 2024's plug-ins.
export default ({ test, ok, M, core }) => {
  const fx = (id) => M.FX.find((f) => f.id === id);
  const def = (id, p) => fx(id).params.find((q) => q.id === p);
  const ids = (id) => fx(id).params.map((q) => q.id).join(',');

  test('generar: Degradado de 4 colores y Ruido de turbulencia como en After Effects', () => {
    // ColorsQuad: 10 % / 90 % points, yellow / green / magenta / blue, Blend 100 (5…10000), Jitter 0…500, None
    ok(fx('fourColorGradient').name === 'Degradado de 4 colores' && fx('fourColorGradient').cat === 'Generar', 'nombre y categoría');
    ok(String(def('fourColorGradient', 'point1').def) === '0.1,0.1' && String(def('fourColorGradient', 'point4').def) === '0.9,0.9', 'puntos al 10 % / 90 %');
    ok(['#ffff00', '#00ff00', '#ff00ff', '#0000ff'].every((c, i) => def('fourColorGradient', `color${i + 1}`).def === c), 'amarillo, verde, magenta, azul');
    ok(def('fourColorGradient', 'blend').def === 100 && def('fourColorGradient', 'blend').min === 5 && def('fourColorGradient', 'blend').max === 10000 && def('fourColorGradient', 'jitter').max === 500, 'fusionar 100 (5…10000), variación 0…500');
    ok(def('fourColorGradient', 'blendMode').def === 'none' && def('fourColorGradient', 'blendMode').choices.length === 18, 'modo de fusión Ninguno (18 modos)');
    ok(ids('fourColorGradient') === 'point1,color1,point2,color2,point3,color3,point4,color4,blend,jitter,opacity,blendMode', 'orden de After Effects');
    // TurbulentNoise: Fractal Noise's params without sub rotation / offset / centre / cycle, + Turbulence Factor
    const tn = fx('turbulentNoise'), fn = fx('fractalNoise');
    ok(tn.name === 'Ruido de turbulencia' && tn.cat === 'Ruido y granulado', 'nombre en español');
    ok(['subRotation', 'subOffset', 'centerSubscale', 'cycle', 'cycleRevs'].every((k) => !def('turbulentNoise', k)), 'sin rotación / desplazamiento secundarios ni evolución cíclica');
    ok(def('turbulentNoise', 'turbulence').def === 1.5 && def('turbulentNoise', 'turbulence').min === 1 && def('turbulentNoise', 'turbulence').max === 4, 'factor de turbulencia 1,5 (1…4)');
    ok(['type', 'noiseType', 'contrast', 'overflow', 'scale', 'complexity', 'subInfluence', 'subScaling'].every((k) => def('turbulentNoise', k).def === fn.params.find((q) => q.id === k).def), 'mismos valores que Ruido fractal');
    ok(def('turbulentNoise', 'type').choices.length === 17 && def('turbulentNoise', 'blendMode').def === 'normal' && !def('turbulentNoise', 'blendMode').choices.some((c) => c.id === 'color'), 'tipos fractales y modo Normal');
  });

  test('generar: Compresión de resalte HDR, Convertidor perfiles de color y Estabilizador del color', () => {
    ok(def('hdrHighlightCompression', 'amount').def === 100 && def('hdrHighlightCompression', 'amount').max === 100 && def('hdrHighlightCompression', 'amount').name === 'Nivel', 'Nivel 100 (0…100)');
    ok(ids('colorProfileConverter') === 'input,linearizeIn,output,linearizeOut,intent,bpc,sceneComp', 'orden de ProfileToProfile');
    ok(def('colorProfileConverter', 'intent').def === 'relative' && def('colorProfileConverter', 'bpc').def === 1 && def('colorProfileConverter', 'sceneComp').def === 'project', 'colorimétrica relativa, compensación de puntos negros');
    ok(['srgb', 'rec709', 'rec2020', 'adobeRgb', 'prophoto', 'linear'].every((k) => def('colorProfileConverter', 'output').choices.some((c) => c.id === k)), 'perfiles sRGB, 709, 2020, Adobe RGB, ProPhoto y lineal');
    ok(def('colorStabilizer', 'stabilize').def === 'levels' && def('colorStabilizer', 'stabilize').choices.map((c) => c.id).join() === 'brightness,levels,curves', 'Brillo | Niveles | Curvas (Niveles)');
    ok(String(def('colorStabilizer', 'blackPoint').def) === '0.2,0.5' && String(def('colorStabilizer', 'whitePoint').def) === '0.8,0.5' && def('colorStabilizer', 'sampleSize').def === 3 && def('colorStabilizer', 'sampleSize').max === 50, 'puntos 20 / 50 / 80 %, muestra 3 (1…50)');
  });

  test('generar: CC Threshold, CC Threshold RGB, CC Burn Film y nombres de coincidencia', () => {
    ok(def('ccThreshold', 'threshold').def === 127.5 && def('ccThreshold', 'channel').choices.map((c) => c.id).join() === 'luminance,rgb,saturation,alpha' && def('ccThreshold', 'blend').def === 0, 'CC Threshold');
    ok(ids('ccThresholdRGB') === 'red,green,blue,invertRed,invertGreen,invertBlue,blend' && def('ccThresholdRGB', 'green').def === 127.5, 'CC Threshold RGB');
    ok(def('ccBurnFilm', 'burn').def === 0 && def('ccBurnFilm', 'burn').max === 100 && def('ccBurnFilm', 'seed').max === 5000, 'CC Burn Film');
    const AE = core.aescript?.AE_EFFECTS ?? core.AE_EFFECTS;
    if (AE) ok(AE['ADBE 4ColorGradient'] === 'fourColorGradient' && AE['ADBE AIF Perlin Noise 3D'] === 'turbulentNoise' && AE['ADBE HDR ToneMap'] === 'hdrHighlightCompression' && AE['ADBE ProfileToProfile'] === 'colorProfileConverter' && AE['ADBE Deflicker'] === 'colorStabilizer' && AE['CC Burn Film'] === 'ccBurnFilm', 'nombres de coincidencia de After Effects');
  });
};
