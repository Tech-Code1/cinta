// MCP cases of «vectores»: shapes / masks from text cover the same pixels as the text, auto-trace of a circle gives a
// mask of its area, and a variable font axis changes the glyphs' width (rendered frames through comp_frame).
export default async ({ test, call, callErr, assert, imgOf, W }) => {
  const VP = W('vectores.cinta');
  const CW = 400, CH = 150;
  /** binary map of white pixels (red channel > 128) of a frame */
  const mask = async (comp, t = 0, w = CW, h = CH) => {
    const r = await call('comp_frame', { project: VP, comp, time: t, width: w });
    assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`);
    const im = imgOf(r);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = im.at((x + 0.5) / w, (y + 0.5) / h)[0] > 128 ? 1 : 0;
    return out;
  };
  const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; } return u ? i / u : 1; };
  const count = (a) => a.reduce((s, v) => s + v, 0);
  const span = (a, w = CW) => { let x0 = Infinity, x1 = -1; a.forEach((v, k) => { if (v) { const x = k % w; x0 = Math.min(x0, x); x1 = Math.max(x1, x); } }); return x1 - x0 + 1; };
  let n = 0;
  const textComp = async (text, o = {}) => {
    const comp = `V${++n}`;
    await call('comp_new', { project: VP, name: comp, width: CW, height: CH, fps: 10, duration: 1, bg: '#000000' });
    const l = (await call('layer_add', { project: VP, comp, type: 'text', text, size: o.size ?? 80, font: o.font ?? 'Arial', color: '#ffffff', position: [CW / 2, 100] })).layer.id;
    return { comp, l };
  };

  await test('vectores: proyecto propio', async () => { await call('project_new', { path: VP, width: 640, height: 360, fps: 10 }); });

  await test('vectores: text_to_shapes crea «… contornos» con un grupo por carácter que cubre los mismos píxeles que el texto', async () => {
    const { comp, l } = await textComp('Hola 8&g', { size: 80 });
    await call('prop_set', { project: VP, comp, layer: l, path: 'rotation', value: 8 });
    await call('prop_set', { project: VP, comp, layer: l, path: 'text.tracking', value: 60 });
    const before = await mask(comp);
    const r = await call('text_to_shapes', { project: VP, comp, layer: l });
    assert(r.layer.name.endsWith('contornos') && r.groups.map((g) => g.name).join('') === 'Hola8&g', JSON.stringify(r.groups));
    assert(r.groups.find((g) => g.name === '8').contours === 3 && r.groups.find((g) => g.name === 'o').contours === 2, 'contornos por carácter');
    const g = await call('comp_get', { project: VP, comp });
    assert(g.comp.layers[0].id === r.layer.id && g.comp.layers[1].hidden, 'texto oculto debajo');
    const after = await mask(comp);
    const k = iou(before, after);
    // (rotated, the canvas rasteriser draws text a hair bolder than the geometric outline: edge pixels only)
    assert(count(before) > 2000 && k > 0.9 && Math.abs(count(after) - count(before)) / count(before) < 0.08, `IoU ${k.toFixed(3)} (${count(before)} vs ${count(after)} px)`);
  });

  await test('vectores: text_to_shapes en modo masks: sólido con una máscara por contorno (contraformas restan), mismos píxeles', async () => {
    const { comp, l } = await textComp('Bo', { size: 100 });
    const before = await mask(comp);
    const r = await call('text_to_shapes', { project: VP, comp, layer: l, mode: 'masks' });
    assert(r.masks.length === 5 && r.masks.filter((m) => m.mode === 'subtract').length === 3, JSON.stringify(r.masks));
    const k = iou(before, await mask(comp));
    assert(k > 0.95, `IoU ${k.toFixed(3)}`);
  });

  await test('vectores: auto_trace de un círculo da una máscara de su área; área de trabajo con claves', async () => {
    const comp = `V${++n}`;
    await call('comp_new', { project: VP, name: comp, width: 200, height: 200, fps: 10, duration: 0.3, bg: '#000000' });
    const s = (await call('layer_add', { project: VP, comp, type: 'solid', color: '#ffffff', width: 200, height: 200 })).layer.id;
    await call('mask_add', { project: VP, comp, layer: s, shape: 'ellipse', x: 50, y: 50, width: 100, height: 100 });
    const r = await call('auto_trace', { project: VP, comp, layer: s, new_layer: true });
    assert(r.masks.length === 1 && r.masks[0].mode === 'add' && r.outlines.length === 1, JSON.stringify(r));
    const a = r.outlines[0].area, want = Math.PI * 50 * 50;
    assert(Math.abs(a - want) / want < 0.02, `área ${a} vs ${want.toFixed(0)}`);
    const g = await call('comp_get', { project: VP, comp });
    assert(g.comp.layers[0].name.startsWith('Trazado automático'), 'nueva capa encima');
    // the traced solid alone shows the same disc
    await call('layer_set', { project: VP, comp, layer: s, hidden: true });
    const px = await mask(comp, 0, 200, 200);
    assert(Math.abs(count(px) - want) / want < 0.03, `píxeles ${count(px)} vs ${want.toFixed(0)}`);
    const w = await call('auto_trace', { project: VP, comp, layer: s, work_area: true, corner_roundness: 0 });
    assert(w.frames === 3 && w.masks.length === 1, `fotogramas ${w.frames}`);
    await callErr('auto_trace', { project: VP, comp, layer: s, threshold: 100, invert: false, channel: 'red', min_area: 1e9 });
  });

  await test('vectores: text_font_axes lista los ejes de Bahnschrift y wdth estrecha el texto (animable)', async () => {
    const { comp, l } = await textComp('HHHH', { font: 'Bahnschrift', size: 70 });
    let r = await call('text_font_axes', { project: VP, comp, layer: l });
    assert(r.font?.variable && r.axes.map((a) => a.tag).join() === 'wght,wdth' && r.instances.length > 5, JSON.stringify(r).slice(0, 300));
    const w0 = span(await mask(comp));
    r = await call('text_font_axes', { project: VP, comp, layer: l, axes: { wdth: 75 } });
    assert(r.axes.find((a) => a.tag === 'wdth').value.v === 75, 'valor');
    const w1 = span(await mask(comp));
    assert(w1 < w0 * 0.75 && w1 > w0 * 0.5, `anchura ${w0} → ${w1}`);
    await call('prop_set', { project: VP, comp, layer: l, path: 'text.axes.wdth', keys: [{ t: 0, v: 75 }, { t: 0.8, v: 100 }] });
    const wm = span(await mask(comp, 0.4));
    assert(wm > w1 + 3 && wm < w0 - 3, `a mitad ${wm} (${w1}…${w0})`);
    // shapes from a variable-font text keep the axis width
    const s = await call('text_to_shapes', { project: VP, comp, layer: l, time: 0 });
    assert(s.groups.length === 4, 'grupos');
    const ws = span(await mask(comp, 0));
    assert(Math.abs(ws - w1) <= 3, `formas ${ws} vs texto ${w1}`);
    await callErr('text_font_axes', { project: VP, comp, layer: l, axes: { zzzz: 1 } });
  });
};
