// Footage proxies (After Effects' File > Create Proxy): a smaller copy of a video or picture that the advanced
// mode draws instead of the original while the proxy is on — scaled back to the original size, so layouts do
// not move. Videos become H.264 with a keyframe every 10 frames (fast scrubbing), without sound (the sound
// still comes from the original).
import { mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { runFfmpeg } from './ffmpeg';
import type { MediaItem } from './model';

export async function createFootageProxy(m: MediaItem, dir: string, scale = 0.5, onProgress?: (f: number) => void): Promise<{ path: string; width: number; height: number }> {
  if (m.kind === 'audio' || (!m.hasVideo && m.kind !== 'image')) throw new Error('Un archivo de solo audio no necesita proxy.');
  if (!(scale > 0 && scale < 1)) throw new Error('La escala del proxy va entre 0 y 1 (0.5 = mitad, 0.25 = cuarto).');
  mkdirSync(dir, { recursive: true });
  const w = Math.max(2, Math.round((m.width * scale) / 2) * 2), h = Math.max(2, Math.round((m.height * scale) / 2) * 2);
  const stem = `${basename(m.path, extname(m.path))}_proxy_${Math.round(scale * 100)}`;
  if (m.kind === 'image') {
    const out = join(dir, `${stem}.png`);
    await runFfmpeg(['-i', m.path, '-vf', `scale=${w}:${h}:flags=lanczos`, '-frames:v', '1', out]);
    return { path: out, width: w, height: h };
  }
  const out = join(dir, `${stem}.mp4`);
  await runFfmpeg(['-i', m.path, '-an', '-vf', `scale=${w}:${h}:flags=bicubic`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '10', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { duration: m.duration, onProgress });
  return { path: out, width: w, height: h };
}
