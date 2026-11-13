// Media for the motion renderer: video frames through <video> elements (exact seek for stills and export,
// free-running playback for the live preview) and images, served by the cinta-media: protocol.
import type { Aux, Need, Pcm, Sources } from './render';

export const mediaUrl = (path: string) => `cinta-media://f/${encodeURIComponent(path)}`;

/** EXR channels from the main process: [u32 json length][json][padding to 4][u32 words per channel]. */
async function fetchAux(url: string): Promise<Aux | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) { console.warn('EXR:', await r.text()); return null; }
    const buf = await r.arrayBuffer();
    const n = new DataView(buf).getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as { w: number; h: number; channels: { name: string; type: number }[]; ids?: number[] };
    let off = 4 + n + ((4 - ((4 + n) % 4)) % 4);
    const size = head.w * head.h, map = new Map<string, { bits: Uint32Array; f: Float32Array; type: number }>();
    for (const c of head.channels) { map.set(c.name, { bits: new Uint32Array(buf, off, size), f: new Float32Array(buf, off, size), type: c.type }); off += size * 4; }
    return { w: head.w, h: head.h, names: head.channels.map((c) => c.name), get: (name) => map.get(name) ?? null, ...(head.ids ? { ids: new Set(head.ids) } : {}) };
  } catch (e) { console.warn('EXR:', e); return null; }
}

interface V { el: HTMLVideoElement; path: string; ready: Promise<void>; lastTime: number }

export class MediaSources implements Sources {
  private videos = new Map<string, V>();
  private images = new Map<string, HTMLImageElement>();
  private current = new Map<string, CanvasImageSource>();
  private sounds = new Map<string, Promise<Pcm | null>>();
  private soundsReady = new Map<string, Pcm | null>();
  /** 'exact': every frame is seeked and awaited; 'live': videos play and are only corrected when they drift */
  mode: 'exact' | 'live' = 'exact';
  rate = 1;

  async prepare(needs: Need[]): Promise<void> {
    this.current.clear();
    const used = new Set<string>();
    await Promise.all(needs.map(async (n) => {
      if (n.kind === 'aux') {
        if (!this.auxes.has(n.key)) this.auxes.set(n.key, fetchAux(n.path));
        this.auxReady.set(n.key, await this.auxes.get(n.key)!);
        if (this.auxes.size > 24) { const k = this.auxes.keys().next().value!; this.auxes.delete(k); this.auxReady.delete(k); }
        return;
      }
      if (n.kind === 'audio') {
        // decoded once per file (mono, the file's own rate) and kept
        if (!this.sounds.has(n.path)) this.sounds.set(n.path, decodeSound(n.path));
        this.soundsReady.set(n.path, await this.sounds.get(n.path)!);
        return;
      }
      used.add(n.key);
      if (n.kind === 'image') {
        const img = await this.image(n.path);
        if (img) this.current.set(n.key, img);
        return;
      }
      const v = this.video(n.key, n.path);
      await v.ready;
      const dur = v.el.duration || 0;
      // stay a hair before the end (seeking to the duration itself shows no frame), not a whole 25 fps frame:
      // at 30 fps or more that hid the last frame
      const want = Math.max(0, Math.min(n.time, Math.max(0, dur - 0.005)));
      if (this.mode === 'live') {
        if (v.el.paused) { v.el.playbackRate = this.rate; void v.el.play().catch(() => {}); }
        if (Math.abs(v.el.currentTime - want) > 0.25) await seek(v.el, want);
      } else {
        if (!v.el.paused) v.el.pause();
        if (Math.abs(v.lastTime - want) > 1e-4 || Math.abs(v.el.currentTime - want) > 0.02) { await seek(v.el, want + 0.001); v.lastTime = want; }
      }
      this.current.set(n.key, v.el);
    }));
    // stop videos that are no longer on screen
    for (const [k, v] of this.videos) if (!used.has(k) && !v.el.paused) v.el.pause();
  }

  audio(path: string): Pcm | null { return this.soundsReady.get(path) ?? null; }
  private auxes = new Map<string, Promise<Aux | null>>();
  private auxReady = new Map<string, Aux | null>();
  aux(key: string): Aux | null { return this.auxReady.get(key) ?? null; }

  frame(key: string): CanvasImageSource | null {
    return this.current.get(key) ?? null;
  }

  pauseAll() { for (const v of this.videos.values()) v.el.pause(); }
  dispose() { for (const v of this.videos.values()) { v.el.pause(); v.el.removeAttribute('src'); v.el.load(); } this.videos.clear(); this.images.clear(); }

  private video(key: string, path: string): V {
    let v = this.videos.get(key);
    if (v && v.path === path) return v;
    if (v) { v.el.pause(); v.el.removeAttribute('src'); }
    const el = document.createElement('video');
    el.crossOrigin = 'anonymous';
    el.muted = true;
    el.preload = 'auto';
    el.playsInline = true;
    el.src = mediaUrl(path);
    const ready = new Promise<void>((ok) => {
      if (el.readyState >= 2) return ok();
      const done = () => { el.removeEventListener('loadeddata', done); el.removeEventListener('error', done); ok(); };
      el.addEventListener('loadeddata', done);
      el.addEventListener('error', done);
    });
    v = { el, path, ready, lastTime: -1 };
    this.videos.set(key, v);
    return v;
  }

  private image(path: string): Promise<HTMLImageElement | null> {
    const have = this.images.get(path);
    if (have?.complete) return Promise.resolve(have);
    const img = have ?? new Image();
    if (!have) { img.crossOrigin = 'anonymous'; img.src = mediaUrl(path); this.images.set(path, img); }
    return img.decode().then(() => img, () => null);
  }
}

async function decodeSound(path: string): Promise<Pcm | null> {
  try {
    const buf = await (await fetch(mediaUrl(path))).arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const ab = await ctx.decodeAudioData(buf);
    const data = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) { const ch = ab.getChannelData(c); for (let i = 0; i < data.length; i++) data[i] += ch[i] / ab.numberOfChannels; }
    return { data, rate: ab.sampleRate };
  } catch { return null; }
}

function seek(el: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((ok) => {
    let done = false;
    const finish = () => { if (done) return; done = true; el.removeEventListener('seeked', onSeeked); clearTimeout(timer); ok(); };
    const onSeeked = () => {
      // wait until the decoded frame is actually presented
      const rv = (el as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (rv && !el.paused) rv.call(el, () => finish());
      else finish();
    };
    const timer = setTimeout(finish, 3000);
    el.addEventListener('seeked', onSeeked);
    el.currentTime = t;
  });
}
