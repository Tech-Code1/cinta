// Self-test of «importacion» through the real UI: Proyecto ▸ Importar ▸ Archivo con opciones de secuencia (the
// «Secuencia PNG» checkbox of the import dialog: one footage item, its frames on screen), Interpretar material de
// archivo from the item's context menu (frame rate and loop change its duration), Importar ▸ Proyecto de Adobe
// Premiere Pro (the Premiere Pro Importer dialog: a comp with the clips) and Importar ▸ Escena Maya (a comp with
// the camera), and the Importar section of the preferences.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from '../core/png';
import type { Ctx } from './selftest-panels';
import { answers } from './testdialogs';

const T = 254016000000;
export async function importacionSteps(x: Ctx) {
  const { js, until, wait, step, assert, dir } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(150); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  const pixel = async (cx: number, cy: number) => { await wait(400); await until('!window.__adv.adv.work', 8000); await wait(600); return js<number[]>(`return A.pixel(${cx}, ${cy})`); };
  const menu = async (label: string) => {
    await js('document.querySelector("[data-test=adv-import]").click()');
    await js(`const b = [...document.querySelectorAll('.ctx button')].find((e) => e.textContent.includes(${JSON.stringify(label)})); if (!b) throw new Error('sin opción ' + ${JSON.stringify(label)}); b.click();`);
  };
  const seqDir = join(dir, 'imp-seq');
  mkdirSync(seqDir, { recursive: true });
  const png = (r: number, g: number, b: number) => { const px = new Uint8Array(64 * 48 * 4); for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; } return encodePng(64, 48, px); };
  for (let i = 1; i <= 4; i++) writeFileSync(join(seqDir, `f_${String(i).padStart(4, '0')}.png`), i <= 2 ? png(255, 0, 0) : png(0, 0, 255));
  let mid = '';

  await step('Importación: Importar ▸ Archivo con «Secuencia PNG» marcada crea un solo material f_[0001-0004].png y sus fotogramas se ven', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    answers.open.push([join(seqDir, 'f_0002.png')]);
    await menu('Archivo con opciones de secuencia');
    await until('!!document.querySelector("[data-test=imp-seq]")');
    const label = await js<string>('return document.querySelector("[data-test=imp-seq]").parentElement.textContent');
    assert(/Secuencia PNG/.test(label), `casilla: ${label}`);
    await js('const c = document.querySelector("[data-test=imp-seq]"); if (!c.checked) c.click(); document.querySelector("[data-test=imp-ok]").click()');
    await untilMain(() => P().media.some((m) => m.footage?.sequence), 'secuencia importada');
    const m = P().media.find((q) => q.footage?.sequence)!;
    mid = m.id;
    assert(m.kind === 'video' && m.footage!.name === 'f_[0001-0004].png' && Math.abs(m.duration - 4 / 30) < 0.01, JSON.stringify({ k: m.kind, n: m.footage!.name, d: m.duration }));
    await until('[...document.querySelectorAll("[data-test=adv-pitem]")].some((e) => e.textContent.includes("f_[0001-0004].png"))');
    const c = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'compNew', { name: 'Secuencia', width: 64, height: 48, fps: 30, duration: 4 / 30, bg: '#000000' })`);
    await js(`return window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(c.id)}, 'video', { mediaId: ${JSON.stringify(m.id)} })`);
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(c.id)}; a.work = null; a.emit('comp'); a.seek(0);`);
    const first = await pixel(32, 24);
    await js(`window.__adv.adv.seek(${3 / 30 + 0.005})`);
    const last = await pixel(32, 24);
    assert(first[0] > 200 && first[2] < 60 && last[2] > 200 && last[0] < 60, `fotograma 1 rojo, 4 azul: ${first} / ${last}`);
  });

  await step('Importación: Interpretar material de archivo (menú contextual): 2 fps y Bucle 2 → 4 s', async () => {
    await js(`const it = [...document.querySelectorAll("[data-test=adv-pitem]")].find((e) => e.textContent.includes("f_[0001-0004].png")); const r = it.getBoundingClientRect(); it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5 }));`);
    await js(`const b = [...document.querySelectorAll('.ctx button')].find((e) => e.textContent.includes('Interpretar material de archivo')); if (!b) throw new Error('sin opción'); b.click();`);
    await until('!!document.querySelector("[data-test=if-fps]")');
    const title = await js<string>('return document.querySelector(".modal header").textContent');
    assert(/Interpretar material de archivo: f_\[0001-0004\]\.png/.test(title), title);
    await js(`const f = document.querySelector("[data-test=if-fps]"); f.value = '2'; f.dispatchEvent(new Event('input')); const l = document.querySelector("[data-test=if-loop]"); l.value = '2'; document.querySelector("[data-test=if-ok]").click();`);
    await untilMain(() => Math.abs((P().media.find((m) => m.id === mid)?.duration ?? 0) - 4) < 0.01, 'duración de 4 s');
    const m = P().media.find((q) => q.id === mid)!;
    assert(m.fps === 2 && m.footage!.interpret.loop === 2, JSON.stringify(m.footage!.interpret));
  });

  await step('Importación: Importar ▸ Proyecto de Adobe Premiere Pro: el diálogo Premiere Pro Importer crea la composición con sus clips', async () => {
    const pf = join(dir, 'imp-proj.prproj'), red = join(seqDir, 'f_0001.png');
    writeFileSync(pf, `<?xml version="1.0"?><PremiereData Version="3">
<Sequence ObjectUID="s1"><Name>Montaje</Name><TrackGroups><TrackGroup Index="0"><Second ObjectRef="10"/></TrackGroup></TrackGroups></Sequence>
<VideoTrackGroup ObjectID="10"><TrackGroup><Tracks><Track Index="0" ObjectURef="t1"/></Tracks><FrameRate>${T / 25}</FrameRate></TrackGroup><FrameRect>0,0,64,48</FrameRect></VideoTrackGroup>
<VideoClipTrack ObjectUID="t1"><ClipTrack><ClipItems><TrackItems><TrackItem Index="0" ObjectRef="20"/></TrackItems></ClipItems></ClipTrack></VideoClipTrack>
<VideoClipTrackItem ObjectID="20"><ClipTrackItem><TrackItem><Start>0</Start><End>${T * 2}</End></TrackItem><SubClip ObjectRef="30"/></ClipTrackItem></VideoClipTrackItem>
<SubClip ObjectID="30"><Clip ObjectRef="40"/><Name>rojo</Name></SubClip>
<VideoClip ObjectID="40"><Clip><Source ObjectRef="50"/><InPoint>0</InPoint><OutPoint>${T * 2}</OutPoint></Clip></VideoClip>
<VideoMediaSource ObjectID="50"><MediaSource><Media ObjectURef="m1"/></MediaSource></VideoMediaSource>
<Media ObjectUID="m1"><ActualMediaFilePath>${red}</ActualMediaFilePath></Media>
</PremiereData>`);
    answers.open.push([pf]);
    await menu('Proyecto de Adobe Premiere Pro');
    await until('!!document.querySelector("[data-test=pr-ok]")');
    const opts = await js<string>('return [...document.querySelectorAll("[data-test=pr-seq] option")].map((o) => o.textContent).join("|")');
    assert(/Todas las secuencias/.test(opts) && /Montaje/.test(opts), opts);
    await js('document.querySelector("[data-test=pr-ok]").click()');
    await untilMain(() => (P().comps ?? []).some((c) => c.name === 'Montaje'), 'composición Montaje');
    const c = P().comps!.find((q) => q.name === 'Montaje')!;
    assert(c.width === 64 && c.fps === 25 && Math.abs(c.duration - 2) < 0.01 && c.layers.some((l) => l.name === 'rojo' && l.type === 'image'), JSON.stringify({ w: c.width, fps: c.fps, d: c.duration, l: c.layers.map((l) => l.name) }));
    await until(`window.__adv.adv.compId === ${JSON.stringify(c.id)}`);
  });

  await step('Importación: Importar ▸ Escena Maya crea la composición con la cámara de Maya', async () => {
    const mf = join(dir, 'imp-cam.ma');
    writeFileSync(mf, '//Maya ASCII 2024 scene\ncurrentUnit -l centimeter -a degree -t pal;\ncreateNode transform -n "camMaya";\n\tsetAttr ".t" -type "double3" 0 0 500 ;\ncreateNode camera -n "camMayaShape" -p "camMaya";\n\tsetAttr ".fl" 50;\nselect -ne :defaultResolution;\n\tsetAttr ".w" 640;\n\tsetAttr ".h" 360;\n');
    answers.open.push([mf]);
    await menu('Escena Maya');
    await untilMain(() => (P().comps ?? []).some((c) => /imp-cam/.test(c.name)), 'composición de Maya');
    const c = P().comps!.find((q) => /imp-cam/.test(q.name))!;
    const cam = c.layers.find((l) => l.type === 'camera');
    assert(c.width === 640 && c.fps === 25 && cam?.name === 'camMaya' && Math.abs((cam.transform.position.v as number[])[2] + 500) < 0.01, JSON.stringify({ w: c.width, fps: c.fps, cam: cam?.name, p: cam?.transform.position.v }));
  });

  await step('Importación: Preferencias ▸ Importar: Material de archivo de secuencias en fotogramas por segundo', async () => {
    await js('document.dispatchEvent(new CustomEvent("cinta:command", { detail: "preferences" }))');
    await until('!!document.querySelector("[data-test=pref-seq-fps]")');
    const v = await js<string>('return document.querySelector("[data-test=pref-seq-fps]").value');
    assert(v === '30', `por defecto ${v}`);
    await js('const f = document.querySelector("[data-test=pref-seq-fps]"); f.value = "24"; f.dispatchEvent(new Event("change")); ');
    await wait(300);
    const p = await js<{ sequenceFps: number }>('return await window.cinta.invoke("import:prefs")');
    assert(p.sequenceFps === 24, JSON.stringify(p));
    await js('return await window.cinta.invoke("import:prefs", { sequenceFps: 30 })');
    await js('const b = [...document.querySelectorAll(".modal footer .btn")].find((e) => e.textContent === "Cerrar"); b.click()');
    await until('!document.querySelector(".backdrop")');
  });
}
