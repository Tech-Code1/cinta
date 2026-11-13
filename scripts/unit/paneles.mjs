// Unit tests of the «paneles» line: keyboard shortcut combos, sets and conflicts; 3D views (orthographic and custom
// cameras, orbit / pan / dolly, wireframes); the flowchart graph; ffprobe metadata groups.
export default ({ test, ok, near, M, core }) => {
  test('atajos: combinaciones canónicas, etiquetas en español y teclas de un evento', () => {
    ok(M.normCombo('shift+ctrl+k') === 'Ctrl+Shift+K', M.normCombo('shift+ctrl+k'));
    ok(M.normCombo('Ctrl++') === 'Ctrl++' && M.normCombo('esc') === 'Escape', 'teclas especiales');
    ok(M.comboLabel('Ctrl+Shift+Delete') === 'Ctrl+Mayús+Supr' && M.comboLabel('Numpad0') === '0 (teclado numérico)', M.comboLabel('Ctrl+Shift+Delete'));
    ok(M.comboOf({ key: 'K', ctrlKey: true, shiftKey: true }) === 'Ctrl+Shift+K', 'Ctrl+Mayús+K');
    ok(M.comboOf({ key: '!', code: 'Digit1', shiftKey: true }) === 'Shift+1', 'Mayús+1 por la tecla física');
    ok(M.comboOf({ key: '[', ctrlKey: true, altKey: true, altGraph: true }) === '[', 'AltGr+[ es [');
    ok(M.comboOf({ key: '+', shiftKey: true }) === '+', '+ sin Mayús');
    ok(M.comboOf({ key: 'Control', ctrlKey: true }) === '', 'solo modificador');
  });
  test('atajos: conjunto predeterminado de After Effects y sin conflictos', () => {
    const map = M.resolveSet(undefined);
    ok(map['easy-ease'][0] === 'F9' && map['tool-orbit'][0] === '1' && map['view-front'][0] === 'F10' && map['view-custom1'][0] === 'F11' && map['view-active'][0] === 'F12', 'F9, 1, F10-F12');
    ok(map['shortcuts'][0] === "Ctrl+Alt+'", map['shortcuts'][0]);
    const conf = M.conflicts(map);
    ok(conf.length === 0, JSON.stringify(conf));
    ok(new Set(M.ADV_SHORTCUTS.map((c) => c.id)).size === M.ADV_SHORTCUTS.length, 'ids únicos');
  });
  test('atajos: reasignar quita la tecla del otro comando; diff y espacio reservado', () => {
    const map = M.resolveSet(undefined);
    const r = M.assignKey(map, 'reveal-animated', 'P');
    ok(r.removedFrom.join() === 'reveal-position' && map['reveal-position'].length === 0 && map['reveal-animated'].includes('P'), JSON.stringify(r));
    const d = M.diffSet(map);
    ok(Object.keys(d).sort().join() === 'reveal-animated,reveal-position', JSON.stringify(d));
    const back = M.resolveSet(d);
    ok(back['reveal-animated'].join() === 'U,P' && back['easy-ease'][0] === 'F9', JSON.stringify(back['reveal-animated']));
    ok(M.assignKey(map, 'undo', 'Space').error && map.play.includes('Space'), 'Espacio reservado');
    ok(M.removeKey(map, 'play', 'Space'), 'no se quita a Reproducir');
    ok(/Deshacer\tCtrl\+Z/.test(M.shortcutsText(map)), 'texto');
  });

  const comp = M.newComp({ width: 1920, height: 1080, duration: 5 });
  const cam = M.newLayer('camera', comp); comp.layers.push(cam);
  const light = M.newLayer('light', comp); comp.layers.push(light);
  const card = M.newLayer('solid', comp, { w: 400, h: 400 }); card.threeD = true; comp.layers.push(card);
  test('vistas 3D: frontal ortogonal sin perspectiva; superior pone la cámara abajo', () => {
    const s = M.defaultViewState(comp, 'front', 0);
    ok(s.scale > 0.05 && s.scale <= 1, `escala ${s.scale}`);
    const { view, zoom } = M.viewProjection(comp, 'front', s, 0);
    const pr = (p) => { const q = M.apply(view, ...p); return M.project(1920, 1080, zoom, q); };
    // two points at the same x/y and very different depth land on the same pixel (orthographic)
    const a = pr([1160, 540, 0]), b = pr([1160, 540, 800]);
    ok(near(a[0], b[0], 2) && near(a[1], b[1], 0.6), `casi sin perspectiva (cámara a 90 000 px): ${a} ${b}`);
    ok(near(a[0] - 960, 200 * s.scale, 0.6), `escala ${a[0] - 960} vs ${200 * s.scale}`);
    const top = M.viewProjection(comp, 'top', M.defaultViewState(comp, 'top', 0), 0);
    const camPos = M.project(1920, 1080, top.zoom, M.apply(top.view, ...cam.transform.position.v));
    ok(camPos[1] > 540, `en la vista superior la cámara (z negativa) queda abajo: ${camPos}`);
    const left = M.viewProjection(comp, 'left', M.defaultViewState(comp, 'left', 0), 0);
    const lp = M.project(1920, 1080, left.zoom, M.apply(left.view, ...cam.transform.position.v));
    ok(Math.abs(lp[0] - 960) > 50 && near(lp[1], 540, 1), `izquierda: ${lp}`);
  });
  test('vistas 3D: viewComp oculta las cámaras y añade la de la vista; la cámara activa no cambia nada', () => {
    ok(M.viewComp(comp, 'active') === comp, 'activa');
    const v = M.viewComp(comp, 'custom1', undefined, 0);
    ok(v.layers[0].type === 'camera' && v.layers[0].id === '__vista3d' && v.layers.find((l) => l.id === cam.id).hidden, 'cámara sintética');
    ok(comp.layers.length === 3 && !cam.hidden, 'el original intacto');
  });
  test('vistas 3D: orbitar / panorámica / dolly de la vista y de una capa de cámara', () => {
    const s = M.defaultViewState(comp, 'custom2', 0);
    const o = M.moveView(comp, 'custom2', s, 'orbit', 100, 0, 0);
    ok(near(o.yaw - s.yaw, 40) && o.pitch === s.pitch, `${o.yaw}`);
    ok(M.moveView(comp, 'front', M.defaultViewState(comp, 'front'), 'orbit', 100, 0).yaw === 0, 'las ortogonales no orbitan');
    const d = M.moveView(comp, 'custom2', s, 'dolly', 0, -100, 0);
    ok(d.dist < s.dist, 'dolly acerca');
    const fs = M.defaultViewState(comp, 'front');
    const p = M.moveView(comp, 'front', fs, 'pan', 50, 0, 0);
    ok(near(p.target[0], fs.target[0] - 50 / fs.scale, 1e-6), `pan ${p.target}`);
    const c = M.cameraAt(comp, 0);
    const pos = cam.transform.position.v, poi = cam.camera.poi.v;
    const r = M.moveCamera(pos, poi, c.view, c.zoom, 'orbit', 90 / 0.4, 0);
    const d0 = Math.hypot(pos[0] - poi[0], pos[1] - poi[1], pos[2] - poi[2]), d1 = Math.hypot(r.pos[0] - poi[0], r.pos[1] - poi[1], r.pos[2] - poi[2]);
    ok(near(d0, d1, 1e-6) && Math.abs(r.pos[0] - poi[0]) > d0 * 0.99, `órbita 90°: ${r.pos}`);
    const pan = M.moveCamera(pos, poi, c.view, c.zoom, 'pan', 10, 0);
    ok(near(pan.pos[0] - pos[0], pan.poi[0] - poi[0], 1e-9) && pan.pos[0] < pos[0], 'pan mueve ambos');
    const dl = M.moveCamera(pos, poi, c.view, c.zoom, 'dolly', 100, 0);
    ok(Math.hypot(dl.pos[0] - poi[0], dl.pos[1] - poi[1], dl.pos[2] - poi[2]) < d0, 'dolly acerca');
  });
  test('vistas 3D: malla de cámaras y luces fuera de la cámara activa', () => {
    const w = M.wireframes(comp, 'top', M.defaultViewState(comp, 'top'), 0);
    ok(w.lines.filter((l) => l.layer === cam.id).length >= 20 && w.lines.some((l) => l.layer === light.id), `${w.lines.length} segmentos`);
    ok(w.labels.map((l) => l.text).join() === 'Cámara 1,Luz 1', w.labels.map((l) => l.text).join());
  });

  test('diagrama de flujo: metraje → capa → comp, comp anidada y opciones', () => {
    const p = { media: [{ id: 'm1', path: 'C:/v/clip.mp4', kind: 'video' }], comps: [] };
    const inner = M.newComp({ name: 'Interior' });
    const outer = M.newComp({ name: 'Exterior' });
    inner.layers.push(M.newLayer('video', inner, { mediaId: 'm1', name: 'clip' }));
    outer.layers.push(M.newLayer('comp', outer, { compId: inner.id, name: 'Interior' }), M.newLayer('solid', outer, { name: 'Fondo' }));
    p.comps = [outer, inner];
    const g = M.flowGraph(p);
    const has = (a, b) => g.edges.some((e) => e.from.startsWith(a) && e.to.startsWith(b));
    ok(has('m:m1', `l:${inner.id}`) && has(`l:${inner.id}`, `c:${inner.id}`) && has(`c:${inner.id}`, `l:${outer.id}`), JSON.stringify(g.edges));
    const x = (id) => g.nodes.find((n) => n.id.startsWith(id)).x;
    ok(x('m:') < x(`c:${inner.id}`) && x(`c:${inner.id}`) < x(`c:${outer.id}`), 'de izquierda a derecha');
    const noL = M.flowGraph(p, { layers: false });
    ok(noL.nodes.every((n) => n.kind !== 'layer') && noL.edges.some((e) => e.from === `c:${inner.id}` && e.to === `c:${outer.id}`), 'sin capas');
    ok(M.flowGraph(p, { root: inner.id }).nodes.every((n) => !n.id.includes(outer.id)), 'solo la comp y lo que usa');
    ok(M.flowGraph(p, { solids: true }).nodes.some((n) => n.kind === 'solid'), 'sólidos');
    const rl = M.flowGraph(p, { dir: 'RL' });
    ok(rl.nodes.find((n) => n.id.startsWith('m:')).x > rl.nodes.find((n) => n.id === `c:${outer.id}`).x, 'derecha a izquierda');
  });

  test('metadatos: grupos de ffprobe con nombres en español', () => {
    const g = core.metadataGroups({
      format: { format_long_name: 'QuickTime / MOV', duration: '61.5', bit_rate: '8000000', nb_streams: 2, tags: { title: 'Prueba', creation_time: '2024-01-01' } },
      streams: [{ codec_type: 'video', codec_name: 'h264', codec_long_name: 'H.264', width: 1920, height: 1080, avg_frame_rate: '30000/1001', pix_fmt: 'yuv420p', color_range: 'tv' },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, channel_layout: 'stereo' }],
      chapters: [{ start_time: '0', tags: { title: 'Intro' } }],
    }, { path: 'C:/v/a.mov', size: 2048, mtime: 0 });
    const names = g.map((x) => x.name).join();
    ok(names === 'Archivo,Formato,Vídeo 1,Audio 1,Capítulos', names);
    const row = (gr, k) => g.find((x) => x.name === gr).rows.find((r) => r[0] === k)?.[1];
    ok(row('Formato', 'Duración') === '1:01.500' && row('Formato', 'Título') === 'Prueba' && row('Formato', 'Velocidad de bits') === '8.00 Mbps', JSON.stringify(g[1]));
    ok(row('Vídeo 1', 'Dimensiones') === '1920 × 1080' && row('Vídeo 1', 'Velocidad de fotogramas') === '29.97 fps' && row('Vídeo 1', 'Rango') === 'Limitado (tv)', JSON.stringify(g[2]));
    ok(row('Audio 1', 'Disposición de canales') === 'stereo' && /48/.test(row('Audio 1', 'Frecuencia de muestreo')), JSON.stringify(g[3]));
    ok(core.entryKind('x.MP4') === 'video' && core.entryKind('a.glb') === 'model' && core.entryKind('z.txt') === 'other', 'tipos');
  });
};
