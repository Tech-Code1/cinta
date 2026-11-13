// MCP cases of the «particulas» effects: rendered pixels through comp_frame.
export default async ({ test, call, assert, imgOf, W }) => {
  const P = W('particulas.cinta');
  let n = 0;
  /** a 200×100 comp with one blue solid, the effect on it, the frame at t */
  const shot = async (fx, values = {}, o = {}) => {
    const comp = `P${++n}`;
    await call('comp_new', { project: P, name: comp, width: 200, height: 100, fps: 30, duration: 3, bg: '#000000' });
    const l = (await call('layer_add', { project: P, comp, type: 'solid', color: o.color ?? '#3366cc', width: 200, height: 100 })).layer.id;
    if (fx) await call('effect_add', { project: P, comp, layer: l, effect: fx, values });
    const r = await call('comp_frame', { project: P, comp, time: o.t ?? 0.5, width: 200 });
    assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`);
    const im = imgOf(r);
    await call('comp_delete', { project: P, comp });
    return { at: (x, y) => im.at((x + 0.5) / 200, (y + 0.5) / 100) };
  };
  const count = (im, f, y0 = 0, y1 = 100) => { let k = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < 200; x++) if (f(im.at(x, y))) k++; return k; };
  const red = (q) => q[0] > 120 && q[1] < 80 && q[2] < 80, blue = (q) => q[2] > 150 && q[0] < 80;

  await test('particulas: proyecto propio', async () => { await call('project_new', { path: P, width: 640, height: 360, fps: 30 }); });

  await test('particulas: Animación del objeto — puntos rojos del cañón en lugar de la capa, la gravedad y la cuadrícula', async () => {
    // defaults: red dots shot up from the centre, pulled down by gravity; the blue layer is gone; the same frame twice
    const a = await shot('particlePlayground', { cRadius: 3 }, { t: 0.6 }), b = await shot('particlePlayground', { cRadius: 3 }, { t: 0.6 });
    assert(count(a, red) > 30 && count(a, blue) === 0, `puntos rojos: ${count(a, red)}, azul ${count(a, blue)}`);
    let same = true; for (let x = 0; x < 200; x += 3) for (let y = 0; y < 100; y += 3) if (a.at(x, y).join() !== b.at(x, y).join()) same = false;
    assert(same, 'determinista');
    // aimed down (180°) without gravity: everything below the centre
    const d = await shot('particlePlayground', { cRadius: 3, cDir: 180, grForce: 0 }, { t: 0.4 });
    assert(count(d, red, 55, 100) > 20 && count(d, red, 0, 45) === 0, `hacia abajo: ${count(d, red, 55, 100)} / ${count(d, red, 0, 45)}`);
    // a 5 × 3 grid, no cannon, no gravity: dots at the intersections (100 × 100 around the centre)
    const g = await shot('particlePlayground', { cRate: 0, gAcross: 5, gDown: 3, gRadius: 3, grForce: 0, gColor: '#00ff00' }, { t: 0.2 });
    assert(g.at(50, 50)[1] > 150 && g.at(100, 50)[1] > 150 && g.at(150, 50)[1] > 150 && g.at(75, 25)[1] < 40, `cuadrícula: ${g.at(50, 50)} ${g.at(75, 25)}`);
  });

  await test('particulas: CC PS Classic y CC PS LE Classic sustituyen la capa por partículas', async () => {
    const c = await shot('ccPsClassic', {}, { t: 0.8 }), l = await shot('ccPsLe', {}, { t: 0.8 });
    const lit = (q) => q[0] + q[1] > 120;
    assert(count(c, lit) > 30 && count(c, blue) === 0, `Classic: ${count(c, lit)}`);
    assert(count(l, lit) > 5 && count(l, blue) === 0, `LE: ${count(l, lit)}`);
  });

  await test('particulas: Texto básico y Texto de trazado', async () => {
    const t = await shot('basicText', { text: 'HHHH', size: 40 });
    assert(count(t, red, 30, 70) > 150 && count(t, blue) === 0, `texto rojo: ${count(t, red, 30, 70)}`);
    const tc = await shot('basicText', { text: 'HH', size: 40, composite: true });
    assert(tc.at(5, 5)[2] > 150 && count(tc, red) > 50, 'compuesto sobre el original');
    // a circle of radius 40 around the centre: red on the ring, nothing in the middle
    const p = await shot('pathText', { shapeType: 'circle', vertex1: [100, 50], tangent1: [100, 10], text: 'OOOOOOOOOOOOOOOOOOOO', size: 14 });
    assert(count(p, red) > 80 && count(p, red, 40, 60) < count(p, red) / 3 && !red(p.at(100, 50)), `texto en círculo: ${count(p, red)}`);
    // Visible Characters 0 hides it all
    const v = await shot('pathText', { text: 'HHHH', visibleChars: 0 });
    assert(count(v, red) === 0, 'caracteres visibles 0');
  });

  await test('particulas: Pintura vectorial — trazos desde MCP, modos de reproducción y pintura compuesta', async () => {
    const strokes = JSON.stringify([{ t: 0, color: '#ffffff', radius: 4, feather: 0, points: [[20, 50, 0], [180, 50, 1]] }]);
    const all = await shot('vectorPaint', { strokes, playback: 'all' });
    assert(all.at(100, 50).every((v) => v > 230) && blue(all.at(100, 20)), `trazo sobre el original: ${all.at(100, 50)}`);
    // Animate Strokes at 0.5 s: half of the stroke
    const an = await shot('vectorPaint', { strokes, playback: 'animate' });
    assert(an.at(80, 50).every((v) => v > 230) && blue(an.at(150, 50)), `animar trazos: ${an.at(150, 50)}`);
    // Current Frame: painted at 0 s, not shown at 0.5 s; Only: no layer
    const cf = await shot('vectorPaint', { strokes });
    assert(blue(cf.at(100, 50)), 'fotograma actual');
    const only = await shot('vectorPaint', { strokes, playback: 'all', composite: 'only' });
    assert(only.at(100, 50).every((v) => v > 230) && only.at(100, 20).every((v) => v < 20), 'sólo');
    const mt = await shot('vectorPaint', { strokes, playback: 'all', composite: 'asMatte' });
    assert(blue(mt.at(100, 50)) && mt.at(100, 20).every((v) => v < 20), 'como máscara');
  });
};
