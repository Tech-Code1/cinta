// MCP cases of the speed graph: keyframe_velocity (read / set speed and influence, interpolation buttons) checked on
// rendered frames, and separate_dimensions keeping the motion identical.
export default async ({ test, call, callErr, assert, imgOf, W }) => {
  const VP = W('velocidad.cinta');
  /** centre of the white square in a frame of the comp */
  const where = async (comp, t) => {
    const img = imgOf(await call('comp_frame', { project: VP, comp, time: t }));
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const p = img.at((x + 0.01) / img.width, (y + 0.01) / img.height); const w = (p[0] + p[1] + p[2]) / 765; if (w > 0.02) { sx += (x + 0.5) * w; sy += (y + 0.5) * w; n += w; } }
    const k = 200 / img.width;
    return n ? [(sx / n) * k, (sy / n) * k] : [NaN, NaN];
  };
  let lay;
  const setup = async () => {
    await call('project_new', { path: VP, width: 200, height: 60, fps: 30 });
    await call('comp_new', { project: VP, name: 'Vel', width: 200, height: 60, fps: 30, duration: 2, bg: '#000000' });
    lay = (await call('layer_add', { project: VP, comp: 'Vel', type: 'solid', color: '#ffffff', width: 4, height: 4, name: 'Q' })).layer.id;
    await call('prop_set', { project: VP, comp: 'Vel', layer: lay, path: 'position', keys: [{ t: 0, v: [10, 30] }, { t: 1, v: [190, 30] }] });
  };

  await test('velocidad: keyframe_velocity lee 180 px/s al 16,67 % (lineal) y fija Easy Ease (0 px/s, 33,33 %)', async () => {
    await setup();
    let r = await call('keyframe_velocity', { project: VP, comp: 'Vel', layer: lay, path: 'position' });
    assert(r.keys.length === 2 && Math.abs(r.keys[0].outgoing.speed - 180) < 1e-3 && Math.abs(r.keys[0].outgoing.influence - 16.6667) < 1e-3 && r.keys[0].incoming === null && r.keys[0].alongPath, JSON.stringify(r.keys));
    const lin = await where('Vel', 0.25);
    assert(Math.abs(lin[0] - 55) < 0.6, `lineal a 0,25 s: ${lin}`);
    r = await call('keyframe_velocity', { project: VP, comp: 'Vel', layer: lay, path: 'position', times: [0], out: { speed: 0, influence: 33.333333 } });
    await call('keyframe_velocity', { project: VP, comp: 'Vel', layer: lay, path: 'position', times: [1], in: { speed: 0, influence: 33.333333 } });
    r = await call('keyframe_velocity', { project: VP, comp: 'Vel', layer: lay, path: 'position' });
    assert(r.keys[0].outgoing.speed === 0 && Math.abs(r.keys[1].incoming.influence - 33.3333) < 1e-3, JSON.stringify(r.keys));
    const [a, m] = [await where('Vel', 0.1), await where('Vel', 0.5)];
    assert(Math.abs(m[0] - 100) < 0.6 && a[0] < 20, `suavizado: 0,1 s → ${a[0]}, 0,5 s → ${m[0]}`);
    // the same as the Easy Ease button (interp easy) up to the influence rounding
    await call('keyframe_velocity', { project: VP, comp: 'Vel', layer: lay, path: 'position', interp: 'easy' });
    const a2 = await where('Vel', 0.1);
    assert(Math.abs(a2[0] - a[0]) < 0.3, `F9 ${a2[0]} vs ${a[0]}`);
  });

  await test('velocidad: velocidad de salida 360 px/s al 50 % adelanta el movimiento; Continuo; deshacer', async () => {
    await call('keyframe_velocity', { project: VP, comp: 'Vel', layer: lay, path: 'position', interp: 'linear' });
    const r = await call('keyframe_velocity', { project: VP, comp: 'Vel', layer: lay, path: 'position', times: [0], out: { speed: 360, influence: 50 } });
    assert(Math.abs(r.keys[0].outgoing.speed - 360) < 1e-3 && Math.abs(r.keys[0].outgoing.influence - 50) < 1e-3 && r.canUndo, JSON.stringify(r.keys));
    const p = await where('Vel', 0.05);
    assert(p[0] > 10 + 360 * 0.05 * 0.85 && p[0] < 10 + 360 * 0.05 * 1.05, `0,05 s: ${p[0]} (≈ ${10 + 18})`);
    // three keys: continuous copies the outgoing speed to the incoming side
    await call('prop_set', { project: VP, comp: 'Vel', layer: lay, path: 'rotation', keys: [{ t: 0, v: 0 }, { t: 1, v: 90 }, { t: 2, v: 0 }] });
    const c = await call('keyframe_velocity', { project: VP, comp: 'Vel', layer: lay, path: 'rotation', times: [1], out: { speed: -45 }, continuous: true });
    assert(c.keys[0].continuous && c.keys[0].incoming.speed === -45 && c.keys[0].outgoing.speed === -45, JSON.stringify(c.keys));
    const e = await callErr('keyframe_velocity', { project: VP, comp: 'Vel', layer: lay, path: 'rotation', times: [1.5] });
    assert(/no tiene fotogramas clave en esos instantes/.test(e), e);
  });

  await test('velocidad: separar dimensiones: X/Y/Z independientes con el mismo movimiento, y al unir también', async () => {
    await call('prop_set', { project: VP, comp: 'Vel', layer: lay, path: 'position', keys: [{ t: 0, v: [10, 10] }, { t: 0.8, v: [100, 50], ease: 'easy' }, { t: 1.6, v: [190, 15] }] });
    const ts = [0.2, 0.5, 0.9, 1.3];
    const before = []; for (const t of ts) before.push(await where('Vel', t));
    const s = await call('separate_dimensions', { project: VP, comp: 'Vel', layer: lay, on: true });
    assert(s.separated && s.keys.positionX >= 3, JSON.stringify(s));
    const g = await call('comp_get', { project: VP, comp: 'Vel' });
    const gl = g.comp.layers.find((x) => x.id === lay);
    assert(gl.separated && gl.animated['transform.positionX'] && !gl.animated['transform.position'], JSON.stringify(gl.animated));
    for (let i = 0; i < ts.length; i++) { const p = await where('Vel', ts[i]); assert(Math.hypot(p[0] - before[i][0], p[1] - before[i][1]) < 0.15, `${ts[i]} s: ${p} vs ${before[i]}`); }
    const e = await callErr('prop_set', { project: VP, comp: 'Vel', layer: lay, path: 'position', value: [5, 5], t: 0 });
    assert(/separadas/.test(e), e);
    // a speed graph per dimension: X eased out of its first key
    const v = await call('keyframe_velocity', { project: VP, comp: 'Vel', layer: lay, path: 'positionX', times: [0], out: { speed: 0, influence: 60 } });
    assert(v.keys[0].outgoing.speed === 0 && !v.keys[0].alongPath, JSON.stringify(v.keys));
    // inside the first segment of X (the refit may have added keys)
    const kx = (await call('keyframe_velocity', { project: VP, comp: 'Vel', layer: lay, path: 'positionX' })).keys;
    const tm = Math.round((kx[1].t / 2) * 30) / 30 || 1 / 30;
    const moved = await where('Vel', tm);
    await call('undo', { project: VP });
    const was = await where('Vel', tm);
    await call('redo', { project: VP });
    assert(moved[0] < was[0] - 0.3 && Math.abs(moved[1] - was[1]) < 0.15, `solo X cambia a ${tm} s: ${moved} vs ${was}`);
    const sepNow = []; for (const t of ts) sepNow.push(await where('Vel', t));
    const j = await call('separate_dimensions', { project: VP, comp: 'Vel', layer: lay, on: false });
    assert(!j.separated && j.keys.position >= 3, JSON.stringify(j));
    for (let i = 0; i < ts.length; i++) { const p = await where('Vel', ts[i]); assert(Math.hypot(p[0] - sepNow[i][0], p[1] - sepNow[i][1]) < 0.15, `unidas ${ts[i]} s: ${p} vs ${sepNow[i]}`); }
    await call('undo', { project: VP });
    const back = await call('comp_get', { project: VP, comp: 'Vel' });
    assert(back.comp.layers.find((x) => x.id === lay).separated, 'deshacer vuelve a separadas');
  });
};
