// Unit tests of the paint tools (src/core/motion/paint.ts): dab spacing, hardness falloff, write-on timing, model.
export default ({ test, ok, near, M, core }) => {
  test('pintura: espaciado de los toques (porcentaje del diámetro) y toques a lo largo del trazado', () => {
    ok(M.dabStep(20, 25) === 5 && M.dabStep(100, 100) === 100 && M.dabStep(10, 0) === 0.25, `paso ${M.dabStep(20, 25)}`);
    const d = M.dabCenters([0, 0, 100, 0], 10);
    ok(d.length === 22 && d[0] === 0 && near(d[20], 100, 1e-6) && near(d[2], 10, 1e-6), `toques ${d.length / 2}`);
    // across a corner the spacing follows the path length
    const c = M.dabCenters([0, 0, 10, 0, 10, 10], 5);
    ok(c.length === 10 && near(c[4], 10, 1e-6) && near(c[5], 0, 1e-6) && near(c[8], 10, 1e-6) && near(c[9], 10, 1e-6), `esquina ${c}`);
    // start / end trim the path; a click is one dab; end 0 paints nothing
    const h = M.dabCenters([0, 0, 100, 0], 10, 0, 50);
    ok(h.length === 12 && near(h[h.length - 2], 50, 1e-6), `mitad ${h.length / 2}`);
    ok(M.dabCenters([5, 5], 3).join() === '5,5' && M.dabCenters([0, 0, 100, 0], 10, 0, 0).length <= 2, 'un clic, fin 0');
    ok(near(M.pathLength([0, 0, 3, 4, 3, 10]), 11, 1e-9), 'longitud');
  });

  test('pintura: dureza (100 % borde nítido, 0 % caída desde el centro, monótona)', () => {
    ok(M.dabAlpha(9.9, 10, 100) === 1 && M.dabAlpha(10, 10, 100) === 0, 'dureza 100');
    ok(M.dabAlpha(0, 10, 0) === 1 && near(M.dabAlpha(5, 10, 0), 0.5, 1e-9) && M.dabAlpha(10, 10, 0) === 0, `dureza 0: ${M.dabAlpha(5, 10, 0)}`);
    ok(M.dabAlpha(4, 10, 50) === 1 && near(M.dabAlpha(7.5, 10, 50), 0.5, 1e-9), 'dureza 50: plena hasta media radio');
    let prev = 2;
    for (let r = 0; r <= 10; r += 0.5) { const a = M.dabAlpha(r, 10, 30); ok(a <= prev + 1e-12, `monótona en ${r}`); prev = a; }
  });

  test('pintura: Simulación de escritura, Constante, Un fotograma y Personalizar (duración del trazo)', () => {
    const w = M.strokeTiming('writeOn', 1, { layerEnd: 10, fps: 25, drawTime: 2 });
    ok(w.in === 1 && w.out === 10 && w.endKeys.length === 2 && w.endKeys[0].t === 1 && w.endKeys[0].v === 0 && w.endKeys[1].t === 3 && w.endKeys[1].v === 100, JSON.stringify(w));
    const k = M.strokeTiming('constant', 2, { layerEnd: 10, fps: 25 });
    ok(k.in === 2 && k.out === 10 && !k.endKeys, 'constante');
    ok(near(M.strokeTiming('single', 2, { layerEnd: 10, fps: 25 }).out, 2.04, 1e-9), 'un fotograma');
    ok(near(M.strokeTiming('custom', 2, { layerEnd: 10, fps: 25, frames: 5 }).out, 2.2, 1e-9), 'personalizar 5 f');
    // the End keys of a write-on stroke: at mid drawing time, half the path
    const c = M.newComp({ width: 200, height: 100, fps: 30, duration: 4 });
    const l = M.newLayer('solid', c);
    const fx = M.newFx('paint', 200, 100); fx.strokes = [];
    const s = M.newStroke(c, l, fx, { kind: 'brush', points: [[0, 0], [100, 0]], duration: 'writeOn', at: 1, drawTime: 2 });
    ok(near(core.motion.keyedAt(s.end, 2), 50, 1e-6) && core.motion.keyedAt(s.end, 1) === 0 && core.motion.keyedAt(s.end, 3) === 100, `fin a mitad ${core.motion.keyedAt(s.end, 2)}`);
  });

  test('pintura: valores por defecto como After Effects y nombres de los trazos', () => {
    const d = M.defaultPaintOptions();
    ok(d.opacity === 100 && d.flow === 100 && d.mode === 'normal' && d.channels === 'rgba' && d.duration === 'constant' && d.erase === 'all' && d.brush.spacing === 25 && d.brush.roundness === 100 && d.clone.aligned && !d.clone.lockTime, JSON.stringify(d));
    ok(M.ERASE_MODES.map((x) => x.name).join('|') === 'Origen de capa y pintar|Sólo pintar|Sólo último trazo', 'modos de borrado');
    ok(M.PAINT_DURATIONS.map((x) => x.name).join('|') === 'Constante|Simulación de escritura|Un fotograma|Personalizar', 'duraciones');
    ok(M.fxDef('paint').name === 'Pintura' && M.fxDef('paint').params[0].name === 'Pintar sobre transparente' && M.fxDef('paint').params[0].def === 0, 'efecto Pintura');
    const c = M.newComp({ width: 200, height: 100 }), l = M.newLayer('solid', c), fx = M.newFx('paint', 200, 100); fx.strokes = [];
    for (const kind of ['brush', 'brush', 'clone', 'eraser']) fx.strokes.push(M.newStroke(c, l, fx, { kind, points: [[1, 2]] }));
    ok(fx.strokes.map((s) => s.name).join() === 'Pincelar 1,Pincelar 2,Clonar 1,Borrador 1', fx.strokes.map((s) => s.name).join());
    l.effects.push(fx);
    // stroke properties are reachable through property paths (prop_set, expressions) and walked like any other
    ok(M.resolveProp(l, `effects.Pintura.strokes.Pincelar 2.transform.position`) === fx.strokes[1].transform.position, 'resolveProp');
    ok(M.stablePath(l, 'effects.Pintura.strokes.2.end') === `effects.${fx.id}.strokes.${fx.strokes[1].id}.end`, M.stablePath(l, 'effects.Pintura.strokes.2.end'));
    const paths = []; M.forEachProp(l, (_, p) => paths.push(p));
    ok(paths.includes(`effects.${fx.id}.strokes.${fx.strokes[2].id}.clone.timeShift`) && paths.includes(`effects.${fx.id}.strokes.${fx.strokes[0].id}.flow`), 'forEachProp');
    // the stroke transform moves the path
    ok(M.strokePoints([10, 10, 20, 10], { anchor: [10, 10], position: [50, 50], scale: [200, 200], rotation: 90 }).map((v) => Math.round(v)).join() === '50,50,50,70', 'transformar');
  });
};
