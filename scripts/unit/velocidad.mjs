// Unit tests of the speed graph / keyframe velocity (After Effects' speed and influence ↔ the normalised bezier
// handles Cinta stores) and of Separate Dimensions.
export default ({ test, ok, near, M }) => {
  const P1 = () => ({ v: 0, k: [{ t: 0, v: 0 }, { t: 2, v: 100 }, { t: 3, v: 40 }] });
  const sp = (p, i, t) => M.speedIn(p, i, t, false)[0];

  test('velocidad: clave lineal = velocidad media con influencia 16,67 % (como After Effects)', () => {
    const v = M.keyVelocity(P1(), 1, false);
    ok(near(v.in.speed[0], 50) && near(v.in.influence, 100 / 6), `entrada ${JSON.stringify(v.in)}`);
    ok(near(v.out.speed[0], -60) && near(v.out.influence, 100 / 6), `salida ${JSON.stringify(v.out)}`);
  });
  test('velocidad: Desacelerac./Acelerac. suave (F9) = velocidad 0 e influencia 33,33 %', () => {
    const p = P1();
    M.easeKeysAE(p, [1], 'easy', false);
    const v = M.keyVelocity(p, 1, false);
    ok(near(v.in.speed[0], 0) && near(v.out.speed[0], 0) && near(v.in.influence, 33.3333) && near(v.out.influence, 33.3333) && v.continuous, JSON.stringify(v));
    // the other sides keep their linear motion: key 0 still leaves at 50/s, key 2 still arrives at −60/s
    ok(near(M.keyVelocity(p, 0, false).out.speed[0], 50) && near(M.keyVelocity(p, 2, false).in.speed[0], -60), 'los lados vecinos siguen lineales');
    // the motion: slow at the key, 50 at the middle of a symmetric eased... (first segment: linear out, eased in)
    ok(near(sp(p, 0, 2 - 1e-6), 0, 1e-3) && near(sp(p, 1, 2), 0, 1e-3), 'velocidad 0 en la clave');
    // easeKeys of keyframe_edit: 33.3 %
    const q = P1(); M.easeKeys(q.k, 'easy');
    ok(near(M.keyVelocity(q, 1, false).out.influence, 33.3, 0.01) && near(M.keyVelocity(q, 1, false).out.speed[0], 0), 'easeKeys también');
  });
  test('velocidad: Desaceleración suave (Mayús+F9) solo la entrada; Aceleración suave solo la salida', () => {
    const p = P1(); M.easeKeysAE(p, [1], 'in', false);
    let v = M.keyVelocity(p, 1, false);
    ok(near(v.in.speed[0], 0) && near(v.out.speed[0], -60) && near(v.out.influence, 100 / 6), JSON.stringify(v));
    const q = P1(); M.easeKeysAE(q, [1], 'out', false);
    v = M.keyVelocity(q, 1, false);
    ok(near(v.out.speed[0], 0) && near(v.in.speed[0], 50), JSON.stringify(v));
  });
  test('velocidad: velocidad/influencia → bezier → velocidad/influencia (ida y vuelta)', () => {
    for (const [s, f] of [[0, 33.33], [120, 75], [-30, 10], [400, 100], [12.5, 0.5]]) {
      const p = P1();
      M.setKeyVelocity(p, 1, false, { out: { speed: s, influence: f }, in: { speed: s / 2, influence: 100 - f / 2 } });
      const v = M.keyVelocity(p, 1, false);
      ok(near(v.out.speed[0], s, 1e-6) && near(v.out.influence, f, 1e-6) && near(v.in.speed[0], s / 2, 1e-6) && near(v.in.influence, 100 - f / 2, 1e-6), `${s}, ${f}: ${JSON.stringify(v)}`);
      // and the evaluator follows: the measured speed at the key is the one set
      ok(near(sp(p, 1, 2), s, 0.05) && near(sp(p, 0, 2 - 1e-7), s / 2, 0.05), `medida ${sp(p, 1, 2)} ${sp(p, 0, 2 - 1e-7)}`);
      const dv = (M.keyedAt(p, 2 + 1e-4) - M.keyedAt(p, 2)) / 1e-4; if (f < 10) continue;
      ok(near(dv, s, Math.max(0.1, Math.abs(s) * 0.01)), `derivada numérica ${dv} vs ${s}`);
    }
  });
  test('velocidad: valores conocidos de After Effects (0 → 100 en 1 s: lineal 100/s; manejador [0.5, 0.75] = 150/s al 50 %)', () => {
    const p = { v: 0, k: [{ t: 0, v: 0, i: 'bezier', eo: [0.5, 0.75] }, { t: 1, v: 100, ei: [0.5, 1] }] };
    const v = M.keyVelocity(p, 0, false);
    ok(near(v.out.speed[0], 150) && near(v.out.influence, 50), JSON.stringify(v));
    ok(near(M.keyVelocity(p, 1, false).in.speed[0], 0) && near(M.keyVelocity(p, 1, false).in.influence, 50), 'entrada 0 /s al 50 %');
  });
  test('velocidad: Continuo copia la velocidad al otro lado; mantener no tiene velocidad de salida', () => {
    const p = P1();
    M.setKeyVelocity(p, 1, false, { out: { speed: 20 }, continuous: true });
    const v = M.keyVelocity(p, 1, false);
    ok(v.continuous && near(v.in.speed[0], 20) && near(v.out.speed[0], 20), JSON.stringify(v));
    M.easeKeysAE(p, [1], 'hold', false);
    ok(M.keyVelocity(p, 1, false).out === null && M.keyedAt(p, 2.9) === 100, 'mantener');
  });
  test('velocidad: posición = velocidad a lo largo de la trayectoria (también curva)', () => {
    const p = { v: [0, 0, 0], k: [{ t: 0, v: [0, 0, 0] }, { t: 1, v: [300, 400, 0] }] };
    ok(near(M.keyVelocity(p, 0, true).out.speed[0], 500), `recta: ${M.keyVelocity(p, 0, true).out.speed}`);
    const q = { v: [0, 0, 0], k: [{ t: 0, v: [0, 0, 0] }, { t: 1, v: [500, 500, 0] }, { t: 2, v: [1000, 0, 0] }] };
    M.setKeyVelocity(q, 0, true, { out: { speed: 900, influence: 40 } });
    const v = M.keyVelocity(q, 0, true);
    ok(near(v.out.speed[0], 900, 1e-6) && v.dims === 1, JSON.stringify(v));
    // measured: distance travelled along the path in a small step
    const a = M.keyedAt(q, 0, true), b = M.keyedAt(q, 1e-4, true);
    ok(near(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1e-4, 900, 27), `medida ${Math.hypot(b[0] - a[0], b[1] - a[1]) / 1e-4}`);
    // speed graph: constant speed on a linear path is the length / time
    const L = M.segmentLength(q.k, 1);
    ok(near(M.speedIn(q, 1, 1.5, true)[0], L, 1e-6) && L > Math.hypot(500, 500), `gráfico ${M.speedIn(q, 1, 1.5, true)} vs ${L}`);
  });
  test('velocidad: escala por dimensión (las dimensiones comparten curva)', () => {
    const p = { v: [100, 100, 100], k: [{ t: 0, v: [100, 100, 100] }, { t: 1, v: [200, 150, 100] }] };
    let v = M.keyVelocity(p, 0, false);
    ok(v.dims === 3 && near(v.out.speed[0], 100) && near(v.out.speed[1], 50) && near(v.out.speed[2], 0), JSON.stringify(v));
    M.setKeyVelocity(p, 0, false, { out: { speed: [300, 0, 0], influence: 50 } });
    v = M.keyVelocity(p, 0, false);
    ok(near(v.out.speed[0], 300) && near(v.out.speed[1], 150), JSON.stringify(v));
  });
  test('velocidad: curva automática = pendiente entre las vecinas, 16,67 %, continua', () => {
    const p = { v: 0, k: [{ t: 0, v: 0 }, { t: 1, v: 100 }, { t: 3, v: 300 }] };
    M.easeKeysAE(p, [1], 'auto', false);
    const v = M.keyVelocity(p, 1, false);
    ok(near(v.out.speed[0], 100) && near(v.in.speed[0], 100) && near(v.in.influence, 100 / 6) && v.autoBezier && v.continuous, JSON.stringify(v));
  });
  test('separar dimensiones: recta → X/Y/Z con la misma suavización; unir vuelve exacto', () => {
    const comp = M.newComp({ width: 1920, height: 1080, duration: 4 });
    const l = M.newLayer('solid', comp, {}); comp.layers.push(l);
    l.transform.position = { v: [0, 0, 0], k: [{ t: 0, v: [0, 0, 0], i: 'bezier', eo: [0.4, 0] }, { t: 2, v: [800, 300, 0], ei: [0.7, 1], i: 'hold', sl: true }, { t: 3, v: [100, 100, 0] }] };
    const env = { comp, layer: l, path: 'transform.position' };
    const before = [0.3, 1, 1.7, 2.5, 3.5].map((t) => M.valueAt(l.transform.position, t, env));
    M.separatePosition(l);
    ok(M.isSeparated(l) && l.transform.positionX.k.length === 3 && !l.transform.position.k, 'separada');
    const sep = [0.3, 1, 1.7, 2.5, 3.5].map((t) => M.valueAt(l.transform.position, t, env));
    ok(before.every((v, i) => v.every((x, d) => near(x, sep[i][d], 1e-6))), `${JSON.stringify(before)} vs ${JSON.stringify(sep)}`);
    M.joinPosition(l);
    const back = [0.3, 1, 1.7, 2.5, 3.5].map((t) => M.valueAt(l.transform.position, t, env));
    ok(!M.isSeparated(l) && l.transform.position.k.length === 3 && before.every((v, i) => v.every((x, d) => near(x, back[i][d], 1e-6))), `${JSON.stringify(back)}`);
  });
  test('separar dimensiones: trayectoria curva se reajusta por dimensión (< 0,05 px)', () => {
    const comp = M.newComp({ width: 1920, height: 1080, duration: 4 });
    const l = M.newLayer('solid', comp, {}); comp.layers.push(l);
    l.transform.position = { v: [0, 0, 0], k: [{ t: 0, v: [100, 100, 0] }, { t: 1, v: [900, 700, 0], i: 'bezier', eo: [0.333, 0], ei: [0.667, 1] }, { t: 3, v: [1500, 100, 0] }] };
    const env = { comp, layer: l, path: 'transform.position' };
    const ts = Array.from({ length: 91 }, (_, i) => i / 30);
    const before = ts.map((t) => M.valueAt(l.transform.position, t, env));
    M.separatePosition(l);
    let err = 0;
    ts.forEach((t, i) => { const v = M.valueAt(l.transform.position, t, env); err = Math.max(err, Math.hypot(v[0] - before[i][0], v[1] - before[i][1])); });
    ok(err < 0.05, `error ${err}`);
    // X / Y with different easing joined back: more keys, same motion
    l.transform.positionY.k[1].eo = [0.1, 0.9];
    const sepv = ts.map((t) => M.valueAt(l.transform.position, t, env));
    M.joinPosition(l);
    let err2 = 0;
    ts.forEach((t, i) => { const v = M.valueAt(l.transform.position, t, env); err2 = Math.max(err2, Math.hypot(v[0] - sepv[i][0], v[1] - sepv[i][1])); });
    ok(err2 < 0.05 && l.transform.position.k.length >= 3, `error ${err2}, ${l.transform.position.k.length} claves`);
  });
  test('separar dimensiones: expresiones de X/Y y transform.xPosition', () => {
    const comp = M.newComp({ width: 1920, height: 1080, duration: 4 });
    const l = M.newLayer('null', comp, {}); comp.layers.push(l);
    M.separatePosition(l);
    l.transform.positionX.x = 'time * 100';
    const v = M.valueAt(l.transform.position, 2, { comp, layer: l, path: 'transform.position' });
    ok(near(v[0], 200) && near(v[1], 540), JSON.stringify(v));
    const m = M.newLayer('null', comp, {}); comp.layers.push(m);
    m.transform.rotation.x = 'thisComp.layer(1).transform.xPosition';
    ok(near(M.valueAt(m.transform.rotation, 1, { comp, layer: m, path: 'transform.rotation' }), 100), 'xPosition');
  });
};
