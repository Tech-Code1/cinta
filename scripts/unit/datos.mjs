// Unit tests of «datos y scripting»: CSV / TSV parsing (quoted fields), footage() in expressions (dataValue,
// sourceData, dataKey*), MGJSON streams, and the After Effects scripting API mapped onto Cinta's operations.
export default ({ test, ok, near, M, core }) => {
  const { Editor, newProject, runScriptSync: runScript } = core;

  test('datos: CSV con comillas, comas, comillas dobles, saltos de línea y CRLF', () => {
    const rows = M.parseDelimited('a,b,c\r\n1,"x, y","dijo ""hola"""\r\n2,"dos\nlíneas",\n\n3,,""\r\n');
    ok(rows.length === 4, JSON.stringify(rows));
    ok(rows[1][1] === 'x, y' && rows[1][2] === 'dijo "hola"', JSON.stringify(rows[1]));
    ok(rows[2][1] === 'dos\nlíneas' && rows[2][2] === '' && rows[2].length === 3, JSON.stringify(rows[2]));
    ok(rows[3].length === 3 && rows[3][2] === '', JSON.stringify(rows[3]));
    const t = M.parseDelimited('\uFEFFx\ty\n1\t"a\tb"', '\t');
    ok(t[0][0] === 'x' && t[1][1] === 'a\tb', JSON.stringify(t));
  });
  test('datos: tabla: la primera fila son los nombres; números como números, el resto como texto', () => {
    const tb = M.parseTable('mes,valor\nEnero, 40\nFebrero,6.5e1\nMarzo,n/d\n', ',');
    ok(tb.header.join() === 'mes,valor' && tb.rows.length === 3, JSON.stringify(tb));
    ok(tb.rows[0][1] === 40 && tb.rows[1][1] === 65 && tb.rows[2][1] === 'n/d' && tb.rows[0][0] === 'Enero', JSON.stringify(tb.rows));
  });

  const comp = M.newComp({ width: 200, height: 100, fps: 10, duration: 5 });
  const layer = M.newLayer('solid', comp, {}); comp.layers.push(layer);
  const proj = { dataItems: [
    { id: 'd1', name: 'ventas.csv', path: 'x/ventas.csv', kind: 'csv', text: 'mes,valor\nEnero,40\nFebrero,65\nMarzo,90\n' },
    { id: 'd2', name: 'datos.tsv', path: 'datos.tsv', kind: 'tsv', text: 'a\tb\n1\t2\n3\t4\n' },
    { id: 'd3', name: 'conf.json', path: 'conf.json', kind: 'json', text: '{"titulo":"Hola","puntos":[[10,20],[30,40]]}' },
    { id: 'd4', name: 'gps.mgjson', path: 'gps.mgjson', kind: 'mgjson', text: JSON.stringify({ version: 'MGJSON2.0.0', dataOutline: [
      { objectType: 'dataStatic', displayName: 'Equipo', dataType: { type: 'string' }, value: 'Rojo' },
      { objectType: 'dataGroup', displayName: 'Sensores', children: [{ objectType: 'dataDynamic', displayName: 'Velocidad', sampleSetID: 's1', dataType: { type: 'numberString' } }] },
    ], dataDynamicSamples: [{ sampleSetID: 's1', samples: [{ time: '2024-01-01T00:00:00.000Z', value: '10' }, { time: '2024-01-01T00:00:01.000Z', value: '20' }, { time: '2024-01-01T00:00:02.500Z', value: '35' }] }] }) },
  ] };
  const ex = (x, t = 0) => { const p = { v: 0, x }; M.useProjectData(proj); M.exprErrors.clear(); const v = M.valueAt(p, t, { comp, layer, path: 'effects.f.v' }); const err = [...M.exprErrors.values()].join(); return err ? `ERR ${err}` : v; };
  const exs = (x, t = 0) => { const p = { v: 'a', x }; M.useProjectData(proj); M.exprErrors.clear(); const v = M.valueAt(p, t, { comp, layer, path: 'text.text' }); const err = [...M.exprErrors.values()].join(); return err ? `ERR ${err}` : v; };

  test('datos: dataValue([columna, fila]) de CSV / TSV: fila 0 = primera fila de datos; columna por número o nombre', () => {
    ok(ex('footage("ventas.csv").dataValue([1, 0])') === 40, String(ex('footage("ventas.csv").dataValue([1, 0])')));
    ok(ex('footage("ventas.csv").dataValue([1, 2])') === 90, 'fila 2');
    ok(exs('footage("ventas.csv").dataValue([0, 1])') === 'Febrero', 'texto');
    ok(ex('footage("ventas.csv").dataValue(["valor", 1])') === 65, 'por nombre');
    ok(ex('footage("datos.tsv").dataValue([1, 1])') === 4, 'tsv');
    ok(/no existe la fila 7/i.test(String(ex('footage("ventas.csv").dataValue([1, 7])'))), String(ex('footage("ventas.csv").dataValue([1, 7])')));
    ok(/material de archivo «nada.csv»/.test(String(ex('footage("nada.csv").dataValue([0,0])'))), 'sin archivo');
  });
  test('datos: dataKeyCount / dataKeyTimes / dataKeyValues de CSV (una fila por fotograma) y sourceData', () => {
    ok(ex('footage("ventas.csv").dataKeyCount([1])') === 3, 'cuenta');
    ok(ex('footage("ventas.csv").dataKeyValues([1]).reduce((a, b) => a + b, 0)') === 195, 'suma');
    ok(near(ex('footage("ventas.csv").dataKeyTimes([1])[2]'), 0.2), 'tiempos a 10 fps');
    ok(ex('footage("ventas.csv").sourceData[2].valor') === 90, 'sourceData de filas');
    ok(exs('footage("conf.json").sourceData.titulo') === 'Hola' && ex('footage("conf.json").sourceData.puntos[1][0]') === 30, 'json');
    ok(exs('eval("(" + footage("conf.json").sourceText + ")").titulo') === 'Hola', 'sourceText + eval como en After Effects');
    ok(ex('footage("conf.json").dataValue(["puntos", 0, 1])') === 20, 'ruta en JSON');
  });
  test('datos: MGJSON: estático, dinámico al tiempo actual (retiene la muestra), dataKeyTimes relativos', () => {
    ok(exs('footage("gps.mgjson").dataValue([0])') === 'Rojo', 'estático');
    ok(ex('footage("gps.mgjson").dataValue([1, 0])', 0.5) === 10 && ex('footage("gps.mgjson").dataValue([1, 0])', 1.2) === 20 && ex('footage("gps.mgjson").dataValue([1, 0])', 3) === 35, 'dinámico');
    ok(ex('footage("gps.mgjson").dataKeyCount([1, 0])') === 3 && near(ex('footage("gps.mgjson").dataKeyTimes([1, 0])[2]'), 2.5), 'muestras');
    ok(ex('footage("gps.mgjson").dataKeyValues([1, 0], 0.9, 3).length') === 2, 'intervalo');
  });
  test('datos: dataAdd rechaza un JSON no válido con el mensaje de After Effects; volver a cargar cambia el valor', () => {
    const e = new Editor(newProject());
    let msg = '';
    try { M.motionOps.dataAdd(e, [{ path: 'C:/x/mal.json', text: '{ a: 1 ' }]); } catch (err) { msg = err.message; }
    ok(/no es un JSON válido/.test(msg) && !e.project.dataItems?.length, msg);
    const [d] = M.motionOps.dataAdd(e, [{ path: 'C:/x/v.csv', text: 'v\n1\n' }]);
    ok(d.name === 'v.csv' && d.kind === 'csv', JSON.stringify(d));
    M.motionOps.dataReload(e, 'v.csv', 'v\n7\n');
    M.useProjectData(e.project);
    ok(M.footageApi('v.csv', 0, 30).dataValue([0, 0]) === 7, 'recargado');
    e.undo();
    M.useProjectData(e.project);
    ok(M.footageApi('v.csv', 0, 30).dataValue([0, 0]) === 1, 'deshacer');
  });

  // ── scripting ──
  test('scripts: addComp + addSolid + setValueAtTime → composición, capa y claves en el modelo', () => {
    const e = new Editor(newProject());
    const r = runScript(e, 'var c = app.project.items.addComp("S", 320, 240, 1, 3, 25); var l = c.layers.addSolid([0, 1, 0], "Verde", 50, 40, 1);\nvar p = l.property("ADBE Transform Group").property("ADBE Position"); p.setValueAtTime(0, [10, 20]); p.setValueAtTime(1, [100, 20]);\n$.writeln(p.numKeys, p.keyTime(2), l.index, c.numLayers, l instanceof AVLayer, c instanceof CompItem);');
    ok(r.ok && r.output === '2 1 1 1 true true', JSON.stringify(r));
    const c = e.project.comps[0], l = c.layers[0];
    ok(c.name === 'S' && c.width === 320 && c.fps === 25 && c.duration === 3, JSON.stringify(c));
    ok(l.solid.color === '#00ff00' && l.solid.width === 50 && l.transform.position.k.length === 2 && l.transform.position.k[1].v[0] === 100, JSON.stringify(l.transform.position));
    ok(r.changes.compsAdded[0] === 'S' && r.changes.layersAdded.length === 1 && r.changes.keyframes === 2, JSON.stringify(r.changes));
  });
  test('scripts: nombres y nombres internos (match names) en inglés y español; transform y efectos', () => {
    const e = new Editor(newProject());
    const r = runScript(e, `var c = app.project.items.addComp("S", 100, 100, 1, 2, 30); var l = c.layers.addNull();
      l.property("Transform").property("Opacidad").setValue(40);
      l.transform.rotation.setValuesAtTimes([0, 1], [0, 90]);
      l.property("ADBE Transform Group").property("ADBE Scale").setValue([50, 60]);
      var fx = l.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
      fx.property("ADBE Slider Control-0001").setValue(7);
      var b = l.property("Effects").addProperty("ADBE Gaussian Blur 2"); b.property(1).setValue(12); b.property(2).setValue(2);
      l.property("ADBE Effect Parade").addProperty("glow");
      $.writeln(l.property("Effects").numProperties, fx.matchName, b.property(2).value, l.property("Transform").property("Scale").value, l.transform.opacity.propertyValueType == PropertyValueType.OneD);
      try { l.transform.rotation.setValue(3); } catch (e) { $.writeln("ERR " + e.message); }
      try { l.property("Effects").addProperty("ADBE Inexistente"); } catch (e) { $.writeln("ERR2"); }`);
    const l = e.project.comps[0].layers[0];
    ok(l.transform.opacity.v === 40 && l.transform.rotation.k.length === 2 && l.transform.scale.v[0] === 50 && l.transform.scale.v[1] === 60, JSON.stringify(l.transform));
    ok(l.effects.map((f) => f.fx).join() === 'slider,gaussianBlur,glow' && l.effects[0].params.value.v === 7 && l.effects[1].params.amount.v === 12 && l.effects[1].params.dir.v === 'h', JSON.stringify(l.effects.map((f) => f.params)));
    const lines = r.output.split('\n');
    ok(lines[0] === '3 ADBE Slider Control 2 50,60,100 true' && /^ERR .*setValueAtTime/.test(lines[1]) && lines[2] === 'ERR2', r.output);
  });
  test('scripts: capas (texto con TextDocument, forma con grupo/rectángulo/relleno, cámara, luz), primario, puntos de entrada', () => {
    const e = new Editor(newProject());
    const r = runScript(e, `var c = app.project.items.addComp("S", 400, 300, 1, 4, 30);
      var t = c.layers.addText("Hola"); var td = t.property("Source Text").value; td.fontSize = 50; td.fillColor = [1, 0, 0]; td.text = "Adiós"; t.property("Source Text").setValue(td);
      var s = c.layers.addShape(); var g = s.property("Contents").addProperty("ADBE Vector Group");
      var rc = g.property("Contents").addProperty("ADBE Vector Shape - Rect"); rc.property("Size").setValue([80, 40]);
      g.property("Contents").addProperty("ADBE Vector Graphic - Fill").property("Color").setValue([0, 0, 1]);
      g.property("Transform").property("Position").setValue([10, 5]);
      var cam = c.layers.addCamera("Cám", [200, 150]); var li = c.layers.addLight("Luz", [200, 150]); li.lightType = LightType.SPOT;
      var n = c.layers.addNull(); t.parent = n; t.inPoint = 1; t.outPoint = 3; t.name = "Título"; t.enabled = false;
      $.writeln(t instanceof TextLayer, s instanceof ShapeLayer, cam instanceof CameraLayer, li instanceof LightLayer, t.parent.name == n.name, c.layer("Título").index, t.property("Source Text").value.text);`);
    ok(r.ok, JSON.stringify(r.error));
    const c = e.project.comps[0], L = (n) => c.layers.find((x) => x.name === n);
    const t = L('Título');
    ok(t.text.text.v === 'Adiós' && t.text.size.v === 50 && t.text.fill.v === '#ff0000' && t.in === 1 && t.out === 3 && t.hidden && t.parent === c.layers.find((x) => x.type === 'null').id, JSON.stringify({ text: t.text.text, in: t.in, out: t.out, p: t.parent }));
    const sh = c.layers.find((x) => x.type === 'shape').shapes[0];
    ok(sh.kind === 'rect' && sh.size.v.join() === '80,40' && sh.fill.on && sh.fill.color.v === '#0000ff' && !sh.stroke.on && sh.transform.position.v.join() === '10,5', JSON.stringify(sh));
    ok(L('Luz').light.type === 'spot' && L('Cám').camera.poi.v[0] === 200, 'cámara y luz');
    ok(r.output === 'true true true true true 5 Adiós', r.output);
  });
  test('scripts: claves: interpolación, facilidad temporal (KeyframeEase), expresiones; app.project.activeItem', () => {
    const e = new Editor(newProject());
    M.motionOps.compNew(e, { name: 'Activa', width: 100, height: 100, duration: 2 });
    const id = e.project.comps[0].id;
    const r = runScript(e, `var c = app.project.activeItem; var l = c.layers.addSolid([1,1,1], "S", 10, 10, 1);
      var p = l.transform.position; p.setValueAtTime(0, [0, 50]); p.setValueAtTime(1, [100, 50]); p.setValueAtTime(2, [50, 50]);
      p.setInterpolationTypeAtKey(1, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
      var o = l.transform.opacity; o.setValueAtTime(0, 0); o.setValueAtTime(1, 100);
      o.setTemporalEaseAtKey(1, [new KeyframeEase(0, 33.33)], [new KeyframeEase(0, 33.33)]); o.setTemporalEaseAtKey(2, [new KeyframeEase(0, 33.33)]);
      l.transform.rotation.expression = "time * 10";
      $.writeln(c.name, p.keyOutInterpolationType(1) == KeyframeInterpolationType.HOLD, p.keyInInterpolationType(3) == KeyframeInterpolationType.LINEAR, Math.round(o.keyOutTemporalEase(1)[0].influence), l.transform.rotation.valueAtTime(2, false), l.transform.rotation.valueAtTime(2, true), p.nearestKeyIndex(1.2));
      p.removeKey(3); $.writeln(p.numKeys);`, { activeComp: id });
    ok(r.ok && r.output === 'Activa true true 33 20 0 2\n2', r.output + JSON.stringify(r.error));
    const l = e.project.comps[0].layers[0];
    ok(l.transform.position.k[0].i === 'hold' && near(M.keyedAt(l.transform.opacity, 0.5), 50, 0.5) && M.keyedAt(l.transform.opacity, 0.1) < 3, 'interpolación');
  });
  test('scripts: aislado: sin require / process; File solo lee; tiempo límite; errores con línea', () => {
    const e = new Editor(newProject());
    let r = runScript(e, 'var a = typeof require + typeof process + typeof module; var b = this.constructor.constructor("return typeof process")(); var c2 = app.constructor.constructor("return typeof process")(); $.writeln(a, b, c2);');
    ok(r.ok && r.output === 'undefinedundefinedundefined undefined undefined', r.output + JSON.stringify(r.error));
    r = runScript(e, 'var f = new File("C:/Windows/win.ini"); $.writeln(f.exists, f.open("r"), f.open("w"));');
    ok(r.output === 'false false false', r.output);
    r = runScript(e, 'for(;;){}', { timeout: 200 });
    ok(!r.ok && /tiempo máximo/.test(r.error.message), JSON.stringify(r.error));
    r = runScript(e, '\n\nvar x = app.project.item(5);');
    ok(!r.ok && r.error.line === 3 && /fuera del intervalo/.test(r.error.message), JSON.stringify(r.error));
    r = runScript(e, 'alert("uno"); $.write("a"); writeLn("b"); $.writeln({x: 1}, [1, 2]);');
    ok(r.log.map((x) => x.kind).join() === 'alert,write,log,log' && r.log[3].text === '{"x":1} 1,2', JSON.stringify(r.log));
  });
  test('scripts: #include y preprocesador de ExtendScript', () => {
    const src = core.preprocess('#target aftereffects\n#include "b.jsx"\nvar a = 1;', 'C:/s/a.jsx', (p) => (p.replace(/\\/g, '/').endsWith('/s/b.jsx') ? 'var b = 2;\nvar c = 3;' : ''));
    ok(src === '\nvar b = 2; var c = 3;\nvar a = 1;', JSON.stringify(src));
  });
  test('scripts: datos importados + expresión footage() de un CSV leída desde el script', () => {
    const e = new Editor(newProject());
    M.motionOps.dataAdd(e, [{ path: 'C:/x/v.csv', text: 'n,v\na,5\nb,9\n' }]);
    const r = runScript(e, 'var d = app.project.item(1); var c = app.project.items.addComp("C", 100, 100, 1, 2, 30); var l = c.layers.addNull(); l.transform.rotation.expression = \'footage("\' + d.name + \'").dataValue([1, 1])\'; $.writeln(d instanceof FootageItem, d.name, l.transform.rotation.value, app.project.numItems);');
    ok(r.output === 'true v.csv 9 2', r.output + JSON.stringify(r.error));
  });

  test('scripts: los efectos de la ronda final se añaden por su nombre interno de After Effects (leído de cada plug-in)', () => {
    const e = new Editor(newProject());
    const names = { 'CC Particle Systems II': 'ccParticleSystems2', 'CC Mr. Mercury': 'ccMrMercury', 'CC Hair': 'ccHair', 'CC Glue Gun': 'ccGlueGun', 'CC Environment': 'ccEnvironment', 'ADBE Fractal': 'fractal', 'VISINF Grain Duplication': 'matchGrain', 'CC Force Motion Blur': 'ccForceMotionBlur', 'ADBE SubspaceStabilizer': 'warpStabilizer' };
    const r = runScript(e, 'var c = app.project.items.addComp("S", 320, 240, 1, 2, 25); var fx = c.layers.addSolid([1,1,1], "S", 320, 240, 1).property("ADBE Effect Parade");\n' + Object.keys(names).map((n) => `fx.addProperty("${n}");`).join('\n'));
    ok(!r.error, r.error);
    const got = e.project.comps.find((c) => c.name === 'S').layers[0].effects.map((f) => f.fx);
    ok(JSON.stringify(got) === JSON.stringify(Object.values(names)), got.join(', '));
  });
};
