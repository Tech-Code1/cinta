// Demo / stress test: builds an 8 s 1080p60 intro using every advanced-mode feature through the MCP server
// (the same calls an AI makes), renders key frames and the final MP4.
//   node scripts/demo-intro.mjs <work dir> [--exe=<Cinta.exe>]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'demo'));
const exe = process.argv.find((a) => a.startsWith('--exe='))?.slice(6);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const FF = join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const serverJs = exe ? join(dirname(exe), 'resources', 'app.asar.unpacked', 'dist', 'main', 'mcp.js') : join(root, 'dist', 'main', 'mcp.js');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CINTA_CACHE: join(out, 'cache'), CINTA_USER_DATA: join(out, 'ud'), CINTA_NO_CLAUDE_CODE: '1', CINTA_CLAUDE_DESKTOP_DIR: join(out, 'cd') };
const client = new Client({ name: 'cinta-demo', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: exe ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [serverJs], env }));
const log = [];
async function call(name, args = {}) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
  const ms = Date.now() - t0;
  if (r.isError) { console.log(`✘ ${name}: ${r.content?.[0]?.text}`); log.push({ name, ok: false, error: r.content?.[0]?.text }); throw new Error(r.content?.[0]?.text); }
  log.push({ name, ok: true, ms });
  return r.structuredContent;
}
const P = join(out, 'intro.cinta');
const M = 'Intro Cinta';

// media: a test video with sound and generated music
execFileSync(FF, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=330:d=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(out, 'clip.mp4')]);
await call('project_new', { path: P, width: 1920, height: 1080, fps: 60 });
const music = await call('media_generate', { project: P, kind: 'music', name: 'upbeat', duration: 8 });

// ───── precomp «Pantalla»: video in slow motion with a live badge and a frame ─────
await call('comp_new', { project: P, name: 'Pantalla', width: 1280, height: 720, fps: 60, duration: 8, transparent: true });
const vid = await call('layer_add', { project: P, comp: 'Pantalla', type: 'video', media_path: join(out, 'clip.mp4') });
await call('layer_set', { project: P, comp: 'Pantalla', layer: vid.layer.id, stretch: 2, out: 8 });
await call('mask_add', { project: P, comp: 'Pantalla', layer: vid.layer.id, shape: 'rect', x: 0, y: 0, width: 1280, height: 720, feather: 6 });
const frame = await call('shape_add', { project: P, comp: 'Pantalla', kind: 'rect', width: 1260, height: 700, roundness: 24, color: null, stroke: '#ffffff', stroke_width: 10, name: 'Marco' });
await call('shape_set', { project: P, comp: 'Pantalla', layer: frame.layer.id, shape: 'Marco', trim: { end: 0 }, cap: 'round' });
await call('prop_set', { project: P, comp: 'Pantalla', layer: frame.layer.id, path: `shapes.Marco.trim.end`, keys: [{ t: 3.4, v: 0 }, { t: 4.4, v: 100, ease: 'easy' }] });
const badge = await call('layer_add', { project: P, comp: 'Pantalla', type: 'text', text: '● EN VIVO', size: 54, color: '#ff4757', position: [150, 80] });
await call('layer_set', { project: P, comp: 'Pantalla', layer: badge.layer.id, text_style: { align: 'left' } });
await call('prop_set', { project: P, comp: 'Pantalla', layer: badge.layer.id, path: 'opacity', expression: 'Math.sin(time * Math.PI * 2) > -0.3 ? 100 : 25' });

// ───── main composition ─────
await call('comp_new', { project: P, name: M, width: 1920, height: 1080, fps: 60, duration: 8, bg: '#05070c' });
await call('comp_set', { project: P, comp: M, motion_blur: { on: true, shutter: 220, samples: 16 } });
await call('preset_apply', { project: P, comp: M, preset: 'bgNoise', colors: ['#04060d', '#16306b'] });
await call('preset_apply', { project: P, comp: M, preset: 'lightLeak' });
await call('preset_apply', { project: P, comp: M, preset: 'bgParticles', color: '#9fd3ff' });

