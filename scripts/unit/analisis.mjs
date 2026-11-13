// Unit tests of «análisis»: the Warp Stabilizer's maths (smoothing, camera path, framing / auto-scale, analysis of
// synthetic frames) and the Lumetri Scopes' numbers and pictures.
export default ({ test, ok, near, M, core }) => {
  // a shaky shot: random jitter (translation + a little rotation) around a slow pan
  const shaky = (n, seed = 7) => {
    let s = seed;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
    const cum = [];
    for (let i = 0; i < n; i++) cum.push({ u: 0.001 * i + rnd() * 0.03, v: rnd() * 0.03, a: rnd() * 0.02 });
    const d = { v: 1, key: 'k', aspect: 0.5625, t0: 0, fps: 30, n, tr: [0, 0], sim: [1, 0, 0, 0], hom: [1, 0, 0, 0, 1, 0, 0, 0], grid: [6, 4], mesh: new Array(48).fill(0), pts: [[]], inliers: [0] };
    const Cm = (c) => [Math.cos(c.a), -Math.sin(c.a), c.u, Math.sin(c.a), Math.cos(c.a), c.v, 0, 0, 1];
    for (let i = 1; i < n; i++) {
      const Mi = M.mul3(Cm(cum[i]), M.inv3(Cm(cum[i - 1])));
      d.tr.push(Mi[2], Mi[5]); d.sim.push(Mi[0], Mi[3], Mi[2], Mi[5]); d.hom.push(...Mi.slice(0, 8).map((v) => v / Mi[8])); d.mesh.push(...new Array(48).fill(0)); d.pts.push([]); d.inliers.push(10);
    }
    return d;
  };

  test('análisis: el suavizado gaussiano conserva una rampa y una constante, y quita el temblor', () => {
    const ramp = Array.from({ length: 50 }, (_, i) => i * 0.5);
    const r = M.smoothSeries(ramp, 6);
    ok(r.every((v, i) => near(v, ramp[i], 1e-9)), 'rampa');
    ok(M.smoothSeries([3, 3, 3, 3], 2).every((v) => near(v, 3, 1e-12)), 'constante');
    const noisy = Array.from({ length: 200 }, (_, i) => Math.sin(i * 1.7) * 2), sm = M.smoothSeries(noisy, 8);
    const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    ok(rms(sm) < rms(noisy) * 0.1, `${rms(sm)} vs ${rms(noisy)}`);
    ok(M.smoothSeries([1, 5, 2], 0).join() === '1,5,2', 'suavidad 0');
  });

  test('análisis: escala para llenar el encuadre (escala automática)', () => {
    const a = 0.5625, frame = [[-0.5, -a / 2], [0.5, -a / 2], [0.5, a / 2], [-0.5, a / 2]];
    ok(near(M.scaleToFill(frame, 0.5, a / 2), 1, 1e-9), 'el propio encuadre: 100 %');
    const right = frame.map(([x, y]) => [x + 0.05, y]);
    ok(near(M.scaleToFill(right, 0.5, a / 2), 0.5 / 0.45, 1e-9), `desplazado ${M.scaleToFill(right, 0.5, a / 2)}`);
    // a 10 % margin (action safe) needs less
    ok(M.scaleToFill(right, 0.4, a * 0.4) < M.scaleToFill(right, 0.5, a / 2), 'margen');
    ok(M.scaleToFill(frame.map(([x, y]) => [x + 0.6, y]), 0.5, a / 2) === Infinity, 'centro fuera');
  });

  test('análisis: Suavizar movimiento reduce mucho el movimiento residual; Sin movimiento lo anula', () => {
    const d = shaky(90);
    const before = M.residualMotion(d, null);
    for (const method of ['position', 'similarity', 'perspective', 'subspace']) {
      const r = M.stabilize(d, { ...M.STAB_DEFAULTS, method, framing: 'stabilize' });
      const after = M.residualMotion(d, r);
      ok(after < before / 4, `${method}: ${after} vs ${before}`);
    }
    const r0 = M.stabilize(d, { ...M.STAB_DEFAULTS, method: 'similarity', result: 'none', framing: 'stabilize' });
    ok(M.residualMotion(d, r0) < before / 50, `sin movimiento ${M.residualMotion(d, r0)}`);
    // a point of the scene stays put in No Motion
    const C = M.cameraPath(d, 'similarity');
    const p0 = M.ap3(r0.fwd[0], 0.1, 0.1), q = M.ap3(C[50], 0.1, 0.1), p50 = M.ap3(r0.fwd[50], q[0], q[1]);
    ok(near(p0[0], p50[0], 1e-6) && near(p0[1], p50[1], 1e-6), `${p0} ${p50}`);
  });

  test('análisis: encuadre — recortar, escala automática (con máximo) y escala adicional', () => {
    const d = shaky(60);
    const s = M.stabilize(d, { ...M.STAB_DEFAULTS, framing: 'stabilize' });
    ok(s.scale === 1 && !s.crop, 'sólo estabilizar');
    const c = M.stabilize(d, { ...M.STAB_DEFAULTS, framing: 'crop' });
    ok(c.scale === 1 && c.crop && c.crop[0] < 0.5 && near(c.crop[1] / c.crop[0], 0.5625, 1e-9), `recortar ${c.crop}`);
    const a = M.stabilize(d, { ...M.STAB_DEFAULTS, framing: 'cropScale' });
    ok(a.scale > 1 && a.scale < 1.5 && !a.crop && near(a.scale, a.needed, 1e-9), `auto ${a.scale}`);
    // every frame's footage covers the whole output after the auto-scale
    const as = 0.5625, corners = [[-0.5, -as / 2], [0.5, -as / 2], [0.5, as / 2], [-0.5, as / 2]];
    for (let i = 0; i < d.n; i++) ok(M.scaleToFill(corners.map(([x, y]) => M.ap3(a.fwd[i], x, y)), 0.5, as / 2) <= 1 + 1e-6, `fotograma ${i} con bordes`);
    const lim = M.stabilize(d, { ...M.STAB_DEFAULTS, framing: 'cropScale', maxScale: 101 });
    ok(near(lim.scale, 1.01, 1e-9) && lim.overcropped && lim.crop, 'escala máxima');
    const add = M.stabilize(d, { ...M.STAB_DEFAULTS, framing: 'stabilize', additionalScale: 120 });
    ok(near(add.scale, 1.2, 1e-9), 'escala adicional');
    const safe = M.stabilize(d, { ...M.STAB_DEFAULTS, framing: 'cropScale', actionSafe: 10 });
    ok(safe.scale < a.scale, 'margen seguro para acción');
  });

  test('análisis: conservar escala quita el zoom de la corrección', () => {
    const d = shaky(40);
    // add a zoom wobble
    for (let i = 1; i < d.n; i++) { const k = i % 2 ? 1.02 : 1 / 1.02; for (let j = 0; j < 2; j++) d.sim[i * 4 + j] *= k; [0, 1, 3, 4].forEach((j) => { d.hom[i * 8 + j] *= k; }); }
    d.key = 'zoom';
    const p = M.stabilize(d, { ...M.STAB_DEFAULTS, method: 'similarity', preserveScale: true, framing: 'stabilize' });
    ok(p.fwd.every((f) => near(Math.hypot(f[0], f[3]), 1, 1e-6)), 'sin zoom');
    const q = M.stabilize(d, { ...M.STAB_DEFAULTS, method: 'similarity', framing: 'stabilize' });
    ok(q.fwd.some((f) => Math.abs(Math.hypot(f[0], f[3]) - 1) > 0.005), 'con zoom');
  });

  test('análisis: puntos de seguimiento de fotogramas sintéticos dan el desplazamiento conocido', () => {
    const W = 160, H = 90, big = 220;
    // a textured scene (smoothed noise) moved by known sub-pixel offsets
    let s = 3; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const scene = new Float32Array(big * big).map(() => rnd() * 255);
    for (let k = 0; k < 2; k++) for (let i = big + 1; i < big * big - big - 1; i++) scene[i] = (scene[i - 1] + scene[i + 1] + scene[i - big] + scene[i + big] + scene[i] * 4) / 8;
    const at = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi, i = yi * big + xi; return (scene[i] * (1 - u) + scene[i + 1] * u) * (1 - v) + (scene[i + big] * (1 - u) + scene[i + big + 1] * u) * v; };
    const shifts = [[0, 0], [1.5, -0.75], [3.25, 0.5], [2.0, 2.25]];
    const frames = shifts.map(([dx, dy]) => Uint8Array.from({ length: W * H }, (_, k) => at(30 + (k % W) - dx, 30 + Math.floor(k / W) - dy)));
    const a = core.analyzeFrames(frames, W, H);
    ok(a.n === 4 && a.inliers[1] > 10, `inliers ${a.inliers}`);
    for (let i = 1; i < 4; i++) {
      const du = (shifts[i][0] - shifts[i - 1][0]) / W, dv = (shifts[i][1] - shifts[i - 1][1]) / W;
      ok(near(a.tr[i * 2], du, 0.15 / W) && near(a.tr[i * 2 + 1], dv, 0.15 / W), `par ${i}: ${a.tr[i * 2] * W}, ${a.tr[i * 2 + 1] * W}`);
      ok(near(a.hom[i * 8 + 2], du, 0.2 / W) && near(a.hom[i * 8], 1, 0.003), `homografía ${i}`);
    }
  });

  test('ámbitos: luminancia Rec. 709 / 601, posiciones del vectorescopio y HLS', () => {
    ok(near(M.ycbcr(1, 1, 1, '709')[0], 1, 1e-12) && near(M.ycbcr(1, 0, 0, '709')[0], 0.2126, 1e-9) && near(M.ycbcr(1, 0, 0, '601')[0], 0.299, 1e-9), 'Y');
    const [, cb, cr] = M.ycbcr(1, 0, 0, '709');
    ok(near(cr, 0.5, 1e-9) && cb < 0, 'Cr del rojo');
    const red = M.vectorPos(1, 0, 0, '709')[0], yel = M.vectorPos(1, 1, 0, '709')[0], blu = M.vectorPos(0, 0, 1, '709')[0];
    ok(red > 90 && red < 120 && yel > 150 && yel < 180 && blu > 330, `${red} ${yel} ${blu}`);
    const [h, l, sat] = M.hls(0, 0.5, 0.5);
    ok(near(h, 180, 1e-9) && near(l, 0.25, 1e-9) && near(sat, 1, 1e-9), 'HLS');
  });

  test('ámbitos: datos de un sólido de color (histograma, forma de onda, vectorescopio)', () => {
    const w = 40, h = 20, px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = 230; px[i * 4 + 1] = 40; px[i * 4 + 2] = 20; px[i * 4 + 3] = 255; }
    const d = M.scopeData(px, w, h, '709', 16);
    ok(d.histogram.r[230] === w * h && d.histogram.g[40] === w * h && d.histogram.b[20] === w * h, 'histograma');
    const Y = M.ycbcr(230 / 255, 40 / 255, 20 / 255, '709')[0];
    ok(d.waveform.columns === 16 && d.waveform.lumaMin.every((v) => near(v, Y, 1e-3)) && d.waveform.rMax.every((v) => near(v, 230 / 255, 1e-3)), 'forma de onda');
    ok(Math.abs(d.vectorscope.hueDeg - M.vectorPos(1, 0, 0, '709')[0]) < 15 && d.vectorscope.meanChroma > 0.3, `vectorescopio ${d.vectorscope.hueDeg}`);
    ok(d.vectorscope.over75 === 1 && d.vectorscope.over100 === 0, `75 % ${d.vectorscope.over75} 100 % ${d.vectorscope.over100}`);
    // a skin tone sits near the skin-tone line
    for (let i = 0; i < w * h; i++) { px[i * 4] = 224; px[i * 4 + 1] = 172; px[i * 4 + 2] = 138; }
    const sk = M.scopeData(px, w, h, '709');
    ok(Math.abs(sk.vectorscope.skinToneDeviationDeg) < 12, `piel ${sk.vectorscope.skinToneDeviationDeg}`);
  });

  test('ámbitos: imágenes de cada ámbito, disposición y ajustes preestablecidos', () => {
    const w = 32, h = 18, px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = 255; px[i * 4 + 3] = 255; }
    const s = M.applyPreset(M.SCOPE_DEFAULTS, 'allRGB');
    ok(s.scopes.length === 4 && s.waveform === 'rgb' && s.parade === 'rgb', 'Todos los ámbitos RGB');
    const tiles = M.scopeLayout(s.scopes, 400, 300);
    ok(tiles.length === 4 && tiles.every((t) => t.x + t.w <= 400 && t.y + t.h <= 300), 'disposición');
    ok(M.scopeLayout(['vectorYUV', 'parade', 'waveform'], 400, 300)[0].w === 200, 'vectorescopio cuadrado a la izquierda');
    for (const k of ['vectorYUV', 'vectorHLS', 'histogram', 'parade', 'waveform']) {
      const d = M.rasterScope(k, px, w, h, { ...M.SCOPE_DEFAULTS, waveform: 'rgb' }, 120, 90);
      ok(d.length === 120 * 90 * 4, k);
    }
    // the red waveform trace sits at the top (255) of the RGB waveform: a bright red row near y = 5 %
    const wf = M.rasterScope('waveform', px, w, h, { ...M.SCOPE_DEFAULTS, waveform: 'rgb' }, 100, 100);
    const rowRed = (y) => { let m = 0; for (let x = 0; x < 100; x++) m = Math.max(m, wf[(y * 100 + x) * 4]); return m; };
    ok(rowRed(5) > 200 && rowRed(50) < 60, `rojo arriba ${rowRed(5)} / ${rowRed(50)}`);
    ok(M.axisPos(1, 'hdr') > 0.45 && M.axisPos(1, 'hdr') < 0.56 && M.axisPos(1, 'float') === 1, 'escala HDR');
  });
};
