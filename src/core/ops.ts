// Editing operations with undo/redo. Used by the app (main process) and the MCP server.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { ANIMATIONS, ASPECTS, CALLOUTS, FILTERS, MASKS, PAN_ZOOM, PIP_LAYOUTS, STICKERS, TITLES, TRANSITIONS, findIn } from './catalog';
import { cacheDir } from './graphics';
import { runFfmpeg } from './ffmpeg';
import {
  clipDuration, clipEnd, defaultTitle, even, mainTimeMap, mainTrack, newClip, newProject, newTrack, packMain, projectDuration, r3, trackClips, uid, validateProject,
  type Clip, type MediaItem, type Project, type ProjectSettings, type TitleStyle, type Track, type TrackKind,
} from './model';
import { probeMedia } from './probe';
import { footageItem, needsConversion } from './footage';
import { validateComps } from './motion/model';

const HISTORY_MAX = 100;
export const DEFAULT_IMAGE_SECONDS = 4;
export const DEFAULT_TITLE_SECONDS = 4;

export class Editor {
  project: Project;
  path: string | null = null;
  private past: string[] = [];
  private future: string[] = [];
  /** called after every change (app: re-render the UI) */
  onChange?: (label: string) => void;

  constructor(p?: Project) {
    this.project = p ?? newProject();
  }

  // ───────────────────────── persistence ─────────────────────────
  static load(path: string, withHistory = false): Editor {
    const abs = resolve(path);
    const e = new Editor(validateComps(validateProject(JSON.parse(readFileSync(abs, 'utf8')))));
    e.path = abs;
    if (withHistory) {
      try {
        const h = JSON.parse(readFileSync(`${abs}.history`, 'utf8')) as { past: string[]; future: string[] };
        e.past = h.past ?? [];
        e.future = h.future ?? [];
      } catch { /* no history yet */ }
    }
    return e;
  }

  save(path = this.path, withHistory = false): string {
    if (!path) throw new Error('El proyecto no tiene ruta: indique dónde guardarlo.');
    const abs = resolve(path.toLowerCase().endsWith('.cinta') ? path : `${path}.cinta`);
    mkdirSync(dirname(abs), { recursive: true });
    if (this.project.name === 'Nuevo proyecto') this.project.name = basename(abs, '.cinta');
    atomicWrite(abs, JSON.stringify(this.project, null, 1));
    if (withHistory) atomicWrite(`${abs}.history`, JSON.stringify({ past: this.past.slice(-HISTORY_MAX), future: this.future.slice(-HISTORY_MAX) }));
    this.path = abs;
    return abs;
  }

