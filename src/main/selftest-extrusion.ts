// Self-test of extruded 3D text through the real UI: the layer's 3D switch, the «Opciones de geometría» group in the
// timeline (Profundidad de extrusión typed in), «Opciones de material ▸ Color lateral» switched on and coloured, and
// the viewer showing the red side of the letter turned 60° where the camera projects it.
import type { Ctx } from './selftest-panels';

export async function extrusionSteps(x: Ctx) {
  const { js, until, wait, step, assert } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  const settle = async () => { await js('window.__adv.adv.select([])'); await wait(400); await until('!window.__adv.adv.work', 5000); await wait(900); };
  let cid = '', lid = '';
  const layer = () => P().comps!.find((c) => c.id === cid)!.layers.find((l) => l.id === lid)!;
  /** types a value into a property's scrub field (click, type, Enter) */
  const typeInto = async (test: string, value: string) => {
    await until(`document.querySelector("[data-test='${test}']")`, 10000);
    await js(`const s = document.querySelector("[data-test='${test}']"); const r = s.getBoundingClientRect(); const o = { bubbles: true, button: 0, pointerId: 1, clientX: r.left + 4, clientY: r.top + 4 }; s.dispatchEvent(new PointerEvent('pointerdown', o)); s.dispatchEvent(new PointerEvent('pointerup', o));`);
    await until('document.querySelector(".scrub-in")', 5000);
    await js(`const i = document.querySelector(".scrub-in"); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  };
  const openGroup = async (name: string) => {
    await until(`[...document.querySelectorAll("#adv .row.group .nm")].some((e) => e.textContent === ${JSON.stringify(name)})`, 10000);
    await js(`[...document.querySelectorAll("#adv .row.group .nm")].find((e) => e.textContent === ${JSON.stringify(name)}).click()`);
  };

  await step('Extrusión: capa de texto 3D ▸ Opciones de geometría ▸ Profundidad de extrusión 80; Color lateral rojo; girada 60° el visor muestra el lateral', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    const c = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'compNew', { name: 'Extrusión', width: 320, height: 240, fps: 30, duration: 2, bg: '#000000' })`);
    cid = c.id;
    const l = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(cid)}, 'text', { text: 'I', size: 150, color: '#ffffff', font: 'Arial' })`);
    lid = l.id;
    await js(`return window.cinta.invoke('motion', 'layerSet', ${JSON.stringify(cid)}, ${JSON.stringify(lid)}, { text: { weight: 700 }, material: { acceptsLights: false } })`);
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(cid)}; a.work = null; a.emit('comp'); a.seek(0);`);
    await until(`[...document.querySelectorAll("[data-test=layer-row]")].some((e) => e.dataset.layer === ${JSON.stringify(lid)})`);
    // the 3D switch of the layer row, then the layer's groups
    await js(`[...document.querySelectorAll("[data-test=layer-row]")].find((e) => e.dataset.layer === ${JSON.stringify(lid)}).querySelector("[data-test=layer-3d]").click()`);
    await untilMain(() => layer().threeD, 'capa 3D');
    await until(`[...document.querySelectorAll("[data-test=layer-row]")].some((e) => e.dataset.layer === ${JSON.stringify(lid)})`);
    await js(`[...document.querySelectorAll("[data-test=layer-row]")].find((e) => e.dataset.layer === ${JSON.stringify(lid)}).querySelector("[data-test=layer-twisty]").click()`);
    await openGroup('Opciones de geometría');
    await untilMain(() => !!layer().geometry, 'opciones de geometría creadas');
    const g = layer().geometry!;
    assert(g.bevelStyle === 'none' && g.bevelDepth.v === 2 && g.holeBevelDepth.v === 100 && g.extrusionDepth.v === 0, JSON.stringify(g));
    await until('document.querySelector("[data-test=geo-bevel-style]") && document.querySelector("[data-test=\'pv-geometry.bevelDepth\']")', 10000);
    // straight on, the right edge of the letter (comp px), before extruding: nothing changes yet (depth 0)
    await settle();
    const edge = await js<number[]>('let y0 = -1, y1 = -1; for (let y = 0; y < 240; y += 2) { const p = A.pixel(160, y); if (p[0] > 200 && p[1] > 200) { if (y0 < 0) y0 = y; y1 = y; } } const ym = Math.round((y0 + y1) / 2); let x1 = -1; for (let x = 160; x < 320; x++) { const p = A.pixel(x, ym); if (p[0] > 200 && p[1] > 200) x1 = x + 1; } return [x1, ym, y0, y1];');
    assert(edge[0] > 165 && edge[3] - edge[2] > 60, `letra: ${edge}`);
    await typeInto('pv-geometry.extrusionDepth', '80');
    await untilMain(() => layer().geometry!.extrusionDepth.v === 80, 'profundidad de extrusión 80');
    await openGroup('Opciones de material');
    await until('document.querySelector("[data-test=geo-sideColor]")', 10000);
    await js('document.querySelector("[data-test=geo-sideColor]").click()');
    await untilMain(() => !!layer().material?.sideColor, 'color lateral propio');
    await until('document.querySelector("[data-test=\'pv-material.sideColor\']")', 10000);
    await js(`const i = document.querySelector("[data-test='pv-material.sideColor']"); i.value = '#ff0000'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change'));`);
    await untilMain(() => layer().material?.sideColor?.v === '#ff0000', 'color lateral rojo');
    await js(`return window.cinta.invoke('motion', 'propSet', ${JSON.stringify(cid)}, ${JSON.stringify(lid)}, 'transform.rotationY', { value: 60 })`);
    await untilMain(() => layer().transform.rotationY.v === 60, 'rotación Y');
    await settle();
    // the side's middle: layer point (right edge, 0, 40) turned 60° about Y, through the default camera
    const zoom = 160 / Math.tan((39.6 / 2) * (Math.PI / 180)), cs = Math.cos(Math.PI / 3), sn = Math.sin(Math.PI / 3), lx = edge[0] - 160;
    const X = 160 + cs * lx + sn * 40, Z = -sn * lx + cs * 40, sx = 160 + (zoom * (X - 160)) / (Z + zoom), sy = 120 + (zoom * (edge[1] - 120)) / (Z + zoom);
    const p = await js<number[]>(`return A.pixel(${sx.toFixed(2)}, ${sy.toFixed(2)})`);
    assert(p[0] > 160 && p[1] < 90 && p[2] < 90, `lateral rojo en ${sx.toFixed(1)}, ${sy.toFixed(1)}: ${p}`);
    const reds = await js<number>('let n = 0; for (let x = 0; x < 320; x += 2) for (let y = 0; y < 240; y += 2) { const p = A.pixel(x, y); if (p[0] > 160 && p[1] < 90 && p[2] < 90) n++; } return n;');
    assert(reds > 40, `píxeles rojos: ${reds}`);
  });
}
