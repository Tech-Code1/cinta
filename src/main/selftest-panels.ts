// Self-test, second part: every tool panel, dialog and timeline gesture driven through the real UI.
// Native dialogs are answered through testdialogs.ts; results are checked on the project model.
import type { BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Editor, generateMedia, mediaInfo, newProject, runFfmpeg, type Clip } from '../core';
import { answers, asked } from './testdialogs';

export interface Ctx {
  win: BrowserWindow;
  dir: string;
  host: { readonly editor: Editor; attach(e: Editor): void; saveTo(path: string): void; autosaveNow(): boolean; checkRecovery(): Promise<boolean>; autosaveFile(): string };
  js: <T = unknown>(code: string) => Promise<T>;
  until: (code: string, timeout?: number) => Promise<boolean>;
  wait: (ms: number) => Promise<unknown>;
  step: (name: string, fn: () => Promise<void>) => Promise<void>;
  assert: (c: unknown, msg: string) => void;
}

export async function panelSteps(x: Ctx) {
  const { js, until, wait, step, assert, dir } = x;
  const say = (t: string) => (x as Ctx & { say?: (t: string) => void }).say?.(t);
  const P = () => x.host.editor.project;
  const clip = (id: string) => P().clips.find((c) => c.id === id)!;
  const untilMain = async (fn: () => boolean, what: string, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  // helpers living in the page: set a panel control by its label, press a panel button, pick a chip
  await js(`window.T = {
    row(label, value) {
      const row = [...document.querySelectorAll('.panel .row, .modal .row')].find((r) => r.querySelector('label')?.textContent.trim().startsWith(label));
      if (!row) throw new Error('no hay control ' + label);
      const inp = row.querySelector('input, select, textarea');
      if (inp.type === 'checkbox') inp.checked = !!value; else inp.value = String(value);
      inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
    },
    btn(text) {
      const b = [...document.querySelectorAll('.panel button, .modal button, .ctx button')].find((e) => e.textContent.trim().startsWith(text));
      if (!b) throw new Error('no hay botón ' + text); b.click();
    },
    chip(id) { const c = document.querySelector('[data-test="chip-' + id + '"]'); if (!c) throw new Error('no hay chip ' + id); c.click(); },
    toast() { return document.getElementById('toast').textContent; },
    select(trackKind, i, add) {
      const el = document.querySelectorAll('.track.' + trackKind + ' .clip')[i]; const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: !!add, clientX: r.left + 8, clientY: r.top + 8 }));
      dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 8, clientY: r.top + 8 }));
    },
  };`);
  const tool = async (id: string) => { await js('document.querySelector("[data-test=tab-tools]").click()'); await js(`document.querySelector("[data-test=tool-${id}]").click()`); await until('document.querySelector(".panel")'); };
  const select = async (kind: string, i: number, add = false) => { await js(`T.select(${JSON.stringify(kind)}, ${i}, ${add})`); await wait(200); };
  const row = (label: string, v: unknown) => js(`T.row(${JSON.stringify(label)}, ${JSON.stringify(v)})`);
  const btn = (t: string) => js(`T.btn(${JSON.stringify(t)})`);
  const chip = (id: string) => js(`T.chip(${JSON.stringify(id)})`);

  // fresh project for this part
  const f = (n: string) => join(dir, n);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(f('talk.mp4'))) await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=300:d=2,apad=pad_dur=1[a];sine=f=600:d=3[b];[a][b]concat=n=2:v=0:a=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('talk.mp4')]);
  if (!existsSync(f('logo.png'))) await runFfmpeg(['-f', 'lavfi', '-i', 'color=lime:s=200x80', '-frames:v', '1', f('logo.png')]);
  if (!existsSync(f('inv.cube'))) (await import('node:fs')).writeFileSync(f('inv.cube'), 'LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n');
  if (!existsSync(f('subs.srt'))) (await import('node:fs')).writeFileSync(f('subs.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHola\n');
  const beats = await generateMedia('sfx', 'click', { output: f('click.wav') });
  void beats;
  x.host.attach(new Editor(newProject({ width: 1280, height: 720 })));
  x.host.saveTo(f('paneles.cinta'));
  const [talk, red] = await x.host.editor.importMedia([f('talk.mp4'), f('red.mp4')]);
  const v1 = x.host.editor.addClip(talk.id), v2 = x.host.editor.addClip(red.id);
  await until('document.querySelectorAll(".track.main .clip").length === 2');

  await step('Panel Propiedades: volumen, fundidos, opacidad, puntos de volumen', async () => {
    await select('main', 0);
    await js('document.querySelector("[data-test=tb-props]").click()');
    await until('document.querySelector(".panel")');
    await row('Volumen:', 0.5);
    await untilMain(() => clip(v1.id).volume === 0.5, 'volumen 50 %');
    await row('F. entrada:', 1);
    await untilMain(() => clip(v1.id).fadeIn === 1, 'fundido');
    await row('Opacidad:', 0.8);
    await untilMain(() => clip(v1.id).opacity === 0.8, 'opacidad');
    await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }))');
    for (let i = 0; i < 30; i++) await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }))');
    await btn('Agregar punto de volumen aquí');
    await untilMain(() => (clip(v1.id).volumeKeys?.length ?? 0) === 1, 'punto de volumen');
  });

  await step('Panel Ajustes de color: manual, automático, LUT y restablecer', async () => {
    await tool('color');
    await row('Brillo:', 0.5);
    await untilMain(() => clip(v1.id).color?.brightness === 0.5, 'brillo');
    await chip('auto-contrast');
    await untilMain(() => clip(v1.id).color?.preset === 'auto-contrast', 'contraste automático');
    answers.open.push([f('inv.cube')]);
    await btn('Cargar LUT');
    await untilMain(() => !!clip(v1.id).color?.lut, 'LUT');
    await btn('Restablecer');
    await untilMain(() => !clip(v1.id).color, 'restablecido');
  });

  await step('Panel Recortar y girar', async () => {
    await tool('crop');
    await row('Izquierda:', 0.1);
    await untilMain(() => clip(v1.id).crop?.x === 0.1, 'recorte');
    await btn('Rotar 90°');
    await untilMain(() => clip(v1.id).rotate === 90, 'rotar');
    await btn('Restablecer');
    await untilMain(() => !clip(v1.id).crop && clip(v1.id).rotate === 0, 'restablecer');
  });

  await step('Panel Estabilización (análisis real)', async () => {
    await tool('stabilize');
    await js('document.querySelector("[data-test=stabilize]").click()');
    await untilMain(() => !!clip(v1.id).stabilize?.trf, 'estabilizado', 60000);
  });

  await step('Paneles Panorámica y zoom, y Resaltar y esconder con seguimiento', async () => {
    await tool('panzoom');
    await chip('zoom-in');
    await untilMain(() => clip(v1.id).panZoom?.preset === 'zoom-in', 'panorámica');
    await tool('mask');
    await chip('blur-rect');
    await untilMain(() => clip(v1.id).mask?.mode === 'blur', 'máscara');
    await row('Ancho:', 0.4);
    await untilMain(() => clip(v1.id).mask?.w === 0.4, 'ancho de la máscara');
    await btn('Añadir punto aquí');
    await untilMain(() => (clip(v1.id).mask?.track?.length ?? 0) === 1, 'punto de seguimiento');
  });

  await step('Paneles de audio: ecualizador, compresor, puerta, reverberación, ruido, mejora, efectos', async () => {
    await select('main', 0);
    await tool('eq');
    await chip('bass-boost');
    await untilMain(() => clip(v1.id).audio?.eqPreset === 'bass-boost', 'ecualizador');
    for (const t of ['compressor', 'gate', 'reverb']) {
      await tool(t);
      await btn('Aplicar');
      await untilMain(() => !!(clip(v1.id).audio as Record<string, unknown> | undefined)?.[t], t);
    }
    await tool('denoise');
    await row('Supresión de ruido:', 0.5);
    await untilMain(() => clip(v1.id).audio?.denoise === 0.5, 'ruido');
    await tool('enhance');
    await chip('voice');
    await untilMain(() => clip(v1.id).audio?.enhance === 'voice', 'mejora');
    await tool('audiofx');
    await chip('echo');
    await untilMain(() => clip(v1.id).audio?.effect === 'echo', 'efecto');
  });

  await step('Paneles Detección de escenas, Fotograma fijo y Detección de ritmo', async () => {
    await select('main', 1);
    await tool('scenes');
    await btn('Detectar escenas');
    await until('/escena/.test(T.toast())', 30000);
    const n = P().clips.length;
    await tool('freeze');
    await btn('Insertar fotograma fijo');
    await untilMain(() => P().clips.length === n + 2 && P().clips.some((c) => c.type === 'image'), 'fotograma fijo');
    await js('document.querySelector("[data-test=tb-undo]").click()');
    await untilMain(() => !P().clips.some((c) => c.type === 'image'), 'deshacer fotograma fijo');
    const [ck] = await x.host.editor.importMedia([f('click.wav')]);
    x.host.editor.addClip(ck.id);
    await until('document.querySelectorAll(".track.audio .clip").length >= 1');
    await select('audio', 0);
    await tool('beats');
    await btn('Detectar compases');
    await until('/ritmo|compases/.test(T.toast())', 30000);
  });

  await step('Panel Sincronizar audio (dos clips con Ctrl+clic)', async () => {
    x.host.editor.detachAudio(v1.id);
    await until('document.querySelectorAll(".track.audio .clip").length >= 2');
    await select('main', 0);
    await select('audio', 1, true);
    await tool('sync');
    await btn('Sincronizar');
    await until('/Sincronizados|Seleccione|distintas/.test(T.toast())', 30000);
    assert(await js('return /Sincronizados/.test(T.toast())'), `resultado: ${await js('return T.toast()')}`);
  });

  await step('Paneles Clave de croma, Imagen en imagen y Animación (pista superpuesta)', async () => {
    await select('main', 1);
    await tool('chroma');
    await btn('Mover a una pista de vídeo superpuesto');
    await untilMain(() => P().tracks.find((t) => t.id === clip(v2.id).trackId)?.kind === 'overlay', 'movido a la superpuesta');
    await until('document.querySelectorAll(".track.overlay .clip").length === 1');
    await select('overlay', 0);
    await tool('chroma');
    await btn('Aplicar');
    await untilMain(() => !!clip(v2.id).chroma, 'croma');
    await tool('pip');
    await chip('overlay');
    await untilMain(() => clip(v2.id).pip === 'overlay', 'PiP');
    await tool('animation');
    await row('Entrada:', 'fade');
    await untilMain(() => clip(v2.id).animIn?.type === 'fade', 'animación de entrada');
    await btn('Agregar cuadro clave');
    await untilMain(() => (clip(v2.id).keyframes?.length ?? 0) === 1, 'fotograma clave');
  });

  await step('Panel Añadir logotipo (archivo elegido en el diálogo)', async () => {
    await tool('logo');
    answers.open.push([f('logo.png')]);
    await btn('Añadir logotipo');
    await untilMain(() => P().clips.some((c) => c.name === 'Logotipo'), 'logotipo');
  });

  await step('Paneles Quitar silencios, Subtítulos (importar .srt), Música y Reencuadrar', async () => {
    const before = P().clips.filter((c) => c.trackId === P().tracks.find((t) => t.kind === 'main')!.id).length;
    await select('main', 0);
    await tool('silences');
    await row('Pausa mínima:', 0.5);
    await js('document.querySelector("[data-test=remove-silences]").click()');
    await until('/silencio/.test(T.toast())', 30000);
    assert(P().clips.filter((c) => c.trackId === P().tracks.find((t) => t.kind === 'main')!.id).length > before, 'el clip se partió en fragmentos');
    await tool('subs');
    answers.open.push([f('subs.srt')]);
    await btn('Importar .srt');
    await untilMain(() => P().tracks.some((t) => t.name === 'Subtítulos'), 'subtítulos importados');
    // click.wav (beats step) already sits on the «Música» track: wait for the generated music itself, or it lands
    // late — in whatever project is open by then (it used to split along with the clip in the palette step)
    const music = () => P().clips.filter((c) => P().tracks.find((t) => t.id === c.trackId)?.name === 'Música').length;
    const m0 = music();
    await tool('music');
    await btn('Añadir música');
    await untilMain(() => music() > m0, 'música', 60000);
    await until('/Música añadida/.test(T.toast())', 10000);
    await tool('reframe');
    await row('Modo:', 'crop');
    await btn('Reencuadrar');
    await untilMain(() => P().settings.width === 1080 && P().settings.height === 1920, '9:16');
    await js('document.querySelector("[data-test=tb-undo]").click()');
    await untilMain(() => P().settings.width === 1280, 'deshacer reencuadre');
  });

  await step('Editor de título: fuente, tamaño, color, negrita, animación, mayúsculas', async () => {
    const t = x.host.editor.addTitle('Título de prueba', { start: 0, duration: 3, trackId: P().tracks.find((tr) => tr.kind === 'title' && tr.name !== 'Subtítulos')?.id });
    await until(`document.querySelector('.clip[data-clip="${t.id}"]')`);
    await js(`document.querySelector('.clip[data-clip="${t.id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await until('document.querySelector("[data-test=title-text]")');
    await row('Fuente:', 'Georgia');
    await untilMain(() => clip(t.id).title?.font === 'Georgia', 'fuente');
    await row('Tamaño:', 120);
    await untilMain(() => clip(t.id).title?.size === 120, 'tamaño');
    await row('Color:', '#ff0000');
    await untilMain(() => clip(t.id).title?.color === '#ff0000', 'color');
    await row('Animación:', 'karaoke');
    await untilMain(() => clip(t.id).title?.anim === 'karaoke', 'animación');
    await row('Mayúsculas:', true);
    await untilMain(() => clip(t.id).title?.uppercase === true, 'mayúsculas');
  });

  await step('Propiedades de la transición (clic en la transición y duración)', async () => {
    const main = P().tracks.find((t) => t.kind === 'main')!;
    const list = P().clips.filter((c) => c.trackId === main.id).sort((a, b) => a.start - b.start);
    x.host.editor.setTransition(list[0].id, 'fade', 0.5);
    await until('document.querySelector(".trans")');
    await js('document.querySelector(".trans").click()');
    await until('document.querySelector(".panel select")');
    await row('Duración:', 0.3);
    await untilMain(() => Math.abs((clip(list[0].id).transition?.duration ?? 0) - 0.3) < 1e-6, 'duración de la transición');
  });

  await step('Menú contextual: clonar y separar audio', async () => {
    const main = P().tracks.find((t) => t.kind === 'main')!;
    const n = P().clips.filter((c) => c.trackId === main.id).length;
    await js(`const el = document.querySelector('.track.main .clip'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));`);
    await until('document.querySelector(".ctx")');
    await btn('Clonar');
    await untilMain(() => P().clips.filter((c) => c.trackId === main.id).length === n + 1, 'clonado');
  });

  await step('Copiar y pegar con el teclado', async () => {
    const n = P().clips.length;
    await select('main', 0);
    await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))');
    await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }))');
    await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }))');
    await untilMain(() => P().clips.length === n + 1, 'pegado');
  });

  await step('Recortar arrastrando el borde y mover un adhesivo a otra pista', async () => {
    const sticker = x.host.editor.addGraphic('sticker', 'heart', { start: 0, duration: 4 });
    await until(`document.querySelector('.clip[data-clip="${sticker.id}"]')`);
    // trim the right edge 40 px to the left
    await js(`const el = document.querySelector('.clip[data-clip="${sticker.id}"] .edge.r'); const r = el.getBoundingClientRect(); const x0 = r.left + 3, y = r.top + 5;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x0, clientY: y }));
      for (let k = 1; k <= 4; k++) dispatchEvent(new PointerEvent('pointermove', { clientX: x0 - 10 * k, clientY: y, altKey: true }));
      dispatchEvent(new PointerEvent('pointerup', { clientX: x0 - 40, clientY: y, altKey: true }));`);
    await untilMain(() => clip(sticker.id).out < 4 - 0.05, 'recortado por el borde');
    // drag it down onto the overlay track
    const ov = P().tracks.find((t) => t.kind === 'overlay')!;
    await js(`const el = document.querySelector('.clip[data-clip="${sticker.id}"]'); const r = el.getBoundingClientRect(); const tr = document.querySelector('.track[data-track="${ov.id}"]').getBoundingClientRect();
      const x0 = r.left + 6, y0 = r.top + 6, y1 = tr.top + tr.height / 2;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x0, clientY: y0 }));
      for (let k = 1; k <= 4; k++) dispatchEvent(new PointerEvent('pointermove', { clientX: x0, clientY: y0 + (y1 - y0) * k / 4, altKey: true }));
      dispatchEvent(new PointerEvent('pointerup', { clientX: x0, clientY: y1, altKey: true }));`);
    await untilMain(() => clip(sticker.id).trackId === ov.id, 'movido a la pista superpuesta');
  });

  await step('Arrastrar un filtro desde la colección hasta un clip', async () => {
    await js('document.querySelector("[data-test=tab-filters]").click()');
    await until('document.querySelector("[data-test=filter-sepia]")');
    const main = P().tracks.find((t) => t.kind === 'main')!;
    const target = P().clips.filter((c) => c.trackId === main.id).sort((a, b) => a.start - b.start)[0];
    const before = target.filters.length;
    await js(`const dt = new DataTransfer(); document.querySelector('[data-test=filter-sepia]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const el = document.querySelector('.clip[data-clip="${target.id}"]'); const r = el.getBoundingClientRect();
      const o = { bubbles: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.top + r.height / 2 };
      document.getElementById('tl-content').dispatchEvent(new DragEvent('dragover', o)); document.getElementById('tl-content').dispatchEvent(new DragEvent('drop', o));`);
    await untilMain(() => clip(target.id).filters.length === before + 1 && clip(target.id).filters.at(-1)!.type === 'sepia', 'filtro soltado');
  });

  await step('Zoom con Ctrl + rueda en la línea de tiempo', async () => {
    const w0 = await js<number>('return document.getElementById("tl-content").getBoundingClientRect().width');
    await js('document.getElementById("tl-scroll").dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: 400, clientY: 700 }))');
    await js('document.getElementById("tl-scroll").dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: 400, clientY: 700 }))');
    await wait(300);
    const w1 = await js<number>('return document.getElementById("tl-content").getBoundingClientRect().width');
    assert(w1 > w0 * 1.2, `acercar amplía la línea de tiempo (${w0} → ${w1})`);
  });

  await step('Importar con el botón «Añadir archivos» y asistente de presentación', async () => {
    await js('document.querySelector("[data-test=tab-import]").click()');
    await until('document.querySelector("[data-test=add-files]")');
    const n = P().clips.length;
    answers.open.push([f('logo.png')]);
    await js('document.querySelector("[data-test=add-files]").click()');
    await untilMain(() => P().clips.length === n + 1, 'archivo añadido');
    answers.open.push([f('logo.png'), f('logo.png')]);
    await js('[...document.querySelectorAll(".quick button")].find((b) => /presentaci/i.test(b.textContent)).click()');
    await until('[...document.querySelectorAll(".modal header span")].some((s) => s.textContent === "Asistente de presentación")');
    await btn('Crear');
    await untilMain(() => P().clips.length >= n + 3, 'presentación', 20000);
  });

  await step('Exportar con opciones: WebM, resolución, borrador y solo la selección', async () => {
    await select('main', 0);
    await js('document.querySelector("[data-test=export]").click()');
    await until('document.querySelector("[data-test=preset-webm]")');
    await js('document.querySelector("[data-test=preset-webm]").click()');
    await js(`const n = document.querySelector("[data-test=export-name]"); n.value = "seleccion"; n.closest(".body").querySelectorAll("input")[1].value = ${JSON.stringify(dir)};`);
    await row('Calidad:', 'draft');
    await row('Resolución:', '640x360');
    await row('Solo la selección:', true);
    await js('document.querySelector("[data-test=export-start]").click()');
    await js('document.querySelectorAll(".task.done").forEach((t) => t.classList.add("seen"))');
    await until('document.querySelector(".task.done:not(.seen), .task.failed")', 120000);
    const err = await js<string>('return document.querySelector(".modal pre")?.textContent ?? ""');
    if (err) (await import('node:fs')).writeFileSync(f('fallo-exportar.cinta'), JSON.stringify(P()));
    assert(!err, `error al exportar: ${err.slice(-400)}`);
    const info = mediaInfo(f('seleccion.webm'));
    const sel = P().clips.filter((c) => c.trackId === P().tracks.find((t) => t.kind === 'main')!.id).sort((a, b) => a.start - b.start)[0];
    assert(info.vcodec === 'vp9' && info.width === 640 && info.height === 360, `webm 640×360 (${info.vcodec} ${info.width}×${info.height})`);
    assert(Math.abs(info.duration - (sel.out - sel.in) / sel.speed) < 0.2, `solo la selección (${info.duration} s)`);
    await js('document.querySelectorAll(".backdrop").forEach((b) => b.remove())');
  });

  await step('Configuración del proyecto (diálogo)', async () => {
    x.win.webContents.send('menu', 'project-settings');
    await until('[...document.querySelectorAll(".modal header span")].some((s) => s.textContent === "Configuración del proyecto")');
    await row('Mantener relación de aspecto:', false);
    await js('const ins = document.querySelectorAll(".modal input[type=number]"); ins[0].value = "1920"; ins[1].value = "1080";');
    await btn('Aceptar');
    await untilMain(() => P().settings.width === 1920 && P().settings.height === 1080, 'resolución');
  });

  await step('Archivos que faltan: aviso y reubicar desde el diálogo', async () => {
    x.win.webContents.send('missing', [{ id: talk.id, path: talk.path }]);
    await until('[...document.querySelectorAll(".modal header span")].some((s) => s.textContent === "Faltan archivos")');
    answers.open.push([f('talk.mp4')]);
    await btn('Buscar');
    await until('document.querySelector(".modal .state.connected")');
    await js('document.querySelectorAll(".backdrop").forEach((b) => b.remove())');
  });

  await step('Cambio externo con cambios sin guardar: pregunta y recarga', async () => {
    x.host.saveTo(f('paneles.cinta'));
    await wait(700);
    x.host.editor.addMarker(1, 'sin guardar'); // dirty
    const ext = Editor.load(f('paneles.cinta'));
    ext.addMarker(2, 'desde la IA');
    answers.message.push(0); // «Recargar»
    ext.save(f('paneles.cinta'));
    await untilMain(() => P().markers.some((m) => m.name === 'desde la IA') && !P().markers.some((m) => m.name === 'sin guardar'), 'recargado tras preguntar', 10000);
    assert(asked.some((a) => a.includes('ha cambiado fuera de Cinta')), 'se preguntó al usuario');
  });

  await step('Preferencias: «Añadir» a Claude Desktop (configuración aislada)', async () => {
    const cfgDir = f('claude-desktop');
    mkdirSync(cfgDir, { recursive: true });
    process.env.CINTA_CLAUDE_DESKTOP_DIR = cfgDir;
    x.win.webContents.send('menu', 'preferences');
    await until('[...document.querySelectorAll(".modal header span")].some((s) => s.textContent === "Preferencias")');
    await btn('Añadir');
    await until('/connected/.test(document.querySelector(".modal .state")?.className ?? "")', 600000);
    const cfg = JSON.parse(readFileSync(join(cfgDir, 'claude_desktop_config.json'), 'utf8'));
    assert(cfg.mcpServers?.cinta?.args?.[0]?.endsWith('mcp.js'), 'entrada de Cinta escrita');
    // start the registered command exactly as Claude would and ask it for its tools (MCP over stdio)
    const entry = cfg.mcpServers.cinta as { command: string; args: string[]; env?: Record<string, string> };
    const { spawn } = await import('node:child_process');
    const child = spawn(entry.command, entry.args, { env: { ...process.env, ...entry.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const reply = new Promise<string>((ok, ko) => {
      const t = setTimeout(() => ko(new Error('el servidor MCP no respondió')), 30000);
      child.stdout.on('data', (d: Buffer) => { buf += d; if (buf.includes('"id":2')) { clearTimeout(t); ok(buf); } });
    });
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const out = await reply.finally(() => child.kill());
    assert(/"name":"export"/.test(out) && /"name":"auto_subtitles"/.test(out), 'el servidor registrado responde con sus herramientas');
    await js('document.querySelectorAll(".backdrop").forEach((b) => b.remove())');
  });

  await step('Autoguardado y recuperación tras un cierre inesperado', async () => {
    x.host.editor.addMarker(3.3, 'antes del cierre');
    assert(x.host.autosaveNow(), 'se guardó automáticamente');
    const own = x.host.autosaveFile();
    const fs = await import('node:fs');
    // pretend a previous Cinta (a process that no longer exists) left it behind
    const orphan = own.replace(/session-\d+\.json$/, 'session-999999.json');
    fs.copyFileSync(own, orphan);
    const saved = JSON.parse(fs.readFileSync(orphan, 'utf8'));
    x.host.attach(new Editor(newProject()));
    answers.message.push(0); // «Recuperar»
    assert(await x.host.checkRecovery(), 'recuperado');
    assert(P().markers.some((m) => m.name === 'antes del cierre') && P().clips.length === saved.project.clips.length, 'proyecto recuperado completo');
    assert(!fs.existsSync(orphan), 'copia huérfana borrada');
    assert(asked.some((a) => a.includes('se cerró sin guardar')), 'se preguntó al usuario');
  });

  // ───────────── redesign ─────────────
  const fresh = async () => {
    x.host.attach(new Editor(newProject({ width: 1280, height: 720 })));
    const [a, b] = await x.host.editor.importMedia([f('talk.mp4'), f('red.mp4')]);
    const c1 = x.host.editor.addClip(a.id), c2 = x.host.editor.addClip(b.id);
    await until('document.querySelectorAll(".track.main .clip").length === 2');
    return [c1, c2];
  };
  const seek = async (frames: number) => {
    await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }))');
    for (let i = 0; i < frames; i++) await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }))');
  };

  await step('Inspector: muestra el clip seleccionado, cambia su duración y se oculta con F4', async () => {
    const [, c2] = await fresh();
    await select('main', 1);
    await until('/red/.test(document.querySelector("#inspector .insp-title")?.textContent ?? "")');
    await js('const i = document.querySelector("[data-test=insp-duration]"); i.value = "2"; i.dispatchEvent(new Event("change"));');
    await untilMain(() => Math.abs((clip(c2.id).out - clip(c2.id).in) - 2) < 0.01, 'duración desde el inspector');
    await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "F4" }))');
    await until('document.getElementById("app").classList.contains("no-inspector")');
    await js('document.querySelector("[data-test=inspector-toggle]").click()');
    await until('!document.getElementById("app").classList.contains("no-inspector")');
  });

  await step('Paleta de comandos (Ctrl+K): buscar «dividir» y ejecutar con Intro', async () => {
    await seek(30);
    const n = P().clips.length;
    await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))');
    await until('document.querySelector("[data-test=palette-input]")');
    await js('const i = document.querySelector("[data-test=palette-input]"); i.value = "dividir"; i.dispatchEvent(new Event("input"));');
    assert(await js('return /Dividir clip/.test(document.querySelector(".pal-item.on")?.textContent ?? "")'), 'primer resultado «Dividir clip»');
    await js('document.querySelector("[data-test=palette-input]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))');
    await untilMain(() => P().clips.length === n + 1, 'dividido desde la paleta');
    await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))');
    await js('const i = document.querySelector("[data-test=palette-input]"); i.value = "sepia"; i.dispatchEvent(new Event("input"));');
    assert(await js('return /Filtro/.test(document.querySelector(".pal-item.on")?.textContent ?? "")'), 'busca filtros');
    await js('document.querySelector("[data-test=palette-input]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
    await until('!document.querySelector(".palette")');
  });

  await step('Vista previa al pasar el ratón por un filtro (sin cambiar el proyecto)', async () => {
    await select('main', 0);
    await js('document.querySelector("[data-test=tab-filters]").click()');
    await until('document.querySelector("[data-test=filter-bw]")');
    await js('document.querySelectorAll(".item").forEach((i) => i.dispatchEvent(new MouseEvent("mouseleave")))');
    await until('!document.querySelector("[data-test=try-label]")');
    await wait(1500);
    const before = JSON.stringify(P().clips.map((c) => c.filters));
    const src0 = await js<string>('return document.getElementById("frame").src');
    await js('document.querySelector("[data-test=filter-bw]").dispatchEvent(new MouseEvent("mouseenter"))');
    await until('document.querySelector("[data-test=try-label]")', 15000);
    const src1 = await js<string>('return document.getElementById("frame").src');
    assert(src1 !== src0, `el reproductor muestra la prueba (antes ${src0.length} ${src0.slice(-40)} · después ${src1.length} ${src1.slice(-40)})`);
    await js('document.querySelector("[data-test=filter-bw]").dispatchEvent(new MouseEvent("mouseleave"))');
    await until('!document.querySelector("[data-test=try-label]")');
    assert(JSON.stringify(P().clips.map((c) => c.filters)) === before, 'el proyecto no cambió');
  });

  await step('Editar el texto de un título directamente en el reproductor', async () => {
    const t = x.host.editor.addTitle('Antes', { start: 0, duration: 3 });
    await seek(15);
    await until(`document.querySelector('.clip[data-clip="${t.id}"]')`);
    await js(`T.select('title', 0)`);
    await until('document.querySelector("#handles .handle-box")');
    await js('document.querySelector("#handles .handle-box").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
    await until('document.querySelector("[data-test=inline-title]")');
    await js('const ta = document.querySelector("[data-test=inline-title]"); ta.value = "Escrito sobre la imagen"; ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));');
    await untilMain(() => clip(t.id).title?.text === 'Escrito sobre la imagen', 'texto cambiado');
  });

  await step('Girar un adhesivo con el tirador del reproductor', async () => {
    const st = x.host.editor.addGraphic('sticker', 'star', { start: 0, duration: 3 });
    await until(`document.querySelector('.clip[data-clip="${st.id}"]')`);
    await js(`const el = document.querySelector('.clip[data-clip="${st.id}"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + 5, clientY: r.top + 5 })); dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5, clientY: r.top + 5 }));`);
    await until('document.querySelector("#handles .rot")');
    await js(`const k = document.querySelector('#handles .rot'); const b = document.querySelector('#handles .handle-box').getBoundingClientRect(); const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      k.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: cx, clientY: b.top - 20 }));
      dispatchEvent(new PointerEvent('pointermove', { clientX: cx + 200, clientY: cy }));
      dispatchEvent(new PointerEvent('pointerup', { clientX: cx + 200, clientY: cy }));`);
    await untilMain(() => Math.abs((clip(st.id).transform?.rotation ?? 0) - 90) < 2, `girado 90° (${clip(st.id).transform?.rotation})`);
  });

  await step('Guías de composición (tercios) y fundidos visibles en la línea de tiempo', async () => {
    await js('document.querySelector("[data-test=guides]").click()');
    await until('document.querySelector(".ctx")');
    await btn('Regla de los tercios');
    await until('document.querySelectorAll("#guides svg line").length === 4');
    await js('document.querySelector("[data-test=guides]").click()');
    await btn('Sin guías');
    const c = P().clips.find((cl) => cl.type === 'video')!;
    x.host.editor.set(c.id, { fadeIn: 1 });
    await until(`document.querySelector('.clip[data-clip="${c.id}"] .fade.in')`);
  });

  await step('Altura de pista ajustable arrastrando su cabecera', async () => {
    const h0 = await js<number>('return document.querySelector(".track.main").getBoundingClientRect().height');
    await js(`const rows = [...document.querySelectorAll('.th-row')]; const main = rows.find((r) => r.querySelector('[title*="espacio vacío"]')); const g = main.querySelector('.th-grip'); const r = g.getBoundingClientRect();
      g.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + 5, clientY: r.top + 2 }));
      dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 5, clientY: r.top + 32 }));
      dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5, clientY: r.top + 32 }));`);
    const h1 = await js<number>('return document.querySelector(".track.main").getBoundingClientRect().height');
    assert(h1 >= h0 + 25, `altura ${h0} → ${h1}`);
    await js('localStorage.removeItem("cinta.heights")');
  });

  await step('Exportar en segundo plano: se sigue editando y se exporta lo que había al pulsar', async () => {
    const dur = (await import('../core')).projectDuration(P());
    await js('document.querySelector("[data-test=export]").click()');
    await until('document.querySelector("[data-test=export-start]")');
    await js(`const n = document.querySelector("[data-test=export-name]"); n.value = "fondo"; n.closest(".body").querySelectorAll("input")[1].value = ${JSON.stringify(dir)};`);
    await row('Calidad:', 'draft');
    await js('document.querySelectorAll(".task.done").forEach((t) => t.classList.add("seen"))');
    await js('document.querySelector("[data-test=export-start]").click()');
    await until('!document.querySelector(".modal")');
    // edit while it exports: delete the first clip
    const first = P().clips.filter((c) => c.trackId === P().tracks.find((t) => t.kind === 'main')!.id).sort((a, b) => a.start - b.start)[0];
    x.host.editor.remove([first.id]);
    await until('document.querySelector(".task.done:not(.seen)")', 120000);
    const info = mediaInfo(f('fondo.mp4'));
    assert(Math.abs(info.duration - dur) < 0.2, `exportó la versión de cuando se pulsó (${info.duration} vs ${dur})`);
    assert(await js('return !!document.querySelector("[data-test=notice]")'), 'aviso de exportación terminada');
    await js('document.querySelectorAll(".notice").forEach((n) => n.remove())');
  });

  await step('Plantilla de inicio «Short, Reel o TikTok» (proyecto vacío)', async () => {
    x.host.attach(new Editor(newProject({ width: 1920, height: 1080 })));
    await js('document.querySelector("[data-test=tab-import]").click()');
    await until('document.querySelector("[data-test=tpl-9-16]")');
    answers.open.push([f('red.mp4')]);
    answers.message.push(1); // «No cambiar» the aspect to match the file
    await js('document.querySelector("[data-test=tpl-9-16]").click()');
    await untilMain(() => P().settings.width === 1080 && P().settings.height === 1920 && P().clips.length === 1, 'proyecto 9:16 con el vídeo');
  });

  await step('Plantilla «Short automático»: silencios, cara 9:16, subtítulos y música en una tarea', async () => {
    x.host.attach(new Editor(newProject()));
    await js('document.querySelector("[data-test=tab-import]").click()');
    await until('document.querySelector("[data-test=tpl-auto-short]")');
    answers.open.push([f('talk.mp4')]);
    answers.message.push(1);
    await js('document.querySelectorAll(".task.done").forEach((t) => t.classList.add("seen"))');
    await js('document.querySelector("[data-test=tpl-auto-short]").click()');
    await until('document.querySelector(".task.done:not(.seen), .task.failed")', 240000);
    assert(!(await js('return !!document.querySelector(".task.failed")')), `la tarea falló: ${await js('return document.querySelector(".task.failed .tk-note")?.textContent')}`);
    assert(P().settings.height === 1920 && P().tracks.some((t) => t.name === 'Música'), 'vertical y con música');
    assert(P().clips.filter((c) => c.type === 'video' && P().tracks.find((t) => t.id === c.trackId)?.kind === 'main').length >= 2, 'sin silencios (troceado)');
    await js('document.querySelectorAll(".notice").forEach((n) => n.remove())');
  });

  await step('Guía de primer uso y nombres accesibles de los botones', async () => {
    x.win.webContents.send('menu', 'tour');
    await until('document.querySelector("[data-test=tour]")');
    for (let i = 0; i < 6 && await js('return !!document.querySelector("[data-test=tour]")'); i++) await js('[...document.querySelectorAll("[data-test=tour] button")].pop().click()');
    await until('!document.querySelector("[data-test=tour]")');
    const unnamed = await js<number>('return [...document.querySelectorAll("#toolbar button, #rail button, #transport button, #player-right button")].filter((b) => !b.getAttribute("aria-label") && !b.textContent.trim()).length');
    assert(unnamed === 0, `${unnamed} botones sin nombre accesible`);
  });

  // ───────────── AI: with Claude (copyable requests) or an optional local AI (mocked here) ─────────────
  const http = await import('node:http');
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = JSON.parse(body || '{}') as { messages?: { role: string; content: string }[] };
      const sys = j.messages?.[0]?.content ?? '', user = j.messages?.[1]?.content ?? '';
      let answer = 'OK';
      if (/traductor/i.test(sys)) answer = JSON.stringify((JSON.parse(user) as string[]).map((t) => `PT: ${t}`));
      else if (/cap[ií]tulos/i.test(sys)) answer = '[{"time": 0, "title": "Inicio"}, {"time": 1.5, "title": "La prueba"}]';
      else if (/fragmentos/i.test(sys)) answer = 'Aquí tiene: ```json\n[{"start": 0, "end": 2.5, "title": "GANCHO"}]\n```';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }));
    });
  });
  await new Promise<void>((ok) => mock.listen(0, '127.0.0.1', () => ok()));
  const mockUrl = `http://127.0.0.1:${(mock.address() as { port: number }).port}/v1`;

  await step('IA: vídeo hablado, transcribir y editar con el texto (sin ninguna IA)', async () => {
    const { speak, findWhisperModel } = await import('../core');
    if (!findWhisperModel()) { say('      (sin modelo Whisper: se omite)'); return; }
    const wav = await speak('Hola a todos. Esto es una prueba de edición con el texto. Gracias por ver.', { output: f('habla.wav'), voice: 'es' });
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=0x203040:s=640x360:r=30:d=8', '-i', wav, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('habla.mp4')]);
    x.host.attach(new Editor(newProject({ width: 1280, height: 720 })));
    const [m] = await x.host.editor.importMedia([f('habla.mp4')]);
    x.host.editor.addClip(m.id);
    await until('document.querySelectorAll(".track.main .clip").length === 1');
    await tool('transcript');
    await until('document.querySelector("[data-test=transcribe]")');
    await js('document.querySelector("[data-test=transcribe]").click()');
    await until('document.querySelectorAll("[data-test=tx-text] .tx-w").length > 5', 60000);
    const d0 = (await import('../core')).projectDuration(P());
    await js('const ws = document.querySelectorAll("[data-test=tx-text] .tx-w"); ws[0].click(); ws[1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));');
    await js('document.querySelector("[data-test=tx-cut]").click()');
    await untilMain(() => (P().clips.length > 1 || (P().clips[0].in > 0.05)) , 'corte por palabras');
    const d1 = (await import('../core')).projectDuration(P());
    assert(d1 < d0 - 0.2, `más corto tras quitar dos palabras (${d0} → ${d1})`);
    await until('document.querySelector("[data-test=tx-subs]")');
    await js('document.querySelector("[data-test=tx-subs]").click()');
    await untilMain(() => P().tracks.some((t) => t.name === 'Subtítulos' && P().clips.some((c) => c.trackId === t.id)), 'subtítulos desde el texto');
  });

  await step('IA sin configurar: cada panel ofrece pedírselo a Claude (y copiarlo)', async () => {
    await tool('translate');
    await until('document.querySelector(".claude-box")');
    assert(!(await js('return !!document.querySelector("[data-test=llm-translate]")')), 'sin IA local no aparece el botón');
    await js('[...document.querySelectorAll(".claude-box .btn")].pop().click()');
    await until('/Copiado/.test(T.toast())');
    await tool('assistant');
    await until('document.querySelectorAll(".claude-box").length >= 5');
  });

  await step('Preferencias: configurar una IA local (Ollama/LM Studio) y probar la conexión', async () => {
    x.win.webContents.send('menu', 'preferences');
    await until('document.querySelector("[data-test=llm-url]")');
    await js(`const u = document.querySelector('[data-test=llm-url]'); u.value = ${JSON.stringify(mockUrl)}; u.dispatchEvent(new Event('change')); const m = document.querySelector('[data-test=llm-model]'); m.value = 'prueba'; m.dispatchEvent(new Event('change')); const c = document.querySelector('[data-test=llm-enabled]'); c.checked = true; c.dispatchEvent(new Event('change'));`);
    await js('document.querySelector("[data-test=llm-test]").click()');
    await until('/Responde correctamente/.test(document.querySelector("[data-test=llm-result]").textContent)', 15000);
    await js('document.querySelectorAll(".backdrop").forEach((b) => b.remove())');
    await wait(3200); // the panels re-read the setting
  });

  await step('IA local: traducir subtítulos, capítulos y mejores momentos → shorts', async () => {
    if (!P().tracks.some((t) => t.name === 'Subtítulos')) { say('      (sin subtítulos previos: se omite)'); return; }
    await tool('translate');
    await until('document.querySelector("[data-test=llm-translate]")');
    await row('Idioma:', 'pt');
    await js('document.querySelector("[data-test=llm-translate]").click()');
    await untilMain(() => { const t = P().tracks.find((tr) => tr.name === 'Subtítulos (pt)'); return !!t && P().clips.filter((c) => c.trackId === t.id).every((c) => c.title?.text.startsWith('PT: ')); }, 'pista traducida');
    await tool('chapters');
    await until('document.querySelector("[data-test=llm-chapters]")');
    await js('document.querySelector("[data-test=llm-chapters]").click()');
    await untilMain(() => P().markers.filter((mk) => mk.name.startsWith('Capítulo: ')).length === 2, 'capítulos');
    await row('Nuevo en el cursor:', 'Despedida');
    await btn('Añadir capítulo aquí');
    await untilMain(() => P().markers.some((mk) => mk.name === 'Capítulo: Despedida'), 'capítulo a mano');
    await tool('shortsai');
    await until('document.querySelector("[data-test=llm-shorts]")');
    await js('document.querySelector("[data-test=llm-shorts]").click()');
    await until('/shorts creados/.test(T.toast())', 120000);
    const dirS = join(await js<string>('return window.cinta.invoke("export:dir")'), 'Shorts');
    const files = (await import('node:fs')).readdirSync(dirS).filter((n) => /GANCHO/.test(n) && n.endsWith('.cinta'));
    assert(files.length >= 1, `short del mejor momento en ${dirS}`);
    await js('document.querySelector("[data-test=short-manual]").click()');
    await until('/Short creado/.test(T.toast())', 60000);
  });

  await step('Voz en off desde texto (voces de Windows)', async () => {
    await tool('tts');
    await until('document.querySelector("[data-test=tts-text]")');
    await js('const t = document.querySelector("[data-test=tts-text]"); t.value = "Bienvenidos a esta clase.";');
    await js('document.querySelector("[data-test=tts-create]").click()');
    await untilMain(() => P().tracks.some((t) => t.name === 'Voz' && P().clips.some((c) => c.trackId === t.id)), 'voz en off', 30000);
    mock.close();
  });

  await step('Acerca de: enlaces a las licencias', async () => {
    x.win.webContents.send('menu', 'about');
    await until('document.querySelector("[data-test=licenses]")');
    const l = await js<{ license: string; notices: string }>('return window.cinta.invoke("licenses")');
    assert(existsSync(l.license) && existsSync(l.notices), `licencias presentes (${l.notices})`);
    await js('document.querySelectorAll(".backdrop").forEach((b) => b.remove())');
  });
  void ({} as Clip);
}
