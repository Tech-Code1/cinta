// MCP case of «nombres»: an After Effects .jsx run with run_script adds effects that only got their AE match name
// in this round (CycoreFX with «CS» names, an audio effect, a keyer) and the comp still renders; matchName reports
// After Effects' own names.
import { writeFileSync } from 'node:fs';

export default async ({ test, call, assert, imgOf, W }) => {
  const NP = W('nombres.cinta');
  await test('nombres: run_script con un .jsx añade CC Snowfall, CC Toner, Extraer y Reverberación por nombre de coincidencia', async () => {
    await call('project_new', { path: NP, width: 160, height: 90, fps: 10 });
    await call('comp_new', { project: NP, name: 'Nombres', width: 160, height: 90, fps: 10, duration: 2, bg: '#000000' });
    await call('layer_add', { project: NP, comp: 'Nombres', type: 'solid', color: '#3060c0', name: 'Fondo' });
    const before = imgOf(await call('comp_frame', { project: NP, comp: 'Nombres', time: 1, width: 160 }));
    const jsx = W('nombres.jsx');
    writeFileSync(jsx, [
      'var comp = app.project.activeItem;',
      'var fx = comp.layer(1).property("ADBE Effect Parade");',
      'var names = ["CSSnowfall", "CC Toner", "ADBE Extract", "ADBE Aud Reverb"];',
      'var out = [];',
      'for (var i = 0; i < names.length; i++) out.push(fx.addProperty(names[i]).matchName);',
      '$.writeln(out.join("|") + "|" + fx.numProperties);',
    ].join('\n'));
    const r = await call('run_script', { project: NP, comp: 'Nombres', file: jsx });
    assert(r.ok && r.log === 'CSSnowfall|CC Toner|ADBE Extract|ADBE Aud Reverb|4' && r.changes.effects === 4, JSON.stringify(r));
    const g = JSON.stringify(await call('comp_get', { project: NP, comp: 'Nombres' }));
    for (const id of ['ccSnowfall', 'ccToner', 'extract', 'audioReverb']) assert(g.includes(`"${id}"`), `${id} no está en la capa`);
    const f = await call('comp_frame', { project: NP, comp: 'Nombres', time: 1, width: 160 });
    assert(!f.layerErrors, `capas con error: ${JSON.stringify(f.layerErrors)}`);
    const after = imgOf(f);
    let diff = 0;
    for (let y = 0; y < 9; y++) for (let x = 0; x < 16; x++) { const a = before.at((x + 0.5) / 16, (y + 0.5) / 9), b = after.at((x + 0.5) / 16, (y + 0.5) / 9); diff = Math.max(diff, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])); }
    assert(diff > 30, `los efectos no cambian la imagen (${diff})`);
  });
};