// null that makes the logo group float
const ctl = await call('layer_add', { project: P, comp: M, type: 'null', name: 'Control', position: [960, 470] });
await call('prop_set', { project: P, comp: M, layer: 'Control', path: 'position', expression: 'add(value, [Math.sin(time * 1.3) * 18, Math.cos(time * 0.9) * 12, 0])' });

// rings: trim paths drawing on, rotating, repeated
const rings = await call('shape_add', { project: P, comp: M, kind: 'ellipse', width: 520, height: 520, color: null, stroke: '#4aa8ff', stroke_width: 6, trim: { start: 0, end: 0, offset: 0 }, repeater: { copies: 4, scale: [84, 84], rotation: 25, startOpacity: 100, endOpacity: 25 }, name: 'Aros' });
await call('layer_set', { project: P, comp: M, layer: rings.layer.id, name: 'Aros', parent: 'Control', motion_blur: true });
await call('prop_set', { project: P, comp: M, layer: 'Aros', path: 'position', value: [0, 0] });
await call('prop_set', { project: P, comp: M, layer: 'Aros', path: 'shapes.Aros.trim.end', keys: [{ t: 0.2, v: 0 }, { t: 1.4, v: 75, ease: 'easy' }] });
await call('prop_set', { project: P, comp: M, layer: 'Aros', path: 'shapes.Aros.trim.offset', expression: 'time * 140' });
await call('prop_set', { project: P, comp: M, layer: 'Aros', path: 'rotation', expression: 'time * -35' });
await call('prop_set', { project: P, comp: M, layer: 'Aros', path: 'scale', keys: [{ t: 0, v: [40, 40] }, { t: 1.2, v: [100, 100], ease: 'easy' }] });

// 3D star logo with gradient, glow and echo trail, elastic arrival
const star = await call('shape_add', { project: P, comp: M, kind: 'star', width: 300, inner_radius: 70, color: '#ffd400', stroke: '#ffffff', stroke_width: 5, gradient: { type: 'linear', colors: ['#ffd400', '#ff6b3d'] }, name: 'Estrella' });
await call('layer_set', { project: P, comp: M, layer: star.layer.id, name: 'Estrella', parent: 'Control', three_d: true, motion_blur: true });
await call('prop_set', { project: P, comp: M, layer: 'Estrella', path: 'position', value: [0, 0, -150] });
await call('prop_set', { project: P, comp: M, layer: 'Estrella', path: 'rotationY', keys: [{ t: 0.4, v: -540 }, { t: 1.8, v: 0, ease: 'easy' }] });
await call('prop_set', { project: P, comp: M, layer: 'Estrella', path: 'rotation', expression: 'wiggle(1.2, 6)' });
await call('preset_apply', { project: P, comp: M, preset: 'elasticScale', layers: ['Estrella'], at: 0.4, duration: 1 });
await call('effect_add', { project: P, comp: M, layer: 'Estrella', effect: 'glow', values: { radius: 60, threshold: 45, intensity: 1.4 } });
await call('effect_add', { project: P, comp: M, layer: 'Estrella', effect: 'echo', values: { time: -0.03, count: 5, decay: 0.55, op: 'composite' } });

