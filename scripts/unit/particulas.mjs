// Unit tests of the «particulas» effects: Particle Playground (parameters and its simulation), CC PS
// Classic / LE, Basic Text, Path Text and Vector Paint.
export default ({ test, ok, near, M, core }) => {
  const fx = (id) => M.FX.find((f) => f.id === id);
  const def = (id, p) => fx(id).params.find((q) => q.id === p);
  const defaults = (id) => Object.fromEntries(fx(id).params.map((q) => [q.id, q.def]));

  test('particulas: Animación del objeto — Cannon, Cuadrícula, explosiones, Gravedad, Rechazar, Muro y mapeadores', () => {
    const pp = 'particlePlayground';
    ok(fx(pp) && fx(pp).name === 'Animación del objeto' && fx(pp).cat === 'Simulación', 'nombre y categoría');
    // Cannon (ids 100–110): 60/s (0–30000), direction 0, spread 20, velocity 130 ± 20, red, radius 2
    ok(def(pp, 'cRate').def === 60 && def(pp, 'cRate').max === 30000 && def(pp, 'cDir').def === 0 && def(pp, 'cDirSpread').def === 20 && def(pp, 'cVel').def === 130 && def(pp, 'cVelSpread').def === 20 && def(pp, 'cColor').def === '#ff0000' && def(pp, 'cRadius').def === 2 && def(pp, 'cBarrel').min === -4000, 'Cannon');
    ok(def(pp, 'gWidth').def === 100 && def(pp, 'gAcross').def === 0 && def(pp, 'gDown').def === 0 && def(pp, 'gAcross').max === 10000, 'Cuadrícula');
    ok(def(pp, 'leRadius').def === 2 && def(pp, 'leDisp').def === 20 && def(pp, 'peRadius').def === 0 && def(pp, 'peDisp').def === 20, 'explosiones');
    ok(def(pp, 'grForce').def === 120 && def(pp, 'grForce').max === 10000 && def(pp, 'grDir').def === 180 && def(pp, 'grSpread').max === 4000, 'Gravedad');
    ok(def(pp, 'rpForce').def === 0 && def(pp, 'rpForce').max === 2000 && def(pp, 'rpRadius').def === 10, 'Rechazar');
    ok(def(pp, 'grFrom').choices.length === 16 && def(pp, 'grFrom').def === 'all' && def(pp, 'grChars').choices.length === 4 && def(pp, 'grAge').max === 30000 && def(pp, 'grAgeFeather').max === 60000, 'Afecta a');
    ok(def(pp, 'pmRTo').choices.length === 27 && def(pp, 'emRTo').choices.length === 19 && def(pp, 'emROp').choices.length === 7 && def(pp, 'pmRMax').def === 1 && def(pp, 'pmRMin').min === -200000 && !def(pp, 'pmROp'), 'mapeadores');
    ok(def(pp, 'lmOffsetType').choices.length === 4 && def(pp, 'lmOffset').max === 10000, 'Mapa de capa');
  });

  const env = (over = {}, w = 200, h = 200) => {
    const P = { ...defaults('particlePlayground'), cPos: [w / 2, h / 2], gPos: [w / 2, h / 2], ...over };
    return { w, h, fps: 30, seed: 5, at: () => P };
  };
  test('particulas: Animación del objeto — el cañón dispara hacia arriba, la gravedad tira hacia abajo, determinista', () => {
    const S = M.ppSimulate(env({ grForce: 0, cDirSpread: 0, cVelSpread: 0 }), 1);
    ok(near(S.parts.length, 60, 2), `60 objetos/s → ${S.parts.length}`);
    const old = S.parts[0];
    ok(old.y < 100 - 100 && Math.abs(old.x - 100) < 1, `hacia arriba: ${old.x},${old.y}`);
    const G = M.ppSimulate(env({ cRate: 2, cVel: 0, cVelSpread: 0 }), 1.5);
    const q = G.parts[0];
    // born at 0.5 s, 120 px/s² for ~1 s: ½·120·1² ≈ 60 px down
    ok(q && q.y > 140 && q.y < 175, `gravedad: ${q.y}`);
    const A = M.ppSimulate(env(), 1.5), B = M.ppSimulate(env(), 1.5);
    ok(JSON.stringify(A.parts) === JSON.stringify(B.parts), 'determinista');
    // going on from a cached state gives the same as from 0
    const C = M.ppSimulate(env(), 0.7); M.ppSimulate(env(), 1.5, C);
    ok(JSON.stringify(C.parts) === JSON.stringify(A.parts), 'continuar desde la caché = desde 0');
  });
  test('particulas: Animación del objeto — cuadrícula, explosión de objetos, muro, afecta a y mapeador constante', () => {
    const G = M.ppSimulate(env({ cRate: 0, gAcross: 3, gDown: 2, grForce: 0 }), 2 / 30);
    ok(G.parts.length === 12 && G.parts.every((q) => q.src === 'g'), `cuadrícula: ${G.parts.length}`);
    const E = M.ppSimulate(env({ cRate: 30, cRadius: 8, peRadius: 2, grForce: 0 }), 0.5);
    ok(E.parts.length > 30 && E.parts.every((q) => q.src === 'p' && q.r === 2), `explosión de objetos: ${E.parts.length}`);
    // a square wall around the cannon keeps the particles in
    const box = [50, 50, 150, 50, 150, 150, 50, 150];
    const Wl = M.ppSimulate({ ...env({ cRate: 20, grForce: 0, wBoundary: 'Máscara 1' }), mask: () => box }, 3);
    ok(Wl.parts.length > 40 && Wl.parts.every((q) => q.x > 40 && q.x < 160 && q.y > 40 && q.y < 160), 'muro');
    const No = M.ppSimulate(env({ cRate: 20, grForce: 0 }), 3);
    ok(No.parts.some((q) => q.y < 40), 'sin muro salen');
    // gravity only on particles older than 1 s
    const Ag = M.ppSimulate(env({ cRate: 2, cVel: 0, cVelSpread: 0, grAge: 1 }), 0.9);
    ok(Ag.parts.length === 1 && Math.abs(Ag.parts[0].y - 100) < 0.01, 'mayores que 1 s: los jóvenes no caen');
    // persistent mapper: the map's red to Opacity, Min 0 Max 0.5 → half opacity on a white map
    const Pm = M.ppSimulate({ ...env({ cRate: 10, pmMap: 'L', pmRTo: 'opacity', pmRMax: 0.5 }), sample: () => [1, 1, 1, 1] }, 0.5);
    ok(Pm.parts.length && Pm.parts.every((q) => near(q.op, 0.5)), 'mapeador constante');
    ok(M.ppAffects({ src: 'c', born: 0, x: 0, y: 0, ch: '' }, { grFrom: 'g' }, 'gr', 1, env()) === 0 && M.ppAffects({ src: 'g', born: 0, x: 0, y: 0, ch: '' }, { grFrom: 'cg' }, 'gr', 1, env()) === 1, 'objetos desde');
    // the ephemeral mapper changes only the frame drawn
    const ee = { ...env({ cRate: 10, emMap: 'L', emRTo: 'red', emROp: 'set', emRMax: 0 }), sample: () => [1, 1, 1, 1] }, Se = M.ppSimulate(ee, 0.5), d = M.ppDisplay(Se, ee, 0.5);
    ok(d.every((q) => q.col[0] === 0) && Se.parts.every((q) => q.col[0] === 1), 'mapeador efímero');
    // layer exploder: an opaque 20 × 20 layer gives (20 / 4)² pieces of radius 2
    const px = new Uint8ClampedArray(20 * 20 * 4).fill(255);
    const Le = M.ppSimulate({ ...env({ cRate: 0, leLayer: 'L', grForce: 0 }, 20, 20), pixels: () => ({ data: px, w: 20, h: 20 }) }, 0.1);
    ok(Le.parts.length === 25 && Le.parts.every((q) => q.src === 'l'), `explosión de capas: ${Le.parts.length}`);
  });

  test('particulas: CC PS Classic y CC PS LE Classic sobre el emisor de CC Particle Systems II', () => {
    ok(def('ccPsClassic', 'birthRate').def === 10 && def('ccPsClassic', 'velocity').max === 1024 && def('ccPsClassic', 'animation').choices.length === 17 && def('ccPsClassic', 'animation').def === 'starLight' && def('ccPsClassic', 'deathColor').def === '#20f010', 'Classic');
    ok(def('ccPsLe', 'radiusX').def === 4 && def('ccPsLe', 'birthRate').def === 5 && def('ccPsLe', 'animation').choices.length === 21 && def('ccPsLe', 'animation').def === 'fractalExplosion' && def('ccPsLe', 'deathColor').def === '#c81010', 'LE');
    const ps = M.psClassicToII({ ...defaults('ccPsLe') }, true), ids = fx('ccParticleSystems2').params;
    ok(ps.animation === 'fractalExplosive' && ps.radiusX === 4 && ids.find((q) => q.id === 'particleType').choices.some((c) => c.id === ps.particleType), 'LE → PS II');
    for (const [k] of M.PS_LE_ANIM.concat(M.PS_CLASSIC_ANIM)) ok(M.PS_PRESETS[k], `preajuste ${k}`);
  });

  test('particulas: Texto básico y Texto de trazado', () => {
    ok(def('basicText', 'size').def === 36 && def('basicText', 'size').max === 1024 && def('basicText', 'fillColor').def === '#ff0000' && def('basicText', 'strokeWidth').max === 128 && def('basicText', 'lineSpacing').def === 100 && def('basicText', 'display').def === 'fill', 'Texto básico');
    const pt = 'pathText';
    ok(def(pt, 'shapeType').choices.map((c) => c.id).join() === 'bezier,circle,loop,line' && near(def(pt, 'tangent1').def[0], 0.25) && near(def(pt, 'vertex2').def[0], 0.8), 'trazado');
    ok(def(pt, 'visibleChars').def === 1024 && def(pt, 'visibleChars').min === -1024 && def(pt, 'fadeTime').def === 0 && def(pt, 'perpendicular').def === 1 && def(pt, 'rotateRoman').def === 1 && def(pt, 'hShear').max === 70 && def(pt, 'hScale').max === 2000 && def(pt, 'alignment').choices.length === 4 && def(pt, 'rotationJitter').max === 360 && def(pt, 'kerningValue').max === 30000, 'Texto de trazado');
    const c = M.ptPath('circle', [100, 100], [100, 50], [0, 0], [0, 0], null, false);
    ok(c.closed && near(c.pts[0], 100) && near(c.pts[1], 50) && near(Math.hypot(c.pts[64] - 100, c.pts[65] - 100), 50), 'círculo desde arriba, radio 50');
    const l = M.ptPath('line', [0, 0], [0, 0], [0, 0], [10, 0], null, true);
    ok(l.pts.join() === '10,0,0,0', 'línea invertida');
    const b = M.ptPath('bezier', [0, 0], [0, -30], [100, -30], [100, 0], null, false);
    ok(near(b.pts[96], 50) && b.pts[97] < -20, 'Bézier sube por las tangentes');
  });

  test('particulas: Pintura vectorial — trazos guardados y modos de reproducción', () => {
    ok(def('vectorPaint', 'playback').def === 'current' && def('vectorPaint', 'playback').choices.length === 6 && def('vectorPaint', 'composite').def === 'inOriginal' && def('vectorPaint', 'composite').choices.length === 10 && def('vectorPaint', 'wigglesPerSec').def === 30 && def('vectorPaint', 'pressVariation').def === 70 && def('vectorPaint', 'individualSeeds').def === 1, 'parámetros');
    const S = M.vpParse(JSON.stringify([{ t: 0, p: [[0, 0, 0], [10, 0, 0.5], [20, 0, 1]] }, { t: 1, color: '#00ff00', radius: 3, points: [5, 5, 6, 6] }, { bad: 1 }]), { c: '#ff0000', r: 9, f: 0, o: 100 });
    ok(S.length === 2 && S[0].c === '#ff0000' && S[0].r === 9 && S[1].c === '#00ff00' && S[1].r === 3 && S[1].pts.length === 2, 'trazos');
    const v = (m, t) => M.vpVisible(S, m, t, 30).map((q) => `${q.s.t}:${Number.isFinite(q.upto) ? q.upto.toFixed(2) : 'all'}`).join();
    ok(v('all', 0) === '0:all,1:all', 'todos');
    ok(v('current', 0) === '0:all' && v('current', 0.5) === '' && v('current', 1) === '1:all', 'fotograma actual');
    ok(v('past', 0.5) === '0:all' && v('past', 2) === '0:all,1:all', 'anteriores');
    ok(v('hold', 0.5) === '0:all' && v('hold', 1.5) === '1:all', 'mantener');
    ok(v('animate', 0.5) === '0:0.50' && v('animate', 1.2) === '0:1.20,1:0.20', 'animar');
    ok(M.vpVisible(S, 'onion', 1 / 30, 30).some((q) => q.tint === 'back') && M.vpVisible(S, 'onion', 29 / 30, 30).some((q) => q.tint === 'fwd'), 'piel de cebolla');
  });

  test('particulas: nombres de coincidencia de After Effects', () => {
    const m = { 'ADBE Playgnd': 'particlePlayground', 'CC PS Classic': 'ccPsClassic', 'CC PS LE Classic': 'ccPsLe', 'ADBE Basic Text2': 'basicText', 'ADBE Path Text': 'pathText', 'ADBE Vector Paint': 'vectorPaint' };
    for (const [k, id] of Object.entries(m)) ok(core.AE_EFFECTS[k] === id && core.AE_EFFECT_NAMES[k], k);
  });
};
