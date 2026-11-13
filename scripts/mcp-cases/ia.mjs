// MCP cases of «ia»: Roto Brush & Refine Edge (roto_brush) on a synthetic shot — an orange disc gliding over a noisy
// blue background — and Content-Aware Fill (content_aware_fill) removing that disc with its own inverted matte.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export default async ({ test, call, callErr, assert, imgOf, ff, W }) => {
  const AP = W('ia-rotoscopia.cinta');
  // disc of radius 33 centred at (115 + 3·n, 90) on frame n, 30 fps, 1 s
  const clip = W('ia-disco.mp4');
  ff('-f', 'lavfi', '-i', 'color=c=0x2a6f8a:s=320x180:d=1:r=30,noise=alls=25:allf=t', '-f', 'lavfi', '-i', "color=c=0xe08030:s=70x70:d=1:r=30,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-35,Y-35),33),255,0)'",
    '-filter_complex', "[0][1]overlay=x='80+3*n':y=55:shortest=1", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-t', '1', clip);
  let lay;
  const cx = (n) => 115 + 3 * n;
  const isOrange = (p) => p[0] > 170 && p[1] > 90 && p[1] < 170 && p[2] < 110;

  await test('ia: roto_brush con un trazo de primer plano segmenta el disco y lo sigue hacia delante y hacia atrás', async () => {
    await call('project_new', { path: AP, width: 320, height: 180, fps: 30 });
    await call('comp_new', { project: AP, name: 'Roto', width: 320, height: 180, fps: 30, duration: 1, bg: '#000000' });
    lay = (await call('layer_add', { project: AP, comp: 'Roto', type: 'video', media_path: clip })).layer.id;
    // base frame 10 (s = 1/3): a stroke across the disc
    const r = await call('roto_brush', { project: AP, comp: 'Roto', layer: lay, strokes: [{ kind: 'fg', time: 10 / 30, points: [[cx(10) - 18, 92], [cx(10) + 18, 86]], diameter: 10 }], report: [0, 10 / 30, 20 / 30, 29 / 30] });
    assert(r.status === 'ok' && r.propagated && r.framesWithMatte >= 29 && r.baseFrame === 10, JSON.stringify({ ...r, matte: undefined }));
    const area = (Math.PI * 33 * 33) / (320 * 180);
    for (const m of r.matte) {
      const n = Math.round(m.time * 30);
      assert(Math.abs(m.coverage - area) < area * 0.2, `fotograma ${n}: cobertura ${m.coverage} (disco ${area.toFixed(3)})`);
      assert(Math.abs(m.centroid[0] - cx(n)) < 4 && Math.abs(m.centroid[1] - 90) < 4, `fotograma ${n}: centro ${m.centroid}`);
    }
    // cached: a second call does not propagate again
    const again = await call('roto_brush', { project: AP, comp: 'Roto', layer: lay });
    assert(!again.propagated && again.status === 'ok', 'caché');
  });

  await test('ia: la capa queda recortada por el mate (el disco se ve, el fondo es transparente) e Invertir lo da la vuelta', async () => {
    let img = imgOf(await call('comp_frame', { project: AP, comp: 'Roto', time: 20 / 30, width: 320 }));
    const inD = img.at(cx(20) / 320, 90 / 180), out = img.at(30 / 320, 30 / 180);
    assert(isOrange(inD) && out[0] + out[1] + out[2] < 30, `dentro ${inD}, fuera ${out}`);
    await call('roto_brush', { project: AP, comp: 'Roto', layer: lay, values: { invert: true } });
    img = imgOf(await call('comp_frame', { project: AP, comp: 'Roto', time: 20 / 30, width: 320 }));
    const a = img.at(cx(20) / 320, 90 / 180), b = img.at(30 / 320, 30 / 180);
    assert(a[0] + a[1] + a[2] < 30 && b[2] > 80, `invertido: dentro ${a}, fuera ${b}`);
    await call('roto_brush', { project: AP, comp: 'Roto', layer: lay, values: { invert: false } });
  });

  await test('ia: un trazo de fondo (Alt) en otro fotograma corrige desde allí; Perfeccionar borde suaviza el borde pintado', async () => {
    // background stroke over the right half of the disc on frame 25: from there on that half is gone
    const r = await call('roto_brush', { project: AP, comp: 'Roto', layer: lay, strokes: [{ kind: 'bg', time: 25 / 30, points: [[cx(25) + 8, 50], [cx(25) + 8, 130]], diameter: 8 }, { kind: 'bg', time: 25 / 30, points: [[cx(25) + 20, 50], [cx(25) + 20, 130]], diameter: 8 }], report: [20 / 30, 27 / 30] });
    const [before, after] = r.matte;
    assert(after.coverage < before.coverage * 0.85 && after.bounds[2] < cx(27) + 22, `antes ${JSON.stringify(before)}, después ${JSON.stringify(after)}`);
    // Refine Edge over the left edge of frame 10: a soft edge region exists there
    const q = await call('roto_brush', { project: AP, comp: 'Roto', layer: lay, strokes: [{ kind: 'refine', time: 10 / 30, points: [[cx(10) - 33, 70], [cx(10) - 33, 110]], diameter: 12 }], report: [10 / 30, 12 / 30] });
    assert(q.matte.every((m) => m.refine), `región de perfeccionamiento ${JSON.stringify(q.matte)}`);
    const img = imgOf(await call('comp_frame', { project: AP, comp: 'Roto', time: 10 / 30, width: 320 }));
    let soft = 0;
    for (let x = cx(10) - 38; x <= cx(10) - 28; x++) { const p = img.at((x + 0.5) / 320, 90.5 / 180); if (p[0] > 15 && p[0] < 200) soft++; }
    assert(soft >= 1, `borde suave: ${soft}`);
  });

  await test('ia: congelar bloquea la propagación y los trazos; descongelar la vuelve a permitir', async () => {
    const r = await call('roto_brush', { project: AP, comp: 'Roto', layer: lay, freeze: true });
    assert(r.frozen && r.status === 'frozen', JSON.stringify(r.status));
    const e = await callErr('roto_brush', { project: AP, comp: 'Roto', layer: lay, strokes: [{ kind: 'fg', time: 0, points: [[100, 90]] }] });
    assert(/congelada/.test(e), e);
    const u = await call('roto_brush', { project: AP, comp: 'Roto', layer: lay, freeze: false, clear: 'all', strokes: [{ kind: 'fg', time: 10 / 30, points: [[cx(10) - 18, 92], [cx(10) + 18, 86]], diameter: 10 }] });
    assert(!u.frozen && u.status === 'ok' && u.strokes.length === 1, JSON.stringify(u.strokes));
  });

  await test('ia: content_aware_fill (Objeto) con el mate invertido borra el disco con el fondo de otros fotogramas', async () => {
    await call('roto_brush', { project: AP, comp: 'Roto', layer: lay, values: { invert: true } });
    const r = await call('content_aware_fill', { project: AP, comp: 'Roto', layer: lay, method: 'object', lighting: 'subtle', range: 'all' });
    assert(r.frames === 30 && /^Rellenar /.test(r.layer.name) && r.holePixels > 1000, JSON.stringify(r));
    const pngs = readdirSync(r.folder).filter((f) => f.endsWith('.png'));
    assert(pngs.length === 30 && existsSync(join(r.folder, readdirSync(r.folder).find((f) => f.endsWith('.webm')))), `secuencia ${pngs.length}`);
    assert(dirname(r.folder).endsWith('Rellenos'), r.folder);
    // the comp: fill above the (inverted-matte) layer — the disc is gone, the background is there
    const comp = await call('comp_get', { project: AP, comp: 'Roto' });
    assert(comp.comp.layers[0].name === r.layer.name, comp.comp.layers.map((l) => l.name).join(', '));
    for (const n of [5, 20]) {
      const img = imgOf(await call('comp_frame', { project: AP, comp: 'Roto', time: n / 30 + 0.001, width: 320 }));
      const p = img.at(cx(n) / 320, 90 / 180);
      assert(!isOrange(p) && p[2] > p[0], `fotograma ${n}: en el disco ${p}`);
    }
  });

  await test('ia: Fusión de borde y Superficie con una máscara Restar; fotograma de referencia; sin hueco avisa', async () => {
    await call('comp_new', { project: AP, name: 'Relleno', width: 320, height: 180, fps: 30, duration: 0.5, bg: '#000000' });
    const l2 = (await call('layer_add', { project: AP, comp: 'Relleno', type: 'video', media_path: clip })).layer.id;
    const e = await callErr('content_aware_fill', { project: AP, comp: 'Relleno', layer: l2, method: 'edge' });
    assert(/opacos/.test(e), e);
    await call('mask_add', { project: AP, comp: 'Relleno', layer: l2, shape: 'ellipse', x: 70, y: 45, width: 90, height: 90, mode: 'subtract' });
    const ed = await call('content_aware_fill', { project: AP, comp: 'Relleno', layer: l2, method: 'edge', range: 'all' });
    assert(ed.frames === 15, JSON.stringify(ed));
    const img = imgOf(await call('comp_frame', { project: AP, comp: 'Relleno', time: 0.1, width: 320 }));
    const p = img.at(115 / 320, 90 / 180);
    assert(!isOrange(p) && p[2] > 60, `fusión de borde ${p}`);
    const ref = await call('content_aware_fill', { project: AP, comp: 'Relleno', layer: l2, referenceFrame: 0.2, referenceOnly: true });
    assert(/^Fotograma de referencia/.test(ref.reference.layer.name) && existsSync(ref.reference.file), JSON.stringify(ref));
    const sf = await call('content_aware_fill', { project: AP, comp: 'Relleno', layer: l2, method: 'surface', range: [0, 0.3] });
    assert(sf.frames === 9, JSON.stringify(sf));
  });
};
