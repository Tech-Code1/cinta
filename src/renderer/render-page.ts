// Hidden render window: draws composition frames with the same engine as the preview and streams them to
// the main process (raw RGBA for ffmpeg, or a PNG for a still).
import { MotionRenderer } from '../motion-render/render';
import { MediaSources } from '../motion-render/sources';
import { ctx2d, mk } from '../motion-render/fx';
import type { Project } from '../core/model';
import { findComp } from '../core/motion/model';
import { runVectorTask, type VectorTask } from '../motion-render/vectortasks';

declare global { interface Window { cinta: { invoke: (c: string, ...a: unknown[]) => Promise<unknown>; on: (c: string, fn: (...a: unknown[]) => void) => () => void } } }
interface JobMsg { id: string; project: Project; compId: string; from?: number; frames?: number; fps?: number; scale: number; opaque?: boolean; sequencePath?: string; still?: number; mbSamples?: number; proxies?: 'current' | 'none' | 'all' | 'comps'; guides?: boolean; size?: [number, number]; task?: VectorTask }

const sources = new MediaSources();
const renderer = new MotionRenderer(sources);

window.cinta.on('render:job', async (m) => {
  const j = m as JobMsg;
  try {
    const comp = findComp(j.project.comps, j.compId);
    const opts = { scale: j.scale, sequencePath: j.sequencePath, mbSamples: j.mbSamples, proxies: j.proxies, guides: j.guides };
    // «vectores»: text outlines / auto-trace for the MCP server
    if (j.task) { await window.cinta.invoke('render:done', j.id, null, await runVectorTask(renderer, j.project, comp, j.task)); return; }
    if (j.still !== undefined) {
      const cv = await renderer.render(j.project, comp, j.still, opts);
      const blob = await new Promise<Blob>((ok) => cv.toBlob((b) => ok(b!), 'image/png'));
      await window.cinta.invoke('render:done', j.id, null, { png: new Uint8Array(await blob.arrayBuffer()), errors: renderer.errors });
      return;
    }
    // video encoders need even sizes; the disk cache asks for the preview's own size
    const [W, H] = j.size ?? [Math.max(2, Math.round((comp.width * j.scale) / 2) * 2), Math.max(2, Math.round((comp.height * j.scale) / 2) * 2)];
    const out = mk(W, H);
    const g = ctx2d(out, true);
    let renderMs = 0, readMs = 0, sendMs = 0;
    const errors = new Set<string>();
    let pending: Promise<unknown> = Promise.resolve(true);
    for (let i = 0; i < (j.frames ?? 1); i++) {
      const t = (j.from ?? 0) + i / (j.fps ?? comp.fps);
      let t0 = performance.now();
      const cv = await renderer.render(j.project, comp, t, opts);
      renderMs += performance.now() - t0; t0 = performance.now();
      for (const er of renderer.errors) errors.add(er);
      g.clearRect(0, 0, W, H);
      if (j.opaque) { g.fillStyle = comp.bg; g.fillRect(0, 0, W, H); }
      g.drawImage(cv, 0, 0, W, H);
      const data = g.getImageData(0, 0, W, H).data;
      readMs += performance.now() - t0; t0 = performance.now();
      // the previous frame is still travelling to ffmpeg while this one was drawn: wait for it, then send
      if ((await pending) === false) break;
      sendMs += performance.now() - t0;
      pending = window.cinta.invoke('render:frame', j.id, i, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) as Promise<unknown>;
    }
    const n = j.frames ?? 1;
    await pending;
    sources.pauseAll();
    await window.cinta.invoke('render:done', j.id, null, { frames: n, renderMs: Math.round(renderMs / n), readMs: Math.round(readMs / n), sendMs: Math.round(sendMs / n), prepMs: Math.round(renderer.prepMs / n), errors: [...errors], layers: Object.fromEntries(Object.entries(renderer.profile).map(([k, v]) => [k, Math.round(v / n)])) });
    renderer.profile = {}; renderer.prepMs = 0;
  } catch (e) {
    await window.cinta.invoke('render:done', j.id, String((e as Error)?.stack ?? e));
  }
});
void window.cinta.invoke('render:ready');
