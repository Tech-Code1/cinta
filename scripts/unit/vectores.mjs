// Unit tests of «vectores»: auto-trace (marching squares, simplification, bezier fit on synthetic images), the
// OpenType reader (glyph outline counts, variable-font axes) and the operations (shapes / masks from text,
// auto-trace masks, font axes) with undo.
import { readFileSync, existsSync } from 'node:fs';

export default ({ test, ok, near, M, core }) => {
  /** RGBA image with alpha from an inside(x, y) test, 4×4 supersampled (antialiased edges) */
  const img = (w, h, inside) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let n = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) n++;
      const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round((n / 16) * 255);
    }
    return d;
  };
  /** area of a flat bezier (vertices + the curves sampled) */
  const bezArea = (p) => {
    const n = p.length / 6, pts = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = [p[i * 6], p[i * 6 + 1]], b = [p[j * 6], p[j * 6 + 1]];
      const c1 = [a[0] + p[i * 6 + 4], a[1] + p[i * 6 + 5]], c2 = [b[0] + p[j * 6 + 2], b[1] + p[j * 6 + 3]];
      for (let k = 0; k < 16; k++) { const t = k / 16, s = 1 - t; pts.push(s * s * s * a[0] + 3 * s * s * t * c1[0] + 3 * s * t * t * c2[0] + t * t * t * b[0], s * s * s * a[1] + 3 * s * s * t * c1[1] + 3 * s * t * t * c2[1] + t * t * t * b[1]); }
    }
    return Math.abs(M.polyArea(pts));
  };
  const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

  test('calco: marching squares de un círculo da su área (πr²) y un solo contorno cerrado', () => {
    const d = img(100, 100, circle(50, 50, 30));
    const f = M.channelField(d, 100, 100, 'alpha', false);
    const polys = M.marchingSquares(f, 100, 100, 0.5);
    ok(polys.length === 1, `contornos ${polys.length}`);
    const a = Math.abs(M.polyArea(polys[0]));
    ok(Math.abs(a - Math.PI * 900) / (Math.PI * 900) < 0.01, `área ${a} vs ${Math.PI * 900}`);
  });
  test('calco: un anillo da contorno exterior y agujero (profundidad 1, resta); el área mínima quita motas', () => {
    const d = img(120, 120, (x, y) => { const r = Math.hypot(x - 50, y - 50); return (r <= 40 && r >= 20) || Math.hypot(x - 110, y - 110) < 1.5; });
    const all = M.autoTraceImage(d, 120, 120, { minArea: 0, blur: 0 });
    ok(all.length === 3, `con motas: ${all.length}`);
    const t = M.autoTraceImage(d, 120, 120, { blur: 0 });
    ok(t.length === 2 && t[0].depth === 0 && !t[0].hole && t[1].depth === 1 && t[1].hole, JSON.stringify(t.map((x) => [x.depth, x.hole, Math.round(x.area)])));
    ok(Math.abs(t[0].area - Math.PI * 1600) < 40 && Math.abs(t[1].area - Math.PI * 400) < 25, `áreas ${t[0].area} ${t[1].area}`);
  });
  test('calco: invertir, canal de luminancia y umbral', () => {
    const w = 40, h = 40, d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, v = x < 20 ? 255 : 64; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    const lum = M.autoTraceImage(d, w, h, { channel: 'luminance', blur: 0 });
    ok(lum.length === 1 && near(lum[0].area, 20 * 40, 25), `luminancia ${lum.map((x) => x.area)}`);
    const low = M.autoTraceImage(d, w, h, { channel: 'luminance', blur: 0, threshold: 20 });
    ok(low.length === 1 && low[0].area > 40 * 40 - 50, `umbral 20 % lo toma todo: ${low[0]?.area}`);
    const inv = M.autoTraceImage(d, w, h, { channel: 'luminance', blur: 0, invert: true });
    ok(inv.length === 1 && near(inv[0].area, 20 * 40, 25) && inv[0].path.every((v, i) => i % 6 !== 0 || v >= 19), 'invertido: la mitad derecha');
  });
  test('calco: simplificación — un cuadrado queda en 4 vértices rectos (redondez 0) y tolerancia', () => {
    const d = img(60, 60, (x, y) => x >= 10 && x <= 50 && y >= 10 && y <= 50);
    const [t] = M.autoTraceImage(d, 60, 60, { cornerRoundness: 0, blur: 0 });
    ok(t.path.length / 6 === 4 && t.path.every((v, i) => i % 6 < 2 || v === 0), `vértices ${t.path.length / 6}`);
    ok(near(bezArea(t.path), 1600, 50), `área ${bezArea(t.path)}`);
    // the default roundness keeps a square's corners (sharper than the limit)
    const [r] = M.autoTraceImage(d, 60, 60, { blur: 0 });
    ok(r.path.length / 6 <= 8 && near(bezArea(r.path), 1600, 50), `redondez 50: ${r.path.length / 6} vértices, área ${bezArea(r.path)}`);
  });
  test('calco: ajuste bezier — un círculo con pocos vértices curvos dentro de la tolerancia', () => {
    const d = img(140, 140, circle(70, 70, 50));
    const [t] = M.autoTraceImage(d, 140, 140, { blur: 0, tolerance: 1 });
    const n = t.path.length / 6;
    ok(n >= 3 && n <= 16, `vértices ${n}`);
    ok(t.path.some((v, i) => i % 6 >= 2 && Math.abs(v) > 1), 'tangentes curvas');
    ok(Math.abs(bezArea(t.path) - Math.PI * 2500) / (Math.PI * 2500) < 0.01, `área ${bezArea(t.path)}`);
    for (let i = 0; i < n; i++) ok(Math.abs(Math.hypot(t.path[i * 6] - 70, t.path[i * 6 + 1] - 70) - 50) < 1.2, `vértice ${i} fuera del círculo`);
    // a stricter tolerance needs more vertices; blur keeps the area
    const [s] = M.autoTraceImage(d, 140, 140, { blur: 0, tolerance: 0.2 });
    ok(s.path.length / 6 >= n, `tolerancia 0,2: ${s.path.length / 6}`);
    const [b] = M.autoTraceImage(d, 140, 140, { blur: 2 });
    ok(Math.abs(bezArea(b.path) - Math.PI * 2500) / (Math.PI * 2500) < 0.02, `con desenfoque ${bezArea(b.path)}`);
  });

  const font = (f) => { const p = `C:/Windows/Fonts/${f}`; return existsSync(p) ? new M.OTFont(new Uint8Array(readFileSync(p))) : null; };
  const contours = (F, ch, axes) => F.path(F.glyphId(ch), axes).filter((c) => c[0] === 'M').length;
  test('fuentes: contornos de glifos TrueType (Arial) y CFF (.otf): O 2, B 3, i 2, 8 3, é 3', () => {
    const A = font('arial.ttf');
    if (!A) return;
    ok(A.info.family === 'Arial' && A.unitsPerEm === 2048, A.info.family);
    for (const [ch, n] of [['O', 2], ['B', 3], ['i', 2], ['8', 3], ['é', 3], ['H', 1]]) ok(contours(A, ch) === n, `${ch}: ${contours(A, ch)}`);
    const cs = M.pathToContours(A.path(A.glyphId('O')), 100 / 2048, 0, 0);
    ok(cs.length === 2 && cs.every((c) => c.length % 6 === 0), 'contornos planos');
    // y down: the O sits above the baseline (negative y), about the cap height of 100 px text
    const ys = cs[0].filter((_, i) => i % 6 === 1);
    ok(Math.max(...ys) > -2 && Math.min(...ys) < -70, `alto ${Math.min(...ys)}…${Math.max(...ys)}`);
    const otf = ['DavidCLM-Bold.otf', 'MiriamLibre-Regular.otf'].map(font).find(Boolean);
    if (otf) ok(contours(otf, 'O') === 2 && contours(otf, 'B') >= 2, `CFF O ${contours(otf, 'O')} B ${contours(otf, 'B')}`);
  });
  test('fuentes: fuente variable (Bahnschrift) — ejes, instancias, wdth estrecha los glifos y avar', () => {
    const B = font('bahnschrift.ttf');
    if (!B) return;
    ok(B.axes.map((a) => a.tag).join() === 'wght,wdth' && B.instances.length >= 10, B.axes.map((a) => a.tag).join());
    const g = B.glyphId('H');
    ok(B.advance(g, { wdth: 75 }) < B.advance(g) * 0.7, `avance ${B.advance(g, { wdth: 75 })} vs ${B.advance(g)}`);
    const xs = (axes) => B.path(g, axes).flatMap((c) => c.slice(1).filter((_, i) => i % 2 === 0));
    ok(Math.max(...xs({ wdth: 75 })) < Math.max(...xs()) * 0.7, 'contorno estrecho');
    // weight: the stems thicken (the outline changes), avar maps 600 to 0.5
    ok(JSON.stringify(B.path(B.glyphId('l'), { wght: 700 })) !== JSON.stringify(B.path(B.glyphId('l'))), 'grosor cambia el contorno');
    ok(near(B.normalize({ wght: 600 })[0], 0.5, 0.01) && B.normalize({ wght: 300 })[0] === -1, `normalizado ${B.normalize({ wght: 600 })}`);
  });

  test('operaciones: crear formas / máscaras a partir del texto, con deshacer', () => {
    const e = new core.Editor();
    const c = M.motionOps.compNew(e, { width: 400, height: 200 });
    const t = M.motionOps.layerAdd(e, c.id, 'text', { text: 'Ho' });
    M.motionOps.propSet(e, c.id, t.id, 'position', { keys: [{ t: 0, v: [100, 100] }, { t: 1, v: [300, 100] }] });
    const sq = (x, y, s) => [x, y, 0, 0, 0, 0, x + s, y, 0, 0, 0, 0, x + s, y + s, 0, 0, 0, 0, x, y + s, 0, 0, 0, 0];
    const rev = (p) => { const out = []; for (let i = p.length - 6; i >= 0; i -= 6) out.push(...p.slice(i, i + 6)); return out; };
    const o = { glyphs: [{ ch: 'H', contours: [sq(0, -50, 40)] }, { ch: 'o', contours: [sq(50, -40, 30), rev(sq(60, -30, 10))] }], fill: '#ff0000', stroke: '#000000', strokeWidth: 2 };
    const sh = M.motionOps.textToShapes(e, c.id, t.id, o);
    let cc = e.project.comps[0];
    ok(cc.layers[0].id === sh.id && sh.name === 'Ho contornos' && sh.type === 'shape', 'capa de forma encima');
    ok(sh.shapes.map((s) => s.name).join() === 'H,o' && sh.shapes[1].contours.length === 1 && sh.shapes[0].fill.color.v === '#ff0000' && sh.shapes[0].stroke.on && sh.shapes[0].stroke.width.v === 2, 'grupos por carácter');
    ok(sh.transform.position.k.length === 2 && cc.layers[1].hidden, 'transformación copiada, texto oculto');
    e.undo();
    ok(e.project.comps[0].layers.length === 1 && !e.project.comps[0].layers[0].hidden, 'deshacer');
    const so = M.motionOps.textToMasks(e, c.id, t.id, o);
    ok(so.type === 'solid' && so.solid.width === 400 && so.masks.length === 3, `máscaras ${so.masks.length}`);
    ok(so.masks.map((m) => m.mode).join() === 'add,add,subtract' && so.masks[2].name === 'o 2', so.masks.map((m) => `${m.name}:${m.mode}`).join());
    // the solid's pixels = text pixels + half the comp (anchor moved the same)
    ok(so.masks[0].path.v[0] === 200 && so.masks[0].path.v[1] === 50 && so.transform.anchor.v[0] === 200 && so.transform.anchor.v[1] === 100, `${so.masks[0].path.v.slice(0, 2)} ${so.transform.anchor.v}`);
    let threw = false; try { M.motionOps.textToShapes(e, c.id, t.id, { ...o, glyphs: [] }); } catch { threw = true; }
    ok(threw, 'sin contornos: error');
  });
  test('operaciones: trazado automático (un fotograma y entorno de trabajo con claves mantenidas) y ejes de fuente', () => {
    const e = new core.Editor();
    const c = M.motionOps.compNew(e, { width: 200, height: 200, duration: 1, fps: 10 });
    const s = M.motionOps.layerAdd(e, c.id, 'solid', { color: '#ffffff', width: 100, height: 100 });
    const outer = { path: [0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 10, 10, 0, 0, 0, 0], area: 50, depth: 0, hole: false };
    const hole = { ...outer, depth: 1, hole: true, area: 5 };
    let r = M.motionOps.autoTraceApply(e, c.id, s.id, [{ t: 0, paths: [outer, hole] }]);
    let l = e.project.comps[0].layers[0];
    ok(r.layer === s.id && l.masks.length === 2 && l.masks[1].mode === 'subtract' && l.masks[0].name === 'Máscara 1' && !l.masks[0].path.k, 'un fotograma');
    e.undo();
    r = M.motionOps.autoTraceApply(e, c.id, s.id, [{ t: 0, paths: [outer] }, { t: 0.1, paths: [outer, hole] }], { newLayer: true });
    l = e.project.comps[0].layers[0];
    ok(l.id === r.layer && l.name === `Trazado automático ${s.name}` && l.solid.width === 100 && l.masks.length === 2, 'nueva capa');
    ok(l.masks[0].path.k.length === 2 && l.masks[0].path.k[0].i === 'hold' && l.masks[1].path.k[0].v.length === 0 && l.masks[1].path.k[1].v.length === 18, 'claves por fotograma');
    const t = M.motionOps.layerAdd(e, c.id, 'text', { text: 'A', font: 'Bahnschrift' });
    ok(JSON.stringify(M.motionOps.textAxesSet(e, c.id, t.id, { wdth: 80, wght: 650 })) === '{"wdth":80,"wght":650}', 'ejes');
    M.motionOps.propSet(e, c.id, t.id, 'text.axes.wdth', { keys: [{ t: 0, v: 75 }, { t: 1, v: 100 }] });
    const tl = e.project.comps[0].layers.find((x) => x.id === t.id);
    ok(near(M.keyedAt(tl.text.axes.wdth, 0.5), 87.5, 1e-6), 'eje animable');
    const seen = []; M.forEachProp(tl, (_, p) => seen.push(p));
    ok(seen.includes('text.axes.wdth'), 'forEachProp');
    M.motionOps.textAxesSet(e, c.id, t.id, { wdth: null, wght: null });
    ok(!e.project.comps[0].layers.find((x) => x.id === t.id).text.axes, 'quitar ejes');
    let bad = false; try { M.motionOps.textAxesSet(e, c.id, t.id, { weight: 1 }); } catch { bad = true; }
    ok(bad, 'etiqueta inválida');
  });
};
