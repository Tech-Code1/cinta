// Unit tests of «texto»: the text layout keeps old projects exactly (point and paragraph text), the Character
// panel extras (Faux, caps, super/subscript, baseline shift, tsume, scales, hindi digits), character runs, the
// Paragraph panel (indents, spacing, justification, composers, hyphenation) and vertical text with Tate-chu-yoko.
export default ({ test, ok, near, M }) => {
  // the layout of earlier versions (reference for old projects)
  function legacy(text, o, measure) {
    let lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (o.box && o.box[0] > 0) {
      const W = o.box[0], out = [];
      for (const para of lines) {
        let cur = '';
        for (const word of para.split(/(\s+)/)) {
          if (!word) continue;
          const next = cur + word;
          if (measure(next.trimEnd()) <= W || !cur.trim()) {
            if (measure(next.trimEnd()) > W && !/\s/.test(word)) { for (const c of word) { if (measure(cur + c) > W && cur) { out.push(cur.trimEnd()); cur = ''; } cur += c; } }
            else cur = next;
          } else { out.push(cur.trimEnd()); cur = /\s/.test(word) ? '' : word; }
        }
        out.push(cur.trimEnd());
      }
      const lh0 = o.leading > 0 ? o.leading : o.size * 1.2;
      const fit = o.box[1] > 0 ? Math.max(1, Math.floor((o.box[1] - o.size * 0.3) / lh0)) : out.length;
      lines = out.slice(0, fit);
    }
    const lh = o.leading > 0 ? o.leading : o.size * 1.2;
    const glyphs = [];
    let idx = 0, ns = 0, word = 0;
    lines.forEach((line, li) => {
      const chars = [...line];
      const adv = chars.map((c, i) => { const next = chars[i + 1]; return (next ? measure(c + next) - measure(next) : measure(c)) + (o.tracking * o.size) / 1000; });
      const total = adv.reduce((a, b) => a + b, 0) - (chars.length ? (o.tracking * o.size) / 1000 : 0);
      const bw = o.box && o.box[0] > 0 ? o.box[0] : 0;
      let x = o.align === 'left' ? -bw / 2 : o.align === 'right' ? bw / 2 - total : -total / 2;
      let prevSpace = true;
      for (let i = 0; i < chars.length; i++) {
        const space = /\s/.test(chars[i]);
        if (!space && prevSpace && glyphs.length) word++;
        prevSpace = space;
        glyphs.push({ ch: chars[i], x, y: li * lh + (o.box && o.box[1] > 0 ? -o.box[1] / 2 + o.size * 0.9 : 0), w: adv[i], line: li, word, idx: idx++, idxNoSpace: space ? -1 : ns++, space });
        x += adv[i];
      }
      prevSpace = true;
      if (li < lines.length - 1) word++;
    });
    return { glyphs, lines: lines.length, words: glyphs.length ? word + 1 : 0, noSpace: ns };
  }
  // a font with kerning-like pairs: widths depend on the letter, "AV" is tighter
  const W = { i: 0.3, l: 0.3, ' ': 0.28, m: 0.9, w: 0.85, M: 0.95, W: 1 };
  const measure = (s) => { let w = 0; const a = [...s]; a.forEach((c, i) => { w += (W[c] ?? 0.58) * 100; if (c === 'A' && a[i + 1] === 'V') w -= 12; }); return w; };
  const same = (a, b) => a.lines === b.lines && a.words === b.words && a.noSpace === b.noSpace && a.glyphs.length === b.glyphs.length
    && a.glyphs.every((g, i) => { const h = b.glyphs[i]; return g.ch === h.ch && near(g.x, h.x, 1e-6) && near(g.y, h.y, 1e-6) && near(g.w, h.w, 1e-6) && g.line === h.line && g.word === h.word && g.idx === h.idx && g.idxNoSpace === h.idxNoSpace && g.space === h.space; });

  test('texto: la disposición nueva da lo mismo que antes (texto de punto y de párrafo, alineaciones, interletraje)', () => {
    const texts = ['Hola mundo', 'AVATAR de la AVENIDA\nsegunda línea  con  espacios', 'Supercalifragilisticoespialidoso es largo', 'a\n\nb c d e f g h i j k l m n o p', '', 'una palabra muy muy larguísimaaaaaaaaaaaaaaaa y más'];
    let n = 0;
    for (const t of texts) for (const align of ['left', 'center', 'right']) for (const box of [undefined, [600, 0], [450, 400], [300, 1000]]) for (const tracking of [0, 80]) for (const leading of [0, 130]) {
      const o = { size: 100, tracking, leading, align, box };
      const a = M.layoutText(t, o, measure), b = legacy(t, o, measure);
      ok(same(a, b), `distinto: ${JSON.stringify(t)} ${JSON.stringify(o)}`);
      n++;
    }
    ok(n === 6 * 3 * 4 * 2 * 2, String(n));
  });

  test('texto: Versalitas (70 %), Superíndice / Subíndice (58,3 % y ±33,3 %), desplazamiento de línea de base', () => {
    const sc = M.layoutText('Ab', { size: 100, tracking: 0, leading: 0, align: 'left', style: () => ({ smallCaps: true }) }, measure);
    ok(sc.glyphs[0].ch === 'A' && sc.glyphs[0].k === undefined, 'la mayúscula queda');
    ok(sc.glyphs[1].ch === 'B' && near(sc.glyphs[1].k, 0.7), `versalita ${JSON.stringify(sc.glyphs[1])}`);
    const sup = M.layoutText('x2', { size: 100, tracking: 0, leading: 0, align: 'left', style: (i) => (i === 1 ? { script: 'super' } : {}) }, measure);
    ok(near(sup.glyphs[1].k, 0.583) && near(sup.glyphs[1].y, -33.3, 0.01) && near(sup.glyphs[1].w, 58 * 0.583, 0.01), JSON.stringify(sup.glyphs[1]));
    const sub = M.layoutText('H2O', { size: 100, tracking: 0, leading: 0, align: 'left', style: (i) => (i === 1 ? { script: 'sub' } : {}) }, measure);
    ok(near(sub.glyphs[1].y, 33.3, 0.01) && sub.glyphs[2].y === 0, 'subíndice baja');
    const bs = M.layoutText('ab', { size: 100, tracking: 0, leading: 0, align: 'left', style: () => ({ baselineShift: 20, hScale: 150, vScale: 80, fauxBold: true, fauxItalic: true }) }, measure);
    ok(bs.glyphs.every((g) => g.y === -20 && g.hs === 1.5 && g.vs === 0.8 && g.fb && g.fi), JSON.stringify(bs.glyphs[0]));
    ok(near(bs.glyphs[1].x, 58 * 1.5), 'la escala horizontal ensancha el avance');
    const ts = M.layoutText('ab', { size: 100, tracking: 0, leading: 0, align: 'left', style: () => ({ tsume: 100 }) }, measure);
    ok(near(ts.glyphs[1].x, 58 * 0.75), `tsume ${ts.glyphs[1].x}`);
    const hd = M.layoutText('2024', { size: 100, tracking: 0, leading: 0, align: 'left', hindiDigits: true }, measure);
    ok(hd.glyphs.map((g) => g.ch).join('') === '٢٠٢٤', 'dígitos hindi');
    const caps = M.layoutText('straße', { size: 100, tracking: 0, leading: 0, align: 'left', allCaps: true }, measure);
    ok(caps.glyphs.map((g) => g.ch).join('') === 'STRASSE' && caps.glyphs.map((g) => g.src).join(',') === '0,1,2,3,4,4,5', 'ß → SS');
  });

  test('texto: tramos de estilo (aplicar a una selección, fusionar, quitar, mover al editar)', () => {
    const d = M.newTextDoc('Hola mundo');
    M.applyRunStyle(d, 0, 4, { fauxBold: true }, 10);
    M.applyRunStyle(d, 2, 7, { script: 'super' }, 10);
    ok(JSON.stringify(d.runs) === JSON.stringify([{ s: 0, e: 2, style: { fauxBold: true } }, { s: 2, e: 4, style: { fauxBold: true, script: 'super' } }, { s: 4, e: 7, style: { script: 'super' } }]), JSON.stringify(d.runs));
    const st = M.styleResolver(d);
    ok(st(3).fauxBold && st(3).script === 'super' && !st(8).fauxBold, 'resolución por carácter');
    M.applyRunStyle(d, 0, 10, { fauxBold: null, script: null }, 10);
    ok(!d.runs && d.fauxBold === undefined, `todo el texto: ${JSON.stringify(d)}`);
    M.applyRunStyle(d, 0, 10, { smallCaps: true }, 10);
    ok(d.smallCaps === true && !d.runs, 'todo el texto va a la capa');
    M.applyRunStyle(d, 5, 10, { fauxItalic: true }, 10);
    M.shiftRuns(d, 'Hola mundo', '¡Hola mundo');
    ok(d.runs[0].s === 6 && d.runs[0].e === 11, JSON.stringify(d.runs));
    M.shiftRuns(d, '¡Hola mundo', '¡Hola mu');
    ok(d.runs[0].s === 6 && d.runs[0].e === 8, JSON.stringify(d.runs));
  });

  test('texto: separación por sílabas (reglas del español, 7 letras, 3 + 3)', () => {
    const hy = (w) => { const p = M.hyphenPoints(w); let s = '', a = 0; for (const x of p) { s += w.slice(a, x) + '-'; a = x; } return s + w.slice(a); };
    ok(hy('composición') === 'com-po-si-ción', hy('composición'));
    ok(hy('extraordinario') === 'extra-or-di-na-rio', hy('extraordinario'));
    ok(hy('construcción') === 'cons-truc-ción', hy('construcción'));
    ok(hy('animación') === 'ani-ma-ción', hy('animación'));
    ok(hy('casa') === 'casa' && hy('pequeña') === 'pequeña', 'palabras cortas sin cortar');
  });

  test('texto: Párrafo: sangrías, espacio antes / después, justificar y separación automática', () => {
    const o = { size: 100, tracking: 0, leading: 0, align: 'left', box: [1000, 0] };
    const ind = M.layoutText('uno dos tres cuatro cinco seis siete ocho\nnueve', { ...o, indentLeft: 50, indentFirst: 30, indentRight: 100 }, measure);
    ok(near(ind.glyphs[0].x, -500 + 80) && ind.glyphs.filter((g) => g.line === 1)[0].x === -450, 'sangrías');
    ok(Math.max(...ind.glyphs.map((g) => g.x + g.w)) <= 400 + 1e-6, 'sangría derecha');
    const sp = M.layoutText('a\nb\nc', { ...o, box: undefined, spaceBefore: 10, spaceAfter: 20 }, measure);
    ok(near(sp.glyphs[1].y, 150) && near(sp.glyphs[2].y, 300), JSON.stringify(sp.glyphs.map((g) => g.y)));
    const j = M.layoutText('aa bb cc dd ee ff gg hh ii jj kk ll mm', { ...o, justify: 'left' }, measure);
    const l0 = j.glyphs.filter((g) => g.line === 0), last = l0[l0.length - 1];
    ok(near(last.x + last.w, 500, 1e-6), `línea justificada llega al borde: ${last.x + last.w}`);
    const lastLine = j.glyphs.filter((g) => g.line === j.lines - 1);
    ok(near(lastLine[0].x, -500), 'la última a la izquierda');
    const jc = M.layoutText('aa bb cc dd ee ff gg hh ii jj kk ll mm', { ...o, justify: 'right' }, measure);
    const ll = jc.glyphs.filter((g) => g.line === jc.lines - 1), z = ll[ll.length - 1];
    ok(near(z.x + z.w, 500), 'la última a la derecha');
    const ja = M.layoutText('aa bb', { ...o, justify: 'all' }, measure);
    ok(near(ja.glyphs[4].x + ja.glyphs[4].w, 500), 'justificar todo fuerza la última');
    const hy = M.layoutText('la composición', { ...o, box: [700, 0], hyphenate: true }, measure);
    ok(hy.glyphs.filter((g) => g.line === 0).map((g) => g.ch).join('') === 'la composi-', hy.glyphs.map((g) => g.ch).join(''));
    ok(hy.glyphs.find((g) => g.ch === '-').src === -1, 'el guion es añadido');
  });

  test('texto: Composición multilínea de Adobe reparte las líneas mejor que la de línea por línea', () => {
    const t = 'aaa bb cccc dd eee ff gggg hh iii jj kkkk ll mmm nn oooo';
    const o = { size: 100, tracking: 0, leading: 0, align: 'left', box: [900, 0] };
    const slack = (l) => { const s = []; for (let i = 0; i < l.lines - 1; i++) { const g = l.glyphs.filter((x) => x.line === i); s.push(900 - (g[g.length - 1].x + g[g.length - 1].w + 450)); } return s; };
    const a = slack(M.layoutText(t, o, measure)), b = slack(M.layoutText(t, { ...o, composer: 'every' }, measure));
    const sq = (s) => s.reduce((x, y) => x + y * y, 0);
    ok(b.every((x) => x >= -1e-6), 'nada se sale');
    ok(sq(b) <= sq(a) + 1e-6, `multilínea ${sq(b)} vs línea por línea ${sq(a)}`);
    const all = M.layoutText(t, { ...o, composer: 'every' }, measure).glyphs.map((g) => g.ch).join('');
    ok(all.replace(/ /g, '') === t.replace(/ /g, ''), 'no se pierde texto');
  });

  test('texto: vertical: columnas de derecha a izquierda, glifos de pie, alineación latina estándar gira 90°, Tate-chu-yoko', () => {
    const v = M.layoutText('ab\ncd', { size: 100, tracking: 0, leading: 0, align: 'left', vertical: true }, measure);
    ok(v.vertical && v.lines === 2, 'dos columnas');
    const [a, b, c] = v.glyphs;
    ok(near(a.x + a.w / 2, 0) && near(c.x + c.w / 2, -120), `columnas ${a.x + a.w / 2} ${c.x + c.w / 2}`);
    ok(near(b.y - a.y, 100), `un em por carácter: ${b.y - a.y}`);
    ok(!a.rot, 'de pie');
    const r = M.layoutText('ab', { size: 100, tracking: 0, leading: 0, align: 'left', vertical: true, romanStd: true }, measure);
    ok(r.glyphs[0].rot === 90 && near(r.glyphs[1].y - r.glyphs[0].y, 58), 'girados, avance de su anchura');
    const t = M.layoutText('平成20年', { size: 100, tracking: 0, leading: 0, align: 'left', vertical: true, style: (i) => (i === 2 || i === 3 ? { tcy: true } : {}) }, measure);
    const [g0, g1, d2, d0, g4] = t.glyphs;
    ok(near(d2.y, d0.y) && d0.x > d2.x && near(d2.x + d2.w, d0.x) && !d2.rot, 'el 20 lado a lado');
    ok(near(g4.y - g1.y, 200) && near(g1.y - g0.y, 100), 'el grupo ocupa un em');
    ok(t.glyphs.map((g) => g.idx).join(',') === '0,1,2,3,4', 'orden');
    const ctr = M.layoutText('abcd', { size: 100, tracking: 0, leading: 0, align: 'center', vertical: true }, measure);
    ok(near(ctr.glyphs[0].y - 100 * 0.35 - 50, -200), `centrado vertical ${ctr.glyphs[0].y}`);
    const box = M.layoutText('abcdef', { size: 100, tracking: 0, leading: 0, align: 'left', vertical: true, box: [600, 300] }, measure);
    ok(box.lines === 2 && box.glyphs[3].line === 1, `columna se ajusta a la altura de la caja (${box.lines})`);
  });
};
