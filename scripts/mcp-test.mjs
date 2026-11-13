// End-to-end test of Cinta's MCP server through a real MCP client over stdio. Every tool is exercised and
// results are verified by content: pixels of rendered frames, durations, codecs, loudness, files written.
//
//   node scripts/mcp-test.mjs                  → dev build (Electron as Node + dist/main/mcp.js)
//   node scripts/mcp-test.mjs --exe=<Cinta.exe> → packaged build (resources/app.asar.unpacked/dist/main/mcp.js)
//   --only=<substring>                           → run matching cases
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const exe = arg('exe');
const only = arg('only');
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const serverJs = exe ? join(dirname(exe), 'resources', 'app.asar.unpacked', 'dist', 'main', 'mcp.js') : join(root, 'dist', 'main', 'mcp.js');
const FF = join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const FP = join(root, 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe');
// A failed run keeps its workspace for inspection; drop the ones older than a day so they don't pile up.
for (const n of readdirSync(tmpdir())) {
  if (!n.startsWith('cinta-mcp-test-')) continue;
  try { const p = join(tmpdir(), n); if (Date.now() - statSync(p).mtimeMs > 864e5) rmSync(p, { recursive: true, force: true }); } catch { /* in use */ }
}
const work = mkdtempSync(join(tmpdir(), 'cinta-mcp-test-'));
const W = (n) => join(work, n);

// ───────────────────────── helpers ─────────────────────────
function decodePng(buf) {
  let off = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[i] = (line[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) px[(y * w + x) * 4 + k] = line[x * bpp + k];
    prev = line;
  }
  const at = (fx, fy) => { const x = Math.min(w - 1, Math.round(fx * w)), y = Math.min(h - 1, Math.round(fy * h)); return [...px.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)]; };
  const mean = () => { let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2]; return s / (w * h * 3); };
  const share = (rgb, tol = 60) => { let n = 0; for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - rgb[0]) + Math.abs(px[i + 1] - rgb[1]) + Math.abs(px[i + 2] - rgb[2]) < tol) n++; return n / (w * h); };
  const gray = () => { let d = 0; for (let i = 0; i < px.length; i += 4) d += Math.abs(px[i] - px[i + 1]) + Math.abs(px[i + 1] - px[i + 2]); return d / (w * h); };
  return { width: w, height: h, at, mean, share, gray };
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const isColor = (px, rgb, tol = 70) => Math.abs(px[0] - rgb[0]) + Math.abs(px[1] - rgb[1]) + Math.abs(px[2] - rgb[2]) < tol;
const ff = (...a) => execFileSync(FF, ['-hide_banner', '-v', 'error', '-y', ...a], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const probe = (p) => JSON.parse(execFileSync(FP, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p], { windowsHide: true }).toString());
const dur = (p) => Number(probe(p).format.duration);
/** mean volume (dB) of a file, optionally a window and a filter before measuring */
function level(p, o = {}) {
  const r = spawnSync(FF, ['-hide_banner', ...(o.from !== undefined ? ['-ss', String(o.from)] : []), ...(o.t ? ['-t', String(o.t)] : []), '-i', p, '-vn', '-af', `${o.af ? `${o.af},` : ''}volumedetect`, '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' });
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr);
  return !m || m[1] === '-inf' ? -120 : Number(m[1]);
}
function lufs(p) {
  const r = spawnSync(FF, ['-hide_banner', '-i', p, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' });
  const all = [...r.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
  return all.length ? Number(all.at(-1)[1]) : -70;
}
/** decode one frame of a video at t to a PNG and analyse it */
function frameOf(p, t) {
  const out = W(`f_${Math.random().toString(36).slice(2)}.png`);
  ff('-ss', String(t), '-i', p, '-frames:v', '1', out);
  return decodePng(readFileSync(out));
}

// ───────────────────────── fixtures ─────────────────────────
function fixtures() {
  ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', W('bars.mp4'));
  for (const [n, c] of [['red', 'red'], ['blue', 'blue'], ['green', 'lime'], ['white', 'white']]) {
    ff('-f', 'lavfi', '-i', `color=${c}:s=640x360:r=30:d=3`, '-f', 'lavfi', '-i', 'sine=f=660:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', W(`${n}.mp4`));
  }
  ff('-f', 'lavfi', '-i', 'color=gray:s=800x600:d=1', '-frames:v', '1', W('gray.png'));
  // textured picture sliding 60 px/s left and 30 px/s up (for the motion tracker)
  ff('-f', 'lavfi', '-i', 'color=gray:s=1280x720,noise=alls=90:all_seed=7,boxblur=2:1', '-frames:v', '1', W('still.png'));
  // a white 16 px square moving 8 px per frame at 10 fps (pixel motion / Timewarp)
  ff('-f', 'lavfi', '-i', 'color=black:s=160x64:r=10:d=2', '-f', 'lavfi', '-i', 'color=white:s=16x16:r=10:d=2', '-filter_complex', "[0][1]overlay=x='10+8*n':y=24", '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', W('moving.mp4'));
  // a 1 kHz tone (audio spectrum / audio to keyframes); lavfi sine amplitude is 1/8
  ff('-f', 'lavfi', '-i', 'sine=f=1000:d=3', '-ac', '2', W('tone.wav'));
  // frames alternating black / white at 10 fps (frame blending)
  ff('-f', 'lavfi', '-i', "color=black:s=64x64:r=10:d=2,geq=lum='255*mod(N,2)':cb=128:cr=128", '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', W('flicker.mp4'));
  ff('-loop', '1', '-framerate', '30', '-t', '2', '-i', W('still.png'), '-vf', "crop=640:360:x='60*t':y='30*t'", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', W('slide.mp4'));
  ff('-f', 'lavfi', '-i', 'color=orange:s=600x800:d=1', '-frames:v', '1', W('tall.png'));
  ff('-f', 'lavfi', '-i', "color=black:s=1280x720:d=1,geq=r='255*X/W':g='0':b='255-255*X/W'", '-frames:v', '1', W('hgrad.png'));
  ff('-f', 'lavfi', '-i', 'color=0x00ff00@1:s=200x80:d=1,format=rgba', '-frames:v', '1', W('logo.png'));
  // speech-like: tone 2 s, silence 2 s, tone 2 s (with a still video)
  ff('-f', 'lavfi', '-i', 'color=navy:s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=2000:d=2,apad=pad_dur=2[a];sine=f=2000:d=2[b];[a][b]concat=n=2:v=0:a=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', W('talk.mp4'));
  // low "music" tone
  ff('-f', 'lavfi', '-i', 'sine=f=100:d=20', '-af', 'volume=0.5', W('music.wav'));
  // clicks every 0.5 s (beats)
  ff('-f', 'lavfi', '-i', "aevalsrc='0.9*sin(2*PI*1500*t)*lt(mod(t\\,0.5)\\,0.03)':s=44100:d=6", W('clicks.wav'));
  // sync pair: noise bursts, B delayed by 1.5 s
  ff('-f', 'lavfi', '-i', "aevalsrc='random(0)*lt(mod(t\\,1.7)\\,0.2)+0.6*random(1)*between(t\\,3\\,3.4)':s=8000:d=10", W('syncA.wav'));
  ff('-i', W('syncA.wav'), '-af', 'adelay=1500:all=1', W('syncB.wav'));
  // scenes: red | blue | green
  ff('-i', W('red.mp4'), '-i', W('blue.mp4'), '-i', W('green.mp4'), '-filter_complex', '[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', W('scenes.mp4'));
  // shaky video
  ff('-f', 'lavfi', '-i', 'testsrc2=s=800x450:r=30:d=4', '-vf', "crop=640:360:'80+40*sin(t*13)':'45+30*cos(t*11)'", '-c:v', 'libx264', '-preset', 'ultrafast', W('shaky.mp4'));
  // invert LUT (.cube 2x2x2)
  writeFileSync(W('invert.cube'), 'LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n');
  writeFileSync(W('subs.srt'), '1\n00:00:00,500 --> 00:00:02,000\nPrimera línea\n\n2\n00:00:02,500 --> 00:00:04,000\nSegunda línea\n');
}

// ───────────────────────── client ─────────────────────────
// isolated profile: an app opened by open_in_editor never touches the user's settings or Claude configs
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CINTA_CACHE: W('cache'), CINTA_USER_DATA: W('userdata'), CINTA_NO_CLAUDE_CODE: '1', CINTA_CLAUDE_DESKTOP_DIR: W('claude-desktop') };
const transport = new StdioClientTransport({ command: exe ?? electron, args: [serverJs], env, stderr: 'pipe' });
const client = new Client({ name: 'cinta-test', version: '1.0.0' });
let failures = 0, passed = 0;
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return { ...r.structuredContent, _content: r.content };
}
async function callErr(name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (!r.isError) throw new Error(`${name} debía fallar`);
  return r.content[0].text;
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
let checkpoint = null;
/** Remember the project file so a failing case cannot leave clips behind for the next ones. */
async function test(name, fn, o = {}) {
  if (only && !name.includes(only) && !new RegExp(only).test(name)) return;
  const t0 = Date.now();
  const snap = o.isolated && checkpoint && existsSync(checkpoint) ? readFileSync(checkpoint) : null;
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    if (snap) writeFileSync(checkpoint, snap);
    failures++;
    console.log(`  ✘ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
const imgOf = (r) => decodePng(Buffer.from(r._content.find((c) => c.type === 'image').data, 'base64'));

// ───────────────────────── cases ─────────────────────────
async function main() {
  console.log(`Cinta MCP e2e — ${exe ? `empaquetado: ${exe}` : 'desarrollo'}\n  carpeta: ${work}`);
  fixtures();
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const P = W('p.cinta');
  checkpoint = P;
  let mainClips = [];

  await test('tools/list incluye todas las herramientas', () => {
    const want = ['project_new', 'project_open', 'project_get', 'project_set', 'project_save', 'project_append', 'project_relink', 'media_import', 'media_list', 'media_info', 'media_generate', 'clip_add', 'color_clip_add', 'clip_split', 'clip_trim', 'clip_move', 'clip_duplicate', 'clip_delete', 'clip_set', 'clip_color', 'clip_filter_add', 'clip_filter_set', 'clip_filter_remove', 'clip_audio', 'clip_detach_audio', 'clip_freeze_frame', 'clip_chroma', 'clip_pip', 'clip_pan_zoom', 'clip_mask', 'clip_animate', 'clip_keyframe', 'clip_stabilize', 'transition_set', 'transition_wizard', 'title_add', 'title_set', 'sticker_add', 'callout_add', 'logo_add', 'track_add', 'track_set', 'track_remove', 'timeline_close_gaps', 'marker_add', 'marker_remove', 'undo', 'redo', 'detect_scenes', 'detect_beats', 'sync_audio', 'remove_silences', 'auto_subtitles', 'subtitles_import', 'subtitles_export', 'reframe', 'music_add', 'voiceover_add', 'slideshow_create', 'join_files', 'export', 'export_mlt', 'preview_frame', 'snapshot', 'catalog_list', 'open_in_editor', 'cinta_status', 'comp_new', 'comp_template', 'comp_get', 'comp_set', 'comp_delete', 'layer_add', 'layer_set', 'layer_delete', 'layer_arrange', 'prop_set', 'keyframe_edit', 'keyframe_assist', 'effect_add', 'effect_set', 'effect_remove', 'mask_add', 'mask_set', 'shape_add', 'text_animator_add', 'preset_apply', 'comp_frame', 'comp_render', 'comp_to_timeline', 'shape_set', 'text_animator_remove'];
    const missing = want.filter((t) => !tools.includes(t));
    assert(!missing.length, `faltan: ${missing.join(', ')}`);
    console.log(`      ${tools.length} herramientas`);
  });

  await test('cinta_status y catalog_list (todos los catálogos)', async () => {
    const s = await call('cinta_status');
    assert(s.version, 'sin versión');
    for (const kind of ['filters', 'transitions', 'titles', 'title_animations', 'stickers', 'callouts', 'masks', 'pip', 'pan_zoom', 'animations', 'eq_presets', 'audio_effects', 'audio_enhance', 'export_presets', 'aspects', 'generated', 'motion_effects', 'motion_presets', 'motion_templates', 'blend_modes', 'comp_formats']) {
      const r = await call('catalog_list', { kind });
      assert(r.count > 0, `catálogo vacío: ${kind}`);
    }
    const f = await call('catalog_list', { kind: 'transitions', search: 'fundido' });
    assert(f.items.every((x) => /fundido|fade/i.test(`${x.id} ${x.name}`)), 'búsqueda');
  });

  await test('project_new / project_get / project_set', async () => {
    const r = await call('project_new', { path: P, width: 1280, height: 720, fps: 30 });
    assert(r.settings.width === 1280 && r.settings.height === 720, 'tamaño');
    assert(existsSync(P), 'no se guardó');
    const s = await call('project_set', { aspect: '16:9', background: '#000000' });
    assert(s.settings.width === 1920, 'aspecto');
    await call('project_set', { width: 1280, height: 720 });
    const g = await call('project_get', {});
    assert(g.tracks.some((t) => t.kind === 'main') && g.duration === 0, 'pistas');
    const err = await callErr('project_new', { path: P });
    assert(/Ya existe/.test(err), 'sobrescritura sin permiso');
  });

  await test('media_import / media_list / media_info', async () => {
    const r = await call('media_import', { paths: [W('red.mp4'), W('blue.mp4'), W('gray.png')] });
    assert(r.media.length === 3, 'importados');
    const red = r.media.find((m) => m.path.endsWith('red.mp4'));
    assert(near(red.duration, 3, 0.1) && red.hasAudio && red.kind === 'video', 'datos del vídeo');
    assert(r.media.find((m) => m.path.endsWith('gray.png')).kind === 'image', 'imagen');
    const l = await call('media_list', {});
    assert(l.media.length === 3 && l.media.every((m) => !m.missing), 'lista');
    const i = await call('media_info', { path: W('bars.mp4') });
    assert(near(i.duration, 6, 0.1) && i.width === 640, 'info');
    const e = await callErr('media_import', { paths: [W('noexiste.mp4')] });
    assert(/No existe/.test(e), 'error en español');
  });

  await test('clip_add / color_clip_add / export básico (duración y códecs)', async () => {
    const a = await call('clip_add', { media: W('red.mp4') });
    const b = await call('clip_add', { media: W('blue.mp4') });
    const c = await call('color_clip_add', { fill: '#ffffff', duration: 2 });
    mainClips = [a.clip.id, b.clip.id, c.clip];
    assert(near(c.duration, 8, 0.01), `duración ${c.duration}`);
    const out = await call('export', { output: W('basic.mp4'), quality: 'draft' });
    assert(near(out.duration, 8, 0.1), `exportado ${out.duration}`);
    assert(out.info.vcodec === 'h264' && out.info.acodec === 'aac' && out.info.width === 1280, 'códecs/tamaño');
    assert(isColor(frameOf(out.path, 1).at(0.5, 0.5), [255, 0, 0]), 'rojo al principio');
    assert(isColor(frameOf(out.path, 4).at(0.5, 0.5), [0, 0, 255]), 'azul en el medio');
    assert(isColor(frameOf(out.path, 7).at(0.5, 0.5), [255, 255, 255]), 'blanco al final');
  });

  await test('clip_split / clip_delete (rizo) / undo / redo', async () => {
    const s = await call('clip_split', { time: 1.5 });
    assert(s.new_clips.length === 1, 'dividir');
    const g = await call('project_get', {});
    const main = g.tracks.find((t) => t.kind === 'main').clips;
    assert(main.length === 4 && near(main[0].duration, 1.5, 0.01), 'dos mitades');
    const d = await call('clip_delete', { clip_ids: [main[0].id] });
    assert(near(d.duration, 6.5, 0.01), `rizo ${d.duration}`);
    const u = await call('undo', {});
    assert(near(u.duration, 8, 0.01), 'deshacer');
    const r = await call('redo', {});
    assert(near(r.duration, 6.5, 0.01), 'rehacer');
    await call('undo', {});
    await call('undo', {});
    const back = await call('project_get', {});
    assert(back.tracks.find((t) => t.kind === 'main').clips.length === 3, 'deshacer la división');
  });

  await test('clip_trim / clip_move / clip_duplicate', async () => {
    const [a, b] = mainClips;
    const t = await call('clip_trim', { clip_id: a, in: 0.5, out: 2.5 });
    assert(near(t.clip.duration, 2, 0.01), 'recorte');
    const m = await call('clip_move', { clip_id: b, index: 0 });
    assert(m.clip.start === 0, 'reordenar');
    const d = await call('clip_duplicate', { clip_id: b });
    const g = await call('project_get', {});
    const main = g.tracks.find((t) => t.kind === 'main').clips;
    assert(main.length === 4 && main[1].id === d.clip, 'clon detrás del original');
    await call('clip_delete', { clip_ids: [d.clip] });
    await call('clip_move', { clip_id: a, index: 0 });
  });

  await test('transition_set / transition_wizard (solapan y acortan)', async () => {
    const before = (await call('project_get', {})).duration;
    const t = await call('transition_set', { clip_id: mainClips[0], type: 'fade', duration: 1 });
    assert(near(t.duration, before - 1, 0.01), 'la transición solapa 1 s');
    const out = await call('export', { output: W('trans.mp4'), quality: 'draft' });
    assert(near(out.duration, before - 1, 0.1), 'duración exportada');
    const mid = frameOf(out.path, 1.5).at(0.5, 0.5); // red(2s) → blue fade between 1 and 2
    assert(mid[0] > 60 && mid[2] > 60, `mezcla rojo/azul ${mid}`);
    const w = await call('transition_wizard', { type: 'wipeleft', duration: 0.5 });
    assert(w.transitions === 2, `asistente ${w.transitions}`);
    await call('transition_wizard', { type: null });
    const e = await callErr('transition_set', { clip_id: mainClips[2], type: 'fade' });
    assert(/último clip/.test(e), 'último clip');
    const e2 = await callErr('transition_set', { clip_id: mainClips[0], type: 'noexiste' });
    assert(/desconocid/.test(e2), 'tipo desconocido');
  });

  await test('clip_set: velocidad, invertir, volumen, silencio, fundidos, rotación', async () => {
    const [a] = mainClips;
    const s = await call('clip_set', { clip_id: a, speed: 2 });
    assert(near(s.clip.duration, 1, 0.01), 'velocidad 2× → mitad');
    await call('clip_set', { clip_id: a, speed: 1, reverse: true, rotate: 90, fade_in: 0.5, volume: 0.5 });
    const g = await call('project_get', {});
    const c = g.tracks.find((t) => t.kind === 'main').clips[0];
    assert(c.reverse && c.rotate === 90 && c.fadeIn === 0.5 && c.volume === 0.5, 'propiedades');
    await call('clip_set', { clip_id: a, muted: true, reverse: false, rotate: 0, fade_in: 0, volume: 1 });
    const out = await call('export', { output: W('mute.mp4'), quality: 'draft', to: 2 });
    assert(level(out.path) < -60, `silenciado: ${level(out.path)} dB`);
    await call('clip_set', { clip_id: a, muted: false });
    const out2 = await call('export', { output: W('unmute.mp4'), quality: 'draft', to: 2 });
    assert(level(out2.path) > -30, 'con sonido');
    const e = await callErr('clip_set', { clip_id: 'nada', speed: 1 });
    assert(/No existe el clip/.test(e), 'id inválido');
  });

  await test('preview_frame / snapshot', async () => {
    const r = await call('preview_frame', { time: 0.5, width: 640 });
    const img = imgOf(r);
    assert(img.width === 640 && img.height === 360, 'tamaño de la vista previa');
    assert(isColor(img.at(0.5, 0.5), [255, 0, 0]), `rojo ${img.at(0.5, 0.5)}`);
    const s = await call('snapshot', { time: 0.5, output: W('snap.png') });
    const big = decodePng(readFileSync(s.path));
    assert(big.width === 1280 && big.height === 720, 'instantánea a resolución completa');
  });

  await test('clip_color (manual, preset, LUT)', async () => {
    const [, b] = mainClips; // blue
    const t = 2.5;
    const base = imgOf(await call('preview_frame', { time: t, width: 320 })).mean();
    await call('clip_color', { clip_id: b, brightness: 0.8 });
    const bright = imgOf(await call('preview_frame', { time: t, width: 320 })).mean();
    assert(bright > base + 20, `más brillo ${base} → ${bright}`);
    await call('clip_color', { clip_id: b, reset: true, preset: 'auto-contrast' });
    await call('clip_color', { clip_id: b, reset: true, lut: W('invert.cube') });
    const inv = imgOf(await call('preview_frame', { time: t, width: 320 })).at(0.5, 0.5);
    assert(isColor(inv, [255, 255, 0], 90), `LUT invierte azul → amarillo ${inv}`);
    await call('clip_color', { clip_id: b, reset: true });
  }, { isolated: true });

  await test('clip_filter_add / set / remove (blanco y negro, desenfoque, píxeles)', async () => {
    const [a] = mainClips;
    await call('clip_filter_add', { clip_id: a, filter: 'bw' });
    const g = imgOf(await call('preview_frame', { time: 0.5, width: 320 }));
    assert(g.gray() < 10, `gris ${g.gray()}`);
    const r = await call('clip_filter_set', { clip_id: a, filter: 'bw', amount: 0 });
    assert(r.filter.amount === 0, 'intensidad');
    await call('clip_filter_remove', { clip_id: a });
    for (const f of ['blur', 'pixelate', 'vignette', 'old-film', 'mirror-h', 'tiles-4', 'glitch', 'sketch']) await call('clip_filter_add', { clip_id: a, filter: f, amount: 0.6 });
    const all = imgOf(await call('preview_frame', { time: 0.5, width: 320 }));
    assert(all.width === 320, 'muchos filtros a la vez');
    await call('clip_filter_remove', { clip_id: a });
  });

  await test('title_add / title_set (texto visible y color)', async () => {
    const r = await call('title_add', { text: 'HOLA', style: 'basic', start: 0, duration: 2, size: 200, color: '#ffffff', anim: 'none' });
    const img = imgOf(await call('preview_frame', { time: 1, width: 640 }));
    assert(img.share([255, 255, 255], 60) > 0.004, `texto blanco ${img.share([255, 255, 255], 60)}`);
    await call('title_set', { clip_id: r.clip.id, color: '#ffff00', text: 'ADIÓS' });
    const img2 = imgOf(await call('preview_frame', { time: 1, width: 640 }));
    assert(img2.share([255, 255, 0], 60) > 0.004, 'texto amarillo');
    for (const anim of ['fade', 'slide-left', 'zoom-in', 'typewriter', 'scroll-up', 'pop']) await call('title_set', { clip_id: r.clip.id, anim });
    await call('title_set', { clip_id: r.clip.id, anim: 'typewriter' });
    const tw = imgOf(await call('preview_frame', { time: 0.05, width: 640 }));
    assert(tw.share([255, 255, 0], 60) < img2.share([255, 255, 0], 60), 'máquina de escribir: al principio menos texto');
    await call('clip_delete', { clip_ids: [r.clip.id] });
  }, { isolated: true });

  await test('sticker_add / callout_add (posición y color)', async () => {
    const s = await call('sticker_add', { name: 'heart', start: 0, duration: 2, x: 0.25, y: 0.5, scale: 0.6 });
    const c = await call('callout_add', { shape: 'rect-fill', start: 0, duration: 2, x: 0.75, y: 0.5, color: '#00ff00', scale: 0.6 });
    const img = imgOf(await call('preview_frame', { time: 1, width: 640 }));
    assert(isColor(img.at(0.25, 0.5), [232, 69, 90], 90), `corazón ${img.at(0.25, 0.5)}`);
    const g = img.at(0.75, 0.5);
    assert(isColor(g, [140, 115, 0], 60), `llamada verde semitransparente sobre rojo ${g}`);
    await call('clip_delete', { clip_ids: [s.clip.id, c.clip.id] });
  }, { isolated: true });

  let ovTrack, ov;
  await test('track_add / clip_pip / clip_chroma / track_set', async () => {
    ovTrack = (await call('track_add', { kind: 'overlay' })).track.id;
    ov = (await call('clip_add', { media: W('green.mp4'), track_id: ovTrack, at: 0 })).clip.id;
    await call('clip_pip', { clip_id: ov, layout: 'overlay' });
    let img = imgOf(await call('preview_frame', { time: 1, width: 640 }));
    assert(isColor(img.at(0.8, 0.77), [0, 255, 0]), `PiP abajo a la derecha ${img.at(0.8, 0.77)}`);
    assert(isColor(img.at(0.2, 0.2), [255, 0, 0]), 'fondo rojo arriba a la izquierda');
    await call('clip_pip', { clip_id: ov, layout: null });
    await call('clip_chroma', { clip_id: ov, color: '#00ff00', tolerance: 0.2 });
    img = imgOf(await call('preview_frame', { time: 1, width: 640 }));
    assert(isColor(img.at(0.5, 0.5), [255, 0, 0]), `croma: se ve el rojo de debajo ${img.at(0.5, 0.5)}`);
    await call('clip_chroma', { clip_id: ov, color: null });
    await call('track_set', { track_id: ovTrack, hidden: true });
    img = imgOf(await call('preview_frame', { time: 1, width: 640 }));
    assert(isColor(img.at(0.5, 0.5), [255, 0, 0]), 'pista oculta');
    await call('track_set', { track_id: ovTrack, hidden: false });
  }, { isolated: true });

  await test('clip_animate / clip_keyframe (movimiento real)', async () => {
    await call('clip_set', { clip_id: ov, transform: { x: 0.5, y: 0.5, scale: 0.25 } });
    await call('clip_keyframe', { clip_id: ov, keyframes: [{ t: 0, x: 0.2 }, { t: 2, x: 0.8 }] });
    const a = imgOf(await call('preview_frame', { time: 0.1, width: 640 }));
    const b = imgOf(await call('preview_frame', { time: 1.9, width: 640 }));
    assert(isColor(a.at(0.21, 0.5), [0, 255, 0]) && !isColor(a.at(0.79, 0.5), [0, 255, 0]), 'al principio a la izquierda');
    assert(isColor(b.at(0.79, 0.5), [0, 255, 0]) && !isColor(b.at(0.21, 0.5), [0, 255, 0]), 'al final a la derecha');
    await call('clip_keyframe', { clip_id: ov, mode: 'clear' });
    await call('clip_animate', { clip_id: ov, in: { type: 'slide-left', duration: 1 }, out: { type: 'fade', duration: 0.5 } });
    const s = imgOf(await call('preview_frame', { time: 0.05, width: 640 }));
    assert(!isColor(s.at(0.5, 0.5), [0, 255, 0]), 'entrando desde fuera');
    const e = imgOf(await call('preview_frame', { time: 1.5, width: 640 }));
    assert(isColor(e.at(0.5, 0.5), [0, 255, 0]), 'ya en su sitio');
    for (const t of ['zoom', 'pop', 'spin']) await call('clip_animate', { clip_id: ov, in: { type: t, duration: 0.5 } });
    imgOf(await call('preview_frame', { time: 0.2, width: 320 }));
    await call('clip_delete', { clip_ids: [ov] });
  }, { isolated: true });

  await test('clip_pan_zoom / clip_mask', async () => {
    const g = await call('clip_add', { media: W('bars.mp4') });
    const id = g.clip.id;
    const start = g.clip.start;
    await call('clip_pan_zoom', { clip_id: id, preset: 'zoom-in' });
    imgOf(await call('preview_frame', { time: start + 3, width: 320 }));
    await call('clip_pan_zoom', { clip_id: id, preset: null });
    await call('clip_mask', { clip_id: id, preset: 'black-rect', x: 0.5, y: 0.5, w: 0.3, h: 0.3 });
    const img = imgOf(await call('preview_frame', { time: start + 1, width: 640 }));
    assert(isColor(img.at(0.5, 0.5), [0, 0, 0], 40), `máscara negra ${img.at(0.5, 0.5)}`);
    assert(!isColor(img.at(0.1, 0.1), [0, 0, 0], 40), 'fuera de la máscara no');
    for (const p of ['blur-ellipse', 'pixel-rect', 'light-ellipse', 'bright-rect']) await call('clip_mask', { clip_id: id, preset: p, feather: 0.3, track: [{ t: 0, x: 0.3, y: 0.5 }, { t: 5, x: 0.7, y: 0.5 }] });
    imgOf(await call('preview_frame', { time: start + 2, width: 320 }));
    await call('clip_mask', { clip_id: id, preset: null });
    await call('clip_delete', { clip_ids: [id] });
  }, { isolated: true });

  await test('clip_audio (EQ, compresor, puerta, reverberación, ruido, mejora, efectos)', async () => {
    const [a] = mainClips;
    await call('clip_audio', { clip_id: a, eq_preset: 'voice', compressor: { ratio: 4 }, gate: { threshold: -50 }, reverb: { wet: 0.3 }, denoise: 0.5, enhance: 'voice' });
    for (const fx of ['echo', 'robot', 'phone', 'radio', 'pitch-high', 'tremolo', 'muffled', 'overdrive', 'vibrato']) {
      await call('clip_audio', { clip_id: a, effect: fx });
    }
    const out = await call('export', { output: W('fx.wav'), preset: 'wav', to: 2 });
    assert(level(out.path) > -40, 'audio con efectos');
    const r = await call('clip_audio', { clip_id: a, reset: true });
    assert(r.audio === null, 'reset');
  });

  await test('clip_detach_audio / clip_freeze_frame', async () => {
    const [, b] = mainClips;
    const d = await call('clip_detach_audio', { clip_id: b });
    const g = await call('project_get', {});
    assert(g.tracks.some((t) => t.kind === 'audio' && t.clips.some((c) => c.id === d.audio_clip)), 'clip de audio separado');
    await call('undo', {});
    const before = (await call('project_get', {})).duration;
    const f = await call('clip_freeze_frame', { time: 1, duration: 1 });
    assert(near(f.duration, before + 1, 0.05), `fotograma fijo +1 s (${before} → ${f.duration})`);
    const img = imgOf(await call('preview_frame', { time: 1.5, width: 320 }));
    assert(isColor(img.at(0.1, 0.9), [255, 0, 0]), `fotograma fijo rojo ${img.at(0.1, 0.9)}`);
    await call('undo', {});
  }, { isolated: true });

  await test('clip_stabilize (vid.stab)', async () => {
    const c = await call('clip_add', { media: W('shaky.mp4') });
    const r = await call('clip_stabilize', { clip_id: c.clip.id, accuracy: 9, shakiness: 6 });
    assert(r.trf, 'análisis');
    const out = await call('export', { output: W('stab.mp4'), quality: 'draft', from: c.clip.start, to: c.clip.start + 2 });
    assert(near(out.duration, 2, 0.1), 'exportado estabilizado');
    await call('clip_delete', { clip_ids: [c.clip.id] });
  }, { isolated: true });

  await test('logo_add / track_remove / timeline_close_gaps / marcadores', async () => {
    const l = await call('logo_add', { path: W('logo.png'), corner: 'tl', scale: 0.2, opacity: 1 });
    const img = imgOf(await call('preview_frame', { time: 0.5, width: 640 }));
    assert(isColor(img.at(0.1, 0.1), [0, 255, 0]), `logotipo ${img.at(0.1, 0.1)}`);
    await call('clip_delete', { clip_ids: [l.clip] });
    const t = await call('track_add', { kind: 'title', name: 'Extra' });
    await call('title_add', { text: 'a', start: 1, duration: 1, track_id: t.track.id });
    await call('title_add', { text: 'b', start: 4, duration: 1, track_id: t.track.id });
    await call('timeline_close_gaps', { track_id: t.track.id });
    const g = await call('project_get', {});
    const clips = g.tracks.find((x) => x.id === t.track.id).clips;
    assert(clips[0].start === 0 && clips[1].start === 1, 'huecos cerrados');
    await call('track_remove', { track_id: t.track.id });
    const m = await call('marker_add', { time: 1.25, name: 'Aquí' });
    assert(m.marker.time === 1.25, 'marcador');
    const r = await call('marker_remove', {});
    assert(r.markers.length === 0, 'marcadores borrados');
  }, { isolated: true });

  await test('export: presets y formatos (webm, gif, mp3, wav, mkv, shorts, rango, loudnorm)', async () => {
    const cases = [['webm', 'webm', 'vp9'], ['gif', 'gif', 'gif'], ['mkv', 'mkv', 'h264'], ['mov', 'mov', 'h264'], ['avi', 'avi', 'mpeg4']];
    for (const [preset, ext, codec] of cases) {
      const r = await call('export', { output: W(`o.${ext}`), preset, quality: 'draft', to: 1 });
      assert(r.info.vcodec === codec, `${preset}: ${r.info.vcodec}`);
    }
    const mp3 = await call('export', { output: W('o.mp3'), to: 2 });
    assert(mp3.info.acodec === 'mp3' && !mp3.info.vcodec, 'mp3 solo audio');
    const sh = await call('export', { output: W('short.mp4'), preset: 'shorts', quality: 'draft', to: 1 });
    assert(sh.info.width === 1080 && sh.info.height === 1920, 'vertical 1080×1920');
    const rg = await call('export', { output: W('range.mp4'), quality: 'draft', from: 1, to: 2.5 });
    assert(near(rg.duration, 1.5, 0.1), 'exportar selección');
    const ln = await call('export', { output: W('loud.wav'), preset: 'wav', loudnorm: true });
    assert(near(lufs(ln.path), -14, 1.5), `loudnorm ${lufs(ln.path)} LUFS`);
    const cbr = await call('export', { output: W('cbr.mp4'), video_bitrate: '2M', bitrate_mode: 'cbr', codec_preset: 'ultrafast', fps: 25, to: 1 });
    assert(near(cbr.info.fps, 25, 0.5), 'fps personalizados');
  });

  await test('export_mlt (Shotcut/Kdenlive)', async () => {
    const r = await call('export_mlt', { output: W('p.mlt') });
    const xml = readFileSync(r.path, 'utf8');
    assert(xml.includes('<mlt') && xml.includes('<playlist') && xml.includes('red.mp4'), 'XML MLT');
  });

  await test('project_save (como, portátil) / project_open / project_append / project_relink', async () => {
    const s = await call('project_save', { as: W('copia.cinta') });
    assert(existsSync(s.saved), 'guardar como');
    const port = await call('project_save', { project: W('copia.cinta'), portable_dir: W('portable') });
    assert(existsSync(join(W('portable'), 'Medios', 'red.mp4')), 'medios copiados');
    const o = await call('project_open', { path: port.saved });
    assert(o.media.every((m) => m.path.startsWith(W('portable'))), 'rutas portátiles');
    const before = o.duration;
    const ap = await call('project_append', { other: P });
    assert(near(ap.duration, before * 2, 0.05), 'adjuntar');
    renameSync(join(W('portable'), 'Medios', 'blue.mp4'), join(W('portable'), 'blue-moved.mp4'));
    const miss = await call('project_open', { path: port.saved });
    assert(miss.missing.length === 1, 'archivo que falta detectado');
    const rl = await call('project_relink', { media: miss.missing[0].id, new_path: join(W('portable'), 'blue-moved.mp4') });
    assert(rl.missing.length === 0, 'reubicado');
    await call('project_open', { path: P });
  });

  await test('detect_scenes (divide en 3)', async () => {
    const p2 = W('scenes.cinta');
    await call('project_new', { path: p2 });
    const c = await call('clip_add', { media: W('scenes.mp4') });
    const r = await call('detect_scenes', { clip_id: c.clip.id });
    assert(r.scenes === 3, `escenas ${r.scenes} ${JSON.stringify(r.cuts)}`);
    assert(r.cuts.every((t, i) => near(t, 3 * (i + 1), 0.1)), 'en 3 s y 6 s');
  });

  await test('detect_beats (clics cada 0,5 s)', async () => {
    const c = await call('clip_add', { media: W('clicks.wav') });
    const r = await call('detect_beats', { clip_id: c.clip.id, min_interval: 0.3 });
    assert(r.beats >= 10 && r.beats <= 13, `ritmos ${r.beats}`);
  });

  await test('sync_audio (retraso de 1,5 s)', async () => {
    const p3 = W('sync.cinta');
    await call('project_new', { path: p3 });
    const a = await call('clip_add', { media: W('syncA.wav') });
    const t = await call('track_add', { kind: 'audio', name: 'Externo' });
    const b = await call('clip_add', { media: W('syncB.wav'), track_id: t.track.id, at: 0 });
    const r = await call('sync_audio', { clip_a: a.clip.id, clip_b: b.clip.id });
    assert(near(r.offset, 1.5, 0.05), `desfase ${r.offset}`);
    const e = await callErr('sync_audio', { clip_a: a.clip.id, clip_b: a.clip.id });
    assert(/distintas pistas/.test(e), 'misma pista');
  });

  await test('remove_silences (quita ≈ 2 s de pausa)', async () => {
    const p4 = W('talk.cinta');
    await call('project_new', { path: p4 });
    await call('clip_add', { media: W('talk.mp4') });
    const r = await call('remove_silences', { min_silence: 0.5, padding: 0.1 });
    assert(r.removedSeconds > 1.6 && r.removedSeconds < 2.1, `quitado ${r.removedSeconds}`);
    const out = await call('export', { output: W('talk-cut.mp4'), quality: 'draft' });
    assert(near(out.duration, r.duration, 0.1), 'duración final');
    assert(level(out.path) > -25, 'el resto tiene voz');
  });

  await test('music_add con ducking (la música baja ≥ 6 dB bajo la voz)', async () => {
    const p5 = W('duck.cinta');
    await call('project_new', { path: p5 });
    await call('clip_add', { media: W('talk.mp4') }); // tone 0-2, silence 2-4, tone 4-6
    const r = await call('music_add', { path: W('music.wav'), volume: 1, fade_in: 0, fade_out: 0 });
    assert(r.duck === true, 'pista con ducking');
    const out = await call('export', { output: W('duck.wav'), preset: 'wav' });
    const musicDuringVoice = level(out.path, { from: 0.6, t: 1, af: 'lowpass=f=200,lowpass=f=200' });
    const musicAlone = level(out.path, { from: 2.6, t: 1, af: 'lowpass=f=200,lowpass=f=200' });
    assert(musicAlone - musicDuringVoice >= 6, `ducking ${musicAlone} vs ${musicDuringVoice}`);
    const g = await call('music_add', { path: 'generated:calm', duck: false });
    assert(existsSync(g.path), 'música generada');
  });

  await test('media_generate / voiceover_add', async () => {
    for (const n of ['whoosh', 'beep', 'pop', 'impact', 'click', 'ding', 'applause']) {
      const r = await call('media_generate', { kind: 'sfx', name: n, output: W(`sfx_${n}.wav`) });
      assert(level(r.path) > -50, `efecto ${n}`);
    }
    const m = await call('media_generate', { kind: 'music', name: 'upbeat', duration: 5, output: W('gen.wav') });
    assert(near(dur(m.path), 5, 0.1), 'música 5 s');
    const v = await call('voiceover_add', { path: W('sfx_ding.wav'), at: 1 });
    const g = await call('project_get', {});
    assert(g.tracks.some((t) => t.name === 'Voz' && t.clips.some((c) => c.id === v.clip && c.start === 1)), 'voz en off');
  });

  await test('reframe 9:16 (desenfoque y recorte)', async () => {
    const p6 = W('reframe.cinta');
    await call('project_new', { path: p6 });
    await call('clip_add', { media: W('bars.mp4') });
    const r = await call('reframe', { aspect: '9:16', mode: 'blur' });
    assert(r.width === 1080 && r.height === 1920, 'tamaño vertical');
    const img = imgOf(await call('preview_frame', { time: 1, width: 270 }));
    assert(img.height === 480, 'vista previa vertical');
    const out = await call('export', { output: W('vertical.mp4'), quality: 'draft', to: 1 });
    assert(out.info.width === 1080 && out.info.height === 1920, 'exportado vertical');
    await call('undo', {});
    await call('reframe', { aspect: '1:1', mode: 'crop' });
    const sq = imgOf(await call('preview_frame', { time: 1, width: 300 }));
    assert(sq.width === 300 && sq.height === 300 && !isColor(sq.at(0.5, 0.02), [0, 0, 0], 30), 'cuadrado sin bandas');
  });

  await test('subtitles_import / subtitles_export (SRT ida y vuelta)', async () => {
    const r = await call('subtitles_import', { path: W('subs.srt') });
    assert(r.captions === 2, 'importados');
    const img = imgOf(await call('preview_frame', { time: 1, width: 640 }));
    assert(img.share([0, 0, 0], 40) > 0.008, `subtítulo con su fondo negro ${img.share([0, 0, 0], 40)}`);
    const e = await call('subtitles_export', { path: W('out.srt') });
    const txt = readFileSync(e.path, 'utf8');
    assert(txt.includes('Primera línea') && txt.includes('00:00:02,500 --> 00:00:04,000'), 'SRT exportado');
  });

  await test('auto_subtitles (Whisper local)', async () => {
    const s = await call('cinta_status');
    if (!s.whisper) { console.log('      (sin modelo Whisper: se comprueba solo el mensaje)'); const e = await callErr('auto_subtitles', {}); assert(/modelo Whisper/.test(e), 'mensaje'); return; }
    const wav = join(dirname(s.whisper), 'test_wavs', '0.wav');
    if (!existsSync(wav)) throw new Error('falta el audio de prueba del modelo');
    const p7 = W('subs.cinta');
    await call('project_new', { path: p7 });
    await call('clip_add', { media: wav });
    // audio on the audio track: point the transcription at that clip
    const g = await call('project_get', {});
    const clip = g.tracks.flatMap((t) => t.clips)[0];
    const r = await call('auto_subtitles', { clip_ids: [clip.id], language: 'en', srt_path: W('auto.srt'), style: 'subtitle' });
    assert(r.captions > 0 && r.text.length > 10, `transcripción: ${r.text}`);
    assert(readFileSync(W('auto.srt'), 'utf8').includes('-->'), 'srt');
    console.log(`      «${r.text.slice(0, 80)}»`);
  });

  await test('slideshow_create / join_files', async () => {
    const p8 = W('slides.cinta');
    await call('project_new', { path: p8 });
    const r = await call('slideshow_create', { paths: [W('gray.png'), W('tall.png'), W('gray.png')], photo_duration: 2, transition: 'fade', transition_duration: 0.5 });
    assert(r.clips === 3 && near(r.duration, 5, 0.05), `presentación ${r.duration}`);
    const j = await call('join_files', { paths: [W('red.mp4'), W('blue.mp4')], output: W('joined.mp4'), quality: 'draft' });
    assert(near(j.duration, 6, 0.15), `unidos ${j.duration}`);
    assert(isColor(frameOf(j.path, 4.5).at(0.5, 0.5), [0, 0, 255]), 'segundo archivo');
  });

  await test('todo el catálogo se renderiza (filtros, transiciones, títulos, adhesivos, llamadas, máscaras, PiP, panorámicas, audio)', async () => {
    const pc = W('catalog.cinta');
    await call('project_new', { path: pc, width: 320, height: 180 });
    const a = (await call('clip_add', { media: W('bars.mp4') })).clip.id;
    const b = (await call('clip_add', { media: W('red.mp4') })).clip.id;
    const bad = [];
    const tryRender = async (what, t = 1) => { try { await call('preview_frame', { time: t, width: 160 }); } catch (e) { bad.push(`${what}: ${String(e.message).split('\n').slice(-2).join(' ')}`); } };
    for (const f of (await call('catalog_list', { kind: 'filters' })).items) {
      await call('clip_filter_remove', { clip_id: a });
      await call('clip_filter_add', { clip_id: a, filter: f.id, amount: 0.7 });
      await tryRender(`filtro ${f.id}`);
    }
    await call('clip_filter_remove', { clip_id: a });
    for (const t of (await call('catalog_list', { kind: 'transitions' })).items) {
      await call('transition_set', { clip_id: a, type: t.id, duration: 1 });
      await tryRender(`transición ${t.id}`, 5.5);
    }
    await call('transition_set', { clip_id: a, type: null });
    for (const t of (await call('catalog_list', { kind: 'titles' })).items) {
      const c = await call('title_add', { text: 'Prueba', style: t.id, start: 0, duration: 2 });
      await tryRender(`título ${t.id}`, 0.8);
      await call('clip_delete', { clip_ids: [c.clip.id] });
    }
    for (const kind of ['stickers', 'callouts']) {
      for (const s of (await call('catalog_list', { kind })).items) {
        const c = kind === 'stickers' ? await call('sticker_add', { name: s.id, start: 0, duration: 2 }) : await call('callout_add', { shape: s.id, start: 0, duration: 2 });
        await tryRender(`${kind} ${s.id}`, 0.8);
        await call('clip_delete', { clip_ids: [c.clip.id] });
      }
    }
    for (const m of (await call('catalog_list', { kind: 'masks' })).items) { await call('clip_mask', { clip_id: a, preset: m.id }); await tryRender(`máscara ${m.id}`); }
    await call('clip_mask', { clip_id: a, preset: null });
    for (const z of (await call('catalog_list', { kind: 'pan_zoom' })).items) { await call('clip_pan_zoom', { clip_id: a, preset: z.id }); await tryRender(`panorámica ${z.id}`); }
    await call('clip_pan_zoom', { clip_id: a, preset: null });
    const ov = (await call('track_add', { kind: 'overlay' })).track.id;
    const o = (await call('clip_add', { media: W('green.mp4'), track_id: ov, at: 0 })).clip.id;
    for (const l of (await call('catalog_list', { kind: 'pip' })).items) { await call('clip_pip', { clip_id: o, layout: l.id }); await tryRender(`pip ${l.id}`); }
    for (const an of (await call('catalog_list', { kind: 'animations' })).items) { await call('clip_animate', { clip_id: o, in: { type: an.id, duration: 0.5 }, out: { type: an.id, duration: 0.5 } }); await tryRender(`animación ${an.id}`, 0.2); }
    for (const fx of (await call('catalog_list', { kind: 'audio_effects' })).items) {
      await call('clip_audio', { clip_id: b, reset: true, effect: fx.id });
      try { await call('export', { output: W('fx.wav'), preset: 'wav', from: 6, to: 7 }); } catch (e) { bad.push(`audio ${fx.id}: ${e.message.split('\n').pop()}`); }
    }
    for (const eq of (await call('catalog_list', { kind: 'eq_presets' })).items) await call('clip_audio', { clip_id: b, reset: true, eq_preset: eq.id });
    await call('export', { output: W('eq.wav'), preset: 'wav', from: 6, to: 7 });
    for (const en of ['studio', 'noisy', 'voice']) { await call('clip_audio', { clip_id: b, reset: true, enhance: en }); try { await call('export', { output: W('en.wav'), preset: 'wav', from: 6, to: 7 }); } catch (e) { bad.push(`mejora ${en}`); } }
    for (const pr of (await call('catalog_list', { kind: 'export_presets' })).items) {
      if (['mp4-4k', 'tv-4k'].includes(pr.id)) continue; // slow; same code path as mp4-1080p
      try { await call('export', { output: W(`preset_${pr.id}.${pr.ext}`), preset: pr.id, quality: 'draft', to: 0.5 }); } catch (e) { bad.push(`exportar ${pr.id}: ${e.message.split('\n').slice(-2).join(' ')}`); }
    }
    assert(!bad.length, `fallan ${bad.length}:\n${bad.join('\n')}`);
    if (existsSync(P)) await call('project_open', { path: P });
  });

  await test('pistas vinculadas: los títulos siguen al vídeo (y se pueden desvincular)', async () => {
    const pl = W('linked.cinta');
    await call('project_new', { path: pl, width: 640, height: 360 });
    const r = (await call('clip_add', { media: W('red.mp4') })).clip.id;
    const b = (await call('clip_add', { media: W('blue.mp4') })).clip.id;
    const t = (await call('title_add', { text: 'Sobre el azul', start: 4, duration: 1 })).clip.id;
    const start = async () => (await call('project_get', {})).tracks.flatMap((x) => x.clips).find((c) => c.id === t).start;
    await call('clip_delete', { clip_ids: [r] });
    assert(near(await start(), 1, 0.01), `tras borrar el rojo el título pasa a 1 s (${await start()})`);
    await call('undo', {});
    assert(near(await start(), 4, 0.01), 'deshacer lo devuelve');
    await call('clip_set', { clip_id: r, speed: 2 });
    assert(near(await start(), 2.5, 0.01), `con el rojo a 2× el título pasa a 2,5 s (${await start()})`);
    await call('clip_set', { clip_id: r, speed: 1 });
    await call('clip_move', { clip_id: b, index: 0 });
    assert(near(await start(), 1, 0.01), `al poner el azul primero el título lo sigue (${await start()})`);
    await call('clip_move', { clip_id: r, index: 0 });
    const tt = (await call('project_get', {})).tracks.find((x) => x.clips.some((c) => c.id === t));
    await call('track_set', { track_id: tt.id, linked: false });
    await call('clip_delete', { clip_ids: [r] });
    assert(near(await start(), 4, 0.01), 'pista desvinculada: el título no se mueve');
    if (existsSync(P)) await call('project_open', { path: P });
  });

  await test('subtítulos palabra a palabra (resaltado dorado que avanza)', async () => {
    const pk = W('karaoke.cinta');
    await call('project_new', { path: pk, width: 640, height: 360 });
    await call('clip_add', { media: W('blue.mp4') });
    await call('title_add', { text: 'uno dos tres', style: 'subtitle-karaoke', start: 0, duration: 3 });
    const a = imgOf(await call('preview_frame', { time: 0.3, width: 640 }));
    const b = imgOf(await call('preview_frame', { time: 2.7, width: 640 }));
    const gold = (img) => img.share([255, 212, 0], 90);
    assert(gold(a) > 0.0006 && gold(b) > 0.0006, `palabra dorada visible (${gold(a)}, ${gold(b)})`);
    // the gold word moves from left to right
    const col = (img) => { let s = 0, n = 0; for (let x = 0; x < 1; x += 0.01) for (let y = 0.6; y < 0.85; y += 0.01) if (isColor(img.at(x, y), [255, 212, 0], 90)) { s += x; n++; } return n ? s / n : -1; };
    assert(col(a) >= 0 && col(b) > col(a) + 0.1, `el resaltado avanza (${col(a).toFixed(2)} → ${col(b).toFixed(2)})`);
    if (existsSync(P)) await call('project_open', { path: P });
  });

  await test('reencuadre siguiendo la cara: sin caras recorta al centro; con trayectoria el recorte se mueve', async () => {
    const pf = W('face.cinta');
    await call('project_new', { path: pf, width: 1280, height: 720 });
    await call('clip_add', { media: W('bars.mp4') });
    const r = await call('reframe', { aspect: '9:16', mode: 'face' });
    await call('undo', {});
    const id = (await call('clip_add', { media: W('hgrad.png'), duration: 5 })).clip.id;
    await call('clip_delete', { clip_ids: [(await call('project_get', {})).tracks.find((x) => x.kind === 'main').clips[0].id] });
    await call('reframe', { aspect: '9:16', mode: 'crop' });
    assert(r.width === 1080 && r.height === 1920 && r.clipsWithFace === 0, `sin caras: ${JSON.stringify(r)}`);
    // a tracked path (as face detection writes it) makes the crop window travel across the picture
    const proj = JSON.parse(readFileSync(pf, 'utf8'));
    proj.clips.find((c) => c.id === id).focusTrack = [{ t: 0, x: 0.2, y: 0.5 }, { t: 5, x: 0.8, y: 0.5 }];
    writeFileSync(pf, JSON.stringify(proj));
    const f1 = imgOf(await call('preview_frame', { time: 0.2, width: 270 }));
    const f2 = imgOf(await call('preview_frame', { time: 4.8, width: 270 }));
    const r1 = f1.at(0.5, 0.5)[0], r2 = f2.at(0.5, 0.5)[0];
    assert(r1 < 90 && r2 > 165, `el recorte viaja de la izquierda (rojo ${r1}) a la derecha (rojo ${r2})`);
    if (existsSync(P)) await call('project_open', { path: P });
  });

  await test('estabilización: reduce el temblor de verdad y un clip estabilizado se puede dividir', async () => {
    // static pattern filmed by a "shaking camera"
    ff('-f', 'lavfi', '-i', "color=black:s=960x540:d=4:r=30,geq=lum='128+100*sin(X/9)*sin(Y/7)':cb=128:cr=128", '-vf', "crop=800:450:'80+45*sin(t*9)':'45+30*cos(t*7)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', W('shake.mp4'));
    const ps = W('stab.cinta');
    await call('project_new', { path: ps, width: 800, height: 450 });
    const id = (await call('clip_add', { media: W('shake.mp4') })).clip.id;
    const motion = (file) => {
      const r = spawnSync(FF, ['-hide_banner', '-i', file, '-vf', 'crop=iw*0.6:ih*0.6,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' });
      const v = [...r.stderr.matchAll(/YAVG=([\d.]+)/g)].map((m) => +m[1]);
      return v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
    };
    const raw = motion((await call('export', { output: W('shake-raw.mp4'), quality: 'draft' })).path);
    await call('clip_stabilize', { clip_id: id, accuracy: 15, shakiness: 10, smoothing: 30 });
    const fixed = motion((await call('export', { output: W('shake-fixed.mp4'), quality: 'draft' })).path);
    assert(fixed < raw * 0.6, `movimiento entre fotogramas ${raw.toFixed(1)} → ${fixed.toFixed(1)}`);
    await call('clip_split', { time: 2 });
    const parts = await call('export', { output: W('shake-split.mp4'), quality: 'draft' });
    assert(near(parts.duration, 4, 0.15), 'exporta tras dividir');
    const fromMid = await call('export', { output: W('shake-mid.mp4'), quality: 'draft', from: 2.5, to: 3.5 });
    // regression: stabilization followed by an RGB filter used to crash ffmpeg
    const g = await call('project_get', {});
    for (const c of g.tracks.find((x) => x.kind === 'main').clips) await call('clip_filter_add', { clip_id: c.id, filter: 'sepia' });
    const sep = await call('export', { output: W('shake-sepia.mp4'), quality: 'draft' });
    assert(near(sep.duration, 4, 0.15), 'estabilizado + sepia');
    assert(near(fromMid.duration, 1, 0.1), 'exporta un tramo del medio');
    if (existsSync(P)) await call('project_open', { path: P });
  });

  await test('audio correcto: el ecualizador quita graves y el compresor baja los fuertes', async () => {
    const pa = W('audio.cinta');
    await call('project_new', { path: pa });
    ff('-f', 'lavfi', '-i', 'sine=f=80:d=3', '-af', 'volume=0.9', W('bass.wav'));
    const c = (await call('clip_add', { media: W('bass.wav') })).clip.id;
    const flat = level((await call('export', { output: W('eq0.wav'), preset: 'wav' })).path);
    await call('clip_audio', { clip_id: c, eq_preset: 'bass-cut' });
    const cut = level((await call('export', { output: W('eq1.wav'), preset: 'wav' })).path);
    assert(flat - cut >= 4, `graves - reducción: ${flat} → ${cut} dB`);
    await call('clip_audio', { clip_id: c, reset: true, compressor: { threshold: -30, ratio: 12, attack: 1, release: 50, makeup: 0, mix: 1 } });
    const comp = level((await call('export', { output: W('comp.wav'), preset: 'wav' })).path);
    assert(flat - comp >= 4, `compresor: ${flat} → ${comp} dB`);
    if (existsSync(P)) await call('project_open', { path: P });
  });

  await test('transición visual: a mitad de un borrado ← cada lado muestra un clip', async () => {
    const pt = W('wipe.cinta');
    await call('project_new', { path: pt, width: 640, height: 360 });
    const a = (await call('clip_add', { media: W('red.mp4') })).clip.id;
    await call('clip_add', { media: W('blue.mp4') });
    await call('transition_set', { clip_id: a, type: 'wipeleft', duration: 2 });
    const img = imgOf(await call('preview_frame', { time: 2, width: 320 }));
    const l = img.at(0.1, 0.5), r = img.at(0.9, 0.5);
    assert((isColor(l, [255, 0, 0]) && isColor(r, [0, 0, 255])) || (isColor(l, [0, 0, 255]) && isColor(r, [255, 0, 0])), `lados ${l} | ${r}`);
    if (existsSync(P)) await call('project_open', { path: P });
  });

  await test('subtítulos automáticos en español (voz española de Windows → Whisper)', async () => {
    const s = await call('cinta_status');
    if (!s.whisper) { console.log('      (sin modelo Whisper)'); return; }
    const wav = W('es.wav');
    const ps1 = W('tts.ps1');
    writeFileSync(ps1, `Add-Type -AssemblyName System.Speech\n$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es*' } | Select-Object -First 1\nif (-not $v) { exit 3 }\n$s.SelectVoice($v.VoiceInfo.Name)\n$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}')\n$s.Speak('Hola a todos. Hoy vamos a aprender a editar vídeos con subtítulos automáticos.')\n$s.Dispose()\n`);
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true });
    if (r.status === 3) { console.log('      (no hay voz española instalada en Windows)'); return; }
    const pe = W('es.cinta');
    await call('project_new', { path: pe });
    await call('clip_add', { media: wav });
    const clip = (await call('project_get', {})).tracks.flatMap((t) => t.clips)[0];
    const out = await call('auto_subtitles', { clip_ids: [clip.id], language: 'es', style: 'subtitle-karaoke' });
    const txt = out.text.toLowerCase();
    assert(/hola/.test(txt) && /subt[ií]tulos/.test(txt) && /autom[aá]tic/.test(txt), `transcripción: ${out.text}`);
    console.log(`      «${out.text}»`);
    if (existsSync(P)) await call('project_open', { path: P });
  });

  await test('exportar con la tarjeta gráfica (y sin ella): mismo resultado, H.264 válido', async () => {
    const gpu = await call('export', { project: P, output: W('gpu.mp4'), quality: 'good', to: 3 });
    const cpu = await call('export', { project: P, output: W('cpu.mp4'), quality: 'good', to: 3, hardware: 'off' });
    assert(cpu.encoder === 'libx264', `sin tarjeta: ${cpu.encoder}`);
    assert(/^(h264_(nvenc|qsv|amf)|libx264)$/.test(gpu.encoder), `codificador ${gpu.encoder}`);
    assert(gpu.info.vcodec === 'h264' && near(gpu.duration, 3, 0.1), 'vídeo H.264 de 3 s');
    const a = frameOf(gpu.path, 1).at(0.5, 0.5), b = frameOf(cpu.path, 1).at(0.5, 0.5);
    assert(isColor(a, b, 40), `misma imagen ${a} / ${b}`);
    console.log(`      con la tarjeta: ${gpu.encoder} (${gpu.seconds.toFixed(1)} s) · procesador: ${cpu.seconds.toFixed(1)} s`);
  });

  await test('flujos de IA por MCP: transcribir, cortar por texto, muletillas, subtítulos, traducción, capítulos, voz y shorts', async () => {
    const s = await call('cinta_status');
    const voices = (await call('tts_voices')).voices;
    if (!s.whisper || !voices.some((v) => v.culture.startsWith('es'))) { console.log('      (sin Whisper o sin voz española: se omite)'); return; }
    const pv = W('ia.cinta');
    await call('project_new', { path: pv, width: 1280, height: 720 });
    // a talking clip made with the Windows voice (then put on the main track with a picture)
    const v = await call('voiceover_tts', { text: 'Hola a todos. Este vídeo es una prueba de edición. Vamos a quitar esta frase de aquí. Gracias por ver el vídeo.', voice: 'es', at: 0 });
    assert(v.duration > 3 && level(v.path) > -40, `voz en off generada (${v.duration} s)`);
    ff('-f', 'lavfi', '-i', `color=0x203040:s=640x360:r=30:d=${Math.ceil(v.duration)}`, '-i', v.path, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', W('habla.mp4'));
    await call('project_new', { path: pv, width: 1280, height: 720, overwrite: true });
    await call('clip_add', { media: W('habla.mp4') });
    const b = await call('transcript_build', { language: 'es' });
    assert(b.words > 10 && b.sentences >= 1, `transcripción: ${b.words} palabras`);
    const t = await call('transcript_get', {});
    const all = t.sentences.map((x) => x.text).join(' ');
    assert(/prueba/i.test(all) && /frase/i.test(all), `texto: ${all}`);
    const lines = await call('transcript_get', { format: 'lines' });
    assert(/^\[00:0\d\]/.test(lines.text), 'formato por líneas');
    const d0 = (await call('project_get', {})).duration;
    const cut = await call('transcript_cut', { phrases: ['quitar esta frase de aquí'] });
    assert(cut.cuts === 1 && cut.duration < d0 - 1, `corte por frase: ${d0} → ${cut.duration}`);
    const after = (await call('transcript_get', {})).sentences.map((x) => x.text).join(' ');
    assert(!/quitar esta frase/i.test(after) && /gracias/i.test(after), `la frase desapareció: ${after}`);
    const fl = await call('fillers_find', { extra: ['gracias'] });
    assert(fl.count >= 1 && fl.fillers.some((f) => /gracias/i.test(f.text)), 'muletilla encontrada');
    const fr = await call('fillers_remove', { extra: ['gracias'] });
    assert(fr.removedSeconds > 0.2, 'muletilla quitada');
    const words = (await call('transcript_get', { format: 'words' })).words;
    const wc = await call('transcript_cut', { word_ranges: [{ from: words[0].id, to: words[1].id }] });
    assert(wc.cuts === 1, 'corte por ids de palabras');
    const st = await call('subtitles_from_transcript', { style: 'subtitle', words: 4 });
    assert(st.captions >= 2, `subtítulos desde la transcripción: ${st.captions}`);
    const cues = await call('subtitles_get', {});
    const tr = await call('subtitles_add_language', { language: 'pt', texts: cues.cues.map((c) => `PT ${c.text}`), hide_source: true });
    assert(tr.captions === cues.count, 'pista traducida con los mismos subtítulos');
    const g = await call('project_get', {});
    assert(g.tracks.some((x) => x.name === 'Subtítulos (pt)') && g.tracks.find((x) => x.name === 'Subtítulos').hidden, 'pista (pt) visible y original oculta');
    await call('subtitles_update', { cues: [{ clip_id: cues.cues[0].id, text: 'Corregido' }] });
    assert((await call('subtitles_get', { track_id: cues.track.id })).cues[0].text === 'Corregido', 'corrección de un subtítulo');
    const ch = await call('chapters_set', { chapters: [{ time: 0, title: 'Saludo' }, { time: 2, title: 'La prueba' }] });
    assert(ch.youtube === '00:00 Saludo\n00:02 La prueba', `capítulos: ${ch.youtube}`);
    const sh = await call('shorts_create', { shorts: [{ start: 0, end: Math.min(3, g.duration), title: 'PRUEBA' }], output_dir: W('shorts'), export: true, quality: 'draft', music: null });
    const pr = probe(sh.shorts[0].video), vs = pr.streams.find((x) => x.codec_type === 'video');
    const info = { width: vs.width, height: vs.height, duration: Number(pr.format.duration) };
    assert(info.width === 1080 && info.height === 1920 && near(info.duration, Math.min(3, g.duration), 0.2), `short ${info.width}×${info.height} ${info.duration}s`);
    const shp = JSON.parse(readFileSync(sh.shorts[0].project, 'utf8'));
    assert(shp.clips.some((c) => c.title?.anim === 'karaoke') && shp.clips.some((c) => c.title?.text === 'PRUEBA'), 'el short lleva subtítulos palabra a palabra y el título');
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    assert(['quitar-muletillas', 'editar-por-texto', 'traducir-subtitulos', 'capitulos-youtube', 'shorts-de-una-clase'].every((p) => prompts.includes(p)), `prompts: ${prompts}`);
    const gp = await client.getPrompt({ name: 'traducir-subtitulos', arguments: { idioma: 'pt' } });
    assert(/subtitles_add_language/.test(gp.messages[0].content.text), 'el prompt guía con las herramientas');
    if (existsSync(P)) await call('project_open', { path: P });
  });

  // ───────────────────────── advanced mode (After Effects-style) ─────────────────────────
  const MP = W('motion.cinta');
  const span = (img, fy, rgb, tol = 90) => { const xs = []; for (let i = 0; i < img.width; i++) if (isColor(img.at(i / img.width, fy), rgb, tol)) xs.push(i); return xs.length ? { a: xs[0], b: xs[xs.length - 1], c: (xs[0] + xs[xs.length - 1]) / 2, n: xs.length } : null; };
  const vspan = (img, fx, rgb, tol = 90) => { const ys = []; for (let i = 0; i < img.height; i++) if (isColor(img.at(fx, i / img.height), rgb, tol)) ys.push(i); return ys.length ? { a: ys[0], b: ys[ys.length - 1], n: ys.length } : null; };
  const centroid = (img, rgb, tol = 120) => { let sx = 0, sy = 0, n = 0; for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (isColor(img.at(x / img.width, y / img.height), rgb, tol)) { sx += x; sy += y; n++; } return n ? [Math.round(sx / n), Math.round(sy / n), n] : null; };
  const frame = async (comp, time, width = 640) => { const r = await call('comp_frame', { project: MP, comp, time, width }); assert(!r.layerErrors, `capas con error: ${JSON.stringify(r.layerErrors)}`); return imgOf(r); };

  await test('modo avanzado: composición, sólido y fotogramas clave con Easy Ease (posición exacta por píxeles)', async () => {
    await call('project_new', { path: MP, width: 640, height: 360, fps: 30 });
    const c = await call('comp_new', { project: MP, name: 'Mov', width: 640, height: 360, fps: 30, duration: 2, bg: '#000000' });
    assert(c.comp.width === 640 && c.comp.layers.length === 0, 'composición');
    const l = await call('layer_add', { project: MP, comp: 'Mov', type: 'solid', color: '#ff0000', width: 60, height: 60, name: 'Caja' });
    await call('prop_set', { project: MP, comp: 'Mov', layer: 'Caja', path: 'position', keys: [{ t: 0, v: [60, 180], ease: 'easy' }, { t: 1, v: [580, 180], ease: 'easy' }] });
    const mid = span(await frame('Mov', 0.5), 0.5, [255, 0, 0]);
    assert(mid && near(mid.c, 320, 5), `en 0.5 s el centro debe estar en 320 (está en ${mid?.c})`);
    const early = span(await frame('Mov', 0.1), 0.5, [255, 0, 0]);
    assert(early && early.c < 95, `Easy Ease arranca despacio: en 0.1 s el centro está en ${early?.c} (lineal sería 112)`);
    const end = span(await frame('Mov', 1.5), 0.5, [255, 0, 0]);
    assert(end && near(end.c, 580, 5), `tras la última clave se queda en 580 (${end?.c})`);
    const g = await call('comp_get', { project: MP, comp: 'Mov' });
    assert(g.comp.layers[0].animated['transform.position'] === '2 claves', JSON.stringify(g.comp.layers[0].animated));
    void l;
  }, { isolated: true });

  await test('expresiones: opacidad con linear(), wiggle determinista, loopOut e informe de errores', async () => {
    await call('prop_set', { project: MP, comp: 'Mov', layer: 'Caja', path: 'opacity', expression: 'linear(time, 0, 1, 0, 100)' });
    const half = (await frame('Mov', 0.5)).at(0.5, 0.5);
    assert(half[0] > 100 && half[0] < 160, `opacidad 50 % → rojo a media intensidad (${half})`);
    await call('prop_set', { project: MP, comp: 'Mov', layer: 'Caja', path: 'opacity', expression: null });
    await call('prop_set', { project: MP, comp: 'Mov', layer: 'Caja', path: 'position', clear_keys: true, t: 0.5 });
    await call('prop_set', { project: MP, comp: 'Mov', layer: 'Caja', path: 'position', value: [320, 180] });
    await call('prop_set', { project: MP, comp: 'Mov', layer: 'Caja', path: 'position', expression: 'wiggle(3, 80)' });
    const a = centroid(await frame('Mov', 0.73), [255, 0, 0]), b = centroid(await frame('Mov', 0.73), [255, 0, 0]);
    assert(a && b && a[0] === b[0] && a[1] === b[1], `wiggle debe ser idéntico al volver a renderizar (${a} / ${b})`);
    assert(Math.abs(a[0] - 320) <= 82 && Math.abs(a[1] - 180) <= 82, `wiggle dentro de ±80 px (${a})`);
    const bad = await call('prop_set', { project: MP, comp: 'Mov', layer: 'Caja', path: 'rotation', expression: 'thisComp.layer("NoExiste").rotation' });
    assert(/NoExiste/.test(bad.expressionError ?? ''), `error de expresión claro: ${bad.expressionError}`);
    await call('prop_set', { project: MP, comp: 'Mov', layer: 'Caja', path: 'rotation', expression: null });
    await call('prop_set', { project: MP, comp: 'Mov', layer: 'Caja', path: 'position', expression: null });
    // loopOut: 0→1 s goes left→right, then repeats
    await call('prop_set', { project: MP, comp: 'Mov', layer: 'Caja', path: 'position', keys: [{ t: 0, v: [60, 180] }, { t: 0.5, v: [580, 180] }] });
    await call('prop_set', { project: MP, comp: 'Mov', layer: 'Caja', path: 'position', expression: "loopOut('cycle')" });
    const lo = span(await frame('Mov', 0.75), 0.5, [255, 0, 0]);
    assert(lo && near(lo.c, 320, 6), `loopOut('cycle') en 0.75 s = 0.25 s → 320 (${lo?.c})`);
  }, { isolated: true });

  await test('texto con animador por caracteres, formas con recortar trazados y repetidor', async () => {
    await call('comp_new', { project: MP, name: 'Texto', width: 640, height: 360, fps: 30, duration: 2, bg: '#000000' });
    const t = await call('layer_add', { project: MP, comp: 'Texto', type: 'text', text: 'MMMMMM', size: 90, color: '#ffffff' });
    const an = await call('text_animator_add', { project: MP, comp: 'Texto', layer: t.layer.id, props: { opacity: 0 }, selector: { shape: 'square', start: 0, end: 100 } });
    await call('prop_set', { project: MP, comp: 'Texto', layer: t.layer.id, path: `text.animators.${an.animator.name}.selectors.0.start`, keys: [{ t: 0, v: 0 }, { t: 1, v: 100 }] });
    const lit = (img, x0, x1) => { let n = 0; for (let x = x0; x < x1; x += 0.01) for (let y = 0.3; y < 0.7; y += 0.02) if (img.at(x, y)[0] > 180) n++; return n; };
    const im = await frame('Texto', 0.5);
    assert(lit(im, 0.1, 0.45) > 10 && lit(im, 0.55, 0.9) === 0, `máquina de escribir a la mitad: izquierda visible (${lit(im, 0.1, 0.45)}), derecha oculta (${lit(im, 0.55, 0.9)})`);
    const full = await frame('Texto', 1.5);
    assert(lit(full, 0.55, 0.9) > 10, 'al final se ve todo el texto');
    // trim paths: a yellow star drawn on from 0 to 100 %
    const sh = await call('shape_add', { project: MP, comp: 'Texto', kind: 'star', width: 200, color: null, stroke: '#ffd400', stroke_width: 10, trim: { start: 0, end: 0 }, position: [0, 0] });
    await call('layer_set', { project: MP, comp: 'Texto', layer: t.layer.id, hidden: true });
    await call('prop_set', { project: MP, comp: 'Texto', layer: sh.layer.id, path: `shapes.${sh.shape.name}.trim.end`, keys: [{ t: 0, v: 0 }, { t: 1, v: 100 }] });
    const y0 = (await frame('Texto', 0)).share([255, 212, 0], 120), y5 = (await frame('Texto', 0.5)).share([255, 212, 0], 120), y1 = (await frame('Texto', 1)).share([255, 212, 0], 120);
    assert(y0 < 0.0005 && y5 > 0.002 && y1 > y5 * 1.5, `el trazo crece: ${y0.toFixed(4)} → ${y5.toFixed(4)} → ${y1.toFixed(4)}`);
    await call('shape_add', { project: MP, comp: 'Texto', layer: sh.layer.id, kind: 'rect', width: 40, height: 40, color: '#00ffff', position: [-250, 120], repeater: { copies: 6, position: [100, 0] } });
    const rep = await frame('Texto', 1);
    let cyan = 0; for (let k = 0; k < 6; k++) if (isColor(rep.at((70 + k * 100) / 640, 300 / 360), [0, 255, 255], 120)) cyan++;
    assert(cyan === 6, `repetidor: 6 copias (${cyan})`);
  }, { isolated: true });

  await test('máscara con calado, modo de fusión y mate de seguimiento', async () => {
    await call('comp_new', { project: MP, name: 'Mate', width: 640, height: 360, fps: 30, duration: 1, bg: '#000000' });
    const blue = await call('layer_add', { project: MP, comp: 'Mate', type: 'solid', color: '#0000ff' });
    await call('mask_add', { project: MP, comp: 'Mate', layer: blue.layer.id, shape: 'ellipse', x: 170, y: 30, width: 300, height: 300, feather: 40 });
    let im = await frame('Mate', 0);
    assert(isColor(im.at(0.5, 0.5), [0, 0, 255]) && isColor(im.at(0.03, 0.05), [0, 0, 0], 30), 'máscara: centro azul, esquinas negras');
    const edge = im.at(170 / 640 + 0.005, 0.5);
    assert(edge[2] > 10 && edge[2] < 200, `calado: borde suave (${edge})`);
    // alpha matte: green only where the text is
    const g = await call('layer_add', { project: MP, comp: 'Mate', type: 'solid', color: '#00ff00' });
    const tx = await call('layer_add', { project: MP, comp: 'Mate', type: 'text', text: 'IIIIII', size: 200, color: '#ffffff' });
    await call('layer_arrange', { project: MP, comp: 'Mate', action: 'reorder', layers: [tx.layer.id], index: 1 });
    await call('layer_set', { project: MP, comp: 'Mate', layer: g.layer.id, matte: { layer: tx.layer.id, mode: 'alpha' } });
    im = await frame('Mate', 0);
    const greenShare = im.share([0, 255, 0], 90);
    assert(greenShare > 0.02 && greenShare < 0.4, `mate alfa: verde solo dentro del texto (${greenShare.toFixed(3)})`);
    assert(!isColor(im.at(0.03, 0.05), [0, 255, 0]), 'fuera del texto no hay verde');
    await call('layer_set', { project: MP, comp: 'Mate', layer: g.layer.id, matte: { layer: tx.layer.id, mode: 'alphaInv' } });
    im = await frame('Mate', 0);
    assert(im.share([0, 255, 0], 90) > 0.5, 'mate alfa invertido: verde fuera del texto');
    await call('layer_set', { project: MP, comp: 'Mate', layer: g.layer.id, matte: null, blend: 'multiply' });
    im = await frame('Mate', 0);
    assert(isColor(im.at(0.5, 0.5), [0, 0, 0], 40), `multiplicar verde × azul = negro (${im.at(0.5, 0.5)})`);
  }, { isolated: true });

  await test('3D con cámara (perspectiva) y desenfoque de movimiento por sub-fotogramas', async () => {
    await call('comp_new', { project: MP, name: '3D', width: 640, height: 360, fps: 30, duration: 1, bg: '#000000' });
    const s = await call('layer_add', { project: MP, comp: '3D', type: 'solid', color: '#ffffff', width: 200, height: 200 });
    await call('layer_set', { project: MP, comp: '3D', layer: s.layer.id, three_d: true });
    await call('prop_set', { project: MP, comp: '3D', layer: s.layer.id, path: 'rotationY', value: 60 });
    let im = await frame('3D', 0);
    const sp = span(im, 0.5, [255, 255, 255], 60);
    assert(sp && sp.n < 140 && sp.n > 60, `girado 60° en Y: más estrecho (${sp?.n} px; 200 × cos 60° ≈ 100)`);
    const left = vspan(im, (sp.a + 3) / 640, [255, 255, 255], 60), right = vspan(im, (sp.b - 3) / 640, [255, 255, 255], 60);
    assert(left && right && Math.abs(left.n - right.n) > 8, `perspectiva: un borde más alto que el otro (${left?.n} / ${right?.n})`);
    await call('layer_add', { project: MP, comp: '3D', type: 'camera' });
    await call('prop_set', { project: MP, comp: '3D', layer: s.layer.id, path: 'rotationY', value: 0 });
    const cam = (await call('comp_get', { project: MP, comp: '3D' })).comp.layers.find((l) => l.type === 'camera');
    await call('prop_set', { project: MP, comp: '3D', layer: cam.id, path: 'position', value: [320, 180, -400] });
    im = await frame('3D', 0);
    const big = span(im, 0.5, [255, 255, 255], 60);
    assert(big && big.n > 260, `cámara más cerca: el sólido se ve más grande (${big?.n} px)`);
    // motion blur
    await call('comp_new', { project: MP, name: 'MB', width: 640, height: 360, fps: 30, duration: 1, bg: '#000000' });
    const m = await call('layer_add', { project: MP, comp: 'MB', type: 'solid', color: '#ffffff', width: 40, height: 200 });
    await call('prop_set', { project: MP, comp: 'MB', layer: m.layer.id, path: 'position', keys: [{ t: 0, v: [0, 180] }, { t: 0.5, v: [640, 180] }] });
    const soft = (img) => { let n = 0; for (let x = 0; x < 640; x++) { const v = img.at(x / 640, 0.5)[0]; if (v > 20 && v < 235) n++; } return n; };
    const sharp = soft(await frame('MB', 0.25));
    await call('layer_set', { project: MP, comp: 'MB', layer: m.layer.id, motion_blur: true });
    const blurred = soft(await frame('MB', 0.25));
    assert(blurred > sharp + 20, `con desenfoque de movimiento hay una estela suave (${sharp} → ${blurred} px intermedios)`);
  }, { isolated: true });

  await test('regresiones de la animación de prueba: text_style, shape_set, quitar animadores, invertir capa y distorsiones', async () => {
    await call('comp_new', { project: MP, name: 'Reg', width: 640, height: 360, fps: 30, duration: 1, bg: '#000000' });
    const t = await call('layer_add', { project: MP, comp: 'Reg', type: 'text', text: 'HHHH', size: 100, color: '#ffffff' });
    const im0 = await frame('Reg', 0);
    const tallest = (img, x0, x1) => { let best = null; for (let x = x0; x < x1; x += 0.005) { const v = vspan(img, x, [255, 255, 255], 80); if (v && (!best || v.n > best.n)) best = v; } return best; };
    const h0 = tallest(im0, 0.2, 0.8);
    await call('layer_set', { project: MP, comp: 'Reg', layer: t.layer.id, text_style: { align: 'left' } });
    const im1 = await frame('Reg', 0);
    const h1 = tallest(im1, 0.4, 1);
    assert(h0 && h1 && Math.abs(h0.n - h1.n) <= 4 && h1.n > 50, `la altura del texto no cambia al alinear a la izquierda (${h0?.n} → ${h1?.n})`);
    const an = await call('text_animator_add', { project: MP, comp: 'Reg', layer: t.layer.id, props: { opacity: 0 }, selector: { start: 0, end: 100 } });
    assert((await frame('Reg', 0)).mean() < 2, 'el animador oculta el texto');
    await call('text_animator_remove', { project: MP, comp: 'Reg', layer: t.layer.id, animator: an.animator.name });
    assert((await frame('Reg', 0)).mean() > 5, 'sin el animador se ve otra vez');
    await call('layer_set', { project: MP, comp: 'Reg', layer: t.layer.id, hidden: true });
    const sh = await call('shape_add', { project: MP, comp: 'Reg', kind: 'rect', width: 300, height: 200, color: '#ff0000', name: 'Caja' });
    await call('shape_set', { project: MP, comp: 'Reg', layer: sh.layer.id, shape: 'Caja', fill: false, stroke: true, trim: { end: 0 } });
    let im = await frame('Reg', 0);
    assert(im.mean() < 2, 'recortar trazados al 0 % sin relleno no dibuja nada');
    await call('shape_set', { project: MP, comp: 'Reg', layer: sh.layer.id, shape: 'Caja', trim: null, gradient: { colors: ['#00ff00', '#00ff00'] } });
    im = await frame('Reg', 0);
    assert(isColor(im.at(0.5, 0.5), [0, 255, 0]), `sin recortar, con degradado verde (${im.at(0.5, 0.5)})`);
    // distortions change the picture
    const before = await frame('Reg', 0);
    for (const fx of ['twirl', 'bulge', 'ripple', 'turbulentDisplace']) {
      const a = await call('effect_add', { project: MP, comp: 'Reg', layer: sh.layer.id, effect: fx, values: fx === 'twirl' ? { angle: 180, twirlRadius: 60 } : fx === 'bulge' ? { hRadius: 300, vRadius: 300, height: 2 } : fx === 'ripple' ? { rippleRadius: 80, amplitude: 160 } : { amount: 80 } });
      const af = await frame('Reg', 0.5);
      let diff = 0; for (let y = 0.2; y < 0.8; y += 0.05) for (let x = 0.2; x < 0.8; x += 0.05) { const p = af.at(x, y), q = before.at(x, y); diff += Math.abs(p[1] - q[1]); }
      assert(diff > 100, `${fx} deforma la forma (${diff})`);
      await call('effect_remove', { project: MP, comp: 'Reg', layer: sh.layer.id, effect: a.effect.id });
    }
    await call('shape_set', { project: MP, comp: 'Reg', layer: sh.layer.id, shape: 'Caja', remove: true });
    assert(!(await call('comp_get', { project: MP, comp: 'Reg' })).comp.layers.find((l) => l.id === sh.layer.id).shapes, 'forma eliminada');
    // reverse a video layer: the last frame of the clip shows first
    await call('comp_new', { project: MP, name: 'Rev', width: 640, height: 360, fps: 30, duration: 2, bg: '#000000' });
    const v = await call('layer_add', { project: MP, comp: 'Rev', type: 'video', media_path: W('scenes.mp4'), duration: 2 });
    // the layer shows source 2 s → 4 s (red until 3 s, then blue)
    await call('layer_set', { project: MP, comp: 'Rev', layer: v.layer.id, start: -2, in: 0, out: 2 });
    assert(isColor((await frame('Rev', 0.1)).at(0.5, 0.5), [255, 0, 0]), 'hacia delante empieza en rojo');
    await call('layer_set', { project: MP, comp: 'Rev', layer: v.layer.id, stretch: -1 });
    const rv = (await frame('Rev', 0.1)).at(0.5, 0.5);
    assert(isColor(rv, [0, 0, 255]), `invertida empieza por el final del tramo: azul (${rv})`);
    assert(isColor((await frame('Rev', 1.9)).at(0.5, 0.5), [255, 0, 0]), 'y termina en rojo');
  }, { isolated: true });

  await test('bola de los elementos: ondular trazados, zigzag, rayo, ráfaga de partículas, mate líquido y squashBounce', async () => {
    if (!existsSync(MP)) await call('project_new', { path: MP, width: 640, height: 360, fps: 30 });
    await call('comp_new', { project: MP, name: 'El', width: 320, height: 240, fps: 30, duration: 2, bg: '#000000' });
    // wiggle paths: the outline moves over time; with speed 0 it does not
    const b = await call('shape_add', { project: MP, comp: 'El', kind: 'ellipse', width: 120, color: '#ffffff', name: 'Bola', wiggle: { size: 25, detail: 7, speed: 3 } });
    const a0 = await frame('El', 0), a1 = await frame('El', 0.5);
    let diff = 0; for (let y = 0.1; y < 0.9; y += 0.04) for (let x = 0.1; x < 0.9; x += 0.04) diff += Math.abs(a0.at(x, y)[0] - a1.at(x, y)[0]);
    assert(diff > 500, `la forma ondula con el tiempo (${diff})`);
    await call('shape_set', { project: MP, comp: 'El', layer: b.layer.id, shape: 'Bola', wiggle: { speed: 0 }, zigzag: { size: 12, ridges: 10 } });
    const s0 = await frame('El', 0), s1 = await frame('El', 1);
    let same = 0; for (let y = 0.1; y < 0.9; y += 0.04) for (let x = 0.1; x < 0.9; x += 0.04) same += Math.abs(s0.at(x, y)[0] - s1.at(x, y)[0]);
    assert(same === 0, `con velocidad 0 queda quieta (${same})`);
    // a new shape in the same layer is drawn on top
    await call('shape_add', { project: MP, comp: 'El', layer: b.layer.id, kind: 'ellipse', width: 30, color: '#ff0000', name: 'Punto' });
    assert(isColor((await frame('El', 0)).at(0.5, 0.5), [255, 0, 0]), 'la forma nueva queda encima');
    await call('layer_set', { project: MP, comp: 'El', layer: b.layer.id, hidden: true });
    // lightning from top to bottom: bright pixels in the middle band, black at the sides
    const s = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#00000000', width: 320, height: 240 });
    const lt = await call('effect_add', { project: MP, comp: 'El', layer: s.layer.id, effect: 'lightning', values: { origin: [160, 0], end: [160, 240], glowRadius: 10, flicker: 0, branching: 0 } });
    const im = await frame('El', 0);
    let hits = 0; for (let y = 0.05; y < 0.95; y += 0.05) { let best = 0; for (let x = 0.2; x < 0.8; x += 0.005) best = Math.max(best, im.at(x, y)[0]); if (best > 200) hits++; }
    assert(hits >= 15, `el rayo cruza la imagen (${hits}/18 filas)`);
    assert(im.at(0.02, 0.5)[2] < 40, 'lejos del rayo sigue oscuro');
    await call('effect_set', { project: MP, comp: 'El', layer: s.layer.id, effect: lt.effect.id, values: { flicker: 30 } });
    const f1 = await frame('El', 0.1), f2 = await frame('El', 0.6);
    let fl = 0; for (let y = 0.1; y < 0.9; y += 0.05) for (let x = 0.3; x < 0.7; x += 0.01) fl += Math.abs(f1.at(x, y)[0] - f2.at(x, y)[0]);
    assert(fl > 1000, `con «cambios por segundo» el rayo cambia (${fl})`);
    await call('effect_remove', { project: MP, comp: 'El', layer: s.layer.id, effect: lt.effect.id });
    // burst particles: nothing before burstAt, a cloud right after, gone after their life
    await call('effect_add', { project: MP, comp: 'El', layer: s.layer.id, effect: 'particles', values: { position: [160, 120], birth: 'burst', burstAt: 1, rate: 60, life: 0.5, velocity: 200, spread: 360, gravity: 0, drag: 2, size: 8, colorStart: '#ffffff', colorEnd: '#ffffff', fadeIn: 1 } });
    const before = (await frame('El', 0.9)).mean(), during = (await frame('El', 1.15)).mean(), after = (await frame('El', 1.7)).mean();
    assert(before < 0.5 && during > 2 && after < 0.5, `ráfaga ${before.toFixed(2)} → ${during.toFixed(2)} → ${after.toFixed(2)}`);
    // a moving emitter leaves a trail: particles stay where they were born (unless followEmitter)
    const tr = await call('effect_add', { project: MP, comp: 'El', layer: s.layer.id, effect: 'particles', values: { position: [40, 120], rate: 60, life: 4, velocity: 0, gravity: 0, size: 14, sizeVar: 0, radiusX: 0, radiusY: 0, colorStart: '#ffffff', colorEnd: '#ffffff', shape: 'shard', fadeIn: 1 } });
    await call('prop_set', { project: MP, comp: 'El', layer: s.layer.id, path: `effects.${tr.effect.id}.position`, keys: [{ t: 0, v: [40, 120] }, { t: 1, v: [280, 120] }] });
    const trailImg = await frame('El', 0.98);
    let lit = 0; for (let x = 0.15; x < 0.85; x += 0.05) if (trailImg.at(x, 0.5)[0] > 100) lit++;
    assert(lit >= 10, `estela a lo largo del recorrido (${lit}/14 puntos)`);
    await call('effect_set', { project: MP, comp: 'El', layer: s.layer.id, effect: tr.effect.id, values: { followEmitter: 1 } });
    const follow = await frame('El', 0.98);
    let lit2 = 0; for (let x = 0.15; x < 0.7; x += 0.05) if (follow.at(x, 0.5)[0] > 100) lit2++;
    assert(lit2 <= 1, `con «seguir al productor» no hay estela (${lit2})`);
    await call('effect_remove', { project: MP, comp: 'El', layer: s.layer.id, effect: tr.effect.id });
    const hspanOf = (img) => { let n = 0; for (let x = 0; x < img.width; x++) if (isColor(img.at(x / img.width, 0.5), [255, 255, 255], 90)) n++; return n; };
    // long directional blur on a dark teal keeps the hue (8-bit accumulation used to turn it blue)
    const tl = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#1d6670', width: 1400, height: 240 });
    await call('effect_add', { project: MP, comp: 'El', layer: tl.layer.id, effect: 'directionalBlur', values: { angle: 90, length: 300 } });
    const tlpx = (await frame('El', 0)).at(0.5, 0.5);
    assert(Math.abs(tlpx[0] - 0x1d) < 10 && Math.abs(tlpx[1] - 0x66) < 10 && Math.abs(tlpx[2] - 0x70) < 10, `el desenfoque direccional conserva el color (${tlpx} ≈ 29,102,112)`);
    await call('layer_delete', { project: MP, comp: 'El', layers: [tl.layer.id] });
    // toon bands: a horizontal ramp becomes exactly 3 flat colours
    const tb = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#ffffff', width: 320, height: 240 });
    await call('effect_add', { project: MP, comp: 'El', layer: tb.layer.id, effect: 'gradientRamp', values: { start: [0, 120], end: [320, 120], startColor: '#000000', endColor: '#ffffff' } });
    await call('effect_add', { project: MP, comp: 'El', layer: tb.layer.id, effect: 'toonBands', values: { bands: 3, c1: '#ff0000', c2: '#00ff00', c3: '#0000ff' } });
    const bands = await frame('El', 0);
    assert(isColor(bands.at(0.1, 0.5), [255, 0, 0]) && isColor(bands.at(0.5, 0.5), [0, 255, 0]) && isColor(bands.at(0.9, 0.5), [0, 0, 255]), `tres bandas planas (${bands.at(0.1, 0.5)} ${bands.at(0.5, 0.5)} ${bands.at(0.9, 0.5)})`);
    await call('layer_delete', { project: MP, comp: 'El', layers: [tb.layer.id] });
    // rim light: a dark square lit around its edge (red border, still dark inside) and a halo outside it;
    // checkboxes accept true / false
    const rl = await call('shape_add', { project: MP, comp: 'El', kind: 'rect', width: 160, height: 160, color: '#000000', name: 'Contraluz' });
    await call('effect_add', { project: MP, comp: 'El', layer: rl.layer.id, effect: 'rimLight', values: { color: '#ff0000', width: 10, softness: 0, intensity: 2, halo: 30, haloColor: '#00ff00', haloOpacity: 100 } });
    const rim = await frame('El', 0);
    const rimPx = rim.at(0.5 - 75 / 320, 0.5), inPx = rim.at(0.5, 0.5), haloPx = rim.at(0.5 - 86 / 320, 0.5);
    assert(rimPx[0] > 150 && rimPx[1] < 80, `borde rojo (${rimPx})`);
    assert(inPx[0] < 40, `el centro sigue oscuro (${inPx})`);
    assert(haloPx[1] > 60 && haloPx[0] < 60, `aura verde fuera (${haloPx})`);
    await call('layer_delete', { project: MP, comp: 'El', layers: [rl.layer.id] });
    const tn = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#ffffff', width: 320, height: 240 });
    const nz = await call('effect_add', { project: MP, comp: 'El', layer: tn.layer.id, effect: 'fractalNoise', values: { type: 'turbulent', uniform: false, scaleWidth: 30, scaleHeight: 300, invert: true } });
    const streaks = await frame('El', 0);
    // stretched 10× vertically: values change much more across x than down y
    let dx = 0, dy = 0; for (let i = 0; i < 20; i++) { const a = 0.1 + i * 0.04; dx += Math.abs(streaks.at(a, 0.5)[0] - streaks.at(a + 0.02, 0.5)[0]); dy += Math.abs(streaks.at(0.5, a)[0] - streaks.at(0.5, a + 0.02)[0]); }
    assert(dx > dy * 2, `vetas verticales (cambio horizontal ${dx}, vertical ${dy})`);
    await call('effect_set', { project: MP, comp: 'El', layer: tn.layer.id, effect: nz.effect.id, values: { invert: false } });
    await call('layer_delete', { project: MP, comp: 'El', layers: [tn.layer.id] });
    // effects that read another layer (hidden input layers, given by name)
    const src = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#ffffff', width: 320, height: 240, name: 'Fuente' });
    await call('effect_add', { project: MP, comp: 'El', layer: src.layer.id, effect: 'gradientRamp', values: { start: [0, 120], end: [320, 120], startColor: '#ff0000', endColor: '#0000ff' } });
    const ramp = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#ffffff', width: 320, height: 240, name: 'Rampa' });
    await call('effect_add', { project: MP, comp: 'El', layer: ramp.layer.id, effect: 'gradientRamp', values: { start: [0, 120], end: [320, 120], startColor: '#000000', endColor: '#ffffff' } });
    await call('layer_set', { project: MP, comp: 'El', layer: ramp.layer.id, hidden: true });
    const blob = await call('shape_add', { project: MP, comp: 'El', kind: 'ellipse', width: 120, color: '#ffffff', name: 'Mancha' });
    await call('layer_set', { project: MP, comp: 'El', layer: blob.layer.id, hidden: true });
    await call('layer_arrange', { project: MP, comp: 'El', action: 'reorder', layers: [src.layer.id], index: 1 });
    const plain = (await frame('El', 0)).at(0.5, 0.5);
    // set matte from a hidden ellipse: the centre stays, the corners go
    const sm = await call('effect_add', { project: MP, comp: 'El', layer: src.layer.id, effect: 'setMatte', values: { from: 'Mancha', channel: 'alpha', fit: 'center' } });
    const matted = await frame('El', 0);
    assert(matted.at(0.5, 0.5)[0] > 60 && matted.at(0.05, 0.1)[0] < 30 && matted.at(0.05, 0.1)[2] < 30, `mate de otra capa (centro ${matted.at(0.5, 0.5)}, esquina ${matted.at(0.05, 0.1)})`);
    await call('effect_remove', { project: MP, comp: 'El', layer: src.layer.id, effect: sm.effect.id });
    // gradient wipe at 50 %: the dark half of the ramp (left) is gone, the right half stays
    const gw = await call('effect_add', { project: MP, comp: 'El', layer: src.layer.id, effect: 'gradientWipe', values: { completion: 50, gradient: 'Rampa' } });
    const wiped = await frame('El', 0);
    assert(wiped.at(0.2, 0.5)[0] < 30 && wiped.at(0.8, 0.5)[2] > 120, `barrido de degradado (${wiped.at(0.2, 0.5)} / ${wiped.at(0.8, 0.5)})`);
    await call('effect_remove', { project: MP, comp: 'El', layer: src.layer.id, effect: gw.effect.id });
    // displacement: a flat 100 % map pushes the image by hMax px (colour from further right = bluer)
    const flat = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#ffffff', width: 320, height: 240, name: 'Blanco' });
    await call('layer_set', { project: MP, comp: 'El', layer: flat.layer.id, hidden: true });
    await call('effect_add', { project: MP, comp: 'El', layer: src.layer.id, effect: 'displacementMap', values: { map: 'Blanco', hChannel: 'red', hMax: 80, vChannel: 'off' } });
    const moved = (await frame('El', 0)).at(0.5, 0.5);
    assert(moved[2] - plain[2] > 60, `desplazado hacia la derecha (${plain} → ${moved})`);
    let refused = false; try { await call('effect_add', { project: MP, comp: 'El', layer: src.layer.id, effect: 'setMatte', values: { from: src.layer.id } }); } catch (er) { refused = /misma capa/.test(er.message); }
    assert(refused, 'una capa no puede ser su propia entrada');
    await call('layer_delete', { project: MP, comp: 'El', layers: [src.layer.id, ramp.layer.id, blob.layer.id, flat.layer.id] });
    // merge paths: two overlapping circles; subtract leaves a bite where the second one was, add fills the gap
    const mg = await call('shape_add', { project: MP, comp: 'El', kind: 'ellipse', width: 120, color: '#ffffff', position: [-35, 0] });
    await call('shape_add', { project: MP, comp: 'El', layer: mg.layer.id, kind: 'ellipse', width: 120, color: '#ffffff', position: [35, 0] });
    const mm = await call('shape_add', { project: MP, comp: 'El', layer: mg.layer.id, kind: 'merge', merge_mode: 'subtract', color: '#ff0000' });
    const sub = await frame('El', 0);
    assert(isColor(sub.at(0.5 - 70 / 320, 0.5), [255, 0, 0]) && sub.at(0.5 + 40 / 320, 0.5)[0] < 40, `restar: queda la primera sin la segunda (${sub.at(0.5 - 70 / 320, 0.5)} / ${sub.at(0.5 + 40 / 320, 0.5)})`);
    await call('shape_set', { project: MP, comp: 'El', layer: mg.layer.id, shape: mm.shape.id, merge_mode: 'intersect' });
    const inter = await frame('El', 0);
    assert(isColor(inter.at(0.5, 0.5), [255, 0, 0]) && inter.at(0.5 - 70 / 320, 0.5)[0] < 40, `intersecar: solo el centro común (${inter.at(0.5, 0.5)} / ${inter.at(0.5 - 70 / 320, 0.5)})`);
    await call('layer_delete', { project: MP, comp: 'El', layers: [mg.layer.id] });
    // offset paths and gradient stroke: a 60 px square grown by 20 px; its gradient stroke is red on the left, blue on the right
    const os = await call('shape_add', { project: MP, comp: 'El', kind: 'rect', width: 60, height: 60, color: '#00ff00', offset: { amount: 20 } });
    const grown = await frame('El', 0);
    assert(isColor(grown.at(0.5 - 45 / 320, 0.5), [0, 255, 0]), `desplazar +20: llega a 50 px del centro (${grown.at(0.5 - 45 / 320, 0.5)})`);
    await call('shape_set', { project: MP, comp: 'El', layer: os.layer.id, shape: os.shape.id, offset: null, fill: false, stroke_gradient: { colors: ['#ff0000', '#0000ff'], start: [-30, 0], end: [30, 0] } });
    await call('prop_set', { project: MP, comp: 'El', layer: os.layer.id, path: `shapes.${os.shape.id}.stroke.width`, value: 10 });
    const gst = await frame('El', 0), lpx = gst.at(0.5 - 30 / 320, 0.5), rpx = gst.at(0.5 + 30 / 320, 0.5);
    assert(lpx[0] > 150 && lpx[2] < 100 && rpx[2] > 150 && rpx[0] < 100, `trazo degradado rojo → azul (${lpx} / ${rpx})`);
    await call('layer_delete', { project: MP, comp: 'El', layers: [os.layer.id] });
    // 3D lights: a white card facing the camera (default camera; comp 320×240)
    await call('comp_new', { project: MP, name: 'L3', width: 320, height: 240, fps: 30, duration: 1, bg: '#000000' });
    const card = await call('layer_add', { project: MP, comp: 'L3', type: 'solid', color: '#ffffff', width: 120, height: 120, name: 'Carta' });
    await call('layer_set', { project: MP, comp: 'L3', layer: card.layer.id, three_d: true });
    const lum3 = async () => (await frame('L3', 0)).at(0.5, 0.5)[0];
    assert(await lum3() > 245, 'sin luces, la capa 3D se ve tal cual');
    const amb = await call('layer_add', { project: MP, comp: 'L3', type: 'light', light_type: 'ambient', name: 'Amb' });
    await call('prop_set', { project: MP, comp: 'L3', layer: amb.layer.id, path: 'light.intensity', value: 50 });
    const a50 = await lum3();
    assert(Math.abs(a50 - 128) < 12, `luz ambiente al 50 %: gris medio (${a50})`);
    const par = await call('layer_add', { project: MP, comp: 'L3', type: 'light', light_type: 'parallel', name: 'Sol' });
    await call('prop_set', { project: MP, comp: 'L3', layer: par.layer.id, path: 'position', value: [160, 120, -500] });
    await call('prop_set', { project: MP, comp: 'L3', layer: par.layer.id, path: 'light.poi', value: [160, 120, 0] });
    await call('prop_set', { project: MP, comp: 'L3', layer: card.layer.id, path: 'material.specular', value: 0 });
    const litV = await lum3();
    assert(litV > 235, `más la luz paralela de frente (difusa 50 %): blanco (${litV})`);
    await call('layer_set', { project: MP, comp: 'L3', layer: card.layer.id, material: { accepts_lights: false } });
    assert(await lum3() > 245, 'sin «acepta luces» vuelve a verse tal cual');
    await call('layer_set', { project: MP, comp: 'L3', layer: card.layer.id, material: { accepts_lights: true } });
    // shadow: a small card in front casts on the white one; only where it falls
    await call('layer_set', { project: MP, comp: 'L3', layer: par.layer.id, light: { casts_shadows: true } });
    await call('prop_set', { project: MP, comp: 'L3', layer: amb.layer.id, path: 'light.intensity', value: 20 });
    const blocker = await call('layer_add', { project: MP, comp: 'L3', type: 'solid', color: '#ff0000', width: 40, height: 40, name: 'Tapa' });
    await call('layer_set', { project: MP, comp: 'L3', layer: blocker.layer.id, three_d: true, material: { casts_shadows: 'only' } });
    await call('prop_set', { project: MP, comp: 'L3', layer: blocker.layer.id, path: 'position', value: [160, 120, -100] });
    const sh = await frame('L3', 0), inShade = sh.at(0.5, 0.5)[0], outShade = sh.at(0.5 + 45 / 320, 0.5)[0];
    assert(inShade < 90 && Math.abs(outShade - 178) < 15, `sombra de una capa «solo sombras» (dentro ${inShade}, fuera ${outShade})`);
    assert(sh.at(0.5, 0.5)[1] < 90 && sh.at(0.5, 0.5)[0] < 90, 'la capa «solo sombras» no se ve (no hay rojo)');
    await call('layer_delete', { project: MP, comp: 'L3', layers: [blocker.layer.id, amb.layer.id, par.layer.id] });
    // depth buffer: a floor whose anchor is nearer than the card would cover it if layers were sorted whole
    await call('prop_set', { project: MP, comp: 'L3', layer: card.layer.id, path: 'position', value: [160, 150, 300] });
    await call('layer_set', { project: MP, comp: 'L3', layer: card.layer.id, solid_color: '#00ff00' });
    const floor3 = await call('layer_add', { project: MP, comp: 'L3', type: 'solid', color: '#0000ff', width: 1000, height: 1000, name: 'Suelo' });
    await call('layer_set', { project: MP, comp: 'L3', layer: floor3.layer.id, three_d: true });
    await call('prop_set', { project: MP, comp: 'L3', layer: floor3.layer.id, path: 'position', value: [160, 220, 100] });
    await call('prop_set', { project: MP, comp: 'L3', layer: floor3.layer.id, path: 'rotationX', value: 90 });
    const zb = await frame('L3', 0), cardPx = zb.at(0.5, 158 / 240), floorPx = zb.at(0.5, 0.95);
    assert(isColor(cardPx, [0, 255, 0]) && isColor(floorPx, [0, 0, 255]), `cada píxel muestra lo más cercano (carta ${cardPx}, suelo ${floorPx})`);
    // depth of field: the card out of focus has a soft edge
    const cam3 = await call('layer_add', { project: MP, comp: 'L3', type: 'camera', name: 'Cam' });
    await call('layer_delete', { project: MP, comp: 'L3', layers: [floor3.layer.id] });
    const edgeSpan = async () => { const im = await frame('L3', 0); let n = 0; for (let x = 0; x < 1; x += 1 / 320) { const v = im.at(x, 150 / 240)[1]; if (v > 20 && v < 235) n++; } return n; };
    const sharp = await edgeSpan();
    await call('layer_set', { project: MP, comp: 'L3', layer: cam3.layer.id, dof: true });
    await call('prop_set', { project: MP, comp: 'L3', layer: cam3.layer.id, path: 'camera.dof.focus', value: 150 });
    await call('prop_set', { project: MP, comp: 'L3', layer: cam3.layer.id, path: 'camera.dof.aperture', value: 60 });
    const soft = await edgeSpan();
    assert(soft > sharp + 6, `profundidad de campo: el borde se difumina (${sharp} → ${soft} px de transición)`);
    await call('comp_delete', { project: MP, comp: 'L3' });
    // layer styles on a white 60 px square (comp 320×240): overlay, outside stroke, drop shadow animated, removal
    const stq = await call('shape_add', { project: MP, comp: 'El', kind: 'rect', width: 60, height: 60, color: '#ffffff', name: 'Estilos' });
    await call('layer_style', { project: MP, comp: 'El', layer: stq.layer.id, style: 'colorOverlay', values: { color: '#0000ff' } });
    await call('layer_style', { project: MP, comp: 'El', layer: stq.layer.id, style: 'stroke', values: { color: '#ff0000', size: 6, position: 'outside' } });
    const st1 = await frame('El', 0);
    assert(isColor(st1.at(0.5, 0.5), [0, 0, 255]), `superposición de color (${st1.at(0.5, 0.5)})`);
    assert(isColor(st1.at(0.5 - 33 / 320, 0.5), [255, 0, 0]), `trazo exterior de 6 px (${st1.at(0.5 - 33 / 320, 0.5)})`);
    await call('layer_style', { project: MP, comp: 'El', layer: stq.layer.id, style: 'stroke', remove: true });
    await call('layer_style', { project: MP, comp: 'El', layer: stq.layer.id, style: 'dropShadow', values: { color: '#00ff00', opacity: 100, angle: 90, distance: 0, size: 0 } });
    // the light comes from above (90°): the shadow falls down by `distance`, animated 0 → 40 px
    await call('prop_set', { project: MP, comp: 'El', layer: stq.layer.id, path: 'styles.dropShadow.distance', keys: [{ t: 0, v: 0 }, { t: 1, v: 40 }] });
    const below = (im) => im.at(0.5, 0.5 + 50 / 240);
    const d0 = await frame('El', 0), d1 = await frame('El', 1);
    assert(!isColor(below(d0), [0, 255, 0]) && isColor(below(d1), [0, 255, 0]), `sombra paralela animada hacia abajo (${below(d0)} → ${below(d1)})`);
    await call('layer_style', { project: MP, comp: 'El', layer: stq.layer.id, style: 'dropShadow', on: false });
    assert(!isColor(below(await frame('El', 1)), [0, 255, 0]), 'estilo apagado: no se dibuja');
    let noStyle = false; try { await call('prop_set', { project: MP, comp: 'El', layer: stq.layer.id, path: 'styles.bevel.size', value: 3 }); } catch (er) { noStyle = /layer_style/.test(er.message); }
    assert(noStyle, 'animar un estilo que no tiene la capa explica cómo añadirlo');
    await call('layer_delete', { project: MP, comp: 'El', layers: [stq.layer.id] });
    // puppet: a 200×20 bar pinned at both ends; the right end raised 60 px bends it up
    const bar = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#ffffff', width: 200, height: 20, name: 'Barra' });
    await call('puppet_pin', { project: MP, comp: 'El', layer: bar.layer.id, action: 'add', at: [65, 120], name: 'Izq' });
    await call('puppet_pin', { project: MP, comp: 'El', layer: bar.layer.id, action: 'add', at: [255, 120], name: 'Der' });
    const flatBar = await frame('El', 0);
    assert(flatBar.at(250 / 320, 0.5)[0] > 200, 'pines sin mover: la barra no cambia');
    await call('puppet_pin', { project: MP, comp: 'El', layer: bar.layer.id, action: 'move', pin: 'Der', to: [255, 60], t: 0 });
    const bent = await frame('El', 0);
    assert(bent.at(250 / 320, 0.5)[0] < 60 && bent.at(250 / 320, 62 / 240)[0] > 200 && bent.at(70 / 320, 0.5)[0] > 200, `la barra se dobla hacia arriba por la derecha (${bent.at(250 / 320, 0.5)} / ${bent.at(250 / 320, 62 / 240)})`);
    await call('puppet_pin', { project: MP, comp: 'El', layer: bar.layer.id, action: 'set', on: false });
    assert((await frame('El', 0)).at(250 / 320, 0.5)[0] > 200, 'marioneta apagada: vuelve a estar recta');
    await call('layer_delete', { project: MP, comp: 'El', layers: [bar.layer.id] });
    // motion tracker: the picture slides 60 px/s left and 30 px/s up; a tracked point does the same
    await call('comp_new', { project: MP, name: 'Trk', width: 640, height: 360, fps: 30, duration: 1.5, bg: '#000000' });
    const vid = await call('layer_add', { project: MP, comp: 'Trk', type: 'video', media_path: W('slide.mp4') });
    // a flat spot cannot be tracked: clear error with a textured spot nearby
    const flatVid = await call('layer_add', { project: MP, comp: 'Trk', type: 'video', media_path: W('red.mp4') });
    let flatErr = ''; try { await call('motion_track', { project: MP, comp: 'Trk', layer: flatVid.layer.id, points: [[320, 180]], at: 0, to: 1 }); } catch (er) { flatErr = er.message; }
    await call('layer_delete', { project: MP, comp: 'Trk', layers: [flatVid.layer.id] });
    assert(/zona lisa/.test(flatErr), `punto liso: lo explica (${flatErr.slice(0, 120)})`);
    const tr1 = await call('motion_track', { project: MP, comp: 'Trk', layer: vid.layer.id, points: [[220, 120]], at: 0, to: 1, apply: 'null' });
    assert(tr1.frames >= 30 && tr1.lost === 0, `rastreo de 1 s sin pérdidas (${tr1.frames} fotogramas, conf. mín. ${tr1.minConfidence})`);
    // a red dot parented to the null ends where the feature went: (220 − 60, 120 − 30)
    const dot = await call('shape_add', { project: MP, comp: 'Trk', kind: 'ellipse', width: 8, color: '#ff0000', name: 'Punto' });
    await call('layer_set', { project: MP, comp: 'Trk', layer: dot.layer.id, parent: tr1.layer });
    await call('prop_set', { project: MP, comp: 'Trk', layer: dot.layer.id, path: 'position', value: [0, 0] });
    const atEnd = await frame('Trk', 1, 640);
    assert(isColor(atEnd.at(160 / 640, 90 / 360), [255, 0, 0]), `el nulo sigue el punto hasta (160, 90) (${atEnd.at(160 / 640, 90 / 360)})`);
    await call('layer_delete', { project: MP, comp: 'Trk', layers: [dot.layer.id, tr1.layer] });
    // stabilize: the same spot of the picture stays at the centre of the frame
    const spot = (im) => [im.at(214 / 640, 114 / 360), im.at(226 / 640, 126 / 360), im.at(220 / 640, 132 / 360)];
    const before1 = spot(await frame('Trk', 0, 640));
    await call('motion_track', { project: MP, comp: 'Trk', layer: vid.layer.id, points: [[220, 120]], at: 0, to: 1, apply: 'stabilize' });
    const after1 = spot(await frame('Trk', 1, 640));
    assert(before1.every((p, k) => isColor(p, after1[k], 60)), `estabilizado: el detalle sigue en (220, 120) al segundo 1 (${before1.join(' ')} / ${after1.join(' ')})`);
    // 4 points → corner pin on a solid: it moves with the picture
    const card4 = await call('layer_add', { project: MP, comp: 'Trk', type: 'solid', color: '#ff0000', width: 640, height: 360, name: 'Pantalla' });
    await call('layer_set', { project: MP, comp: 'Trk', layer: vid.layer.id, hidden: false });
    await call('prop_set', { project: MP, comp: 'Trk', layer: vid.layer.id, path: 'anchor', value: [320, 180], clear_keys: true });
    await call('prop_set', { project: MP, comp: 'Trk', layer: vid.layer.id, path: 'position', value: [320, 180], clear_keys: true });
    const pin4 = await call('motion_track', { project: MP, comp: 'Trk', layer: vid.layer.id, points: [[220, 120], [420, 120], [420, 240], [220, 240]], at: 0, to: 1, apply: 'cornerPin', target: 'Pantalla' });
    assert(pin4.lost === 0, `4 puntos sin pérdidas (${pin4.minConfidence})`);
    const pinned = await frame('Trk', 1, 640);
    // at t = 1 the quad moved by (−60, −30): its centre is at (260, 150), the old centre's right part is uncovered
    assert(isColor(pinned.at(260 / 640, 150 / 360), [255, 0, 0]) && !isColor(pinned.at(470 / 640, 220 / 360), [255, 0, 0]), `esquina fija sigue al vídeo (${pinned.at(260 / 640, 150 / 360)} / ${pinned.at(470 / 640, 220 / 360)})`);
    // mask tracking: a mask over the sliding texture follows it (−60, −30 px in 1 s)
    const mvid = await call('layer_add', { project: MP, comp: 'Trk', type: 'video', media_path: W('slide.mp4'), name: 'Textura' });
    await call('mask_add', { project: MP, comp: 'Trk', layer: mvid.layer.id, shape: 'rect', x: 250, y: 130, width: 140, height: 100, name: 'Zona' });
    const mtr = await call('mask_track', { project: MP, comp: 'Trk', layer: mvid.layer.id, mask: 'Zona', at: 0, to: 1 });
    assert(mtr.frames >= 30 && mtr.points >= 2 && mtr.minConfidence > 0.8, `seguimiento de máscara con ${mtr.points} puntos (conf. mín. ${mtr.minConfidence})`);
    await call('layer_set', { project: MP, comp: 'Trk', layer: mvid.layer.id, solo: true });
    const mimg = await frame('Trk', 1, 640);
    // at t = 1 the mask is at x 190…330, y 100…200: inside shows video, the old right part is empty (black)
    assert(mimg.at(200 / 640, 110 / 360).some((v) => v > 20) && mimg.at(380 / 640, 220 / 360).every((v) => v < 10), `la máscara se movió con la textura (${mimg.at(200 / 640, 110 / 360)} / ${mimg.at(380 / 640, 220 / 360)})`);
    await call('comp_delete', { project: MP, comp: 'Trk' });
    // After Effects: the glow reaches 0.6 × radius + 2 px; gradient wipe and set matte use the layer itself by default
    const gl = await call('shape_add', { project: MP, comp: 'El', kind: 'rect', width: 40, height: 40, color: '#ffffff', name: 'Brillo' });
    const gfx = (await call('effect_add', { project: MP, comp: 'El', layer: gl.layer.id, effect: 'glow', values: { radius: 50, threshold: 10, intensity: 2 } })).effect.id;
    const gimg = await frame('El', 0), glowLit = gimg.at(0.5 + (20 + 10) / 320, 0.5)[0], glowDark = gimg.at(0.5 + (20 + 36) / 320, 0.5)[0];
    assert(glowLit > 25 && glowDark < 12, `el resplandor llega ~32 px (0,6 × 50 + 2): a 10 px ${glowLit}, a 36 px ${glowDark}`);
    // composite original: on top keeps the original inside; none + no operation leaves only the glow; A & B colours
    await call('effect_set', { project: MP, comp: 'El', layer: gl.layer.id, effect: gfx, values: { composite: 'onTop', intensity: 4 } });
    const onTop = (await frame('El', 0)).at(0.5, 0.5);
    assert(isColor(onTop, [255, 255, 255], 12), `encima: el interior es el original (${onTop})`);
    await call('effect_set', { project: MP, comp: 'El', layer: gl.layer.id, effect: gfx, values: { composite: 'none', operation: 'none', mode: 'ab', color: '#ff0000', colorB: '#0000ff', looping: 'sawAB', intensity: 1 } });
    const abImg = await frame('El', 0), abIn = abImg.at(0.5, 0.5), abOut = abImg.at(0.5 + 28 / 320, 0.5);
    assert(abIn[2] > abIn[0] && abOut[0] > abOut[2], `A y B: brillo fuerte → color B (azul ${abIn}), débil → color A (rojo ${abOut})`);
    await call('layer_delete', { project: MP, comp: 'El', layers: [gl.layer.id] });
    const gws = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#ffffff', width: 320, height: 240, name: 'Propio' });
    await call('effect_add', { project: MP, comp: 'El', layer: gws.layer.id, effect: 'gradientRamp', values: { start: [0, 120], end: [320, 120], startColor: '#000000', endColor: '#ffffff' } });
    await call('effect_add', { project: MP, comp: 'El', layer: gws.layer.id, effect: 'gradientWipe', values: { completion: 50 } });
    const own = await frame('El', 0);
    assert(own.at(0.2, 0.5)[0] < 30 && own.at(0.8, 0.5)[0] > 150, `barrido sin capa: usa la propia (${own.at(0.2, 0.5)} / ${own.at(0.8, 0.5)})`);
    await call('layer_delete', { project: MP, comp: 'El', layers: [gws.layer.id] });
    // colour: curves, levels per channel, colour balance, change to colour, a 3D LUT (.cube swapping red and blue)
    const col = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#c83232', width: 320, height: 240, name: 'Color' });
    const px = async () => (await frame('El', 0)).at(0.5, 0.5);
    const cfx = async (effect, values) => (await call('effect_add', { project: MP, comp: 'El', layer: col.layer.id, effect, values })).effect.id;
    const off = (id) => call('effect_remove', { project: MP, comp: 'El', layer: col.layer.id, effect: id });
    let id = await cfx('curves', { rgb: '0,1 1,0' });
    let c1 = await px(); assert(isColor(c1, [55, 205, 205], 30), `curvas invertidas (${c1})`); await off(id);
    id = await cfx('levelsRGB', { rOutWhite: 0 });
    c1 = await px(); assert(c1[0] < 10 && c1[1] > 40, `niveles: sin rojo (${c1})`); await off(id);
    id = await cfx('colorBalance', { hiR: -100 });
    c1 = await px(); assert(c1[0] < 60 && Math.abs(c1[2] - 50) < 6, `equilibrio de color: menos rojo en las iluminaciones, el azul oscuro intacto (${c1})`); await off(id);
    id = await cfx('changeToColor', { from: '#c83232', to: '#3232c8' });
    c1 = await px(); assert(c1[2] > 150 && c1[0] < 90, `cambiar a color: rojo → azul (${c1})`); await off(id);
    const cube = ['LUT_3D_SIZE 2']; for (let b2 = 0; b2 < 2; b2++) for (let g2 = 0; g2 < 2; g2++) for (let r2 = 0; r2 < 2; r2++) cube.push(`${b2} ${g2} ${r2}`);
    writeFileSync(W('swap.cube'), cube.join(String.fromCharCode(10)));
    id = await cfx('applyLut', { file: W('swap.cube') });
    c1 = await px(); assert(isColor(c1, [50, 50, 200], 25), `LUT .cube que cambia rojo y azul (${c1})`); await off(id);
    // Lumetri, Change Color, Channel Mixer, Shadow/Highlight, Colorama, Three-Way
    id = await cfx('lumetri', { exposure: 1 });
    c1 = await px(); assert(c1[0] > 240 && c1[1] > 70, `Lumetri: +1 de exposición (${c1})`); await off(id);
    id = await cfx('lumetri', { temperature: -100 });
    c1 = await px(); assert(c1[2] > 53 && c1[0] < 190, `Lumetri: temperatura fría (${c1})`); await off(id);
    id = await cfx('lumetri', { vigAmount: -5, vigMidpoint: 20, vigFeather: 20 });
    const vimg = await frame('El', 0); assert(vimg.at(0.02, 0.03)[0] < 40 && vimg.at(0.5, 0.5)[0] > 190, `Lumetri: viñeta (${vimg.at(0.02, 0.03)} / ${vimg.at(0.5, 0.5)})`); await off(id);
    id = await cfx('changeColor', { color: '#c83232', hue: 180, match: 'hue' });
    c1 = await px(); assert(c1[0] < 90 && c1[1] > 150 && c1[2] > 150, `Cambiar color: tono +180° (${c1})`); await off(id);
    id = await cfx('channelMixer', { rr: 0, rb: 100, bb: 0, br: 100 });
    c1 = await px(); assert(isColor(c1, [50, 50, 200], 15), `Mezclador: rojo ↔ azul (${c1})`); await off(id);
    id = await cfx('colorama', { palette: 'gray' });
    c1 = await px(); assert(Math.abs(c1[0] - c1[1]) < 4 && Math.abs(c1[1] - c1[2]) < 4, `Colorama gris (${c1})`); await off(id);
    // #c83232 (luma 82) is a midtone for After Effects' tonal ranges (shadows < 64, highlights > 192)
    id = await cfx('threeWay', { midBalance: '#4040ff' });
    c1 = await px(); assert(c1[2] > 55, `3 vías: medios tonos hacia el azul (${c1})`); await off(id);
    await call('layer_set', { project: MP, comp: 'El', layer: col.layer.id, solid_color: '#202020' });
    id = await cfx('shadowHighlight', { auto: false, shadowAmount: 100 });
    c1 = await px(); assert(c1[0] > 60, `Sombras/Iluminaciones: levanta las sombras (${c1})`); await off(id);
    await call('layer_delete', { project: MP, comp: 'El', layers: [col.layer.id] });
    // keying: green screen with a red square and a green-tinted edge
    const kGs = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#00b140', width: 320, height: 240, name: 'Verde' });
    const kSub = await call('shape_add', { project: MP, comp: 'El', kind: 'rect', width: 120, height: 120, color: '#c83c3c', name: 'Sujeto' });
    await call('layer_arrange', { project: MP, comp: 'El', action: 'precompose', layers: [kSub.layer.id, kGs.layer.id], name: 'Croma' });
    const kComp = (await call('comp_get', { project: MP, comp: 'El' }));
    const kCroma = (kComp.layers ?? []).find((q) => q.name === 'Croma')?.id ?? 'Croma';
    const kBg = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#0000ff', width: 320, height: 240, name: 'FondoK', index: 2 });
    const kFx = (await call('effect_add', { project: MP, comp: 'El', layer: kCroma, effect: 'keylight', values: { screen: '#00b140' } })).effect.id;
    const kKeyed = await frame('El', 0);
    assert(isColor(kKeyed.at(0.1, 0.1), [0, 0, 255]) && isColor(kKeyed.at(0.5, 0.5), [200, 60, 60], 40), `Keylight: el verde desaparece, el sujeto queda (${kKeyed.at(0.1, 0.1)} / ${kKeyed.at(0.5, 0.5)})`);
    await call('effect_set', { project: MP, comp: 'El', layer: kCroma, effect: kFx, values: { view: 'matte' } });
    const kMt = await frame('El', 0);
    assert(kMt.at(0.1, 0.1)[0] < 20 && kMt.at(0.5, 0.5)[0] > 235, `vista de mate: negro el fondo, blanco el sujeto (${kMt.at(0.1, 0.1)} / ${kMt.at(0.5, 0.5)})`);
    await call('effect_set', { project: MP, comp: 'El', layer: kCroma, effect: kFx, values: { view: 'final' } });
    await call('effect_add', { project: MP, comp: 'El', layer: kCroma, effect: 'simpleChoker', values: { choke: 20 } });
    const kCh = await frame('El', 0);
    assert(isColor(kCh.at(0.5 - 50 / 320, 0.5), [0, 0, 255]) && isColor(kCh.at(0.5, 0.5), [200, 60, 60], 40), `Simple Choker 20 px: el borde del sujeto se recorta (${kCh.at(0.5 - 50 / 320, 0.5)})`);
    await call('layer_delete', { project: MP, comp: 'El', layers: [kCroma, kBg.layer.id] });
    // spill suppressor: a greenish skin tone loses the green cast
    const kSp = await call('layer_add', { project: MP, comp: 'El', type: 'solid', color: '#a0c080', width: 320, height: 240, name: 'Derrame' });
    await call('effect_add', { project: MP, comp: 'El', layer: kSp.layer.id, effect: 'spillSuppressor', values: {} });
    const kSp1 = (await frame('El', 0)).at(0.5, 0.5);
    assert(kSp1[1] <= (kSp1[0] + kSp1[2]) / 2 + 3, `supresor: el verde no pasa de la media de rojo y azul (${kSp1})`);
    await call('layer_delete', { project: MP, comp: 'El', layers: [kSp.layer.id] });
    // frame mix: a video at half speed between frame 2 (black) and frame 3 (white) shows grey only with blending on
    await call('comp_new', { project: MP, name: 'Mix', width: 64, height: 64, fps: 30, duration: 2, bg: '#ff0000' });
    const fmLayer = await call('layer_add', { project: MP, comp: 'Mix', type: 'video', media_path: W('flicker.mp4') });
    await call('layer_set', { project: MP, comp: 'Mix', layer: fmLayer.layer.id, stretch: 2 });
    const fmMid = async () => (await frame('Mix', 0.5, 64)).at(0.5, 0.5)[0];
    const fmHard = await fmMid();
    await call('layer_set', { project: MP, comp: 'Mix', layer: fmLayer.layer.id, frame_blend: true });
    const fmSoft = await fmMid();
    assert((fmHard < 30 || fmHard > 225) && fmSoft > 90 && fmSoft < 165, `mezcla de fotogramas: ${fmHard} sin mezcla, ${fmSoft} con mezcla (≈ 128)`);
    await call('comp_delete', { project: MP, comp: 'Mix' });
    // pixel motion: half speed, halfway between frame 4 (square at x 50…66) and 5 (58…74): one square at 54…70
    await call('comp_new', { project: MP, name: 'PM', width: 160, height: 64, fps: 30, duration: 4, bg: '#000000' });
    const pmv = await call('layer_add', { project: MP, comp: 'PM', type: 'video', media_path: W('moving.mp4') });
    await call('layer_set', { project: MP, comp: 'PM', layer: pmv.layer.id, stretch: 2, frame_blend: 'mix' });
    const pmAt = async () => { const im = await frame('PM', 0.9, 160); return [im.at(52 / 160, 0.5)[0], im.at(68 / 160, 0.5)[0]]; };
    const [mix44, mix60] = await pmAt();
    await call('layer_set', { project: MP, comp: 'PM', layer: pmv.layer.id, frame_blend: 'pixel' });
    const [pm44, pm60] = await pmAt();
    assert(mix44 > 90 && mix44 < 165 && mix60 > 90 && mix60 < 165, `fusión: dos cuadrados a medias (${mix44}, ${mix60})`);
    assert(pm44 < 60 && pm60 > 190, `movimiento de píxeles: un cuadrado en la posición intermedia (x 52: ${pm44}, x 68: ${pm60})`);
    // Timewarp at 50 % (pixel motion) on a normal-speed layer gives the same in-between frame
    await call('layer_set', { project: MP, comp: 'PM', layer: pmv.layer.id, stretch: 1, frame_blend: false });
    await call('effect_add', { project: MP, comp: 'PM', layer: pmv.layer.id, effect: 'timewarp', values: { speed: 50 } });
    const [tw44, tw60] = await pmAt();
    assert(tw44 < 60 && tw60 > 190, `Timewarp 50 %: el mismo fotograma intermedio (${tw44}, ${tw60})`);
    await call('comp_delete', { project: MP, comp: 'PM' });
    // audio: spectrum of a 1 kHz tone peaks where 1 kHz is (log scale 20…2000 Hz along x 20…300), and audio to keyframes
    await call('comp_new', { project: MP, name: 'Aud', width: 320, height: 120, fps: 30, duration: 2, bg: '#000000' });
    const tone = await call('layer_add', { project: MP, comp: 'Aud', type: 'audio', media_path: W('tone.wav'), name: 'Tono' });
    const scr = await call('layer_add', { project: MP, comp: 'Aud', type: 'solid', color: '#000000', width: 320, height: 120, name: 'Pantalla' });
    await call('effect_add', { project: MP, comp: 'Aud', layer: scr.layer.id, effect: 'audioSpectrum', values: { audio: 'Tono', start: [20, 100], end: [300, 100], side: 'a', softness: 0, thickness: 4, maxHeight: 1000 } });
    const spec = await frame('Aud', 1, 320);
    const x1k = 20 + 280 * (Math.log(50) / Math.log(100));
    assert(spec.at(x1k / 320, 70 / 120)[0] > 150 && spec.at(60 / 320, 70 / 120)[0] < 40, `espectro: barra alta en 1 kHz (${spec.at(x1k / 320, 70 / 120)}), nada en graves (${spec.at(60 / 320, 70 / 120)})`);
    const ak = await call('audio_to_keys', { project: MP, comp: 'Aud', layers: ['Tono'] });
    // the stereo WAV carries the 1/8 tone at −3 dB per channel (0.088): RMS 0.0625 → 6.25
    assert(ak.frames >= 59 && Math.abs(ak.peak - 6.25) < 0.6, `audio a fotogramas clave: ${ak.frames} claves, pico ${ak.peak} (≈ 6,25)`);
    await call('comp_delete', { project: MP, comp: 'Aud' });
    void tone;
    // paragraph text wraps in its box; text on a circular path sits on the circle
    await call('comp_new', { project: MP, name: 'Txt', width: 320, height: 240, fps: 30, duration: 1, bg: '#000000' });
    const para = await call('layer_add', { project: MP, comp: 'Txt', type: 'text', text: 'uno dos tres cuatro cinco seis siete ocho', size: 24, color: '#ffffff' });
    await call('layer_set', { project: MP, comp: 'Txt', layer: para.layer.id, text_style: { align: 'left', box: [120, 200] } });
    const pimg = await frame('Txt', 0);
    let rows = 0; for (let y = 0; y < 1; y += 1 / 240) { let lit = false; for (let x = 0; x < 1; x += 1 / 320) if (pimg.at(x, y)[0] > 128) { lit = true; break; } if (lit) rows++; }
    let wide = false; for (let y = 0; y < 1; y += 1 / 240) for (const x of [0.04, 0.96]) if (pimg.at(x, y)[0] > 128) wide = true;
    assert(rows > 60 && !wide, `párrafo: varias líneas (${rows} filas con texto) dentro de 120 px de ancho`);
    await call('layer_delete', { project: MP, comp: 'Txt', layers: [para.layer.id] });
    const ringT = await call('layer_add', { project: MP, comp: 'Txt', type: 'text', text: 'OOOOOOOOOOOOOOOOOOOOOOOOOOOOOO', size: 16, color: '#ffffff' });
    await call('mask_add', { project: MP, comp: 'Txt', layer: ringT.layer.id, shape: 'ellipse', x: -90, y: -90, width: 180, height: 180, name: 'Aro' });
    await call('layer_set', { project: MP, comp: 'Txt', layer: ringT.layer.id, text_style: { align: 'left', path: { mask: 'Aro' } } });
    const rimg = await frame('Txt', 0);
    const near = (x, y) => { for (let dy = -10; dy <= 10; dy += 2) for (let dx = -10; dx <= 10; dx += 2) if (rimg.at((x + dx) / 320, (y + dy) / 240)[0] > 128) return true; return false; };
    assert(near(160, 30) && near(250, 120) && !near(160, 120), 'texto en trazado: sobre el círculo (arriba y a la derecha), nada en el centro');
    await call('comp_delete', { project: MP, comp: 'Txt' });
    // layer control and dropdown control in expressions; exponential scale; motion sketch
    await call('comp_new', { project: MP, name: 'Ctl', width: 320, height: 240, fps: 30, duration: 2, bg: '#000000' });
    const tgt = await call('shape_add', { project: MP, comp: 'Ctl', kind: 'rect', width: 20, height: 20, color: '#ff0000', name: 'Objetivo' });
    await call('prop_set', { project: MP, comp: 'Ctl', layer: tgt.layer.id, path: 'position', value: [60, 60] });
    const fol = await call('shape_add', { project: MP, comp: 'Ctl', kind: 'rect', width: 20, height: 20, color: '#00ff00', name: 'Seguidor' });
    await call('effect_add', { project: MP, comp: 'Ctl', layer: fol.layer.id, effect: 'layerCtrl', values: { value: 'Objetivo' } });
    await call('effect_add', { project: MP, comp: 'Ctl', layer: fol.layer.id, effect: 'dropdownCtrl', values: { items: 'izquierda|derecha', value: 2 } });
    await call('prop_set', { project: MP, comp: 'Ctl', layer: fol.layer.id, path: 'position', expression: 'const o = effect("Control de capa")("Capa").position; const m = effect("Control de menú desplegable")("Menú"); add(o, [m === 2 ? 100 : -100, 0])' });
    const cimg = await frame('Ctl', 0);
    assert(isColor(cimg.at(160 / 320, 60 / 240), [0, 255, 0]), `control de capa + menú: el seguidor está 100 px a la derecha del objetivo (${cimg.at(160 / 320, 60 / 240)})`);
    await call('prop_set', { project: MP, comp: 'Ctl', layer: tgt.layer.id, path: 'scale', keys: [{ t: 0, v: [100, 100] }, { t: 1, v: [400, 400] }] });
    await call('keyframe_assist', { project: MP, comp: 'Ctl', kind: 'exponentialScale', layers: [tgt.layer.id], path: 'scale' });
    const mid = await call('comp_get', { project: MP, comp: 'Ctl' });
    void mid;
    const scImg = await frame('Ctl', 0.5);
    // exponential: at half time 100 · 4^0.5 = 200 % → 40 px wide (linear would give 250 % → 50 px)
    let wpx = 0; for (let x = 0; x < 320; x++) if (isColor(scImg.at(x / 320, 60 / 240), [255, 0, 0])) wpx++;
    assert(Math.abs(wpx - 40) <= 3, `escala exponencial: a mitad, 200 % (${wpx} px de ancho)`);
    await call('keyframe_assist', { project: MP, comp: 'Ctl', kind: 'sketch', layers: [tgt.layer.id], path: 'position', points: [0, 40, 200, 0.5, 160, 200, 1, 280, 200], smoothing: 2 });
    await call('prop_set', { project: MP, comp: 'Ctl', layer: tgt.layer.id, path: 'scale', value: [100, 100], clear_keys: true });
    const sk = await frame('Ctl', 1);
    assert(isColor(sk.at(280 / 320, 200 / 240), [255, 0, 0]), `Motion Sketch: al segundo 1 está donde terminó el trazo (${sk.at(280 / 320, 200 / 240)})`);
    await call('comp_delete', { project: MP, comp: 'Ctl' });
    // morph: a small square keyed into a big star of a different vertex count, through a path made from an ellipse
    const mo = await call('shape_add', { project: MP, comp: 'El', kind: 'ellipse', width: 60, color: '#ffffff', name: 'Morf' });
    await call('shape_set', { project: MP, comp: 'El', layer: mo.layer.id, shape: 'Morf', to_path: true });
    const sq = [-30, -30, 30, -30, 30, 30, -30, 30], big = []; for (let i = 0; i < 12; i++) { const an = (i / 12) * Math.PI * 2; big.push(Math.cos(an) * 110, Math.sin(an) * 110); }
    await call('prop_set', { project: MP, comp: 'El', layer: mo.layer.id, path: 'shapes.Morf.path', path_points: true, keys: [{ t: 0, v: sq }, { t: 1, v: big }] });
    const w0 = hspanOf(await frame('El', 0)), w5 = hspanOf(await frame('El', 0.5)), w1 = hspanOf(await frame('El', 1));
    assert(w0 < w5 && w5 < w1, `la forma crece al transformarse (${w0} → ${w5} → ${w1} px)`);
    await call('layer_delete', { project: MP, comp: 'El', layers: [mo.layer.id] });
    // gooey: two separate dots close together melt into one blob (the gap fills)
    await call('layer_set', { project: MP, comp: 'El', layer: s.layer.id, hidden: true });
    const g = await call('shape_add', { project: MP, comp: 'El', kind: 'ellipse', width: 60, color: '#ffffff', name: 'A', position: [-34, 0] });
    await call('shape_add', { project: MP, comp: 'El', layer: g.layer.id, kind: 'ellipse', width: 60, color: '#ffffff', name: 'B', position: [34, 0] });
    assert((await frame('El', 0)).at(0.5, 0.5)[0] < 30, 'sin mate líquido hay un hueco entre las dos');
    await call('effect_add', { project: MP, comp: 'El', layer: g.layer.id, effect: 'gooey', values: { radius: 10, threshold: 40 } });
    assert((await frame('El', 0)).at(0.5, 0.5)[0] > 200, 'con mate líquido se funden');
    // squashBounce on a shape: at the impact the bottom stays on the floor
    await call('layer_set', { project: MP, comp: 'El', layer: g.layer.id, hidden: true });
    const ball = await call('shape_add', { project: MP, comp: 'El', kind: 'ellipse', width: 60, color: '#00ff00', name: 'Bote' });
    await call('prop_set', { project: MP, comp: 'El', layer: ball.layer.id, path: 'position', value: [160, 200] });
    await call('preset_apply', { project: MP, comp: 'El', preset: 'squashBounce', layers: [ball.layer.id], at: 0, duration: 1, amount: 120 });
    const imTop = await frame('El', 0), imHit = await frame('El', 0.5);
    const top = vspan(imTop, 0.5, [0, 255, 0], 80), hit = vspan(imHit, 0.5, [0, 255, 0], 80);
    assert(top && hit && top.n > hit.n * 1.3, `aplastada al tocar el suelo (${top?.n} → ${hit?.n} px)`);
    assert(Math.abs(hit.b / imHit.height - 230 / 240) < 0.03, `la base no se hunde (${hit.b} de ${imHit.height})`);
    assert(top.b / imTop.height < 0.6, `arriba está a la altura del salto (${top.b})`);
  }, { isolated: true });

  await test('todos los efectos del catálogo se dibujan sin errores (y cambian la imagen)', async () => {
    const fx = (await call('catalog_list', { kind: 'motion_effects' })).items;
    assert(fx.length >= 50, `${fx.length} efectos`);
    await call('comp_new', { project: MP, name: 'FX', width: 320, height: 180, fps: 30, duration: 1, bg: '#202020' });
    const base = await call('layer_add', { project: MP, comp: 'FX', type: 'solid', color: '#3366cc', width: 320, height: 180 });
    await call('effect_add', { project: MP, comp: 'FX', layer: base.layer.id, effect: 'gradientRamp', values: { startColor: '#ff3300', endColor: '#00ccff', blend: 30 } });
    // input for effects that read another layer: a hidden ellipse
    const inp = await call('shape_add', { project: MP, comp: 'FX', kind: 'ellipse', width: 140, color: '#ffffff', name: 'Entrada' });
    await call('layer_set', { project: MP, comp: 'FX', layer: inp.layer.id, hidden: true });
    const ref = await frame('FX', 0.5, 320);
    const nochange = [];
    const FXD = new Map(createRequire(import.meta.url)(join(root, 'dist', 'core', 'index.js')).motion.FX.map((d) => [d.id, d]));
    for (const f of fx) {
      if (/Ctrl$/.test(f.id) || f.id === 'slider' || f.id === 'gradientRamp') continue;
      // effects whose defaults are neutral get a visible setting
      const TRY = { brightnessContrast: { brightness: 40 }, hueSat: { hue: 120 }, levels: { gamma: 2.5 }, exposure: { exposure: 1.5 }, glow: { threshold: 10, intensity: 3 }, particles: { rate: 600, size: 40, warmup: 2 }, chromaticAberration: { amount: 60 }, glitch: { amount: 100, rgb: 60 }, curves: { rgb: '0,1 1,0' }, levelsRGB: { rOutWhite: 0 }, colorBalance: { hiR: -100, shB: 100 }, simpleChoker: { choke: 5 }, channelMixer: { rr: 0, rb: 100 }, lumetri: { exposure: 1 }, changeColor: { color: '#ff3300', hue: 120, tolerance: 60 }, threeWay: { midBalance: '#2020ff' }, keylight: { screen: '#ff3300' }, applyLut: { lut: 'LUT_3D_SIZE 2' + String.fromCharCode(10) + '1 1 1 0 1 1 1 0 1 0 0 1 1 1 0 0 1 0 1 0 0 0 0 0'.match(/\S+ \S+ \S+/g).join(String.fromCharCode(10)) } };
      const values = { ...(TRY[f.id] ?? FXD.get(f.id)?.probe ?? (f.params.some((p) => p.id === 'completion') ? { completion: 50 } : {})) };
      for (const p of f.params) if (p.type === 'layer') values[p.id] = 'Entrada';
      const a = await call('effect_add', { project: MP, comp: 'FX', layer: base.layer.id, effect: f.id, values });
      const im = await frame('FX', 0.5, 320);
      let diff = 0; for (let y = 0.1; y < 1; y += 0.1) for (let x = 0.05; x < 1; x += 0.05) { const p = im.at(x, y), q = ref.at(x, y); diff += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]); }
      if (diff < 30) nochange.push(f.id);
      await call('effect_remove', { project: MP, comp: 'FX', layer: base.layer.id, effect: a.effect.id });
    }
    // echo / posterizeTime / transformFx etc. act on movement only: allowed not to change a still layer
    // EXR channel effects need EXR footage (After Effects: «No auxiliary channels available») and Stroke needs a mask;
    // they have their own tests
    // the distortions are identities at their After Effects defaults (interpolation 0 %, radius 0, pins on the corners…)
    const allowed = new Set(['wideTime', 'timeBlend', 'timeDisplacement', 'leaveColor', 'removeMatting', 'shatter', 'cardDance', 'foam', 'particleWorld', 'polar', 'spherize', 'bezierWarp', 'meshWarp', 'liquify', 'bendIt', 'powerPin', 'stroke', 'extractor', 'identifier', 'cryptomatte', 'layerCtrl', 'dropdownCtrl', 'audioSpectrum', 'audioWaveform', 'timewarp', 'shadowHighlight', 'keyCleaner', 'matteChoker', 'simpleChoker', 'changeToColor', 'echo', 'posterizeTime', 'transformFx', 'motionTile', 'offset', 'cornerPin', 'mirror', 'lumaKey', 'colorKey', 'directionalBlur', 'radialBlur', 'sharpen', 'outline', 'dropShadow', 'emboss', 'blockDissolve']);
    const bad = nochange.filter((x) => !allowed.has(x) && !FXD.get(x)?.still);
    assert(!bad.length, `no cambian la imagen: ${bad.join(', ')}`);
  }, { isolated: true });

  await test('ajustes preestablecidos (todos) y plantillas sin errores; deshacer entre llamadas', async () => {
    const presets = (await call('catalog_list', { kind: 'motion_presets' })).items;
    assert(presets.length >= 45, `${presets.length} preajustes`);
    await call('comp_new', { project: MP, name: 'Pre', width: 640, height: 360, fps: 30, duration: 3, bg: '#000000' });
    for (const p of presets) {
      if (p.createsLayer) { await call('preset_apply', { project: MP, comp: 'Pre', preset: p.id }); continue; }
      const l = await call('layer_add', { project: MP, comp: 'Pre', type: p.textOnly ? 'text' : 'solid', text: 'Hola mundo', color: '#ffffff', width: 80, height: 80 });
      await call('preset_apply', { project: MP, comp: 'Pre', preset: p.id, layers: [l.layer.id] });
    }
    for (const t of [0.3, 1, 2.6]) await frame('Pre', t, 480);
    for (const tpl of (await call('catalog_list', { kind: 'motion_templates' })).items) {
      const r = await call('comp_template', { project: MP, template: tpl.id });
      const im = await frame(r.comp.name, 2, 480);
      assert(im.mean() > 3, `plantilla ${tpl.id} con contenido`);
    }
    const before = (await call('comp_get', { project: MP })).comps.length;
    await call('undo', { project: MP });
    assert((await call('comp_get', { project: MP })).comps.length === before - 1, 'deshacer quita la última plantilla');
    await call('redo', { project: MP });
  }, { isolated: true });

  await test('gráficos esenciales: propiedades maestras por capa, sustitución de medios y plantilla exportada', async () => {
    // a card: red box on top, green logo below; two copies side by side in «EG»
    await call('comp_new', { project: MP, name: 'Tarjeta', width: 200, height: 200, fps: 30, duration: 2, transparent: true });
    const egBox = await call('shape_add', { project: MP, comp: 'Tarjeta', kind: 'rect', width: 200, height: 100, color: '#ff0000', position: [0, -50] });
    await call('layer_set', { project: MP, comp: 'Tarjeta', layer: egBox.layer.id, name: 'Caja' });
    const egLogo = await call('layer_add', { project: MP, comp: 'Tarjeta', type: 'image', media_path: W('logo.png'), name: 'Logo' });
    await call('prop_set', { project: MP, comp: 'Tarjeta', layer: egLogo.layer.id, path: 'position', value: [100, 150] });
    const egColor = await call('essential_props', { project: MP, comp: 'Tarjeta', action: 'add', layer: 'Caja', path: 'shapes.0.fill.color', name: 'Color' });
    await call('essential_props', { project: MP, comp: 'Tarjeta', action: 'add', layer: 'Caja', path: 'opacity', name: 'Opacidad' });
    const egAll = await call('essential_props', { project: MP, comp: 'Tarjeta', action: 'add', layer: 'Logo', path: 'source', name: 'Imagen' });
    assert(egColor.result.name === 'Color' && egAll.essential.length === 3 && egAll.essential[0].value === '#ff0000' && egAll.essential[2].path === 'source', `expuestas: ${JSON.stringify(egAll.essential)}`);
    const egDup = await callErr('essential_props', { project: MP, comp: 'Tarjeta', action: 'add', layer: 'Caja', path: 'opacity' });
    assert(/ya está/.test(egDup), egDup);
    const egComps = (await call('comp_get', { project: MP })).comps;
    const egSub = egComps.find((c) => c.name === 'Tarjeta').id;
    await call('comp_new', { project: MP, name: 'EG', width: 400, height: 200, fps: 30, duration: 2, bg: '#000000' });
    const egA = (await call('layer_add', { project: MP, comp: 'EG', type: 'comp', comp_id: egSub, name: 'A' })).layer.id;
    const egB = (await call('layer_add', { project: MP, comp: 'EG', type: 'comp', comp_id: egSub, name: 'B' })).layer.id;
    await call('prop_set', { project: MP, comp: 'EG', layer: egA, path: 'position', value: [100, 100] });
    await call('prop_set', { project: MP, comp: 'EG', layer: egB, path: 'position', value: [300, 100] });
    const tall = (await call('media_import', { project: MP, paths: [W('tall.png')] })).media.find((m) => m.path.endsWith('tall.png'));
    await call('prop_set', { project: MP, comp: 'EG', layer: egB, path: 'essential.Color', value: '#0000ff' });
    await call('prop_set', { project: MP, comp: 'EG', layer: egB, path: 'essential.Imagen', value: tall.id });
    await call('prop_set', { project: MP, comp: 'EG', layer: egA, path: 'essential.Opacidad', keys: [{ t: 0, v: 100 }, { t: 1, v: 0 }] });
    const eg0 = await frame('EG', 0, 400), eg1 = await frame('EG', 1, 400);
    const [aTop, bTop, aLow, bLow] = [eg0.at(0.25, 0.25), eg0.at(0.75, 0.25), eg0.at(0.25, 0.75), eg0.at(0.75, 0.75)];
    assert(aTop[0] > 200 && aTop[2] < 50 && bTop[2] > 200 && bTop[0] < 50, `color por capa: A ${aTop}, B ${bTop}`);
    assert(aLow[1] > 200 && aLow[0] < 50 && bLow[0] > 200 && bLow[1] > 100 && bLow[1] < 200 && bLow[2] < 60, `sustitución de medios: A verde ${aLow}, B naranja ${bLow}`);
    assert(eg1.at(0.25, 0.25)[0] < 30 && eg1.at(0.75, 0.25)[2] > 200, `opacidad animada en el tiempo de EG: A ${eg1.at(0.25, 0.25)}, B ${eg1.at(0.75, 0.25)}`);
    // the nested comp itself keeps its own values
    const egIn = await frame('Tarjeta', 0, 200);
    assert(egIn.at(0.5, 0.25)[0] > 200 && egIn.at(0.5, 0.75)[1] > 200, `dentro de la composición, sin cambios: ${egIn.at(0.5, 0.25)} ${egIn.at(0.5, 0.75)}`);
    // rename follows into the overrides; reset goes back to the nested value
    await call('essential_props', { project: MP, comp: 'Tarjeta', action: 'rename', key: 'Color', name: 'Color de fondo' });
    const egLayers = (await call('comp_get', { project: MP, comp: 'EG' })).comp.layers;
    assert(egLayers.find((l) => l.name === 'B').overrides['Color de fondo'] === '#0000ff', `renombrada: ${JSON.stringify(egLayers.find((l) => l.name === 'B').overrides)}`);
    await call('prop_set', { project: MP, comp: 'EG', layer: egB, path: 'essential.Color de fondo', value: '#00ffff' });
    assert((await frame('EG', 0, 400)).at(0.75, 0.25)[1] > 200, 'cambiar por el nombre nuevo');
    const egList = await call('essential_props', { project: MP, comp: 'Tarjeta', action: 'list' });
    assert(egList.nestedIn.length === 2 && egList.essential[0].name === 'Color de fondo', `lista: ${JSON.stringify(egList.nestedIn)}`);
    await call('essential_props', { project: MP, comp: 'EG', action: 'reset', layer: 'B', key: 'Color de fondo' });
    const egR = (await frame('EG', 0, 400)).at(0.75, 0.25);
    assert(egR[0] > 200 && egR[2] < 50, `restablecida: ${egR}`);
    const egErr = await callErr('prop_set', { project: MP, comp: 'Tarjeta', layer: 'Caja', path: 'essential.Color de fondo', value: '#ffffff' });
    assert(/no es una capa de composición/.test(egErr), egErr);
    // template: export, import into another project, change it there
    const egFile = W('tarjeta.cintaplantilla');
    const egT = await call('template_export', { project: MP, comp: 'Tarjeta', output: egFile });
    assert(existsSync(egFile) && egT.comps === 1 && egT.media.length === 1 && egT.essential.length === 3, `plantilla: ${JSON.stringify(egT)}`);
    const TP = W('plantilla.cinta');
    await call('project_new', { path: TP, width: 400, height: 200, fps: 30 });
    await call('comp_new', { project: TP, name: 'Main', width: 400, height: 200, fps: 30, duration: 2, bg: '#000000' });
    const egImp = await call('template_import', { project: TP, file: egFile, into: 'Main' });
    assert(egImp.layer && egImp.essential.join() === 'Color de fondo,Opacidad,Imagen' && !egImp.missingMedia, `importada: ${JSON.stringify(egImp)}`);
    await call('prop_set', { project: TP, comp: 'Main', layer: egImp.layer.id, path: 'essential.Color de fondo', value: '#ffff00' });
    const egTP = imgOf(await call('comp_frame', { project: TP, comp: 'Main', time: 0, width: 400 }));
    const egY = egTP.at(0.5, 0.25), egG = egTP.at(0.5, 0.75);
    assert(egY[0] > 200 && egY[1] > 200 && egY[2] < 50 && egG[1] > 200 && egG[0] < 50, `plantilla en otro proyecto: amarillo ${egY}, logo ${egG}`);
    await call('template_import', { project: TP, file: egFile });
    const egPrj = await call('project_get', { project: TP });
    assert(egPrj.media.filter((m) => m.path.endsWith('logo.png')).length === 1, 'los medios ya importados se reutilizan');
    for (const c of ['EG', 'Tarjeta']) await call('comp_delete', { project: MP, comp: c });
  });

  await test('importar PSD como composición: capas, grupo, máscara de recorte, máscaras, estilos y ajustes', async () => {
    // a 200×100 document written with ag-psd: blue background; «Base» (white, its left half hidden by a raster
    // mask) with a red layer clipped to it; a group at 50 % with a green square under a yellow colour overlay;
    // «Vec» (white) cut by a vector mask to x 100…120; a hidden Invert adjustment layer and a text layer
    const { writePsdBuffer } = await import('ag-psd');
    const solid = (w, h, rgba) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set(rgba, i * 4); return { width: w, height: h, data: d }; };
    const half = (() => { const d = new Uint8ClampedArray(80 * 80 * 4); for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) d.fill(x < 40 ? 0 : 255, (y * 80 + x) * 4, (y * 80 + x) * 4 + 4); return { width: 80, height: 80, data: d }; })();
    const psdDoc = { width: 200, height: 100, children: [
      { name: 'Fondo', left: 0, top: 0, right: 200, bottom: 100, imageData: solid(200, 100, [0, 0, 255, 255]) },
      { name: 'Base', left: 10, top: 10, right: 90, bottom: 90, imageData: solid(80, 80, [255, 255, 255, 255]), mask: { left: 10, top: 10, right: 90, bottom: 90, defaultColor: 0, imageData: half } },
      { name: 'Recorte', left: 0, top: 0, right: 200, bottom: 100, clipping: true, imageData: solid(200, 100, [255, 0, 0, 255]) },
      { name: 'Grupo', opacity: 0.5, children: [
        { name: 'Verde', left: 140, top: 30, right: 180, bottom: 70, imageData: solid(40, 40, [0, 255, 0, 255]), effects: { solidFill: [{ enabled: true, color: { r: 255, g: 255, b: 0 }, opacity: 1, blendMode: 'normal' }] } },
      ] },
      { name: 'Vec', left: 100, top: 75, right: 160, bottom: 95, blendMode: 'linear dodge', imageData: solid(60, 20, [255, 255, 255, 255]),
        vectorMask: { paths: [{ open: false, fillRule: 'non-zero', knots: [[100, 75], [120, 75], [120, 95], [100, 95]].map(([x, y]) => ({ linked: false, points: [x, y, x, y, x, y] })) }] } },
      { name: 'Invertir', hidden: true, adjustment: { type: 'invert' } },
    ] };
    const psdFile = W('capas.psd');
    writeFileSync(psdFile, writePsdBuffer(psdDoc, { generateThumbnail: false, noBackground: true }));
    const imp = await call('import_as_comp', { project: MP, path: psdFile, name: 'PSD' });
    const byName = Object.fromEntries(imp.comp.layers.map((l) => [l.name, l]));
    assert(imp.comp.width === 200 && imp.layers === 7 && imp.nestedComps === 1, `importado: ${imp.layers} capas, ${imp.nestedComps} anidadas`);
    assert(imp.comp.layers[0].name === 'Invertir' && imp.comp.layers.at(-1).name === 'Fondo', `orden: ${imp.comp.layers.map((l) => l.name)}`);
    assert(byName.Recorte.matte?.layer === 'Base' && byName.Recorte.matte.mode === 'alpha', `máscara de recorte: ${JSON.stringify(byName.Recorte.matte)}`);
    assert(byName.Vec.blend === 'add' && byName.Vec.masks?.length === 1 && byName.Grupo.type === 'comp' && byName.Grupo.opacity === 50, `modo/máscara/grupo: ${JSON.stringify([byName.Vec, byName.Grupo])}`);
    assert(byName.Invertir.type === 'adjustment' && byName.Invertir.hidden && byName.Invertir.effects?.[0]?.fx === 'invert', `ajuste: ${JSON.stringify(byName.Invertir)}`);
    const pim = await frame('PSD', 0, 200);
    const pAt = (x, y) => pim.at(x / 200, y / 100);
    const [clipIn, clipOut, grp, vecIn, vecOut] = [pAt(70, 50), pAt(30, 50), pAt(160, 50), pAt(110, 85), pAt(145, 85)];
    assert(clipIn[0] > 230 && clipIn[2] < 25, `recorte dentro de la base visible: ${clipIn}`);
    assert(clipOut[2] > 230 && clipOut[0] < 25, `máscara de píxeles: mitad izquierda de la base oculta (se ve el fondo): ${clipOut}`);
    assert(Math.abs(grp[0] - 128) < 12 && Math.abs(grp[1] - 128) < 12 && Math.abs(grp[2] - 128) < 12, `grupo al 50 % con superposición amarilla sobre azul: ${grp}`);
    assert(vecIn[0] > 230 && vecIn[1] > 230 && vecOut[0] < 25 && vecOut[2] > 230, `máscara vectorial: ${vecIn} dentro, ${vecOut} fuera`);
    await call('undo', { project: MP });
    assert(!(await call('comp_get', { project: MP })).comps.some((c) => c.name === 'PSD'), 'deshacer quita toda la importación de una vez');
  });

  await test('importar Illustrator como composición: capas a capas de forma, trazado compuesto con agujero y trazo', async () => {
    // a PDF-compatible .ai (as Illustrator saves it: one optional-content group per layer, compressed content)
    const { deflateSync } = await import('node:zlib');
    const aiContent = Buffer.from([
      '/OC /MC0 BDC 0 0 1 rg 0 0 200 100 re f EMC',
      '/OC /MC1 BDC 1 0 0 rg 20 20 m 80 20 l 80 80 l 20 80 l h 40 40 m 40 60 l 60 60 l 60 40 l h f*',
      'q 1 0 0 1 100 0 cm 0 1 0 RG 6 w 1 J 20 50 m 80 50 l S Q',
      'BT /F1 12 Tf (hola) Tj ET EMC',
    ].join('\n'));
    const aiStream = deflateSync(aiContent);
    const aiObjs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Properties << /MC0 5 0 R /MC1 6 0 R >> >> >>',
      null,
      '<< /Type /OCG /Name (Fondo) >>',
      '<< /Type /OCG /Name (Formas) >>',
    ];
    const aiParts = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    aiObjs.forEach((o, i) => aiParts.push(o === null
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${aiStream.length} /Filter /FlateDecode >>\nstream\n`), aiStream, Buffer.from('\nendstream\nendobj\n')])
      : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`)));
    aiParts.push(Buffer.from('trailer\n<< /Root 1 0 R /Size 7 >>\n%%EOF\n'));
    const aiFile = W('formas.ai');
    writeFileSync(aiFile, Buffer.concat(aiParts));
    const ai = await call('import_as_comp', { project: MP, path: aiFile, name: 'AI' });
    assert(ai.comp.width === 200 && ai.comp.height === 100 && ai.layers === 2 && ai.paths === 3, `importado: ${ai.layers} capas, ${ai.paths} trazados`);
    assert(ai.comp.layers.map((l) => l.name).join() === 'Formas,Fondo' && ai.comp.layers.every((l) => l.type === 'shape'), `capas: ${ai.comp.layers.map((l) => `${l.name}:${l.type}`)}`);
    assert(ai.warnings?.some((w) => /textos/.test(w)), `aviso de texto sin contornos: ${JSON.stringify(ai.warnings)}`);
    const aim = await frame('AI', 0, 200);
    const aAt = (x, y) => aim.at(x / 200, y / 100);
    const [ring, hole, line, off] = [aAt(30, 50), aAt(50, 50), aAt(150, 50), aAt(150, 30)];
    assert(ring[0] > 230 && ring[2] < 25, `trazado compuesto (relleno): ${ring}`);
    assert(hole[2] > 230 && hole[0] < 25, `agujero par-impar: se ve el fondo ${hole}`);
    assert(line[1] > 230 && line[0] < 25 && off[2] > 230, `trazo verde desplazado por cm: ${line}, fuera ${off}`);
    const aiNoPdf = W('viejo.ai');
    writeFileSync(aiNoPdf, '%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator\n');
    const aiErr = await callErr('import_as_comp', { project: MP, path: aiNoPdf });
    assert(/compatibilidad con PDF/.test(aiErr), aiErr);
    await call('comp_delete', { project: MP, comp: 'AI' });
  });

  await test('exportar a Lottie: suavizados, trayectoria curva, expresiones horneadas, mates, imágenes y composiciones anidadas', async () => {
    await call('comp_new', { project: MP, name: 'Lot', width: 200, height: 100, fps: 25, duration: 2, bg: '#000000', transparent: true });
    const lBox = (await call('shape_add', { project: MP, comp: 'Lot', kind: 'rect', width: 40, height: 40, color: '#ff0000' })).layer.id;
    await call('prop_set', { project: MP, comp: 'Lot', layer: lBox, path: 'position', keys: [{ t: 0, v: [30, 50], ease: 'easy' }, { t: 1, v: [100, 20], ease: 'easy' }, { t: 2, v: [170, 50], ease: 'easy' }] });
    await call('prop_set', { project: MP, comp: 'Lot', layer: lBox, path: 'rotation', expression: 'time * 90' });
    await call('effect_add', { project: MP, comp: 'Lot', layer: lBox, effect: 'glow' });
    const lStar = (await call('shape_add', { project: MP, comp: 'Lot', kind: 'star', width: 60, color: null, stroke: '#ffffff', stroke_width: 4, trim: { start: 0, end: 50 } })).layer.id;
    const lImg = (await call('layer_add', { project: MP, comp: 'Lot', type: 'image', media_path: W('logo.png') })).layer.id;
    await call('layer_set', { project: MP, comp: 'Lot', layer: lImg, matte: { layer: lStar, mode: 'alpha' } });
    const lotSub = (await call('comp_new', { project: MP, name: 'LotSub', width: 50, height: 50, fps: 25, duration: 2 })).comp.id;
    await call('layer_add', { project: MP, comp: 'LotSub', type: 'solid', color: '#00ff00', width: 50, height: 50 });
    await call('layer_add', { project: MP, comp: 'Lot', type: 'comp', comp_id: lotSub });
    await call('layer_add', { project: MP, comp: 'Lot', type: 'text', text: 'Hola', size: 30, color: '#ffff00' });
    const lotFile = W('lot.json');
    const lr = await call('comp_export_lottie', { project: MP, comp: 'Lot', output: lotFile });
    const lj = JSON.parse(readFileSync(lotFile, 'utf8'));
    assert(lj.fr === 25 && lj.op === 50 && lj.w === 200 && lj.layers.length === lr.layers, `cabecera: ${JSON.stringify({ fr: lj.fr, op: lj.op, w: lj.w })}`);
    const box = lj.layers.find((x) => x.ty === 4 && x.shapes[0].it[0].ty === 'rc');
    const pk = box.ks.p.k;
    assert(box.ks.p.a === 1 && pk.length === 3 && pk[0].o.x === 0.333 && pk[0].o.y === 0 && pk[0].i.x === 0.667 && pk[0].i.y === 1, `suavizado: ${JSON.stringify(pk[0])}`);
    // Hermite tangents of the curved path: first key leaves towards the second (70,-30)/3, middle key along (140,0)/2/3
    assert(Math.abs(pk[0].to[0] - 70 / 3) < 0.01 && Math.abs(pk[0].to[1] + 10) < 0.01 && Math.abs(pk[1].to[0] - 70 / 3) < 0.01 && Math.abs(pk[0].ti[0] + 70 / 3) < 0.01, `tangentes espaciales: ${JSON.stringify([pk[0].to, pk[0].ti, pk[1].to])}`);
    assert(box.ks.r.a === 1 && box.ks.r.k.length >= 50 && Math.abs(box.ks.r.k[25].s[0] - 90) < 0.01, `expresión horneada: ${box.ks.r.k.length} claves, f25 = ${box.ks.r.k[25]?.s}`);
    const iImg = lj.layers.findIndex((x) => x.ty === 2);
    assert(lj.layers[iImg].tt === 1 && lj.layers[iImg - 1].td === 1 && lj.layers[iImg - 1].ty === 4, `mate: ${JSON.stringify(lj.layers.map((x) => [x.ty, x.td, x.tt]))}`);
    const img = lj.assets.find((x) => x.p?.startsWith('data:image/png;base64,')), pre = lj.assets.find((x) => x.layers);
    assert(img && img.w === 200 && pre?.layers[0].ty === 1 && lj.layers.some((x) => x.ty === 0 && x.refId === pre.id), `recursos: ${JSON.stringify(lj.assets.map((x) => x.id))}`);
    const star = lj.layers.find((x) => x.ty === 4 && x.shapes[0].it[0].ty === 'sr' && !x.td);
    assert(star.shapes[0].it.some((x) => x.ty === 'tm') && star.shapes[0].it.some((x) => x.ty === 'st'), 'estrella con recortar trazados y trazo');
    const txt = lj.layers.find((x) => x.ty === 5);
    assert(txt.t.d.k[0].s.t === 'Hola' && txt.t.d.k[0].s.fc.join() === '1,1,0' && lj.fonts.list.length === 1, `texto: ${JSON.stringify(txt.t.d.k[0].s)}`);
    assert(lr.warnings?.some((w) => /efectos/.test(w)), `avisos: ${JSON.stringify(lr.warnings)}`);
    for (const c of ['Lot', 'LotSub']) await call('comp_delete', { project: MP, comp: c });
  });

  await test('cola de render: varias salidas de un solo render, plantillas de nombre, ajustes de render y proxies', async () => {
    // a blue comp with a red square; one item, two output modules (MP4 at half size and WebM with alpha)
    await call('comp_new', { project: MP, name: 'RQ', width: 160, height: 90, fps: 10, duration: 1, bg: '#0000ff' });
    await call('layer_add', { project: MP, comp: 'RQ', type: 'solid', color: '#ff0000', width: 40, height: 40 });
    const rqAdd = await call('render_queue', { project: MP, action: 'add', comp: 'RQ', settings: { resolution: 0.5, span: [0, 0.5], fps: 20 },
      outputs: [{ format: 'mp4', path: 'rq/[compName]_[width]x[height].[fileExtension]' }, { format: 'webm-alpha', path: 'rq/[compName]_alfa', audio: false }] });
    assert(rqAdd.queue.length === 1 && rqAdd.queue[0].status === 'queued' && rqAdd.queue[0].outputs.length === 2, `cola: ${JSON.stringify(rqAdd.queue)}`);
    await call('render_queue', { project: MP, action: 'add', comp: 'RQ' });
    await call('render_queue', { project: MP, action: 'set', item: '2', status: 'unqueued' });
    const rqRun = await call('render_queue', { project: MP, action: 'render' });
    assert(rqRun.rendered.length === 1 && rqRun.rendered[0].status === 'done', `render: ${JSON.stringify(rqRun.rendered)}`);
    const rqMp4 = join(dirname(MP), 'rq', 'RQ_80x46.mp4'), rqWebm = join(dirname(MP), 'rq', 'RQ_alfa.webm');
    assert(rqRun.rendered[0].files.length === 2 && existsSync(rqMp4) && existsSync(rqWebm), `archivos: ${JSON.stringify(rqRun.rendered[0].files)}`);
    const rqInfo = probe(rqMp4).streams.find((x) => x.codec_type === 'video');
    assert(rqInfo.width === 80 && Math.abs(Number(rqInfo.nb_frames) - 10) <= 1 && /^20/.test(rqInfo.r_frame_rate), `ajustes de render: ${rqInfo.width} px, ${rqInfo.nb_frames} fotogramas a ${rqInfo.r_frame_rate}`);
    // the opaque output lays the alpha frames on the comp background; the WebM keeps the transparency
    const rqF = frameOf(rqMp4, 0.2);
    assert(rqF.at(0.05, 0.05)[2] > 200 && rqF.at(0.5, 0.5)[0] > 200, `MP4 sobre el fondo azul: ${rqF.at(0.05, 0.05)} / ${rqF.at(0.5, 0.5)}`);
    assert(probe(rqWebm).streams[0].codec_name === 'vp9', 'WebM VP9');
    const rqList = await call('render_queue', { project: MP, action: 'list' });
    assert(rqList.queue[0].status === 'done' && rqList.queue[0].log.files.length === 2 && rqList.queue[1].status === 'unqueued', `estados: ${rqList.queue.map((x) => x.status)}`);
    await call('render_queue', { project: MP, action: 'remove', items: ['done'] });
    assert((await call('render_queue', { project: MP, action: 'list' })).queue.length === 1, 'quitar los terminados');
    // footage proxy: blue.mp4 with red.mp4 as its proxy → previews (proxies on) show red, final renders blue
    const pxl = await call('layer_add', { project: MP, comp: 'RQ', type: 'video', media_path: W('blue.mp4'), name: 'Azul' });
    const pxMedia = (await call('media_list', { project: MP })).media.find((m) => m.path.endsWith('blue.mp4'));
    await call('proxy', { project: MP, action: 'set', media: pxMedia.id, path: W('red.mp4') });
    const pxOn = (await frame('RQ', 0.5, 160)).at(0.5, 0.5);
    await call('proxy', { project: MP, action: 'off', media: pxMedia.id });
    const pxOff = (await frame('RQ', 0.5, 160)).at(0.5, 0.5);
    assert(pxOn[0] > 200 && pxOn[2] < 50 && pxOff[2] > 200 && pxOff[0] < 50, `proxy de metraje: activo ${pxOn}, inactivo ${pxOff}`);
    await call('proxy', { project: MP, action: 'remove', media: pxMedia.id });
    const pxMade = await call('proxy', { project: MP, action: 'create', media: pxMedia.id, scale: 0.25 });
    assert(existsSync(pxMade.proxy.path) && pxMade.proxy.width === 160, `proxy creado: ${JSON.stringify(pxMade.proxy)}`);
    const pxBlue = (await frame('RQ', 0.5, 160)).at(0.9, 0.9);
    assert(pxBlue[2] > 200, `el proxy se dibuja al tamaño original (esquina): ${pxBlue}`);
    await call('layer_delete', { project: MP, comp: 'RQ', layers: [pxl.layer.id] });
    // comp proxy: a green comp pre-rendered; after turning it yellow, the parent still shows the (outdated) proxy
    await call('comp_new', { project: MP, name: 'PXsub', width: 160, height: 90, fps: 10, duration: 1 });
    const pxs = await call('layer_add', { project: MP, comp: 'PXsub', type: 'solid', color: '#00ff00', width: 160, height: 90 });
    const pxSubId = (await call('comp_get', { project: MP })).comps.find((c) => c.name === 'PXsub').id;
    await call('comp_new', { project: MP, name: 'PXtop', width: 160, height: 90, fps: 10, duration: 1, bg: '#000000' });
    await call('layer_add', { project: MP, comp: 'PXtop', type: 'comp', comp_id: pxSubId });
    const cpx = await call('proxy', { project: MP, action: 'create', comp: 'PXsub' });
    assert(existsSync(cpx.proxy.path) && /\.webm$/.test(cpx.proxy.path), `proxy de composición: ${JSON.stringify(cpx.proxy)}`);
    await call('layer_set', { project: MP, comp: 'PXsub', layer: pxs.layer.id, solid_color: '#ffff00' });
    const cpxOn = (await frame('PXtop', 0.5, 160)).at(0.5, 0.5);
    const cpxState = await call('proxy', { project: MP, action: 'off', comp: 'PXsub' });
    const cpxOff = (await frame('PXtop', 0.5, 160)).at(0.5, 0.5);
    assert(cpxOn[1] > 200 && cpxOn[0] < 60 && cpxOff[0] > 200 && cpxOff[1] > 200, `proxy de composición: activo ${cpxOn} (verde), inactivo ${cpxOff} (amarillo)`);
    assert(cpxState.outdated === true, `aviso de proxy desactualizado: ${JSON.stringify(cpxState)}`);
    for (const c of ['PXtop', 'PXsub', 'RQ']) await call('comp_delete', { project: MP, comp: c });
  });

  await test('caché de disco: llenar el área de trabajo, reutilizar, invalidar por cambios y archivos, y volver al deshacer', async () => {
    await call('comp_new', { project: MP, name: 'DC', width: 160, height: 90, fps: 10, duration: 1, bg: '#000000' });
    const dcBox = (await call('layer_add', { project: MP, comp: 'DC', type: 'solid', color: '#ff0000', width: 40, height: 40 })).layer.id;
    copyFileSync(W('logo.png'), W('dc-logo.png'));
    await call('layer_add', { project: MP, comp: 'DC', type: 'image', media_path: W('dc-logo.png') });
    await call('disk_cache', { project: MP, action: 'clear' });
    const st0 = await call('disk_cache', { project: MP, comp: 'DC', action: 'status' });
    assert(st0.frames === 10 && st0.cached === 0, `vacía: ${JSON.stringify(st0)}`);
    const f1 = await call('disk_cache', { project: MP, comp: 'DC', action: 'fill' });
    const f2 = await call('disk_cache', { project: MP, comp: 'DC', action: 'fill' });
    assert(f1.rendered === 10 && f2.rendered === 0 && f2.cached === 10, `llenar y reutilizar: ${JSON.stringify([f1, f2])}`);
    const info = await call('disk_cache', { project: MP, action: 'info' });
    const sub = readdirSync(info.dir).find((d) => !d.includes('.'));
    const png = decodePng(readFileSync(join(info.dir, sub, readdirSync(join(info.dir, sub))[0])));
    assert(info.frames === 10 && png.width === 80 && png.height === 45, `archivos: ${info.frames} PNG de ${png.width}×${png.height}`);
    // the green logo (200×80, on top) covers the middle; the top row is the black background
    const dcMid = png.at(0.5, 0.5), dcTop = png.at(0.5, 0);
    assert(dcMid[1] > 220 && dcMid[0] < 30 && dcTop[0] < 30 && dcTop[1] < 30, `píxeles del fotograma guardado: centro ${dcMid}, arriba ${dcTop}`);
    // a change makes new keys (nothing stale is reused); undo brings the cached frames back
    await call('prop_set', { project: MP, comp: 'DC', layer: dcBox, path: 'position', value: [30, 30] });
    assert((await call('disk_cache', { project: MP, comp: 'DC', action: 'status' })).cached === 0, 'un cambio invalida');
    await call('undo', { project: MP });
    assert((await call('disk_cache', { project: MP, comp: 'DC', action: 'status' })).cached === 10, 'al deshacer vuelven a servir');
    // a media file changed on disk is a different input
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(W('dc-logo.png'), readFileSync(W('tall.png')));
    assert((await call('disk_cache', { project: MP, comp: 'DC', action: 'status' })).cached === 0, 'un archivo cambiado invalida');
    await call('disk_cache', { project: MP, action: 'clear' });
    assert((await call('disk_cache', { project: MP, action: 'info' })).frames === 0, 'vaciar');
    await call('comp_delete', { project: MP, comp: 'DC' });
  });

  await test('interpolación inteligente de máscaras: cuadrado (4 vértices) a triángulo (3) con claves intermedias', async () => {
    await call('comp_new', { project: MP, name: 'MI', width: 200, height: 200, fps: 10, duration: 2, bg: '#000000' });
    const miL = (await call('layer_add', { project: MP, comp: 'MI', type: 'solid', color: '#ffffff', width: 200, height: 200 })).layer.id;
    await call('mask_add', { project: MP, comp: 'MI', layer: miL, shape: 'rect', x: 50, y: 50, width: 100, height: 100, name: 'M' });
    const poly = (pts) => pts.flatMap(([x, y]) => [x, y, 0, 0, 0, 0]);
    await call('prop_set', { project: MP, comp: 'MI', layer: miL, path: 'masks.M.path', keys: [{ t: 0, v: poly([[50, 50], [150, 50], [150, 150], [50, 150]]) }, { t: 1, v: poly([[100, 30], [170, 170], [30, 170]]) }] });
    const one = await callErr('mask_interpolate', { project: MP, comp: 'MI', layer: miL, mask: 'M', from: 0, to: 0.5 });
    assert(/al menos 2/.test(one), one);
    const mi = await call('mask_interpolate', { project: MP, comp: 'MI', layer: miL, mask: 'M' });
    assert(mi.pairs === 1 && mi.keys === 9, `claves añadidas: ${JSON.stringify(mi)}`);
    const miG = (await call('comp_get', { project: MP, comp: 'MI' })).comp.layers[0].animated;
    assert(/11 claves/.test(miG[Object.keys(miG).find((k) => k.endsWith('.path'))]), `claves del trazado: ${JSON.stringify(miG)}`);
    const at = async (t) => { const im = await frame('MI', t, 200); return (x, y) => im.at(x / 200, y / 200)[0]; };
    const f0 = await at(0), f1 = await at(1), fm = await at(0.5);
    assert(f0(60, 60) > 200 && f0(100, 25) < 40 && f0(160, 100) < 40, 'el primer fotograma es el cuadrado (clave original intacta)');
    assert(f1(100, 45) > 200 && f1(55, 55) < 40 && f1(160, 165) > 200, 'el último es el triángulo');
    // halfway: a convex in-between with no folds — the centre and the inner region filled, far corners empty
    assert(fm(100, 100) > 200 && fm(100, 60) > 200 && fm(40, 40) < 40 && fm(175, 40) < 40, `intermedio sin pliegues: ${[fm(100, 100), fm(100, 60), fm(40, 40), fm(175, 40)]}`);
    // linear vertex paths off (curved paths) and keyframe fields: twice as many in-betweens
    await call('undo', { project: MP });
    const mi2 = await call('mask_interpolate', { project: MP, comp: 'MI', layer: miL, mask: 'M', linear: false, fields: true, bending: 80, quality: 100 });
    assert(mi2.keys === 19, `campos (doble de claves): ${mi2.keys}`);
    assert((await at(0.5))(100, 100) > 200, 'trayectorias curvas: intermedio relleno');
    await call('comp_delete', { project: MP, comp: 'MI' });
  });

  await test('texto 3D por carácter: cada letra en su profundidad, tapada por píxel por otra capa 3D y con perspectiva', async () => {
    await call('comp_new', { project: MP, name: 'T3D', width: 300, height: 200, fps: 10, duration: 1, bg: '#000000' });
    await call('layer_add', { project: MP, comp: 'T3D', type: 'camera' });
    // a red 3D plane over the right half, at z = 0
    const t3p = (await call('layer_add', { project: MP, comp: 'T3D', type: 'solid', color: '#ff0000', width: 150, height: 200 })).layer.id;
    await call('layer_set', { project: MP, comp: 'T3D', layer: t3p, three_d: true });
    await call('prop_set', { project: MP, comp: 'T3D', layer: t3p, path: 'position', value: [225, 100, 0] });
    const t3t = (await call('layer_add', { project: MP, comp: 'T3D', type: 'text', text: 'HH', size: 90, color: '#ffffff' })).layer.id;
    await call('layer_set', { project: MP, comp: 'T3D', layer: t3t, text_style: { align: 'center', per_char_3d: true } });
    await call('prop_set', { project: MP, comp: 'T3D', layer: t3t, path: 'position', value: [150, 130, 0] });
    const t3get = (await call('comp_get', { project: MP, comp: 'T3D' })).comp.layers.find((l) => l.id === t3t);
    assert(t3get.threeD, 'activar 3D por carácter hace 3D la capa');
    // first H toward the camera, second H behind the plane
    const a1 = (await call('text_animator_add', { project: MP, comp: 'T3D', layer: t3t, props: { position: [0, 0, -200] }, selector: { start: 0, end: 50 } })).animator.id;
    await call('text_animator_add', { project: MP, comp: 'T3D', layer: t3t, props: { position: [0, 0, 100] }, selector: { start: 50, end: 100 } });
    const im = await frame('T3D', 0.5, 300);
    const row = (y) => Array.from({ length: 300 }, (_, x) => im.at(x / 300, y / 200));
    const white = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200, red = (p) => p[0] > 200 && p[1] < 60;
    const mid = row(100);
    const whiteRight = mid.slice(155).filter(white).length, redRight = mid.slice(155).filter(red).length, whiteLeft = mid.slice(0, 150).filter(white).length;
    assert(whiteLeft > 10 && whiteRight === 0 && redRight > 120, `la H del fondo queda tapada por el plano y la del frente se ve: blanco izq ${whiteLeft}, blanco der ${whiteRight}, rojo der ${redRight}`);
    // perspective: the front H is bigger than at z = 0
    const height = (img) => { let n = 0; for (let y = 0; y < 200; y++) if (Array.from({ length: 150 }, (_, x) => img.at(x / 300, y / 200)).some(white)) n++; return n; };
    const hFront = height(im);
    await call('prop_set', { project: MP, comp: 'T3D', layer: t3t, path: `text.animators.${a1}.props.position`, value: [0, 0, 0] });
    const hFlat = height(await frame('T3D', 0.5, 300));
    assert(hFront > hFlat * 1.15 && hFlat > 40, `perspectiva: alto ${hFront} px delante, ${hFlat} px en z = 0`);
    // X rotation of 90° puts the characters edge-on: nothing white left
    await call('prop_set', { project: MP, comp: 'T3D', layer: t3t, path: `text.animators.${a1}.props.rotationX`, value: 90 });
    const edge = await frame('T3D', 0.5, 300);
    assert(Array.from({ length: 150 }, (_, x) => edge.at(x / 300, 100 / 200)).filter(white).length === 0, 'rotación X de 90°: de canto');
    await call('comp_delete', { project: MP, comp: 'T3D' });
  });

  await test('OpenEXR: importar con canales, EXtractoR, IDentifier, Cryptomatte (con manifiesto y comodines) y secuencias', async () => {
    const { exr } = createRequire(import.meta.url)(join(root, 'dist', 'core', 'index.js'));
    // 80×40: beauty red | blue, depth.Z = x, objectId (uint) 1 | 2, CryptoObject: «bunny» | «teapot» with full coverage
    const EW = 80, EH = 40, F = () => new Float32Array(EW * EH);
    const R = F(), G = F(), B = F(), A = F(), Z = F(), cid = F(), cov = F(), zero = F(), oid = new Uint32Array(EW * EH);
    for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) {
      const i = y * EW + x, left = x < 40;
      R[i] = left ? 1 : 0; B[i] = left ? 0 : 1; A[i] = 1; Z[i] = x; oid[i] = left ? 1 : 2;
      cid[i] = exr.bitsToFloat(exr.cryptoIdBits(left ? 'bunny' : 'teapot')); cov[i] = 1;
    }
    const hex = (n) => exr.cryptoIdBits(n).toString(16).padStart(8, '0');
    const meta = { 'cryptomatte/abc1234/name': 'CryptoObject', 'cryptomatte/abc1234/hash': 'MurmurHash3_32', 'cryptomatte/abc1234/conversion': 'uint32_to_float32', 'cryptomatte/abc1234/manifest': JSON.stringify({ bunny: hex('bunny'), teapot: hex('teapot') }) };
    const chans = (z) => [{ name: 'R', type: 2, data: R }, { name: 'G', type: 2, data: G }, { name: 'B', type: 2, data: B }, { name: 'A', type: 2, data: A }, { name: 'depth.Z', type: 2, data: z }, { name: 'objectId', type: 0, data: oid },
      { name: 'CryptoObject00.R', type: 2, data: cid }, { name: 'CryptoObject00.G', type: 2, data: cov }, { name: 'CryptoObject00.B', type: 2, data: zero }, { name: 'CryptoObject00.A', type: 2, data: zero }];
    mkdirSync(W('exr'), { recursive: true });
    const still = W('exr/render.exr');
    writeFileSync(still, exr.writeExr(EW, EH, chans(Z), { compression: 3, strings: meta }));
    const info = await call('exr_info', { path: still });
    assert(info.width === 80 && info.compression === 'ZIP' && info.layers.depth?.[0] === 'depth.Z' && info.cryptomatte[0].names.join() === 'bunny,teapot', `exr_info: ${JSON.stringify(info)}`);
    const im = await call('exr_import', { project: MP, path: still });
    assert(im.media.kind === 'image' && im.media.width === 80 && im.exr.crypto[0].name === 'CryptoObject', `importado: ${JSON.stringify(im.media)}`);
    await call('comp_new', { project: MP, name: 'EXR', width: 80, height: 40, fps: 10, duration: 1, bg: '#000000' });
    const xl = (await call('layer_add', { project: MP, comp: 'EXR', type: 'image', media_id: im.media.id })).layer.id;
    const px = async (x) => (await frame('EXR', 0, 80)).at(x / 80, 0.5);
    const beauty = [await px(20), await px(60)];
    assert(beauty[0][0] > 200 && beauty[1][2] > 200, `beauty: ${beauty}`);
    // EXtractoR: depth to grey, white point 79
    const fxE = (await call('effect_add', { project: MP, comp: 'EXR', layer: xl, effect: 'extractor', values: { red: 'depth.Z', green: 'depth.Z', blue: 'depth.Z', alpha: '', whitePoint: 79 } })).effect.id;
    const g60 = await px(60.5);
    assert(Math.abs(g60[0] - (60 / 79) * 255) < 4 && g60[0] === g60[2], `EXtractoR profundidad: ${g60} (≈ ${Math.round((60 / 79) * 255)})`);
    await call('effect_remove', { project: MP, comp: 'EXR', layer: xl, effect: fxE });
    // IDentifier: luma matte of object 2
    const fxI = (await call('effect_add', { project: MP, comp: 'EXR', layer: xl, effect: 'identifier', values: { channel: 'objectId', display: 'luma', id: 2 } })).effect.id;
    const idL = await px(20), idR = await px(60);
    assert(idL[0] < 10 && idR[0] > 245, `IDentifier: ${idL} / ${idR}`);
    await call('effect_remove', { project: MP, comp: 'EXR', layer: xl, effect: fxI });
    // Cryptomatte: wildcard through the manifest, then a name and the matted beauty
    const fxC = (await call('effect_add', { project: MP, comp: 'EXR', layer: xl, effect: 'cryptomatte', values: { selection: 'tea*', output: 'matte' } })).effect.id;
    const cL = await px(20), cR = await px(60);
    assert(cL[0] < 10 && cR[0] > 245, `Cryptomatte «tea*»: ${cL} / ${cR}`);
    await call('effect_set', { project: MP, comp: 'EXR', layer: xl, effect: fxC, values: { selection: 'bunny', output: 'mattedRGBA' } });
    const mL = await px(20), mR = await px(60);
    assert(mL[0] > 200 && mR[2] < 30 && mR[0] < 30, `Cryptomatte «bunny» sobre la beauty: ${mL} / ${mR}`);
    // a sequence: depth.Z = 10 × frame, read frame by frame
    for (const f of [1, 2, 3]) writeFileSync(W(`exr/shot.000${f}.exr`), exr.writeExr(EW, EH, chans(F().fill(10 * f)), { compression: 3, strings: meta }));
    const sq = await call('exr_import', { project: MP, path: W('exr/shot.0002.exr'), fps: 10 });
    assert(sq.exr.pattern?.endsWith('shot.%04d.exr') && sq.exr.first === 1 && sq.exr.last === 3 && sq.media.kind === 'video', `secuencia: ${JSON.stringify(sq.exr)}`);
    await call('comp_new', { project: MP, name: 'EXRS', width: 80, height: 40, fps: 10, duration: 0.3, bg: '#000000' });
    const sl = (await call('layer_add', { project: MP, comp: 'EXRS', type: 'video', media_id: sq.media.id })).layer.id;
    await call('effect_add', { project: MP, comp: 'EXRS', layer: sl, effect: 'extractor', values: { red: 'depth.Z', green: 'depth.Z', blue: 'depth.Z', alpha: '', whitePoint: 30 } });
    const g1 = (await frame('EXRS', 0, 80)).at(0.5, 0.5)[0], g3 = (await frame('EXRS', 0.2, 80)).at(0.5, 0.5)[0];
    assert(Math.abs(g1 - 85) < 4 && g3 > 250, `fotograma de la secuencia: ${g1} (≈ 85) y ${g3} (≈ 255)`);
    for (const c of ['EXR', 'EXRS']) await call('comp_delete', { project: MP, comp: c });
  });

  await test('generadores sobre máscaras: Trazo, Escritura, Garabato, Ondas de radio, Haz, Vegas y Relleno', async () => {
    // a 320×180 dark solid with a rectangular mask set to None (40,40 → 280,140), traced from the top-left corner
    const gen = async (name, fx, values, o = {}) => {
      await call('comp_new', { project: MP, name, width: 320, height: 180, fps: 25, duration: 2, bg: '#000000' });
      const l = (await call('layer_add', { project: MP, comp: name, type: 'solid', color: '#000000', width: 320, height: 180 })).layer.id;
      if (o.mask !== false) await call('mask_add', { project: MP, comp: name, layer: l, shape: 'path', path: [40, 40, 280, 40, 280, 140, 40, 140], mode: 'none', name: 'R' });
      const f = (await call('effect_add', { project: MP, comp: name, layer: l, effect: fx, values })).effect.id;
      for (const [k, keys] of Object.entries(o.keys ?? {})) await call('prop_set', { project: MP, comp: name, layer: l, path: `effects.${f}.${k}`, keys });
      return async (t, x, y) => (await frame(name, t, 320)).at(x / 320, y / 180);
    };
    const lit = (p) => p[0] + p[1] + p[2] > 200;
    // Stroke: 30 % of the 680 px outline = the top edge up to x ≈ 244
    const st = await gen('G1', 'stroke', { brushSize: 6, color: '#ffffff', end: 30 });
    assert(lit(await st(0, 100, 40)) && !lit(await st(0, 270, 40)) && !lit(await st(0, 280, 100)), 'Trazo: solo el primer 30 % del contorno');
    // Write-on: the brush went from x 40 to 280 in 1 s: at 0.5 s it has painted up to x 160
    const wo = await gen('G2', 'writeOn', { brushSize: 8, color: '#ffffff' }, { mask: false, keys: { position: [{ t: 0, v: [40, 90] }, { t: 1, v: [280, 90] }] } });
    assert(lit(await wo(0.5, 100, 90)) && !lit(await wo(0.5, 220, 90)), 'Escritura: lo pintado hasta ahora');
    // Scribble: hatching inside the mask only
    const sc = await gen('G3', 'scribble', { color: '#ffffff', strokeWidth: 4, spacing: 6 });
    const scIm = await frame('G3', 0, 320);
    let inside = 0, outside = 0;
    for (let y = 0; y < 180; y += 3) for (let x = 0; x < 320; x += 3) { const v = lit(scIm.at(x / 320, y / 180)); if (x > 44 && x < 276 && y > 44 && y < 136) inside += v; else if (x < 34 || x > 286 || y < 34 || y > 146) outside += v; }
    assert(inside > 300 && outside === 0, `Garabato: ${inside} píxeles dentro, ${outside} fuera`);
    void sc;
    // Radio Waves: the wave born at 0 s, 5 px per frame at 25 fps, is a ring of radius 125 at 1 s
    const rw = await gen('G4', 'radioWaves', { frequency: 1, expansion: 5, startWidth: 6, endWidth: 6, color: '#ffffff' }, { mask: false });
    assert(lit(await rw(1, 160 + 125, 90)) && !lit(await rw(1, 160 + 60, 90)) && !lit(await rw(1, 160, 90)), 'Ondas de radio: el anillo en su radio');
    // Beam: from 10 % to 90 % of the width, the part [25 %, 50 %] of the way → x 96…160
    const bm = await gen('G5', 'beam', { length: 25, time: 50 }, { mask: false });
    assert(lit(await bm(0, 128, 90)) && !lit(await bm(0, 220, 90)) && !lit(await bm(0, 60, 90)), 'Haz: el tramo de la longitud que acaba en el tiempo');
    // Vegas: dashes along the mask, nothing in the middle
    const vgIm = await (async () => { await gen('G6', 'vegas', { source: 'mask', segments: 8, length: 0.5, width: 4, color: '#ffffff' }); return frame('G6', 0, 320); })();
    let edge = 0; for (let x = 40; x <= 280; x += 2) edge += lit(vgIm.at(x / 320, 40 / 180));
    assert(edge > 20 && edge < 115 && !lit(vgIm.at(0.5, 0.5)), `Vegas: trozos a lo largo del borde (${edge} de 121)`);
    // Fill: the mask filled with the colour, the rest of the layer untouched
    const fl = await gen('G7', 'fill', { color: '#ff0000' });
    const fIn = await fl(0, 160, 90), fOut = await fl(0, 10, 10);
    assert(fIn[0] > 240 && fIn[1] < 20 && fOut[0] < 20, `Relleno: ${fIn} dentro, ${fOut} fuera`);
    for (let i = 1; i <= 7; i++) await call('comp_delete', { project: MP, comp: `G${i}` });
  });

  await test('deformaciones: coordenadas polares, esferizar, Bézier, malla, licuar, CC Bend It y CC Power Pin', async () => {
    // a 200×200 layer with a black → white horizontal ramp in a 200×200 comp
    const dist = async (name, fx, values) => {
      await call('comp_new', { project: MP, name, width: 200, height: 200, fps: 10, duration: 1, bg: '#ff0000' });
      const l = (await call('layer_add', { project: MP, comp: name, type: 'solid', color: '#000000', width: 200, height: 200 })).layer.id;
      await call('effect_add', { project: MP, comp: name, layer: l, effect: 'gradientRamp', values: { start: [0, 100], end: [200, 100], startColor: '#000000', endColor: '#ffffff' } });
      if (fx) await call('effect_add', { project: MP, comp: name, layer: l, effect: fx, values });
      const im = await frame(name, 0, 200);
      return (x, y) => im.at(x / 200, y / 200);
    };
    const base = await dist('D0', null, {});
    const g = (p) => p[1];
    // polar: the corners fall outside the circle (comp red shows), the centre column is kept
    const po = await dist('D1', 'polar', { interpolation: 100, conversion: 'rectToPolar' });
    assert(po(3, 3)[0] > 200 && po(3, 3)[1] < 40, `Coordenadas polares: esquina vacía ${po(3, 3)}`);
    // spherize: inside the radius a pixel shows what was nearer the centre (closer to mid grey)
    const sp = await dist('D2', 'spherize', { radius: 90 });
    assert(Math.abs(g(sp(150, 100)) - 128) < Math.abs(g(base(150, 100)) - 128) - 10, `Esferizar: ${g(sp(150, 100))} más cerca del gris medio que ${g(base(150, 100))}`);
    // Bezier: the right-top vertex pulled in leaves the top-right corner empty
    const bz = await dist('D3', 'bezierWarp', { rtv: [120, 60] });
    assert(bz(195, 5)[0] > 200 && bz(195, 5)[1] < 40, `Deformación Bézier: esquina vacía ${bz(195, 5)}`);
    // mesh: the centre vertex moved 40 px right carries darker pixels there
    const me = await dist('D4', 'meshWarp', { rows: 2, columns: 2, mesh: JSON.stringify([[0, 0], [0, 0], [0, 0], [0, 0], [40, 0], [0, 0], [0, 0], [0, 0], [0, 0]]) });
    assert(g(me(120, 100)) < g(base(120, 100)) - 20, `Deformación de malla: ${g(me(120, 100))} < ${g(base(120, 100))}`);
    // liquify: a warp stroke dragging right from the centre does the same
    const lq = await dist('D5', 'liquify', { strokes: JSON.stringify([{ tool: 'warp', x: 100, y: 100, x2: 140, y2: 100, size: 120, pressure: 100 }]) });
    assert(g(lq(100, 100)) < g(base(100, 100)) - 20, `Licuar: ${g(lq(100, 100))} < ${g(base(100, 100))}`);
    const lq0 = await dist('D6', 'liquify', { strokes: JSON.stringify([{ tool: 'warp', x: 100, y: 100, x2: 140, y2: 100, size: 120, pressure: 100 }]), distortion: 0 });
    assert(Math.abs(g(lq0(100, 100)) - g(base(100, 100))) < 3, 'Licuar: distorsión 0 % deja la imagen igual');
    // CC Bend It: 0 leaves it, a bend moves the top part sideways
    const b0 = await dist('D7', 'bendIt', { bend: 0 }), b1 = await dist('D8', 'bendIt', { bend: 90 });
    assert(Math.abs(g(b0(100, 20)) - g(base(100, 20))) < 3 && Math.abs(g(b1(100, 20)) - g(base(100, 20))) > 20, `CC Bend It: ${g(b1(100, 20))} frente a ${g(base(100, 20))}`);
    // CC Power Pin: pins inside the layer leave the corners empty; perspective 0 and 100 differ inside
    const pin = { tl: [40, 20], tr: [180, 50], br: [170, 180], bl: [20, 190] };
    const pp = await dist('D9', 'powerPin', { ...pin, perspective: 100 }), pq = await dist('D10', 'powerPin', { ...pin, perspective: 0 });
    assert(pp(5, 5)[0] > 200 && pp(5, 5)[1] < 40 && Math.abs(g(pp(100, 100)) - g(pq(100, 100))) > 3, `CC Power Pin: ${g(pp(100, 100))} con perspectiva, ${g(pq(100, 100))} sin ella`);
    for (let i = 0; i <= 10; i++) await call('comp_delete', { project: MP, comp: `D${i}` });
  });

  await test('simulaciones: Estallido, Card Dance, Cáusticas, Mundo de olas, Espuma y CC Particle World', async () => {
    const sim = async (name, fx, values, color = '#3060a0') => {
      await call('comp_new', { project: MP, name, width: 200, height: 120, fps: 25, duration: 3, bg: '#ff0000' });
      const l = (await call('layer_add', { project: MP, comp: name, type: 'solid', color, width: 200, height: 120 })).layer.id;
      await call('effect_add', { project: MP, comp: name, layer: l, effect: fx, values });
      // one render per instant, read as often as needed
      const shots = new Map();
      return async (t, x, y) => { if (!shots.has(t)) shots.set(t, await frame(name, t, 200)); return shots.get(t).at(x / 200, y / 120); };
    };
    const red = (p) => p[0] > 200 && p[1] < 40 && p[2] < 40;
    // Shatter: whole at 0 s; a second later the pieces round the force have flown (the comp shows through)
    const sh = await sim('S1', 'shatter', { view: 'rendered' });
    assert(!red(await sh(0, 100, 60)) && red(await sh(1, 100, 60)), 'Estallido: intacta al principio, rota después');
    // Card Dance: identity by default; every card turned half round (no back layer) leaves nothing
    const cd0 = await sim('S2', 'cardDance', {}), cd1 = await sim('S3', 'cardDance', { yRotOff: 180 });
    assert(!red(await cd0(0, 100, 60)) && red(await cd1(0, 100, 60)), 'Card Dance: tarjetas de espaldas sin capa posterior');
    // Caustics: lit by the light (ambient + diffuse), so the flat bottom changes
    const ca = await sim('S4', 'caustics', { surfaceOpacity: 0, lightType: 'point', lightPosition: [50, 30] }, '#808080');
    // the light (at 25 %, 25 %) falls on the flat bottom unevenly: brighter near it than far from it
    const caNear = await ca(0, 50, 30), caFar = await ca(0, 195, 115);
    assert(caNear[0] - caFar[0] > 10, `Cáusticas: iluminación ${caNear} cerca de la luz, ${caFar} lejos`);
    // Wave World: flat grey at rest, ripples after a second
    const ww = await sim('S5', 'waveWorld', { view: 'height' });
    const w0 = await ww(0, 30, 30);
    let spread = 0; for (const [x, y] of [[100, 60], [80, 60], [60, 60], [100, 30], [40, 90]]) spread = Math.max(spread, Math.abs((await ww(1, x, y))[0] - 128));
    assert(Math.abs(w0[0] - 128) < 3 && spread > 20, `Mundo de olas: gris en reposo (${w0[0]}), ondas después (±${spread})`);
    // Foam and CC Particle World: nothing at the start, bubbles / particles near the producer later
    const fo = await sim('S6', 'foam', { view: 'rendered', rate: 3, size: 1 }, '#000000');
    const pw = await sim('S7', 'particleWorld', { birthRate: 3, particleType: 'faded' }, '#000000');
    const lit = async (fn, t) => { let n = 0; for (let x = 60; x <= 140; x += 4) for (let y = 30; y <= 90; y += 4) { const q = await fn(t, x, y); n += q[0] + q[1] + q[2] > 120 ? 1 : 0; } return n; };
    const fo1 = await lit(fo, 1), pw1 = await lit(pw, 0.5);
    assert(fo1 > 3 && pw1 > 3, `Espuma ${fo1} y partículas ${pw1} píxeles encendidos`);
    for (let i = 1; i <= 7; i++) await call('comp_delete', { project: MP, comp: `S${i}` });
  });

  await test('color: curvas de tono de Lumetri, Ecualizar, Niveles / Contraste / Color automáticos y Conservar color', async () => {
    // a dull ramp (#404858 → #8090a0) left to right, 200×100
    const col = async (name, fx, values, o = {}) => {
      await call('comp_new', { project: MP, name, width: 200, height: 100, fps: 10, duration: 1, bg: '#000000' });
      const l = (await call('layer_add', { project: MP, comp: name, type: 'solid', color: o.solid ?? '#000000', width: 200, height: 100 })).layer.id;
      if (!o.solid) await call('effect_add', { project: MP, comp: name, layer: l, effect: 'gradientRamp', values: { start: [0, 50], end: [200, 50], startColor: '#404858', endColor: '#8090a0' } });
      if (o.halves) { await call('effect_add', { project: MP, comp: name, layer: l, effect: 'gradientRamp', values: { start: [99, 50], end: [101, 50], startColor: '#ff2020', endColor: '#20c020' } }); }
      await call('effect_add', { project: MP, comp: name, layer: l, effect: fx, values });
      const im = await frame(name, 0, 200);
      return (x) => im.at(x / 200, 0.5);
    };
    // Equalize (Photoshop style by default: one table for the three channels, so their differences stay): the
    // dull ramp now runs from dark to bright; per channel (RGB) every channel reaches black and white
    const lum = (q) => q[0] * 0.299 + q[1] * 0.587 + q[2] * 0.114;
    const eq = await col('C1', 'equalize', {});
    assert(lum(eq(2)) < 40 && lum(eq(198)) > 200 && eq(198)[2] > eq(198)[0] + 20, `Ecualizar (estilo Photoshop): ${eq(2)} … ${eq(198)}`);
    const eqr = await col('C6', 'equalize', { mode: 'rgb' });
    assert(eqr(2).every((v) => v < 30) && eqr(198).every((v) => v > 225), `Ecualizar (RGB): ${eqr(2)} … ${eqr(198)}`);
    // Auto Levels: each channel stretched on its own (the blue cast goes: the bright end turns white)
    const al = await col('C2', 'autoLevels', {});
    assert(al(2).every((v) => v < 20) && al(198).every((v) => v > 235), `Niveles automáticos: ${al(2)} … ${al(198)}`);
    // Auto Contrast: stretched together, so the bright end keeps its blue cast
    const ac = await col('C3', 'autoContrast', {});
    assert(ac(198)[2] > 240 && ac(198)[0] < ac(198)[2] - 20 && ac(2)[0] < 15, `Contraste automático: ${ac(2)} … ${ac(198)}`);
    // Lumetri: Hue vs Saturation pulled down everywhere makes a red layer grey
    const lu = await col('C4', 'lumetri', { hueSat: '0,0 1,0' }, { solid: '#e03030' });
    const lp = lu(100);
    assert(Math.max(...lp.slice(0, 3)) - Math.min(...lp.slice(0, 3)) < 6, `Lumetri tono frente a saturación: ${lp}`);
    // Leave Color: red stays, green loses its colour
    const lc = await col('C5', 'leaveColor', { amount: 100, color: '#ff2020', tolerance: 20 }, { solid: '#000000', halves: true });
    const lr = lc(40), lg = lc(160);
    assert(lr[0] > 200 && lr[1] < 60 && Math.abs(lg[0] - lg[1]) < 6 && Math.abs(lg[1] - lg[2]) < 6, `Conservar color: ${lr} rojo, ${lg} gris`);
    for (let i = 1; i <= 6; i++) await call('comp_delete', { project: MP, comp: `C${i}` });
  });

  await test('tiempo: CC Wide Time, CC Time Blend, Desplazamiento de tiempo, desenfoque de Timewarp y Eco en vídeo', async () => {
    // moving.mp4: a white 16 px square moving 8 px per frame at 10 fps; everything is measured from where the plain
    // layer shows it at 0.5 s (X0 = its left edge), one frame = 8 px
    const tm = async (name, fx, values, o = {}) => {
      await call('comp_new', { project: MP, name, width: 160, height: 64, fps: 10, duration: 2, bg: '#000000' });
      let mapId;
      if (o.map) { mapId = (await call('layer_add', { project: MP, comp: name, type: 'solid', color: o.map, width: 160, height: 64, name: 'Mapa' })).layer.id; await call('layer_set', { project: MP, comp: name, layer: mapId, hidden: true }); }
      const v = (await call('layer_add', { project: MP, comp: name, type: 'video', media_path: W('moving.mp4') })).layer.id;
      if (fx) await call('effect_add', { project: MP, comp: name, layer: v, effect: fx, values: mapId ? { ...values, map: mapId } : values });
      const im = await frame(name, 0.5, 160);
      return (x) => (x < 0 || x > 159 ? 0 : im.at((x + 0.5) / 160, 0.5)[0]);
    };
    const plain = await tm('T0', null, {});
    let X0 = 0; while (X0 < 159 && plain(X0) < 128) X0++;
    assert(X0 > 20 && X0 < 120, `cuadrado en x ${X0}`);
    // CC Wide Time 1 back, 1 forward: three frames averaged — X0−5 is only in the previous one (a third)
    const wt = await tm('T1', 'wideTime', { forward: 1, backward: 1 });
    assert(wt(X0 - 5) > 55 && wt(X0 - 5) < 115 && wt(X0 + 4) > 150 && wt(X0 + 40) < 15, `CC Wide Time: ${wt(X0 - 5)} / ${wt(X0 + 4)} / ${wt(X0 + 40)}`);
    // CC Time Blend: a fading trail behind the square
    const tb = await tm('T2', 'timeBlend', { accumulation: 0.5 });
    assert(tb(X0 - 20) > 3 && tb(X0 - 20) < tb(X0 + 8) && tb(X0 + 40) < 10, `CC Time Blend: estela ${tb(X0 - 20)} < ${tb(X0 + 8)}`);
    // Time Displacement: a white map takes every pixel 1 s later (10 frames = 80 px further)
    const td = await tm('T3', 'timeDisplacement', { maxTime: 1 }, { map: '#ffffff' });
    assert(td(X0 + 88) > 200 && td(X0 + 8) < 30, `Desplazamiento de tiempo: ${td(X0 + 88)} / ${td(X0 + 8)}`);
    // Timewarp motion blur: at 100 % with a 360° shutter the square is smeared over one frame: soft edges
    const tw0 = await tm('T4', 'timewarp', { speed: 100, method: 'whole' }), tw1 = await tm('T5', 'timewarp', { speed: 100, method: 'whole', motionBlur: true, shutterAngle: 360, shutterSamples: 8 });
    const xs = [-6, -4, -2, 0, 2, 4, 6].map((d) => X0 + d);
    const soft = xs.map(tw1).filter((v) => v > 30 && v < 225).length, hard = xs.map(tw0).filter((v) => v > 30 && v < 225).length;
    assert(soft >= 2 && soft > hard, `Timewarp con desenfoque: ${soft} píxeles intermedios (sin él ${hard})`);
    // Echo on a video: the copy 0.1 s earlier is its own frame (8 px back), not the current one again (Add, since the
    // opaque video would hide copies composited behind it)
    const ec = await tm('T6', 'echo', { time: -0.1, count: 1, start: 1, decay: 1, op: 'add' });
    assert(ec(X0 - 5) > 150, `Eco en vídeo: fotograma anterior = ${ec(X0 - 5)}`);
    for (let i = 0; i <= 6; i++) await call('comp_delete', { project: MP, comp: `T${i}` });
  });

  await test('rastreo plano (perspectiva): la máscara sigue la superficie y la esquina fija la reemplaza', async () => {
    const core = createRequire(import.meta.url)(join(root, 'dist', 'core', 'index.js'));
    // a textured picture whose corners move to known places (ffmpeg perspective, sense=destination): at t s the
    // source corners (0,0) (640,0) (0,360) (640,360) are at the positions below
    const C = (t) => [[0 + 40 * t, 0 + 20 * t], [640 - 30 * t, 0 + 35 * t], [0 + 10 * t, 360 - 25 * t], [640 - 50 * t, 360 - 10 * t]];
    // (the filter knows the frame number «in»: t = in / 10)
    const vf = `scale=640:360,perspective=x0='4*in':y0='2*in':x1='640-3*in':y1='3.5*in':x2='1*in':y2='360-2.5*in':x3='640-5*in':y3='360-1*in':sense=destination:eval=frame`;
    ff('-loop', '1', '-framerate', '10', '-t', '1.2', '-i', W('still.png'), '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', W('plane.mp4'));
    await call('comp_new', { project: MP, name: 'PT', width: 640, height: 360, fps: 10, duration: 1.2, bg: '#000000' });
    const pv = (await call('layer_add', { project: MP, comp: 'PT', type: 'video', media_path: W('plane.mp4') })).layer.id;
    const rect = [[160, 90], [480, 90], [480, 270], [160, 270]];
    await call('mask_add', { project: MP, comp: 'PT', layer: pv, shape: 'path', path: rect.flat(), mode: 'none', name: 'Plano' });
    const r = await call('mask_track', { project: MP, comp: 'PT', layer: pv, mask: 'Plano', at: 0, to: 1, method: 'perspective' });
    assert(r.frames === 11 && r.points >= 10, `rastreo: ${JSON.stringify(r)}`);
    // the truth at 1 s: the homography from the source corners to C(1)
    const src = [[0, 0], [640, 0], [0, 360], [640, 360]], Ht = core.fitHomography(src, C(1));
    const pj = JSON.parse(readFileSync(MP, 'utf8')), mk = pj.comps.find((c) => c.name === 'PT').layers.find((l) => l.id === pv).masks[0].path.k;
    const at1 = mk.find((k) => Math.abs(k.t - 1) < 1e-6).v;
    const err = rect.map(([x, y], j) => { const [u, v] = core.applyH(Ht, x, y); return Math.hypot(at1[j * 6] - u, at1[j * 6 + 1] - v); });
    assert(Math.max(...err) < 3, `vértices a 1 s frente a la verdad: error ${err.map((x) => x.toFixed(2))} px`);
    // the same surface onto another layer as a corner pin
    const tl = (await call('layer_add', { project: MP, comp: 'PT', type: 'solid', color: '#ff0000', width: 640, height: 360, name: 'Pantalla' })).layer.id;
    await call('mask_track', { project: MP, comp: 'PT', layer: pv, mask: 'Plano', at: 0, to: 1, method: 'perspective', target: tl });
    const pj2 = JSON.parse(readFileSync(MP, 'utf8')), tgt = pj2.comps.find((c) => c.name === 'PT').layers.find((l) => l.id === tl);
    const cp = tgt.effects.find((f) => f.fx === 'cornerPin');
    const tl1 = cp.params.tl.k.find((k) => Math.abs(k.t - 1) < 1e-6).v, want = core.applyH(Ht, 160, 90);
    assert(Math.hypot(tl1[0] - want[0], tl1[1] - want[1]) < 3, `esquina fija superior izquierda a 1 s: ${tl1} frente a ${want.map((x) => x.toFixed(1))}`);
    await call('comp_delete', { project: MP, comp: 'PT' });
  });

  await test('color del proyecto: fundir con gamma 1.0 y 32 bits por canal conservan la luz', async () => {
    await call('comp_new', { project: MP, name: 'Lin', width: 200, height: 100, fps: 10, duration: 1, bg: '#000000' });
    const red = (await call('layer_add', { project: MP, comp: 'Lin', type: 'solid', color: '#ff0000' })).layer.id;
    const green = (await call('layer_add', { project: MP, comp: 'Lin', type: 'solid', color: '#00ff00' })).layer.id;
    await call('prop_set', { project: MP, comp: 'Lin', layer: green, path: 'opacity', value: 50 });
    // 50 % green over red: gamma-encoded values average to 128; in linear light half the light of each is 188
    let px = (await frame('Lin', 0.5, 200)).at(0.5, 0.5);
    assert(Math.abs(px[0] - 128) <= 3 && Math.abs(px[1] - 128) <= 3, `mezcla en gamma 2.2 (${px})`);
    await call('color_settings', { project: MP, linear_blend: true });
    px = (await frame('Lin', 0.5, 200)).at(0.5, 0.5);
    assert(Math.abs(px[0] - 188) <= 3 && Math.abs(px[1] - 188) <= 3 && px[2] < 5, `mezcla en luz lineal (${px})`);
    // 32 bpc: 0.6 + 0.6 added and then multiplied by 0.5 keeps 0.6; at 8 bpc the sum clips at 1 first (→ 0.5)
    await call('color_settings', { project: MP, linear_blend: false, depth: 8 });
    await call('layer_set', { project: MP, comp: 'Lin', layer: red, solid_color: '#999999' });
    await call('layer_set', { project: MP, comp: 'Lin', layer: green, solid_color: '#999999', blend: 'add' });
    await call('prop_set', { project: MP, comp: 'Lin', layer: green, path: 'opacity', value: 100 });
    const half = (await call('layer_add', { project: MP, comp: 'Lin', type: 'solid', color: '#808080' })).layer.id;
    await call('layer_set', { project: MP, comp: 'Lin', layer: half, blend: 'multiply' });
    px = (await frame('Lin', 0.5, 200)).at(0.5, 0.5);
    assert(Math.abs(px[0] - 128) <= 3, `8 bpc recorta la suma (${px})`);
    const r32 = await call('color_settings', { project: MP, depth: 32 });
    assert(r32.color.depth === 32 && r32.color.blendGamma1 === false, `ajustes devueltos (${JSON.stringify(r32.color)})`);
    px = (await frame('Lin', 0.5, 200)).at(0.5, 0.5);
    assert(Math.abs(px[0] - 154) <= 3, `32 bpc conserva el exceso (${px})`);
    // the float path blends like the canvas when nothing needs it: screen at 16 bpc matches 8 bpc
    await call('layer_set', { project: MP, comp: 'Lin', layer: half, blend: 'screen' });
    await call('color_settings', { project: MP, depth: 16 });
    const p16 = (await frame('Lin', 0.5, 200)).at(0.5, 0.5);
    await call('color_settings', { project: MP, depth: 8 });
    const p8 = (await frame('Lin', 0.5, 200)).at(0.5, 0.5);
    assert(Math.abs(p16[0] - p8[0]) <= 2, `trama igual en 16 y 8 bpc (${p16} / ${p8})`);
    const pj = JSON.parse(readFileSync(MP, 'utf8'));
    assert(pj.motionColor === undefined, 'los ajustes por defecto no se guardan');
    await call('comp_delete', { project: MP, comp: 'Lin' });
  });

  await test('vídeo en una composición: cada instante muestra su fotograma exacto (también hacia atrás y a mitad de GOP)', async () => {
    // the grey level of each frame is its index × 4; one keyframe, so every seek lands mid-GOP
    ff('-f', 'lavfi', '-i', 'color=black:s=160x90:r=30:d=2', '-vf', "format=rgb24,geq=r='N*4':g='N*4':b='N*4'", '-c:v', 'libx264', '-crf', '0', '-g', '60', '-pix_fmt', 'yuv420p', W('frames.mp4'));
    const SP = W('seek.cinta');
    await call('project_new', { path: SP });
    await call('comp_new', { project: SP, name: 'Seek', width: 160, height: 90, fps: 30, duration: 2, bg: '#ff0000' });
    await call('layer_add', { project: SP, comp: 'Seek', type: 'video', media_path: W('frames.mp4') });
    const got = [];
    for (const t of [0.5, 0.2, 1.0, 1.5, 0.5, 0.0333, 1.9]) {
      const img = imgOf(await call('comp_frame', { project: SP, comp: 'Seek', time: t, width: 160 }));
      got.push([t, Math.round(img.at(0.5, 0.5)[1] / 4), Math.round(t * 30)]);
    }
    assert(got.every(([, a, b]) => a === b), `fotograma mostrado vs. esperado: ${JSON.stringify(got)}`);
    // export: frame n of the render is frame n of the source
    await call('comp_render', { project: SP, comp: 'Seek', output: W('seek-out.mov'), format: 'mov', quality: 'high' });
    const raw = execFileSync(FF, ['-v', 'error', '-i', W('seek-out.mov'), '-vf', 'format=gray,crop=1:1:80:45', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 20 });
    const bad = [...raw].map((v, i) => [i, Math.round(v / 4)]).filter(([i, f]) => i !== f);
    assert(raw.length === 60 && !bad.length, `exportado (${raw.length} fotogramas), distintos: ${JSON.stringify(bad.slice(0, 10))}`);
    // the trackers read the same frames at their own rate (30 → 10 and 30 → 12 fps from 0.5 s)
    const { grayFrames } = createRequire(import.meta.url)(join(root, 'dist', 'core', 'index.js'));
    for (const [fps, want] of [[10, [15, 18, 21, 24]], [12, [15, 17, 20, 22, 25, 27]]]) {
      const fr = (await grayFrames(W('frames.mp4'), 0.5, want.length, fps, 160, 90)).map((d) => Math.round(d[45 * 160 + 80] / 4));
      assert(JSON.stringify(fr) === JSON.stringify(want), `rastreador a ${fps} fps: ${fr} (esperado ${want})`);
    }
  });

  await test('rastreador de cámara 3D: resuelve la cámara de una escena 3D renderizada por Cinta', async () => {
    // the scene: three textured planes at different depths, filmed by a camera that travels and pans
    // a wide lens and planes from near to far: enough perspective to tell travel from panning
    const Z = 560;
    // texture with detail coarse enough to survive being drawn small (fine noise would alias as planes change size)
    ff('-f', 'lavfi', '-i', 'color=gray:s=80x45,noise=alls=100:all_seed=11', '-frames:v', '1', '-vf', 'scale=1280:720:flags=bicubic', W('ct-tex.png'));
    await call('comp_new', { project: MP, name: 'CT3D', width: 640, height: 360, fps: 10, duration: 2, bg: '#000000' });
    const plane = async (x, y, z, s) => { const id = (await call('layer_add', { project: MP, comp: 'CT3D', type: 'image', media_path: W('ct-tex.png') })).layer.id; await call('layer_set', { project: MP, comp: 'CT3D', layer: id, three_d: true }); await call('prop_set', { project: MP, comp: 'CT3D', layer: id, path: 'position', value: [x, y, z] }); await call('prop_set', { project: MP, comp: 'CT3D', layer: id, path: 'scale', value: [s, s, 100] }); };
    await plane(320, 180, 500, 110); await plane(380, 250, 250, 35); await plane(230, 120, 100, 25); await plane(420, 130, -100, 18); await plane(250, 220, -300, 10);
    const cam = (await call('layer_add', { project: MP, comp: 'CT3D', type: 'camera' })).layer.id;
    await call('prop_set', { project: MP, comp: 'CT3D', layer: cam, path: 'camera.zoom', value: Z });
    const eye0 = [320, 180, -Z], eye1 = [440, 170, -Z + 100], poi0 = [320, 180, 0], poi1 = [350, 180, 0];
    await call('prop_set', { project: MP, comp: 'CT3D', layer: cam, path: 'position', keys: [{ t: 0, v: eye0 }, { t: 1.9, v: eye1 }] });
    await call('prop_set', { project: MP, comp: 'CT3D', layer: cam, path: 'camera.poi', keys: [{ t: 0, v: poi0 }, { t: 1.9, v: poi1 }] });
    await call('comp_render', { project: MP, comp: 'CT3D', output: W('ct3d.mp4'), quality: 'high' });
    // solve it from the video
    await call('comp_new', { project: MP, name: 'CTsolve', width: 640, height: 360, fps: 10, duration: 2, bg: '#000000' });
    const vid = (await call('layer_add', { project: MP, comp: 'CTsolve', type: 'video', media_path: W('ct3d.mp4') })).layer.id;
    const r = await call('camera_track', { project: MP, comp: 'CTsolve', layer: vid, to: 1.9, nulls: 4 });
    assert(r.error < 1.5 && r.points > 30 && r.nulls.length === 4, `solución: ${JSON.stringify(r)}`);
    const pj = JSON.parse(readFileSync(MP, 'utf8')), sc = pj.comps.find((c) => c.name === 'CTsolve').layers.find((l) => l.id === r.camera);
    const last = (pr) => pr.k.reduce((a, b) => (b.t > a.t ? b : a)).v;
    const eS = last(sc.transform.position), pS = last(sc.camera.poi);
    const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); }, angle = (a, b) => (Math.acos(Math.max(-1, Math.min(1, unit(a).reduce((s, v, i) => s + v * unit(b)[i], 0)))) * 180) / Math.PI;
    const fwdErr = angle(pS.map((v, i) => v - eS[i]), poi1.map((v, i) => v - eye1[i]));
    const moveErr = angle(eS.map((v, i) => v - eye0[i]), eye1.map((v, i) => v - eye0[i]));
    assert(Math.abs(r.zoom - Z) / Z < 0.15, `ángulo de visión estimado: zoom ${r.zoom} frente a ${Z}`);
    assert(fwdErr < 1.5 && moveErr < 8, `cámara resuelta: dirección de mirada ${fwdErr.toFixed(2)}° y de avance ${moveErr.toFixed(2)}° de la verdad (zoom ${r.zoom} frente a ${Z})`);
    for (const c of ['CT3D', 'CTsolve']) await call('comp_delete', { project: MP, comp: c });
  });

  await test('exportar composición: MP4 con sonido, MOV ProRes con alfa, WebM con alfa, GIF y PNG', async () => {
    await call('comp_new', { project: MP, name: 'Exp', width: 320, height: 180, fps: 25, duration: 2, transparent: true });
    const v = await call('layer_add', { project: MP, comp: 'Exp', type: 'video', media_path: W('bars.mp4') });
    await call('prop_set', { project: MP, comp: 'Exp', layer: v.layer.id, path: 'scale', value: [25, 25] });
    await call('preset_apply', { project: MP, comp: 'Exp', preset: 'popIn', layers: [v.layer.id] });
    const mp4 = await call('comp_render', { project: MP, comp: 'Exp', output: W('exp.mp4') });
    const pm = probe(mp4.path);
    assert(pm.streams.some((s) => s.codec_type === 'audio') && near(dur(mp4.path), 2, 0.15), `MP4 2 s con audio (${dur(mp4.path)})`);
    assert(level(mp4.path) > -40, 'el sonido del vídeo está en la mezcla');
    const mov = await call('comp_render', { project: MP, comp: 'Exp', output: W('exp.mov'), format: 'mov-alpha' });
    assert(/yuva/.test(probe(mov.path).streams.find((s) => s.codec_type === 'video').pix_fmt), 'ProRes 4444 con alfa');
    const webm = await call('comp_render', { project: MP, comp: 'Exp', output: W('exp.webm'), format: 'webm-alpha', from: 0, to: 0.5 });
    assert(existsSync(webm.path) && near(dur(webm.path), 0.5, 0.15), 'WebM medio segundo');
    const gif = await call('comp_render', { project: MP, comp: 'Exp', output: W('exp.gif'), to: 0.4 });
    assert(existsSync(gif.path) && probe(gif.path).streams[0].codec_name === 'gif', 'GIF');
    const png = await call('comp_render', { project: MP, comp: 'Exp', output: W('seq.png'), format: 'png', to: 0.2 });
    assert(existsSync(W('seq_00001.png')) && existsSync(W('seq_00005.png')), `secuencia PNG (${png.frames})`);
  }, { isolated: true });

  await test('integración: composición como clip del modo simple (se actualiza sola) y el montaje simple como capa', async () => {
    await call('comp_new', { project: MP, name: 'Clip', width: 640, height: 360, fps: 30, duration: 2, bg: '#000000' });
    const s = await call('layer_add', { project: MP, comp: 'Clip', type: 'solid', color: '#ff0000' });
    await call('comp_to_timeline', { project: MP, comp: 'Clip' });
    let pf = imgOf(await call('preview_frame', { project: MP, time: 1, width: 320 }));
    assert(isColor(pf.at(0.5, 0.5), [255, 0, 0]), `la composición se ve en el modo simple (${pf.at(0.5, 0.5)})`);
    await call('layer_set', { project: MP, comp: 'Clip', layer: s.layer.id, solid_color: '#0000ff' });
    pf = imgOf(await call('preview_frame', { project: MP, time: 1, width: 320 }));
    assert(isColor(pf.at(0.5, 0.5), [0, 0, 255]), `tras cambiar la composición se vuelve a procesar (${pf.at(0.5, 0.5)})`);
    // the simple timeline as a layer of another composition
    await call('comp_new', { project: MP, name: 'Encima', width: 640, height: 360, fps: 30, duration: 2, bg: '#000000' });
    const seq = await call('layer_add', { project: MP, comp: 'Encima', type: 'sequence' });
    await call('prop_set', { project: MP, comp: 'Encima', layer: seq.layer.id, path: 'scale', value: [50, 50] });
    const im = await frame('Encima', 1);
    assert(isColor(im.at(0.5, 0.5), [0, 0, 255]) && isColor(im.at(0.05, 0.05), [0, 0, 0], 40), 'la secuencia aparece reducida al 50 % en el centro');
  }, { isolated: true });

  await test('al límite: 1080p60, 40 capas animadas con texto, formas, partículas, 3D, desenfoque de movimiento y efectos', async () => {
    await call('comp_new', { project: MP, name: 'Limite', width: 1920, height: 1080, fps: 60, duration: 2, bg: '#05070c' });
    await call('preset_apply', { project: MP, comp: 'Limite', preset: 'bgNoise' });
    await call('preset_apply', { project: MP, comp: 'Limite', preset: 'bgParticles' });
    for (let i = 0; i < 20; i++) {
      const sh = await call('shape_add', { project: MP, comp: 'Limite', kind: i % 3 ? 'star' : 'rect', width: 120, color: ['#ffd400', '#1d6cff', '#e8455a', '#36c48f'][i % 4], trim: { end: 100 }, repeater: i % 5 === 0 ? { copies: 5, rotation: 72 } : undefined });
      await call('prop_set', { project: MP, comp: 'Limite', layer: sh.layer.id, path: 'position', keys: [{ t: 0, v: [100 + i * 85, 1180], ease: 'easy' }, { t: 1, v: [100 + i * 85, 300 + (i % 4) * 150], ease: 'easy' }] });
      await call('prop_set', { project: MP, comp: 'Limite', layer: sh.layer.id, path: 'rotation', expression: `time * ${60 + i * 10}` });
      await call('layer_set', { project: MP, comp: 'Limite', layer: sh.layer.id, motion_blur: true, three_d: i % 4 === 0 });
    }
    for (let i = 0; i < 18; i++) {
      const t = await call('layer_add', { project: MP, comp: 'Limite', type: 'text', text: `Capa ${i + 1}`, size: 48, position: [200 + (i % 6) * 300, 150 + Math.floor(i / 6) * 120] });
      await call('preset_apply', { project: MP, comp: 'Limite', preset: ['dropChars', 'fadeUpChars', 'decode', 'blurInWords', 'wave', 'flipChars'][i % 6], layers: [t.layer.id] });
    }
    const adj = await call('layer_add', { project: MP, comp: 'Limite', type: 'adjustment' });
    await call('effect_add', { project: MP, comp: 'Limite', layer: adj.layer.id, effect: 'glow', values: { radius: 30, threshold: 70 } });
    await call('effect_add', { project: MP, comp: 'Limite', layer: adj.layer.id, effect: 'vignette' });
    await call('preset_apply', { project: MP, comp: 'Limite', preset: 'cameraPush', at: 0, duration: 2 });
    const g = await call('comp_get', { project: MP, comp: 'Limite' });
    assert(g.comp.layers.length >= 40, `${g.comp.layers.length} capas`);
    const t0 = Date.now();
    const r = await call('comp_render', { project: MP, comp: 'Limite', output: W('limite.mp4'), to: 1 });
    const secs = (Date.now() - t0) / 1000;
    assert(r.frames === 60 && near(dur(r.path), 1, 0.1), `60 fotogramas (${r.frames})`);
    assert(!r.perf?.errors?.length, `errores de capas: ${r.perf?.errors}`);
    const mid = frameOf(r.path, 0.9);
    assert(mid.mean() > 15, 'el fotograma tiene contenido');
    console.log(`      1080p60 con ${g.comp.layers.length} capas: ${(60 / secs).toFixed(1)} fotogramas/s (render ${r.perf?.renderMs} ms/fotograma)`);
  }, { isolated: true });

  await test('open_in_editor abre la ventana de Cinta con el proyecto', async () => {
    const r = await call('open_in_editor', { project: P });
    assert(r.pid, 'proceso iniciado');
    let title = '';
    for (let i = 0; i < 60 && !/p\b|p –|– p/.test(title); i++) {
      await new Promise((ok) => setTimeout(ok, 500));
      title = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${r.pid} -ErrorAction SilentlyContinue).MainWindowTitle`], { windowsHide: true, encoding: 'utf8' }).stdout.trim();
      if (/Cinta [–-] p/.test(title)) break;
    }
    spawnSync('taskkill', ['/PID', String(r.pid), '/T', '/F'], { windowsHide: true });
    assert(/Cinta [–-] p/.test(title), `título de la ventana: «${title}»`);
  });

  if (exe) await test('desinstalar quita de Claude solo la entrada de esta copia de Cinta', async () => {
    const dir = W('uninstall');
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, 'claude_desktop_config.json');
    const ours = { command: exe.replace(/\//g, '\\'), args: [serverJs.replace(/\//g, '\\')], env: { ELECTRON_RUN_AS_NODE: '1' } };
    const run = () => spawnSync(exe, ['--uninstall-mcp'], { env: { ...process.env, CINTA_NO_CLAUDE_CODE: '1', CINTA_CLAUDE_DESKTOP_DIR: dir, CINTA_USER_DATA: join(dir, 'ud') }, windowsHide: true, timeout: 60000 });
    writeFileSync(cfg, JSON.stringify({ preferences: { a: 1 }, mcpServers: { otro: { command: 'otro.exe' }, cinta: ours } }));
    run();
    const after = JSON.parse(readFileSync(cfg, 'utf8'));
    assert(!after.mcpServers.cinta && after.mcpServers.otro && after.preferences.a === 1, `tras desinstalar: ${JSON.stringify(after)}`);
    writeFileSync(cfg, JSON.stringify({ mcpServers: { cinta: { command: 'C:\\OtraCopia\\Cinta.exe', args: ['C:\\OtraCopia\\mcp.js'] } } }));
    run();
    assert(JSON.parse(readFileSync(cfg, 'utf8')).mcpServers.cinta, 'la entrada de otra copia no se toca');
  });

  await test('errores claros en español', async () => {
    const e1 = await callErr('clip_split', { project: P, time: 9999 });
    assert(/No hay ningún clip/.test(e1), e1);
    const e2 = await callErr('project_get', { project: W('no.cinta') });
    assert(/No existe el proyecto/.test(e2), e2);
    const e3 = await callErr('clip_filter_add', { project: P, clip_id: mainClips[0], filter: 'nada' });
    assert(/Filtro desconocido/.test(e3), e3);
  });

  // cases per line of work (scripts/mcp-cases/*.mjs): export default async ({ test, call, … }) => { await test(…) }
  for (const f of readdirSync(join(root, 'scripts', 'mcp-cases')).filter((x) => x.endsWith('.mjs')).sort()) {
    await (await import(pathToFileURL(join(root, 'scripts', 'mcp-cases', f)).href)).default({ test, call, callErr, assert, imgOf, decodePng, isColor, near, ff, probe, W, FF, root });
  }

  await client.close();
  console.log(`\n${passed} correctas, ${failures} fallidas`);
  if (!failures) rmSync(work, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
