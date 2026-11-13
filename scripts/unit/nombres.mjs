// Unit tests of «nombres»: the After Effects match-name table of src/core/aescript.ts covers the whole effect
// catalog (or says why not), every name in it is one After Effects 2024 really registers, and .jsx scripts reach
// the effects by match name and by AE's English / Spanish display names; what aescript reports back is AE's name.
import { existsSync, readFileSync } from 'node:fs';

// Optional list of After Effects 2024 match names (JSON: rows[].names), given with CINTA_AE_INVENTARIO
const INVENTARIO = process.env.CINTA_AE_INVENTARIO ?? '';
// Match names the list misses, each checked in After Effects 2024:
const BUILT_IN = {
  'ADBE Paint': 'the Paint effect of the Brush / Clone Stamp / Eraser tools',
  'APC Foam': 'Foam (CycoreFX)',
  'ADBE Color Balance (HLS)': 'Color Balance (HLS)',
  'ADBE RefineMatte': 'Refine Hard Matte',
  'ADBE RefineMatte2': 'Refine Soft Matte',
  'ADBE Samurai': 'Roto Brush & Refine Edge (applied by the Roto Brush tool)',
  'ADBE Gamma/Pedestal/Gain2': 'Gamma/Pedestal/Gain',
};

export default ({ test, ok, M, core }) => {
  const { AE_EFFECTS, AE_EFFECT_ALIASES, AE_EFFECT_NAMES, CINTA_ONLY_EFFECTS, AE_UNMAPPED_EFFECTS, aeMatchName, aeEffectId, Editor, newProject, runScriptSync: runScript } = core;
  const ids = new Set(M.FX.map((d) => d.id));

  test('nombres: cada efecto del catálogo tiene nombre de coincidencia de AE o está en la lista de solo Cinta / sin equivalente', () => {
    const mapped = new Set(Object.values(AE_EFFECTS));
    const missing = M.FX.filter((d) => !mapped.has(d.id) && !CINTA_ONLY_EFFECTS.includes(d.id) && !AE_UNMAPPED_EFFECTS[d.id]).map((d) => d.id);
    ok(!missing.length, `sin nombre de AE: ${missing.join(', ')}`);
    const both = [...CINTA_ONLY_EFFECTS, ...Object.keys(AE_UNMAPPED_EFFECTS)].filter((id) => mapped.has(id) || !ids.has(id));
    ok(!both.length, `en las listas pero con nombre de AE o fuera del catálogo: ${both.join(', ')}`);
    const orphan = Object.entries(AE_EFFECTS).filter(([, id]) => !ids.has(id)).map(([m]) => m);
    ok(!orphan.length, `nombres que apuntan a efectos que no existen: ${orphan.join(', ')}`);
  });

  test('nombres: ningún nombre de coincidencia repetido en aescript.ts ni compartido por dos efectos; uno solo «oficial» por efecto', () => {
    const src = readFileSync(new URL('../../src/core/aescript.ts', import.meta.url), 'utf8');
    // the table literal + the Object.assign blocks: every 'match name': 'id' pair, as merged by several agents
    const start = src.indexOf('export const AE_EFFECTS'), end = src.indexOf('export const AE_EFFECT_ALIASES');
    const region = src.slice(start, src.indexOf('};', start)) + src.slice(src.indexOf('Object.assign(AE_EFFECTS', start), end);
    const seen = new Map(), dup = [];
    for (const [, m, id] of region.matchAll(/'((?:[^'\\]|\\.)+)':\s*'([A-Za-z0-9]+)'/g)) { if (seen.has(m)) dup.push(`${m} (${seen.get(m)} / ${id})`); seen.set(m, id); }
    ok(!dup.length, `repetidos: ${dup.join(', ')}`);
    ok(seen.size === Object.keys(AE_EFFECTS).length, `${seen.size} en el código, ${Object.keys(AE_EFFECTS).length} en la tabla`);
    const real = new Map();
    for (const [m, id] of Object.entries(AE_EFFECTS)) {
      if (AE_EFFECT_ALIASES.has(m)) continue;
      // legacy twins of one plug-in (Gaussian Blur / Gaussian Blur 2) are fine; the first one is the reported one
      real.set(id, [...(real.get(id) ?? []), m]);
    }
    const multi = [...real].filter(([, ms]) => ms.length > 1).map(([id, ms]) => `${id}: ${ms.join(' | ')}`);
    ok(multi.length <= 1 && (!multi.length || multi[0].startsWith('gaussianBlur: ADBE Gaussian Blur 2')), multi.join('; '));
    for (const [id, ms] of real) ok(aeMatchName(id) === ms[0], `${id}: informa ${aeMatchName(id)}, no ${ms[0]}`);
  });

  test('nombres: todos los nombres de la tabla existen en After Effects 2024 (lista de nombres o integrados comprobados)', () => {
    if (!INVENTARIO || !existsSync(INVENTARIO)) { console.log(`      (sin CINTA_AE_INVENTARIO: no se comprueba contra la lista)`); return; }
    const inv = new Set(JSON.parse(readFileSync(INVENTARIO, 'utf8')).rows.flatMap((r) => r.names));
    const bad = Object.keys(AE_EFFECTS).filter((m) => !AE_EFFECT_ALIASES.has(m) && !inv.has(m) && !BUILT_IN[m]);
    ok(!bad.length, `no son nombres de AE 2024: ${bad.join(', ')}`);
    const stale = [...AE_EFFECT_ALIASES].filter((m) => inv.has(m) || !AE_EFFECTS[m]);
    ok(!stale.length, `alias que sí son nombres reales o no están en la tabla: ${stale.join(', ')}`);
    // every guess has the real name next to it
    for (const a of AE_EFFECT_ALIASES) ok(!AE_EFFECT_ALIASES.has(aeMatchName(AE_EFFECTS[a])), `${a}: falta el nombre real de ${AE_EFFECTS[a]}`);
    // and each real match name has its display names
    const noName = Object.keys(AE_EFFECTS).filter((m) => !AE_EFFECT_ALIASES.has(m) && !(AE_EFFECT_NAMES[m]?.[0] && AE_EFFECT_NAMES[m]?.[1]));
    ok(!noName.length, `sin nombre visible: ${noName.join(', ')}`);
  });

  test('nombres: búsqueda por nombre de coincidencia (sin distinguir mayúsculas) y por nombre visible en inglés y en español', () => {
    const cases = [
      ['ADBE Aud Reverb', 'audioReverb'], ['adbe aud reverb', 'audioReverb'], ['Reverb', 'audioReverb'], ['Reverberación', 'audioReverb'],
      ['CC Snow', 'snow'], ['CSRainfall', 'ccRainfall'], ['CC Rainfall', 'ccRainfall'], ['APC Foam', 'foam'], ['Espuma', 'foam'],
      ['Shadow/Highlight', 'shadowHighlight'], ['Sombra/iluminación', 'shadowHighlight'], ['Three-Way Color Corrector', 'threeWay'],
      ['Gaussian Blur', 'gaussianBlur'], ['Desenfoque gaussiano', 'gaussianBlur'], ['Levels', 'levels'], ['Transformar', 'transformFx'],
      ['Color Balance', 'colorBalance'], ['Color Balance (HLS)', 'colorBalanceHLS'], ['Inner/Outer Key', 'innerOuterKey'], ['Paint', 'paint'],
    ];
    for (const [n, id] of cases) ok(aeEffectId(n) === id, `${n} → ${aeEffectId(n)} (esperado ${id})`);
    ok(aeEffectId('Rayo eléctrico') === undefined && aeEffectId('No existe') === undefined, 'solo nombres de AE');
    for (const [m, id] of [['shadowHighlight', 'ADBE ShadowHighlight'], ['foam', 'APC Foam'], ['vignette', 'CS Vignette'], ['ccCrossBlur', 'CS CrossBlur'], ['cardWipe', 'APC CardWipeCam'], ['audioTone', 'ADBE Aud Tone']]) ok(aeMatchName(m) === id, `${m}: ${aeMatchName(m)}`);
    ok(aeMatchName('toonBands') === undefined, 'los efectos propios no tienen nombre de AE');
  });

  test('nombres: un .jsx añade efectos nuevos por nombre de coincidencia y visible; matchName y effect() devuelven los de AE', () => {
    const e = new Editor(newProject());
    const r = runScript(e, `var c = app.project.items.addComp("N", 160, 90, 1, 2, 25); var l = c.layers.addSolid([1, 1, 1], "S", 160, 90, 1);
var fx = l.property("ADBE Effect Parade");
var a = fx.addProperty("CC Simple Wire Removal"), b = fx.addProperty("ADBE Aud Reverb"), d = fx.addProperty("APC Foam"), g = fx.addProperty("ADBE Shadow/Highlight");
fx.addProperty("Barrido de cartas"); fx.addProperty("Color Balance (HLS)");
$.writeln(fx.numProperties + "|" + a.matchName + "|" + b.matchName + "|" + d.matchName + "|" + g.matchName + "|" + fx.property(5).matchName + "|" + fx.property(6).matchName);
$.writeln(fx.property("Shadow/Highlight").matchName + "|" + fx.property("CSRainfall") + "|" + fx.property("Reverberación").matchName + "|" + fx.canAddProperty("CS LineSweep") + "|" + fx.canAddProperty("Cinta Inventado"));`);
    ok(r.ok, JSON.stringify(r.error));
    const [l1, l2] = r.output.trim().split('\n');
    ok(l1 === '6|CC Simple Wire Removal|ADBE Aud Reverb|APC Foam|ADBE ShadowHighlight|APC CardWipeCam|ADBE Color Balance (HLS)', l1);
    ok(/^ADBE ShadowHighlight\|(null|undefined)\|ADBE Aud Reverb\|true\|false$/.test(l2), l2);
    const L = e.project.comps?.[0]?.layers?.[0] ?? Object.values(e.project.comps ?? {})[0]?.layers?.[0];
    ok(L && L.effects.map((f) => f.fx).join() === 'ccSimpleWireRemoval,audioReverb,foam,shadowHighlight,cardWipe,colorBalanceHLS', JSON.stringify(L?.effects?.map((f) => f.fx)));
  });
};
