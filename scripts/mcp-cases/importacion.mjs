// MCP cases of «importacion»: PNG sequences (gaps, padding, folder), Interpret Footage (frame rate, loop, alpha) in
// both modes; Targa, SGI, DPX, Cineon, TIFF, MXF, DNG, other Camera Raw, AVIF and HEIC (single and grid) converted on
// import; Premiere Pro projects to comps and to the simple timeline; Maya cameras.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cineon, dng, fakeRaw, heic, mayaScene, prproj, runFf } from '../fixtures/importacion.mjs';

export default async ({ test, call, callErr, assert, imgOf, isColor, W, FF }) => {
  const P = W('importacion.cinta');
  const ffb = runFf(FF);
  const RED = [255, 0, 0], BLUE = [0, 0, 255], GREEN = [0, 128, 0];
  const frame = async (comp, t) => imgOf(await call('comp_frame', { project: P, comp, time: t, width: 64 }));
  const color = (c, file, extra = []) => ffb('-f', 'lavfi', '-i', `color=c=${c}:s=64x48`, '-frames:v', '1', ...extra, file);
  const dir = W('imp');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join2(dir, 'seq'), { recursive: true });
  function join2(a, b) { return `${a}\\${b}`; }

  await test('importacion: Secuencia PNG con un hueco → un solo material de vídeo f_[001-010].png; Interpretar: 10 fps y bucle 2; capas y modo simple', async () => {
    await call('project_new', { path: P, width: 64, height: 48, fps: 10, overwrite: true });
    // frames 1–5 red, 6–10 blue; frame 7 is missing (holds frame 6)
    for (let i = 1; i <= 10; i++) if (i !== 7) color(i <= 5 ? 'red' : 'blue', join2(dir, `seq\\f_${String(i).padStart(3, '0')}.png`));
    const r = await call('footage_import', { project: P, paths: [join2(dir, 'seq\\f_003.png')], sequence: true });
    const m = r.media[0];
    assert(m.kind === 'video' && m.name === 'f_[001-010].png' && m.footage.frames === 10 && m.footage.missing.join() === '7', JSON.stringify(m));
    assert(Math.abs(m.duration - 10 / 30) < 0.01 && m.fps === 30, `30 fps por defecto: ${m.duration} s, ${m.fps}`);
    assert(r.notes?.some((n) => /falta el fotograma 7/.test(n)), JSON.stringify(r.notes));
    const i1 = await call('footage_interpret', { project: P, media: m.id, fps: 10 });
    assert(Math.abs(i1.media.duration - 1) < 0.01 && i1.media.fps === 10, `10 fps: ${i1.media.duration}`);
    const i2 = await call('footage_interpret', { project: P, media: m.id, loop: 2 });
    assert(Math.abs(i2.media.duration - 2) < 0.01 && i2.media.footage.interpret.loop === 2 && i2.media.footage.interpret.fps === 10, JSON.stringify(i2.media));
    await call('comp_new', { project: P, name: 'Sec', width: 64, height: 48, fps: 10, duration: 2, bg: '#000000' });
    await call('layer_add', { project: P, comp: 'Sec', type: 'video', media_id: m.id });
    const l = (await call('comp_get', { project: P, comp: 'Sec' })).comp.layers[0];
    assert(Math.abs(l.out - 2) < 0.01, `capa de 2 s: ${l.out}`);
    for (const [t, want, what] of [[0.15, RED, 'fotograma 2'], [0.65, BLUE, 'fotograma 7 (falta: repite el 6)'], [1.15, RED, 'segunda vuelta del bucle']]) {
      const px = (await frame('Sec', t)).at(0.5, 0.5);
      assert(isColor(px, want), `${what} en ${t} s: ${px}`);
    }
    // the simple timeline: one clip of 2 s
    const c = await call('clip_add', { project: P, media: m.id });
    const pv = imgOf(await call('preview_frame', { project: P, time: 0.75, width: 160 })).at(0.5, 0.5);
    assert(isColor(pv, BLUE), `modo simple 0,75 s: ${pv}`);
    await call('clip_delete', { project: P, clip_ids: [c.clip?.id ?? c.id] }).catch(() => {});
  });

  await test('importacion: carpeta arrastrada → su secuencia; alfa recto (WebM con alfa) e Ignorar alfa (MP4)', async () => {
    const ad = join2(dir, 'alfa');
    mkdirSync(ad, { recursive: true });
    for (let i = 1; i <= 4; i++) ffb('-f', 'lavfi', '-i', 'color=c=red@0.5:s=64x48,format=rgba', '-frames:v', '1', '-pix_fmt', 'rgba', join2(ad, `a${i}.png`));
    const r = await call('footage_import', { project: P, paths: [ad] });
    const m = r.media[0];
    assert(m.kind === 'video' && m.footage.hasAlpha && /\.webm$/.test(m.path) && m.footage.interpret.alpha === 'straight', JSON.stringify(m));
    await call('comp_new', { project: P, name: 'Alfa', width: 64, height: 48, fps: 30, duration: 0.1, bg: '#ffffff' });
    await call('layer_add', { project: P, comp: 'Alfa', type: 'video', media_id: m.id });
    const px = (await frame('Alfa', 0)).at(0.5, 0.5);
    assert(px[0] > 230 && px[1] > 90 && px[1] < 170, `rojo al 50 % sobre blanco: ${px}`);
    const i = await call('footage_interpret', { project: P, media: m.id, alpha: 'ignore' });
    assert(/\.mp4$/.test(i.media.path), i.media.path);
    const px2 = (await frame('Alfa', 0)).at(0.5, 0.5);
    assert(isColor(px2, RED, 60), `alfa ignorado: ${px2}`);
    const err = await callErr('footage_interpret', { project: P, media: m.id, loop: 0 });
    assert(/loop|1/i.test(err), err);
  });

  await test('importacion: Targa, SGI, DPX, Cineon, TIFF, DNG, Camera Raw (vista previa), AVIF y HEIC se convierten y se ven', async () => {
    const f = (n) => join2(dir, n);
    color('green', f('t.tga'));
    color('blue', f('t.sgi'));
    color('red', f('t.dpx'));
    color('blue', f('t.tif'));
    writeFileSync(f('t.cin'), cineon(64, 48, () => [685, 95, 95]));
    writeFileSync(f('t.dng'), dng());
    writeFileSync(f('t.nef'), fakeRaw(ffb, dir, 'green'));
    color('red', f('t.avif'), ['-c:v', 'libaom-av1', '-still-picture', '1']);
    writeFileSync(f('t.heic'), heic(ffb, ['blue'], 64, 48, 64, 48));
    writeFileSync(f('g.heic'), heic(ffb, ['red', 'blue'], 64, 64, 120, 64));
    const files = ['t.tga', 't.sgi', 't.dpx', 't.cin', 't.tif', 't.dng', 't.nef', 't.avif', 't.heic', 'g.heic'];
    const r = await call('media_import', { project: P, paths: files.map(f) });
    const want = { 't.tga': GREEN, 't.sgi': BLUE, 't.dpx': RED, 't.cin': RED, 't.tif': BLUE, 't.nef': GREEN, 't.avif': RED, 't.heic': BLUE };
    await call('comp_new', { project: P, name: 'Fmt', width: 64, height: 48, fps: 10, duration: 1, bg: '#000000' });
    const list = (await call('media_list', { project: P })).media;
    for (const [i, name] of files.entries()) {
      const m = r.media[i];
      const full = list.find((x) => x.id === m.id);
      assert(m.kind === 'image' && /\.png$/i.test(m.path) && full.footage?.source.endsWith(name), `${name}: ${JSON.stringify(m)}`);
      if (!want[name]) continue;
      const l = (await call('layer_add', { project: P, comp: 'Fmt', type: 'image', media_id: m.id })).layer.id;
      const px = (await frame('Fmt', 0)).at(0.5, 0.5);
      assert(isColor(px, want[name], 90), `${name}: ${px} (${full.footage.format})`);
      await call('layer_delete', { project: P, comp: 'Fmt', layers: [l] });
    }
    const byName = (n) => list.find((x) => x.footage?.source.endsWith(n));
    assert(byName('t.cin').footage.format === 'Cineon' && byName('t.nef').footage.format === 'Camera Raw' && /vista previa/i.test(byName('t.nef').footage.notes.join()), JSON.stringify(byName('t.nef').footage));
    // DNG: ffmpeg demosaics it — red left, blue right
    const d = byName('t.dng');
    const ld = (await call('layer_add', { project: P, comp: 'Fmt', type: 'image', media_id: d.id })).layer.id;
    const im = await frame('Fmt', 0);
    assert(im.at(0.25, 0.5)[0] > 150 && im.at(0.25, 0.5)[2] < 100 && im.at(0.75, 0.5)[2] > 150, `DNG: ${im.at(0.25, 0.5)} / ${im.at(0.75, 0.5)}`);
    await call('layer_delete', { project: P, comp: 'Fmt', layers: [ld] });
    // HEIC grid: 2 tiles of 64×64 cropped to 120×64
    const g = byName('g.heic');
    assert(g.width === 120 && g.height === 64, `cuadrícula ${g.width}×${g.height}`);
  });

  await test('importacion: MXF (vídeo y audio) se convierte a MP4 con sonido; la duración se conserva', async () => {
    const mxf = join2(dir, 't.mxf');
    ffb('-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=25:d=1', '-f', 'lavfi', '-i', 'sine=d=1:sample_rate=48000', '-c:v', 'mpeg2video', '-c:a', 'pcm_s16le', '-shortest', mxf);
    const r = await call('media_import', { project: P, paths: [mxf] });
    const m = r.media[0];
    assert(m.kind === 'video' && m.hasAudio && /\.mp4$/.test(m.path) && Math.abs(m.duration - 1) < 0.1, JSON.stringify(m));
  });

  await test('importacion: proyecto de Premiere Pro → composiciones (pistas, entrada, anidada, archivo que falta) y → línea de tiempo', async () => {
    const a = join2(dir, 'pr_a.mp4'), b = join2(dir, 'pr_b.png');
    ffb('-f', 'lavfi', '-i', 'color=c=red:s=64x48:r=25:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', a);
    color('blue', b);
    const file = join2(dir, 'proj.prproj');
    writeFileSync(file, prproj([
      { name: 'Principal', w: 64, h: 48, fps: 25, video: [[{ file: a, start: 0, end: 2, in: 1, name: 'rojo' }, { file: b, start: 2, end: 3, name: 'azul' }], [{ seq: 1, start: 0.5, end: 1, name: 'Anidada' }, { file: 'Z:\\no\\existe.mov', start: 2.5, end: 3, name: 'perdido' }]], audio: [[{ file: a, start: 0, end: 2, in: 1 }]] },
      { name: 'Anidada', w: 64, h: 48, fps: 25, video: [[{ file: b, start: 0, end: 4 }]] },
    ]));
    const ls = await call('premiere_import', { project: P, path: file, list: true });
    assert(ls.sequences.map((s) => s.name).join() === 'Principal,Anidada', JSON.stringify(ls));
    const r = await call('premiere_import', { project: P, path: file });
    assert(r.comps.length === 2 && r.missing?.length === 1, JSON.stringify(r));
    const main = r.comps.find((c) => c.name === 'Principal');
    assert(main.width === 64 && main.fps === 25 && Math.abs(main.duration - 3) < 0.01, JSON.stringify(main));
    const g = await call('comp_get', { project: P, comp: main.id });
    const L = g.comp?.layers ?? g.layers;
    const red = L.find((l) => l.name === 'rojo');
    assert(red && Math.abs(red.start + 1) < 0.01 && Math.abs(red.in) < 0.01 && Math.abs(red.out - 2) < 0.01, `rojo: ${JSON.stringify(red)}`);
    assert(L.some((l) => l.type === 'comp' && l.name === 'Anidada') && L.some((l) => /^Falta: perdido/.test(l.name)) && L.some((l) => l.type === 'audio'), L.map((l) => `${l.type}:${l.name}`).join());
    // the top track (V2) is above V1
    const iN = L.findIndex((l) => l.name === 'Anidada'), iR = L.findIndex((l) => l.name === 'rojo');
    assert(iN < iR, `orden ${L.map((l) => l.name)}`);
    const px = (await frame(main.id, 0.25)).at(0.5, 0.5);
    assert(isColor(px, RED), `0,25 s: ${px}`);
    const px2 = (await frame(main.id, 0.75)).at(0.5, 0.5);
    assert(isColor(px2, BLUE), `0,75 s (anidada encima): ${px2}`);
    // into the simple timeline
    const P2 = W('importacion-pr.cinta');
    await call('project_new', { path: P2, width: 64, height: 48, fps: 25, overwrite: true });
    const t = await call('premiere_import', { project: P2, path: file, target: 'timeline', sequence: 'Principal' });
    assert(t.clips >= 3, JSON.stringify(t));
    const pj = await call('project_get', { project: P2 });
    const clips = pj.tracks.flatMap((tr) => (tr.clips ?? []).map((c) => ({ ...c, track: tr.kind })));
    assert(clips.length >= 3 && clips.some((c) => c.track === 'audio') && pj.tracks.some((tr) => tr.kind === 'overlay') && clips.find((c) => c.name === 'pr_a.mp4' && c.track === 'main')?.in === 1, JSON.stringify(clips).slice(0, 400));
    const v = imgOf(await call('preview_frame', { project: P2, time: 2.2, width: 160 })).at(0.5, 0.5);
    assert(isColor(v, BLUE), `2,2 s: ${v}`);
  });

  await test('importacion: escena Maya → composición con cámara animada y nulo; import_as_comp con .ma', async () => {
    const file = join2(dir, 'cam.ma');
    writeFileSync(file, mayaScene());
    const r = await call('maya_import', { project: P, path: file });
    assert(r.comp.width === 1920 && r.comp.height === 1080 && r.comp.fps === 24 && r.cameras.length === 1 && r.nulls.length === 1 && r.frames === 25, JSON.stringify(r));
    const r2 = await call('import_as_comp', { project: P, path: file, name: 'Maya 2' });
    assert(r2.comp.name === 'Maya 2' && r2.cameras.length === 1, JSON.stringify(r2));
    const err = await callErr('maya_import', { project: P, path: join2(dir, 't.tga') });
    assert(/Ascii Maya/.test(err), err);
  });
};
