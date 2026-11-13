// Unit tests of the update policy: version order, skipped versions, how often to check and where updates can't run.
export default ({ test, ok, core }) => {
  test('actualizaciones: orden de versiones (1.2.10 > 1.2.9, final > beta, «v» opcional)', () => {
    const c = core.compareVersions;
    ok(c('1.2.10', '1.2.9') === 1 && c('1.0.0', '1.0.0') === 0 && c('v2.0.0', '1.9.9') === 1, 'números');
    ok(c('1.0.0', '1.0.0-beta.1') === 1 && c('1.0.0-beta.2', '1.0.0-beta.1') === 1 && c('1.0', '1.0.0') === 0, 'previas');
  });
  test('actualizaciones: se ofrece solo lo más nuevo; «Omitir esta versión» la salta salvo al buscar a mano', () => {
    const s = { auto: true, skip: '1.1.0' };
    ok(!core.shouldOffer('1.0.0', '1.0.0', s, true) && !core.shouldOffer('1.1.0', '1.0.5', s, true), 'igual o más antigua');
    ok(!core.shouldOffer('1.0.0', '1.1.0', s, false) && core.shouldOffer('1.0.0', '1.1.0', s, true), 'omitida');
    ok(core.shouldOffer('1.0.0', '1.2.0', s, false), 'más nueva que la omitida');
  });
  test('actualizaciones: comprobación automática cada 6 h y nunca si está desactivada', () => {
    const now = Date.UTC(2026, 10, 12);
    ok(core.checkDue({ auto: true }, now) && !core.checkDue({ auto: false }, now), 'interruptor');
    ok(!core.checkDue({ auto: true, last: now - 3600e3 }, now) && core.checkDue({ auto: true, last: now - 7 * 3600e3 }, now), 'intervalo');
    ok(core.checkDue({ auto: true, last: now + 864e5 }, now), 'reloj atrasado');
  });
  test('actualizaciones: no en la versión portátil, en desarrollo sin servidor ni en las pruebas', () => {
    const b = core.updateBlock;
    ok(b({ packaged: true, portable: false, test: false }) === null, 'instalada');
    ok(b({ packaged: true, portable: true, test: false }) === 'portable' && b({ packaged: false, portable: false, test: false }) === 'dev', 'portátil / desarrollo');
    ok(b({ packaged: false, portable: false, test: false, feed: 'http://x/' }) === null && b({ packaged: true, portable: false, test: true }) === 'test', 'servidor / pruebas');
  });
  test('actualizaciones: las novedades de GitHub (HTML) se muestran como texto', () => {
    ok(core.notesText('<h2>1.1</h2><ul><li>Uno &amp; dos</li><li>Tres</li></ul>') === '1.1\n• Uno & dos\n• Tres', JSON.stringify(core.notesText('<h2>1.1</h2><ul><li>Uno &amp; dos</li><li>Tres</li></ul>')));
    ok(core.notesText([{ version: '1.1.0', note: 'a' }, { version: '1.2.0', note: 'b' }]).includes('1.2.0\nb'), 'varias versiones');
    ok(core.notesText('x'.repeat(2000)).length === 1201, 'recorte');
  });
};
