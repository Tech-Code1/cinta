// Self-test of the 3D model layers through the real UI: Proyecto ▸ Importar ▸ Modelo 3D (an .obj + .mtl written
// here) shows the item with its rendered thumbnail, a double click adds it to the comp and the viewer draws it; the
// timeline shows «Opciones de modelo» and the layer menu's «Acepta luces» changes how a comp light shades it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './selftest-panels';
import { answers } from './testdialogs';

const OBJ = 'mtllib rojo.mtl\no Caja\nv -0.5 -0.5 0.5\nv 0.5 -0.5 0.5\nv 0.5 0.5 0.5\nv -0.5 0.5 0.5\nv -0.5 -0.5 -0.5\nv 0.5 -0.5 -0.5\nv 0.5 0.5 -0.5\nv -0.5 0.5 -0.5\nusemtl Rojo\nf 1 2 3 4\nf 6 5 8 7\nf 2 6 7 3\nf 5 1 4 8\nf 4 3 7 8\nf 5 6 2 1\n';

export async function modelos3dSteps(x: Ctx) {
  const { js, until, wait, step, assert, dir } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  const pixel = async (cx: number, cy: number) => { await js('window.__adv.adv.select([])'); await wait(400); await until('!window.__adv.adv.work', 5000); await wait(600); return js<number[]>(`return A.pixel(${cx}, ${cy})`); };
  const comp = () => P().comps!.find((c) => c.id === cid)!;
  let cid = '';

  await step('Modelos 3D: Importar ▸ Modelo 3D muestra el elemento con su miniatura; doble clic lo añade y el visor lo dibuja', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    const obj = join(dir, 'caja3d.obj');
    writeFileSync(obj, OBJ);
    writeFileSync(join(dir, 'rojo.mtl'), 'newmtl Rojo\nKd 1 0 0\nKs 0 0 0\n');
    const c = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'compNew', { name: 'Modelos', width: 320, height: 240, fps: 30, duration: 2, bg: '#000000' })`);
    cid = c.id;
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(cid)}; a.work = null; a.emit('comp'); a.seek(0);`);
    answers.open.push([obj]);
    await js('document.querySelector("[data-test=adv-import]").click()');
    await js(`const b = [...document.querySelectorAll('.ctx button')].find((e) => e.textContent.includes('Modelo 3D')); if (!b) throw new Error('sin opción Modelo 3D'); b.click();`);
    await untilMain(() => P().media.some((m) => m.kind === 'model' && m.path.endsWith('caja3d.obj')), 'modelo importado');
    const m = P().media.find((y) => y.path.endsWith('caja3d.obj'))!;
    assert(m.model?.meshes.join() === 'Caja' && m.model.triangles === 12 && m.model.files.join() === 'rojo.mtl', JSON.stringify(m.model));
    await until('[...document.querySelectorAll("[data-test=adv-pitem]")].some((e) => e.textContent.includes("caja3d.obj") && e.textContent.includes("12 triángulos"))');
    // the thumbnail is a three.js render of the model: red pixels in it
    await until('document.querySelector("[data-test=model-thumb][data-ready]")', 20000);
    const red = await js<number>(`const img = document.querySelector("[data-test=model-thumb][data-ready]"); const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; const g = cv.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 80 && d[i] > d[i + 1] * 2 + 10) n++; return n;`);
    assert(red > 200, `miniatura: ${red} píxeles rojos`);
    await js(`const it = [...document.querySelectorAll("[data-test=adv-pitem]")].find((e) => e.textContent.includes("caja3d.obj")); it.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`);
    await untilMain(() => comp().layers.some((l) => l.type === 'model'), 'capa de modelo');
    const l = comp().layers.find((y) => y.type === 'model')!;
    assert(l.threeD && l.model?.unit === 120 && l.mediaId === m.id, JSON.stringify(l.model));
    // no lights in the comp: the default lighting shows it red, centred in the frame; the corners stay black
    const mid = await pixel(178, 136), corner = await pixel(10, 10);
    assert(mid[0] > 90 && mid[0] > mid[1] * 2 + 20 && corner[0] < 20, `modelo en el visor: ${mid} / esquina ${corner}`);
    // the layer row and its «Opciones de modelo» group
    await until(`[...document.querySelectorAll("[data-test=layer-row]")].some((e) => e.dataset.layer === ${JSON.stringify(l.id)})`);
    await js(`[...document.querySelectorAll("[data-test=layer-row]")].find((e) => e.dataset.layer === ${JSON.stringify(l.id)}).querySelector("[data-test=layer-twisty]").click()`);
    await until('[...document.querySelectorAll("#adv .row.group .nm")].some((e) => e.textContent === "Opciones de modelo")');
    await js('[...document.querySelectorAll("#adv .row.group .nm")].find((e) => e.textContent === "Opciones de modelo").click()');
    await until('document.querySelector("[data-test=model-unit]") && document.querySelector("[data-test=\\"prop-model.speed\\"]")');
    // the scale field: twice as big, the model stays centred and grows
    await js('const u = document.querySelector("[data-test=model-unit]"); u.value = "240"; u.dispatchEvent(new Event("change"));');
    await untilMain(() => comp().layers.find((y) => y.id === l.id)!.model!.unit === 240, 'escala del modelo');
    const far = await pixel(150, 50);
    assert(far[0] > 60, `modelo más grande: ${far}`);
  });

  await step('Modelos 3D: una luz ambiente al 0 % lo oscurece; «Acepta luces» desde el menú de la capa lo muestra con su color', async () => {
    const lt = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(cid)}, 'light', {})`);
    await js(`return window.cinta.invoke('motion', 'layerSet', ${JSON.stringify(cid)}, ${JSON.stringify(lt.id)}, { light: { type: 'ambient' } })`);
    await js(`return window.cinta.invoke('motion', 'propSet', ${JSON.stringify(cid)}, ${JSON.stringify(lt.id)}, 'light.intensity', { value: 0 })`);
    await untilMain(() => comp().layers.some((y) => y.light?.type === 'ambient'), 'luz ambiente');
    let p = await pixel(178, 136);
    assert(p[0] < 20, `sin luz: ${p}`);
    const l = comp().layers.find((y) => y.type === 'model')!;
    await js(`const r = [...document.querySelectorAll("[data-test=layer-row]")].find((e) => e.dataset.layer === ${JSON.stringify(l.id)}); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 30, clientY: b.top + 5 }));`);
    await js(`const b = [...document.querySelectorAll('.ctx button')].find((e) => e.textContent.includes('Acepta luces')); if (!b) throw new Error('sin opción Acepta luces'); b.click();`);
    await untilMain(() => comp().layers.find((y) => y.id === l.id)!.material?.acceptsLights === false, 'no acepta luces');
    p = await pixel(178, 136);
    assert(p[0] > 230 && p[1] < 30, `con su propio color: ${p}`);
  });
}
