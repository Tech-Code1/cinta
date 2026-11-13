// Self-test of automatic updates: a local web folder plays the part of GitHub Releases (latest.yml + installer).
// With version 1.0.0 published Cinta says it is up to date; with 99.0.0 it offers it, downloads it and checks its
// sha512. Nothing is installed: in the self-test the download goes to %LOCALAPPDATA%\cinta-updater-test, which is
// removed afterwards, and install-on-quit is off.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { answers, asked } from './testdialogs';
import { checkForUpdates } from './updates';

interface Ctx { dir: string; step: (name: string, fn: () => Promise<void>) => Promise<void>; assert: (c: unknown, m: string) => void }

export async function updateSteps({ dir, step, assert }: Ctx) {
  const feedDir = join(dir, 'actualizaciones');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(feedDir, { recursive: true });
  const exe = randomBytes(256 * 1024), sha = createHash('sha512').update(exe).digest('base64');
  const publish = (v: string) => {
    const name = `Cinta-Setup-${v}.exe`;
    writeFileSync(join(feedDir, name), exe);
    writeFileSync(join(feedDir, 'latest.yml'), `version: ${v}\nfiles:\n  - url: ${name}\n    sha512: ${sha}\n    size: ${exe.length}\npath: ${name}\nsha512: ${sha}\nreleaseDate: '2026-11-12T00:00:00.000Z'\nreleaseNotes: '<ul><li>Novedad de prueba</li></ul>'\n`);
  };
  const server = createServer((req, res) => {
    const f = join(feedDir, decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, ''));
    if (!f.startsWith(feedDir) || !existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-length': String(readFileSync(f).length) }).end(readFileSync(f));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const prev = process.env.CINTA_UPDATE_URL;
  process.env.CINTA_UPDATE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const cache = join(process.env.LOCALAPPDATA ?? '', 'cinta-updater-test');
  try {
    await step('Actualizaciones: con la misma versión publicada, «Buscar actualizaciones…» dice que Cinta está al día', async () => {
      publish('1.0.0');
      asked.length = 0;
      const r = await checkForUpdates(true);
      assert(r === 'Cinta está al día.', r);
      assert(asked.includes('message:Cinta está al día.'), asked.join(' | '));
    });
    await step('Actualizaciones: una versión nueva se ofrece con sus novedades, se descarga y se comprueba su sha512', async () => {
      publish('99.0.0');
      asked.length = 0;
      answers.message.push(0, 1); // Descargar, then «Al cerrar Cinta»
      const r = await checkForUpdates(true);
      assert(r === 'Cinta 99.0.0 descargada.', r);
      assert(asked.includes('message:Hay una nueva versión de Cinta: 99.0.0'), asked.join(' | '));
      await new Promise((ok) => setTimeout(ok, 300));
      assert(asked.includes('message:Cinta 99.0.0 está lista para instalarse.'), asked.join(' | '));
      const got = join(cache, 'pending', 'Cinta-Setup-99.0.0.exe');
      assert(existsSync(got) && createHash('sha512').update(readFileSync(got)).digest('base64') === sha, 'instalador descargado distinto');
    });
  } finally {
    answers.message.length = 0;
    server.close();
    if (prev === undefined) delete process.env.CINTA_UPDATE_URL; else process.env.CINTA_UPDATE_URL = prev;
    rmSync(cache, { recursive: true, force: true });
  }
}
