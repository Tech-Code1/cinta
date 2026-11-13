// Self-test of «capas» through the real UI: right-click → «Capa de guía» (icon, still in the panel), Composición ▸
// Diseño interactivo: tiempo ▸ Crear Intro (protected marker on the ruler, its dialog), Ctrl+Mayús+X, the Región de
// interés button (draw, only that area drawn, Alt+clic resets), RotoBézier on a mask row, the Mask Feather tool (G
// toggles it with the Pen; dragging on the edge adds a feather point) and «Transformación de ondulación» in Add.
import type { motion } from '../core';
import type { Ctx } from './selftest-panels';

export async function capasSteps(x: Ctx) {
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
  const rclick = (id: string) => js(`const el = document.querySelector('[data-test=layer-row][data-layer=${JSON.stringify(id)}]'); if (!el) throw new Error('sin fila'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 5 }));`);
  const menu = (text: string) => js(`const b = [...document.querySelectorAll('.ctx button')].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('sin opción ${text}: ' + [...document.querySelectorAll('.ctx button')].map((e) => e.textContent).join(' | ')); b.click();`);
  const inv = (code: string) => js<{ id: string }>(`return await window.cinta.invoke('motion', ${code})`);
  const white = (cx: number, cy: number) => js<boolean>(`const p = A.pixel(${cx}, ${cy}); return p[0] > 230 && p[1] > 230 && p[2] > 230;`);

  let solid = '';
  await step('Capas: clic derecho → «Capa de guía» (icono en la línea de tiempo; se sigue viendo en el panel Composición)', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    const c = await inv(`'compNew', { name: 'Capas', width: 400, height: 200, fps: 10, duration: 4, bg: '#000000' }`);
    compId = c.id;
    solid = (await inv(`'layerAdd', ${JSON.stringify(compId)}, 'solid', { color: '#ffffff', width: 200, height: 100, position: [200, 100] }`)).id;
    await untilMain(() => !!layer(solid), 'sólido');
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(compId)}; a.work = null; a.emit('comp'); a.select([${JSON.stringify(solid)}]); a.seek(0);`);
    await js('document.querySelector("[data-test=tool-select]").click()');
    await settle();
    await rclick(solid);
    await menu('Capa de guía');
    await untilMain(() => !!layer(solid)?.guide, 'capa de guía');
    await until(`!!document.querySelector('[data-test=layer-row][data-layer=${JSON.stringify(solid)}] [data-test=layer-guide-ic]')`, 5000);
    await settle();
    assert(await white(200, 100), 'la capa de guía se ve en el panel');
    // menu again: switched off
    await rclick(solid);
    await menu('✓ Capa de guía');
    await untilMain(() => !layer(solid)?.guide, 'guía desactivada');
  });

  await step('Capas: Composición ▸ Diseño interactivo: tiempo ▸ Crear Intro; el marcador protegido en la regla y su diálogo', async () => {
    await js('window.__adv.adv.seek(1)');
    await wait(150);
    await js('document.querySelector("[data-test=adv-comp-menu]").click()');
    await menu('Diseño interactivo: tiempo');
    await menu('Crear Intro');
    await untilMain(() => comp()!.markers.length === 1, 'marcador de intro');
    const m = comp()!.markers[0];
    assert(m.t === 0 && Math.abs((m.dur ?? 0) - 1) < 1e-6 && m.protected, JSON.stringify(m));
    await wait(400);
    // the protected band is drawn on the ruler (light blue under the marker)
    const blue = await js<number[]>(`const r = document.querySelector('[data-test=adv-ruler]'); const k = devicePixelRatio || 1; const g = r.getContext('2d'); let best = [0, 0, 0]; for (let x = 6; x < r.width * 0.2; x += 2) { const p = [...g.getImageData(x, Math.round(21 * k), 1, 1).data]; if (p[2] - p[0] > best[2] - best[0]) best = p; } return best;`);
    assert(blue[2] > blue[0] + 30, `banda de zona protegida ${blue}`);
    // double-click on the marker: its dialog; switch the protected region off there
    await js(`const r = document.querySelector('[data-test=adv-ruler]').getBoundingClientRect(); document.querySelector('[data-test=adv-ruler]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 1, clientY: r.top + 15 }));`);
    await until('document.querySelector("[data-test=marker-ok]")', 5000);
    assert(await js<boolean>('return document.querySelector("[data-test=marker-protected]").checked'), 'casilla Zona protegida');
    await js('document.querySelector("[data-test=marker-name]").value = "Entrada"; document.querySelector("[data-test=marker-protected]").checked = false; document.querySelector("[data-test=marker-ok]").click();');
    await untilMain(() => comp()!.markers[0].name === 'Entrada' && !comp()!.markers[0].protected, 'marcador editado');
    // * of the numeric keypad: a comp marker at the current time
    await js('A.key("*", { code: "NumpadMultiply" })');
    await untilMain(() => comp()!.markers.length === 2 && comp()!.markers[1].t === 1, 'marcador con *');
  });

  await step('Capas: Ctrl+Mayús+X separa la comp. del entorno de trabajo', async () => {
    await js(`const a = window.__adv.adv; const w = a.begin(); w.workArea = [1, 3]; a.commit('Área de trabajo');`);
    await untilMain(() => comp()!.workArea[0] === 1, 'área de trabajo');
    await settle();
    await js('A.key("X", { ctrl: true, shift: true })');
    await untilMain(() => comp()!.duration === 2, 'duración 2 s');
    assert(comp()!.markers.map((m) => m.t).join() === '0', `marcadores ${comp()!.markers.map((m) => m.t)}`);
    assert(layer(solid)!.start === -1, `inicio de la capa ${layer(solid)!.start}`);
  });

  await step('Capas: botón Región de interés — dibujarla, solo se dibuja esa zona; Alt+clic la restablece', async () => {
    await js('window.__adv.adv.seek(0)');
    await settle();
    assert(await white(130, 100) && await white(270, 100), 'sólido entero');
    await js('document.querySelector("[data-test=adv-roi]").click()');
    await js('A.drag("[data-test=adv-stage]", A.comp(180, 60), A.comp(300, 140))');
    await untilMain(() => !!comp()!.roi?.on, 'región de interés');
    const r = comp()!.roi!.rect;
    assert(Math.abs(r[0] - 180) < 3 && Math.abs(r[2] - 120) < 3, `rect ${r}`);
    await settle();
    await until('window.__adv.adv.comp().roi && document.querySelector("[data-test=adv-roi]").classList.contains("on")', 5000);
    await wait(600);
    assert(await white(250, 100), 'dentro se dibuja');
    assert(!(await white(130, 100)), 'fuera no se dibuja');
    await js('document.querySelector("[data-test=adv-roi]").dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }))');
    await untilMain(() => !comp()!.roi, 'restablecida');
    await settle();
    await wait(400);
    assert(await white(130, 100), 'otra vez entera');
  });

  await step('Capas: máscara con RotoBézier (casilla de la fila) y herramienta Calado de máscara (G alterna con la Pluma)', async () => {
    const m = (await inv(`'maskAdd', ${JSON.stringify(compId)}, ${JSON.stringify(solid)}, { shape: 'rect', x: 40, y: 20, width: 120, height: 60 }`)).id;
    await untilMain(() => layer(solid)!.masks.length === 1, 'máscara');
    await js(`window.__adv.adv.select([${JSON.stringify(solid)}])`);
    // open the layer and its masks to reach the mask row
    await js(`document.querySelector('[data-test=layer-row][data-layer=${JSON.stringify(solid)}] [data-test=layer-twisty]').click()`);
    await wait(300);
    await js(`const g = [...document.querySelectorAll('#adv .row')].find((e) => e.textContent.includes('Máscaras')); g.querySelector('button').click();`);
    await until('!!document.querySelector("[data-test=mask-roto]")', 5000);
    await js('const b = document.querySelector("[data-test=mask-roto]"); b.checked = true; b.dispatchEvent(new Event("change"));');
    await untilMain(() => !!layer(solid)!.masks[0].rotoBezier, 'RotoBézier');
    await js('document.querySelector("[data-test=tool-pen]").click()');
    await js('A.key("g")');
    await until('window.__adv.adv.tool === "feather"', 3000);
    // the top edge of the mask (layer y 20) is at comp y 70; with RotoBézier (33 %) its middle bulges up to y 62.5:
    // drag from there 15 px up
    await settle();
    void m;
    await js('A.drag("[data-test=adv-stage]", A.comp(200, 62.5), A.comp(200, 47.5))');
    await untilMain(() => (layer(solid)!.masks[0].featherPts?.length ?? 0) === 1, 'punto de calado', 8000);
    const f = layer(solid)!.masks[0].featherPts![0];
    assert(f.seg === 0 && f.r > 8 && f.r < 25, `punto ${JSON.stringify(f)}`);
    await js('A.key("g")');
    await until('window.__adv.adv.tool === "pen"', 3000);
    await js('document.querySelector("[data-test=tool-select]").click()');
  });

  await step('Capas: Añadir ▸ «Transformación de ondulación» en una forma (propiedades en la línea de tiempo)', async () => {
    const r = await js<{ layer: { id: string }; shape: { id: string } }>(`return await window.cinta.invoke('motion', 'shapeAdd', ${JSON.stringify(compId)}, undefined, { kind: 'rect', width: 40, height: 40, color: '#ff0000' })`);
    await untilMain(() => !!layer(r.layer.id), 'capa de forma');
    await js(`window.__adv.adv.select([${JSON.stringify(r.layer.id)}])`);
    await js(`document.querySelector('[data-test=layer-row][data-layer=${JSON.stringify(r.layer.id)}] [data-test=layer-twisty]').click()`);
    await wait(300);
    await js(`const g = [...document.querySelectorAll('#adv .row')].find((e) => e.textContent.includes('Contenido')); g.querySelector('button').click();`);
    await until('!!document.querySelector("[data-test=shape-add]")', 5000);
    await js('document.querySelector("[data-test=shape-add]").click()');
    await menu('Transformación de ondulación');
    await untilMain(() => !!layer(r.layer.id)?.shapes?.[0].wiggleTransform, 'transformación de ondulación');
    await until(`[...document.querySelectorAll('#adv .row')].some((e) => e.textContent.includes('Ondulación: correlación'))`, 5000);
  });
}
