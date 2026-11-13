// Unit tests of the motion cache cap: least recently used renders go first, recent ones are always kept, and a
// cached file that is used again counts as recent.
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default ({ test, ok, core }) => {
  test('caché de composiciones: se recorta a su límite borrando lo usado hace más tiempo; lo reciente se conserva', () => {
    const prev = process.env.CINTA_CACHE;
    const root = mkdtempSync(join(tmpdir(), 'cinta-unit-cache-'));
    process.env.CINTA_CACHE = root;
    try {
      const dir = core.cacheDir('motion');
      const day = 864e5, now = Date.now();
      const mk = (n, ageDays) => { const p = join(dir, n); writeFileSync(p, Buffer.alloc(1000)); const t = new Date(now - ageDays * day); utimesSync(p, t, t); return p; };
      const a = mk('comp_a.mov', 10), b = mk('comp_b.mov', 5), c = mk('comp_c.mov', 3), d = mk('comp_d.mov', 0.5);
      // used again → recent
      core.touchCached(a);
      const r = core.pruneMotionCache(2500);
      ok(r.removed === 2 && r.bytes === 2000, `borra dos (${JSON.stringify(r)})`);
      ok(existsSync(a) && existsSync(d), 'conserva los usados hace poco');
      ok(!existsSync(b) && !existsSync(c), 'borra los más antiguos');
      // under the cap nothing goes; files used in the last two days are kept even over the cap
      ok(core.pruneMotionCache(1e9).removed === 0, 'bajo el límite no borra nada');
      ok(core.pruneMotionCache(0).removed === 0 && existsSync(a) && existsSync(d), 'nunca borra lo usado en los dos últimos días');
      ok(core.motionCached('comp_d.mov') === d, 'motionCached devuelve la ruta de la caché');
      ok(core.motionCacheCap() === 5 * 2 ** 30, 'límite por defecto: 5 GB');
    } finally {
      if (prev === undefined) delete process.env.CINTA_CACHE; else process.env.CINTA_CACHE = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
};