// kinetic title
const title = await call('layer_add', { project: P, comp: M, type: 'text', text: 'CINTA', size: 230, font: 'Segoe UI Black', position: [960, 800] });
await call('layer_set', { project: P, comp: M, layer: title.layer.id, name: 'Título', motion_blur: true });
await call('prop_set', { project: P, comp: M, layer: 'Título', path: 'text.tracking', value: 60 });
await call('preset_apply', { project: P, comp: M, preset: 'dropChars', layers: ['Título'], at: 1.2, duration: 1.1 });
const hi = await call('text_animator_add', { project: P, comp: M, layer: 'Título', name: 'Brillo', props: { fill: '#ffd400', scale: [112, 112], position: [0, -18] }, selector: { shape: 'smooth', start: 0, end: 35 } });
await call('prop_set', { project: P, comp: M, layer: 'Título', path: `text.animators.${hi.animator.name}.selectors.0.offset`, keys: [{ t: 2.6, v: -35 }, { t: 3.8, v: 100, ease: 'easy' }] });
await call('effect_add', { project: P, comp: M, layer: 'Título', effect: 'dropShadow', values: { distance: 18, softness: 30, opacity: 70 } });
await call('effect_add', { project: P, comp: M, layer: 'Título', effect: 'glow', values: { radius: 35, threshold: 70, intensity: 0.8 } });

// gradient-filled tagline: gradient solid shown through the text (track matte), flipping in
const tag = await call('layer_add', { project: P, comp: M, type: 'text', text: 'EDICIÓN · ANIMACIÓN · 3D · MCP', size: 64, font: 'Segoe UI', position: [960, 930] });
await call('layer_set', { project: P, comp: M, layer: tag.layer.id, name: 'Lema' });
await call('preset_apply', { project: P, comp: M, preset: 'flipChars', layers: ['Lema'], at: 2.2, duration: 1.2 });
const grad = await call('layer_add', { project: P, comp: M, type: 'solid', color: '#ffffff', name: 'Degradado lema' });
await call('effect_add', { project: P, comp: M, layer: grad.layer.id, effect: 'gradientRamp', values: { start: [560, 930], end: [1360, 930], startColor: '#36c48f', endColor: '#4aa8ff' } });
await call('layer_arrange', { project: P, comp: M, action: 'reorder', layers: ['Lema'], index: 1 });
await call('layer_arrange', { project: P, comp: M, action: 'reorder', layers: [grad.layer.id], index: 2 });
await call('layer_set', { project: P, comp: M, layer: grad.layer.id, matte: { layer: 'Lema', mode: 'alpha' } });
// precompose the tagline pair (keeps the matte inside)
await call('layer_arrange', { project: P, comp: M, action: 'precompose', layers: ['Lema', grad.layer.id], name: 'Lema (precomp)' });

// the «Pantalla» precomp in 3D on the right, swinging, sliding in
const scr = await call('layer_add', { project: P, comp: M, type: 'comp', comp_id: 'Pantalla', start: 0 });
await call('layer_set', { project: P, comp: M, layer: scr.layer.id, name: 'Pantalla 3D', three_d: true, motion_blur: true, in: 3.2 });
await call('prop_set', { project: P, comp: M, layer: 'Pantalla 3D', path: 'scale', value: [42, 42, 100] });
await call('prop_set', { project: P, comp: M, layer: 'Pantalla 3D', path: 'position', keys: [{ t: 3.2, v: [2400, 470, 0] }, { t: 4.2, v: [1520, 470, -100], ease: 'easy' }] });
await call('prop_set', { project: P, comp: M, layer: 'Pantalla 3D', path: 'rotationY', expression: '-28 + Math.sin(time * 1.1) * 8' });
await call('effect_add', { project: P, comp: M, layer: 'Pantalla 3D', effect: 'dropShadow', values: { distance: 30, softness: 50, opacity: 80 } });

// lower third from a template, nested
const lt = await call('comp_template', { project: P, template: 'lowerthird', name: 'Rótulo' });
const ltl = await call('layer_add', { project: P, comp: M, type: 'comp', comp_id: lt.comp.id, start: 4.4 });
await call('layer_set', { project: P, comp: M, layer: ltl.layer.id, name: 'Rótulo', in: 4.4 });

