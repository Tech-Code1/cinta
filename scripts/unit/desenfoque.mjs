// Unit tests of the desenfoque effects (fidelity with After Effects).
export default ({ test, ok, M }) => {
  const fx = (id) => M.FX.find((f) => f.id === id);
  const def = (id, p) => fx(id).params.find((q) => q.id === p);
  const ids = (id) => fx(id).params.map((q) => q.id).join(',');
  const choices = (id, p) => def(id, p).choices.map((c) => c.id).join('|');
  const is = (id, p, d, min, max) => { const q = def(id, p); ok(q, `${id}.${p} no existe`); ok(q.def === d && (min === undefined || q.min === min) && (max === undefined || q.max === max), `${id}.${p}: ${q.def} [${q.min}, ${q.max}], esperado ${d} [${min}, ${max}]`); };

  test('desenfocar y enfocar: valores de After Effects (Gaussian_Blur_MC, DirectionalBlur, Radial_Blur, Sharpen)', () => {
    is('gaussianBlur', 'amount', 0, 0, 30000); is('gaussianBlur', 'dir', 'both'); is('gaussianBlur', 'repeat', 1);
    is('directionalBlur', 'angle', 0); is('directionalBlur', 'length', 0, 0, 1000);
    is('radialBlur', 'amount', 10, 0, 1000); is('radialBlur', 'type', 'spin'); is('radialBlur', 'aa', 'low');
    ok(choices('radialBlur', 'type') === 'spin|zoom' && choices('radialBlur', 'aa') === 'low|high', 'Desenfoque radial: Giro|Zoom, Bajo|Alto');
    is('sharpen', 'amount', 0, 0, 4000);
  });
  test('ruido, mate e incrustación: valores de After Effects (Noise, Matte_Choker, Simple_Choker, Color_Key, Luma_Key)', () => {
    is('noise', 'amount', 0, 0, 100); is('noise', 'color', 1); is('noise', 'clip', 1);
    ok(ids('noise').startsWith('amount,color,clip'), 'Ruido: cantidad, tipo, recorte');
    is('matteChoker', 'soft1', 4, 0, 100); is('matteChoker', 'choke1', 75, -127, 127); is('matteChoker', 'gray1', 10); is('matteChoker', 'soft2', 0, 0, 100); is('matteChoker', 'choke2', 0, -127, 127); is('matteChoker', 'gray2', 100); is('matteChoker', 'iterations', 1, 1, 100);
    is('simpleChoker', 'view', 'final'); is('simpleChoker', 'choke', 0, -100, 100);
    is('colorKey', 'color', '#0000ff'); is('colorKey', 'tolerance', 0, 0, 255); is('colorKey', 'edgeThin', 0, -5, 5); is('colorKey', 'edgeFeather', 0, 0, 100);
    is('lumaKey', 'type', 'dark'); ok(choices('lumaKey', 'type') === 'light|dark|similar|dissimilar', 'Clave de luminancia: 4 tipos');
    is('lumaKey', 'threshold', 0, 0, 255); is('lumaKey', 'tolerance', 0, 0, 255); is('lumaKey', 'edgeThin', 0, -5, 5); is('lumaKey', 'edgeFeather', 0, 0, 100);
  });
  test('efectos nuevos de desenfoque y ruido: parámetros de After Effects (orden, valores por defecto, rangos)', () => {
    ok(ids('boxBlur') === 'radius,iterations,dims,repeat', 'Desenfoque de cuadro: orden');
    is('boxBlur', 'radius', 0, 0, 30000); is('boxBlur', 'iterations', 3, 1, 50); is('boxBlur', 'repeat', 1);
    ok(ids('channelBlur') === 'red,green,blue,alpha,repeat,dims', 'Desenfoque de canal: orden');
    is('channelBlur', 'red', 0, 0, 32767); is('channelBlur', 'repeat', 1);
    is('unsharpMask', 'amount', 50, 0, 500); is('unsharpMask', 'radius', 1, 0.1, 500); is('unsharpMask', 'threshold', 0);
    is('smartBlur', 'radius', 3, 0.1, 100); is('smartBlur', 'threshold', 25, 0.1, 100); ok(choices('smartBlur', 'mode') === 'normal|edge|overlay', 'Desenfoque inteligente: 3 modos');
    is('bilateralBlur', 'radius', 25, 0, 30000); is('bilateralBlur', 'threshold', 3, 0, 200); is('bilateralBlur', 'colorize', 1);
    is('median', 'radius', 0, 0, 255); is('median', 'alpha', 0);
    is('dustScratches', 'radius', 1, 0, 255); is('dustScratches', 'threshold', 0);
    is('noiseHLS', 'type', 'uniform'); is('noiseHLS', 'lightness', 0, 0, 1000); is('noiseHLS', 'grain', 1, 0, 10); is('noiseHLSAuto', 'speed', 24, 0, 200);
    ok(ids('noiseAlpha') === 'type,amount,original,overflow,phase,cycle,cycles', 'Ruido alfa: orden');
    is('noiseAlpha', 'original', 'clamp'); is('noiseAlpha', 'overflow', 'wrapBack'); is('noiseAlpha', 'cycles', 1, 1, 88);
  });
  test('efectos nuevos de canal e incrustación: parámetros de After Effects', () => {
    is('minimax', 'op', 'max'); is('minimax', 'radius', 0, 0, 32000); is('minimax', 'channel', 'color'); is('minimax', 'dir', 'both'); is('minimax', 'noShrink', 0);
    ok(def('shiftChannels', 'red').choices.length === 10 && ['alpha', 'red', 'green', 'blue'].every((c) => def('shiftChannels', c).def === c), 'Cambiar canales: cada uno del suyo, 10 opciones');
    ok(ids('setChannels') === 'source1,red,source2,green,source3,blue,source4,alpha,stretch', 'Establecer canales: orden');
    is('setChannels', 'stretch', 1);
    is('arithmetic', 'op', 'xor'); ok(def('arithmetic', 'op').choices.length === 13, 'Aritmética: 13 operadores'); is('arithmetic', 'red', 0, 0, 255); is('arithmetic', 'clip', 1);
    is('solidComposite', 'sourceOpacity', 100); is('solidComposite', 'color', '#ffffff'); is('solidComposite', 'mode', 'normal');
    is('linearColorKey', 'color', '#0000ff'); is('linearColorKey', 'tolerance', 0); is('linearColorKey', 'softness', 10); is('linearColorKey', 'operation', 'key');
    is('extract', 'channel', 'luma'); is('extract', 'black', 0, 0, 255); is('extract', 'white', 255, 0, 255);
    is('differenceMatte', 'fit', 'center'); is('differenceMatte', 'tolerance', 15); is('differenceMatte', 'softness', 0); is('differenceMatte', 'blur', 0, 0, 1000);
    for (const f of M.FX.filter((d) => ['Desenfocar y enfocar', 'Ruido y granulado', 'Canal', 'Incrustación', 'Mate'].includes(d.cat))) ok(typeof f.name === 'string' && f.params.every((q) => q.min === undefined || q.max === undefined || q.min <= q.max), `${f.id}: rangos`);
  });
  test('ronda 2, canal: Blend, Calculations, Channel Combiner, Compound Arithmetic, Alpha Levels', () => {
    ok(ids('blend') === 'layer,mode,original,fit', 'Fusionar: orden'); is('blend', 'mode', 'crossfade'); is('blend', 'original', 100, 0, 100); is('blend', 'fit', 'center');
    ok(choices('blend', 'mode') === 'crossfade|colorOnly|tintOnly|darkenOnly|lightenOnly', 'Fusionar: 5 modos');
    is('calculations', 'inChannel', 'rgba'); is('calculations', 'inInvert', 0); is('calculations', 'layerOpacity', 0, 0, 100); is('calculations', 'stretch', 1); is('calculations', 'mode', 'normal'); is('calculations', 'preserve', 1);
    ok(def('calculations', 'mode').choices.length === 30 && choices('calculations', 'inChannel') === 'rgba|gray|red|green|blue|alpha', 'Cálculos: 30 modos, 6 canales');
    is('channelCombiner', 'use2nd', 0); is('channelCombiner', 'from', 'rgbToHls'); is('channelCombiner', 'to', 'lightness'); is('channelCombiner', 'invert', 0); is('channelCombiner', 'solidAlpha', 0);
    ok(def('channelCombiner', 'from').choices.length === 16 && def('channelCombiner', 'to').choices.length === 14, 'Combinador: 16 orígenes, 14 destinos');
    is('compoundArithmetic', 'op', 'copy'); ok(def('compoundArithmetic', 'op').choices.length === 15, 'Aritmética compuesta: 15 operadores'); is('compoundArithmetic', 'channels', 'rgb'); is('compoundArithmetic', 'overflow', 'clip'); is('compoundArithmetic', 'stretch', 1); is('compoundArithmetic', 'original', 0);
    is('alphaLevels', 'inBlack', 0, 0, 255); is('alphaLevels', 'inWhite', 255); is('alphaLevels', 'gamma', 1, 0, 10); is('alphaLevels', 'outWhite', 255);
  });
  test('ronda 2: Keylight (pantalla negra, ganancia 100, equilibrio 50, ajuste de tonos)', () => {
    is('keylight', 'screen', '#000000'); is('keylight', 'gain', 100, 0); is('keylight', 'balance', 50, 0, 100); is('keylight', 'clipWhite', 100);
    is('keylight', 'midPoint', 0.5, 0, 1); is('keylight', 'lowGain', 1, 0); is('keylight', 'midGain', 1, 0); is('keylight', 'highGain', 1, 0);
  });
  test('ronda 2, incrustación: Color Difference Key, Color Range, Spill Suppressor', () => {
    is('colorDifferenceKey', 'view', 'final'); is('colorDifferenceKey', 'color', '#0000ff'); is('colorDifferenceKey', 'accuracy', 'faster'); is('colorDifferenceKey', 'aGamma', 1, 0, 10); is('colorDifferenceKey', 'bOutWhite', 255, 0, 255); is('colorDifferenceKey', 'mInWhite', 255);
    ok(def('colorDifferenceKey', 'view').choices.length === 9, 'Diferencia de color: 9 vistas');
    is('colorRange', 'fuzziness', 20, 0, 200); is('colorRange', 'space', 'lab'); for (const k of ['min1', 'max1', 'min2', 'max2', 'min3', 'max3']) is('colorRange', k, 127, 0, 255);
    is('innerOuterKey', 'radius', 5, 1, 1000); is('innerOuterKey', 'thin', 0, -100, 100); is('innerOuterKey', 'feather', 0, 0, 100); is('innerOuterKey', 'threshold', 0); is('innerOuterKey', 'invert', 0); is('innerOuterKey', 'original', 0);
    is('spillSuppression', 'color', '#0000ff'); is('spillSuppression', 'suppression', 100, 0, 200);
  });
  test('ronda 2, granulado y CycoreFX', () => {
    is('addGrain', 'view', 'preview'); is('addGrain', 'boxW', 200, 50, 1024); is('addGrain', 'showBox', 1); is('addGrain', 'intensity', 1, 0, 100); is('addGrain', 'size', 1, 0, 10); is('addGrain', 'softness', 1, 0, 10);
    is('addGrain', 'rInt', 1, 0, 10); is('addGrain', 'rSize', 1, 0, 5); is('addGrain', 'saturation', 1, 0, 2); is('addGrain', 'tintAmount', 100); is('addGrain', 'mode', 'film'); is('addGrain', 'midpoint', 0.5, 0, 1); is('addGrain', 'shadows', 1, 0, 5); is('addGrain', 'seed', 0, 0, 10000); is('addGrain', 'smooth', 0);
    is('removeGrain', 'view', 'preview'); is('removeGrain', 'reduction', 1, 0, 100); is('removeGrain', 'passes', 3, 1, 6); is('removeGrain', 'mode', 'multi'); is('removeGrain', 'texture', 0.1, 0, 1); is('removeGrain', 'sizeBias', 0, -1, 1); is('removeGrain', 'chroma', 1, 0, 10); is('removeGrain', 'usmRadius', 1, 0, 24);
    is('ccCrossBlur', 'radiusX', 0, 0, 10000); is('ccCrossBlur', 'mode', 'blend'); is('ccCrossBlur', 'repeat', 1);
    is('ccRadialBlur', 'type', 'scratch'); is('ccRadialBlur', 'amount', 0, -250, 250); is('ccRadialBlur', 'quality', 50, 10, 100);
    is('ccRadialFastBlur', 'amount', 50, 0, 100); is('ccRadialFastBlur', 'zoom', 'standard');
    is('ccVectorBlur', 'type', 'natural'); is('ccVectorBlur', 'amount', 0, -500, 500); is('ccVectorBlur', 'ridge', 1, 0, 100); is('ccVectorBlur', 'property', 'lightness'); is('ccVectorBlur', 'softness', 15, 0, 500);
    is('ccSimpleWireRemoval', 'style', 'displace'); is('ccSimpleWireRemoval', 'thickness', 2, 0, 100); is('ccSimpleWireRemoval', 'slope', 50); is('ccSimpleWireRemoval', 'mirror', 25); is('ccSimpleWireRemoval', 'frameOffset', 5, -120, 120);
    ok(def('ccSimpleWireRemoval', 'a').def.join() === '0.5,0.75' && def('ccSimpleWireRemoval', 'b').def.join() === '0.5,0.25', 'Wire Removal: A (50 %, 75 %), B (50 %, 25 %)');
  });

  test('tiempo: CC Force Motion Blur (ForceMB)', () => {
    // samples 8 (1–255), override shutter settings on, angle 180 (0–3600), phase 0 (±360), native motion blur Off
    ok(ids('ccForceMotionBlur') === 'samples,override,shutterAngle,shutterPhase,native', ids('ccForceMotionBlur'));
    is('ccForceMotionBlur', 'samples', 8, 1, 255); is('ccForceMotionBlur', 'override', 1); is('ccForceMotionBlur', 'shutterAngle', 180, 0, 3600);
    is('ccForceMotionBlur', 'shutterPhase', 0, -360, 360); is('ccForceMotionBlur', 'native', 'off');
    ok(choices('ccForceMotionBlur', 'native') === 'on|off' && fx('ccForceMotionBlur').cat === 'Tiempo' && fx('ccForceMotionBlur').still, 'Activado | Desactivado, en Tiempo');
  });

  test('ruido y granulado: Aplicar granulado (MatchGrain)', () => {
    const f = fx('matchGrain');
    ok(f.name === 'Aplicar granulado' && f.cat === 'Ruido y granulado', f.name);
    is('matchGrain', 'view', 'preview'); ok(choices('matchGrain', 'view') === 'preview|noiseSamples|compSamples|matte|final', choices('matchGrain', 'view'));
    is('matchGrain', 'compensate', 0, 0, 100); is('matchGrain', 'boxW', 200, 50, 200); is('matchGrain', 'showBox', 1);
    is('matchGrain', 'sourceFrame', 0, 0, 100000); is('matchGrain', 'samples', 8, 1, 10); is('matchGrain', 'sampleSize', 24, 16, 256);
    is('matchGrain', 'size', 1, 0, 100); is('matchGrain', 'aspect', 1, 0, 10); is('matchGrain', 'softness', 1, 0, 10); is('matchGrain', 'intensity', 1, 0, 100);
    is('matchGrain', 'rSize', 1, 0, 5); is('matchGrain', 'bInt', 1, 0, 100); is('matchGrain', 'saturation', 1, 0, 10); is('matchGrain', 'tintAmount', 100, 0, 100);
    is('matchGrain', 'mode', 'add'); is('matchGrain', 'midpoint', 0.5, 0, 1); is('matchGrain', 'gHighlights', 1, 0, 5);
    is('matchGrain', 'original', 0); is('matchGrain', 'matchTolerance', 0.1, 0, 1); is('matchGrain', 'matchColor', '#808080'); is('matchGrain', 'matchUsing', 'rgb');
    is('matchGrain', 'seed', 0, 0, 10000); is('matchGrain', 'speed', 1, 0, 1); is('matchGrain', 'smooth', 0);
  });
};
