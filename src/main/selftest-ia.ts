// Self-test of «ia» through the real UI: Alt+W picks the Roto Brush and then Refine Edge; a drag over an orange disc
// in the viewer paints a foreground stroke, the propagation runs by itself and the layer is cut to the disc; Alt+drag
// paints background on another frame; Freeze locks it; Window ▸ Content-Aware Fill fills the inverted matte.
import { Menu } from 'electron';
import { join } from 'node:path';
import { runFfmpeg } from '../core';
import type { motion } from '../core';
import type { Ctx } from './selftest-panels';

export async function iaSteps(x: Ctx) {
  const { js, until, wait, step, assert, dir } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(150); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  let cid = '', lid = '';
  const comp = () => (P().comps ?? []).find((c) => c.id === cid);
  const layer = () => comp()?.layers.find((l) => l.id === lid) as motion.Layer | undefined;
  const roto = () => layer()?.effects.find((f) => f.fx === 'rotoBrush');
  // pixels of the frame only: no tool overlay (strokes, outline) nor selection over it
  const plain = () => js('document.querySelector("[data-test=tool-select]").click(); window.__adv.adv.select([]);');
  const pixel = async (cx: number, cy: number) => { await wait(500); await until('!window.__adv.adv.work', 5000); await wait(700); return js<number[]>(`return A.pixel(${cx}, ${cy})`); };
  const cx = (n: number) => 115 + 3 * n;
  const orange = (p: number[]) => p[0] > 170 && p[1] > 90 && p[1] < 170 && p[2] < 110;
  /** a drag on the viewer between two comp points, with Alt held when asked */
  const drag = (a: [number, number], b: [number, number], alt = false) => js(`const el = document.querySelector('.adv-stage'), p = A.comp(${a[0]}, ${a[1]}), q = A.comp(${b[0]}, ${b[1]});
    const ev = (type, c) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, clientX: c[0], clientY: c[1], altKey: ${alt} }));
    ev('pointerdown', p); for (let i = 1; i <= 8; i++) ev('pointermove', [p[0] + (q[0] - p[0]) * i / 8, p[1] + (q[1] - p[1]) * i / 8]); ev('pointerup', q);`);

  await step('Pincel tipo rotoscopia: Alt+W elige la herramienta (y Perfeccionar borde); un trazo segmenta el disco y se propaga solo', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    const clip = join(dir, 'ia-disco.mp4');
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=0x2a6f8a:s=320x180:d=1:r=30,noise=alls=25:allf=t', '-f', 'lavfi', '-i', "color=c=0xe08030:s=70x70:d=1:r=30,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-35,Y-35),33),255,0)'",
      '-filter_complex', "[0][1]overlay=x='80+3*n':y=55:shortest=1", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-t', '1', clip]);
    const [m] = await js<{ id: string }[]>(`return await window.cinta.invoke('op', 'importMedia', [${JSON.stringify(clip)}])`);
    cid = (await js<{ id: string }>(`return await window.cinta.invoke('motion', 'compNew', { name: 'Rotoscopia', width: 320, height: 180, fps: 30, duration: 1, bg: '#000000' })`)).id;
    lid = (await js<{ id: string }>(`return await window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(cid)}, 'video', { mediaId: ${JSON.stringify(m.id)} })`)).id;
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(cid)}; a.work = null; a.emit('comp'); a.select([${JSON.stringify(lid)}]); a.seek(10 / 30);`);
    await js('document.querySelector("[data-test=tool-select]").click()');
    const seq: string[] = [];
    for (let i = 0; i < 3; i++) { await js('A.key("w", { alt: true })'); seq.push(await js<string>('return window.__adv.adv.tool')); }
    assert(seq.join() === 'roto,refine,roto', `Alt+W: ${seq}`);
    await wait(400);
    await drag([cx(10) - 18, 92], [cx(10) + 18, 86]);
    await untilMain(() => (roto()?.roto?.strokes.length ?? 0) === 1, 'un trazo');
    const s = roto()!.roto!.strokes[0];
    assert(s.kind === 'fg' && s.name === 'Primer plano 1' && Math.abs(s.s - 1 / 3) < 0.02 && Math.abs(s.pts[0] - (cx(10) - 18)) < 3, `trazo ${JSON.stringify({ ...s, pts: s.pts.slice(0, 4) })}`);
    await untilMain(() => (roto()?.roto?.seg?.m.filter(Boolean).length ?? 0) >= 29, 'propagación');
    await until('/Propagación lista/.test(document.querySelector("[data-test=roto-status]")?.textContent ?? "")', 15000);
    await plain();
    const inD = await pixel(cx(10), 90), out = await pixel(30, 30);
    assert(orange(inD) && out[0] + out[1] + out[2] < 40, `recorte: dentro ${inD}, fuera ${out}`);
    // further on, the matte followed the disc
    await js('window.__adv.adv.seek(25 / 30)');
    const later = await pixel(cx(25), 90), gone = await pixel(cx(10) - 20, 90);
    assert(orange(later) && gone[0] + gone[1] + gone[2] < 40, `fotograma 25: ${later} / ${gone}`);
  });

  await step('Pincel tipo rotoscopia: Alt+arrastrar pinta fondo y corrige desde ese fotograma; Congelar bloquea los trazos', async () => {
    const key0 = roto()!.roto!.seg!.key;
    await js(`window.__adv.adv.select([${JSON.stringify(lid)}])`);
    await js('A.key("w", { alt: true })');
    assert(await js<string>('return window.__adv.adv.tool') === 'roto', 'Alt+W vuelve al Pincel tipo rotoscopia');
    await drag([cx(25) + 10, 55], [cx(25) + 10, 125], true);
    await untilMain(() => roto()?.roto?.strokes.some((s) => s.kind === 'bg') ?? false, 'trazo de fondo');
    await untilMain(() => !!roto()?.roto?.seg && roto()!.roto!.seg!.key !== key0, 'nueva propagación');
    await until('/Propagación lista/.test(document.querySelector("[data-test=roto-status]")?.textContent ?? "")', 15000);
    await plain();
    const right = await pixel(cx(25) + 22, 90), left = await pixel(cx(25) - 15, 90);
    assert(!orange(right) && orange(left), `corrección: derecha ${right}, izquierda ${left}`);
    await js(`window.__adv.adv.select([${JSON.stringify(lid)}])`);
    await until('document.querySelector("[data-test=roto-freeze]")', 5000);
    await js('document.querySelector("[data-test=roto-freeze]").click()');
    await untilMain(() => !!roto()?.roto?.frozen, 'congelado');
    await until('/Descongelar/.test(document.querySelector("[data-test=roto-freeze]")?.textContent ?? "")', 5000);
    await js('A.key("w", { alt: true })');
    await drag([40, 40], [60, 40]);
    await wait(600);
    assert(roto()!.roto!.strokes.length === 2, 'congelado: sin trazos nuevos');
    await js('document.querySelector("[data-test=roto-freeze]").click()');
    await untilMain(() => !roto()?.roto?.frozen, 'descongelado');
  });

  await step('Relleno según el contenido: Ventana ▸ Relleno según el contenido genera la capa «Rellenar …» que borra el disco', async () => {
    await js(`return window.cinta.invoke('motion', 'effectSet', ${JSON.stringify(cid)}, ${JSON.stringify(lid)}, ${JSON.stringify(roto()!.id)}, { values: { invert: true } })`);
    await js('document.querySelector("[data-test=tool-select]").click()');
    const item = Menu.getApplicationMenu()?.getMenuItemById('content-aware-fill');
    assert(item && item.label === 'Relleno según el contenido', 'opción de menú');
    item!.click();
    await until('document.querySelector("[data-test=tab-caf]")?.classList.contains("on") && document.querySelector("[data-test=caf-panel]")?.offsetParent !== null');
    await js(`window.__adv.adv.select([${JSON.stringify(lid)}])`);
    await until(`document.querySelector("[data-test=caf-target]")?.textContent === ${JSON.stringify(layer()!.name)}`, 5000);
    await js('const s = document.querySelector("[data-test=caf-range]"); s.value = "all"; s.dispatchEvent(new Event("change")); const m = document.querySelector("[data-test=caf-method]"); m.value = "object"; m.dispatchEvent(new Event("change"));');
    await js('document.querySelector("[data-test=caf-generate]").click()');
    await untilMain(() => comp()?.layers[0]?.name.startsWith('Rellenar ') ?? false, 'capa de relleno', 120000);
    await js('window.__adv.adv.seek(5 / 30)');
    const p = await pixel(cx(5), 90);
    assert(!orange(p) && p[2] > p[0], `sin disco: ${p}`);
  });
}
