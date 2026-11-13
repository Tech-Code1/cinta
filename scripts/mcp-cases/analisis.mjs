// MCP cases of «análisis»: the Warp Stabilizer on a synthetic shaky shot (a static textured scene moved and turned
// by jitter every frame) and the Lumetri Scopes of a comp frame.
export default async ({ test, call, callErr, assert, imgOf, ff, W }) => {
  const AP = W('analisis.cinta');
  // the shake: a 480×270 window over a still noise picture, moved by up to ±14 px and turned by up to ±0.6° per frame
  const shaky = W('shaky.mp4');
  ff('-loop', '1', '-framerate', '30', '-t', '2', '-i', W('still.png'), '-vf',
    "rotate=a='0.011*sin(n*2.71)':c=black,crop=480:270:x='300+14*sin(n*1.93)+6*sin(n*4.37)':y='200+11*sin(n*2.41+1)+5*sin(n*5.13)'",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p', shaky);
  let lay, fxId;

  /** shift (px) between two frames of the comp: the best match of the middle within ±18 px (gray, sum of differences) */
  const shiftBetween = (a, b) => {
    const g = (img, x, y) => { const p = img.at(x / img.width, y / img.height); return p[0] + p[1] + p[2]; };
    let best = Infinity, bs = [0, 0];
    for (let dy = -18; dy <= 18; dy += 1) for (let dx = -18; dx <= 18; dx += 1) {
      let s = 0;
      for (let y = 80; y < 190; y += 6) for (let x = 120; x < 360; x += 6) s += Math.abs(g(a, x, y) - g(b, x + dx, y + dy));
      if (s < best) { best = s; bs = [dx, dy]; }
    }
    return Math.hypot(...bs);
  };

  await test('análisis: warp_stabilize añade el Estabilizador de deformación, analiza en segundo plano y reduce mucho el movimiento', async () => {
    await call('project_new', { path: AP, width: 480, height: 270, fps: 30 });
    await call('comp_new', { project: AP, name: 'Estab', width: 480, height: 270, fps: 30, duration: 2, bg: '#000000' });
    lay = (await call('layer_add', { project: AP, comp: 'Estab', type: 'video', media_path: shaky })).layer.id;
    // through effect_add, like any effect: status first (no analysis yet)
    fxId = (await call('effect_add', { project: AP, comp: 'Estab', layer: lay, effect: 'warpStabilizer' })).effect.id;
    let r = await call('warp_stabilize', { project: AP, comp: 'Estab', layer: lay, analyze: false });
    assert(r.effect.id === fxId && !r.added && r.analysedFrames === 0 && /Analizar/.test(r.status), JSON.stringify(r));
    // the frame shows AE's banner until it is analysed
    const banner = imgOf(await call('comp_frame', { project: AP, comp: 'Estab', time: 0.5 }));
    const mid = banner.at(0.02, 0.5);
    assert(mid[0] > 150 && mid[1] > 70 && mid[2] < 120, `banda de advertencia ${mid}`);
    r = await call('warp_stabilize', { project: AP, comp: 'Estab', layer: lay });
    assert(r.analysed && r.analysedFrames >= 58 && r.trackPointsPerFrame >= 12, JSON.stringify(r));
    assert(r.residualMotionPx.before > 4 && r.residualMotionPx.reduction > 5, `movimiento residual ${JSON.stringify(r.residualMotionPx)}`);
    assert(r.autoScale > 100 && r.autoScale <= 150 && !r.overcropped, `escala automática ${r.autoScale}`);
    // cached: a second call does not analyse again
    const again = await call('warp_stabilize', { project: AP, comp: 'Estab', layer: lay });
    assert(!again.analysed && again.analysedFrames === r.analysedFrames, 'caché');
  });

  await test('análisis: los fotogramas estabilizados casi no se mueven entre sí (medido en los píxeles)', async () => {
    const t = [0.9, 0.9 + 1 / 30];
    const st = await Promise.all(t.map(async (x) => imgOf(await call('comp_frame', { project: AP, comp: 'Estab', time: x, width: 480 }))));
    await call('effect_set', { project: AP, comp: 'Estab', layer: lay, effect: fxId, on: false });
    const raw = await Promise.all(t.map(async (x) => imgOf(await call('comp_frame', { project: AP, comp: 'Estab', time: x, width: 480 }))));
    await call('effect_set', { project: AP, comp: 'Estab', layer: lay, effect: fxId, on: true });
    const a = shiftBetween(raw[0], raw[1]), b = shiftBetween(st[0], st[1]);
    assert(a >= 5 && b <= a / 3, `sin estabilizar ${a} px, estabilizado ${b} px`);
  });

  await test('análisis: Sólo estabilizar deja bordes vacíos; Escala automática los quita; Recortar y método se aplican sin volver a analizar', async () => {
    // the frame with the biggest jump: look at the four edges
    const edges = (img) => { let black = 0, n = 0; for (let k = 0; k <= 40; k++) for (const [x, y] of [[k / 40, 0.003], [k / 40, 0.997], [0.003, k / 40], [0.997, k / 40]]) { const p = img.at(x, y); if (p[0] + p[1] + p[2] < 30) black++; n++; } return black / n; };
    let worst = 0;
    await call('warp_stabilize', { project: AP, comp: 'Estab', layer: lay, values: { framing: 'stabilize' } });
    for (const tt of [0.2, 0.5, 1.0, 1.5]) worst = Math.max(worst, edges(imgOf(await call('comp_frame', { project: AP, comp: 'Estab', time: tt, width: 480 }))));
    assert(worst > 0.05, `Sólo estabilizar: bordes vacíos ${worst}`);
    const r = await call('warp_stabilize', { project: AP, comp: 'Estab', layer: lay, values: { framing: 'cropScale' } });
    assert(!r.analysed, 'el encuadre no vuelve a analizar');
    let worst2 = 0;
    for (const tt of [0.2, 0.5, 1.0, 1.5]) worst2 = Math.max(worst2, edges(imgOf(await call('comp_frame', { project: AP, comp: 'Estab', time: tt, width: 480 }))));
    assert(worst2 < 0.01, `Escala automática: bordes ${worst2}`);
    const c = await call('warp_stabilize', { project: AP, comp: 'Estab', layer: lay, values: { framing: 'crop', method: 'similarity' } });
    assert(!c.analysed && c.crop && c.crop.width < 480 && c.residualMotionPx.reduction > 3, JSON.stringify(c));
    // Detailed Analysis needs a new analysis
    const d = await call('warp_stabilize', { project: AP, comp: 'Estab', layer: lay, values: { detailed: true }, analyze: false });
    assert(d.stale && /necesitan análisis/.test(d.status), JSON.stringify(d));
    const err = await callErr('warp_stabilize', { project: AP, comp: 'Estab', layer: (await call('layer_add', { project: AP, comp: 'Estab', type: 'solid', color: '#ff0000' })).layer.id });
    assert(/no es una capa de vídeo/.test(err), err);
  });

  await test('análisis: comp_scopes da el histograma, la forma de onda y el vectorescopio de un fotograma', async () => {
    await call('comp_new', { project: AP, name: 'Rojo', width: 320, height: 180, fps: 30, duration: 1, bg: '#000000' });
    await call('layer_add', { project: AP, comp: 'Rojo', type: 'solid', color: '#ff0000', width: 160, height: 180, position: [80, 90] });
    const r = await call('comp_scopes', { project: AP, comp: 'Rojo', time: 0, image: true, preset: 'allRGB', columns: 16 });
    const n = r.frame.width * r.frame.height;
    assert(Math.abs(r.histogram.r[255] - n / 2) < n * 0.03 && Math.abs(r.histogram.r[0] - n / 2) < n * 0.03 && r.histogram.g[0] > n * 0.97, `histograma r255 ${r.histogram.r[255]} / ${n}`);
    // left half red, right half black: the waveform's red max is 1 on the left columns and 0 on the right ones
    assert(r.waveform.rMax[0] > 0.98 && r.waveform.rMax[15] < 0.02 && Math.abs(r.waveform.lumaMax[0] - 0.2126) < 0.02, JSON.stringify(r.waveform.rMax));
    assert(r.vectorscope.meanChroma > 0.2 && Math.abs(r.vectorscope.hueDeg - 104) < 12, JSON.stringify(r.vectorscope));
    const img = imgOf(r);
    assert(img.width === 640 && img.share([255, 60, 60], 120) > 0.002, `imagen de los ámbitos ${img.width}`);
  });
};
