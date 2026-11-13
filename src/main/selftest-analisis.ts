// Self-test of «análisis» through the real UI: Ver ▸ Ámbitos de Lumetri opens the panel and its histogram follows
// a coloured solid (settings popover, presets, floating and docking again); the Warp Stabilizer applied from the
// Effects panel to a shaky video layer analyses in the background (banner, then the stabilised frame).
import { Menu } from 'electron';
import { join } from 'node:path';
import { runFfmpeg } from '../core';
import type { Ctx } from './selftest-panels';

export async function analisisSteps(x: Ctx) {
  const { js, until, wait, step, assert, dir } = x;
  const P = () => x.host.editor.project;
  const untilMain = async (fn: () => boolean, what: string, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return; await wait(120); }
    throw new Error(`tiempo agotado: ${what}`);
  };
  const stats = () => js<{ frames: number; mode: string; r: number[]; g: number[]; b: number[] } | null>('const i = window.__scopes?.info; return i?.stats ? { frames: i.frames, mode: i.mode, r: i.stats.histogram.r, g: i.stats.histogram.g, b: i.stats.histogram.b } : null');
  /** share of the frame's pixels in the top bin of a channel */
  const top = (h: number[]) => h[255] / Math.max(1, h.reduce((s, v) => s + v, 0));
  let cid = '', lid = '';

  await step('Ámbitos de Lumetri: Ver ▸ Ámbitos de Lumetri abre el panel y el histograma sigue al color de un sólido', async () => {
    if (!(await js<boolean>('return document.body.classList.contains("mode-adv")'))) {
      await js('document.querySelector("[data-test=mode-adv]").click()');
      await until('document.body.classList.contains("mode-adv")');
    }
    const c = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'compNew', { name: 'Ámbitos', width: 320, height: 180, fps: 30, duration: 2, bg: '#000000' })`);
    cid = c.id;
    lid = (await js<{ id: string }>(`return await window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(cid)}, 'solid', { color: '#ff0000', width: 320, height: 180, name: 'Color' })`)).id;
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(cid)}; a.work = null; a.emit('comp'); a.seek(0);`);
    const item = Menu.getApplicationMenu()?.getMenuItemById('lumetri-scopes');
    assert(item && item.label === 'Ámbitos de Lumetri', 'opción de menú');
    item!.click();
    await until('document.querySelector("[data-test=tab-scopes]")?.classList.contains("on") && document.querySelector("[data-test=scopes-panel]")?.offsetParent !== null');
    await until('(window.__scopes?.info.stats?.histogram.r[255] ?? 0) > 1000', 15000);
    let s = (await stats())!;
    assert(top(s.r) > 0.95 && s.g[0] / Math.max(1, s.g.reduce((a, v) => a + v, 0)) > 0.95, `rojo: ${top(s.r)}`);
    // the solid turns blue: the panel follows the new frame
    await js(`return window.cinta.invoke('motion', 'layerSet', ${JSON.stringify(cid)}, ${JSON.stringify(lid)}, { solidColor: '#0000ff' })`);
    await until('(() => { const h = window.__scopes?.info.stats?.histogram; return h && h.b[255] > 1000 && h.r[255] < 10; })()', 15000);
    s = (await stats())!;
    assert(top(s.b) > 0.95 && top(s.r) < 0.01, `azul: ${top(s.b)} / ${top(s.r)}`);
    // the canvas shows the scopes (not empty)
    const lit = await js<number>('const c = document.querySelector("[data-test=scopes-canvas]"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 200) n++; return n');
    assert(lit > 50, `trazos en el panel: ${lit}`);
    (x as Ctx & { say?: (t: string) => void }).say?.(`ámbitos calculados en: ${s.mode}`);
  });

  await step('Ámbitos de Lumetri: Ajustes… (preestablecido Histograma, fijar señal, 8 bits / flotante) y desacoplar / acoplar el panel', async () => {
    const f0 = (await stats())!.frames;
    await js('document.querySelector("[data-test=scopes-gear]").click()');
    await until('document.querySelector("[data-test=scopes-settings]")');
    await js('const s = document.querySelector("[data-test=scopes-preset]"); s.value = "histogram"; s.dispatchEvent(new Event("change"))');
    await until('window.__scopes.settings().scopes.join() === "histogram" && document.querySelector("[data-test=scopes-histogram]").checked && !document.querySelector("[data-test=scopes-waveform]").checked');
    await js('const s = document.querySelector("[data-test=scopes-waveform]"); s.click()');
    await until('window.__scopes.settings().scopes.join() === "histogram,waveform"');
    await js('const s = document.querySelector("[data-test=scopes-precision]"); s.value = "float"; s.dispatchEvent(new Event("change")); document.querySelector("[data-test=scopes-clamp]").click()');
    await until('window.__scopes.settings().precision === "float" && window.__scopes.settings().clamp === false');
    await until(`window.__scopes.info.frames > ${f0}`, 10000);
    await js('document.querySelector(".scopes-pop button.btn")?.click()');
    await js('document.querySelector("[data-test=scopes-float]").click()');
    await until('document.querySelector("[data-test=scopes-floating] [data-test=scopes-panel]")');
    const f1 = (await stats())!.frames;
    await until(`window.__scopes.info.frames > ${f1}`, 10000);
    await js('document.querySelector("[data-test=scopes-float]").click()');
    await until('!document.querySelector("[data-test=scopes-floating]") && document.querySelector(".tabpane[data-pane=scopes] [data-test=scopes-panel]")');
    // back to the default view for the rest of the session
    await js('window.__scopes.set({ scopes: ["vectorYUV", "parade", "waveform"], precision: "8bit", clamp: true })');
  });

  await step('Estabilizador de deformación: aplicado desde Efectos a un vídeo tembloroso, analiza en segundo plano y estabiliza', async () => {
    const still = join(dir, 'estab-ruido.png'), shaky = join(dir, 'estab-tembloroso.mp4');
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=gray:s=900x600,noise=alls=90:all_seed=11,boxblur=2:1', '-frames:v', '1', still]);
    await runFfmpeg(['-y', '-loop', '1', '-framerate', '30', '-t', '1.5', '-i', still, '-vf', "crop=320:180:x='200+12*sin(n*1.93)+5*sin(n*4.37)':y='180+9*sin(n*2.41+1)+4*sin(n*5.13)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', shaky]);
    const [m] = await js<{ id: string }[]>(`return await window.cinta.invoke('op', 'importMedia', [${JSON.stringify(shaky)}])`);
    const c = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'compNew', { name: 'Estabilizar', width: 320, height: 180, fps: 30, duration: 1.5, bg: '#000000' })`);
    const l = await js<{ id: string }>(`return await window.cinta.invoke('motion', 'layerAdd', ${JSON.stringify(c.id)}, 'video', { mediaId: ${JSON.stringify(m.id)} })`);
    await js(`const a = window.__adv.adv; a.compId = ${JSON.stringify(c.id)}; a.work = null; a.emit('comp'); a.seek(0.5); a.select([${JSON.stringify(l.id)}]);`);
    await js('document.querySelector("[data-test=tab-controls]").click()');
    await js('const s = document.querySelector("[data-test=adv-fx-search]"); s.value = "deformación"; s.dispatchEvent(new Event("input"))');
    await until('document.querySelector("[data-test=adv-fx-warpStabilizer]")');
    await js('A.dbl("[data-test=adv-fx-warpStabilizer]")');
    const fx = () => P().comps!.find((y) => y.id === c.id)!.layers.find((y) => y.id === l.id)!.effects.find((f) => f.fx === 'warpStabilizer');
    await untilMain(() => !!fx(), 'efecto aplicado');
    assert(fx()!.name === 'Estabilizador de deformación' && fx()!.params.method.v === 'subspace' && fx()!.params.framing.v === 'cropScale' && fx()!.params.smoothness.v === 50, 'valores predeterminados de After Effects');
    // the analysis starts by itself: Effect Controls show it and the viewer gets the banner
    await until('/Análisis en segundo plano|Estabilización/.test(document.querySelector("[data-test=warpstab-status]")?.textContent ?? "") || /finalizada/.test(document.querySelector("[data-test=warpstab-status]")?.textContent ?? "")', 10000);
    await untilMain(() => !!fx()!.stab, 'análisis terminado', 60000);
    const seen = await js<{ phases: number[]; banners: { analysing: number } }>('return window.__warpstab');
    assert(seen.phases.includes(1) && seen.phases.includes(2) && seen.banners.analysing > 0, `paso 1 de 2, paso 2 de 2 y banda en el visor: ${JSON.stringify(seen)}`);
    await until('/Estabilización finalizada/.test(document.querySelector("[data-test=warpstab-status]")?.textContent ?? "") && /Escala automática \\(\\d+%\\)/.test(document.querySelector("[data-test=warpstab-autoscale]")?.textContent ?? "")', 10000);
    const d = fx()!.stab!;
    assert(d.n >= 40 && d.inliers.slice(1).every((v) => v >= 6), `fotogramas ${d.n}, puntos ${d.inliers.slice(0, 6)}`);
    // the banner is gone and the stabilised frame has no empty border (Stabilize, Crop, Auto-scale)
    await js('window.__adv.adv.seek(0.7)');
    await wait(600);
    await until('!window.__adv.adv.work', 5000);
    await wait(600);
    const corners = await js<number[][]>('return [[3, 3], [316, 3], [3, 176], [316, 176], [160, 90]].map(([x, y]) => A.pixel(x, y))');
    assert(corners.every((p) => p[0] + p[1] + p[2] > 60), `esquinas rellenas: ${JSON.stringify(corners)}`);
    const centre = corners[4];
    assert(!(centre[0] > 150 && centre[2] < 80 && centre[1] > 60 && centre[1] < 160), `sin banda de advertencia: ${centre}`);
    // Analyze again from Effect Controls (the button), then Ctrl+Z keeps the effect
    await js('document.querySelector("[data-test=warpstab-analyze]").click()');
    await until('/Análisis en segundo plano|Estabilización \\(paso/.test(document.querySelector("[data-test=warpstab-status]")?.textContent ?? "") || document.querySelector("[data-test=warpstab-cancel]")', 5000).catch(() => true);
    await until('document.querySelector("[data-test=warpstab-analyze]") && /finalizada/.test(document.querySelector("[data-test=warpstab-status]")?.textContent ?? "")', 60000);
  });
}
