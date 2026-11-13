// Unit tests of the advanced-mode core (pure TypeScript, bundled in dist/core): easing, motion paths,
// expressions, trim paths, text selectors and editing operations with undo.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../dist/core/index.js');
const { motion: M, Editor } = core;

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log(`  ✔ ${name}`); } catch (e) { fail++; console.log(`  ✘ ${name}\n      ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

const comp = M.newComp({ width: 1920, height: 1080, duration: 10 });
const layer = M.newLayer('solid', comp, {});
comp.layers.push(layer);
const env = (path) => ({ comp, layer, path });

console.log('Cinta — pruebas unitarias del modo avanzado');

test('lineal: 0 → 100 en 1 s vale 25 en 0.25 s', () => {
  const p = { v: 0, k: [{ t: 0, v: 0 }, { t: 1, v: 100 }] };
  ok(near(M.keyedAt(p, 0.25), 25), String(M.keyedAt(p, 0.25)));
});
test('Easy Ease: 50 en el centro, lento al principio y simétrico', () => {
  const p = { v: 0, k: [{ t: 0, v: 0 }, { t: 1, v: 100 }] };
  M.easeKeys(p.k, 'easy');
  const v = (t) => M.keyedAt(p, t);
  ok(near(v(0.5), 50, 0.01), `centro ${v(0.5)}`);
  ok(v(0.1) < 10, `inicio ${v(0.1)}`);
  ok(near(v(0.2) + v(0.8), 100, 0.01), 'simétrico');
  // monotonic and smooth: no frame jumps more than 2.5 % at 60 fps
  let prev = 0, maxStep = 0;
  for (let f = 1; f <= 60; f++) { const x = v(f / 60); ok(x >= prev - 1e-9, 'monótono'); maxStep = Math.max(maxStep, x - prev); prev = x; }
  ok(maxStep < 2.7, `paso máximo ${maxStep}`);
});
test('mantener (hold) no interpola', () => {
  const p = { v: 0, k: [{ t: 0, v: 0, i: 'hold' }, { t: 1, v: 100 }] };
  ok(M.keyedAt(p, 0.99) === 0 && M.keyedAt(p, 1) === 100, 'hold');
});
test('bezier con rebasamiento (overshoot) pasa de 100 y vuelve', () => {
  const p = { v: 0, k: [{ t: 0, v: 0, i: 'bezier', eo: [0.3, 1.6] }, { t: 1, v: 100, ei: [0.6, 1] }] };
  let mx = 0;
  for (let f = 0; f <= 100; f++) mx = Math.max(mx, M.keyedAt(p, f / 100));
  ok(mx > 100.5 && near(M.keyedAt(p, 1), 100), `máximo ${mx}`);
});
test('trayectoria espacial curva (auto-bezier) y velocidad uniforme', () => {
  const p = { v: [0, 0, 0], k: [{ t: 0, v: [0, 0, 0] }, { t: 1, v: [500, 500, 0] }, { t: 2, v: [1000, 0, 0] }] };
  const mid = M.keyedAt(p, 0.5, true);
  const lin = M.keyedAt(p, 0.5, false);
  ok(Math.hypot(mid[0] - lin[0], mid[1] - lin[1]) > 20, `curva ${mid} vs ${lin}`);
  // arc-length parametrisation: equal steps in time → near-equal distances
  const d = [];
  for (let f = 0; f < 30; f++) { const a = M.keyedAt(p, f / 30, true), b = M.keyedAt(p, (f + 1) / 30, true); d.push(Math.hypot(b[0] - a[0], b[1] - a[1])); }
  ok(Math.max(...d) / Math.min(...d) < 1.15, `pasos ${Math.min(...d).toFixed(1)}–${Math.max(...d).toFixed(1)}`);
});
test('colores interpolados', () => {
  const p = { v: '#000000', k: [{ t: 0, v: '#000000' }, { t: 1, v: '#ffffff' }] };
  ok(M.keyedAt(p, 0.5).toLowerCase() === '#808080', M.keyedAt(p, 0.5));
});
test('wiggle(2, 30): determinista, acotado y continuo', () => {
  const p = { v: [960, 540, 0], x: 'wiggle(2, 30)' };
  const a = M.valueAt(p, 1.234, env('transform.position')), b = M.valueAt(p, 1.234, env('transform.position'));
  ok(a[0] === b[0] && a[1] === b[1], 'determinista');
  let maxJump = 0, prev = null;
  for (let f = 0; f < 600; f++) {
    const v = M.valueAt(p, f / 60, env('transform.position'));
    ok(Math.abs(v[0] - 960) <= 30.001 && Math.abs(v[1] - 540) <= 30.001, `fuera de rango ${v}`);
    if (prev) maxJump = Math.max(maxJump, Math.abs(v[0] - prev[0]));
    prev = v;
  }
  ok(maxJump < 5, `salto ${maxJump}`);
  const other = M.valueAt(p, 1.234, { comp, layer: { ...layer, id: 'otra' }, path: 'transform.position' });
  ok(other[0] !== a[0], 'semilla distinta por capa');
});
test('loopOut cycle / pingpong / offset y loopIn', () => {
  const k = [{ t: 0, v: 0 }, { t: 1, v: 100 }];
  ok(near(M.valueAt({ v: 0, k, x: "loopOut('cycle')" }, 2.25, env('a')), 25), 'cycle');
  ok(near(M.valueAt({ v: 0, k, x: "loopOut('pingpong')" }, 1.25, env('a')), 75), 'pingpong');
  ok(near(M.valueAt({ v: 0, k: [{ t: 1, v: 0 }, { t: 2, v: 100 }], x: "loopIn('cycle')" }, 0.25, env('a')), 25), 'loopIn');
  ok(near(M.valueAt({ v: 0, k, x: "loopOut('offset')" }, 2.5, env('a')), 250), 'offset');
});
test('expresiones: time, linear, ease, varias líneas, otra capa, efecto y error', () => {
  ok(M.valueAt({ v: 0, x: 'time * 90' }, 2, env('transform.rotation')) === 180, 'time');
  ok(near(M.valueAt({ v: 0, x: 'linear(time, 0, 2, 0, 100)' }, 1, env('a')), 50), 'linear');
  ok(near(M.valueAt({ v: 0, x: 'var a = 3;\nvar b = 4;\nMath.hypot(a, b)' }, 0, env('a')), 5), 'varias líneas');
  const other = M.newLayer('null', comp, { name: 'Control' });
  other.transform.position.v = [100, 200, 0];
  other.effects.push(M.newFx('slider', 10, 10, { value: 42 }));
  comp.layers.push(other);
  const r = M.valueAt({ v: [0, 0], x: 'thisComp.layer("Control").position' }, 0, env('transform.position'));
  ok(r[0] === 100 && r[1] === 200, `otra capa ${r}`);
  ok(M.valueAt({ v: 0, x: 'thisComp.layer("Control").effect("Control de deslizador")("value") * 2' }, 0, env('a')) === 84, 'efecto');
  const bad = M.valueAt({ v: 7, x: 'thisComp.layer("NoExiste").position[0]' }, 0, env('x'));
  ok(bad === 7 && M.exprErrors.get(`${layer.id}|x`), 'error → valor sin expresión');
  ok(Array.isArray(M.valueAt({ v: [1, 2, 3], x: 'add(value, [10, 0, 0])' }, 0, env('p'))), 'add');
  comp.layers.pop();
});
test('inercia: rebota tras la última clave y se asienta', () => {
  const p = { v: 0, k: [{ t: 0, v: 0 }, { t: 0.5, v: 100 }], x: 'inertia(0.05, 3, 6)' };
  const vals = []; for (let f = 31; f < 180; f++) vals.push(M.valueAt(p, f / 60, env('a')));
  ok(Math.max(...vals) > 101, `rebasa ${Math.max(...vals)}`);
  ok(Math.abs(vals[vals.length - 1] - 100) < 0.5, 'se asienta');
});
test('recortar trazados: mitad de un cuadrado = mitad del perímetro', () => {
  const o = { pts: [0, 0, 100, 0, 100, 100, 0, 100], closed: true };
  const r = M.trimOutline(o, 0, 50, 0);
  let len = 0; for (const part of r) for (let i = 2; i < part.pts.length; i += 2) len += Math.hypot(part.pts[i] - part.pts[i - 2], part.pts[i + 1] - part.pts[i - 1]);
  ok(near(len, 200, 0.5), `longitud ${len}`);
  const wrap = M.trimOutline(o, 0, 50, 270);
  ok(wrap.length === 2, 'da la vuelta (dos trozos)');
  ok(M.trimOutline(o, 30, 30, 0).length === 0, 'vacío');
});
test('texto: disposición y selector de rango en cascada', () => {
  const t = M.newLayer('text', comp, {});
  t.text.text.v = 'Hola mundo';
  const lay = M.layoutText('Hola mundo', { size: 100, tracking: 0, leading: 0, align: 'center' }, (s) => s.length * 50);
  ok(lay.glyphs.length === 10 && lay.words === 2 && near(lay.glyphs[0].x, -250), `glifos ${lay.glyphs.length} palabras ${lay.words} x0 ${lay.glyphs[0].x}`);
  const an = { id: 'a1', name: 'A', props: { opacity: { v: 0 } }, selectors: [M.makeSelector({ shape: 'rampUp', start: 0, end: 30 })] };
  an.selectors[0].offset.k = [{ t: 0, v: -30 }, { t: 1, v: 100 }];
  const w0 = M.animatorWeights(comp, t, an, lay, 0), w1 = M.animatorWeights(comp, t, an, lay, 1), wm = M.animatorWeights(comp, t, an, lay, 0.5);
  ok(w0.every((w) => w > 0.99), 'al principio todo afectado');
  ok(w1.every((w) => w < 0.01), 'al final nada');
  ok(wm[0] < wm[9], 'en medio: los primeros ya llegaron');
  const words = M.animatorWeights(comp, t, { ...an, selectors: [M.makeSelector({ shape: 'square', basedOn: 'words', start: 0, end: 50 })] }, lay, 0);
  ok(words[0] === 1 && words[9] === 0, 'por palabras');
  ok(M.offsetChar('a', 3) === 'd' && M.offsetChar('Z', 1) === 'A' && M.offsetChar('9', 1) === '0', 'desplazamiento de caracteres');
});
test('matrices: parenting, escala y rotación', () => {
  const c = M.newComp({});
  const par = M.newLayer('null', c, { name: 'Padre' });
  const ch = M.newLayer('solid', c, { w: 100, h: 100 });
  c.layers.push(ch, par);
  par.transform.position.v = [500, 500, 0];
  par.transform.rotation.v = 90;
  ch.parent = par.id;
  ch.transform.position.v = [100, 0, 0];
  ch.transform.anchor.v = [50, 50, 0];
  const w = M.worldMatrix(c, ch, 0);
  const p = M.apply(w, 50, 50);
  ok(near(p[0], 500, 1e-6) && near(p[1], 600, 1e-6), `anclaje del hijo en ${p}`);
});
test('cámara por defecto: el plano z = 0 se ve al 100 %', () => {
  const c = M.newComp({ width: 1920, height: 1080 });
  const cam = M.cameraAt(c, 0);
  const v = M.apply(cam.view, 100, 200, 0);
  const s = M.project(1920, 1080, cam.zoom, v);
  ok(near(s[0], 100, 0.5) && near(s[1], 200, 0.5), `proyección ${s}`);
});
test('operaciones con deshacer: composición, capas, claves, preajustes, asistentes, precomponer', () => {
  const e = new Editor();
  const c = M.motionOps.compNew(e, { name: 'Intro', duration: 5 });
  const t = M.motionOps.layerAdd(e, c.id, 'text', { text: 'CINTA' });
  M.motionOps.propSet(e, c.id, t.id, 'position', { keys: [{ t: 0, v: [0, 540], ease: 'easy' }, { t: 1, v: [960, 540], ease: 'easy' }] });
  M.motionOps.propSet(e, c.id, t.id, 'opacity', { expression: 'wiggle(4, 20)' });
  M.presetApply(e, c.id, 'fadeUpChars', [t.id], {});
  M.presetApply(e, c.id, 'bgParticles', [], {});
  const fx = M.motionOps.effectAdd(e, c.id, t.id, 'glow', { radius: 40 });
  M.motionOps.propSet(e, c.id, t.id, `effects.${fx.name}.intensity`, { keys: [{ t: 0, v: 0 }, { t: 2, v: 3 }] });
  const sh = M.motionOps.shapeAdd(e, c.id, undefined, { kind: 'star', width: 300, color: '#ffd400', trim: { end: 50 }, repeater: { copies: 4, rotation: 90 } });
  M.motionOps.keyframeAssist(e, c.id, { kind: 'bake', layers: [t.id], path: 'opacity', from: 0, to: 1 });
  const cc = e.project.comps[0];
  const tl = cc.layers.find((l) => l.id === t.id);
  ok(tl.transform.opacity.k.length === 31 && !tl.transform.opacity.x, `bake ${tl.transform.opacity.k?.length}`);
  ok(cc.layers.length === 3 && tl.text.animators.length === 1 && cc.layers.some((l) => l.effects.some((f) => f.fx === 'particles')), 'capas');
  const pre = M.motionOps.layerPrecompose(e, c.id, [t.id, sh.layer.id], 'Logo');
  ok(e.project.comps.length === 2 && e.project.comps[0].layers.length === 2, 'precomponer');
  ok(M.dependsOn(e.project, c.id, pre.comp.id) && !M.dependsOn(e.project, pre.comp.id, c.id), 'dependencias');
  let threw = false; try { M.motionOps.layerAdd(e, pre.comp.id, 'comp', { compId: c.id }); } catch { threw = true; }
  ok(threw, 'no permite composición circular');
  e.undo();
  ok(e.project.comps.length === 1, 'deshacer precomponer');
  const s = M.compSummary(e.project, e.project.comps[0]);
  ok(s.layers.find((l) => l.id === t.id).animated['transform.position'] === '2 claves', JSON.stringify(s.layers[0].animated));
  let bad = false; try { M.motionOps.propSet(e, c.id, t.id, 'noexiste', { value: 1 }); } catch (er) { bad = /Propiedad desconocida/.test(er.message); }
  ok(bad, 'error claro en propiedad desconocida');
  let keyed = false; try { M.motionOps.propSet(e, c.id, t.id, 'position', { value: [1, 2] }); } catch (er) { keyed = /tiene fotogramas clave/.test(er.message); }
  ok(keyed, 'pide t si hay claves');
});
test('ondular trazados y zigzag: deforman el contorno, cerrado sin salto, estable con velocidad 0', () => {
  const circle = { pts: [], closed: true };
  for (let i = 0; i < 64; i++) { const a = (i / 64) * Math.PI * 2; circle.pts.push(Math.cos(a) * 100, Math.sin(a) * 100); }
  const rs = M.resampleOutline(circle, 40);
  ok(rs.length === 80, `remuestreo ${rs.length}`);
  for (let i = 0; i < 80; i += 2) ok(near(Math.hypot(rs[i], rs[i + 1]), 100, 0.6), 'remuestreo sobre el círculo');
  const w = M.wiggleOutline(circle, 20, 8, 0.3, 5, true);
  let maxd = 0, mind = 1e9;
  for (let i = 0; i < w.pts.length; i += 2) { const r = Math.hypot(w.pts[i], w.pts[i + 1]); maxd = Math.max(maxd, r); mind = Math.min(mind, r); }
  ok(maxd > 104 && mind < 96 && maxd < 130 && mind > 70, `radio ${mind.toFixed(1)}…${maxd.toFixed(1)}`);
  // the seam of a closed outline: last and first points stay close (noise on a circle)
  const n = w.pts.length;
  ok(Math.hypot(w.pts[0] - w.pts[n - 2], w.pts[1] - w.pts[n - 1]) < 25, 'sin salto en la costura');
  const sharp = M.wiggleOutline(circle, 15, 11, 0, 1, false);
  ok(sharp.pts.length === 22, `esquinas: un vértice por detalle (${sharp.pts.length / 2})`);
  ok(JSON.stringify(M.wiggleOutline(circle, 15, 11, 0, 1, false)) === JSON.stringify(sharp), 'determinista');
  ok(JSON.stringify(M.wiggleOutline(circle, 15, 11, 0.5, 1, false)) !== JSON.stringify(sharp), 'evoluciona con el tiempo');
  const z = M.zigzagOutline(circle, 10, 12, false);
  ok(z.pts.length === 48, `zigzag: 2 vértices por cresta (${z.pts.length / 2})`);
  const r0 = Math.hypot(z.pts[0], z.pts[1]), r1 = Math.hypot(z.pts[2], z.pts[3]);
  ok(Math.abs(Math.abs(r0 - r1) - 20) < 1.5, `crestas alternas ±10 (${r0.toFixed(1)} / ${r1.toFixed(1)})`);
  for (let i = 0; i < 200; i++) { const v = M.noise3(i * 0.37, i * 0.11, i * 0.07, 3); ok(v >= -1 && v <= 1, `noise3 fuera de rango ${v}`); }
});
test('shape_add apila encima, modificadores con deshacer y efectos por id de catálogo', () => {
  const e = new Editor();
  const c = M.motionOps.compNew(e, { name: 'Formas' });
  const a = M.motionOps.shapeAdd(e, c.id, undefined, { kind: 'ellipse', width: 200, name: 'Base' });
  M.motionOps.shapeAdd(e, c.id, a.layer.id, { kind: 'ellipse', width: 50, name: 'Brillo', wiggle: { size: 6, detail: 5 }, zigzag: { ridges: 9 } });
  let l = e.project.comps[0].layers[0];
  ok(l.shapes[0].name === 'Brillo' && l.shapes[1].name === 'Base', 'la nueva forma va arriba');
  ok(l.shapes[0].wiggle.size.v === 6 && l.shapes[0].wiggle.smooth === true && l.shapes[0].zigzag.ridges.v === 9, 'modificadores');
  M.motionOps.propSet(e, c.id, l.id, 'shapes.Brillo.wiggle.size', { keys: [{ t: 0, v: 0 }, { t: 1, v: 30 }] });
  l = e.project.comps[0].layers[0];
  const o0 = M.shapeOutline(e.project.comps[0], l, l.shapes[0], 0), o1 = M.shapeOutline(e.project.comps[0], l, l.shapes[0], 1);
  ok(JSON.stringify(o0) !== JSON.stringify(o1), 'tamaño animable');
  M.motionOps.shapeSet(e, c.id, l.id, 'Brillo', { wiggle: null, zigzag: null });
  l = e.project.comps[0].layers[0];
  ok(!l.shapes[0].wiggle && !l.shapes[0].zigzag, 'null los quita');
  e.undo();
  ok(e.project.comps[0].layers[0].shapes[0].wiggle, 'deshacer los recupera');
  const paths = []; M.forEachProp(e.project.comps[0].layers[0], (_p, path) => paths.push(path));
  ok(paths.some((p) => p.endsWith('.wiggle.size')) && paths.some((p) => p.endsWith('.zigzag.ridges')), 'forEachProp los recorre');
  M.motionOps.effectAdd(e, c.id, l.id, 'glow');
  M.motionOps.effectAdd(e, c.id, l.id, 'glow');
  M.motionOps.propSet(e, c.id, l.id, 'effects.glow.radius', { value: 77 });
  const fxs = e.project.comps[0].layers[0].effects;
  ok(fxs[0].params.radius.v === 77 && fxs[1].params.radius.v !== 77, 'effects.<id de catálogo> = el primero de ese tipo');
});
test('preajuste squashBounce: cae al suelo, se aplasta sin hundirse y repite en bucle', () => {
  const e = new Editor();
  const c = M.motionOps.compNew(e, { name: 'Bote', width: 1000, height: 1000 });
  const s = M.motionOps.shapeAdd(e, c.id, undefined, { kind: 'ellipse', width: 200, name: 'Bola' });
  M.motionOps.propSet(e, c.id, s.layer.id, 'position', { value: [500, 800] });
  M.presetApply(e, c.id, 'squashBounce', [s.layer.id], { at: 0, duration: 1, amount: 500 });
  const cc = e.project.comps[0], l = cc.layers[0];
  const y = (t) => M.valueAt(l.transform.position, t, { comp: cc, layer: l, path: 'transform.position' })[1];
  const sc = (t) => M.valueAt(l.transform.scale, t, { comp: cc, layer: l, path: 'transform.scale' });
  ok(near(y(0), 300, 0.5) && near(y(0.47), 800, 0.5), `arriba ${y(0)} / suelo ${y(0.47)}`);
  ok(y(0.2) - y(0) < y(0.45) - y(0.25), 'acelera al caer');
  const sq = sc(0.5);
  ok(sq[0] > 120 && sq[1] < 80, `aplastada ${sq}`);
  ok(near(y(0.5) + (100 * sq[1]) / 100, 900, 2), `la base sigue en el suelo (${y(0.5)} + ${sq[1]})`);
  ok(near(y(1.47), 800, 1) && near(y(2.2), y(0.2), 1), 'repite (loopOut)');
});
test('expresiones: valueAtTime en vectores de otra capa (estelas y retardos)', () => {
  const e = new Editor();
  const c = M.motionOps.compNew(e, { name: 'Exp' });
  const a = M.motionOps.layerAdd(e, c.id, 'null', { name: 'Guía' });
  M.motionOps.propSet(e, c.id, a.id, 'position', { keys: [{ t: 0, v: [0, 0] }, { t: 1, v: [100, 200] }] });
  const b = M.motionOps.layerAdd(e, c.id, 'null', { name: 'Sigue' });
  M.motionOps.propSet(e, c.id, b.id, 'position', { expression: "thisComp.layer('Guía').transform.position.valueAtTime(time - 0.5)" });
  const cc = e.project.comps[0], lb = cc.layers.find((l) => l.id === b.id);
  const v = M.valueAt(lb.transform.position, 0.75, { comp: cc, layer: lb, path: 'transform.position' });
  ok(near(v[0], 25, 0.01) && near(v[1], 50, 0.01), `valor 0.5 s antes (${v})`);
  M.motionOps.propSet(e, c.id, b.id, 'position', { expression: "add(thisComp.layer('Guía').position, [1, 1])" });
  const w = M.valueAt(cc.layers.find((l) => l.id === b.id).transform.position, 1, { comp: e.project.comps[0], layer: e.project.comps[0].layers.find((l) => l.id === b.id), path: 'transform.position' });
  ok(near(w[0], 101) && near(w[1], 201), `sigue funcionando la aritmética (${w})`);
  ok(JSON.stringify(e.project).indexOf('valueAtTime"') < 0, 'no ensucia el modelo');
});
test('trazados: convertir en trazado y transformar entre claves con distinto nº de vértices', () => {
  const e = new Editor();
  const c = M.motionOps.compNew(e, { name: 'Morph' });
  const s = M.motionOps.shapeAdd(e, c.id, undefined, { kind: 'ellipse', width: 200, name: 'Bola' });
  M.motionOps.shapeSet(e, c.id, s.layer.id, 'Bola', { toPath: true });
  let l = e.project.comps[0].layers[0], sh = l.shapes[0];
  ok(sh.kind === 'path' && sh.closed && sh.path.v.length % 6 === 0 && sh.path.v.length / 6 >= 24, `trazado de ${sh.path.v.length / 6} vértices`);
  const o = M.shapeOutline(e.project.comps[0], l, sh, 0);
  for (let i = 0; i < o.pts.length; i += 2) ok(near(Math.hypot(o.pts[i], o.pts[i + 1]), 100, 3), 'sigue siendo el círculo');
  const square = [-50, -50, 50, -50, 50, 50, -50, 50];
  const star = []; for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2, r = i % 2 ? 40 : 120; star.push(Math.cos(a) * r, Math.sin(a) * r); }
  M.motionOps.propSet(e, c.id, l.id, 'shapes.Bola.path', { pathPoints: true, keys: [{ t: 0, v: square }, { t: 1, v: star }] });
  l = e.project.comps[0].layers[0]; sh = l.shapes[0];
  ok(sh.path.k[0].v.length === 24 && sh.path.k[1].v.length === 60, 'claves con 4 y 10 vértices');
  const cc = e.project.comps[0];
  const a0 = M.shapeOutline(cc, l, sh, 0), a1 = M.shapeOutline(cc, l, sh, 1), am = M.shapeOutline(cc, l, sh, 0.5);
  ok(a0.pts.length === 10 && a1.pts.length === 22, `en las claves, la forma exacta (${a0.pts.length / 2 - 1} y ${a1.pts.length / 2 - 1} vértices)`);
  ok(am.pts.length === 256, `a mitad, contorno transformado (${am.pts.length / 2} puntos)`);
  let rmax = 0; for (let i = 0; i < am.pts.length; i += 2) rmax = Math.max(rmax, Math.hypot(am.pts[i], am.pts[i + 1]));
  ok(rmax > 72 && rmax < 118, `a mitad de camino entre el cuadrado y la estrella (radio máx ${rmax.toFixed(1)})`);
  let bad = false; try { M.motionOps.propSet(e, c.id, l.id, 'shapes.Bola.path', { keys: [{ t: 0, v: square }] }); } catch (er) { bad = /path_points/.test(er.message); }
  ok(bad, 'sin path_points pide vértices bezier y lo explica');
});
test('operadores de trazado: desplazar, redondear, contraer y torcer', () => {
  const sq = { pts: [-50, -50, 50, -50, 50, 50, -50, 50], closed: true };
  const span = (o) => { let a = Infinity, b = -Infinity; for (let i = 0; i < o.pts.length; i += 2) { a = Math.min(a, o.pts[i]); b = Math.max(b, o.pts[i]); } return b - a; };
  for (const order of [sq, { pts: [-50, -50, -50, 50, 50, 50, 50, -50], closed: true }]) {
    ok(near(span(M.offsetOutline(order, 10, 'miter')), 120, 0.01), `+10 en inglete crece a 120 px en los dos sentidos de giro (${span(M.offsetOutline(order, 10, 'miter'))})`);
    ok(near(span(M.offsetOutline(order, -10, 'miter')), 80, 0.01), 'con −10 encoge a 80 px');
  }
  const r = M.offsetOutline(sq, 10, 'round');
  let farthest = 0; for (let i = 0; i < r.pts.length; i += 2) farthest = Math.max(farthest, Math.hypot(r.pts[i], r.pts[i + 1]));
  ok(near(farthest, Math.hypot(50, 50) + 10, 0.5), `esquina redonda a 10 px del vértice (${farthest.toFixed(2)})`);
  const rc = M.roundCornersOutline(sq, 20);
  let corner = Infinity; for (let i = 0; i < rc.pts.length; i += 2) corner = Math.min(corner, Math.hypot(rc.pts[i] - 50, rc.pts[i + 1] - 50));
  ok(corner > 5 && rc.pts.length > sq.pts.length, `la esquina se aparta del vértice (${corner.toFixed(1)} px)`);
  const flat = []; for (let i = 0; i < 4; i++) flat.push(sq.pts[i * 2], sq.pts[i * 2 + 1], 0, 0, 0, 0);
  const bloat = M.puckerOutline(flat, true, 100), pucker = M.puckerOutline(flat, true, -100);
  ok(near(Math.hypot(bloat.pts[0], bloat.pts[1]), 0, 0.01), 'engordar 100: los vértices van al centro');
  ok(near(Math.hypot(pucker.pts[0], pucker.pts[1]), Math.hypot(100, 100), 0.01), 'contraer 100: los vértices se alejan el doble');
  const tw = M.twistOutline(sq, 90, [0, 0]);
  ok(tw.pts.length >= 480, 'torcer remuestrea el contorno');
  let maxR = 0; for (let i = 0; i < tw.pts.length; i += 2) maxR = Math.max(maxR, Math.hypot(tw.pts[i], tw.pts[i + 1]));
  ok(near(maxR, Math.hypot(50, 50), 0.5), 'torcer conserva las distancias al centro');
});
test('marioneta: MLS rígido y distancias a lo largo de la malla', () => {
  const [x1, y1] = M.mlsRigid(10, 0, [0, 0], [5, 7]);
  ok(near(x1, 15) && near(y1, 7), 'un pin: traslada');
  // two pins turned 90° about the origin: a point between them turns too, keeping its distance
  const [x2, y2] = M.mlsRigid(50, 0, [0, 0, 100, 0], [0, 0, 0, 100]);
  ok(near(x2, 0, 1e-6) && near(y2, 50, 1e-6), `dos pines girados 90°: el punto gira (${x2.toFixed(3)}, ${y2.toFixed(3)})`);
  const [x3, y3] = M.mlsRigid(100, 0, [0, 0, 100, 0], [3, 4, 103, 4]);
  ok(near(x3, 103) && near(y3, 4), 'sobre un pin: va con él');
  // U-shaped alpha: two prongs joined at the bottom; along the mesh the prong tips are far apart
  const w = 60, h = 60, a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 15 || x >= 45 || y >= 45) a[y * w + x] = 255;
  const mesh = M.puppetMesh(a, w, h, 0, 0, 1, 5, 0, 1, 0);
  ok(mesh.tris.length > 0 && mesh.tris.length % 3 === 0, `malla de ${mesh.tris.length / 3} triángulos`);
  const [d] = M.meshDistances(mesh, [5, 0]);
  let tip = -1; for (let v = 0; v < mesh.rest.length / 2; v++) if (near(mesh.rest[v * 2], 55, 0.01) && near(mesh.rest[v * 2 + 1], 0, 0.01)) tip = v;
  ok(tip >= 0 && d[tip] > 100, `de punta a punta por la malla ${d[tip]?.toFixed(1)} px (en línea recta 50)`);
  let hole = false; for (let i = 0; i < mesh.tris.length; i += 3) { const cx = (mesh.rest[mesh.tris[i] * 2] + mesh.rest[mesh.tris[i + 1] * 2] + mesh.rest[mesh.tris[i + 2] * 2]) / 3, cy = (mesh.rest[mesh.tris[i] * 2 + 1] + mesh.rest[mesh.tris[i + 1] * 2 + 1] + mesh.rest[mesh.tris[i + 2] * 2 + 1]) / 3; if (cx > 22 && cx < 38 && cy < 38) hole = true; }
  ok(!hole, 'la malla no cubre el hueco de la U');
});
test('rastreador: sigue un punto con precisión de subpíxel', () => {
  // a textured image moved by (3.5, −2.25) px per frame
  const w = 160, h = 120, tex = (x, y) => 128 + 60 * Math.sin(x * 0.37) * Math.cos(y * 0.29) + 40 * Math.sin((x + 2 * y) * 0.11);
  const frames = [];
  for (let f = 0; f < 6; f++) { const d = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = tex(x - 3.5 * f, y + 2.25 * f); frames.push(d); }
  const [t] = core.trackFrames(frames, w, h, [[60, 70]], 10, 12);
  const [x5, y5] = t.pts[5];
  ok(near(x5, 60 + 17.5, 0.35) && near(y5, 70 - 11.25, 0.35), `5 fotogramas después en (${x5.toFixed(2)}, ${y5.toFixed(2)}) ≈ (77.5, 58.75)`);
  ok(Math.min(...t.conf) > 0.9, `coincidencia alta (${Math.min(...t.conf).toFixed(3)})`);
});
test('fidelidad con After Effects: valores por defecto y opciones', () => {
  const def = (fx, p) => M.FX.find((f) => f.id === fx).params.find((q) => q.id === p);
  ok(def('glow', 'radius').def === 10 && def('glow', 'intensity').def === 1 && def('glow', 'threshold').def === 60, 'Resplandor: radio 10, intensidad 1, umbral 60 %');
  ok(def('dropShadow', 'distance').def === 5 && def('dropShadow', 'softness').def === 0 && def('dropShadow', 'direction').def === 135 && def('dropShadow', 'opacity').def === 50, 'Sombra paralela: distancia 5, suavidad 0, dirección 135°, opacidad 50 %');
  ok(def('dropShadow', 'distance').max === 4000 && def('dropShadow', 'softness').max === 30000, 'Sombra paralela: máximos 4000 / 30000');
  ok(def('gradientWipe', 'completion').def === 0 && def('gradientWipe', 'softness').def === 0 && def('gradientWipe', 'fit').def === 'stretch', 'Barrido de degradado: 0 %, 0 %, ajustar');
  const sm = def('setMatte', 'channel');
  ok(sm.choices.length === 10 && sm.def === 'alpha' && def('setMatte', 'composite').def === 1 && def('setMatte', 'premultiply').def === 1, 'Establecer mate: 10 opciones (alfa), componer y premultiplicar activados');
  ok(def('compoundBlur', 'max').def === 20, 'Desenfoque compuesto: máximo 20');
  ok(def('changeColor', 'tolerance').def === 15 && def('changeColor', 'softness').def === 0 && def('changeColor', 'match').def === 'rgb', 'Cambiar color: tolerancia 15 %, suavidad 0, usando RGB');
  ok(def('channelMixer', 'rr').def === 100 && def('channelMixer', 'rg').def === 0 && def('channelMixer', 'rr').min === -200, 'Mezclador de canales: diagonal 100, ±200');
  ok(def('glow', 'composite').def === 'behind' && def('glow', 'operation').def === 'add' && def('glow', 'mode').def === 'original' && def('glow', 'looping').def === 'triangleAB' && def('glow', 'loops').def === 1 && def('glow', 'midpoint').def === 50 && def('glow', 'basedOn').def === 'color', 'Resplandor: detrás, añadir, colores originales, triángulo A>B>A, 1 bucle, punto medio 50 %, basado en color');
});
test('catálogos: efectos y preajustes con nombres y parámetros únicos', () => {
  const ids = new Set();
  for (const f of M.FX) { ok(!ids.has(f.id), `efecto repetido ${f.id}`); ids.add(f.id); const ps = new Set(f.params.map((p) => p.id)); ok(ps.size === f.params.length, `parámetros repetidos en ${f.id}`); }
  const pids = new Set(M.PRESETS.map((p) => p.id));
  ok(pids.size === M.PRESETS.length, 'preajustes repetidos');
  ok(M.FX.length >= 50 && M.PRESETS.length >= 45, `${M.FX.length} efectos, ${M.PRESETS.length} preajustes`);
});

test('interpolación inteligente de máscaras: valores de SmartMask, densificar, extremos exactos y giro sin encoger', () => {
  const D = M.SMART_MASK_DEFAULTS;
  ok(D.linear === true && D.bending === 50 && D.quality === 50 && D.addVertices.mode === 'pixels' && D.addVertices.value === 9 && D.matching === 'auto' && !D.oneToOne && D.firstMatch && !D.fields && D.rate === null, 'valores por defecto del asistente');
  ok(M.SPACING.total.def === 100 && M.SPACING.total.max === 2500 && M.SPACING.percent.def === 1 && M.SPACING.percent.min === 0.04, 'rangos del espaciado');
  const star = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 35 : 85; star.push(100 + r * Math.cos(a), 100 + r * Math.sin(a), 0, 0, 0, 0); }
  const k = 0.5523 * 60, circ = [100, 40, -k, 0, k, 0, 160, 100, 0, -k, 0, k, 100, 160, k, 0, -k, 0, 40, 100, 0, k, 0, -k];
  // options left undefined take the defaults (the MCP passes every option, set or not)
  const r = M.smartMaskPair(star, circ, true, { linear: undefined, addVertices: undefined, quality: undefined });
  ok(r.a.length / 6 >= 60 && r.a.length === r.b.length, `vértices añadidos cada 9 px: ${r.a.length / 6}`);
  const same = (x, y) => x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-6);
  ok(same(r.at(0), r.a) && same(r.at(1), r.b), 'u = 0 y u = 1 son las claves');
  // the densified keys keep the shape: the star tips are still there
  const rad = (f) => { const o = []; for (let i = 0; i < f.length; i += 6) o.push(Math.hypot(f[i] - 100, f[i + 1] - 100)); return o; };
  ok(Math.abs(Math.max(...rad(r.a)) - 85) < 1e-6, 'las puntas de la estrella siguen en la clave densificada');
  // a square turned 45°: curved vertex paths keep its size halfway, straight ones shrink it
  const poly = (p) => p.flatMap(([x, y]) => [x, y, 0, 0, 0, 0]);
  const sq = poly([[0, 0], [100, 0], [100, 100], [0, 100]]), turned = poly([[50, -20.7107], [120.7107, 50], [50, 120.7107], [-20.7107, 50]]);
  const edge = (f) => Math.hypot(f[6] - f[0], f[7] - f[1]);
  const lin = M.smartMaskPair(sq, turned, true, { linear: true, addVertices: false, quality: 0 }).at(0.5), cur = M.smartMaskPair(sq, turned, true, { linear: false, addVertices: false, quality: 0 }).at(0.5);
  ok(edge(cur) > 99.9 && edge(lin) < 93, `giro: curvo ${edge(cur).toFixed(2)}, lineal ${edge(lin).toFixed(2)} (lado 100)`);
});

// tests per line of work (scripts/unit/*.mjs): export default ({ test, ok, near, M, core }) => { test(…) }
{
  const { readdirSync } = await import('node:fs');
  const dir = new URL('./unit/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort()) (await import(new URL(f, dir))).default({ test, ok, near, M, core });
}

console.log(`\n${pass} correctas, ${fail} fallidas`);
process.exit(fail ? 1 : 0);
