// Unit tests of «capas»: Responsive Design – Time maps (protected regions keep their speed), retiming on a duration
// change, the crops (work area, region of interest), guide layers, RotoBezier tangents, feather radii and contours,
// Wiggle Transform and the operations with undo.
export default ({ test, ok, near, M, core }) => {
  const sq = (x, y, s) => [x, y, 0, 0, 0, 0, x + s, y, 0, 0, 0, 0, x + s, y + s, 0, 0, 0, 0, x, y + s, 0, 0, 0, 0];

  test('zonas protegidas: intro y outro conservan su velocidad al estirar 200 %; el centro se estira el resto', () => {
    const reg = [[0, 2], [8, 10]];
    const inv = (u) => M.protectedInverse(reg, 10, 20, u);
    ok(near(inv(1), 1) && near(inv(2), 2), `intro ${inv(1)} ${inv(2)}`);
    ok(near(inv(18), 8) && near(inv(19), 9) && near(inv(20), 10), `outro ${inv(18)} ${inv(19)}`);
    // the middle (6 s) fills 16 s: k = 16 / 6
    ok(near(inv(10), 2 + 8 / (16 / 6)), `centro ${inv(10)}`);
    for (const t of [0.5, 3, 7.7, 9.2]) ok(near(M.protectedInverse(reg, 10, 20, M.protectedForward(reg, 10, 20, t)), t), `ida y vuelta ${t}`);
    // shorter than the protected time: the unprotected part collapses
    ok(near(M.protectedForward(reg, 10, 3, 5), 2), `colapso ${M.protectedForward(reg, 10, 3, 5)}`);
  });

  test('zonas protegidas: capa de composición anidada estirada (layerSourceTime) y sin estirar igual que siempre', () => {
    const sub = M.newComp({ duration: 4, fps: 10 });
    sub.markers.push({ t: 0, name: 'Intro', dur: 1, protected: true });
    const top = M.newComp({ duration: 10, fps: 10 });
    const l = M.newLayer('comp', top, { compId: sub.id, start: 1, stretch: 2 });
    const comps = [sub, top];
    ok(near(M.layerSourceTime(comps, l, 1.5), 0.5) && near(M.layerSourceTime(comps, l, 2), 1), 'intro a velocidad normal');
    // the remaining 3 s of the sub comp fill 7 s
    ok(near(M.layerSourceTime(comps, l, 9), 4), `final ${M.layerSourceTime(comps, l, 9)}`);
    ok(near(M.layerSourceTime(comps, l, 5.5), 1 + 3.5 * (3 / 7)), `centro ${M.layerSourceTime(comps, l, 5.5)}`);
    l.stretch = 1;
    ok(near(M.layerSourceTime(comps, l, 3.3), 2.3), 'sin estirar');
    sub.markers[0].protected = false; l.stretch = 2;
    ok(near(M.layerSourceTime(comps, l, 3), 1), 'sin zonas protegidas: estiramiento normal');
  });

  test('cambiar la duración con zonas protegidas: claves, capas, marcadores y área de trabajo se ajustan alrededor', () => {
    const e = new core.Editor();
    const c = M.motionOps.compNew(e, { duration: 10, fps: 10 });
    const t = M.motionOps.layerAdd(e, c.id, 'text', { text: 'A' });
    M.motionOps.propSet(e, c.id, t.id, 'opacity', { keys: [{ t: 1, v: 0 }, { t: 5, v: 50 }, { t: 9, v: 100 }] });
    M.motionOps.responsiveTime(e, c.id, 'intro', 2);
    M.motionOps.responsiveTime(e, c.id, 'outro', 8);
    M.motionOps.compSet(e, c.id, { duration: 16 });
    const cc = e.project.comps[0], l = cc.layers[0], k = l.transform.opacity.k.map((x) => x.t);
    ok(near(k[0], 1) && near(k[2], 15) && near(k[1], 2 + 3 * 2), `claves ${k}`);
    ok(near(l.in, 0) && near(l.out, 16), `capa ${l.in}–${l.out}`);
    ok(cc.markers.map((m) => `${m.name}:${m.t}+${m.dur}`).join() === 'Intro:0+2,Outro:14+2', JSON.stringify(cc.markers));
    ok(near(cc.workArea[1], 16), `área ${cc.workArea}`);
    e.undo();
    ok(e.project.comps[0].duration === 10 && e.project.comps[0].layers[0].transform.opacity.k[1].t === 5, 'deshacer');
    // errors like After Effects: an intro needs the time indicator after the start
    let threw = false; try { M.motionOps.responsiveTime(e, c.id, 'intro', 0); } catch { threw = true; }
    ok(threw, 'intro vacía');
  });

  test('marcadores: añadir, zona protegida hasta el siguiente, «Habilitar zona protegida» en todos', () => {
    const e = new core.Editor();
    const c = M.motionOps.compNew(e, { duration: 6, fps: 10 });
    M.motionOps.markerAdd(e, c.id, { t: 4, name: 'b' });
    const r = M.motionOps.markerAdd(e, c.id, { t: 1, name: 'a' });
    ok(r.index === 0 && e.project.comps[0].markers.map((m) => m.name).join() === 'a,b', 'en orden');
    M.motionOps.markerSet(e, c.id, 0, { protected: true });
    ok(e.project.comps[0].markers[0].dur === 3 && e.project.comps[0].markers[0].protected, 'hasta el siguiente');
    M.motionOps.responsiveTime(e, c.id, 'markers');
    const ms = e.project.comps[0].markers;
    ok(ms[1].protected && near(ms[1].dur, 2), JSON.stringify(ms));
    ok(M.protectedRegions(e.project.comps[0]).map((x) => x.join('-')).join() === '1-6', JSON.stringify(M.protectedRegions(e.project.comps[0])));
    M.motionOps.markerSet(e, c.id, 1, { remove: true });
    ok(e.project.comps[0].markers.length === 1, 'eliminar');
  });

  test('separar comp. del entorno de trabajo: duración, capas, claves y marcadores', () => {
    const e = new core.Editor();
    const c = M.motionOps.compNew(e, { duration: 10, fps: 10 });
    const s = M.motionOps.layerAdd(e, c.id, 'solid', { color: '#ff0000' });
    M.motionOps.propSet(e, c.id, s.id, 'rotation', { keys: [{ t: 3, v: 0 }, { t: 6, v: 90 }] });
    M.motionOps.markerAdd(e, c.id, { t: 5, name: 'm' });
    M.motionOps.compSet(e, c.id, { workArea: [2, 7] });
    M.motionOps.compCropWorkArea(e, c.id);
    const cc = e.project.comps[0], l = cc.layers[0];
    ok(cc.duration === 5 && cc.workArea.join() === '0,5', `comp ${cc.duration} ${cc.workArea}`);
    ok(l.in === 0 && l.out === 5 && l.start === -2 && l.transform.rotation.k.map((k) => k.t).join() === '1,4', `capa ${l.in} ${l.out} ${l.start} ${l.transform.rotation.k.map((k) => k.t)}`);
    ok(cc.markers[0].t === 3, 'marcador');
  });

  test('región de interés y recortar comp. según ella: tamaño y posiciones (también separadas y claves)', () => {
    const e = new core.Editor();
    const c = M.motionOps.compNew(e, { width: 1000, height: 500 });
    const a = M.motionOps.layerAdd(e, c.id, 'solid', { color: '#ff0000', width: 100, height: 100 });
    const b = M.motionOps.layerAdd(e, c.id, 'null');
    M.motionOps.propSet(e, c.id, a.id, 'position', { keys: [{ t: 0, v: [300, 200] }, { t: 1, v: [500, 300] }] });
    M.motionOps.layerSet(e, c.id, b.id, { parent: a.id });
    const roi = M.motionOps.compRoi(e, c.id, { rect: [250, 150, 400, 200] });
    ok(roi.on && roi.rect.join() === '250,150,400,200', JSON.stringify(roi));
    // a rect outside the comp is refused; null resets
    let threw = false; try { M.motionOps.compRoi(e, c.id, { rect: [2000, 0, 10, 10] }); } catch { threw = true; }
    ok(threw, 'fuera de la comp');
    M.motionOps.compCropRoi(e, c.id);
    const cc = e.project.comps[0], la = cc.layers.find((l) => l.id === a.id), lb = cc.layers.find((l) => l.id === b.id);
    ok(cc.width === 400 && cc.height === 200 && !cc.roi, `tamaño ${cc.width}×${cc.height}`);
    ok(la.transform.position.k.map((k) => k.v.slice(0, 2).join(':')).join() === '50:50,250:150', JSON.stringify(la.transform.position.k));
    ok(lb.transform.position.v[0] === 500, 'la capa emparentada no se mueve (su primario sí)');
    e.undo(); e.undo();
    ok(e.project.comps[0].width === 1000 && !e.project.comps[0].roi, 'deshacer');
  });

  test('capa de guía: alterna y aparece en el resumen', () => {
    const e = new core.Editor();
    const c = M.motionOps.compNew(e, { duration: 2 });
    const t = M.motionOps.layerAdd(e, c.id, 'text', { text: 'guía' });
    const s = M.motionOps.layerAdd(e, c.id, 'solid', { color: '#00ff00' });
    ok(M.motionOps.layerGuide(e, c.id, [t.id]) === true && e.project.comps[0].layers.find((l) => l.id === t.id).guide, 'activada');
    const sum = M.compSummary(e.project, e.project.comps[0]);
    ok(sum.layers.find((l) => l.id === t.id).guide === true && !sum.layers.find((l) => l.id === s.id).guide, 'resumen');
    ok(M.motionOps.layerGuide(e, c.id, [t.id]) === false && !e.project.comps[0].layers.find((l) => l.id === t.id).guide, 'desactivada');
  });

  test('RotoBézier: tangentes de Catmull-Rom a 33 %, esquina a 100 %, la curva pasa por los vértices', () => {
    const flat = sq(0, 0, 100);
    const r = M.rotoFlat({ rotoBezier: true }, flat);
    // vertex (100, 0): neighbours (0, 0) and (100, 100) → tangent (100, 100) × (1 − 0.3333) / 4
    ok(near(r[10], 100 * 0.6667 / 4, 0.01) && near(r[11], 100 * 0.6667 / 4, 0.01) && near(r[8], -r[10]), `tangentes ${r.slice(6, 12)}`);
    ok(r[6] === 100 && r[7] === 0, 'vértice intacto');
    const corner = M.rotoFlat({ rotoBezier: true, tension: [100, 100, 100, 100] }, flat);
    ok(corner.every((v, i) => i % 6 < 2 || v === 0), 'esquinas');
    ok(M.rotoFlat({}, flat) === flat, 'sin RotoBézier no cambia');
    const e = new core.Editor();
    const c = M.motionOps.compNew(e, {});
    const so = M.motionOps.layerAdd(e, c.id, 'solid', { color: '#ffffff', width: 200, height: 200 });
    const m = M.motionOps.maskAdd(e, c.id, so.id, { shape: 'rect', x: 10, y: 10, width: 100, height: 100 });
    ok(M.motionOps.maskRoto(e, c.id, so.id, 'all') === true && e.project.comps[0].layers[0].masks[0].rotoBezier, 'activado');
    M.motionOps.maskRoto(e, c.id, so.id, [m.id], true, 80);
    ok(e.project.comps[0].layers[0].masks[0].tension.join() === '80,80,80,80', 'tensión');
  });

  test('calado variable: radios entre puntos (tensión), un punto = radio uniforme, contornos hacia fuera / dentro', () => {
    const flat = sq(0, 0, 100);
    const { pts, length, area } = M.sampleMask(flat, 24);
    ok(near(length, 400, 0.5) && near(Math.abs(area), 10000, 1), `perímetro ${length} área ${area}`);
    const one = M.featherRadii(pts, length, [{ seg: 0, u: 0.5, r: 20, tension: 0 }]);
    ok(one.every((r) => r === 20), 'uniforme');
    const two = M.featherRadii(pts, length, [{ seg: 0, u: 0.5, r: 30, tension: 0 }, { seg: 2, u: 0.5, r: 0, tension: 0 }]);
    const at = (seg, u) => two[pts.findIndex((p) => p.seg === seg && Math.abs(p.u - u) < 1e-9)];
    ok(near(at(0, 0.5), 30) && near(at(2, 0.5), 0) && at(1, 0.5) > 5 && at(1, 0.5) < 25, `radios ${at(0, 0.5)} ${at(1, 0.5)} ${at(2, 0.5)}`);
    const held = M.featherRadii(pts, length, [{ seg: 0, u: 0.5, r: 30, tension: 100 }, { seg: 2, u: 0.5, r: 0, tension: 0 }]);
    ok(held[pts.findIndex((p) => p.seg === 1 && p.u === 0)] > two[pts.findIndex((p) => p.seg === 1 && p.u === 0)] + 3, 'la tensión sostiene el radio');
    // outward 20 px: the alpha-0 contour is 20 px out, alpha 1 on the edge; inward: the other way round
    const out0 = M.featherContour(pts, one, area, 0), out1 = M.featherContour(pts, one, area, 1);
    const i = pts.findIndex((p) => p.seg === 0 && near(p.u, 0.5));
    ok(near(out0[i * 2 + 1], -20, 0.01) && near(out1[i * 2 + 1], 0, 0.01), `fuera ${out0[i * 2 + 1]} ${out1[i * 2 + 1]}`);
    const inw = M.featherContour(pts, one.map(() => -20), area, 1);
    ok(near(inw[i * 2 + 1], 20, 0.01), `dentro ${inw[i * 2 + 1]}`);
    const n = M.nearestOnMask(flat, 50, -7);
    ok(n.seg === 0 && near(n.u, 0.5, 0.01) && near(n.d, 7, 0.01), JSON.stringify(n));
    const pt = M.maskPointAt(flat, 0, 0.5);
    ok(near(pt.nx, 0) && near(pt.ny, -1), `normal hacia fuera ${pt.nx} ${pt.ny}`);
    const e = new core.Editor();
    const c = M.motionOps.compNew(e, {});
    const so = M.motionOps.layerAdd(e, c.id, 'solid', { color: '#ffffff', width: 200, height: 200 });
    const m = M.motionOps.maskAdd(e, c.id, so.id, { shape: 'rect', x: 10, y: 10, width: 100, height: 100 });
    M.motionOps.maskFeather(e, c.id, so.id, m.id, { add: { seg: 2, u: 0.5, r: 10 } });
    M.motionOps.maskFeather(e, c.id, so.id, m.id, { add: { seg: 0, u: 0.25, r: -5, tension: 40 } });
    let fp = e.project.comps[0].layers[0].masks[0].featherPts;
    ok(fp.length === 2 && fp[0].seg === 0 && fp[0].tension === 40, JSON.stringify(fp));
    M.motionOps.maskFeather(e, c.id, so.id, m.id, { set: { index: 1, r: 25 } });
    M.motionOps.maskFeather(e, c.id, so.id, m.id, { remove: 0 });
    fp = e.project.comps[0].layers[0].masks[0].featherPts;
    ok(fp.length === 1 && fp[0].r === 25, JSON.stringify(fp));
    M.motionOps.maskFeather(e, c.id, so.id, m.id, { points: null });
    ok(!e.project.comps[0].layers[0].masks[0].featherPts, 'quitar todos');
  });

  test('transformación de ondulación: valores de After Effects, amplitud acotada, correlación 100 % = copias iguales', () => {
    const e = new core.Editor();
    const c = M.motionOps.compNew(e, { duration: 4 });
    const l = M.motionOps.layerAdd(e, c.id, 'shape');
    const s = M.motionOps.shapeAdd(e, c.id, l.id, { kind: 'rect' }).shape;
    const w = M.motionOps.shapeWiggleTransform(e, c.id, l.id, s.id, {});
    ok(w.speed.v === 2 && w.correlation.v === 50 && w.seed === 0 && w.position.v.join() === '0,0' && w.scale.v.join() === '0,0' && w.rotation.v === 0, JSON.stringify(w));
    M.motionOps.shapeWiggleTransform(e, c.id, l.id, s.id, { position: [40, 10], rotation: 30, scale: [20, 20] });
    const cc = e.project.comps[0], ll = cc.layers[0], ss = ll.shapes[0];
    let maxX = 0, moved = false;
    for (let t = 0; t < 4; t += 0.05) {
      const o = M.wiggleTransformAt(cc, ll, ss, t, 0);
      maxX = Math.max(maxX, Math.abs(o.position[0]));
      if (Math.abs(o.position[0]) > 5) moved = true;
      ok(Math.abs(o.position[1]) <= 10 + 1e-9 && Math.abs(o.rotation) <= 30 + 1e-9 && o.scale[0] === o.scale[1], `t ${t}`);
    }
    ok(moved && maxX <= 40 + 1e-9, `amplitud ${maxX}`);
    const a = M.wiggleTransformAt(cc, ll, ss, 1.3, 0), b = M.wiggleTransformAt(cc, ll, ss, 1.3, 3);
    ok(a.position[0] !== b.position[0], 'copias distintas a 50 %');
    ss.wiggleTransform.correlation.v = 100;
    const a2 = M.wiggleTransformAt(cc, ll, ss, 1.3, 0), b2 = M.wiggleTransformAt(cc, ll, ss, 1.3, 3);
    ok(near(a2.position[0], b2.position[0]), 'correlación 100 %');
    // keyframable like any property
    M.motionOps.propSet(e, c.id, l.id, `shapes.${s.id}.wiggleTransform.speed`, { keys: [{ t: 0, v: 1 }, { t: 1, v: 5 }] });
    ok(e.project.comps[0].layers[0].shapes[0].wiggleTransform.speed.k.length === 2, 'clave');
    ok(M.compSummary(e.project, e.project.comps[0]).layers[0].shapes[0].wiggleTransform === true, 'resumen');
    M.motionOps.shapeWiggleTransform(e, c.id, l.id, s.id, { remove: true });
    ok(!e.project.comps[0].layers[0].shapes[0].wiggleTransform, 'quitar');
  });
};
