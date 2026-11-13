// Self-test of «datos y scripting» through the real UI: Importar ▸ Datos in the Project panel (the CSV appears there and
// an expression reads it: pixels), «Volver a cargar material de archivo» from its context menu (the animation
// follows the new file), and Archivo ▸ Scripts ▸ Ejecutar archivo de secuencias de comandos (the script's comp
// opens in the viewer, its output is shown, and one Ctrl+Z removes the whole script).
import { Menu } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './selftest-panels';
import { answers } from './testdialogs';

export async function datosSteps(x: Ctx) {
  const { js, until, wait, step, assert, dir } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  const pixel = async (cx: number, cy: number) => { await wait(400); await until('!window.__adv.adv.work', 5000); await wait(500); return js<number[]>(`return A.pixel(${cx}, ${cy})`); };
  const csv = join(dir, 'puntos.csv');
  let cid = '';

  await step('Datos: Importar ▸ Datos (CSV) lo pone en el panel Proyecto y una expresión footage().dataValue mueve la capa', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    writeFileSync(csv, 'n,x,"texto, con coma"\n0,100,"a ""b"""\n1,500,c\n');
    const c = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'compNew', { name: 'Datos', width: 640, height: 360, fps: 30, duration: 2, bg: '#000000' })`);
    cid = c.id;
    const l = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(cid)}, 'solid', { color: '#ffffff', width: 60, height: 60, name: 'Punto' })`);
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(cid)}; a.work = null; a.emit('comp'); a.seek(0);`);
    answers.open.push([csv]);
    await js('document.querySelector("[data-test=adv-import]").click()');
    await js(`const b = [...document.querySelectorAll('.ctx button')].find((e) => e.textContent.includes('Datos: JSON')); if (!b) throw new Error('sin opción Datos'); b.click();`);
    await untilMain(() => (P().dataItems ?? []).some((d) => d.name === 'puntos.csv'), 'archivo de datos importado');
    await until('[...document.querySelectorAll("[data-test=adv-data-item]")].some((e) => e.textContent.includes("puntos.csv") && e.textContent.includes("3 columnas × 2 filas"))');
    await js(`return window.cinta.invoke('motion', 'propSet', ${JSON.stringify(cid)}, ${JSON.stringify(l.id)}, 'position', { expression: '[footage("puntos.csv").dataValue([1, 0]), 180]' })`);
    const on = await pixel(100, 180), off = await pixel(320, 180);
    assert(on[0] > 200 && on[1] > 200 && off[0] < 40, `capa en x = 100 (dato de la fila 0): ${on} / centro ${off}`);
  });

  await step('Datos: «Volver a cargar material de archivo» en el menú contextual lee el CSV de nuevo y la capa se mueve', async () => {
    writeFileSync(csv, 'n,x\n0,540\n');
    await js(`const it = [...document.querySelectorAll("[data-test=adv-data-item]")].find((e) => e.textContent.includes("puntos.csv")); const r = it.getBoundingClientRect(); it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5 }));`);
    await js(`const b = [...document.querySelectorAll('.ctx button')].find((e) => e.textContent.includes('Volver a cargar material de archivo')); if (!b) throw new Error('sin opción'); b.click();`);
    await untilMain(() => (P().dataItems ?? []).find((d) => d.name === 'puntos.csv')?.text.includes('540') === true, 'datos vueltos a cargar');
    await js('window.__adv.adv.seek(0)');
    const now = await pixel(540, 180), old = await pixel(100, 180);
    assert(now[0] > 200 && old[0] < 40, `capa en x = 540 tras volver a cargar: ${now} / antes ${old}`);
  });

  await step('Scripts: Archivo ▸ Scripts ▸ Ejecutar archivo de secuencias de comandos: crea la composición, muestra la salida y Ctrl+Z la deshace entera', async () => {
    const jsx = join(dir, 'crear.jsx');
    writeFileSync(jsx, [
      '#target aftereffects',
      'app.beginUndoGroup("Desde el menú");',
      'var comp = app.project.items.addComp("Por script", 640, 360, 1, 2, 30);',
      'var s = comp.layers.addSolid([0, 1, 0], "Verde", 100, 100, 1);',
      's.property("Transform").property("Position").setValuesAtTimes([0, 1], [[160, 180], [480, 180]]);',
      'var fx = s.property("ADBE Effect Parade").addProperty("ADBE Fill"); fx.property("Color").setValue([0, 1, 0]);',
      '$.writeln("Composición: " + comp.name + ", capas: " + comp.numLayers);',
      'app.endUndoGroup();',
    ].join('\n'));
    const before = (P().comps ?? []).length;
    answers.open.push([jsx]);
    const item = Menu.getApplicationMenu()?.getMenuItemById('run-script');
    assert(item && item.label === 'Ejecutar archivo de secuencias de comandos…', 'opción de menú');
    item!.click();
    await untilMain(() => (P().comps ?? []).some((c) => c.name === 'Por script'), 'composición del script');
    await until('document.querySelector("[data-test=script-log]")?.textContent.includes("Composición: Por script, capas: 1")');
    const comp = P().comps!.find((c) => c.name === 'Por script')!;
    const s = comp.layers[0];
    assert(s.name === 'Verde' && s.transform.position.k?.length === 2 && s.effects[0]?.fx === 'fill', JSON.stringify({ n: s.name, k: s.transform.position.k, fx: s.effects.map((f) => f.fx) }));
    await until(`window.__adv.adv.compId === ${JSON.stringify(comp.id)}`);
    await js('document.querySelector("[data-test=script-ok]").click()');
    await js('window.__adv.adv.seek(0)');
    const px = await pixel(160, 180);
    assert(px[1] > 200 && px[0] < 60, `sólido verde en la composición abierta: ${px}`);
    await js('A.key("z", { ctrl: true })');
    await untilMain(() => (P().comps ?? []).length === before && !(P().comps ?? []).some((c) => c.name === 'Por script'), 'deshacer el script entero');
    const back = (P().comps ?? []).find((c) => c.id === cid);
    assert(back && (P().dataItems ?? []).length === 1, 'lo anterior al script sigue');
  });
}
