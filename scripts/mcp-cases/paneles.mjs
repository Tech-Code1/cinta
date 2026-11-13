// MCP cases of the «paneles» line: a comp seen from 3D views (comp_view_frame), the flowchart as data, the media
// browser and the metadata of a file.
import { dirname } from 'node:path';
export default async ({ test, call, assert, imgOf, W }) => {
  const VP = W('paneles.cinta');
  const red = (img) => { let n = 0; for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) { const p = img.at((x + 0.5) / img.width, (y + 0.5) / img.height); if (p[0] > 150 && p[1] < 80 && p[2] < 80) n++; } return n; };

  await test('paneles: comp_view_frame — una tarjeta 3D de frente se ve; desde arriba queda de canto; malla de cámara', async () => {
    await call('project_new', { path: VP, width: 400, height: 200, fps: 30 });
    await call('comp_new', { project: VP, name: 'Vistas', width: 400, height: 200, fps: 30, duration: 1, bg: '#000000' });
    const card = (await call('layer_add', { project: VP, comp: 'Vistas', type: 'solid', color: '#ff0000', width: 100, height: 100, name: 'Tarjeta' })).layer.id;
    await call('layer_set', { project: VP, comp: 'Vistas', layer: card, three_d: true });
    await call('layer_add', { project: VP, comp: 'Vistas', type: 'camera', name: 'Cámara 1' });
    const act = await call('comp_view_frame', { project: VP, comp: 'Vistas', view: 'active', width: 400 });
    const front = await call('comp_view_frame', { project: VP, comp: 'Vistas', view: 'front', width: 400 });
    const top = await call('comp_view_frame', { project: VP, comp: 'Vistas', view: 'top', width: 400 });
    const [na, nf, nt] = [red(imgOf(act)), red(imgOf(front)), red(imgOf(top))];
    assert(na > 400 && nf > 50 && nt < nf / 4, `rojo: activa ${na}, frontal ${nf}, superior ${nt}`);
    assert(front.name === 'Parte frontal' && front.state.scale < 1 && top.wireframes.some((w) => w.name === 'Cámara 1') && top.segments > 20, JSON.stringify({ n: front.name, w: top.wireframes, s: top.segments }));
    const c1 = await call('comp_view_frame', { project: VP, comp: 'Vistas', view: 'custom1', width: 400, orbit: [-30, 20] });
    assert(c1.state.yaw === -30 && c1.state.pitch === 20 && red(imgOf(c1)) > 30, JSON.stringify(c1.state));
  });

  await test('paneles: comp_flowchart — comp anidada, capas y material de archivo', async () => {
    await call('comp_new', { project: VP, name: 'Exterior', width: 400, height: 200, fps: 30, duration: 1 });
    const vid0 = (await call('comp_get', { project: VP })).comps.find((c) => c.name === 'Vistas').id;
    await call('layer_add', { project: VP, comp: 'Exterior', type: 'comp', comp_id: vid0 });
    const g = await call('comp_flowchart', { project: VP });
    const comps = g.nodes.filter((n) => n.kind === 'comp').map((n) => n.name).sort().join();
    assert(comps === 'Exterior,Vistas' && g.nodes.some((n) => n.kind === 'layer' && n.name === 'Tarjeta'), JSON.stringify(g.nodes));
    const vid = g.nodes.find((n) => n.kind === 'comp' && n.name === 'Vistas').id, ext = g.nodes.find((n) => n.kind === 'comp' && n.name === 'Exterior').id;
    const nested = g.edges.some((e) => e.from === vid && g.edges.some((f) => f.from === e.to && f.to === ext));
    assert(nested, JSON.stringify(g.edges));
    const only = await call('comp_flowchart', { project: VP, comp: 'Vistas', layers: false });
    assert(only.nodes.length === 1 && only.nodes[0].name === 'Vistas', JSON.stringify(only.nodes));
  });

  await test('paneles: media_browse y media_metadata de un vídeo', async () => {
    const places = await call('media_browse', {});
    assert(places.places.some((p) => p.name === 'Directorio de inicio'), JSON.stringify(places));
    const r = await call('media_browse', { folder: dirname(VP) });
    const bars = r.entries.find((e) => e.name === 'bars.mp4');
    assert(bars?.kind === 'video' && !r.entries.some((e) => e.kind === 'other'), JSON.stringify(r.entries.slice(0, 5)));
    const m = await call('media_metadata', { path: bars.path });
    const g = (n) => m.groups.find((x) => x.name === n);
    assert(g('Vídeo 1').rows.some(([k, v]) => k === 'Dimensiones' && v === '640 × 360') && g('Audio 1') && g('Formato').rows.some(([k]) => k === 'Duración'), JSON.stringify(m.groups.map((x) => x.name)));
  });
};
