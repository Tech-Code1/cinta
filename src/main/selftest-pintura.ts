// Self-test of the paint tools through the real UI: Ctrl+B cycles Brush / Clone Stamp / Eraser, the Paint and
// Brushes panels set the colour and the tip, a drag on the viewer paints a stroke on the selected layer (model,
// timeline row and pixels), the eraser takes it away, and undo brings it back.
import type { motion } from '../core';
import type { Ctx } from './selftest-panels';

export async function paintSteps(x: Ctx) {
  const { js, until, wait, step, assert } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  let compId = '', layerId = '';
  const layer = () => (P().comps ?? []).find((c) => c.id === compId)?.layers.find((l) => l.id === layerId) as motion.Layer | undefined;
  const strokes = () => layer()?.effects.find((f) => f.fx === 'paint')?.strokes ?? [];
  /** a pixel of the viewer (comp px) once the frame is rendered (away from the anchor gizmo at the centre) */
  const pixel = async (cx: number, cy: number) => { await wait(400); await until('!window.__adv.adv.work', 5000); await wait(500); return js<number[]>(`return A.pixel(${cx}, ${cy})`); };
  const val = (sel: string, v: string) => js(`const e = document.querySelector('${sel}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change'));`);

  await step('Pintura: Ctrl+B recorre Pincel, Tampón de clonar y Borrador; los paneles Pintar y Pinceles', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    const c = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'compNew', { name: 'Pintura', width: 640, height: 360, fps: 30, duration: 4, bg: '#000000' })`);
    compId = c.id;
    const l = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(compId)}, 'solid', { color: '#1d6cff' })`);
    layerId = l.id;
    await untilMain(() => !!layer(), 'capa sólida');
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(compId)}; a.work = null; a.emit('comp'); a.select([${JSON.stringify(layerId)}]); a.seek(0);`);
    await wait(300);
    await js('document.querySelector("[data-test=tool-select]").click()');
    const seq: string[] = [];
    for (let i = 0; i < 4; i++) { await js('A.key("b", { ctrl: true })'); seq.push(await js<string>('return window.__adv.adv.tool')); }
    assert(seq.join() === 'brush,clone,eraser,brush', `Ctrl+B: ${seq}`);
    await js('document.querySelector("[data-test=tab-paint]").click()');
    await val('[data-test=paint-fg]', '#ff0000');
    await js('document.querySelector("[data-test=tab-brushes]").click()');
    await val('[data-test=brush-diameter] input, input[data-test=brush-diameter]', '30');
    await val('input[data-test=brush-hardness]', '100');
    const o = await js<{ fg: string; d: number; h: number }>('const o = JSON.parse(localStorage.getItem("cinta.adv.paint")); return { fg: o.fg, d: o.brush.diameter, h: o.brush.hardness }');
    assert(o.fg === '#ff0000' && o.d === 30 && o.h === 100, `opciones ${JSON.stringify(o)}`);
  });

  await step('Pintura: arrastrar con el Pincel sobre el visor pinta un trazo en la capa (modelo, línea de tiempo y píxeles)', async () => {
    const before = await pixel(250, 180);
    await js('A.drag(".adv-stage", A.comp(120, 180), A.comp(520, 180))');
    await untilMain(() => strokes().length === 1, 'un trazo');
    const s = strokes()[0];
    assert(s.kind === 'brush' && s.name === 'Pincelar 1' && s.color.v === '#ff0000' && s.diameter.v === 30 && s.path.v.length >= 4, `trazo ${JSON.stringify({ k: s.kind, n: s.name, c: s.color.v, d: s.diameter.v, p: s.path.v.length })}`);
    // the solid has the comp's size and sits at its centre: layer px = comp px
    assert(Math.abs(s.path.v[0] - 120) < 3 && Math.abs(s.path.v[1] - 180) < 3, `trazado en espacio de capa ${s.path.v.slice(0, 2)}`);
    const px = await pixel(250, 180);
    assert(px[0] > 200 && px[1] < 60 && px[2] < 60 && before[2] > 150, `rojo pintado: ${px} (antes ${before})`);
    const off = await pixel(250, 230);
    assert(off[2] > 150 && off[0] < 80, `fuera del trazo sigue el sólido: ${off}`);
    // the stroke under the layer's Pintura effect in the timeline
    await js(`const rows = [...document.querySelectorAll('#adv .row.layer')]; rows[0].querySelector('[data-test=layer-twisty]').click();`);
    await wait(150);
    for (const g of ['Efectos', 'Pintura']) { await js(`const r = [...document.querySelectorAll('#adv .row.group')].find((e) => e.querySelector('.nm')?.textContent === ${JSON.stringify(g)}); r?.querySelector('.tw').click();`); await wait(150); }
    const rows = await js<string[]>('return A.rows()');
    assert(rows.some((r) => r.startsWith('group') && r.endsWith(':Pincelar 1')) && rows.some((r) => r.endsWith(':Pintar sobre transparente')), `filas: ${rows.slice(0, 12).join(' | ')}`);
  });

  await step('Pintura: el Borrador quita el trazo y la capa; Ctrl+Z lo deshace', async () => {
    await js('A.key("b", { ctrl: true })'); await js('A.key("b", { ctrl: true })');
    assert((await js<string>('return window.__adv.adv.tool')) === 'eraser', 'borrador');
    await js('document.querySelector("[data-test=tab-paint]").click()');
    await val('[data-test=paint-erase]', 'all');
    await js('A.drag(".adv-stage", A.comp(250, 120), A.comp(250, 240))');
    await untilMain(() => strokes().length === 2, 'trazo de borrador');
    assert(strokes()[1].kind === 'eraser' && strokes()[1].erase === 'all' && strokes()[1].name === 'Borrador 1', 'borrador en el modelo');
    const px = await pixel(250, 180);
    assert(px[0] < 40 && px[1] < 40 && px[2] < 40, `borrado hasta el fondo: ${px}`);
    const red = await pixel(420, 180);
    assert(red[0] > 200, `el resto del trazo sigue: ${red}`);
    await js('A.key("z", { ctrl: true })');
    await untilMain(() => strokes().length === 1, 'deshacer');
    const back = await pixel(250, 180);
    assert(back[0] > 200 && back[2] < 60, `deshacer devuelve el rojo: ${back}`);
    await js('document.querySelector("[data-test=tool-select]").click()');
  });
}
