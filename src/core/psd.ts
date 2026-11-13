// Photoshop files as compositions (After Effects' "Import As: Composition – Retain Layer Sizes"): every pixel layer
// becomes an image layer at its own size and place, groups become nested comps, and what Photoshop keeps editable
// stays editable here: blend mode, opacity, visibility, clipping masks (alpha mattes), vector masks (masks), layer
// effects (layer styles), adjustment layers (adjustment layers with the matching colour effect) and, if asked,
// text (text layers). The pixels of each layer, with its raster mask baked into the alpha, go to PNG files in a
// "<file> capas" folder next to the project.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { encodePng } from './png';
import { initializeCanvas, readPsd, type Layer as PsdLayer, type Color as PsdColor, type BlendMode as PsdBlend, type LayerEffectsInfo, type AdjustmentLayer } from 'ag-psd';
import type { Editor } from './ops';
import { motionOps } from './motion/ops';
import type { BlendMode, Comp, PVal } from './motion/model';

// no canvas outside the renderer: pixels are plain RGBA buffers (useImageData)
initializeCanvas(() => { throw new Error('canvas no disponible'); }, (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as ImageData);

export { encodePng };
export interface PsdImportResult { comp: Comp; layers: number; comps: number; warnings: string[]; folder: string }

// Photoshop blend mode → composition blend mode (the ones without an equivalent fall back to the closest)
const BLEND: Partial<Record<PsdBlend, BlendMode>> = {
  normal: 'normal', 'pass through': 'normal', dissolve: 'normal', darken: 'darken', multiply: 'multiply', 'color burn': 'color-burn',
  'linear burn': 'multiply', 'darker color': 'darken', lighten: 'lighten', screen: 'screen', 'color dodge': 'color-dodge',
  'linear dodge': 'add', 'lighter color': 'lighten', overlay: 'overlay', 'soft light': 'soft-light', 'hard light': 'hard-light',
  'vivid light': 'hard-light', 'linear light': 'hard-light', 'pin light': 'hard-light', 'hard mix': 'hard-light',
  difference: 'difference', exclusion: 'exclusion', subtract: 'difference', divide: 'color-dodge', hue: 'hue', saturation: 'saturation',
  color: 'color', luminosity: 'luminosity',
};
const EXACT = new Set<PsdBlend>(['normal', 'pass through', 'darken', 'multiply', 'color burn', 'lighten', 'screen', 'color dodge', 'linear dodge', 'overlay', 'soft light', 'hard light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);

const hex = (c?: PsdColor): string => {
  if (!c) return '#000000';
  const o = c as Record<string, number>;
  const rgb = 'r' in o ? [o.r, o.g, o.b] : 'fr' in o ? [o.fr * 255, o.fg * 255, o.fb * 255] : 'k' in o && !('c' in o) ? [255 - o.k * 2.55, 255 - o.k * 2.55, 255 - o.k * 2.55] : [0, 0, 0];
  return '#' + rgb.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
};
/** ag-psd keeps effect opacities as 0…1 */
const pct = (v?: number, d = 100) => (v === undefined ? d : v <= 1 ? Math.round(v * 100) : v);
const px = (u?: { value: number }, d = 0) => u?.value ?? d;

/** A layer's pixels as 8-bit RGBA with its raster layer mask multiplied into the alpha. */
function layerPixels(l: PsdLayer): { w: number; h: number; data: Uint8Array } | null {
  const im = l.imageData;
  if (!im || !im.width || !im.height) return null;
  const w = im.width, h = im.height, n = w * h * 4, src = im.data;
  const data = new Uint8Array(n);
  const k = src instanceof Uint16Array ? 1 / 257 : src instanceof Float32Array ? 255 : 1;
  for (let i = 0; i < n; i++) data[i] = Math.max(0, Math.min(255, Math.round(src[i] * k)));
  const m = l.mask;
  if (m?.imageData && !m.disabled) {
    const mx = (m.left ?? 0) - (l.left ?? 0), my = (m.top ?? 0) - (l.top ?? 0), mw = m.imageData.width, mh = m.imageData.height, md = m.imageData.data;
    const mk = md instanceof Uint16Array ? 1 / 257 : md instanceof Float32Array ? 255 : 1, def = m.defaultColor ?? 255;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = x - mx, v = y - my;
      const a = u >= 0 && v >= 0 && u < mw && v < mh ? md[(v * mw + u) * 4] * mk : def;
      data[(y * w + x) * 4 + 3] = Math.round((data[(y * w + x) * 4 + 3] * a) / 255);
    }
  }
  return { w, h, data };
}

/** Photoshop layer effects → layer styles (one of each kind; the first of the repeatable ones). */
function stylesOf(fx: LayerEffectsInfo | undefined): { kind: string; on: boolean; values: Record<string, PVal> }[] {
  if (!fx || fx.disabled) return [];
  const out: { kind: string; on: boolean; values: Record<string, PVal> }[] = [];
  const on = (x: { enabled?: boolean }) => x.enabled !== false;
  const ds = fx.dropShadow?.[0], is = fx.innerShadow?.[0], so = fx.solidFill?.[0], go = fx.gradientOverlay?.[0], st = fx.stroke?.[0];
  if (ds) out.push({ kind: 'dropShadow', on: on(ds), values: { color: hex(ds.color), opacity: pct(ds.opacity, 75), angle: ds.angle ?? 120, distance: px(ds.distance, 5), spread: px(ds.choke), size: px(ds.size, 5) } });
  if (is) out.push({ kind: 'innerShadow', on: on(is), values: { color: hex(is.color), opacity: pct(is.opacity, 75), angle: is.angle ?? 120, distance: px(is.distance, 5), choke: px(is.choke), size: px(is.size, 5) } });
  if (fx.outerGlow) { const g = fx.outerGlow; out.push({ kind: 'outerGlow', on: on(g), values: { color: hex(g.color), opacity: pct(g.opacity, 75), spread: px(g.choke), size: px(g.size, 5) } }); }
  if (fx.innerGlow) { const g = fx.innerGlow; out.push({ kind: 'innerGlow', on: on(g), values: { color: hex(g.color), opacity: pct(g.opacity, 75), source: g.source === 'center' ? 'center' : 'edge', choke: px(g.choke), size: px(g.size, 5) } }); }
  if (fx.bevel) {
    const b = fx.bevel, style = ({ 'outer bevel': 'outer', emboss: 'emboss', 'pillow emboss': 'pillow' } as Record<string, string>)[b.style ?? ''] ?? 'inner';
    out.push({ kind: 'bevel', on: on(b), values: { style, depth: b.strength ?? 100, direction: b.direction === 'down' ? 'down' : 'up', size: px(b.size, 5), soften: px(b.soften), angle: b.angle ?? 120, altitude: b.altitude ?? 30, highlightColor: hex(b.highlightColor ?? { r: 255, g: 255, b: 255 }), highlightOpacity: pct(b.highlightOpacity, 75), shadowColor: hex(b.shadowColor), shadowOpacity: pct(b.shadowOpacity, 75) } });
  }
  if (so) out.push({ kind: 'colorOverlay', on: on(so), values: { color: hex(so.color), opacity: pct(so.opacity) } });
  if (go?.gradient && 'colorStops' in go.gradient && go.gradient.colorStops?.length) {
    const stops = go.gradient.colorStops;
    out.push({ kind: 'gradientOverlay', on: on(go), values: { startColor: hex(stops[0].color), endColor: hex(stops[stops.length - 1].color), opacity: pct(go.opacity), type: go.type === 'radial' ? 'radial' : 'linear', angle: go.angle ?? 90, scale: go.scale ?? 100, reverse: go.reverse ? 1 : 0 } });
  }
  if (st) out.push({ kind: 'stroke', on: on(st), values: { color: hex(st.color), size: px(st.size, 3), opacity: pct(st.opacity), position: st.position ?? 'outside' } });
  return out;
}

/** Photoshop adjustment layer → colour effect and its values (null when Cinta has no counterpart). */
function adjustmentOf(a: AdjustmentLayer): { fx: string; values: Record<string, PVal> } | null {
  const curve = (pts?: { input: number; output: number }[]) => (pts?.length ? pts.map((p) => `${+(p.input / 255).toFixed(4)},${+(p.output / 255).toFixed(4)}`).join(' ') : '0,0 1,1');
  const gam = (g: number) => (g > 10 ? g / 100 : g || 1);
  switch (a.type) {
    case 'brightness/contrast': return { fx: 'brightnessContrast', values: { brightness: Math.max(-100, Math.min(100, a.brightness ?? 0)), contrast: Math.max(-100, Math.min(100, a.contrast ?? 0)) } };
    case 'levels': {
      if (!a.red && !a.green && !a.blue) { const c = a.rgb; return { fx: 'levels', values: c ? { inBlack: c.shadowInput, inWhite: c.highlightInput, gamma: gam(c.midtoneInput), outBlack: c.shadowOutput, outWhite: c.highlightOutput } : {} }; }
      const v: Record<string, PVal> = {};
      for (const [k, c] of [['', a.rgb], ['r', a.red], ['g', a.green], ['b', a.blue]] as const) if (c) Object.assign(v, { [`${k}InBlack`]: c.shadowInput, [`${k}InWhite`]: c.highlightInput, [`${k}Gamma`]: gam(c.midtoneInput), [`${k}OutBlack`]: c.shadowOutput, [`${k}OutWhite`]: c.highlightOutput });
      return { fx: 'levelsRGB', values: v };
    }
    case 'curves': return { fx: 'curves', values: { rgb: curve(a.rgb), red: curve(a.red), green: curve(a.green), blue: curve(a.blue) } };
    case 'exposure': return { fx: 'exposure', values: { exposure: a.exposure ?? 0, gamma: a.gamma ?? 1 } };
    case 'vibrance': return { fx: 'vibrance', values: { vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 } };
    case 'hue/saturation': return { fx: 'hueSat', values: { hue: a.master?.hue ?? 0, sat: a.master?.saturation ?? 0, light: a.master?.lightness ?? 0 } };
    case 'color balance': {
      const v: Record<string, PVal> = {};
      for (const [k, c] of [['sh', a.shadows], ['mid', a.midtones], ['hi', a.highlights]] as const) if (c) Object.assign(v, { [`${k}R`]: c.cyanRed, [`${k}G`]: c.magentaGreen, [`${k}B`]: c.yellowBlue });
      return { fx: 'colorBalance', values: v };
    }
    case 'black & white': return { fx: 'blackWhite', values: { amount: 100 } };
    case 'photo filter': return { fx: 'photoFilter', values: { filter: 'custom', color: hex(a.color), density: a.density ?? 25 } };
    case 'invert': return { fx: 'invert', values: {} };
    case 'posterize': return { fx: 'posterize', values: { levels: a.levels ?? 4 } };
    case 'threshold': return { fx: 'threshold', values: { level: a.level ?? 128 } };
    default: return null;
  }
}

/** Imports a .psd as a composition (and one nested comp per group). */
export async function psdImport(e: Editor, path: string, o: { name?: string; editableText?: boolean; folder?: string } = {}): Promise<PsdImportResult> {
  let psd;
  try { psd = readPsd(readFileSync(path), { useImageData: true, skipCompositeImageData: true, skipThumbnail: true }); } catch (err) { throw new Error(`No se pudo leer el PSD: ${(err as Error).message}`); }
  if (!psd.children?.length) throw new Error('El PSD no tiene capas (está aplanado): impórtelo como imagen con media_import.');
  const stem = basename(path, extname(path));
  const folder = o.folder ?? join(e.path ? dirname(e.path) : dirname(path), `${stem} capas`);
  mkdirSync(folder, { recursive: true });
  const warnings: string[] = [];
  const W = psd.width, H = psd.height;
  // 1 · pixels of every layer to PNG, then import them all at once
  const files = new Map<PsdLayer, string>();
  let n = 0;
  const walk = (ls: PsdLayer[]) => { for (const l of ls) {
    if (l.children) { walk(l.children); continue; }
    if (l.adjustment || (l.text && o.editableText)) continue;
    const pxl = layerPixels(l);
    if (!pxl) continue;
    const f = join(folder, `${String(++n).padStart(3, '0')} ${(l.name ?? 'Capa').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)}.png`);
    writeFileSync(f, encodePng(pxl.w, pxl.h, pxl.data));
    files.set(l, f);
  } };
  walk(psd.children);
  // one undo step for the media and every comp
  return e.batch(async () => {
    const media = files.size ? await e.importMedia([...files.values()]) : [];
    const mediaOf = new Map([...files].map(([l, f], i) => [l, media.find((m) => m.path === f) ?? media[i]]));
    // 2 · comps: Photoshop lists layers bottom → top, layers are added on top, so the order comes out right
    let comps = 0, layers = 0;
    const build = (ls: PsdLayer[], name: string): Comp => {
      const c = motionOps.compNew(e, { name, width: W, height: H, transparent: true });
      comps++;
      let base: string | null = null;
      for (const l of ls) {
        const nm = l.name ?? 'Capa';
        let id: string | null = null;
        if (l.children) {
          const sub = build(l.children, nm);
          id = motionOps.layerAdd(e, c.id, 'comp', { compId: sub.id, name: nm }).id;
          if (l.blendMode && l.blendMode !== 'pass through' && l.blendMode !== 'normal') warnings.push(`Grupo «${nm}»: el modo se aplica al grupo entero (no atraviesa como en Photoshop).`);
        } else if (l.adjustment) {
          const adj = adjustmentOf(l.adjustment);
          if (!adj) { warnings.push(`Capa de ajuste «${nm}» (${l.adjustment.type}): no tiene equivalente y se omite.`); continue; }
          id = motionOps.layerAdd(e, c.id, 'adjustment', { name: nm }).id;
          motionOps.effectAdd(e, c.id, id, adj.fx, adj.values);
          if (l.mask?.imageData) warnings.push(`Capa de ajuste «${nm}»: su máscara de píxeles no se importa.`);
        } else if (l.text && o.editableText) {
          const s = l.text.style ?? {}, tf = l.text.transform ?? [1, 0, 0, 1, l.left ?? 0, l.bottom ?? 0];
          const scale = Math.hypot(tf[0], tf[1]) || 1;
          const just = l.text.paragraphStyle?.justification ?? 'left', align = just.includes('center') ? 'center' : just.includes('right') ? 'right' : 'left';
          id = motionOps.layerAdd(e, c.id, 'text', { name: nm, text: l.text.text.replace(/\r/g, '\n'), size: Math.round((s.fontSize ?? 24) * scale * 100) / 100, font: s.font?.name, color: hex(s.fillColor ?? { r: 0, g: 0, b: 0 }), position: [tf[4], tf[5]] }).id;
          motionOps.layerSet(e, c.id, id, { text: { align } });
        } else {
          const m = mediaOf.get(l);
          if (!m) continue;
          id = motionOps.layerAdd(e, c.id, 'image', { mediaId: m.id, name: nm }).id;
          motionOps.propSet(e, c.id, id, 'position', { value: [(l.left ?? 0) + m.width / 2, (l.top ?? 0) + m.height / 2] });
          // vector mask → mask (Photoshop knots: [in, anchor, out] in document pixels)
          const vm = l.vectorMask;
          for (const vp of vm && !vm.disable ? vm.paths : []) {
            if (vp.knots.length < 2) continue;
            const pts = vp.knots.flatMap((k) => { const [ix, iy, ax, ay, ox, oy] = k.points, x = ax - (l.left ?? 0), y = ay - (l.top ?? 0); return [x, y, ix - ax, iy - ay, ox - ax, oy - ay]; });
            motionOps.maskAdd(e, c.id, id, { shape: 'path', bezier: true, path: pts, inverted: !!vm!.invert, mode: vp.operation === 'subtract' ? 'subtract' : vp.operation === 'intersect' ? 'intersect' : 'add', name: 'Máscara vectorial' });
          }
        }
        layers++;
        const patch: Record<string, unknown> = {};
        if (l.hidden) patch.hidden = true;
        if (l.blendMode) { patch.blend = BLEND[l.blendMode] ?? 'normal'; if (!EXACT.has(l.blendMode)) warnings.push(`«${nm}»: el modo «${l.blendMode}» se aproxima con «${patch.blend}».`); }
        // clipping mask: the layer shows only where the base below it (the last unclipped one) has alpha
        if (l.clipping && base) patch.matte = { layer: base, mode: 'alpha' };
        else base = id;
        if (Object.keys(patch).length) motionOps.layerSet(e, c.id, id, patch as never);
        // opacity is stored as 0…255: whole percent, as Photoshop shows it
        if ((l.opacity ?? 1) < 1) motionOps.propSet(e, c.id, id, 'opacity', { value: Math.round((l.opacity ?? 1) * 100) });
        for (const st of stylesOf(l.effects)) motionOps.styleSet(e, c.id, id, st.kind, { values: st.values, on: st.on });
      }
      return c;
    };
    const comp = build(psd.children!, o.name ?? stem);
    return { comp, layers, comps, warnings, folder };
  });
}
