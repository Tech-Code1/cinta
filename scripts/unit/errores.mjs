// Unit tests of the error log: anything thrown becomes an entry, the user's home folder is hidden, the file is
// rotated at its size limit and the same error gives the same key (one dialog, not hundreds).
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export default ({ test, ok, core }) => {
  test('registro de errores: Error, texto u objeto; oculta la carpeta del usuario; sin repetir el mensaje en la pila', () => {
    const e = new TypeError(`no existe ${join(homedir(), 'Videos', 'a.mp4')}`);
    const x = core.describeError(e, 'principal');
    ok(x.message.startsWith('TypeError: no existe ~'), x.message);
    ok(!x.message.includes(homedir()) && !x.stack.includes(homedir()), 'carpeta del usuario visible');
    ok(!x.stack.includes('TypeError'), `pila repite el mensaje: ${x.stack.split('\n')[0]}`);
    ok(core.describeError('falló', 'promesa').message === 'falló', 'texto');
    ok(core.describeError({ a: 1 }, 'promesa').message === '{"a":1}', 'objeto');
    ok(core.describeError(undefined, 'promesa').message === 'undefined', 'undefined');
    ok(core.errorKey(x) === core.errorKey(core.describeError(e, 'principal')), 'misma clave');
  });
  test('registro de errores: se añade al archivo y al pasar del límite se rota (una copia antigua)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cinta-unit-errlog-'));
    try {
      const x = core.describeError(new Error('uno'), 'principal');
      const f = core.appendErrorLog(dir, x, 200);
      ok(readFileSync(f, 'utf8').includes('(principal) Error: uno'), 'contenido');
      for (let i = 0; i < 20; i++) core.appendErrorLog(dir, core.describeError(new Error(`e${i}`), 'ventana'), 200);
      ok(existsSync(join(dir, 'errores.1.log')), 'sin rotar');
      ok(statSync(f).size < 2000, `tamaño ${statSync(f).size}`);
      ok(readFileSync(f, 'utf8').includes('e19'), 'falta el último');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
};
