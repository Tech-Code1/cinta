// `Cinta --selftest=<folder>`: drives the real UI (clicks on the actual buttons, drag-free paths) and checks
// the results — timeline DOM, project state, preview pixels, playback, export, and reload after an outside
// (MCP) change. Writes selftest.log and screenshots into the folder; exits 0 when everything passed.
import { app, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Editor, mediaInfo, newProject, projectDuration, runFfmpeg } from '../core';
import { panelSteps } from './selftest-panels';
import { advancedSteps } from './selftest-adv';
import { updateSteps } from './selftest-updates';

interface Host { readonly editor: Editor; attach(e: Editor): void; saveTo(path: string): void; autosaveNow(): boolean; checkRecovery(): Promise<boolean>; autosaveFile(): string }

export async function runSelfTest(win: BrowserWindow, host: Host, dirArg?: string) {
  const tmp = app.getPath('temp');
  // Default folders of earlier runs (logs, screenshots, exported media) are dropped after a day.
  for (const n of readdirSync(tmp)) {
    if (!n.startsWith('cinta-selftest-')) continue;
    try { const p = join(tmp, n); if (Date.now() - statSync(p).mtimeMs > 864e5) rmSync(p, { recursive: true, force: true }); } catch { /* in use */ }
  }
  const dir = resolve(dirArg || join(tmp, `cinta-selftest-${Date.now()}`));
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'selftest.log');
  writeFileSync(log, '');
  let fails = 0, passes = 0;
  // The log file is the record; stdout may be a pipe whose reader went away (EPIPE must not crash the run).
  for (const o of [process.stdout, process.stderr]) o.on('error', () => {});
  const say = (s: string) => { appendFileSync(log, `${s}\n`); try { console.log(s); } catch { /* closed pipe */ } };
  const js = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (code: string, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await js<boolean>(`return !!(${code})`)) return true; await wait(150); }
    throw new Error(`tiempo agotado esperando: ${code}`);
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); passes++; say(`  ✔ ${name}`); } catch (e) { fails++; say(`  ✘ ${name}\n      ${(e as Error).message}`); }
  };
  const assert = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };
  const click = (sel: string) => js(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no existe ${sel.replace(/'/g, '')}'); el.click();`);
  const dbl = (sel: string) => js(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no existe ${sel.replace(/'/g, '')}'); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`);
  const selectClip = (i: number, kind = 'main') => js(`const t = document.querySelector('.track.${kind}'); const el = t.querySelectorAll('.clip')[${i}]; const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + 10, clientY: r.top + 10 })); dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 10, clientY: r.top + 10 }));`);
  const clips = () => host.editor.project.clips;
  const shot = async (name: string) => writeFileSync(join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  /** Pixel of the preview <img> at a relative point (decoded in the page). */
  const framePixel = (fx: number, fy: number) => js<number[]>(`const img = document.getElementById('frame'); await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return [...x.getImageData(Math.floor(c.width * ${fx}), Math.floor(c.height * ${fy}), 1, 1).data];`);
  const near = (a: number[], b: number[], tol = 70) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < tol;

  say(`Cinta — autoprueba de la interfaz\n  carpeta: ${dir}`);
  win.setSize(1600, 950);
  win.show();
  try {
    await until('window.cintaReady');
    await js('localStorage.setItem("cinta.tour", "done"); document.querySelectorAll(".tour, .tour-ring").forEach((e) => e.remove());');
    // fixtures
    const red = join(dir, 'red.mp4'), blue = join(dir, 'blue.mp4'), img = join(dir, 'img.png');
    if (!existsSync(red)) await runFfmpeg(['-f', 'lavfi', '-i', 'color=red:s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', red]);
    if (!existsSync(blue)) await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=660:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', blue]);
    if (!existsSync(img)) await runFfmpeg(['-f', 'lavfi', '-i', 'color=lime:s=640x360', '-frames:v', '1', img]);
    const projectPath = join(dir, 'prueba.cinta');

    await step('Proyecto de inicio (sin abrir nada): importar y añadir se ven en la línea de tiempo', async () => {
      await js(`const [m] = await window.cinta.invoke('op', 'importMedia', [${JSON.stringify(red)}]); await window.cinta.invoke('op', 'addClip', m.id);`);
      await until('document.querySelectorAll(".track.main .clip").length === 1', 5000);
    });
    host.attach(new Editor(newProject({ width: 1280, height: 720 })));
    host.saveTo(projectPath);
    await wait(300);

    await step('Errores: un error no capturado (proceso principal y ventana) se anota en logs/errores.log y Cinta sigue funcionando', async () => {
      const tag = `prueba-errores-${Date.now()}`, f = join(app.getPath('userData'), 'logs', 'errores.log');
      setTimeout(() => { throw new Error(`${tag}-principal`); }, 0);
      void Promise.reject(new Error(`${tag}-promesa`));
      await js(`setTimeout(() => { throw new Error('${tag}-ventana'); }, 0); Promise.reject(new Error('${tag}-ventana-promesa'));`);
      await wait(800);
      const txt = existsSync(f) ? readFileSync(f, 'utf8') : '';
      for (const k of ['principal', 'promesa', 'ventana', 'ventana-promesa']) assert(txt.includes(`${tag}-${k}`), `sin anotar: ${k}`);
      assert(await js('return document.querySelectorAll("#rail button").length') === 6, 'la ventana dejó de funcionar');
    });
    await updateSteps({ dir, step, assert });

    await step('Interfaz: riel, barra, línea de tiempo y reproductor', async () => {
      const n = await js<number>('return document.querySelectorAll("#rail button").length');
      assert(n === 6, `riel con ${n} botones`);
      assert(await js('return !!document.querySelector("[data-test=export]") && !!document.querySelector("[data-test=play]") && document.querySelectorAll("#toolbar .ib").length >= 12'), 'barra de herramientas');
      assert(await js('return document.querySelectorAll(".track").length === 3'), 'tres pistas iniciales (título, vídeo, música)');
      await shot('01-vacio');
    });

    await step('Importar y añadir al proyecto (contenedor de medios → «+»)', async () => {
      await host.editor.importMedia([red, blue, img]);
      await click('#cats .cat:nth-child(2)'); // Contenedor de medios
      await until('document.querySelectorAll(".bin .item").length === 3');
      await js('document.querySelectorAll(".bin .item .add")[0].click(); await new Promise(r => setTimeout(r, 300)); document.querySelectorAll(".bin .item .add")[1].click();');
      await until('document.querySelectorAll(".track.main .clip").length === 2');
      assert(Math.abs(host.editor.project.clips.reduce((s, c) => s + (c.out - c.in), 0) - 6) < 0.05, 'duración 6 s');
      await until('document.getElementById("status-text").textContent.includes("00:06")');
    });

    await step('Vista previa exacta del fotograma (rojo en 1 s, azul en 4 s)', async () => {
      await js('document.querySelector("#ruler").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 })); dispatchEvent(new PointerEvent("pointerup"));');
      await js('const s = document.getElementById("tl-scroll"); s.scrollLeft = 0;');
      // seek via keyboard: Home then 30 frames forward with →
      await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));');
      for (let i = 0; i < 30; i++) await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));');
      await until('document.getElementById("tc-main").textContent === "00:00:01"');
      await wait(1500);
      const p = await framePixel(0.5, 0.5);
      assert(near(p, [255, 0, 0]), `rojo ${p}`);
      await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));');
      for (let i = 0; i < 60; i++) await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));');
      await wait(1500);
      const q = await framePixel(0.5, 0.5);
      assert(near(q, [0, 0, 255]), `azul ${q}`);
    });

    await step('Dividir (barra), deshacer y rehacer', async () => {
      await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));');
      for (let i = 0; i < 45; i++) await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));');
      await click('[data-test=tb-split]');
      await until('document.querySelectorAll(".track.main .clip").length === 3');
      await click('[data-test=tb-undo]');
      await until('document.querySelectorAll(".track.main .clip").length === 2');
      await click('[data-test=tb-redo]');
      await until('document.querySelectorAll(".track.main .clip").length === 3');
      await click('[data-test=tb-undo]');
      await until('document.querySelectorAll(".track.main .clip").length === 2');
    });

    await step('Seleccionar clip y aplicar filtro (Filtros → doble clic)', async () => {
      await selectClip(0);
      await until('document.querySelector(".track.main .clip.sel")');
      await click('[data-test=tab-filters]');
      await until('document.querySelector("[data-test=filter-bw]")');
      await dbl('[data-test=filter-bw]');
      await until('document.querySelector(".track.main .clip .badges")');
      assert(clips().find((c) => c.filters.length)?.filters[0].type === 'bw', 'filtro bw en el proyecto');
      await click('[data-test=tb-props]');
      await until('document.querySelector(".applied .fx")');
    });

    await step('Transición entre clips (Transiciones → doble clic)', async () => {
      await selectClip(0);
      await click('[data-test=tab-transitions]');
      await until('document.querySelector("[data-test=transition-fade]")');
      await dbl('[data-test=transition-fade]');
      await until('document.querySelector(".trans")');
      assert(Math.abs(host.editor.project.clips.find((c) => c.transition)!.transition!.duration - 1) < 1e-6, 'transición de 1 s');
      await until('document.getElementById("status-text").textContent.includes("00:05")');
    });

    await step('Título: añadir y editar el texto en su panel', async () => {
      await click('[data-test=tab-titles]');
      await until('document.querySelector("[data-test=title-basic]")');
      await dbl('[data-test=title-basic]');
      await until('document.querySelector(".track.title .clip")');
      await until('document.querySelector("[data-test=title-text]")');
      await js('const t = document.querySelector("[data-test=title-text]"); t.value = "Hola desde Cinta"; t.dispatchEvent(new Event("change"));');
      await until('document.querySelector(".track.title .clip .name").textContent.includes("Hola desde Cinta")');
    });

    await step('Arrastrar un título con imán: se pega al cursor de reproducción', async () => {
      await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));');
      for (let i = 0; i < 60; i++) await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));');
      await until('document.getElementById("tc-main").textContent === "00:00:02"');
      const title = clips().find((c) => c.type === 'title')!;
      // drag with the real pointer handlers, releasing 3 px past the playhead
      await js(`const el = document.querySelector('.track.title .clip'); const r = el.getBoundingClientRect();
        const ph = document.getElementById('playhead').getBoundingClientRect().left;
        const x0 = r.left + 20, y = r.top + 10, dx = ph - r.left + 3;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x0, clientY: y }));
        for (let k = 1; k <= 5; k++) dispatchEvent(new PointerEvent('pointermove', { clientX: x0 + dx * k / 5, clientY: y }));
        dispatchEvent(new PointerEvent('pointerup', { clientX: x0 + dx, clientY: y }));`);
      await until(`(${JSON.stringify(title.id)}, true)`);
      await wait(500);
      const moved = clips().find((c) => c.id === title.id)!;
      assert(Math.abs(moved.start - 2) < 1e-6, `el título empieza justo en 2 s (${moved.start})`);
      assert(await js('return !!document.querySelector(".th-row .ib.on[title^=\\"Pista vinculada\\"]")'), 'botón de pista vinculada en la cabecera');
    });

    await step('Más herramientas: velocidad desde su panel', async () => {
      await selectClip(1);
      await click('[data-test=tab-tools]');
      await click('[data-test=tool-speed]');
      await until('document.querySelector("[data-test=chip-2]")');
      await click('[data-test=chip-2]');
      await until('document.querySelector(".track.main .clip .badges")?.parentElement && [...document.querySelectorAll(".track.main .clip .badges span")].some(s => s.textContent === "2×")');
    });

    await step('Reproducir (flujo en vivo) y pausar', async () => {
      await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));');
      const t0 = Date.now();
      await click('[data-test=play]');
      await until('document.getElementById("video").currentTime > 0.3', 6000);
      const started = (Date.now() - t0) / 1000;
      const playing = await js<boolean>('return document.getElementById("player").classList.contains("playing")');
      await click('[data-test=play]');
      assert(playing, 'reproduciendo');
      say(`      (avanza 0,3 s de vídeo en ${started.toFixed(2)} s · ${JSON.stringify(await js('const m = { ...window.__playMarks }; delete m.t0; return m'))})`);
      assert(started < 2, `tarda demasiado en arrancar: ${started.toFixed(2)} s`);
      await shot('02-edicion');
    });

    await step('Exportar desde el diálogo (MP4) y comprobar el archivo', async () => {
      await click('[data-test=export]');
      await until('document.querySelector("[data-test=export-start]")');
      await js(`const n = document.querySelector("[data-test=export-name]"); n.value = "autoprueba"; const f = n.closest(".body").querySelectorAll("input")[1]; f.value = ${JSON.stringify(dir)};`);
      await click('[data-test=export-start]');
      await until('document.querySelector(".task.done")', 120000);
      const out = join(dir, 'autoprueba.mp4');
      assert(existsSync(out), 'archivo exportado');
      const info = mediaInfo(out);
      const want = projectDuration(host.editor.project);
      assert(info.vcodec === 'h264' && Math.abs(info.duration - want) < 0.2, `vídeo ${info.vcodec} ${info.duration} s (esperado ${want})`);
      await js('document.querySelectorAll(".backdrop").forEach(b => b.remove())');
    });

    await step('Guardar y recargar al cambiar el proyecto desde fuera (MCP)', async () => {
      host.saveTo(projectPath);
      await wait(800);
      const ext = Editor.load(projectPath);
      ext.addColorClip('#ffffff', 2);
      ext.save(projectPath);
      await until('document.querySelectorAll(".track.main .clip").length === 3', 8000);
    });

    await step('Preferencias: estado de la conexión con asistentes de IA', async () => {
      await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "," , ctrlKey: true }));');
      await win.webContents.executeJavaScript('void 0');
      win.webContents.send('menu', 'preferences');
      await until('[...document.querySelectorAll(".modal header span")].some(s => s.textContent === "Preferencias")');
      assert(await js('return document.querySelector(".modal pre").textContent.includes("mcpServers")'), 'configuración MCP visible');
      await shot('03-preferencias');
      await js('document.querySelectorAll(".backdrop").forEach(b => b.remove())');
    });

    say('\n  Paneles, diálogos y gestos:');
    await panelSteps({ win, dir, host, js, until, wait, step, assert, say } as Parameters<typeof panelSteps>[0]);
    await advancedSteps({ win, dir, host, js, until, wait, step, assert, say } as Parameters<typeof advancedSteps>[0]);
    await shot('04-paneles');
  } catch (e) {
    fails++;
    say(`  ✘ error general: ${(e as Error).stack}`);
  }
  say(`\n${passes} correctas, ${fails} fallidas`);
  app.exit(fails ? 1 : 0);
}
