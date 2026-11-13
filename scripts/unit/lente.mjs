// Unit tests of the «lente» effects (parameters as in After Effects' Shape Blur, Fast Blur, Rolling Shutter
// Repair, Deblur and Upscale; Spanish names from AE's Spanish interface).
export default ({ test, ok, M, core }) => {
  const fx = (id) => M.FX.find((f) => f.id === id);
  const def = (id, p) => fx(id).params.find((q) => q.id === p);
  const ids = (id) => fx(id).params.map((q) => q.id).join(',');
  const choices = (id, p) => def(id, p).choices.map((c) => c.id).join('|');
  const is = (id, p, d, min, max) => { const q = def(id, p); ok(q, `${id}.${p} no existe`); ok(q.def === d && (min === undefined || q.min === min) && (max === undefined || q.max === max), `${id}.${p}: ${q.def} [${q.min}, ${q.max}], esperado ${d} [${min}, ${max}]`); };

  test('lente: Desenfoque de lente de cámara (ShapeBlur): orden, valores por defecto y rangos', () => {
    const f = fx('cameraLensBlur');
    ok(f.name === 'Desenfoque de lente de cámara' && f.cat === 'Desenfocar y enfocar', f.name);
    ok(ids('cameraLensBlur') === 'radius,shape,roundness,aspect,rotation,fringe,map,mapChannel,mapPlacement,focal,mapInvert,gain,threshold,saturation,repeat,linear', ids('cameraLensBlur'));
    is('cameraLensBlur', 'radius', 5, 0, 500); is('cameraLensBlur', 'shape', 'hexagon'); is('cameraLensBlur', 'roundness', 0, 0, 100);
    is('cameraLensBlur', 'aspect', 1, 0.01, 100); is('cameraLensBlur', 'rotation', 0); is('cameraLensBlur', 'fringe', 100, 0, 500);
    ok(choices('cameraLensBlur', 'shape') === 'triangle|square|pentagon|hexagon|heptagon|octagon|nonagon|decagon', 'ocho formas de iris');
    ok(choices('cameraLensBlur', 'mapChannel') === 'luma|red|green|blue|alpha' && choices('cameraLensBlur', 'mapPlacement') === 'center|stretch', 'canal y posición del mapa');
    is('cameraLensBlur', 'focal', 0, 0, 255); is('cameraLensBlur', 'mapInvert', 0);
    is('cameraLensBlur', 'gain', 0, 0, 100); is('cameraLensBlur', 'threshold', 204, 0, 255); is('cameraLensBlur', 'saturation', 0, 0, 100);
    is('cameraLensBlur', 'repeat', 1); is('cameraLensBlur', 'linear', 1);
  });
  test('lente: Desenfoque rápido (heredado), Desenfoque de movimiento de píxeles, Estabilización del desenfoque de temblores y Conservar detalles', () => {
    ok(fx('fastBlur').name === 'Desenfoque rápido (heredado)' && fx('fastBlur').cat === 'Obsoleto', 'Desenfoque rápido');
    ok(ids('fastBlur') === 'blurriness,dims,repeat', ids('fastBlur'));
    is('fastBlur', 'blurriness', 0, 0, 30000); is('fastBlur', 'dims', 'both'); is('fastBlur', 'repeat', 1);
    const pm = fx('pixelMotionBlur');
    ok(pm.name === 'Desenfoque de movimiento de píxeles' && pm.cat === 'Tiempo' && pm.still, 'Desenfoque de movimiento de píxeles');
    ok(ids('pixelMotionBlur') === 'shutterControl,shutterAngle,shutterSamples,vectorDetail', ids('pixelMotionBlur'));
    is('pixelMotionBlur', 'shutterControl', 'manual'); ok(choices('pixelMotionBlur', 'shutterControl') === 'manual|auto', 'Manual|Automático');
    is('pixelMotionBlur', 'shutterAngle', 180, 0, 5000); is('pixelMotionBlur', 'shutterSamples', 5, 1, 256); is('pixelMotionBlur', 'vectorDetail', 20, 5, 100);
    const db = fx('cameraShakeDeblur');
    ok(db.name === 'Estabilización del desenfoque de temblores' && db.cat === 'Desenfocar y enfocar', db.name);
    ok(ids('cameraShakeDeblur') === 'duration,method,strength,sensitivity', ids('cameraShakeDeblur'));
    is('cameraShakeDeblur', 'duration', '5'); ok(choices('cameraShakeDeblur', 'duration') === '5|7|9', '5, 7 o 9 fotogramas');
    is('cameraShakeDeblur', 'method', 'standard'); is('cameraShakeDeblur', 'strength', 100, 0, 200); is('cameraShakeDeblur', 'sensitivity', 50, 0, 100);
    const up = fx('upscale');
    ok(up.name === 'Conservar detalles (ampliación)' && up.cat === 'Distorsionar', up.name);
    ok(ids('upscale') === 'fitWidth,fitHeight,scale,noise,detail,alpha', ids('upscale'));
    is('upscale', 'scale', 100, 100, 30000); is('upscale', 'noise', 0, 0, 100); is('upscale', 'detail', 50, 0, 100);
    is('upscale', 'alpha', 'bicubic'); ok(choices('upscale', 'alpha') === 'detail|bicubic', 'Conservar detalles|Bicúbico');
  });
  test('lente: nombres de coincidencia de After Effects para los scripts', () => {
    const { Editor, newProject, runScriptSync } = core;
    const e = new Editor(newProject());
    const r = runScriptSync(e, 'var c = app.project.items.addComp("S", 320, 240, 1, 3, 25); var l = c.layers.addSolid([1, 1, 1], "B", 50, 40, 1);\n' +
      ['ADBE Camera Lens Blur', 'ADBE Fast Blur', 'ADBE OFMotionBlur', 'ADBE CameraShakeDeblur', 'ADBE Upscale'].map((m) => `l.property("ADBE Effect Parade").addProperty("${m}");`).join('\n'));
    ok(r.ok, JSON.stringify(r));
    const got = e.project.comps[0].layers[0].effects.map((f) => f.fx).join(',');
    ok(got === 'cameraLensBlur,fastBlur,pixelMotionBlur,cameraShakeDeblur,upscale', got);
  });
};
