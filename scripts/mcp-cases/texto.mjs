// MCP cases of «texto»: text_format (Faux bold / italic, small caps, superscript on a range, vertical text,
// justified paragraph text with hyphenation), checked on frames rendered through comp_frame, and text animators
// still working per character on styled text.
export default async ({ test, call, callErr, assert, imgOf, W }) => {
  const TP = W('texto.cinta');
  const CW = 400, CH = 300;
  const mask = async (comp, t = 0) => {
    const r = await call('comp_frame', { project: TP, comp, time: t, width: CW });
    assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`);
    const im = imgOf(r), out = new Uint8Array(CW * CH);
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) out[y * CW + x] = im.at((x + 0.5) / CW, (y + 0.5) / CH)[0] > 128 ? 1 : 0;
    return out;
  };
  const count = (a) => a.reduce((s, v) => s + v, 0);
  const bbox = (a, x0 = 0, x1 = CW) => { let X0 = Infinity, X1 = -1, Y0 = Infinity, Y1 = -1; a.forEach((v, k) => { const x = k % CW, y = (k / CW) | 0; if (v && x >= x0 && x < x1) { X0 = Math.min(X0, x); X1 = Math.max(X1, x); Y0 = Math.min(Y0, y); Y1 = Math.max(Y1, y); } }); return { x0: X0, x1: X1, y0: Y0, y1: Y1, w: X1 - X0 + 1, h: Y1 - Y0 + 1 }; };
  let n = 0;
  const textComp = async (text, o = {}) => {
    const comp = `T${++n}`;
    await call('comp_new', { project: TP, name: comp, width: CW, height: CH, fps: 10, duration: 1, bg: '#000000' });
    const l = (await call('layer_add', { project: TP, comp, type: 'text', text, size: o.size ?? 60, font: 'Arial', color: '#ffffff', position: [CW / 2, CH / 2] })).layer.id;
    return { comp, l };
  };

  await test('texto: proyecto propio', async () => { await call('project_new', { path: TP, width: 640, height: 360, fps: 10 }); });

  await test('texto: Faux negrita engorda los glifos, Faux cursiva los inclina; se quitan con null', async () => {
    const { comp, l } = await textComp('Hola');
    const a = await mask(comp);
    const r = await call('text_format', { project: TP, comp, layer: l, character: { faux_bold: true } });
    assert(r.character.fauxBold === true, JSON.stringify(r.character));
    const b = await mask(comp);
    assert(count(b) > count(a) * 1.12, `negrita ${count(a)} → ${count(b)}`);
    await call('text_format', { project: TP, comp, layer: l, character: { faux_bold: null, faux_italic: true } });
    const c = await mask(comp);
    let xor = 0; a.forEach((v, k) => { xor += v ^ c[k]; });
    assert(Math.abs(count(c) - count(a)) / count(a) < 0.08 && xor > count(a) * 0.2, `cursiva: ${count(a)} vs ${count(c)}, distintos ${xor}`);
  });

  await test('texto: Superíndice en un intervalo sube y achica solo esos caracteres; Versalitas con un animador por carácter', async () => {
    const { comp, l } = await textComp('x2');
    const a = await mask(comp);
    const r = await call('text_format', { project: TP, comp, layer: l, range: [1, 2], character: { script: 'super' } });
    assert(r.runs.length === 1 && r.runs[0].s === 1 && r.runs[0].style.script === 'super', JSON.stringify(r.runs));
    const b = await mask(comp);
    const ba = bbox(a), bb0 = bbox(b);
    const da = bbox(a, ba.x1 - ba.w * 0.2, CW), db = bbox(b, bb0.x1 - bb0.w * 0.2, CW);
    assert(db.y1 < da.y1 - 15 && db.y0 <= da.y0 && db.h < da.h * 0.7, `el 2: base ${da.y1} → ${db.y1}, arriba ${da.y0} → ${db.y0}, alto ${da.h} → ${db.h}`);
    const s = await textComp('abcd');
    await call('text_format', { project: TP, comp: s.comp, layer: s.l, character: { small_caps: true } });
    await call('text_animator_add', { project: TP, comp: s.comp, layer: s.l, props: { opacity: 0 }, selector: { start: 0, end: 50 } });
    const m = await mask(s.comp), bb = bbox(m);
    assert(count(m) > 300 && bb.x0 > CW / 2 - 15, `solo la mitad derecha visible: ${JSON.stringify(bb)}`);
  });

  await test('texto: orientación vertical: el texto se apila en columna (más alto que ancho) y se vuelve horizontal', async () => {
    const { comp, l } = await textComp('ABCD', { size: 50 });
    const h0 = bbox(await mask(comp));
    const r = await call('text_format', { project: TP, comp, layer: l, orientation: 'vertical' });
    assert(r.orientation === 'vertical', r.orientation);
    const v = bbox(await mask(comp));
    assert(h0.w > h0.h * 2 && v.h > v.w * 2, `horizontal ${h0.w}×${h0.h}, vertical ${v.w}×${v.h}`);
    await call('text_format', { project: TP, comp, layer: l, orientation: 'horizontal' });
    const h1 = bbox(await mask(comp));
    assert(Math.abs(h1.w - h0.w) <= 1 && Math.abs(h1.h - h0.h) <= 1, 'vuelve igual');
  });

  await test('texto: párrafo justificado llega a los dos bordes de la caja; separación automática y composición multilínea', async () => {
    const { comp, l } = await textComp('uno dos tres cuatro cinco seis siete ocho nueve diez once doce', { size: 30 });
    await call('layer_set', { project: TP, comp, layer: l, text_style: { box: [300, 200] } });
    await call('text_format', { project: TP, comp, layer: l, paragraph: { align: 'left' } });
    const a = await mask(comp);
    const r = await call('text_format', { project: TP, comp, layer: l, paragraph: { justify: 'left', hyphenate: true, composer: 'every', indent_left: 10 } });
    assert(r.paragraph.justify === 'left' && r.paragraph.hyphenate && r.paragraph.composer === 'every' && r.paragraph.indent_left === 10, JSON.stringify(r.paragraph));
    const b = await mask(comp);
    // the first line's band: from the box's left edge + indent to its right edge
    const row = (m) => { const bb = bbox(m); const out = new Uint8Array(CW * CH); for (let y = bb.y0; y < bb.y0 + 20; y++) for (let x = 0; x < CW; x++) out[y * CW + x] = m[y * CW + x]; return bbox(out); };
    const ra = row(a), rb = row(b);
    assert(rb.x1 >= 345 && rb.x0 >= 58 && rb.x0 <= 66 && ra.x1 < rb.x1, `primera línea ${ra.x0}-${ra.x1} → ${rb.x0}-${rb.x1}`);
    const err = await callErr('text_format', { project: TP, comp, layer: l, range: [3, 3], character: { faux_bold: true } });
    assert(/vacío/.test(err), err);
  });
};
