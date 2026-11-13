// MCP cases of the distorsion effects: rendered pixels through comp_frame.
export default async ({ test, call, callErr, assert, imgOf, decodePng, isColor, near, ff, probe, W, FF, root }) => {
  const P = W('distorsion.cinta');
  let n = 0;
  /** a 200×200 comp (red background) with a 200×200 layer: black → white ramp left to right (or a solid colour);
   *  returns (x, y) → [r, g, b] in comp px. fxs: [[effect, values], …] */
  const shot = async (fxs, { color, t = 0, ramp = true, w = 200, h = 200 } = {}) => {
    const name = `D${++n}`;
    await call('comp_new', { project: P, name, width: w, height: h, fps: 10, duration: 2, bg: '#ff0000' });
    const l = (await call('layer_add', { project: P, comp: name, type: 'solid', color: color ?? '#000000', width: w, height: h })).layer.id;
    if (ramp && !color) await call('effect_add', { project: P, comp: name, layer: l, effect: 'gradientRamp', values: { start: [0, h / 2], end: [w, h / 2], startColor: '#000000', endColor: '#ffffff' } });
    for (const [fx, values] of fxs) await call('effect_add', { project: P, comp: name, layer: l, effect: fx, values });
    const r = await call('comp_frame', { project: P, comp: name, time: t, width: w });
    assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`);
    const im = imgOf(r);
    await call('comp_delete', { project: P, comp: name });
    return (x, y) => im.at(x / w, y / h);
  };
  const g = (p) => p[1];
  const red = (p) => p[0] > 200 && p[1] < 50 && p[2] < 50;

  await test('distorsión: Remolino, Abombar, Ondas, Desplazamiento turbulento y Deformación de onda con los valores de After Effects', async () => {
    await call('project_new', { path: P, width: 200, height: 200, fps: 10, overwrite: true });
    const base = await shot([]);
    // Twirl: angle 0 (its default) leaves the layer; 90° turns the ramp near the centre (the top of the centre column
    // takes pixels from the side)
    const t0 = await shot([['twirl', {}]]), t1 = await shot([['twirl', { angle: 90, twirlRadius: 40 }]]);
    assert(Math.abs(g(t0(100, 60)) - g(base(100, 60))) < 4, 'Remolino: identidad con ángulo 0');
    assert(Math.abs(g(t1(100, 60)) - g(base(100, 60))) > 25, `Remolino: gira (${g(t1(100, 60))} frente a ${g(base(100, 60))})`);
    // Bulge: horizontal radius only magnifies across x (a pixel right of the centre shows what was nearer it)
    const b1 = await shot([['bulge', { hRadius: 80, vRadius: 80 }]]);
    assert(g(b1(130, 100)) < g(base(130, 100)) - 8, `Abombar: amplía desde el centro (${g(b1(130, 100))} < ${g(base(130, 100))})`);
    const b2 = await shot([['bulge', { hRadius: 80, vRadius: 80, height: -1 }]]);
    assert(g(b2(130, 100)) > g(base(130, 100)) + 8, `Abombar: altura negativa encoge (${g(b2(130, 100))} > ${g(base(130, 100))})`);
    // Ripple: radius 0 (default) does nothing; symmetric ripple of 100 % moves the ramp
    const r0 = await shot([['ripple', { amplitude: 200 }]]);
    assert(Math.abs(g(r0(130, 100)) - g(base(130, 100))) < 4, 'Ondas: radio 0 no deforma');
    let rd = 0;
    const r1 = await shot([['ripple', { rippleRadius: 100, amplitude: 200, conversion: 'symmetric' }]]);
    for (let x = 20; x < 200; x += 20) rd += Math.abs(g(r1(x, 100)) - g(base(x, 100)));
    assert(rd > 60, `Ondas: deforma (${rd})`);
    // Turbulent Displace: horizontal kind moves pixels along x only (the vertical ramp stays the same per row);
    // Pin All keeps the very edges in place
    const td = await shot([['turbulentDisplace', { kind: 'horizontal', amount: 60, size: 40, pinning: 'none' }]]);
    let dd = 0; for (let x = 20; x < 200; x += 20) dd += Math.abs(g(td(x, 100)) - g(base(x, 100)));
    assert(dd > 40, `Desplazamiento turbulento: horizontal mueve la rampa (${dd})`);
    const tp = await shot([['turbulentDisplace', { amount: 60, size: 40 }]]);
    assert(Math.abs(g(tp(1, 100)) - g(base(1, 100))) < 6, `Desplazamiento turbulento: fijar todo deja el borde (${g(tp(1, 100))})`);
    // Wave Warp: the default (direction 90°, height 10) bends the top edge: some top pixels show the background
    const ww = await shot([['waveWarp', {}]]);
    let gaps = 0; for (let x = 2; x < 200; x += 4) if (red(ww(x, 2)) || red(ww(x, 197))) gaps++;
    assert(gaps > 5, `Deformación de onda: el borde ondula (${gaps})`);
    // square wave of 0 height: identity
    const w0 = await shot([['waveWarp', { type: 'square', height: 0 }]]);
    assert(Math.abs(g(w0(100, 100)) - g(base(100, 100))) < 4 && !red(w0(100, 2)), 'Deformación de onda: altura 0 no deforma');
  });

  await test('distorsión: Transformar (escala de anchura, sesgo) y transiciones de After Effects (radial ambos, iris, persianas, bloques)', async () => {
    await call('project_new', { path: P, width: 200, height: 200, fps: 10, overwrite: true });
    const blue = { color: '#2040ff' };
    // Transform: uniform off, half the width → the sides show the background, the top centre does not
    const tf = await shot([['transformFx', { uniform: false, scaleWidth: 50 }]], blue);
    assert(red(tf(20, 100)) && !red(tf(100, 20)), 'Transformar: escala de anchura 50 % sin escala uniforme');
    const tk = await shot([['transformFx', { skew: 30 }]], blue);
    assert(red(tk(5, 5)) || red(tk(195, 195)) || red(tk(195, 5)) || red(tk(5, 195)), 'Transformar: el sesgo deja esquinas vacías');
    // Radial Wipe Both at 50 %: the top (start angle 0) is wiped on both sides, the bottom stays
    const rw = await shot([['radialWipe', { completion: 50, wipe: 'both' }]], blue);
    assert(red(rw(60, 30)) && red(rw(140, 30)) && !red(rw(100, 180)), 'Barrido radial: ambos lados desde arriba');
    // Iris: outer radius 0 hides everything; 60 keeps the centre but not the corners
    const i0 = await shot([['iris', {}]], blue), i1 = await shot([['iris', { outerRadius: 60 }]], blue);
    assert(red(i0(100, 100)) && !red(i1(100, 100)) && red(i1(10, 10)), 'Barrido de iris: radio exterior');
    // Venetian Blinds 50 %, width 20: bands of 10 px gone, the other 10 px kept
    const vb = await shot([['venetianBlinds', { completion: 50 }]], blue);
    let gone = 0, kept = 0; for (let y = 0.5; y < 200; y += 1) (red(vb(100, y)) ? gone++ : kept++);
    assert(Math.abs(gone - kept) < 30, `Persianas venecianas: mitad y mitad (${gone} / ${kept})`);
    // Block Dissolve 50 %: about half of the pixels gone
    const bd = await shot([['blockDissolve', { completion: 50, blockWidth: 10, blockHeight: 10 }]], blue);
    let gb = 0; for (let y = 5; y < 200; y += 10) for (let x = 5; x < 200; x += 10) if (red(bd(x, y))) gb++;
    assert(gb > 120 && gb < 280, `Disolución en bloques: ${gb} de 400 bloques`);
  });

  await test('distorsión: efectos nuevos — Bisel alfa, Biselar bordes, Lupa, Deformar, CC Lens, CC Slant, CC Tiler y transiciones CC', async () => {
    await call('project_new', { path: P, width: 200, height: 200, fps: 10, overwrite: true });
    const blue = { color: '#2040ff' };
    const base = await shot([]), bb = await shot([], blue);
    const lum = (q) => q[0] + q[1] + q[2];
    // Bevel Alpha / Bevel Edges: light from the upper left (−60°): the left edge is lighter, the right edge darker
    for (const [fx, v] of [['bevelAlpha', { thickness: 12, intensity: 1 }], ['bevelEdges', {}]]) {
      const b = await shot([[fx, v]], blue);
      assert(lum(b(2, 100)) > lum(bb(2, 100)) + 30 && lum(b(197, 100)) < lum(bb(197, 100)) - 30 && Math.abs(lum(b(100, 100)) - lum(bb(100, 100))) < 6, `${fx}: borde izquierdo ${b(2, 100)}, derecho ${b(197, 100)}, centro ${b(100, 100)}`);
    }
    // Magnify 200 % at the centre: a pixel 40 px right shows what was 20 px right (darker on the ramp); far away unchanged
    const mg = await shot([['magnify', { magnification: 200, size: 60 }]]);
    assert(g(mg(140, 100)) < g(base(140, 100)) - 15 && Math.abs(g(mg(190, 20)) - g(base(190, 20))) < 4, `Lupa: ${g(mg(140, 100))} frente a ${g(base(140, 100))}`);
    // Warp (Arc, bend 50): the top corners drop, so the background shows above them; Flag shifts columns
    const wa = await shot([['warp', {}]], blue);
    assert(red(wa(5, 3)) && !red(wa(100, 100)), 'Deformar: arco');
    const wf = await shot([['warp', { style: 'flag', bend: 60 }]], blue);
    assert(red(wf(150, 3)) && red(wf(50, 197)) && !red(wf(50, 3)), 'Deformar: bandera');
    // CC Lens: outside the lens nothing; inside the centre stays the centre
    const ln = await shot([['ccLens', {}]]);
    assert(red(ln(5, 5)) && Math.abs(g(ln(100, 100)) - g(base(100, 100))) < 8, 'CC Lens: lente redonda');
    // CC Slant: slant 50 leans the top to the right: the top-left corner is empty, the bottom stays
    const sl = await shot([['ccSlant', { slant: 50 }]], blue);
    assert(red(sl(10, 10)) && !red(sl(10, 195)), 'CC Slant: inclinado sobre el suelo');
    // CC Tiler at 50 %: a tile centred on the layer (50…150), so at 150 the ramp starts again
    const tl = await shot([['ccTiler', { scale: 50 }]]);
    assert(g(tl(153, 100)) < 40 && g(tl(147, 100)) > 200, `CC Tiler: mosaico (${g(tl(147, 100))} | ${g(tl(153, 100))})`);
    // CC Radial ScaleWipe 30 %: a hole at the centre, the corners still there
    const rs = await shot([['ccRadialScaleWipe', { completion: 30 }]], blue);
    assert(red(rs(100, 100)) && !red(rs(5, 5)), 'CC Radial ScaleWipe: agujero en el centro');
    // CC Scale Wipe: the right half smears the centre column (direction 90°)
    const sw = await shot([['ccScaleWipe', { stretch: 10, direction: 90 }]]);
    assert(Math.abs(g(sw(180, 100)) - g(base(102, 100))) < 25 && Math.abs(g(sw(50, 100)) - g(base(50, 100))) < 4, `CC Scale Wipe: ${g(sw(180, 100))}`);
    // CC Grid Wipe 50 % (radial): the centre tiles are gone first, the corners stay
    const gw = await shot([['ccGridWipe', { completion: 50 }]], blue);
    assert(red(gw(100, 100)) && !red(gw(3, 3)), 'CC Grid Wipe: radial desde el centro');
    // CC Jaws 50 %: the middle opens, top and bottom remain
    const jw = await shot([['ccJaws', { completion: 50 }]], blue);
    assert(red(jw(100, 100)) && !red(jw(100, 5)), 'CC Jaws: se abre por el centro');
    // CC Line Sweep 50 %: part gone, part kept
    const ls = await shot([['ccLineSweep', { completion: 50 }]], blue);
    let gone = 0; for (let x = 5; x < 200; x += 10) if (red(ls(x, 100))) gone++;
    assert(gone > 4 && gone < 16, `CC Line Sweep: ${gone} de 20`);
  });

  await test('ronda 2: perspectiva y distorsión — Sombra radial, 3D básico, CC Cylinder, CC Sphere, Page Turn, Bender, Flo Motion, Griddler, Split, RepeTile, Smear y Compensación de óptica', async () => {
    await call('project_new', { path: P, width: 200, height: 200, fps: 10, overwrite: true });
    const blue = { color: '#2040ff' };
    const base = await shot([]);
    // Radial Shadow alone: black at 50 % over the red background; Glass Edge takes the layer's blue
    const rs = await shot([['radialShadow', { only: 1 }]], blue), rg = await shot([['radialShadow', { only: 1, render: 'glass' }]], blue);
    assert(near(rs(100, 100)[0], 128, 12) && rs(100, 100)[2] < 20, `Sombra radial: ${rs(100, 100)}`);
    assert(rg(100, 100)[2] > 100 && rg(100, 100)[0] > 100, `Sombra radial (borde de cristal): ${rg(100, 100)}`);
    // Basic 3D: swivelled 60°, the layer narrows (the sides show the background)
    const b3 = await shot([['basic3d', { swivel: 60 }]], blue);
    assert(red(b3(5, 100)) && red(b3(195, 100)) && !red(b3(100, 100)), 'Básico 3D: girar estrecha la capa');
    // CC Cylinder by default: a narrow cylinder (circumference = the layer's width); CC Sphere of radius 60
    const cy = await shot([['ccCylinder', {}]], blue), sp = await shot([['ccSphere', { radius: 60 }]], blue);
    assert(red(cy(10, 100)) && !red(cy(100, 100)) && !red(cy(100, 10)), 'CC Cylinder: cilindro centrado');
    assert(red(sp(10, 10)) && red(sp(100, 30)) && !red(sp(100, 100)), 'CC Sphere: esfera de radio 60');
    // CC Page Turn (bottom right corner to 75 % / 50 %): that corner is lifted, the top left stays
    const pg = await shot([['ccPageTurn', {}]], blue);
    assert(red(pg(197, 197)) && !red(pg(5, 5)), 'CC Page Turn: la esquina se levanta');
    // CC Bender 60: above the top point the layer leans right (its upper left shows the background)
    const bn = await shot([['ccBender', { amount: 60 }]], blue);
    assert(red(bn(20, 5)) && !red(bn(20, 195)), 'CC Bender: se curva por encima de la base');
    // CC Flo Motion: a knot pulls the image in; CC Smear drags the centre to 75 % / 25 %
    const fm = await shot([['ccFloMotion', { amount1: 100 }]]), sm = await shot([['ccSmear', {}]]);
    assert(Math.abs(g(fm(100, 50)) - g(base(100, 50))) > 15, `CC Flo Motion: ${g(fm(100, 50))}`);
    assert(Math.abs(g(sm(150, 50)) - g(base(100, 100))) < 12, `CC Smear: ${g(sm(150, 50))} frente a ${g(base(100, 100))}`);
    // CC Griddler half width with cut tiles: the tile edges are empty, the tile centres kept
    const gr = await shot([['ccGriddler', { hScale: 50 }]], blue);
    assert(red(gr(118, 100)) && !red(gr(110, 100)), 'CC Griddler: mosaicos cortados');
    // CC Split 60: a hole in the middle of A–B
    const st = await shot([['ccSplit', { split: 60 }]], blue);
    assert(red(st(100, 100)) && !red(st(100, 10)), 'CC Split: agujero');
    // Optics Compensation 120°: barrel distortion leaves the corners empty and the centre in place
    const oc = await shot([['opticsComp', { fov: 120 }]]);
    assert(red(oc(2, 2)) && Math.abs(g(oc(100, 100)) - g(base(100, 100))) < 6, 'Compensación de óptica: barril');
    // CC RepeTile: a 100 × 100 layer expanded 50 px to the right repeats itself there; nothing below
    const name = `D${++n}`;
    await call('comp_new', { project: P, name, width: 200, height: 200, fps: 10, duration: 2, bg: '#ff0000' });
    const l = (await call('layer_add', { project: P, comp: name, type: 'solid', color: '#2040ff', width: 100, height: 100 })).layer.id;
    await call('effect_add', { project: P, comp: name, layer: l, effect: 'ccRepeTile', values: { right: 50 } });
    const im = imgOf(await call('comp_frame', { project: P, comp: name, time: 0, width: 200 }));
    assert(!red(im.at(170 / 200, 0.5)) && red(im.at(0.5, 170 / 200)) && red(im.at(20 / 200, 0.5)), 'CC RepeTile: se repite a la derecha');
  });

  await test('ronda 2: transiciones — Barrido de tarjetas, CC Glass Wipe, Image Wipe, Light Wipe, Twister y WarpoMatic', async () => {
    await call('project_new', { path: P, width: 200, height: 200, fps: 10, overwrite: true });
    const blue = { color: '#2040ff' };
    const reds = (f) => { let k = 0; for (let y = 5; y < 200; y += 10) for (let x = 5; x < 200; x += 10) if (red(f(x, y))) k++; return k; };
    // Card Wipe: nothing missing at 0 %, cards seen edge on at 50 % (gaps), all turned over at 100 % (the back is the layer)
    const c0 = await shot([['cardWipe', { completion: 0 }]], blue), c5 = await shot([['cardWipe', { completion: 50 }]], blue), c1 = await shot([['cardWipe', { completion: 100 }]], blue);
    assert(reds(c0) === 0 && reds(c5) > 5 && reds(c1) < 3, `Barrido de tarjetas: ${reds(c0)} / ${reds(c5)} / ${reds(c1)}`);
    // Glass Wipe and Image Wipe at 50 % on the ramp: the dark (left) half goes first
    for (const fx of ['ccGlassWipe', 'ccImageWipe']) {
      const w = await shot([[fx, { completion: 50 }]]);
      assert(red(w(20, 100)) && !red(w(185, 100)), `${fx}: lo oscuro primero`);
    }
    // Light Wipe (round) at 50 %: the centre is gone, the corner remains
    const lw = await shot([['ccLightWipe', { completion: 50, intensity: 0 }]], blue);
    assert(red(lw(100, 100)) && !red(lw(3, 3)), 'CC Light Wipe: círculo desde el centro');
    // Twister at 50 %: the ribbon is edge on somewhere (gaps), not at 0 %
    const tw = await shot([['ccTwister', { completion: 50 }]], blue);
    assert(reds(tw) > 3, `CC Twister: ${reds(tw)}`);
    // WarpoMatic at 50 % without a layer to reveal: the dark side has gone, the bright side is still there
    const wm = await shot([['ccWarpoMatic', { completion: 50 }]]);
    assert(red(wm(10, 100)) && !red(wm(190, 100)), 'CC WarpoMatic: por brillo');
  });
  // a comp like shot() whose layer also has masks (mode None, named) — masks: [{ name, shape, x, y, width, height }]
  const mshot = async (fxs, masks, { color } = {}) => {
    const name = `D${++n}`;
    await call('comp_new', { project: P, name, width: 200, height: 200, fps: 10, duration: 2, bg: '#ff0000' });
    const l = (await call('layer_add', { project: P, comp: name, type: 'solid', color: color ?? '#000000', width: 200, height: 200 })).layer.id;
    if (!color) await call('effect_add', { project: P, comp: name, layer: l, effect: 'gradientRamp', values: { start: [0, 100], end: [200, 100], startColor: '#000000', endColor: '#ffffff' } });
    for (const m of masks) await call('mask_add', { project: P, comp: name, layer: l, mode: 'none', ...m });
    for (const [fx, values] of fxs) await call('effect_add', { project: P, comp: name, layer: l, effect: fx, values });
    const r = await call('comp_frame', { project: P, comp: name, time: 0, width: 200 });
    assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`);
    const im = imgOf(r);
    await call('comp_delete', { project: P, comp: name });
    return (x, y) => im.at(x / 200, y / 200);
  };

  await test('ronda 5: Barrido de tarjetas — Sistema de cámaras (posición de la cámara, posicionamientos de los bordes), Iluminación y Material', async () => {
    await call('project_new', { path: P, width: 200, height: 200, fps: 10, overwrite: true });
    const blue = { color: '#2040ff' };
    const reds = (f) => { let k = 0; for (let y = 5; y < 200; y += 10) for (let x = 5; x < 200; x += 10) if (red(f(x, y))) k++; return k; };
    // the defaults (Z 2, focal length 70, light straight ahead: ambient 0.25 + diffuse 0.75) show the layer as it is
    const c0 = await shot([['cardWipe', { completion: 0 }]], blue);
    assert(reds(c0) === 0 && Math.abs(c0(100, 100)[2] - 255) < 8 && Math.abs(c0(100, 100)[0] - 32) < 8, `por defecto: la capa tal cual (${c0(100, 100)})`);
    // the camera turned 40° round Y: the layer is seen at an angle (the background shows); Z 4: half size
    const ry = await shot([['cardWipe', { completion: 0, camRotY: 40 }]], blue), z4 = await shot([['cardWipe', { completion: 0, camZ: 4 }]], blue);
    assert(reds(ry) > 10, `rotación Y: ${reds(ry)}`);
    assert(red(z4(20, 20)) && red(z4(180, 180)) && !red(z4(100, 100)) && !red(z4(60, 60)), 'posición Z 4: la mitad de tamaño');
    // X,Y Position moves the layer's centre
    const xy = await shot([['cardWipe', { completion: 0, camXY: [140, 100] }]], blue);
    assert(red(xy(20, 100)) && !red(xy(190, 100)), 'posición X,Y: se desplaza');
    // Corner Pins: the top-left corner pulled in shows the background there, the rest stays
    const cp = await shot([['cardWipe', { completion: 0, cameraSystem: 'cornerPins', pinUL: [70, 70] }]], blue);
    assert(red(cp(30, 30)) && !red(cp(170, 170)) && !red(cp(100, 100)), 'posicionamientos de los bordes');
    const ca = await shot([['cardWipe', { completion: 0, cameraSystem: 'cornerPins', autoFocal: 1, pinUL: [40, 30], pinUR: [160, 30] }]], blue);
    assert(red(ca(20, 10)) && !red(ca(100, 150)), 'distancia focal automática');
    // Material: no diffuse, ambient 0.5 halves the colour; a point light close to the middle leaves the sides dark
    const am = await shot([['cardWipe', { completion: 0, ambient: 0.5, diffuse: 0 }]], blue);
    assert(Math.abs(am(100, 100)[2] - 128) < 12, `luz ambiental 0.5: ${am(100, 100)}`);
    const side = await shot([['cardWipe', { completion: 0, ambient: 0, lightType: 'point', lightPos: [100, 100], lightDepth: 0.05 }]], blue);
    assert(side(100, 100)[2] > side(10, 100)[2] + 40, `luz puntual cercana: el centro más claro (${side(100, 100)} / ${side(10, 100)})`);
    const sp = await shot([['cardWipe', { completion: 0, specular: 1, sharpness: 5 }]], blue);
    assert(sp(100, 100)[0] > 150, `reflejo especular: ${sp(100, 100)}`);
  });

  await test('ronda 5: Gafas 3D y CC Blobbylize', async () => {
    await call('project_new', { path: P, width: 200, height: 200, fps: 10, overwrite: true });
    const base = await shot([]);
    // Stereo Pair: both views squeezed side by side (the middle of each half shows the middle of the ramp)
    const sp = await shot([['glasses3d', {}]]);
    assert(Math.abs(g(sp(50, 100)) - g(base(100, 100))) < 12 && Math.abs(g(sp(150, 100)) - g(base(100, 100))) < 12, `par estéreo: ${g(sp(50, 100))} / ${g(sp(150, 100))}`);
    // Over Under: the same, top and bottom
    const ou = await shot([['glasses3d', { view: 'overUnder' }]]);
    assert(Math.abs(g(ou(100, 50)) - g(base(100, 100))) < 12 && Math.abs(g(ou(20, 150)) - g(base(20, 100))) < 12, 'superior inferior');
    // Red Blue LR on white: red from the left view, blue from the right one, no green
    const rb = await shot([['glasses3d', { view: 'redBlue' }]], { color: '#ffffff' });
    assert(rb(100, 100)[0] > 240 && rb(100, 100)[1] < 15 && rb(100, 100)[2] > 240, `ID rojo azul: ${rb(100, 100)}`);
    // Scene Convergence slides the views apart: the left view (red) from further left, the right one (blue) from
    // further right
    const cv = await shot([['glasses3d', { view: 'redBlue', convergence: 40 }]]);
    assert(cv(100, 100)[2] > cv(100, 100)[0] + 30, `convergencia: ${cv(100, 100)}`);
    // Difference of the view with itself shifted shows the shift
    const df = await shot([['glasses3d', { view: 'difference', convergence: 40 }]]);
    assert(g(df(100, 100)) > 30 && g(df(100, 100)) < 80, `diferencia: ${g(df(100, 100))}`);
    // Balanced: the ghost of the other eye taken out
    const rg = await shot([['glasses3d', { view: 'redGreen', convergence: 40 }]]), bl = await shot([['glasses3d', { view: 'balancedRedGreen', convergence: 40, balance: 30 }]]);
    assert(bl(100, 100)[0] < rg(100, 100)[0] - 10 && bl(100, 100)[1] > rg(100, 100)[1] + 10 && bl(100, 100)[2] < 10, `equilibrado: ${bl(100, 100)} frente a ${rg(100, 100)}`);
    // CC Blobbylize on a solid: the blurred edge falls under Cut Away (cut out), the middle stays
    const bz = await shot([['ccBlobbylize', {}]], { color: '#2040ff' });
    assert(red(bz(2, 2)) && !red(bz(100, 100)), 'CC Blobbylize: bordes recortados');
    const bz2 = await shot([['ccBlobbylize', { cutAway: 0, softness: 0, specular: 0, ambient: 100, diffuse: 0 }]], { color: '#2040ff' });
    assert(!red(bz2(2, 2)) && Math.abs(bz2(100, 100)[2] - 255) < 10, `CC Blobbylize: sin recorte (${bz2(100, 100)})`);
  });

  await test('ronda 5: Dar nueva forma y Alargar con las máscaras de la capa', async () => {
    await call('project_new', { path: P, width: 200, height: 200, fps: 10, overwrite: true });
    const base = await shot([]);
    const masks = [{ name: 'Origen', shape: 'rect', x: 40, y: 80, width: 40, height: 40 }, { name: 'Destino', shape: 'rect', x: 120, y: 80, width: 40, height: 40 }];
    // 0 % (the default) does nothing; 100 % carries the dark source square onto the destination on the right
    const r0 = await mshot([['reshape', { source: 'Origen', destination: 'Destino' }]], masks);
    assert(Math.abs(g(r0(140, 100)) - g(base(140, 100))) < 5, 'Dar nueva forma: 0 % no cambia');
    const r1 = await mshot([['reshape', { source: 'Origen', destination: 'Destino', percent: 100 }]], masks);
    assert(g(r1(140, 100)) < g(base(140, 100)) - 40 && Math.abs(g(r1(195, 5)) - g(base(195, 5))) < 12, `Dar nueva forma: 100 % (${g(r1(140, 100))} frente a ${g(base(140, 100))}; esquina ${g(r1(195, 5))} frente a ${g(base(195, 5))}; ${r1(195, 5)})`);
    // a boundary mask round the source only: nothing outside it moves
    const rb = await mshot([['reshape', { source: 'Origen', destination: 'Destino', boundary: 'Borde', percent: 100 }]], [...masks, { name: 'Borde', shape: 'rect', x: 10, y: 10, width: 95, height: 180 }]);
    assert(Math.abs(g(rb(140, 100)) - g(base(140, 100))) < 6, 'Dar nueva forma: fuera del contorno no se mueve');
    // Smear: the content of the circle dragged to Mask Offset (140, 100)
    const blob = [{ name: 'Mancha', shape: 'ellipse', x: 40, y: 80, width: 40, height: 40 }];
    const sm = await mshot([['smear', { source: 'Mancha', offset: [140, 100], percent: 100 }]], blob);
    assert(g(sm(140, 100)) < g(base(140, 100)) - 40, `Alargar: ${g(sm(140, 100))} frente a ${g(base(140, 100))}`);
    const s0 = await mshot([['smear', { source: 'Mancha', offset: [140, 100] }]], blob);
    assert(Math.abs(g(s0(140, 100)) - g(base(140, 100))) < 5, 'Alargar: 0 % no cambia');
  });

  await test('ronda 5: Reparación de obturación de desplazamiento (movimiento medido con flujo óptico entre fotogramas)', async () => {
    await call('project_new', { path: P, width: 200, height: 200, fps: 10, overwrite: true });
    // fractal noise sliding right 16 px per frame (Offset animated); frame 1 s with and without the repair
    const frame = async (rs, still = false) => {
      const name = `D${++n}`;
      await call('comp_new', { project: P, name, width: 200, height: 200, fps: 10, duration: 3, bg: '#ff0000' });
      const l = (await call('layer_add', { project: P, comp: name, type: 'solid', color: '#000000', width: 200, height: 200 })).layer.id;
      await call('effect_add', { project: P, comp: name, layer: l, effect: 'fractalNoise', values: { contrast: 200, scale: 40 } });
      const o = await call('effect_add', { project: P, comp: name, layer: l, effect: 'offset', values: {} });
      if (!still) await call('prop_set', { project: P, comp: name, layer: l, path: `effects.${o.effect.id}.shift`, keys: [{ t: 0, v: [100, 100] }, { t: 2, v: [420, 100] }] });
      if (rs) await call('effect_add', { project: P, comp: name, layer: l, effect: 'rollingShutter', values: rs });
      const r = await call('comp_frame', { project: P, comp: name, time: 1, width: 200 });
      assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`);
      const im = imgOf(r);
      await call('comp_delete', { project: P, comp: name });
      return (x, y) => im.at(x / 200, y / 200)[1];
    };
    // the horizontal shift s that best matches row y of A with row y of B moved by s (A(x) ≈ B(x − s))
    const shiftOf = (A, B, y) => {
      let best = 0, err = Infinity;
      for (let s = -12; s <= 12; s++) { let e = 0; for (let x = 30; x < 170; x += 2) e += Math.abs(A(x, y) - B(x - s, y)); if (e < err) { err = e; best = s; } }
      return best;
    };
    const C = await frame(null);
    // rate 100 %, top to bottom: the top row was read 0.45 frame early (7 px behind), the bottom one 0.45 late
    const O = await frame({ rate: 100 });
    const top = shiftOf(O, C, 10), mid = shiftOf(O, C, 100), bot = shiftOf(O, C, 190);
    assert(top >= 4 && top <= 10 && Math.abs(mid) <= 2 && bot <= -4 && bot >= -10, `deformar: arriba ${top}, centro ${mid}, abajo ${bot}`);
    // bottom to top: the other way round; Pixel Motion: the same as Warp for a uniform slide
    const R = await frame({ rate: 100, scan: 'bottomTop' });
    assert(shiftOf(R, C, 10) <= -4 && shiftOf(R, C, 190) >= 4, `de abajo arriba: ${shiftOf(R, C, 10)} / ${shiftOf(R, C, 190)}`);
    const PM = await frame({ rate: 100, method: 'pixelMotion' });
    assert(shiftOf(PM, C, 10) >= 3 && shiftOf(PM, C, 190) <= -3, `movimiento de píxeles: ${shiftOf(PM, C, 10)} / ${shiftOf(PM, C, 190)}`);
    // a still layer: nothing to repair
    const S0 = await frame(null, true), S1 = await frame({ rate: 100 }, true);
    let d = 0; for (let y = 10; y < 200; y += 30) for (let x = 10; x < 200; x += 30) d = Math.max(d, Math.abs(S0(x, y) - S1(x, y)));
    assert(d < 4, `capa quieta: ${d}`);
  });

  await test('distorsión: Card Wipe con «Cámara comp.» y CC Blobbylize con «Luces de AE» usan la cámara y las luces de la composición', async () => {
    const SP = W('escena-fx.cinta');
    await call('project_new', { path: SP });
    await call('comp_new', { project: SP, name: 'Esc', width: 320, height: 180, fps: 10, duration: 1, bg: '#000000' });
    const base = await call('layer_add', { project: SP, comp: 'Esc', type: 'solid', color: '#3366cc', width: 320, height: 180 });
    await call('effect_add', { project: SP, comp: 'Esc', layer: base.layer.id, effect: 'gradientRamp', values: { startColor: '#ff3300', endColor: '#00ccff' } });
    const cw = await call('effect_add', { project: SP, comp: 'Esc', layer: base.layer.id, effect: 'cardWipe', values: { completion: 0, cameraSystem: 'position' } });
    const img = async () => imgOf(await call('comp_frame', { project: SP, comp: 'Esc', time: 0.5, width: 320 }));
    const diff = (a, b) => { let d = 0, n = 0; for (let y = 0.05; y < 1; y += 0.05) for (let x = 0.05; x < 1; x += 0.05) { const p = a.at(x, y), q = b.at(x, y); d += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]); n++; } return d / n; };
    const pos = await img();
    await call('effect_set', { project: SP, comp: 'Esc', layer: base.layer.id, effect: cw.effect.id, values: { cameraSystem: 'comp' } });
    const noCam = await img();
    assert(diff(pos, noCam) < 2, `sin cámara en la comp, «Cámara comp.» = «Posición de la cámara» (${diff(pos, noCam).toFixed(1)})`);
    const cam = await call('layer_add', { project: SP, comp: 'Esc', type: 'camera', name: 'Cam' });
    const dflt = await img();
    assert(diff(pos, dflt) < 12, `la cámara por defecto ve la capa de frente (${diff(pos, dflt).toFixed(1)})`);
    await call('prop_set', { project: SP, comp: 'Esc', layer: cam.layer.id, path: 'position', value: [520, 90, -300] });
    const side = await img();
    assert(diff(pos, side) > 25, `la cámara movida a un lado cambia la perspectiva de las tarjetas (${diff(pos, side).toFixed(1)})`);
    await call('layer_delete', { project: SP, comp: 'Esc', layers: [cam.layer.id] });
    await call('effect_remove', { project: SP, comp: 'Esc', layer: base.layer.id, effect: cw.effect.id });
    // Blobbylize lit by a red light of the comp instead of its own white one
    const bl = await call('effect_add', { project: SP, comp: 'Esc', layer: base.layer.id, effect: 'ccBlobbylize', values: { using: 'effect' } });
    const meanG = (im) => { let g = 0, r = 0; for (let y = 0.1; y < 1; y += 0.1) for (let x = 0.1; x < 1; x += 0.1) { const p = im.at(x, y); r += p[0]; g += p[1]; } return g / (r + g + 1); };
    const own = await img();
    const L = await call('layer_add', { project: SP, comp: 'Esc', type: 'light', light_type: 'point', name: 'Roja' });
    await call('prop_set', { project: SP, comp: 'Esc', layer: L.layer.id, path: 'light.color', value: '#ff0000' });
    await call('prop_set', { project: SP, comp: 'Esc', layer: L.layer.id, path: 'position', value: [160, 90, -200] });
    const stillOwn = await img();
    assert(diff(own, stillOwn) < 2, 'con «Luz del efecto» la luz de la comp no cuenta');
    await call('effect_set', { project: SP, comp: 'Esc', layer: base.layer.id, effect: bl.effect.id, values: { using: 'ae' } });
    const ae = await img();
    assert(meanG(ae) < meanG(own) - 0.03, `con «Luces de AE» la luz roja de la comp tiñe la superficie (verde ${meanG(own).toFixed(3)} → ${meanG(ae).toFixed(3)})`);
  });
};
