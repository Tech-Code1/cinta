// Self-test of «texto» through the real UI: paragraph text by dragging with the type tool, Character panel buttons
// on the selected characters while editing (Superíndice) and on the layer (Faux negrita), AE text shortcuts in the
// text box (Ctrl+Mayús+K), the Paragraph panel (Justificar todo, sangría, composición), the layer menu (Orientación
// del texto ▸ Vertical, Convertir a texto de punto) and Ctrl+T cycling to the Vertical Type tool.
import type { motion } from '../core';
import type { Ctx } from './selftest-panels';

export async function textoSteps(x: Ctx) {
  const { js, until, wait, step, assert } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  let compId = '';
  const comp = () => (P().comps ?? []).find((c) => c.id === compId) as motion.Comp | undefined;
  const settle = async () => { await wait(400); await until('!window.__adv.adv.work', 5000); await wait(500); };
  const rclick = (id: string) => js(`const el = document.querySelector('[data-test=layer-row][data-layer=${JSON.stringify(id)}]'); if (!el) throw new Error('sin fila'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 120, clientY: r.top + 8 }));`);
  const menu = (text: string) => js(`const b = [...document.querySelectorAll('.ctx button')].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('sin opción ${text}'); b.click();`);
  const click = (sel: string) => js(`const b = document.querySelector(${JSON.stringify(sel)}); if (!b) throw new Error('falta ${sel}'); b.click();`);
  /** bounding box of the white pixels of the viewer (comp px, 8 px steps) */
  const inkBox = () => js<number[]>('let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (let x = 0; x < 640; x += 8) for (let y = 0; y < 360; y += 8) { const p = A.pixel(x, y); if (p[0] > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } } return [x0, y0, x1, y1];');
  let id = '';

  await step('Texto: arrastrar con la herramienta Texto crea texto de párrafo (caja, composición multilínea) y se escribe', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    const c = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'compNew', { name: 'Texto AE', width: 640, height: 360, fps: 10, duration: 1, bg: '#000000' })`);
    compId = c.id;
    await untilMain(() => !!comp(), 'comp');
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(compId)}; a.work = null; a.emit('comp'); a.select([]); a.seek(0);`);
    await settle();
    await click('[data-test=tool-text]');
    await js('A.drag(".adv-stage", A.comp(120, 80), A.comp(520, 300))');
    await until('document.querySelector("[data-test=adv-text-edit]")', 8000);
    await untilMain(() => comp()!.layers.length === 1, 'capa de texto');
    const l = comp()!.layers[0];
    id = l.id;
    assert(!!l.text!.box && Math.abs(l.text!.box[0] - 400) < 3 && Math.abs(l.text!.box[1] - 220) < 3 && l.text!.composer === 'every', `caja ${l.text!.box}`);
    await js('const t = document.querySelector("[data-test=adv-text-edit]"); t.value = "Hola Cinta"; t.dispatchEvent(new Event("input"))');
    // Superíndice on the selected characters while editing ("Cinta")
    await js('const t = document.querySelector("[data-test=adv-text-edit]"); t.focus(); t.setSelectionRange(5, 10);');
    await click('[data-test=tab-character]');
    await click('[data-test=char-super]');
    await untilMain(() => !!comp()!.layers[0].text!.runs?.some((r) => r.s === 5 && r.e === 10 && r.style.script === 'super'), 'superíndice en «Cinta»');
    assert(String(comp()!.layers[0].text!.text.v) === 'Hola Cinta', `texto ${comp()!.layers[0].text!.text.v}`);
    // Ctrl+Mayús+K in the text box: All caps on the selection
    await js('const t = document.querySelector("[data-test=adv-text-edit]"); t.focus(); t.setSelectionRange(0, 4); t.dispatchEvent(new KeyboardEvent("keydown", { key: "K", ctrlKey: true, shiftKey: true, bubbles: true }))');
    await untilMain(() => !!comp()!.layers[0].text!.runs?.some((r) => r.s === 0 && r.e === 4 && r.style.allCaps), 'mayúsculas con Ctrl+Mayús+K');
    await js('const t = document.querySelector("[data-test=adv-text-edit]"); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))');
    await until('!document.querySelector("[data-test=adv-text-edit]")', 5000);
    await click('[data-test=tool-select]');
  });

  await step('Texto: Faux negrita en la capa (panel Carácter) engorda los glifos; panel Párrafo: justificar todo, sangría y composición', async () => {
    await js(`window.__adv.adv.select([${JSON.stringify(id)}])`);
    await settle();
    const ink = () => js<number>('let n = 0; for (let x = 100; x <= 540; x += 2) for (let y = 60; y <= 320; y += 2) { const p = A.pixel(x, y); if (p[0] > 128) n++; } return n;');
    const before = await ink();
    await click('[data-test=tab-character]');
    await click('[data-test=char-fauxBold]');
    await untilMain(() => comp()!.layers[0].text!.fauxBold === true, 'Faux negrita');
    await settle();
    const after = await ink();
    assert(before > 100 && after > before * 1.08, `píxeles ${before} → ${after}`);
    await click('[data-test=tab-paragraph]');
    await click('[data-test=para-justify-all]');
    await untilMain(() => comp()!.layers[0].text!.justify === 'all', 'justificar todo');
    await js('const i = document.querySelector("[data-test=para-indentFirst]"); i.value = "24"; i.dispatchEvent(new Event("change"))');
    await untilMain(() => comp()!.layers[0].text!.indentFirst === 24, 'sangría en primera línea');
    await click('[data-test=para-composer-single]');
    await untilMain(() => comp()!.layers[0].text!.composer === 'single', 'composición línea por línea');
    await settle();
    const b = await inkBox();
    // justified to the box (120…520 minus the indent)
    assert(b[0] >= 136 && b[0] <= 160 && b[2] >= 496, `caja de tinta ${b}`);
  });

  await step('Texto: menú de capa ▸ Orientación del texto ▸ Vertical, Convertir a texto de punto; Ctrl+T pasa a Tipo vertical', async () => {
    await click('[data-test=para-justify-all]');
    await js(`return window.cinta.invoke('motion', 'textFormat', ${JSON.stringify(compId)}, ${JSON.stringify(id)}, { paragraph: { justify: null, align: 'left' }, character: { fauxBold: null } })`);
    await rclick(id);
    await menu('Orientación del texto');
    await menu('Vertical');
    await untilMain(() => comp()!.layers[0].text!.vertical === true, 'vertical');
    await settle();
    const b = await inkBox();
    assert(b[3] - b[1] > (b[2] - b[0]) * 1.3, `vertical: caja ${b}`);
    await rclick(id);
    await menu('Orientación del texto');
    await menu('Horizontal');
    await untilMain(() => !comp()!.layers[0].text!.vertical, 'horizontal');
    await rclick(id);
    await menu('Convertir a texto de punto');
    await untilMain(() => !comp()!.layers[0].text!.box, 'texto de punto');
    assert(String(comp()!.layers[0].text!.text.v).replace(/\n/g, ' ') === 'Hola Cinta', `texto ${JSON.stringify(comp()!.layers[0].text!.text.v)}`);
    // Ctrl+T: type tool, again: Vertical Type tool; a click starts vertical point text
    await js('A.key("t", { ctrl: true })');
    await until('window.__adv.adv.tool === "text"');
    await js('A.key("t", { ctrl: true })');
    await until('document.querySelector("[data-test=tool-text]").dataset.vertical === "1"');
    await js('const p = A.comp(600, 40); A.drag(".adv-stage", p, p)');
    await until('document.querySelector("[data-test=adv-text-edit]")', 8000);
    await untilMain(() => comp()!.layers.length === 2 && comp()!.layers[0].text?.vertical === true, 'texto vertical nuevo');
    await js('const t = document.querySelector("[data-test=adv-text-edit]"); t.value = "縦書き"; t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))');
    await untilMain(() => comp()!.layers[0].text!.text.v === '縦書き', 'texto escrito');
    await js('A.key("t", { ctrl: true })');
    await until('document.querySelector("[data-test=tool-text]").dataset.vertical === ""');
    await click('[data-test=tool-select]');
  });
}
