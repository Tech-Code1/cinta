// Portable ffmpeg/ffprobe: bundled npm binaries, unpacked from the asar in packaged builds.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setPriority } from 'node:os';
import { dirname, join } from 'node:path';

const unpacked = (p: string) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function findBin(pkg: string, exe: string, env: string): string {
  const fromEnv = process.env[env];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // dist/main/*.js → <root>/node_modules/<pkg>/<exe>; also works from src via require.resolve
  const roots = [join(__dirname, '..', '..'), join(__dirname, '..'), process.cwd()];
  for (const r of roots) {
    const p = unpacked(join(r, 'node_modules', pkg, exe));
    if (existsSync(p)) return p;
  }
  try {
    const p = unpacked(join(dirname(require.resolve(`${pkg}/package.json`)), exe));
    if (existsSync(p)) return p;
  } catch { /* not resolvable */ }
  throw new Error(`No se encontró ${exe} (paquete ${pkg})`);
}

let ff: string | null = null, fp: string | null = null;
export const ffmpegPath = () => (ff ??= findBin('ffmpeg-static', 'ffmpeg.exe', 'CINTA_FFMPEG'));
export const ffprobePath = () => (fp ??= findBin('@ffprobe-installer/win32-x64', 'ffprobe.exe', 'CINTA_FFPROBE'));

export interface RunOptions {
  cwd?: string;
  /** total output seconds, for progress */
  duration?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** collect stdout as a Buffer */
  stdout?: 'buffer' | 'ignore' | ((chunk: Buffer) => void);
  lowPriority?: boolean;
}

export interface RunResult {
  code: number;
  stderr: string;
  stdout: Buffer;
}

function lower(child: ChildProcess) {
  try { if (child.pid) setPriority(child.pid, 10); } catch { /* not allowed */ }
}

/** Runs ffmpeg; rejects with the tail of stderr when it fails. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', ...(opts.onProgress ? ['-progress', 'pipe:2', '-stats_period', '0.25'] : []), ...args], opts);
}

export function runFfprobe(args: string[]): Promise<RunResult> {
  return run(ffprobePath(), ['-hide_banner', ...args], {});
}

function run(bin: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('Cancelado'));
    const child = spawn(bin, args, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (opts.lowPriority !== false) lower(child);
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      if (typeof opts.stdout === 'function') opts.stdout(d);
      else if (opts.stdout !== 'ignore') out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      err += s;
      if (err.length > 400_000) err = err.slice(-200_000);
      if (opts.onProgress && opts.duration) {
        const m = /out_time_us=(\d+)/g;
        let hit: RegExpExecArray | null, last = -1;
        while ((hit = m.exec(s))) last = +hit[1];
        if (last >= 0) opts.onProgress(Math.min(1, last / 1e6 / opts.duration));
      }
    });
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new Error('Cancelado'));
      const res = { code: code ?? -1, stderr: err, stdout: Buffer.concat(out) };
      if (code !== 0) {
        const tail = err.split(/\r?\n/).filter((l) => l && !/^(frame|fps|stream_|bitrate|total_size|out_time|dup_frames|drop_frames|speed|progress)=/.test(l)).slice(-12).join('\n');
        const e = new Error(`ffmpeg falló (código ${code}):\n${tail}`) as Error & { result: RunResult };
        e.result = res;
        return reject(e);
      }
      resolve(res);
    });
  });
}

/** Spawns ffmpeg for streaming (preview); caller owns the process. */
export function spawnFfmpeg(args: string[], cwd?: string, lowPriority = true): ChildProcess {
  const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (lowPriority) lower(child);
  return child;
}
