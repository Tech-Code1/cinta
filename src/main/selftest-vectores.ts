// Self-test of «vectores» through the real UI: right-click on a text layer → «Crear formas a partir del texto» (shape
// layer over the text, text switched off, same pixels), «Crear máscaras a partir del texto», the «Trazado automático»
// dialog on a solid with a round mask, and the variable-font axes of the Character panel.
import type { motion } from '../core';
import type { Ctx } from './selftest-panels';

export async function vectoresSteps(x: Ctx) {
  const { js, until, wait, step, assert } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  let compId = '';
  const comp = () => (P().comps ?? []).find((c) => c.id === compId) as motion.Comp | undefined;
  const layer = (id: string) => comp()?.layers.find((l) => l.id === id);
  const settle = async () => { await wait(400); await until('!window.__adv.adv.work', 5000); await wait(500); };
  const rclick = (id: string) => js(`const el = document.querySelector('[data-test=layer-row][data-layer=${JSON.stringify(id)}]'); if (!el) throw new Error('sin fila'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 120, clientY: r.top + 8 }));`);
  const menu = (text: string) => js(`const b = [...document.querySelectorAll('.ctx button')].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('sin opción ${text}'); b.click();`);
  /** white pixels of the viewer in a band of comp pixels */
  const ink = () => js<number>('let n = 0; for (let x = 120; x <= 520; x += 3) for (let y = 120; y <= 240; y += 3) { const p = A.pixel(x, y); if (p[0] > 128) n++; } return n;');

  await step('Vectores: clic derecho en una capa de texto → «Crear formas a partir del texto» (formas sobre el texto, mismos píxeles)', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    const c = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'compNew', { name: 'Vectores', width: 640, height: 360, fps: 10, duration: 1, bg: '#000000' })`);
    compId = c.id;
    const t = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(compId)}, 'text', { text: 'Cinta 8', size: 90, font: 'Arial', color: '#ffffff', position: [320, 210] })`);
    await untilMain(() => !!layer(t.id), 'capa de texto');
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(compId)}; a.work = null; a.emit('comp'); a.select([${JSON.stringify(t.id)}]); a.seek(0);`);
    await js('document.querySelector("[data-test=tool-select]").click()');
    await settle();
    const before = await ink();
    await rclick(t.id);
    await menu('Crear formas a partir del texto');
    await untilMain(() => comp()!.layers.length === 2, 'capa de forma');
    const sh = comp()!.layers[0];
    assert(sh.type === 'shape' && sh.name === 'Cinta 8 contornos' && sh.shapes!.map((s) => s.name).join('') === 'Cinta8' && layer(t.id)!.hidden, `capa ${sh.name}: ${sh.shapes?.map((s) => s.name)}`);
    assert(sh.shapes!.find((s) => s.name === '8')!.contours!.length === 2 && sh.shapes!.find((s) => s.name === 'a')!.contours!.length === 1, 'contornos del 8 y la a');
    await settle();
    const after = await ink();
    assert(before > 200 && Math.abs(after - before) / before < 0.08, `píxeles ${before} → ${after}`);
    // the menu of the header (Capa ▸) offers them for the selected layer too; undo returns the text
    await js('return window.cinta.invoke("op", "undo")');
    await untilMain(() => comp()!.layers.length === 1 && !layer(t.id)!.hidden, 'deshacer');
  });

  await step('Vectores: «Crear máscaras a partir del texto» (sólido con una máscara por contorno)', async () => {
    const t = comp()!.layers[0];
    await js(`window.__adv.adv.select([${JSON.stringify(t.id)}])`);
    await wait(200);
    await js('document.querySelector("[data-test=adv-add-layer]").click()');
    await menu('Crear máscaras a partir del texto');
    await untilMain(() => comp()!.layers.length === 2, 'sólido');
    const so = comp()!.layers[0];
    assert(so.type === 'solid' && so.masks.length === 10 && so.masks.filter((m) => m.mode === 'subtract').length === 3, `máscaras ${so.masks.map((m) => `${m.name}:${m.mode}`)}`);
    await settle();
    const n = await ink();
    assert(n > 200, `píxeles del sólido ${n}`);
  });

  await step('Vectores: diálogo «Trazado automático» sobre un sólido con máscara redonda (opciones de After Effects)', async () => {
    const s = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(compId)}, 'solid', { color: '#ffffff', width: 200, height: 200, position: [320, 180] })`);
    await js(`return await window.cinta.invoke('motion', 'maskAdd', ${JSON.stringify(compId)}, ${JSON.stringify(s.id)}, { shape: 'ellipse', x: 40, y: 40, width: 120, height: 120 })`);
    await untilMain(() => layer(s.id)?.masks.length === 1, 'máscara');
    await wait(300);
    await rclick(s.id);
    await menu('Trazado automático');
    await until('document.querySelector("[data-test=at-ok]")');
    const d = await js<Record<string, string | boolean>>(`const q = (k) => document.querySelector('[data-test=' + k + ']'); return { ch: q('at-channel').value, cur: q('at-current').checked, blur: q('at-blur').value, blurOn: q('at-blur-on').checked, tol: q('at-tolerance').value, thr: q('at-threshold').value, area: q('at-minarea').value, round: q('at-round').value, nl: q('at-newlayer').checked }`);
    assert(d.ch === 'alpha' && d.cur && d.blur === '1' && d.blurOn && d.tol === '1' && d.thr === '50' && d.area === '10' && d.round === '50' && !d.nl, `valores por defecto ${JSON.stringify(d)}`);
    await js(`const n = document.querySelector('[data-test=at-newlayer]'); n.checked = true; document.querySelector('[data-test=at-ok]').click();`);
    await untilMain(() => comp()!.layers[0].name.startsWith('Trazado automático'), 'capa del trazado', 30000);
    const tl = comp()!.layers[0];
    assert(tl.masks.length === 1 && tl.masks[0].mode === 'add' && tl.solid!.width === 200, `máscaras ${tl.masks.length}`);
    // its vertices lie on the circle (centre 100, 100, radius 60 in the solid's pixels)
    const p = tl.masks[0].path.v as number[];
    for (let i = 0; i < p.length; i += 6) assert(Math.abs(Math.hypot(p[i] - 100, p[i + 1] - 100) - 60) < 1.5, `vértice ${p[i]}, ${p[i + 1]}`);
  });

  await step('Vectores: panel Carácter — ejes de fuente variable de Bahnschrift (Anchura cambia el modelo)', async () => {
    const t = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(compId)}, 'text', { text: 'HH', size: 60, font: 'Bahnschrift', color: '#ffffff' })`);
    await untilMain(() => !!layer(t.id), 'texto Bahnschrift');
    await js(`window.__adv.adv.select([${JSON.stringify(t.id)}])`);
    await js('document.querySelector("[data-test=tab-character]").click()');
    await until('document.querySelector("[data-test=axis-wdth]")', 10000);
    assert(await js('return !!document.querySelector("[data-test=axis-wght]")'), 'eje de grosor');
    await js(`const e = document.querySelector('[data-test=axis-wdth]'); e.value = '80'; e.dispatchEvent(new Event('change'));`);
    await untilMain(() => layer(t.id)?.text?.axes?.wdth?.v === 80, 'eje wdth');
    // set: now a property with stopwatch in the panel
    await until('document.querySelector("[data-test=\'pv-text.axes.wdth\']")', 10000);
  });
}