  /** Copies every media file next to the project ("Guardar proyecto portátil"). */
  savePortable(dir: string): string {
    const root = resolve(dir);
    const mediaDir = join(root, 'Medios');
    mkdirSync(mediaDir, { recursive: true });
    const used = new Set<string>();
    for (const m of this.project.media) {
      if (!existsSync(m.path)) continue;
      let name = basename(m.path);
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${basename(m.path, extname(m.path))} (${i})${extname(m.path)}`;
      used.add(name.toLowerCase());
      const dst = join(mediaDir, name);
      if (resolve(m.path) !== dst) copyFileSync(m.path, dst);
      m.path = dst;
    }
    for (const c of this.project.clips) {
      const lut = c.color?.lut;
      if (lut && existsSync(lut)) {
        const dst = join(mediaDir, basename(lut));
        copyFileSync(lut, dst);
        c.color!.lut = dst;
      }
    }
    return this.save(join(root, `${this.project.name || 'Proyecto'}.cinta`));
  }

  // ───────────────────────── history ─────────────────────────
  mutate<T>(label: string, fn: (p: Project) => T): T {
    const before = JSON.stringify(this.project);
    let out: T;
    try {
      out = fn(this.project);
      packMain(this.project);
      followMain(JSON.parse(before), this.project);
    } catch (e) {
      this.project = JSON.parse(before);
      throw e;
    }
    if (JSON.stringify(this.project) !== before) {
      if (!this.batching) {
        this.past.push(before);
        if (this.past.length > HISTORY_MAX) this.past.shift();
      }
      this.future = [];
      this.onChange?.(label);
    }
    return out;
  }

  private batching = 0;
  /** set by undo/redo so an enclosing batch does not record them as a new change */
  private historyMoved = false;
  /** Several operations that the user sees as one (freeze frame, logo, music, slideshow…): one undo step. */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    const before = JSON.stringify(this.project);
    this.historyMoved = false;
    this.batching++;
    let out: T;
    try {
      out = await fn();
    } catch (e) {
      this.project = JSON.parse(before);
      throw e;
    } finally {
      this.batching--;
    }
    if (!this.batching && !this.historyMoved && JSON.stringify(this.project) !== before) {
      this.past.push(before);
      if (this.past.length > HISTORY_MAX) this.past.shift();
      this.future = [];
    }
    return out;
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(JSON.stringify(this.project));
    this.project = JSON.parse(prev);
    this.historyMoved = true;
    this.onChange?.('undo');
    return true;
  }
  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(JSON.stringify(this.project));
    this.project = JSON.parse(next);
    this.historyMoved = true;
    this.onChange?.('redo');
    return true;
  }
  /** Replace the whole project (reload from disk); keeps history so the change can be undone. */
  replace(p: Project, label = 'reload') {
    this.mutate(label, () => { this.project = p; });
  }

  // ───────────────────────── lookups ─────────────────────────
  clip(id: string): Clip {
    const c = this.project.clips.find((x) => x.id === id);
    if (!c) throw new Error(`No existe el clip «${id}»`);
    return c;
  }
  track(id: string): Track {
    const t = this.project.tracks.find((x) => x.id === id);
    if (!t) throw new Error(`No existe la pista «${id}»`);
    return t;
  }
  media(id: string): MediaItem {
    const m = this.project.media.find((x) => x.id === id || x.path.toLowerCase() === resolve(id).toLowerCase());
    if (!m) throw new Error(`No existe el archivo «${id}» en el proyecto`);
    return m;
  }
  /** First track of a kind (creating it if needed). */
  ensureTrack(kind: TrackKind): Track {
    let t = this.project.tracks.find((x) => x.kind === kind);
    if (!t) {
      t = newTrack(kind);
      insertTrack(this.project, t);
    }
    return t;
  }
  private checkUnlocked(t: Track) {
    if (t.locked) throw new Error(`La pista «${t.name}» está bloqueada`);
  }

  // ───────────────────────── project ─────────────────────────
  setSettings(s: Partial<ProjectSettings> & { aspect?: string; name?: string }) {
    return this.mutate('Configuración del proyecto', (p) => {
      if (s.aspect) {
        const a = findIn(ASPECTS, s.aspect, 'Relación de aspecto');
        p.settings.width = a.width;
        p.settings.height = a.height;
      }
      if (s.width) p.settings.width = even(s.width);
      if (s.height) p.settings.height = even(s.height);
      if (s.fps) p.settings.fps = Math.max(1, Math.min(120, s.fps));
      if (s.sampleRate) p.settings.sampleRate = s.sampleRate;
      if (s.background) p.settings.background = s.background;
      if (s.name) p.name = s.name;
      return p.settings;
    });
  }

  async importMedia(paths: string[]): Promise<MediaItem[]> {
    const items: MediaItem[] = [];
    for (const path of paths) {
      const abs = resolve(path);
      const known = this.project.media.find((m) => m.path.toLowerCase() === abs.toLowerCase() || (!m.footage?.sequence && m.footage?.source.toLowerCase() === abs.toLowerCase()));
      // Targa, DPX, Cineon, TIFF, Camera Raw, HEIF, MXF…: a playable copy both engines read (footage.ts)
      items.push(known ?? (needsConversion(abs) ? await footageItem(this, abs) : await probeMedia(abs)));
    }
    this.mutate('Importar', (p) => {
      for (const m of items) if (!p.media.some((x) => x.id === m.id)) p.media.push(m);
    });
    return items;
  }

  removeMedia(id: string) {
    return this.mutate('Quitar del contenedor', (p) => {
      const m = this.media(id);
      p.clips = p.clips.filter((c) => c.mediaId !== m.id);
      p.media = p.media.filter((x) => x !== m);
    });
  }

  relink(mediaId: string, newPath: string) {
    return this.mutate('Reubicar archivo', (p) => {
      const m = p.media.find((x) => x.id === mediaId || x.path === mediaId);
      if (!m) throw new Error(`No existe el archivo «${mediaId}»`);
      if (!existsSync(newPath)) throw new Error(`No existe: ${newPath}`);
      m.path = resolve(newPath);
      return m;
    });
  }

  missingMedia(): MediaItem[] {
    return this.project.media.filter((m) => !existsSync(m.path));
  }

  // ───────────────────────── clips ─────────────────────────
  /**
   * Adds a media file to the timeline. Video/images go to the main track (or `trackId`), audio to the first
   * audio track. `at`: timeline position (main track: inserted at the nearest clip boundary; default end).
   */
  addClip(mediaId: string, o: { trackId?: string; at?: number; in?: number; out?: number; duration?: number } = {}): Clip {
    return this.mutate('Añadir clip', (p) => {
      const m = this.media(mediaId);
      if (m.kind === 'model') throw new Error('Los modelos 3D se usan en el modo avanzado: añádalos a una composición.');
      const t = o.trackId ? this.track(o.trackId) : m.kind === 'audio' ? this.ensureTrack('audio') : mainTrack(p);
      this.checkUnlocked(t);
      if (t.kind === 'audio' && m.kind !== 'audio' && !m.hasAudio) throw new Error('Ese archivo no tiene sonido para una pista de audio');
      if (t.kind !== 'audio' && m.kind === 'audio') throw new Error('Un archivo de audio va en una pista de audio');
      const isImg = m.kind === 'image';
      const inn = isImg ? 0 : Math.max(0, Math.min(o.in ?? 0, m.duration));
      const out = isImg ? (o.duration ?? (o.out ?? DEFAULT_IMAGE_SECONDS)) : Math.min(m.duration, o.out ?? m.duration);
      if (out - inn < 0.04) throw new Error('El tramo elegido es demasiado corto');
      const type = t.kind === 'audio' ? 'audio' : isImg ? 'image' : 'video';
      const c = newClip(t.id, type, { mediaId: m.id, in: r3(inn), out: r3(out), name: basename(m.path) });
      placeClip(p, t, c, o.at);
      return c;
    });
  }

  addColorClip(fill: string, duration = 4, o: { trackId?: string; at?: number } = {}): Clip {
    return this.mutate('Añadir fondo', (p) => {
      const t = o.trackId ? this.track(o.trackId) : mainTrack(p);
      this.checkUnlocked(t);
      const c = newClip(t.id, 'color', { in: 0, out: duration, fill, name: fill.startsWith('gradient:') ? 'Degradado' : 'Color' });
      placeClip(p, t, c, o.at);
      return c;
    });
  }

  addTitle(text: string, o: { style?: string; start?: number; duration?: number; trackId?: string } & Partial<TitleStyle> = {}): Clip {
    return this.mutate('Añadir título', (p) => {
      const def = findIn(TITLES, o.style ?? 'basic', 'Estilo de título');
      const t = o.trackId ? this.track(o.trackId) : this.ensureTrack('title');
      if (t.kind !== 'title' && t.kind !== 'overlay') throw new Error('Los títulos van en una pista de títulos');
      this.checkUnlocked(t);
      const { style: _s, start: _st, duration: _d, trackId: _t, ...over } = o;
      void _s; void _st; void _d; void _t;
      const title = defaultTitle(text, { ...def.style, style: def.id, ...over });
      const dur = o.duration ?? (def.style.anim === 'scroll-up' ? 10 : DEFAULT_TITLE_SECONDS);
      const c = newClip(t.id, 'title', { in: 0, out: dur, title, name: text.split('\n')[0].slice(0, 40) });
      placeFree(p, t, c, o.start);
      return c;
    });
  }

  addGraphic(kind: 'sticker' | 'callout', id: string, o: { start?: number; duration?: number; trackId?: string; color?: string; x?: number; y?: number; scale?: number; rotation?: number } = {}): Clip {
    return this.mutate(kind === 'sticker' ? 'Añadir adhesivo' : 'Añadir llamada', (p) => {
      const def = findIn(kind === 'sticker' ? STICKERS : CALLOUTS, id, kind === 'sticker' ? 'Adhesivo' : 'Llamada');
      const t = o.trackId ? this.track(o.trackId) : this.ensureTrack('title');
      if (t.kind === 'main' || t.kind === 'audio') throw new Error('Los adhesivos y llamadas van en una pista de títulos o superpuesta');
      this.checkUnlocked(t);
      const c = newClip(t.id, kind, {
        in: 0,
        out: o.duration ?? DEFAULT_TITLE_SECONDS,
        name: def.name,
        transform: { x: o.x ?? 0.5, y: o.y ?? 0.5, scale: o.scale ?? def.size / 0.6 * 0.6, rotation: o.rotation ?? 0 },
        ...(kind === 'sticker' ? { sticker: { name: def.id, color: o.color } } : { callout: { shape: def.id, color: o.color ?? '#ff3b30', stroke: 8 } }),
      });
      placeFree(p, t, c, o.start);
      return c;
    });
  }

  /** Splits clips at a timeline time (all clips under it, or the given ones). Returns the new right-hand clips. */
  split(time: number, clipIds?: string[]): Clip[] {
    return this.mutate('Dividir', (p) => {
      const targets = (clipIds?.length ? clipIds.map((id) => this.clip(id)) : p.clips).filter((c) => time > c.start + 0.02 && time < clipEnd(c) - 0.02);
      if (!targets.length) throw new Error(`No hay ningún clip en ${time.toFixed(2)} s para dividir`);
      const made: Clip[] = [];
      for (const c of targets) {
        this.checkUnlocked(this.track(c.trackId));
        const u = (time - c.start) * c.speed;
        const right: Clip = { ...structuredClone(c), id: uid('c'), start: r3(time) };
        if (c.reverse) {
          right.out = r3(c.out - u);
          c.in = r3(c.out - u);
        } else {
          right.in = r3(c.in + u);
          c.out = r3(c.in + u);
        }
        // the transition belongs to the end of the original; fades split between both halves
        delete c.transition;
        c.fadeOut = 0;
        right.fadeIn = 0;
        right.keyframes = c.keyframes?.filter((k) => k.t >= time - c.start).map((k) => ({ ...k, t: k.t - (time - c.start) }));
        c.keyframes = c.keyframes?.filter((k) => k.t < time - c.start);
        p.clips.push(right);
        made.push(right);
      }
      return made;
    });
  }

  /** Changes source in/out or timeline duration of a clip. */
  trim(id: string, o: { in?: number; out?: number; duration?: number; start?: number }) {
    return this.mutate('Recortar', (p) => {
      const c = this.clip(id);
      this.checkUnlocked(this.track(c.trackId));
      const m = c.mediaId ? p.media.find((x) => x.id === c.mediaId) : undefined;
      const max = m && m.kind !== 'image' ? m.duration : Infinity;
      if (o.in !== undefined) c.in = r3(Math.max(0, Math.min(o.in, c.out - 0.04)));
      if (o.out !== undefined) c.out = r3(Math.min(max, Math.max(o.out, c.in + 0.04)));
      if (o.duration !== undefined) c.out = r3(Math.min(max, c.in + Math.max(0.04, o.duration) * c.speed));
      if (o.start !== undefined && this.track(c.trackId).kind !== 'main') c.start = r3(Math.max(0, o.start));
      return c;
    });
  }

  /** Moves a clip in time and/or to another track. Main track: `index` reorders. */
  move(id: string, o: { start?: number; trackId?: string; index?: number }) {
    return this.mutate('Mover', (p) => {
      const c = this.clip(id);
      const from = this.track(c.trackId);
      this.checkUnlocked(from);
      const to = o.trackId ? this.track(o.trackId) : from;
      this.checkUnlocked(to);
      if ((to.kind === 'audio') !== (c.type === 'audio')) throw new Error(c.type === 'audio' ? 'Un clip de audio solo puede ir a una pista de audio' : 'Ese clip no puede ir a una pista de audio');
      if (to.kind === 'main' && !['video', 'image', 'color'].includes(c.type)) throw new Error('En la pista principal solo van vídeos, fotos y fondos');
      if (to.kind === 'title' && ['video', 'image', 'color'].includes(c.type)) {
        // Movavi lets photos/videos go to an extra video track, not the title track
        throw new Error('Los vídeos y fotos van a una pista de vídeo superpuesto');
      }
      c.trackId = to.id;
      if (to.kind === 'main') {
        const others = trackClips(p, to.id).filter((x) => x.id !== c.id);
        let idx = o.index ?? (o.start !== undefined ? others.filter((x) => x.start + clipDuration(x) / 2 < o.start!).length : others.length);
        idx = Math.max(0, Math.min(others.length, idx));
        others.splice(idx, 0, c);
        resequence(others, to.gaps && o.start !== undefined ? { clip: c, start: o.start } : undefined);
      } else if (o.start !== undefined) {
        c.start = r3(Math.max(0, o.start));
      }
      if (to.kind !== 'main') delete c.transition;
      return c;
    });
  }

  duplicate(id: string): Clip {
    return this.mutate('Clonar', (p) => {
      const c = this.clip(id);
      const t = this.track(c.trackId);
      this.checkUnlocked(t);
      const copy: Clip = { ...structuredClone(c), id: uid('c') };
      if (t.kind === 'main') {
        const list = trackClips(p, t.id);
        copy.start = c.start + 0.001;
        list.splice(list.indexOf(c) + 1, 0, copy);
        resequence(list);
      } else {
        copy.start = r3(clipEnd(c));
      }
      p.clips.push(copy);
      return copy;
    });
  }

  /** Deletes clips. Main track closes the gap (ripple) unless it allows gaps. */
  remove(ids: string[]) {
    return this.mutate('Eliminar', (p) => {
      for (const id of ids) {
        const c = this.clip(id);
        this.checkUnlocked(this.track(c.trackId));
        p.clips = p.clips.filter((x) => x !== c);
      }
    });
  }

  /** "Eliminación de rizo": close every gap on a track (default: all non-main tracks keep relative order). */
  closeGaps(trackId?: string) {
    return this.mutate('Eliminar espacio vacío', (p) => {
      const tracks = trackId ? [this.track(trackId)] : p.tracks;
      for (const t of tracks) {
        let at = 0;
        for (const c of trackClips(p, t.id)) {
          if (t.kind === 'main') continue;
          c.start = r3(Math.max(at, 0));
          at = clipEnd(c);
        }
        if (t.kind === 'main' && t.gaps) {
          let end = 0;
          for (const c of trackClips(p, t.id)) { c.start = r3(end); end = clipEnd(c); }
        }
      }
    });
  }

  detachAudio(id: string): Clip {
    return this.mutate('Separar audio', (p) => {
      const c = this.clip(id);
      const m = c.mediaId ? p.media.find((x) => x.id === c.mediaId) : undefined;
      if (c.type !== 'video' || !m?.hasAudio) throw new Error('Ese clip no tiene audio que separar');
      if (c.audioDetached) throw new Error('El audio de ese clip ya está separado');
      const t = this.ensureTrack('audio');
      c.audioDetached = true;
      const a: Clip = { ...structuredClone(c), id: uid('c'), trackId: t.id, type: 'audio', audioDetached: false, filters: [], transition: undefined, name: `${c.name ?? 'Audio'} (audio)` };
      p.clips.push(a);
      return a;
    });
  }

  /** "Insertar fotograma fijo": still image of the frame at `time`, inserted on the main track. */
  async freezeFrame(time: number, duration = 3): Promise<Clip> {
    return this.batch(() => this.freezeFrameSteps(time, duration));
  }
  private async freezeFrameSteps(time: number, duration: number): Promise<Clip> {
    const p = this.project;
    const t = mainTrack(p);
    const c = trackClips(p, t.id).find((x) => time >= x.start && time < clipEnd(x));
    if (!c) throw new Error(`No hay ningún clip de la pista principal en ${time.toFixed(2)} s`);
    const m = c.mediaId ? p.media.find((x) => x.id === c.mediaId) : undefined;
    if (!m || m.kind !== 'video') throw new Error('El fotograma fijo se crea desde un clip de vídeo');
    const u = (time - c.start) * c.speed;
    const src = c.reverse ? c.out - u : c.in + u;
    const out = join(cacheDir('frames'), `freeze_${uid('f')}.png`);
    await runFfmpeg(['-ss', src.toFixed(3), '-i', m.path, '-frames:v', '1', out]);
    const [img] = await this.importMedia([out]);
    if (time > c.start + 0.05) this.split(time, [c.id]);
    return this.addClip(img.id, { at: time, duration });
  }

  /** Generic property change with light validation. */
  set(id: string, patch: Partial<Clip>): Clip {
    return this.mutate('Propiedades del clip', () => {
      const c = this.clip(id);
      this.checkUnlocked(this.track(c.trackId));
      const forbidden = ['id', 'trackId', 'type', 'mediaId'] as const;
      for (const k of forbidden) if (k in patch) throw new Error(`No se puede cambiar «${k}» con esta operación`);
      if (patch.speed !== undefined && (patch.speed < 0.1 || patch.speed > 10)) throw new Error('La velocidad va de 0,1× a 10×');
      if (patch.volume !== undefined && (patch.volume < 0 || patch.volume > 4)) throw new Error('El volumen va de 0 a 4 (400 %)');
      if (patch.opacity !== undefined && (patch.opacity < 0 || patch.opacity > 1)) throw new Error('La opacidad va de 0 a 1');
      if (patch.rotate !== undefined && ![0, 90, 180, 270].includes(patch.rotate)) throw new Error('La rotación es 0, 90, 180 o 270');
      if (patch.pip) findIn(PIP_LAYOUTS, patch.pip, 'Disposición PiP');
      if (patch.animIn) findIn(ANIMATIONS, patch.animIn.type, 'Animación');
      if (patch.animOut) findIn(ANIMATIONS, patch.animOut.type, 'Animación');
      if (patch.panZoom?.preset) {
        const pz = findIn(PAN_ZOOM, patch.panZoom.preset, 'Panorámica');
        patch.panZoom = { preset: pz.id, from: { ...pz.from }, to: { ...pz.to }, ...(patch.panZoom.from ? { from: patch.panZoom.from } : {}), ...(patch.panZoom.to ? { to: patch.panZoom.to } : {}) };
      }
      if (patch.title && c.title) patch.title = { ...c.title, ...patch.title };
      // color and audio settings are replaced as a whole (callers send the complete object)
      if (patch.transform && c.transform) patch.transform = { ...c.transform, ...patch.transform };
      // changing speed keeps the source range: duration on the timeline changes
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete (c as unknown as Record<string, unknown>)[k];
        else (c as unknown as Record<string, unknown>)[k] = v;
      }
      return c;
    });
  }

  addFilter(clipId: string, type: string, amount = 1) {
    return this.mutate('Añadir filtro', () => {
      const def = findIn(FILTERS, type, 'Filtro');
      const c = this.clip(clipId);
      if (c.type === 'audio' || c.type === 'title') throw new Error('Los filtros se aplican a vídeos, fotos y gráficos');
      const f = { id: uid('f'), type: def.id, amount: Math.max(0, Math.min(1, amount)), enabled: true };
      c.filters.push(f);
      return f;
    });
  }
  setFilter(clipId: string, filterId: string, o: { amount?: number; enabled?: boolean }) {
    return this.mutate('Ajustar filtro', () => {
      const f = this.clip(clipId).filters.find((x) => x.id === filterId || x.type === filterId);
      if (!f) throw new Error(`El clip no tiene el filtro «${filterId}»`);
      if (o.amount !== undefined) f.amount = Math.max(0, Math.min(1, o.amount));
      if (o.enabled !== undefined) f.enabled = o.enabled;
      return f;
    });
  }
  removeFilter(clipId: string, filterId?: string) {
    return this.mutate('Quitar filtro', () => {
      const c = this.clip(clipId);
      c.filters = filterId ? c.filters.filter((x) => x.id !== filterId && x.type !== filterId) : [];
    });
  }

  /** Transition from a main-track clip into the next one (null removes it). */
  setTransition(clipId: string, type: string | null, duration = 1) {
    return this.mutate('Transición', (p) => {
      const c = this.clip(clipId);
      if (this.track(c.trackId).kind !== 'main') throw new Error('Las transiciones se ponen entre clips de la pista principal');
      if (type === null) delete c.transition;
      else {
        const def = findIn(TRANSITIONS, type, 'Transición');
        const list = trackClips(p, c.trackId);
        if (list.indexOf(c) === list.length - 1) throw new Error('El último clip no tiene ningún clip siguiente con el que unirse');
        c.transition = { type: def.id, duration: Math.max(0.1, Math.min(10, duration)) };
      }
      return c;
    });
  }

  /** "Asistente para transiciones": same/random transition between all (or selected) main clips. */
  transitionWizard(o: { type?: string | 'random' | null; duration?: number; photoDuration?: number; clipIds?: string[] } = {}) {
    return this.mutate('Asistente para transiciones', (p) => {
      const list = trackClips(p, mainTrack(p).id);
      const sel = o.clipIds?.length ? list.filter((c) => o.clipIds!.includes(c.id)) : list;
      let i = 0;
      for (const c of sel) {
        if (o.photoDuration && c.type === 'image') c.out = r3(c.in + o.photoDuration);
        if (list.indexOf(c) === list.length - 1) continue;
        if (o.type === null) delete c.transition;
        else {
          const type = !o.type || o.type === 'random' ? TRANSITIONS[(Math.random() * TRANSITIONS.length) | 0].id : findIn(TRANSITIONS, o.type, 'Transición').id;
          c.transition = { type, duration: o.duration ?? 1 };
        }
        i++;
      }
      return i;
    });
  }

  setMask(clipId: string, preset: string | null, o: Partial<NonNullable<Clip['mask']>> = {}) {
    return this.mutate('Resaltar y esconder', () => {
      const c = this.clip(clipId);
      if (preset === null) { delete c.mask; return c; }
      const def = findIn(MASKS, preset, 'Máscara');
      c.mask = { shape: def.shape, mode: def.mode, x: 0.5, y: 0.5, w: 0.3, h: 0.3, feather: 0.2, opacity: 1, invert: false, ...c.mask, ...o };
      c.mask.shape = o.shape ?? def.shape;
      c.mask.mode = def.mode;
      return c;
    });
  }

  // ───────────────────────── tracks ─────────────────────────
  addTrack(kind: TrackKind, name?: string): Track {
    return this.mutate('Añadir pista', (p) => {
      if (kind === 'main') throw new Error('Solo hay una pista de vídeo principal');
      const t = newTrack(kind, name);
      insertTrack(p, t);
      return t;
    });
  }
  removeTrack(id: string) {
    return this.mutate('Eliminar pista', (p) => {
      const t = this.track(id);
      if (t.kind === 'main') throw new Error('La pista de vídeo principal no se puede eliminar');
      p.clips = p.clips.filter((c) => c.trackId !== id);
      p.tracks = p.tracks.filter((x) => x !== t);
    });
  }
  setTrack(id: string, patch: Partial<Pick<Track, 'hidden' | 'muted' | 'locked' | 'gaps' | 'name' | 'duck' | 'linked'>>) {
    // undefined values mean "leave as is"
    return this.mutate('Pista', () => Object.assign(this.track(id), Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))));
  }

  // ───────────────────────── markers ─────────────────────────
  addMarker(time: number, name?: string) {
    return this.mutate('Agregar marcador', (p) => {
      const m = { id: uid('k'), time: r3(Math.max(0, time)), name: name ?? `Marcador ${p.markers.length + 1}` };
      p.markers.push(m);
      p.markers.sort((a, b) => a.time - b.time);
      return m;
    });
  }
  removeMarker(id?: string) {
    return this.mutate('Eliminar marcador', (p) => {
      p.markers = id ? p.markers.filter((m) => m.id !== id) : [];
    });
  }
  renameMarker(id: string, name: string) {
    return this.mutate('Renombrar marcador', (p) => {
      const m = p.markers.find((x) => x.id === id);
      if (!m) throw new Error(`No existe el marcador «${id}»`);
      m.name = name;
    });
  }

  // ───────────────────────── composite operations ─────────────────────────
  /** "Adjuntar proyecto": appends another project's timeline at the end. */
  append(other: Project) {
    return this.mutate('Adjuntar proyecto', (p) => {
      const offset = projectDuration(p);
      const mediaMap = new Map<string, string>();
      for (const m of other.media) {
        const known = p.media.find((x) => x.path.toLowerCase() === m.path.toLowerCase());
        if (known) mediaMap.set(m.id, known.id);
        else { p.media.push({ ...m }); mediaMap.set(m.id, m.id); }
      }
      const trackMap = new Map<string, string>();
      for (const t of other.tracks) {
        const same = p.tracks.filter((x) => x.kind === t.kind)[other.tracks.filter((x) => x.kind === t.kind).indexOf(t)];
        if (same) trackMap.set(t.id, same.id);
        else { const nt = { ...t, id: uid('t') }; insertTrack(p, nt); trackMap.set(t.id, nt.id); }
      }
      for (const c of other.clips) {
        p.clips.push({ ...structuredClone(c), id: uid('c'), trackId: trackMap.get(c.trackId)!, mediaId: c.mediaId ? mediaMap.get(c.mediaId) : undefined, start: r3(c.start + offset) });
      }
      for (const m of other.markers) p.markers.push({ ...m, id: uid('k'), time: r3(m.time + offset) });
    });
  }

  addLogo(path: string, o: { corner?: 'tl' | 'tr' | 'bl' | 'br' | 'center'; scale?: number; opacity?: number } = {}): Promise<Clip> {
    return this.batch(() => this.importMedia([path]).then(([m]) => this.mutate('Añadir logotipo', (p) => {
      if (m.kind !== 'image') throw new Error('El logotipo debe ser una imagen (PNG con transparencia recomendado)');
      const t = this.ensureTrack('overlay');
      const pos = { tl: [0.1, 0.1], tr: [0.9, 0.1], bl: [0.1, 0.9], br: [0.9, 0.9], center: [0.5, 0.5] }[o.corner ?? 'tr'];
      const dur = Math.max(1, projectDuration(p));
      const c = newClip(t.id, 'image', { mediaId: m.id, in: 0, out: dur, start: 0, opacity: o.opacity ?? 0.9, name: 'Logotipo', transform: { x: pos[0], y: pos[1], scale: o.scale ?? 0.14, rotation: 0 } });
      p.clips.push(c);
      return c;
    })));
  }

  /** Title clip pushed straight into the project — only for use inside mutate(). */
  addTitleRaw(trackId: string, text: string, style: string, start: number, duration: number): Clip {
    const def = findIn(TITLES, style, 'Estilo de título');
    const c = newClip(trackId, 'title', { in: 0, out: r3(duration), start: r3(start), title: defaultTitle(text, { ...def.style, style: def.id }), name: text.slice(0, 40) });
    this.project.clips.push(c);
    return c;
  }

  /** Audio clip (not added) covering `len` seconds of a media file from its start. */
  newAudioClip(trackId: string, mediaId: string, start: number, len: number): Clip {
    const m = this.media(mediaId);
    return newClip(trackId, 'audio', { mediaId, in: 0, out: r3(Math.min(len, m.duration)), start: r3(start), name: basename(m.path) });
  }

  summary() {
    const p = this.project;
    return {
      path: this.path,
      name: p.name,
      settings: p.settings,
      duration: projectDuration(p),
      tracks: p.tracks.map((t) => ({ ...t, clips: trackClips(p, t.id).map((c) => clipSummary(p, c)) })),
      media: p.media.map((m) => ({ id: m.id, path: m.path, kind: m.kind, duration: m.duration, width: m.width, height: m.height, hasAudio: m.hasAudio })),
      markers: p.markers,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
    };
  }
}

export function clipSummary(p: Project, c: Clip) {
  const out: Record<string, unknown> = { id: c.id, type: c.type, name: c.name, start: r3(c.start), end: r3(clipEnd(c)), duration: r3(clipDuration(c)) };
  if (c.mediaId) out.in = c.in, out.out = c.out;
  if (c.speed !== 1) out.speed = c.speed;
  if (c.reverse) out.reverse = true;
  if (c.volume !== 1) out.volume = c.volume;
  if (c.muted) out.muted = true;
  if (c.hidden) out.hidden = true;
  if (c.transition) out.transition = c.transition;
  if (c.filters.length) out.filters = c.filters.map((f) => ({ id: f.id, type: f.type, amount: f.amount, enabled: f.enabled }));
  if (c.title) out.text = c.title.text, out.style = c.title.style;
  if (c.sticker) out.sticker = c.sticker.name;
  if (c.callout) out.callout = c.callout.shape;
  for (const k of ['color', 'audio', 'chroma', 'stabilize', 'panZoom', 'mask', 'pip', 'transform', 'crop', 'animIn', 'animOut', 'keyframes', 'fill'] as const) if (c[k] !== undefined) out[k] = c[k];
  if (c.rotate) out.rotate = c.rotate;
  if (c.fadeIn) out.fadeIn = c.fadeIn;
  if (c.fadeOut) out.fadeOut = c.fadeOut;
  if (c.opacity !== 1) out.opacity = c.opacity;
  void p;
  return out;
}

/**
 * Linked tracks (Movavi's "Vincular pista"): titles, stickers and overlays keep sitting on the same picture
 * when the main track is cut, trimmed, reordered or sped up. Clips the operation moved itself are left alone.
 */
function followMain(before: Project, after: Project) {
  const sig = (p: Project) => JSON.stringify(trackClips(p, mainTrack(p).id).map((c) => [c.id, c.start, c.in, c.out, c.speed, c.reverse]));
  if (sig(before) === sig(after)) return;
  const map = mainTimeMap(before, after);
  const linked = new Set(after.tracks.filter((t) => (t.kind === 'title' || t.kind === 'overlay') && t.linked !== false).map((t) => t.id));
  const old = new Map(before.clips.map((c) => [c.id, c]));
  for (const c of after.clips) {
    const o = old.get(c.id);
    if (!o || !linked.has(c.trackId) || o.trackId !== c.trackId || Math.abs(o.start - c.start) > 1e-6) continue;
    c.start = map(o.start);
  }
}

function atomicWrite(path: string, data: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

/** Tracks are kept in display order: titles, overlays, main, audio. */
function insertTrack(p: Project, t: Track) {
  const order: Record<TrackKind, number> = { title: 0, overlay: 1, main: 2, audio: 3 };
  let idx = p.tracks.length;
  if (t.kind === 'audio') idx = p.tracks.length;
  else idx = p.tracks.findIndex((x) => order[x.kind] > order[t.kind]);
  if (idx < 0) idx = p.tracks.length;
  // new title/overlay tracks go on top of their group, like Movavi's "Añadir pista"
  if (t.kind === 'title' || t.kind === 'overlay') {
    const first = p.tracks.findIndex((x) => x.kind === t.kind);
    if (first >= 0) idx = first;
  }
  p.tracks.splice(idx, 0, t);
}

/** Main track: puts clips back in the given order (starts are then recomputed by packMain). */
function resequence(list: Clip[], pin?: { clip: Clip; start: number }) {
  let at = 0;
  for (const c of list) {
    c.start = pin && pin.clip === c ? Math.max(at, pin.start) : at + (pin ? 0 : 0);
    if (!pin || pin.clip !== c) c.start = Math.max(c.start, at);
    at = c.start + clipDuration(c);
  }
  // give a tiny monotonic offset so the sort in packMain keeps this order
  list.forEach((c, i) => { c.start = r3(c.start) + i * 1e-6; });
}

function placeClip(p: Project, t: Track, c: Clip, at?: number) {
  if (t.kind === 'main') {
    const list = trackClips(p, t.id);
    let idx = list.length;
    if (at !== undefined) idx = list.filter((x) => x.start + clipDuration(x) / 2 < at).length;
    list.splice(idx, 0, c);
    p.clips.push(c);
    resequence(list, t.gaps && at !== undefined ? { clip: c, start: at } : undefined);
  } else {
    placeFree(p, t, c, at);
  }
}

/** Free tracks: at the given time, or after the last clip of the track. */
function placeFree(p: Project, t: Track, c: Clip, at?: number) {
  const last = trackClips(p, t.id).at(-1);
  c.start = r3(Math.max(0, at ?? (last ? clipEnd(last) : 0)));
  p.clips.push(c);
}

export { newProject };
