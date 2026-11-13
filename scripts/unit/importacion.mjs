// Unit tests of «importacion»: numbered sequences (padding, gaps, alphabetical), interpretation filters, the Cineon
// reader, raw previews, Maya ASCII cameras and Premiere Pro projects (synthetic files from scripts/fixtures).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cineon, fakeRaw, mayaScene, prproj, runFf } from '../fixtures/importacion.mjs';

export default ({ test, ok, near, M, core }) => {
  const I = core.importacion;
  const dir = mkdtempSync(join(tmpdir(), 'cinta-imp-'));
  const touch = (n) => writeFileSync(join(dir, n), '');
  try {
    for (let i = 1; i <= 12; i++) if (i !== 5 && i !== 6) touch(`img_${String(i).padStart(4, '0')}.png`);
    for (let i = 8; i <= 11; i++) touch(`b${i}.tga`);
    touch('zeta.jpg'); touch('alfa.jpg'); touch('mid.jpg'); touch('notes.txt');

    test('importacion: secuencia numerada con relleno y huecos → img_[0001-0012].png, faltan 5 y 6', () => {
      const s = I.detectSequence(join(dir, 'img_0007.png'));
      ok(s && s.first === 1 && s.last === 12 && s.pad === 4, JSON.stringify(s));
      ok(s.missing.join() === '5,6', `faltan ${s.missing}`);
      ok(I.seqName(s) === 'img_[0001-0012].png', I.seqName(s));
      const f = I.seqFrames(s);
      ok(f.length === 12 && f[4] === null && f[5] === null && f[11].endsWith('img_0012.png'), JSON.stringify(f.map((x) => x && x.slice(-12))));
    });
    test('importacion: sin relleno (b8 … b11) y archivo suelto sin secuencia', () => {
      const s = I.detectSequence(join(dir, 'b9.tga'));
      ok(s && s.pad === 0 && s.first === 8 && s.last === 11 && !s.missing.length, JSON.stringify(s));
      ok(I.seqFrames(s)[2].endsWith('b10.tga'), I.seqFrames(s)[2]);
      ok(I.detectSequence(join(dir, 'zeta.jpg')) === null, 'sin número no es secuencia');
    });
    test('importacion: Forzar orden alfabético: todos los JPEG de la carpeta por nombre', () => {
      const s = I.detectSequence(join(dir, 'zeta.jpg'), { alphabetical: true });
      ok(s && s.alphabetical && I.seqFrames(s).map((p) => p.split(/[\\/]/).pop()).join() === 'alfa.jpg,mid.jpg,zeta.jpg', JSON.stringify(s));
    });
    test('importacion: una carpeta importa su secuencia más larga', () => {
      ok(/img_\d{4}\.png$/.test(I.sequenceInFolder(dir) ?? ''), I.sequenceInFolder(dir));
    });
    test('importacion: filtros de alfa (Ignorar, Recto, Premultiplicado con negro / con color, Invertir alfa)', () => {
      ok(I.alphaFilters({ hasAlpha: true, interpret: { alpha: 'ignore' } }).join() === 'format=rgb24', 'ignorar');
      ok(I.alphaFilters({ hasAlpha: false, interpret: {} }).join() === 'format=rgb24', 'sin alfa');
      ok(I.alphaFilters({ hasAlpha: true, interpret: { alpha: 'straight' } }).join() === 'format=rgba', 'recto');
      ok(I.alphaFilters({ hasAlpha: true, interpret: { alpha: 'premultiplied' } }).includes('unpremultiply=inplace=1'), 'premultiplicado negro');
      const c = I.alphaFilters({ hasAlpha: true, interpret: { alpha: 'premultiplied', matte: '#ffffff', invertAlpha: true } });
      ok(c[1] === "lut=a='negval'" && /^geq=r=.*255\*\(255-alpha/.test(c[2]), c.join(' | '));
      ok(I.SEQUENCE_FPS === 30, 'Preferencias ▸ Importar: 30 fps');
    });
    test('importacion: Cineon 10 bits: 685 → blanco, 95 → negro, 445 gris medio (Estándar, gamma 1,7)', () => {
      const b = cineon(3, 2, (x) => (x === 0 ? [685, 685, 685] : x === 1 ? [95, 95, 95] : [445, 300, 685]));
      const im = I.readCineon(b);
      ok(im.width === 3 && im.height === 2, `${im.width}×${im.height}`);
      ok(im.rgba[0] === 255 && im.rgba[4] === 0 && im.rgba[3] === 255, `${im.rgba.slice(0, 8)}`);
      const g = im.rgba[8];
      // (10^((445−685)·0.002/0.6) − offset)·gain = 0.149 lineal → ^(1/1.7) = 0.326 → 83
      ok(Math.abs(g - 83) <= 2 && im.rgba[9] < g && im.rgba[10] === 255, `gris ${im.rgba.slice(8, 12)}`);
      let threw = false; try { I.readCineon(Buffer.alloc(2048)); } catch { threw = true; }
      ok(threw, 'no Cineon');
    });
    test('importacion: Camera Raw: la vista previa JPEG más grande, no la miniatura ni los datos sin pérdida', () => {
      const ff = runFf(join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));
      const p = I.rawPreview(fakeRaw(ff));
      ok(p && p.width === 320 && p.height === 200 && p.orientation === 1, JSON.stringify(p && { w: p.width, h: p.height, o: p.orientation }));
      ok(p.jpeg[0] === 0xff && p.jpeg[1] === 0xd8 && p.jpeg[p.jpeg.length - 1] === 0xd9, 'JPEG completo');
    });
    test('importacion: Maya ASCII: unidades, rango, resolución, curvas conectadas', () => {
      const sc = I.parseMaya(mayaScene());
      ok(sc.fps === 24 && sc.start === 1 && sc.end === 25 && sc.width === 1920 && sc.height === 1080, JSON.stringify({ fps: sc.fps, s: sc.start, e: sc.end, w: sc.width }));
      ok(sc.curves.get('camera1.tx')?.v.join() === '0,240', [...sc.curves.keys()].join());
      let threw = false; try { I.parseMaya('hola'); } catch (e) { threw = /Ascii Maya/.test(e.message); }
      ok(threw, 'binario / no Maya');
    });
    test('importacion: cámara de Maya → capa de cámara: posición, punto de interés, zoom de 35 mm y nulo del localizador', () => {
      const e = new core.Editor();
      writeFileSync(join(dir, 'cam.ma'), mayaScene());
      const r = I.mayaImport(e, join(dir, 'cam.ma'));
      ok(r.comp.width === 1920 && r.comp.fps === 24 && near(r.comp.duration, 25 / 24, 0.01) && r.cameras.length === 1 && r.nulls.length === 1, JSON.stringify({ c: r.comp.width, d: r.comp.duration, cams: r.cameras.length }));
      const cam = r.comp.layers.find((l) => l.id === r.cameras[0]);
      ok(cam.name === 'camera1' && cam.type === 'camera', cam.name);
      const pos0 = M.keyedAt(cam.transform.position, 0), pos1 = M.keyedAt(cam.transform.position, 1);
      ok(near(pos0[0], 0) && near(pos0[1], 0) && near(pos0[2], -1000), `posición 0: ${pos0}`);
      ok(near(pos1[0], 240, 0.01), `posición en el fotograma 25: ${pos1}`);
      const zoom = cam.camera.zoom.v, poi = M.keyedAt(cam.camera.poi, 0);
      ok(near(zoom, (1920 * 35) / (1.4173228346456692 * 25.4), 0.01), `zoom ${zoom}`);
      ok(near(poi[2], -1000 + zoom, 0.01) && near(poi[0], 0), `punto de interés ${poi}`);
      const nl = r.comp.layers.find((l) => l.id === r.nulls[0]);
      ok(nl.threeD && near(nl.transform.position.v[0], 100) && near(nl.transform.position.v[1], -50), `nulo ${nl.transform.position.v}`);
      const c2 = I.mayaImport(e, join(dir, 'cam.ma'), { origin: 'center' }).comp, cam2 = c2.layers.find((l) => l.type === 'camera');
      ok(near(M.keyedAt(cam2.transform.position, 0)[0], 960), 'origen en el centro');
    });
    test('importacion: proyecto de Premiere Pro: secuencias, pistas, entrada/salida en ticks, anidadas', () => {
      const pr = I.readPrproj(prproj([
        { name: 'Principal', w: 1280, h: 720, fps: 25, video: [[{ file: 'C:\\a&b.mp4', start: 0, end: 2, in: 1, name: 'a' }, { file: 'D:\\c.png', start: 2, end: 3 }], [{ seq: 1, start: 0.5, end: 1.5 }]], audio: [[{ file: 'C:\\a&b.mp4', start: 0, end: 2, in: 1 }]] },
        { name: 'Anidada', w: 640, h: 360, fps: 30, video: [[{ file: 'D:\\c.png', start: 0, end: 4 }]] },
      ]));
      ok(pr.sequences.length === 2 && pr.media.length === 2 && pr.media.includes('C:\\a&b.mp4'), JSON.stringify(pr.media));
      const s = pr.sequences[0];
      ok(s.name === 'Principal' && s.width === 1280 && s.height === 720 && s.fps === 25 && near(s.duration, 3), JSON.stringify({ n: s.name, w: s.width, fps: s.fps, d: s.duration }));
      ok(s.tracks.length === 3 && s.tracks[0].kind === 'video' && s.tracks[2].kind === 'audio', s.tracks.map((t) => t.kind).join());
      const c = s.tracks[0].clips[0];
      ok(near(c.start / I.TICKS, 0) && near(c.end / I.TICKS, 2) && near(c.inPoint / I.TICKS, 1) && c.name === 'a', JSON.stringify(c));
      ok(s.tracks[1].clips[0].sequence === 'seq-2', JSON.stringify(s.tracks[1].clips[0]));
      let threw = false; try { I.readPrproj(Buffer.from('<x/>')); } catch (e) { threw = /Premiere/.test(e.message); }
      ok(threw, 'no es Premiere');
    });
    test('importacion: XML con entidades, CDATA y autocierre', () => {
      const x = I.parseXml('<?xml version="1.0"?><a k="1 &amp; 2"><b/><c><![CDATA[<z>]]></c><d>&#65;&lt;</d></a>');
      const a = x.kids[0];
      ok(a.attrs.k === '1 & 2' && a.kids.length === 3 && a.kids[1].text === '<z>' && a.kids[2].text === 'A<', JSON.stringify(a));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