// music with a fade out (audio level keyframes)
const mus = await call('layer_add', { project: P, comp: M, type: 'audio', media_path: music.path });
await call('prop_set', { project: P, comp: M, layer: mus.layer.id, path: 'audio.level', keys: [{ t: 0, v: -6 }, { t: 6.5, v: -6 }, { t: 8, v: -40 }] });

// adjustment layer: chromatic aberration at the start, a glitch burst, vignette, iris out
const adj = await call('layer_add', { project: P, comp: M, type: 'adjustment', name: 'Acabado' });
const ca = await call('effect_add', { project: P, comp: M, layer: 'Acabado', effect: 'chromaticAberration', values: { amount: 0 } });
await call('prop_set', { project: P, comp: M, layer: 'Acabado', path: `effects.${ca.effect.name}.amount`, keys: [{ t: 0, v: 25 }, { t: 1, v: 0, ease: 'easy' }, { t: 6, v: 0 }, { t: 6.1, v: 30 }, { t: 6.35, v: 0 }] });
const gl = await call('effect_add', { project: P, comp: M, layer: 'Acabado', effect: 'glitch', values: { amount: 0, speed: 24 } });
await call('prop_set', { project: P, comp: M, layer: 'Acabado', path: `effects.${gl.effect.name}.amount`, keys: [{ t: 6, v: 0, ease: 'hold' }, { t: 6.05, v: 90, ease: 'hold' }, { t: 6.35, v: 0, ease: 'hold' }] });
await call('effect_add', { project: P, comp: M, layer: 'Acabado', effect: 'vignette', values: { amount: 55 } });
await call('preset_apply', { project: P, comp: M, preset: 'irisOut', layers: ['Acabado'], at: 7.3, duration: 0.7 });
void adj; void ctl;

// camera: slow push in with all layers in 3D (parallax by depth)
await call('preset_apply', { project: P, comp: M, preset: 'cameraPush', at: 0, duration: 8 });
const g = await call('comp_get', { project: P, comp: M });
for (const l of g.comp.layers) if (/Ruido|Fugas|Partículas/.test(l.name)) {
  await call('prop_set', { project: P, comp: M, layer: l.id, path: 'position', value: [960, 540, 900] });
  await call('prop_set', { project: P, comp: M, layer: l.id, path: 'scale', value: [175, 175, 100] });
}
await call('keyframe_assist', { project: P, comp: M, kind: 'easyAll', layers: ['Pantalla 3D'] });

const summary = await call('comp_get', { project: P, comp: M });
console.log(`${summary.comp.layers.length} capas en «${M}»:`);
for (const l of summary.comp.layers) console.log(`  ${l.index}. ${l.name} (${l.type}${l.threeD ? ', 3D' : ''}${l.motionBlur ? ', desenf.' : ''}${l.parent ? `, primario ${l.parent}` : ''}${l.matte ? `, mate ${l.matte.layer}` : ''}) ${Object.keys(l.animated).length} propiedades animadas`);

// key frames as images
for (const t of [0.15, 0.8, 1.5, 2.2, 3.0, 3.9, 4.8, 6.1, 7.6]) {
  const r = await call('comp_frame', { project: P, comp: M, time: t, width: 960, output: join(out, `f_${String(t).replace('.', '_')}.png`) });
  if (r.layerErrors) console.log(`  ⚠ ${t}s: ${r.layerErrors.join('; ')}`);
}
const t0 = Date.now();
const r = await call('comp_render', { project: P, comp: M, output: join(out, 'intro.mp4') });
console.log(`render: ${r.frames} fotogramas ${r.width}×${r.height} @${r.fps} en ${r.seconds.toFixed(1)} s → ${(r.frames / r.seconds).toFixed(1)} fps · ${r.perf.renderMs} ms/fotograma · errores: ${r.perf.errors.length} · audio: ${r.audio}`);
console.log(`total ${(Date.now() - t0) / 1000} s · llamadas MCP: ${log.length} (${log.filter((x) => !x.ok).length} fallidas)`);
await client.close();
