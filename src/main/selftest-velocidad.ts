// Self-test of the speed graph: the graph editor switched to the speed graph, a handle dragged (speed and influence
// change), the Keyframe Velocity dialog (Ctrl+Shift+K), Easy Ease from the graph's buttons and Separate Dimensions.
import { motion } from '../core';
import type { Ctx } from './selftest-panels';

export async function velocidadSteps(x: Ctx) {
  const { js, until, wait, step, assert } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  const settle = async () => { await wait(250); await until('!window.__adv || !window.__adv.adv.work', 5000); };
  let cid = '', lid = '';
  const layer = () => P().comps!.find((c) => c.id === cid)!.layers.find((l) => l.id === lid)!;
  const vel = (i: number) => motion.keyVelocity(layer().transform.position, i, true);
  const menu = (text: string) => js(`const b = [...document.querySelectorAll('.ctx button')].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('sin opción ${text}'); b.click();`);

  await step('Velocidad: el editor de gráficos muestra el gráfico de velocidad y un tirador cambia velocidad e influencia', async () => {
    cid = await js<string>('return window.__adv.adv.compId');
    const l = await js<{ id: string }>(`return window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(cid)}, 'solid', { color: '#ffffff', width: 40, height: 40, name: 'Vel' })`);
    lid = l.id;
    await js(`return window.cinta.invoke('motion', 'propSet', ${JSON.stringify(cid)}, ${JSON.stringify(lid)}, 'position', { keys: [{ t: 0, v: [100, 360] }, { t: 1, v: [1100, 360] }] })`);
    await untilMain(() => layer().transform.position.k?.length === 2, 'claves de posición');
    assert(Math.abs(vel(0).out!.speed[0] - 1000) < 1e-6 && Math.abs(vel(0).out!.influence - 100 / 6) < 1e-6, `lineal: ${JSON.stringify(vel(0).out)}`);
    await js(`const a = window.__adv.adv; a.graphProp = { layer: ${JSON.stringify(lid)}, path: 'transform.position' }; a.keys = []; a.emit('comp');`);
    if (!(await js<boolean>('return document.querySelector("[data-test=adv-graph]").classList.contains("on")'))) await js('document.querySelector("[data-test=adv-graph]").click()');
    await until('getComputedStyle(document.querySelector("[data-test=g-bar]")).display === "flex"');
    // automatic type: speed graph for a spatial property; then chosen by hand in «Elegir tipo y opciones de gráfico»
    assert(await js('return window.__graph.mode() === "speed"'), 'automático: velocidad para la posición');
    await js('document.querySelector("[data-test=g-type]").click()');
    await menu('Editar gráfico de valores');
    await until('window.__graph.mode() === "value"');
    await js('document.querySelector("[data-test=g-type]").click()');
    await menu('Editar gráfico de velocidad');
    await until('window.__graph.mode() === "speed"');
    await js('document.querySelector("[data-test=g-fitall]").click()');
    await wait(200);
    // drag the outgoing handle of key 1 up and to the right
    const h0 = await js<{ x: number; y: number }>('const cv = document.querySelector("[data-test=adv-graph-cv]"); return window.__graph.pts(cv).find((p) => p.kind === "out" && p.i === 0)');
    assert(h0, 'tirador de salida de la clave 1');
    await js(`A.drag("[data-test=adv-graph-cv]", [${h0.x}, ${h0.y}], [${h0.x + 60}, ${h0.y - 40}])`);
    await settle();
    await untilMain(() => (vel(0).out?.influence ?? 0) > 20, 'influencia');
    const v = vel(0).out!;
    assert(v.speed[0] > 1050 && v.influence > 20, `velocidad ${v.speed[0]}, influencia ${v.influence}`);
    // the yellow handle is drawn where it now is
    const h1 = await js<{ x: number; y: number }>('const cv = document.querySelector("[data-test=adv-graph-cv]"); return window.__graph.pts(cv).find((p) => p.kind === "out" && p.i === 0)');
    // (auto-zoom height refits the curve after the drag: only the influence moves it on screen)
    assert(h1.x > h0.x + 30, `tirador movido: ${JSON.stringify([h0, h1])}`);
    const px = await js<number[]>(`const cv = document.querySelector("[data-test=adv-graph-cv]"); const r = cv.getBoundingClientRect(); const k = cv.width / r.width; return [...cv.getContext('2d').getImageData(Math.round((${h1.x} - r.left) * k), Math.round((${h1.y} - r.top) * k), 1, 1).data]`);
    assert(px[0] > 200 && px[1] > 180 && px[2] < 80, `píxel del tirador: ${px}`);
  });

  await step('Velocidad: Ctrl+Mayús+K abre «Velocidad de fotogramas clave» y fija entrada y continuo', async () => {
    await js(`const a = window.__adv.adv; a.keys = [{ layer: ${JSON.stringify(lid)}, path: 'transform.position', t: 1 }]; a.emit('keys');`);
    await js('A.key("K", { ctrl: true, shift: true })');
    await until('document.querySelector("[data-test=kv-ok]")');
    assert(await js('return document.querySelector("[data-test=kv-out-0]").disabled && !document.querySelector("[data-test=kv-in-0]").disabled'), 'última clave: solo velocidad de entrada');
    await js('const s = document.querySelector("[data-test=kv-in-0]"); s.value = "250"; s.dispatchEvent(new Event("input")); const f = document.querySelector("[data-test=kv-in-inf]"); f.value = "75"; document.querySelector("[data-test=kv-cont]").click(); document.querySelector("[data-test=kv-ok]").click();');
    await settle();
    await untilMain(() => Math.abs((vel(1).in?.influence ?? 0) - 75) < 1e-6, 'influencia de entrada');
    assert(Math.abs(vel(1).in!.speed[0] - 250) < 1e-6 && vel(1).continuous, JSON.stringify(vel(1)));
  });

  await step('Velocidad: botón Desacelerac./Acelerac. suave = 0 /s al 33,33 %; Separar dimensiones', async () => {
    await js(`const a = window.__adv.adv; a.keys = [{ layer: ${JSON.stringify(lid)}, path: 'transform.position', t: 0 }]; a.emit('keys');`);
    await js('document.querySelector("[data-test=g-easy]").click()');
    await settle();
    await untilMain(() => (vel(0).out?.speed[0] ?? 1) === 0, 'suavizado');
    assert(Math.abs(vel(0).out!.influence - 100 / 3) < 1e-6, `influencia ${vel(0).out!.influence}`);
    const before = [0.25, 0.5, 0.8].map((t) => motion.valueAt(layer().transform.position, t, { comp: P().comps!.find((c) => c.id === cid)!, layer: layer(), path: 'transform.position' }) as number[]);
    await js('document.querySelector("[data-test=g-sep]").click()');
    await untilMain(() => !!layer().transform.positionX, 'separada');
    const after = [0.25, 0.5, 0.8].map((t) => motion.valueAt(layer().transform.position, t, { comp: P().comps!.find((c) => c.id === cid)!, layer: layer(), path: 'transform.position' }) as number[]);
    assert(before.every((v, i) => Math.hypot(v[0] - after[i][0], v[1] - after[i][1]) < 0.05), `mismo movimiento: ${JSON.stringify([before, after])}`);
    await until('window.__adv.adv.graphProp?.path === "transform.positionX"');
    assert(await js('return document.querySelector("[data-test=g-sep]").classList.contains("on")'), 'botón activo');
    // join back, close the graph editor, remove the layer
    await js('document.querySelector("[data-test=g-sep]").click()');
    await untilMain(() => !layer().transform.positionX && (layer().transform.position.k?.length ?? 0) >= 2, 'unida');
    await js('document.querySelector("[data-test=adv-graph]").click()');
    await js(`return window.cinta.invoke('motion', 'layerDelete', ${JSON.stringify(cid)}, [${JSON.stringify(lid)}])`);
    await settle();
  });
}
