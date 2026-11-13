// Self-test, third part: the advanced mode (After Effects-style) driven through its real UI — mode switch,
// templates, viewer tools, layer timeline, keyframes, effects/presets panels, expressions, RAM preview, export
// and the bridge back to the simple timeline. Results are checked on the project model and on pixels.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Editor, newProject, type motion } from '../core';
import type { Ctx } from './selftest-panels';
import { velocidadSteps } from './selftest-velocidad';
import { modelos3dSteps } from './selftest-modelos3d';
import { extrusionSteps } from './selftest-extrusion';
import { paintSteps } from './selftest-pintura';
import { datosSteps } from './selftest-datos';
import { importacionSteps } from './selftest-importacion';
import { vectoresSteps } from './selftest-vectores';
import { textoSteps } from './selftest-texto';
import { capasSteps } from './selftest-capas';
import { analisisSteps } from './selftest-analisis';
import { iaSteps } from './selftest-ia';
import { particulasSteps } from './selftest-particulas';
import { panelesSteps } from './selftest-paneles';

export async function advancedSteps(x: Ctx) {
  const { js, until, wait, step, assert, dir } = x;
  const say = (t: string) => (x as Ctx & { say?: (t: string) => void }).say?.(t);
  const P = () => x.host.editor.project;
  const comp = () => (P().comps ?? []).find((c) => c.id === (P().comps ?? [])[0]?.id) as motion.Comp | undefined;
  const untilMain = async (fn: () => boolean, what: string, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  // page helpers: pointer gestures in client coordinates, comp → client, pixel of the viewer
  await js(`window.A = {
    pt(sel, fx, fy) { const r = document.querySelector(sel).getBoundingClientRect(); return [r.left + r.width * fx, r.top + r.height * fy]; },
    comp(x, y) { return window.__adv.compToClient(x, y); },
    drag(sel, a, b, o = {}) {
      const el = document.querySelector(sel);
      const ev = (type, p) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, clientX: p[0], clientY: p[1], shiftKey: !!o.shift }));
      ev('pointerdown', a);
      for (let i = 1; i <= 8; i++) ev('pointermove', [a[0] + (b[0] - a[0]) * i / 8, a[1] + (b[1] - a[1]) * i / 8]);
      ev('pointerup', b);
    },
    key(k, o = {}) { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: o.code ?? '', bubbles: true, ctrlKey: !!o.ctrl, shiftKey: !!o.shift, altKey: !!o.alt })); },
    pixel(x, y) { const c = document.querySelector('.adv-screen'); const p = window.__adv.compToClient(x, y); const r = c.getBoundingClientRect(); const k = c.width / r.width; return [...c.getContext('2d').getImageData(Math.round((p[0] - r.left) * k), Math.round((p[1] - r.top) * k), 1, 1).data]; },
    rows() { return [...document.querySelectorAll('#adv .row')].map((e) => e.className.replace('row ', '') + ':' + (e.querySelector('.nm')?.textContent ?? '')); },
    dbl(sel) { document.querySelector(sel).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); },
  };`);
  const adv = <T = unknown>(code: string) => js<T>(`const a = window.__adv.adv; ${code}`);
  const settle = async () => { await wait(250); await until('!window.__adv || !window.__adv.adv.work', 5000); };

  x.host.attach(new Editor(newProject({ width: 1280, height: 720 })));
  await wait(400);

  await step('Modo avanzado: el interruptor cambia toda la ventana (y vuelve al simple)', async () => {
    await js('document.querySelector("[data-test=mode-adv]").click()');
    await until('document.body.classList.contains("mode-adv") && getComputedStyle(document.getElementById("adv")).display === "grid"');
    assert(await js('return getComputedStyle(document.getElementById("app")).display === "none"'), 'el editor simple debe ocultarse');
    assert(await js('return !!document.querySelector("[data-test=adv-empty]") && getComputedStyle(document.querySelector("[data-test=adv-empty]")).display === "flex"'), 'pantalla de inicio sin composiciones');
    await js('document.querySelector("#adv [data-test=mode-simple]").click()');
    await until('!document.body.classList.contains("mode-adv") && getComputedStyle(document.getElementById("app")).display !== "none"');
    await js('document.querySelector("#status [data-test=mode-adv]").click()');
    await until('document.body.classList.contains("mode-adv")');
  });

  await step('Plantilla «Título cinético» desde la pantalla de inicio: se dibuja y se recorre', async () => {
    await js('document.querySelector("[data-test=tpl-kinetic]").click()');
    await untilMain(() => (comp()?.layers.length ?? 0) >= 4, 'plantilla');
    await until('window.__adv.adv.compId && !document.getElementById("adv-viewer").classList.contains("empty")');
    // drag the playhead on the ruler to ~2 s
    await js('const r = document.querySelector("[data-test=adv-ruler]").getBoundingClientRect(); A.drag("[data-test=adv-ruler]", [r.left + 4, r.top + 25], [r.left + r.width * 2 / 6, r.top + 25])');
    await until('Math.abs(window.__adv.adv.time - 2) < 0.15');
    await wait(500);
    const px = await js<number[]>('let best = [0, 0, 0]; for (let x = 300; x <= 980; x += 6) for (const y of [300, 320, 340]) { const p = A.pixel(x, y); if (p[0] + p[1] + p[2] > best[0] + best[1] + best[2]) best = p; } return best;');
    const tc = await js<string>('return document.querySelector("[data-test=adv-tc]").textContent');
    assert(/0:00:0[12]:/.test(tc), `código de tiempo ${tc}`);
    assert(px[0] + px[1] + px[2] > 300, `el título se ve en 2 s (píxel ${px})`);
    const rows = await js<string[]>('return A.rows()');
    assert(rows.filter((r) => r.startsWith('layer')).length === comp()!.layers.length, 'una fila por capa');
  });

  await step('Herramientas del visor: rectángulo → capa de forma; arrastrar con Selección la mueve (un paso de deshacer)', async () => {
    await js('document.querySelector("[data-test=tool-rect]").click()');
    await js('A.drag(".adv-stage", A.comp(100, 500), A.comp(300, 650))');
    await untilMain(() => comp()!.layers[0].type === 'shape', 'capa de forma');
    const sh = comp()!.layers[0];
    const size = sh.shapes![0].size.v;
    assert(Math.abs(size[0] - 200) < 6 && Math.abs(size[1] - 150) < 6, `rectángulo de 200×150 (${size})`);
    await js('document.querySelector("[data-test=tool-select]").click()');
    await settle();
    const p0 = [...(sh.transform.position.v as number[])];
    const undo0 = x.host.editor.canUndo;
    await js('A.drag(".adv-stage", A.comp(200, 575), A.comp(400, 475))');
    await untilMain(() => { const l = comp()!.layers.find((q) => q.id === sh.id)!; return Math.abs((l.transform.position.v as number[])[0] - p0[0] - 200) < 4; }, 'mover 200 px');
    const l = comp()!.layers.find((q) => q.id === sh.id)!;
    assert(Math.abs((l.transform.position.v as number[])[1] - p0[1] + 100) < 4, 'y −100 px');
    assert(undo0, 'hay historial');
    await js('A.key("z", { ctrl: true })');
    await untilMain(() => { const q = comp()!.layers.find((z) => z.id === sh.id)!; return Math.abs((q.transform.position.v as number[])[0] - p0[0]) < 1; }, 'deshacer el movimiento');
  });

  await step('Texto: herramienta Texto crea la capa y se escribe sobre el visor', async () => {
    await js('document.querySelector("[data-test=tool-text]").click()');
    // Shift+click: a new text layer even over the template's text (a plain click there would edit it)
    await js('const p = A.comp(640, 200); A.drag(".adv-stage", p, p, { shift: true })');
    await until('document.querySelector("[data-test=adv-text-edit]")', 8000);
    await js('const t = document.querySelector("[data-test=adv-text-edit]"); t.value = "Hola Cinta"; t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))');
    await untilMain(() => comp()!.layers.some((l) => l.type === 'text' && l.text!.text.v === 'Hola Cinta'), 'texto escrito');
    await js('document.querySelector("[data-test=tool-select]").click()');
  });

  await step('Línea de tiempo: desplegar, cronómetro (clave), arrastrar el valor, F9 (Easy Ease) y J/K', async () => {
    const id = comp()!.layers.find((l) => l.type === 'text' && l.text!.text.v === 'Hola Cinta')!.id;
    await adv(`a.select([${JSON.stringify(id)}]); a.seek(0);`);
    await js('A.key("p")'); // reveal Position only
    await until('document.querySelector("[data-test=\'sw-transform.position\']")');
    await js('document.querySelector("[data-test=\'sw-transform.position\']").click()');
    await untilMain(() => (comp()!.layers.find((l) => l.id === id)!.transform.position.k?.length ?? 0) === 1, 'cronómetro: primera clave');
    await adv('a.seek(1);');
    await settle();
    await until('document.querySelector("[data-test=\'pv-transform.position-0\']")');
    await js('const s = document.querySelector("[data-test=\'pv-transform.position-0\']"); const r = s.getBoundingClientRect(); A.drag("[data-test=\'pv-transform.position-0\']", [r.left + 5, r.top + 5], [r.left + 125, r.top + 5])');
    await untilMain(() => (comp()!.layers.find((l) => l.id === id)!.transform.position.k?.length ?? 0) === 2, 'arrastrar el valor crea la segunda clave');
    const k = comp()!.layers.find((l) => l.id === id)!.transform.position.k!;
    assert(Math.abs((k[1].v as number[])[0] - (k[0].v as number[])[0] - 120) < 3, `+120 px (${JSON.stringify(k.map((q) => q.v))})`);
    // select both keys on the keyframe canvas and Easy Ease them
    await adv(`a.keys = [{ layer: ${JSON.stringify(id)}, path: 'transform.position', t: 0 }, { layer: ${JSON.stringify(id)}, path: 'transform.position', t: 1 }];`);
    await js('A.key("F9")');
    await untilMain(() => comp()!.layers.find((l) => l.id === id)!.transform.position.k!.every((q) => q.i === 'bezier'), 'F9');
    await adv('a.seek(0.5);');
    await js('A.key("j")');
    await until('Math.abs(window.__adv.adv.time) < 0.01');
    await js('A.key("k")');
    await until('Math.abs(window.__adv.adv.time - 1) < 0.01');
  });

  await step('Efectos y ajustes preestablecidos: doble clic aplica; Controles de efectos los edita', async () => {
    const id = comp()!.layers.find((l) => l.type === 'text' && l.text!.text.v === 'Hola Cinta')!.id;
    await adv(`a.select([${JSON.stringify(id)}]);`);
    await js('const s = document.querySelector("[data-test=adv-fx-search]"); s.value = "resplandor"; s.dispatchEvent(new Event("input"))');
    await until('document.querySelector("[data-test=adv-fx-glow]")');
    await js('A.dbl("[data-test=adv-fx-glow]")');
    await untilMain(() => comp()!.layers.find((l) => l.id === id)!.effects.some((f) => f.fx === 'glow'), 'resplandor');
    await until('document.querySelector("[data-test=fxbox-glow]")');
    await js('const s = document.querySelector("[data-test=adv-fx-search]"); s.value = "caída"; s.dispatchEvent(new Event("input"))');
    await until('document.querySelector("[data-test=adv-preset-dropChars]")');
    await js('A.dbl("[data-test=adv-preset-dropChars]")');
    await untilMain(() => (comp()!.layers.find((l) => l.id === id)!.text?.animators.length ?? 0) >= 1, 'preajuste de texto');
    // edit a parameter in Effect Controls by dragging its value
    await js('document.querySelector("[data-test=tab-controls]").click()');
    const before = comp()!.layers.find((l) => l.id === id)!.effects.find((f) => f.fx === 'glow')!.params.radius.v as number;
    await until('document.querySelector("[data-test=fxbox-glow] [data-test^=pv-effects][data-test$=radius]")');
    await js('const s = document.querySelector("[data-test=fxbox-glow] [data-test^=pv-effects][data-test$=radius]"); const r = s.getBoundingClientRect(); A.drag("[data-test=fxbox-glow] [data-test^=pv-effects][data-test$=radius]", [r.left + 5, r.top + 5], [r.left + 45, r.top + 5])');
    await untilMain(() => (comp()!.layers.find((l) => l.id === id)!.effects.find((f) => f.fx === 'glow')!.params.radius.v as number) > before + 30, 'radio del resplandor');
  });

  await step('Expresión escrita en la línea de tiempo (wiggle) y error de expresión visible', async () => {
    const id = comp()!.layers.find((l) => l.type === 'text' && l.text!.text.v === 'Hola Cinta')!.id;
    await adv(`a.select([${JSON.stringify(id)}]);`);
    await js('A.key("r")');
    await until('document.querySelector("[data-test=\'prop-transform.rotation\'] .ex")');
    await js('document.querySelector("[data-test=\'prop-transform.rotation\'] .ex").click()');
    await until('document.querySelector("[data-test=\'expr-transform.rotation\']")');
    await js('const t = document.querySelector("[data-test=\'expr-transform.rotation\']"); t.value = "wiggle(2, 30)"; t.dispatchEvent(new Event("change"))');
    await untilMain(() => comp()!.layers.find((l) => l.id === id)!.transform.rotation.x === 'wiggle(2, 30)', 'expresión guardada');
    await until('document.querySelector("[data-test=\'expr-transform.rotation\']")');
    await js('const t = document.querySelector("[data-test=\'expr-transform.rotation\']"); t.value = "noExiste + 1"; t.dispatchEvent(new Event("change"))');
    await until('document.querySelector(".expr-row .err")', 8000);
    await js('const t = document.querySelector("[data-test=\'expr-transform.rotation\']"); t.value = ""; t.dispatchEvent(new Event("change"))');
    await untilMain(() => !comp()!.layers.find((l) => l.id === id)!.transform.rotation.x, 'expresión quitada');
  });

  await step('Texto: «Animar ▸ Activar 3D por carácter» lo activa (y hace 3D la capa)', async () => {
    const id = comp()!.layers.find((l) => l.type === 'text' && l.text!.text.v === 'Hola Cinta')!.id;
    await adv(`a.select([${JSON.stringify(id)}]);`);
    // the twisty toggles (a layer showing only revealed properties closes first): click until the Text group shows
    for (let i = 0; i < 3 && !(await js<boolean>('return !!document.querySelector("[data-test=add-animator]")')); i++) {
      await js(`document.querySelector('[data-layer="${id}"] [data-test=layer-twisty]').click()`);
      await wait(250);
    }
    await until('document.querySelector("[data-test=add-animator]")');
    await js('document.querySelector("[data-test=add-animator]").click()');
    await until('[...document.querySelectorAll(".ctx button")].some((b) => b.textContent.includes("3D por carácter"))');
    await js('[...document.querySelectorAll(".ctx button")].find((b) => b.textContent.includes("3D por carácter")).click()');
    await untilMain(() => { const l = comp()!.layers.find((x) => x.id === id)!; return !!l.text!.perChar3D && l.threeD; }, '3D por carácter');
    await wait(400);
    // back to how the template was (the steps after this one expect a 2D text layer)
    await js(`return window.cinta.invoke('motion', 'layerSet', window.__adv.adv.compId, ${JSON.stringify(id)}, { threeD: false, text: { perChar3D: false } })`);
    await untilMain(() => !comp()!.layers.find((x) => x.id === id)!.threeD, 'capa 2D otra vez');
  });

  await step('Edición a mano: arrastrar un vértice de máscara, pluma con curvas y guías', async () => {
    const cid = comp()!.id;
    const l = await js<{ id: string }>(`return window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(cid)}, 'solid', { color: '#ff00ff', width: 1280, height: 720 })`);
    await js(`return window.cinta.invoke('motion', 'maskAdd', ${JSON.stringify(cid)}, ${JSON.stringify(l.id)}, { shape: 'rect', x: 400, y: 200, width: 400, height: 300 })`);
    await untilMain(() => comp()!.layers.some((q) => q.id === l.id && q.masks.length === 1), 'máscara');
    await adv(`a.select([${JSON.stringify(l.id)}]); a.tool = 'select'; a.emit('tool');`);
    await settle();
    await js('A.drag(".adv-stage", A.comp(400, 200), A.comp(500, 250))');
    await untilMain(() => { const m = comp()!.layers.find((q) => q.id === l.id)!.masks[0].path.v as number[]; return Math.abs(m[0] - 500) < 3 && Math.abs(m[1] - 250) < 3; }, 'vértice movido a (500, 250)');
    await js(`return window.cinta.invoke('motion', 'layerDelete', ${JSON.stringify(cid)}, [${JSON.stringify(l.id)}])`);
    // pen: a smooth point (click + drag), then a corner point, Enter → open curved path
    await adv('a.select([]);');
    await js('document.querySelector("[data-test=tool-pen]").click()');
    const n0 = comp()!.layers.length;
    await js('A.drag(".adv-stage", A.comp(300, 400), A.comp(380, 330))');
    await js('const p = A.comp(700, 400); A.drag(".adv-stage", p, p)');
    await js('A.key("Enter")');
    await untilMain(() => comp()!.layers.length === n0 + 1 && comp()!.layers[0].type === 'shape', 'trazado de pluma');
    const path = comp()!.layers[0].shapes![0].path.v as number[];
    assert(path.length === 12 && (Math.abs(path[4]) > 40 || Math.abs(path[5]) > 40), `punto suave con tiradores (${path.map((x) => Math.round(x)).join(',')})`);
    await js('document.querySelector("[data-test=tool-select]").click()');
    await js('document.querySelector("[data-test=adv-guides]").click()');
    assert(await js('return document.querySelector("[data-test=adv-guides]").classList.contains("on")'), 'guías activadas');
    await js('document.querySelector("[data-test=adv-guides]").click()');
  });

  await step('Marioneta (Ctrl+P): clic pone pines, arrastrar mueve uno con clave y la capa se dobla', async () => {
    const cid = comp()!.id;
    const l = await js<{ id: string }>(`return window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(cid)}, 'solid', { color: '#00ffff', width: 400, height: 60, name: 'Barra' })`);
    await untilMain(() => comp()!.layers[0].id === l.id, 'barra');
    await adv(`a.select([${JSON.stringify(l.id)}]); a.seek(0);`);
    await settle();
    await js('A.key("p", { ctrl: true })');
    await until('document.querySelector("[data-test=tool-puppet]").classList.contains("on")');
    // the bar spans x 440…840 at y 360: pin both ends
    await js('const p = A.comp(450, 360); A.drag(".adv-stage", p, p)');
    await untilMain(() => comp()!.layers.find((q) => q.id === l.id)!.puppet?.pins.length === 1, 'primer pin');
    await js('const p = A.comp(830, 360); A.drag(".adv-stage", p, p)');
    await untilMain(() => comp()!.layers.find((q) => q.id === l.id)!.puppet?.pins.length === 2, 'segundo pin');
    await settle();
    await js('A.drag(".adv-stage", A.comp(830, 360), A.comp(830, 200))');
    await untilMain(() => { const pin = comp()!.layers.find((q) => q.id === l.id)!.puppet!.pins[1]; return (pin.position.k?.length ?? 0) >= 1 && Math.abs((pin.position.k![0].v as number[])[1] - (200 - 330)) < 4; }, 'pin arrastrado con clave');
    await settle();
    const tip = await js<number[]>('return A.pixel(830, 210)'), oldTip = await js<number[]>('return A.pixel(830, 360)');
    assert(tip[1] > 150 && tip[2] > 150 && oldTip[1] < 120, `el extremo subió (${tip} arriba, ${oldTip} donde estaba)`);
    await js('document.querySelector("[data-test=tool-select]").click()');
    await js(`return window.cinta.invoke('motion', 'layerDelete', ${JSON.stringify(cid)}, [${JSON.stringify(l.id)}])`);
  });

  await step('Formas: «+ ▸» añade Ondular trazados y Zigzag desde la línea de tiempo (se animan y se ven)', async () => {
    const cid = comp()!.id;
    const r = await js<{ layer: { id: string } }>(`return window.cinta.invoke('motion', 'shapeAdd', ${JSON.stringify(cid)}, undefined, { kind: 'ellipse', width: 300, color: '#00ff00', name: 'Gota' })`);
    await untilMain(() => comp()!.layers[0].id === r.layer.id, 'capa de forma');
    await adv(`a.select([${JSON.stringify(r.layer.id)}]); a.seek(0.5);`);
    await settle();
    const clickRow = (label: string) => js(`const row = [...document.querySelectorAll('#adv .row.group')].find((e) => e.querySelector('.nm')?.textContent === ${JSON.stringify(label)}); if (!row) throw new Error('sin fila ' + ${JSON.stringify(label)}); if (!row.querySelector('.tw').classList.contains('open')) row.querySelector('.tw').click();`);
    await js('document.querySelector("#adv .row [data-test=layer-twisty]").click()');
    await until(`[...document.querySelectorAll('#adv .row.group .nm')].some((e) => e.textContent === 'Contenido')`);
    await clickRow('Contenido');
    await until(`[...document.querySelectorAll('#adv .row.group .nm')].some((e) => e.textContent === 'Gota')`);
    await clickRow('Gota');
    const menu = async (label: string) => {
      await js(`[...document.querySelectorAll('#adv .row.group')].find((e) => e.querySelector('.nm')?.textContent === 'Gota').querySelector('[data-test=shape-add]').click()`);
      await until('document.querySelector(".ctx")');
      await js(`const b = [...document.querySelectorAll('.ctx button')].find((e) => e.textContent === ${JSON.stringify(label)}); if (!b) throw new Error('sin opción ' + ${JSON.stringify(label)}); b.click();`);
    };
    const before = await js<number[]>('return A.pixel(640 + 158, 360)');
    await menu('Ondular trazados');
    await untilMain(() => !!comp()!.layers[0].shapes![0].wiggle, 'ondular en el modelo');
    await until(`A.rows().some((r) => r.endsWith(':Ondular: tamaño'))`);
    await menu('Zigzag');
    await untilMain(() => !!comp()!.layers[0].shapes![0].zigzag, 'zigzag en el modelo');
    await until(`A.rows().some((r) => r.endsWith(':Zigzag: crestas'))`);
    await settle();
    // the edge of the circle is no longer where it was: some pixels around it changed
    let changed = 0;
    for (let a = 0; a < 24; a++) { const p = await js<number[]>(`return A.pixel(${640 + Math.cos(a / 24 * Math.PI * 2) * 140}, ${360 + Math.sin(a / 24 * Math.PI * 2) * 140})`); if (p[1] < 120) changed++; }
    assert(changed >= 3, `el contorno se deforma (${changed}/24 puntos del borde fuera de la forma; antes ${before})`);
    await js('A.key("z", { ctrl: true })');
    await untilMain(() => !comp()!.layers[0].shapes![0].zigzag, 'deshacer el zigzag');
    await js(`return window.cinta.invoke('motion', 'layerDelete', ${JSON.stringify(cid)}, [${JSON.stringify(r.layer.id)}])`);
  });

  await step('Capas: Ctrl+D duplica, Supr elimina, modo de fusión y 3D desde la fila', async () => {
    const n0 = comp()!.layers.length;
    const id = comp()!.layers[0].id;
    await adv(`a.select([${JSON.stringify(id)}]);`);
    await js('A.key("d", { ctrl: true })');
    await untilMain(() => comp()!.layers.length === n0 + 1, 'duplicar');
    await adv(`a.select([a.comp().layers[0].id]);`);
    await js('A.key("Delete")');
    await untilMain(() => comp()!.layers.length === n0, 'eliminar');
    await until('document.querySelector("[data-test=layer-mode]")');
    await js('const s = document.querySelector("[data-test=layer-mode]"); s.value = "screen"; s.dispatchEvent(new Event("change"))');
    await untilMain(() => comp()!.layers[0].blend === 'screen', 'modo Trama');
    await js('document.querySelector("[data-test=layer-3d]").click()');
    await untilMain(() => comp()!.layers[0].threeD, 'capa 3D');
  });

  await step('Previsualización RAM: prepara el área de trabajo y reproduce en tiempo real', async () => {
    await js('window.__adv.adv.res = 0.25');
    await adv('a.seek(0);');
    await js('document.querySelector("[data-test=adv-ram]").click()');
    await until('window.__adv.adv.playing', 60000);
    const t0 = await js<number>('return window.__adv.adv.time');
    await wait(1000);
    const t1 = await js<number>('return window.__adv.adv.time');
    assert(t1 - t0 > 0.6 && t1 - t0 < 1.4 || t1 < t0, `avanza en tiempo real (${t0.toFixed(2)} → ${t1.toFixed(2)})`);
    await js('A.key(" ")');
    await until('!window.__adv.adv.playing');
    await js('window.__adv.adv.res = 0.5');
  });

  await step('Interpolación inteligente de máscaras: clic derecho en una clave de trazado, diálogo y Aplicar', async () => {
    const back = await js<string>('return window.__adv.adv.compId');
    const mc = await js<{ id: string }>(`return window.cinta.invoke('motion', 'compNew', { name: 'Máscaras', width: 200, height: 200, fps: 10, duration: 1 })`);
    const ml = await js<{ id: string }>(`return window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(mc.id)}, 'solid', { color: '#ffffff', width: 200, height: 200 })`);
    const mk = await js<{ id: string }>(`return window.cinta.invoke('motion', 'maskAdd', ${JSON.stringify(mc.id)}, ${JSON.stringify(ml.id)}, { shape: 'rect', x: 50, y: 50, width: 100, height: 100 })`);
    const poly = (p: number[][]) => p.flatMap(([x, y]) => [x, y, 0, 0, 0, 0]);
    const sq = poly([[50, 50], [150, 50], [150, 150], [50, 150]]);
    const tri = poly([[100, 30], [170, 170], [30, 170]]);
    await js(`return window.cinta.invoke('motion', 'propSet', ${JSON.stringify(mc.id)}, ${JSON.stringify(ml.id)}, ${JSON.stringify(`masks.${mk.id}.path`)}, { keys: [{ t: 0, v: ${JSON.stringify(sq)} }, { t: 0.8, v: ${JSON.stringify(tri)} }] })`);
    await untilMain(() => (P().comps?.find((c) => c.id === mc.id)?.layers[0]?.masks[0]?.path.k?.length ?? 0) === 2, 'claves de máscara');
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(mc.id)}; a.select([${JSON.stringify(ml.id)}]); a.emit('comp');`);
    await wait(300);
    await js('A.key("u")');
    const sel = `[data-test="prop-masks.${mk.id}.path"]`;
    await until(`document.querySelector(${JSON.stringify(sel)})`);
    // right-click the key at t = 0 (x = 0 with the time fitted) on its row
    await js(`const i = Number(document.querySelector(${JSON.stringify(sel)}).dataset.i); const cv = document.querySelector("[data-test=adv-keys]"); const r = cv.getBoundingClientRect(); cv.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 1, clientY: r.top + i * 22 + 11 }));`);
    await until('[...document.querySelectorAll(".ctx button")].some((b) => b.textContent.startsWith("Interpolación inteligente"))');
    await js('[...document.querySelectorAll(".ctx button")].find((b) => b.textContent.startsWith("Interpolación inteligente")).click()');
    await until('document.querySelector("[data-test=smi-apply]")');
    assert(await js<boolean>('return document.querySelector("[data-test=smi-linear]").checked'), 'trayectorias lineales marcadas por defecto (como After Effects)');
    await js('document.querySelector("[data-test=smi-apply]").click()');
    await untilMain(() => (P().comps?.find((c) => c.id === mc.id)?.layers[0]?.masks[0]?.path.k?.length ?? 0) === 9, 'claves intermedias (7 entre 0 y 0,8 s)');
    const mid = P().comps!.find((c) => c.id === mc.id)!.layers[0].masks[0].path.k![4].v as number[];
    assert(mid.length / 6 > 40, `vértices añadidos: ${mid.length / 6}`);
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(back)}; a.emit('comp');`);
  });

  await step('Cola de render: el diálogo muestra el elemento, cambia la salida y lo renderiza', async () => {
    const id = comp()!.id;
    await js(`window.cinta.invoke('motion', 'queueAdd', ${JSON.stringify(id)}, { settings: { resolution: 0.25, span: [0, 0.4] }, outputs: [{ format: 'mp4' }] })`);
    await untilMain(() => (P().renderQueue?.length ?? 0) === 1, 'elemento en la cola');
    await js('document.querySelector("[data-test=adv-rq]").click()');
    await until('document.querySelectorAll(".rq-item").length === 1');
    const tpl = join(dir, 'Cola', '[compName]_ui.[fileExtension]');
    await js(`const i = document.querySelector(".rq-out input:not([type])"); i.value = ${JSON.stringify(tpl)}; i.dispatchEvent(new Event("change"));`);
    await untilMain(() => P().renderQueue?.[0]?.outputs[0].path === tpl, 'plantilla de salida');
    await until('document.querySelector(".rq-out input:not([type])")?.value.endsWith("_ui.[fileExtension]")');
    await js('document.querySelector("[data-test=rq-render]").click()');
    await untilMain(() => P().renderQueue?.[0]?.status === 'done', 'elemento renderizado', 180000);
    const file = P().renderQueue![0].log!.files[0];
    assert(existsSync(file) && file.endsWith(`${comp()!.name}_ui.mp4`), `archivo de la cola: ${file}`);
    await until('document.querySelector(".rq-st.done")');
    await js('document.querySelector(".modal header .ib").click()');
  });

  await step('Caché de disco: la previsualización RAM guarda los fotogramas, la línea azul los marca y se reutilizan', async () => {
    await js('window.cinta.invoke("cache:clear")');
    await js('window.__adv.adv.res = 0.25');
    await adv('a.seek(a.comp().workArea[0]);');
    await js('document.querySelector("[data-test=adv-ram]").click()');
    await until('window.__adv.adv.playing', 60000);
    await js('A.key(" ")');
    await until('!window.__adv.adv.playing');
    const c = comp()!, n = Math.round((c.workArea[1] - c.workArea[0]) * c.fps);
    // frames are written one by one in idle time after playback: report how far it got if it runs out of time
    const t0 = Date.now();
    let got = 0;
    while (Date.now() - t0 < 60000 && (got = await js<number>('return window.cinta.invoke("cache:info").then((i) => i.frames)')) < n) await wait(250);
    say(`    caché de disco: ${got}/${n} fotogramas en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (got < n) say(`    diagnóstico: ${await js<string>('return JSON.stringify({ w: window.__adv.diskWriteInfo(), errors: window.__adv.renderer.errors, res: window.__adv.adv.res, info: await window.cinta.invoke("cache:info") })')}`);
    assert(got >= n, `fotogramas en la caché de disco: ${got} de ${n}`);
    // the blue line under the ruler: read the pixel just under the work area at its middle
    await wait(800);
    const blue = await js<number[]>(`const r = document.querySelector("[data-test=adv-ruler]"); const g = r.getContext("2d"); const k = devicePixelRatio || 1; const x = (r.getBoundingClientRect().width) * 0.02; let best = [0, 0, 0]; for (let xx = 0; xx < r.width; xx += 4) { const p = [...g.getImageData(xx, Math.round(10.5 * k), 1, 1).data]; if (p[2] > 200 && p[0] < 120) { best = p; break; } } return best;`);
    assert(blue[2] > 200 && blue[0] < 120, `línea azul de caché: ${blue}`);
    // a frame that is on disk is shown without rendering
    await adv(`a.seek(a.comp().workArea[0] + 3 / a.comp().fps);`);
    await until('window.__adv.viewInfo.renderMs === 0', 5000);
    await js('window.__adv.adv.res = 0.5');
  });

  await velocidadSteps(x);

  await step('Exportar composición desde su diálogo (MP4) y llevarla al modo simple', async () => {
    const out = join(dir, 'Exportadas');
    await js('document.querySelector("[data-test=adv-export]").click()');
    await until('document.querySelector("[data-test=cexp-go]")');
    await js(`const n = document.querySelector("[data-test=cexp-name]"); n.value = "comp-ui"; const f = document.querySelector(".modal .fval input[style]"); f.value = ${JSON.stringify(out)}; const s = document.querySelector("[data-test=cexp-format]"); s.value = "mp4"; s.dispatchEvent(new Event("change"));`);
    await js('document.querySelector("[data-test=cexp-go]").click()');
    const file = join(out, 'comp-ui.mp4');
    await untilMain(() => existsSync(file) && readdirSync(out).length > 0, 'archivo exportado', 180000);
    await wait(1500);
    // composition → simple timeline (context menu of the project item)
    const id = comp()!.id;
    await js(`window.cinta.invoke('motion:toTimeline', ${JSON.stringify(id)})`);
    await untilMain(() => P().media.some((m) => m.compId === id) && P().clips.length > 0, 'clip de composición', 120000);
    await js('document.querySelector("#adv [data-test=mode-simple]").click()');
    await until('!document.body.classList.contains("mode-adv") && document.querySelectorAll(".track.main .clip").length >= 1');
  });
  await paintSteps(x);
  await datosSteps(x);
  await vectoresSteps(x);
  await analisisSteps(x);
  await modelos3dSteps(x);
  await extrusionSteps(x);
  await particulasSteps(x);
  await importacionSteps(x);
  await textoSteps(x);
  await iaSteps(x);
  await capasSteps(x);
  await panelesSteps(x);
}
