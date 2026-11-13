// MCP cases of «datos y scripting»: a comp animated from a CSV column through footage().dataValue (frames match the
// values, and reloading the file changes them), and After Effects scripts run with run_script (model + pixels,
// log, errors, and one undo for the whole script).
import { writeFileSync } from 'node:fs';

export default async ({ test, call, callErr, assert, imgOf, isColor, W }) => {
  const DP = W('datos.cinta');
  /** centre of the bright pixels of a frame (comp px; the frame is rendered at the comp's width) */
  const where = async (comp, t, w = 200) => {
    const img = imgOf(await call('comp_frame', { project: DP, comp, time: t, width: w }));
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const p = img.at((x + 0.01) / img.width, (y + 0.01) / img.height); const v = (p[0] + p[1] + p[2]) / 765; if (v > 0.2) { sx += (x + 0.5) * v; sy += (y + 0.5) * v; n += v; } }
    const k = w / img.width;
    return n ? [(sx / n) * k, (sy / n) * k] : [NaN, NaN];
  };

  await test('datos: una columna de un CSV mueve una capa con footage().dataValue([1, fotograma]); volver a cargar el archivo cambia la animación', async () => {
    const csv = W('serie.csv');
    writeFileSync(csv, 'fotograma,x,"nota, con coma"\n0,20,"a"\n1,60,"b ""c"""\n2,100,\n3,150,d\n');
    await call('project_new', { path: DP, width: 200, height: 100, fps: 10 });
    await call('comp_new', { project: DP, name: 'Datos', width: 200, height: 100, fps: 10, duration: 1, bg: '#000000' });
    const lay = (await call('layer_add', { project: DP, comp: 'Datos', type: 'solid', color: '#ffffff', width: 8, height: 8, name: 'P' })).layer.id;
    const r = await call('data_import', { project: DP, paths: [csv] });
    assert(r.data.length === 1 && r.data[0].name === 'serie.csv' && r.data[0].rows === 4 && r.data[0].columns.join('|') === 'fotograma|x|nota, con coma', JSON.stringify(r.data));
    await call('prop_set', { project: DP, comp: 'Datos', layer: lay, path: 'position', expression: '[footage("serie.csv").dataValue([1, Math.min(3, timeToFrames(time))]), 50]' });
    const xs = [];
    for (const t of [0, 0.1, 0.2, 0.3]) xs.push((await where('Datos', t))[0]);
    assert([20, 60, 100, 150].every((v, i) => Math.abs(xs[i] - v) < 1), `x por fotograma ${xs.map((x) => x.toFixed(1))}`);
    writeFileSync(csv, 'fotograma,x\n0,30\n1,170\n');
    const rl = await call('data_import', { project: DP, reload: ['serie.csv'] });
    assert(rl.data[0].rows === 2, JSON.stringify(rl.data));
    const [a, b] = [(await where('Datos', 0))[0], (await where('Datos', 0.1))[0]];
    assert(Math.abs(a - 30) < 1 && Math.abs(b - 170) < 1, `tras volver a cargar: ${a}, ${b}`);
    const l = await call('data_import', { project: DP });
    assert(l.data[0].expression === 'footage("serie.csv").dataValue([0, 0])', JSON.stringify(l.data));
    const bad = W('mal.json'); writeFileSync(bad, '{ "a": ');
    const err = await callErr('data_import', { project: DP, paths: [bad] });
    assert(/no es un JSON válido/.test(err), err);
  });

  await test('datos: run_script con un .jsx crea composición, sólido y fotogramas clave (modelo y píxeles); undo deshace todo el script', async () => {
    const jsx = W('crear.jsx');
    writeFileSync(jsx, [
      '#target aftereffects',
      'app.beginUndoGroup("Crear");',
      'var comp = app.project.items.addComp("Script", 200, 100, 1, 2, 10);',
      'var s = comp.layers.addSolid([1, 0, 0], "Rojo", 20, 20, 1);',
      'var p = s.property("Transform").property("Position");',
      'p.setValuesAtTimes([0, 1], [[30, 50], [170, 50]]);',
      's.property("ADBE Transform Group").property("ADBE Opacity").setValue(100);',
      '$.writeln("claves: " + p.numKeys);',
      'alert("hecho");',
      'app.endUndoGroup();',
    ].join('\n'));
    const before = (await call('comp_get', { project: DP })).comps.length;
    const r = await call('run_script', { project: DP, file: jsx });
    assert(r.ok && r.log === 'claves: 2\n[alert] hecho' && r.undoGroups[0] === 'Crear' && r.changes.compsAdded[0] === 'Script' && r.changes.keyframes === 2 && r.canUndo, JSON.stringify(r));
    const g = await call('comp_get', { project: DP, comp: 'Script' });
    const L = g.comp?.layers?.[0] ?? g.layers?.[0];
    assert(L && L.name === 'Rojo', JSON.stringify(g).slice(0, 400));
    const [p0, p1] = [await where('Script', 0), await where('Script', 1)];
    assert(Math.abs(p0[0] - 30) < 1.5 && Math.abs(p1[0] - 170) < 1.5 && Math.abs(p0[1] - 50) < 1.5, `posiciones ${p0} ${p1}`);
    const img = imgOf(await call('comp_frame', { project: DP, comp: 'Script', time: 0, width: 200 }));
    assert(isColor(img.at(30 / 200, 0.5), [255, 0, 0]), `rojo ${img.at(30 / 200, 0.5)}`);
    await call('undo', { project: DP });
    const after = await call('comp_get', { project: DP });
    assert(after.comps.length === before && !after.comps.some((c) => c.name === 'Script'), JSON.stringify(after.comps));
  });

  await test('datos: run_script con código: activeItem, errores con línea y registro; sin acceso a process', async () => {
    const r = await call('run_script', { project: DP, comp: 'Datos', code: 'var c = app.project.activeItem;\n$.writeln(c.name, c.numLayers, typeof process, typeof require);\nc.layer(1).name = "Punto";\nnull.x;' });
    assert(!r.ok && r.error.line === 4 && /null/.test(r.error.message) && r.log.startsWith('Datos 1 undefined undefined'), JSON.stringify(r));
    const g = await call('comp_get', { project: DP, comp: 'Datos' });
    assert(JSON.stringify(g).includes('"Punto"'), 'lo hecho antes del error se queda (como After Effects)');
    const t = await call('run_script', { project: DP, code: 'while (true) {}', timeout: 300 });
    assert(!t.ok && /tiempo máximo/.test(t.error.message), JSON.stringify(t.error));
  });
};
