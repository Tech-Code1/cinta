// Self-test of Vector Paint through the real UI: «Pintar en el visor» in the effect's controls, a Brush drag on the
// viewer becomes a stroke of the effect (model and pixels, Playback Mode All Strokes), «Borrar trazos» empties it.
import type { motion } from '../core';
import type { Ctx } from './selftest-panels';

export async function particulasSteps(x: Ctx) {
  const { js, until, wait, step, assert } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  let compId = '', layerId = '';
  const layer = () => (P().comps ?? []).find((c) => c.id === compId)?.layers.find((l) => l.id === layerId) as motion.Layer | undefined;
  const strokes = () => { const v = layer()?.effects.find((f) => f.fx === 'vectorPaint')?.params.strokes?.v; try { return JSON.parse(String(v ?? '[]')) as { t: number; color: string; radius: number; points: number[][] }[]; } catch { return []; } };
  const pixel = async (cx: number, cy: number) => { await wait(400); await until('!window.__adv.adv.work', 5000); await wait(500); return js<number[]>(`return A.pixel(${cx}, ${cy})`); };

  await step('Pintura vectorial: «Pintar en el visor» y un arrastre con el Pincel guardan un trazo en el efecto y se ve', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    const c = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'compNew', { name: 'Pintura vectorial', width: 640, height: 360, fps: 30, duration: 4, bg: '#000000' })`);
    compId = c.id;
    const l = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(compId)}, 'solid', { color: '#1d6cff' })`);
    layerId = l.id;
    await js(`return await window.cinta.invoke('motion', 'effectAdd', ${JSON.stringify(compId)}, ${JSON.stringify(layerId)}, 'vectorPaint', { playback: 'all', brushColor: '#ff0000', brushRadius: 12, brushFeather: 0 })`);
    await untilMain(() => !!layer()?.effects.some((f) => f.fx === 'vectorPaint'), 'efecto');
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(compId)}; a.work = null; a.emit('comp'); a.select([${JSON.stringify(layerId)}]); a.seek(0);`);
    await wait(300);
    await js('document.querySelector("[data-test=tab-controls]")?.click()');
    await until('!!document.querySelector("[data-test=vp-paint]")');
    await js('document.querySelector("[data-test=vp-paint]").click()');
    assert((await js<string>('return window.__adv.adv.tool')) === 'brush', 'herramienta Pincel');
    await js('A.drag(".adv-stage", A.comp(120, 180), A.comp(520, 180))');
    await untilMain(() => strokes().length === 1, 'un trazo');
    const s = strokes()[0];
    assert(s.color === '#ff0000' && s.radius === 12 && s.points.length >= 4 && Math.abs(s.points[0][0] - 120) < 3 && Math.abs(s.points[0][1] - 180) < 3, `trazo ${JSON.stringify(s).slice(0, 160)}`);
    // no Paint effect strokes: the drag went to Vector Paint
    assert(!layer()?.effects.some((f) => f.fx === 'paint'), 'no es un trazo de Pintura');
    const px = await pixel(250, 180), off = await pixel(250, 260);
    assert(px[0] > 200 && px[2] < 80 && off[2] > 150, `rojo pintado: ${px} / ${off}`);
    await until('/1 trazo/.test(document.querySelector("[data-test=vp-count]")?.textContent ?? "")');
  });

  await step('Pintura vectorial: «Borrar trazos» vacía el efecto y «Dejar de pintar» vuelve a la pintura normal', async () => {
    await js('document.querySelector("[data-test=vp-clear]").click()');
    await untilMain(() => strokes().length === 0, 'sin trazos');
    const px = await pixel(250, 180);
    assert(px[2] > 150 && px[0] < 80, `sin pintura: ${px}`);
    await js('document.querySelector("[data-test=vp-paint]").click()');
    await until('/Pintar en el visor/.test(document.querySelector("[data-test=vp-paint]")?.textContent ?? "")');
    await js('document.querySelector("[data-test=tool-select]").click()');
  });
}
