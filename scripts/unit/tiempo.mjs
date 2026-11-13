// Unit tests of the «tiempo» effects: parameters as each After Effects plug-in sets them up and their
// match names for .jsx scripts.
export default ({ test, ok, M, core }) => {
  const fx = (id) => M.FX.find((f) => f.id === id);
  const def = (id, p) => fx(id).params.find((q) => q.id === p);
  const ids = (id) => fx(id).params.map((q) => q.id).join(',');
  const choices = (id, p) => def(id, p).choices.map((c) => c.id).join('|');
  const is = (id, p, d, min, max) => { const q = def(id, p); ok(q, `${id}.${p} no existe`); ok(JSON.stringify(q.def) === JSON.stringify(d) && (min === undefined || q.min === min) && (max === undefined || q.max === max), `${id}.${p}: ${JSON.stringify(q.def)} [${q.min}, ${q.max}], esperado ${JSON.stringify(d)} [${min}, ${max}]`); };

  test('tiempo: Reducir parpadeo entrelazado y Diferencia de tiempo como en After Effects', () => {
    is('reduceInterlaceFlicker', 'softness', 0, 0, 1000); ok(fx('reduceInterlaceFlicker').cat === 'Desenfocar y enfocar', 'categoría de Fast_Blur');
    ok(ids('timeDifference') === 'target,offset,contrast,absolute,alpha', ids('timeDifference'));
    is('timeDifference', 'offset', 0, -2000, 2000); is('timeDifference', 'contrast', 50, -10000, 10000); is('timeDifference', 'absolute', 0); is('timeDifference', 'alpha', 'original');
    ok(choices('timeDifference', 'alpha') === 'original|target|blend|max|full|lightness|maxResult|alphaDiff|alphaDiffOnly', 'Canal alfa: 9 opciones (sin separadores)');
    ok(fx('timeDifference').name === 'Diferencia de tiempo' && def('timeDifference', 'offset').name === 'Compens. de tiempo (seg.)', 'nombres en español');
    ok(ids('deflicker') === 'mode,frequency,frames,detail' && choices('deflicker', 'mode') === 'timelapse|highFrequency', 'Eliminar parpadeo');
  });
  test('tiempo: CC Time Blend FX, CC Block Load, CC Mr. Smoothie, CC Composite y CC Ripple Pulse como en After Effects', () => {
    ok(ids('ccTimeBlendFx') === 'instance,mode,accumulation,clearTo' && choices('ccTimeBlendFx', 'instance') === 'copy|paste', 'Instancia Copiar | Pegar');
    is('ccTimeBlendFx', 'instance', 'copy'); is('ccTimeBlendFx', 'mode', 'blend'); is('ccTimeBlendFx', 'accumulation', 0.75, 0, 1); is('ccTimeBlendFx', 'clearTo', 'transparent');
    ok(def('ccTimeBlendFx', 'mode').choices.length === 17, 'Transferencia: 17 modos');
    ok(ids('ccBlockLoad') === 'completion,scans,startCleared,bilinear', ids('ccBlockLoad'));
    is('ccBlockLoad', 'completion', 0, 0, 100); is('ccBlockLoad', 'scans', 4, 1, 16); is('ccBlockLoad', 'startCleared', 1); is('ccBlockLoad', 'bilinear', 0);
    ok(ids('ccMrSmoothie') === 'flow,property,smoothness,sampleA,sampleB,phase,loop', ids('ccMrSmoothie'));
    is('ccMrSmoothie', 'property', 'luminance'); is('ccMrSmoothie', 'smoothness', 4, 0, 511); is('ccMrSmoothie', 'sampleA', [0.25, 0.25]); is('ccMrSmoothie', 'sampleB', [0.75, 0.75]); is('ccMrSmoothie', 'loop', 'AB');
    ok(choices('ccMrSmoothie', 'property') === 'red|green|blue|alpha|luminance|lightness|hue|saturation' && choices('ccMrSmoothie', 'loop') === 'AB|BA|ABA|BAB', 'Propiedad y Bucle de color');
    ok(ids('ccComposite') === 'opacity,mode,rgbOnly', ids('ccComposite'));
    is('ccComposite', 'opacity', 100); is('ccComposite', 'mode', 'inFront'); is('ccComposite', 'rgbOnly', 1);
    ok(def('ccComposite', 'mode').choices.length === 34 && choices('ccComposite', 'mode').startsWith('copy|behind|inFront|darken'), 'Componer original: 34 modos');
    ok(ids('ccRipplePulse') === 'center,pulse,timeSpan,amplitude,bumpMap', ids('ccRipplePulse'));
    is('ccRipplePulse', 'pulse', 100, -10000, 10000); is('ccRipplePulse', 'timeSpan', 1, 0, 10); is('ccRipplePulse', 'amplitude', 100, -10000, 10000); is('ccRipplePulse', 'bumpMap', 0);
  });
  test('tiempo: nombres de coincidencia de After Effects para los scripts', () => {
    const pairs = [['ADBE Reduce Interlace Flicker', 'reduceInterlaceFlicker'], ['ADBE Difference', 'timeDifference'], ['CC Time Blend FX', 'ccTimeBlendFx'], ['CS BlockLoad', 'ccBlockLoad'], ['CC Mr. Smoothie', 'ccMrSmoothie'], ['CC Composite', 'ccComposite'], ['CC Ripple Pulse', 'ccRipplePulse']];
    for (const [m, id] of pairs) ok(core.AE_EFFECTS[m] === id && core.aeMatchName(id) === m, `${m} ↔ ${id}`);
    ok(core.aeEffectId('Diferencia de tiempo') === 'timeDifference', 'por nombre visible');
    ok(core.aeMatchName('deflicker') === undefined && core.CINTA_ONLY_EFFECTS.includes('deflicker'), 'Eliminar parpadeo: propio de Cinta');
  });
};
