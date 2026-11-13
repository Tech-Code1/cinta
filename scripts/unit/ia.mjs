// Unit tests of «ia»: Roto Brush & Refine Edge (effect catalogue entry, RLE of the mattes, strokes / span / freeze
// with undo, segmentation of a frame from one stroke, motion of the subject) and Content-Aware Fill's maths (the
// hole from masks, filling from other frames, patch-based completion and the membrane).
export default ({ test, ok, near, M, core }) => {
  const S = core.segment;
  const W = 160, H = 96;
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  /** orange ellipse (cx, cy, r) on a striped blue-green background with noise; ground truth */
  const frame = (cx, cy, r) => {
    const d = new Uint8Array(W * H * 3), gt = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, inside = (x - cx) ** 2 + ((y - cy) * 1.2) ** 2 < r * r, n = (rnd() - 0.5) * 36;
      gt[i] = inside ? 1 : 0;
      if (inside) { d[i * 3] = 205 + n; d[i * 3 + 1] = 115 + n + 15 * Math.sin(x / 3); d[i * 3 + 2] = 60 + n; }
      else { const s = ((x + y) >> 3) & 1; d[i * 3] = 50 + n + s * 40; d[i * 3 + 1] = 110 + n + s * 30; d[i * 3 + 2] = 150 + n; }
    }
    return { img: { w: W, h: H, d }, gt };
  };
  const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++; } return i / u; };

  test('ia: el efecto «Pincel rotoscopia y Perf. borde» (ADBE Samurai) con los nombres y valores de AE', () => {
    const d = M.fxDef('rotoBrush');
    ok(d.name === 'Pincel rotoscopia y Perf. borde' && d.still, d.name);
    const p = Object.fromEntries(d.params.map((x) => [x.id, x]));
    ok(p.searchRadius.def === 50 && p.motionThreshold.def === 10 && p.motionDamping.def === 20 && p.edgeDetection.def === 'balanced', 'propagación');
    ok(p.quality.choices.map((c) => c.name).join('|') === 'Estándar|Mejor', 'calidad');
    ok(p.edgeDetection.choices.map((c) => c.name).join('|') === 'Priorizar bordes previstos|Equilibrado|Priorizar bordes actuales', 'detección de bordes');
    ok(p.renderRefine.def === 1 && p.reDecontaminate.def === 1 && p.reDeconAmount.def === 100, 'perfeccionar');
    ok(core.aeEffectId('ADBE Samurai') === 'rotoBrush' && core.aeEffectId('Roto Brush & Refine Edge') === 'rotoBrush' && core.aeMatchName('rotoBrush') === 'ADBE Samurai', 'nombre de coincidencia');
  });

  test('ia: RLE de los mates: ida y vuelta exacta y compacta', () => {
    const m = new Uint8Array(5000);
    for (let i = 0; i < m.length; i++) m[i] = (i % 700) > 300 && (i % 700) < 520 ? 1 : 0;
    const s = M.rleEncode(m), back = M.rleDecode(s, m.length);
    ok(back.every((v, i) => v === m[i]), 'idéntico');
    ok(s.length < 60, `longitud ${s.length}`);
    ok(M.rleDecode(M.rleEncode(new Uint8Array(10).fill(1)), 10).every((v) => v === 1), 'todo dentro');
  });

  test('ia: trazos, espacio y congelar con deshacer; los trazos se guardan en tiempo de origen', () => {
    const e = new core.Editor(core.newProject());
    const c = M.motionOps.compNew(e, { width: 320, height: 180, fps: 30, duration: 2 });
    e.mutate('media', (p) => p.media.push({ id: 'm1', path: 'x.mp4', kind: 'video', duration: 4, width: 320, height: 180, fps: 30, hasAudio: false, hasVideo: true }));
    const l = M.motionOps.layerAdd(e, c.id, 'video', { mediaId: 'm1' });
    e.mutate('mover', (p) => { const L = M.findLayer(M.findComp(p.comps, c.id), l.id); L.start = -1; });
    const r = M.motionOps.rotoStroke(e, c.id, l.id, { kind: 'fg', t: 0.5, points: [[10, 10], [20, 20]] });
    const L = () => M.findLayer(M.findComp(e.project.comps, c.id), l.id);
    ok(L().effects[0].fx === 'rotoBrush' && r.stroke.name === 'Primer plano 1', JSON.stringify(r));
    ok(near(L().effects[0].roto.strokes[0].s, 1.5), `tiempo de origen ${L().effects[0].roto.strokes[0].s}`);
    let err = '';
    try { M.motionOps.rotoStroke(e, c.id, l.id, { kind: 'refine', t: 0.5, points: [[1, 1]] }); } catch (x) { err = x.message; }
    ok(!err, err);
    M.motionOps.rotoEdit(e, c.id, l.id, { span: [0.2, 1.2] });
    ok(near(L().effects[0].roto.span[0], 1.2) && near(L().effects[0].roto.span[1], 2.2), JSON.stringify(L().effects[0].roto.span));
    err = '';
    try { M.motionOps.rotoEdit(e, c.id, l.id, { freeze: true }); } catch (x) { err = x.message; }
    ok(/congelar/.test(err), `congelar sin propagación: ${err}`);
    e.undo(); e.undo();
    ok(L().effects[0].roto.strokes.length === 1 && !L().effects[0].roto.span, 'deshacer');
    const img = M.motionOps.layerAdd(e, c.id, 'solid', {});
    err = '';
    try { M.motionOps.rotoStroke(e, c.id, img.id, { kind: 'fg', t: 0.5, points: [[1, 1]] }); } catch (x) { err = x.message; }
    ok(/metraje/.test(err), err);
  });

  test('ia: un trazo de primer plano segmenta el sujeto (camino aleatorio con modelos de color)', () => {
    const f = frame(70, 50, 28);
    const fg = new Uint8Array(W * H), bg = new Uint8Array(W * H);
    S.rasterStroke(fg, W, H, [55, 52, 85, 48], 3);
    const m = S.segmentFrame(f.img, fg, bg, null, {});
    ok(iou(m, f.gt) > 0.92, `IoU ${iou(m, f.gt)}`);
    // a background stroke across the subject cuts it
    S.rasterStroke(bg, W, H, [88, 20, 88, 80], 3);
    const m2 = S.segmentFrame(f.img, fg, bg, null, {});
    let right = 0; for (let y = 0; y < H; y++) for (let x = 92; x < W; x++) right += m2[y * W + x];
    ok(right < 20, `a la derecha del trazo de fondo: ${right}`);
  });

  test('ia: el movimiento del sujeto (afín de puntos seguidos) y la propagación siguen al sujeto', () => {
    const a = frame(60, 48, 26), b = frame(66, 50, 26);
    const A = S.subjectMotion(S.toGray(a.img), S.toGray(b.img), W, H, a.gt);
    ok(A && near(A[2] + A[0] * 60 + A[1] * 48 - 60, 6, 2.5), `afín ${A}`);
    const damped = S.dampMotion([1, 0, 0.5, 0, 1, 0, 0], W, H, 1, 0.5);
    ok(near(damped[2], 0.25), `atenuación ${damped}`);
    const w = S.warpMask(a.gt, W, H, [1, 0, 6, 0, 1, 2]);
    ok(iou(w, b.gt) > 0.85, `máscara movida ${iou(w, b.gt)}`);
  });

  test('ia: el hueco de una máscara Restar (escaneo par-impar) y la expansión', () => {
    const e = new core.Editor(core.newProject());
    const c = M.motionOps.compNew(e, { width: 100, height: 100, fps: 30, duration: 1 });
    const l = M.motionOps.layerAdd(e, c.id, 'solid', { width: 100, height: 100 });
    M.motionOps.maskAdd(e, c.id, l.id, { shape: 'rect', x: 20, y: 30, width: 40, height: 20, mode: 'subtract' });
    const cc = M.findComp(e.project.comps, c.id), L = M.findLayer(cc, l.id);
    const cov = core.layerCoverage(cc, L, 0, 50, 50, 100, 100);
    let holes = 0; for (const v of cov) holes += 1 - v;
    ok(near(holes, 20 * 10, 30) && cov[20 * 50 + 20] === 0 && cov[5 * 50 + 5] === 1, `hueco ${holes}`);
  });

  test('ia: Relleno según el contenido toma el fondo de otros fotogramas (Objeto) y completa por parches lo nunca visto', () => {
    const n = 6, frames = [];
    for (let k = 0; k < n; k++) { const f = frame(40 + k * 12, 48, 16); frames.push({ img: f.img.d, hole: S.morph(f.gt, W, H, 2), gt: f.gt }); }
    const out = core.fillFrames(frames, W, H, { method: 'object' });
    // where the disc was on frame 2: the fill is background (blue > red), not orange
    let orange = 0, n2 = 0;
    for (let i = 0; i < W * H; i++) if (frames[2].hole[i]) { n2++; if (out[2][i * 3] > 160 && out[2][i * 3 + 2] < 110) orange++; }
    ok(n2 > 200 && orange < n2 * 0.02, `naranja ${orange} de ${n2}`);
    // a still hole on a single frame: PatchMatch completion of the stripes, then the membrane
    const one = frame(80, 48, 0.1);
    const hole = new Uint8Array(W * H); for (let y = 30; y < 60; y++) for (let x = 60; x < 100; x++) hole[y * W + x] = 1;
    const img = { w: W, h: H, d: Float32Array.from(one.img.d) };
    core.inpaint(img, hole, {});
    let blue = 0, cnt = 0; for (let i = 0; i < W * H; i++) if (hole[i]) { cnt++; if (img.d[i * 3 + 2] > img.d[i * 3]) blue++; }
    ok(blue > cnt * 0.95, `parches ${blue}/${cnt}`);
    const lap = { w: 20, h: 20, d: new Float32Array(1200) };
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) for (let c = 0; c < 3; c++) lap.d[(y * 20 + x) * 3 + c] = x * 10;
    const h2 = new Uint8Array(400); for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) h2[y * 20 + x] = 1;
    for (let i = 0; i < 400; i++) if (h2[i]) lap.d[i * 3] = 0;
    core.laplaceFill(lap, h2);
    ok(near(lap.d[(10 * 20 + 10) * 3], 100, 6), `membrana ${lap.d[(10 * 20 + 10) * 3]}`);
  });
};
