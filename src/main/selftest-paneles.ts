// Self-test of the «paneles» line through the real UI: the Keyboard Shortcuts editor (reassign with conflict, save a
// set in the preferences, the new key works, back to the default set), view layouts and 3D views (wireframes in a
// second view, F10 / Esc, Camera Orbit on the camera layer with one undo step, orbiting a custom view), the
// Flowchart (nodes, double-click opens), the Properties panel editing a layer, the Media Browser (browse, preview,
// metadata in the Metadata panel, import by double-click).
import { join } from 'node:path';
import { runFfmpeg } from '../core';
import type { Ctx } from './selftest-panels';

export async function panelesSteps(x: Ctx) {
  const { js, until, wait, step, assert, dir } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  const settle = async () => { await wait(250); await until('!window.__adv || !window.__adv.adv.work', 5000); };
  const V = <T = unknown>(code: string) => js<T>(`const V = window.__paneles; ${code}`);
  let cid = '', card = '', camId = '';
  const comp = () => P().comps!.find((c) => c.id === cid)!;

  await step('Paneles: Métodos abreviados de teclado — reasignar con conflicto, guardar el conjunto y usar la tecla nueva', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    await js('A.key("\'", { ctrl: true, alt: true })');
    await until('document.querySelector("[data-test=kse]")');
    assert(await js('return document.querySelector("[data-test=kse-key-F9]").classList.contains("app") && !document.querySelector("[data-test=kse-key-F1]").classList.contains("app")'), 'F9 morada, F1 libre');
    // Shift+V for the Hand tool: taken from nobody; then V (Selection's) for Unhide… reassign V → conflict
    await js('document.querySelector("[data-test=kse-add-tool-hand]").click()');
    await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "V", code: "KeyV", shiftKey: true, bubbles: true }))');
    await until('[...document.querySelectorAll("[data-test=kse-chip-tool-hand]")].some((e) => e.dataset.combo === "Shift+V")');
    await js('document.querySelector("[data-test=kse-add-reveal-animated]").click()');
    await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", code: "KeyP", bubbles: true }))');
    await until('document.querySelector("[data-test=kse-msg]").textContent.includes("Se ha eliminado")');
    assert(!(await js('return !!document.querySelector("[data-test=kse-chip-reveal-position]")')), 'P quitada de Mostrar Posición');
    await js('document.querySelector("[data-test=kse-goto]").click()');
    await until('document.querySelector("[data-test=kse-cmd-reveal-position]").classList.contains("sel")');
    // the visual keyboard with Shift: V is coloured
    await js('document.querySelector("[data-test=kse-key-Shift]").click()');
    await until('document.querySelector("[data-test=kse-key-V]").classList.contains("app")');
    await js('const n = document.querySelector("[data-test=kse-name]"); n.value = "Prueba"; document.querySelector("[data-test=kse-saveas]").click()');
    await until('document.querySelector("[data-test=kse-set]").value === "Prueba"');
    await js('document.querySelector("[data-test=kse-ok]").click()');
    await until('!document.querySelector("[data-test=kse]")');
    const pr = await js<{ settings: { advShortcuts?: { current: string; sets: Record<string, Record<string, string[]>> } } }>('return window.cinta.invoke("prefs:get")');
    const sc = pr.settings.advShortcuts!;
    assert(sc.current === 'Prueba' && sc.sets.Prueba['tool-hand'].includes('Shift+V') && sc.sets.Prueba['reveal-position'].length === 0, JSON.stringify(sc));
    await js('A.key("V", { shift: true, code: "KeyV" })');
    await until('window.__adv.adv.tool === "hand"');
    // back to the default set (read-only): Shift+V does nothing, V selects
    await js('A.key("\'", { ctrl: true, alt: true })');
    await until('document.querySelector("[data-test=kse-set]")');
    await js('const s = document.querySelector("[data-test=kse-set]"); s.value = "Conjunto predeterminado"; s.dispatchEvent(new Event("change")); document.querySelector("[data-test=kse-ok]").click();');
    await until('!document.querySelector("[data-test=kse]") && window.__paneles.shortcuts().current === "Conjunto predeterminado"');
    await js('A.key("V", { code: "KeyV" })');
    await until('window.__adv.adv.tool === "select"');
  });

  await step('Paneles: 2 vistas — la vista Izquierda dibuja la malla de la cámara; F10 / Esc cambian la vista 3D', async () => {
    const c = await js<{ id: string }>('return window.cinta.invoke("motion", "compNew", { name: "Vistas 3D", width: 640, height: 360, fps: 30, duration: 2, bg: "#000000" })');
    cid = c.id;
    card = (await js<{ id: string }>(`return window.cinta.invoke("motion", "layerAdd", ${JSON.stringify(cid)}, "solid", { color: "#ff0000", width: 160, height: 160, name: "Tarjeta" })`)).id;
    await js(`return window.cinta.invoke("motion", "layerSet", ${JSON.stringify(cid)}, ${JSON.stringify(card)}, { threeD: true })`);
    camId = (await js<{ id: string }>(`return window.cinta.invoke("motion", "layerAdd", ${JSON.stringify(cid)}, "camera", {})`)).id;
    await js(`return window.cinta.invoke("motion", "layerAdd", ${JSON.stringify(cid)}, "light", {})`);
    await untilMain(() => comp()?.layers.length === 3, 'capas 3D');
    await js(`const s = document.querySelector("[data-test=adv-comp-sel]"); s.value = ${JSON.stringify(cid)}; s.dispatchEvent(new Event("change"));`);
    await until(`window.__adv.adv.compId === ${JSON.stringify(cid)}`);
    await js('const s = document.querySelector("[data-test=adv-layout]"); s.value = "2"; s.dispatchEvent(new Event("change"));');
    await until('document.querySelectorAll("[data-test=adv-pane]").length === 1 && window.__paneles.views().views.join() === "left,active"');
    // wireframe pixels of the camera (pink label colour) in the Left view
    await wait(1500);
    const pink = await js<number>('const cv = document.querySelector("[data-test=adv-pane] canvas"); const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 140 && d[i + 2] > 120) n++; return n;');
    assert(pink > 30, `malla de la cámara en la vista Izquierda: ${pink} píxeles`);
    // the composition viewer becomes the active view; F10 = Front, Esc = back to the last 3D view
    await js('document.getElementById("adv-viewer").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 2 }))');
    await until('window.__paneles.views().active === 1');
    await js('A.key("F10")');
    await until('window.__paneles.views().views[1] === "front" && document.querySelector("#adv-viewer .adv-vsel").value === "front"');
    await js('A.key("Escape")');
    await until('window.__paneles.views().views[1] === "active"');
  });

  await step('Paneles: Cámara orbital (1) mueve la cámara en la vista activa (un paso de deshacer) y orbita una vista personalizada', async () => {
    const pos0 = [...(comp().layers.find((l) => l.id === camId)!.transform.position.v as number[])];
    await js('A.key("1", { code: "Digit1" })');
    await until('window.__adv.adv.tool === "orbit"');
    await js('A.drag(".adv-stage", A.pt(".adv-stage", 0.5, 0.5), A.pt(".adv-stage", 0.7, 0.5))');
    await settle();
    await untilMain(() => { const p = comp().layers.find((l) => l.id === camId)!.transform.position.v as number[]; return Math.abs(p[0] - pos0[0]) > 50; }, 'cámara orbitada');
    await js('A.key("z", { ctrl: true })');
    await untilMain(() => { const p = comp().layers.find((l) => l.id === camId)!.transform.position.v as number[]; return Math.abs(p[0] - pos0[0]) < 1e-6; }, 'deshacer la órbita');
    // Custom View 1 in the other view, orbited by dragging in it
    await js('const s = document.querySelector("[data-test=adv-pane] .adv-vsel"); s.value = "custom1"; s.dispatchEvent(new Event("change"));');
    await until('window.__paneles.views().views[0] === "custom1"');
    await until(`!!window.__paneles.views().states[${JSON.stringify(cid + '|custom1')}]`);
    const yaw0 = await V<number>(`return V.views().states[${JSON.stringify(cid + '|custom1')}].yaw`);
    await js('A.drag("[data-test=adv-pane]", A.pt("[data-test=adv-pane]", 0.5, 0.5), A.pt("[data-test=adv-pane]", 0.6, 0.5))');
    await until(`Math.abs(window.__paneles.views().states[${JSON.stringify(cid + '|custom1')}].yaw - (${yaw0})) > 5`);
    await js('A.key("V", { code: "KeyV" })');
    await js('const s = document.querySelector("[data-test=adv-layout]"); s.value = "4"; s.dispatchEvent(new Event("change"));');
    await until('document.querySelectorAll("[data-test=adv-pane]").length === 3 && window.__paneles.views().views.join() === "top,front,right,active"');
    await js('const s = document.querySelector("[data-test=adv-layout]"); s.value = "1"; s.dispatchEvent(new Event("change"));');
    await until('document.querySelectorAll("[data-test=adv-pane]").length === 0');
  });

  await step('Paneles: Diagrama de flujo de la composición — nodos y doble clic abre la composición', async () => {
    await js('document.querySelector("[data-test=adv-flow-btn]").click()');
    await until('document.querySelector("#adv-flow.on") && document.querySelectorAll("[data-test=flow-node-layer]").length === 3');
    assert((await js<number>('return document.querySelectorAll("[data-test=flow-node-comp]").length')) === 1, 'una composición');
    await js('document.querySelector("[data-test=flow-layers]").click()');
    await until('document.querySelectorAll("[data-test=flow-node-layer]").length === 0');
    await js('document.querySelector("[data-test=flow-layers]").click()');
    // the project flowchart (Ctrl+F11) shows every comp
    await js('A.key("F11", { ctrl: true })');
    await until(`document.querySelectorAll("[data-test=flow-node-comp]").length === ${P().comps!.length}`);
    await js(`const g = document.querySelector('[data-test=flow-node-comp][data-id="c:${cid}"]'); g.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
    await until(`!document.querySelector("#adv-flow.on") && window.__adv.adv.compId === ${JSON.stringify(cid)}`);
  });

  await step('Paneles: Propiedades — transformación de la capa seleccionada (opacidad y rotaciones 3D)', async () => {
    await js('document.querySelector("[data-test=tab-properties]").click()');
    await js(`window.__adv.adv.select([${JSON.stringify(card)}])`);
    await until('document.querySelector("[data-test=props-sec-transform]") && document.querySelector("[data-test=\'props-pv-transform.rotationX\']")');
    await js('const s = document.querySelector("[data-test=\'props-pv-transform.opacity\']"); s.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 5 })); s.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 5 }));');
    await until('document.querySelector(".props-pane .scrub-in")');
    await js('const i = document.querySelector(".props-pane .scrub-in"); i.value = "40"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));');
    await settle();
    await untilMain(() => comp().layers.find((l) => l.id === card)!.transform.opacity.v === 40, 'opacidad 40');
  });

  await step('Paneles: Navegador de medios — carpeta, vista previa, Metadatos y doble clic importa', async () => {
    const folder = join(dir, 'Navegador');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(folder, { recursive: true });
    const vid = join(folder, 'barras.mp4');
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', vid]);
    await js('document.querySelector("[data-test=tab-mediabrowser]").click()');
    await V(`return V.browseTo(${JSON.stringify(folder)})`);
    await until('[...document.querySelectorAll("[data-test=mb-entry]")].some((e) => e.dataset.path.endsWith("barras.mp4"))');
    await js('document.querySelector("[data-test=tab-metadata]").click()');
    await js('[...document.querySelectorAll("[data-test=mb-entry]")].find((e) => e.dataset.path.endsWith("barras.mp4")).click()');
    await until('document.querySelector("[data-test=mb-prev-video]")');
    await until('[...document.querySelectorAll("#adv [data-test=md-body] .md-r")].some((r) => r.textContent.includes("320 × 180"))', 15000);
    await js('const s = document.querySelector("[data-test=md-search]"); s.value = "códec"; s.dispatchEvent(new Event("input"));');
    await until('document.querySelectorAll("#adv [data-test=md-body] .md-r").length >= 1 && ![...document.querySelectorAll("#adv [data-test=md-body] .md-r")].some((r) => r.textContent.includes("320 × 180"))');
    await js('[...document.querySelectorAll("[data-test=mb-entry]")].find((e) => e.dataset.path.endsWith("barras.mp4")).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
    await untilMain(() => P().media.some((m) => m.path.endsWith('barras.mp4')), 'importado');
    await js('document.querySelector("[data-test=tab-project]").click(); document.querySelector("[data-test=tab-controls]").click();');
  });
}
