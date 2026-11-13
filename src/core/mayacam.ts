// Maya ASCII (.ma) camera import, like After Effects' MayaImport («Escena Maya»): the cameras of the scene (and
// its locators, as 3D nulls) become layers of a composition sized like Maya's render resolution, with the camera's
// position, point of interest, roll and focal length keyed on every frame. Maya is Y-up and looks down −Z; After
// Effects is Y-down and looks down +Z: the scene is turned half a turn about X, one Maya unit = one pixel, and Maya's
// origin lands on the comp's top-left corner (After Effects' 3D origin) unless `origin: 'center'`.
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { Editor } from './ops';
import { motionOps } from './motion/ops';
import type { Comp } from './motion/model';

interface MNode { type: string; name: string; parent?: string; shared: boolean; attrs: Map<string, (number | string)[]> }
export interface MayaScene {
  nodes: MNode[];
  fps: number;
  /** playback range in Maya frames */
  start: number; end: number;
  width: number; height: number;
  /** animCurve feeding node.attr (short attribute names: tx, ry, fl…) */
  curves: Map<string, { t: number[]; v: number[] }>;
  linear: number; angle: 'degree' | 'radian';
}
const TIME: Record<string, number> = { game: 15, film: 24, pal: 25, ntsc: 30, show: 48, palf: 50, ntscf: 60, hour: 1 / 3600, min: 1 / 60, sec: 1, millisec: 1000 };
const LINEAR: Record<string, number> = { mm: 0.1, millimeter: 0.1, cm: 1, centimeter: 1, m: 100, meter: 100, km: 100000, kilometer: 100000, in: 2.54, inch: 2.54, ft: 30.48, foot: 30.48, yd: 91.44, yard: 91.44, mi: 160934.4, mile: 160934.4 };
const LONG: Record<string, string> = { translateX: 'tx', translateY: 'ty', translateZ: 'tz', rotateX: 'rx', rotateY: 'ry', rotateZ: 'rz', scaleX: 'sx', scaleY: 'sy', scaleZ: 'sz', focalLength: 'fl', translate: 't', rotate: 'r', scale: 's', rotateOrder: 'ro', visibility: 'v' };

/** MEL statements → tokens (strings unquoted). */
function statements(src: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [], tok = '', inStr = false, quoted = false;
  const push = () => { if (tok || quoted) cur.push(tok); tok = ''; quoted = false; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\' && i + 1 < src.length) { tok += src[++i] === 'n' ? '\n' : src[i]; continue; }
      if (ch === '"') { inStr = false; continue; }
      tok += ch;
      continue;
    }
    if (ch === '"') { inStr = true; quoted = true; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; push(); continue; }
    if (ch === ';') { push(); if (cur.length) out.push(cur); cur = []; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    tok += ch;
  }
  push();
  if (cur.length) out.push(cur);
  return out;
}
const short = (a: string) => { const x = a.replace(/^\./, '').replace(/^.*\./, ''); return LONG[x] ?? x; };
const leaf = (n: string) => n.split('|').filter(Boolean).pop() ?? n;

/** Parses a Maya ASCII scene: nodes, attributes, animation curves and their connections, units, range, resolution. */
export function parseMaya(src: string): MayaScene {
  if (!/^\/\/Maya ASCII/m.test(src.slice(0, 200)) && !/createNode\s/.test(src)) throw new Error('Sólo son compatibles los archivos Ascii Maya.');
  const nodes: MNode[] = [], byName = new Map<string, MNode>();
  const conns: [string, string][] = [];
  let cur: MNode | null = null, fps = 24, linear = 1, angle: 'degree' | 'radian' = 'degree', start = NaN, end = NaN, width = 0, height = 0;
  for (const st of statements(src)) {
    const cmd = st[0];
    if (cmd === 'currentUnit') {
      for (let i = 1; i < st.length - 1; i++) {
        const v = st[i + 1];
        if (st[i] === '-t' || st[i] === '-time') { const m = /^([\d.]+)(fps|df)?$/.exec(v); fps = m ? Number(m[1]) : TIME[v] ?? fps; }
        if (st[i] === '-l' || st[i] === '-linear') linear = LINEAR[v] ?? 1;
        if (st[i] === '-a' || st[i] === '-angle') angle = v.startsWith('rad') ? 'radian' : 'degree';
      }
    } else if (cmd === 'createNode') {
      let name = '', parent: string | undefined, shared = false;
      for (let i = 2; i < st.length; i++) {
        if (st[i] === '-n' || st[i] === '-name') name = st[++i];
        else if (st[i] === '-p' || st[i] === '-parent') parent = leaf(st[++i]);
        else if (st[i] === '-s' || st[i] === '-shared') shared = true;
      }
      cur = { type: st[1], name: name || `${st[1]}${nodes.length}`, parent, shared, attrs: new Map() };
      nodes.push(cur); byName.set(cur.name, cur);
    } else if (cmd === 'select') {
      const target = st.find((x, i) => i > 0 && !x.startsWith('-'));
      cur = target ? (byName.get(leaf(target.replace(/^:/, ''))) ?? null) : null;
      if (target && !cur) { cur = { type: 'select', name: target.replace(/^:/, ''), shared: true, attrs: new Map() }; byName.set(cur.name, cur); nodes.push(cur); }
    } else if (cmd === 'setAttr' && cur) {
      let i = 1, attr = '';
      const vals: (number | string)[] = [];
      for (; i < st.length; i++) {
        const t = st[i];
        if (t === '-type') { i++; continue; }
        if (t === '-s' || t === '-size' || t === '-l' || t === '-lock' || t === '-k' || t === '-keyable' || t === '-cb' || t === '-channelBox' || t === '-av' || t === '-ca') { if (t === '-s' || t === '-size' || t === '-l' || t === '-k' || t === '-cb') i++; continue; }
        if (!attr && t.startsWith('.')) { attr = t; continue; }
        if (attr) vals.push(/^-?[\d.]+(e[-+]?\d+)?$/i.test(t) ? Number(t) : t === 'yes' || t === 'on' || t === 'true' ? 1 : t === 'no' || t === 'off' || t === 'false' ? 0 : t);
      }
      if (!attr) continue;
      // key arrays come in pieces: .ktv[0:9] then .ktv[10:19]
      const base = attr.replace(/\[.*$/, ''), name = short(base);
      if (name === 'ktv') cur.attrs.set('ktv', [...(cur.attrs.get('ktv') ?? []), ...vals]);
      else cur.attrs.set(name, vals);
      if (cur.name === 'defaultResolution' || cur.type === 'resolution') { if (name === 'w') width = Number(vals[0]); if (name === 'h') height = Number(vals[0]); }
      if (cur.type === 'script' && typeof vals[0] === 'string' && /playbackOptions/.test(vals[0])) {
        const mn = /-min\s+(-?[\d.]+)/.exec(vals[0]), mx = /-max\s+(-?[\d.]+)/.exec(vals[0]);
        if (mn) start = Number(mn[1]);
        if (mx) end = Number(mx[1]);
      }
    } else if (cmd === 'connectAttr') {
      const args = st.slice(1).filter((x) => !x.startsWith('-'));
      if (args.length >= 2) conns.push([args[0], args[1]]);
    }
  }
  const curves = new Map<string, { t: number[]; v: number[] }>();
  for (const [s, d] of conns) {
    const src = byName.get(leaf(s.replace(/\.[^.|]+$/, '')));
    if (!src || !/^animCurveT[LAU]$/.test(src.type)) continue;
    const ktv = (src.attrs.get('ktv') ?? []).map(Number), t: number[] = [], v: number[] = [];
    for (let i = 0; i + 1 < ktv.length; i += 2) { t.push(ktv[i]); v.push(ktv[i + 1]); }
    if (!t.length) continue;
    const dst = d.replace(/^.*\|/, ''), dot = dst.indexOf('.');
    curves.set(`${dst.slice(0, dot)}.${short(dst.slice(dot + 1))}`, { t, v });
  }
  if (Number.isNaN(start) || Number.isNaN(end)) {
    const ts = [...curves.values()].flatMap((c) => c.t);
    if (Number.isNaN(start)) start = ts.length ? Math.min(...ts) : 1;
    if (Number.isNaN(end)) end = ts.length ? Math.max(...ts) : start + Math.round(fps * 5) - 1;
  }
  return { nodes, fps, start, end, width, height, curves, linear, angle };
}

type M4 = number[];
const mul = (a: M4, b: M4): M4 => { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c]; return o; };
const I = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const rx = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
const ry = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const rz = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const ORDERS = ['xyz', 'yzx', 'zxy', 'xzy', 'yxz', 'zyx'];

/** Value of node.attr at a Maya frame: its animation curve (linear between keys, held outside), else the static value. */
function attrAt(sc: MayaScene, n: MNode, a: string, f: number, def: number): number {
  const cv = sc.curves.get(`${n.name}.${a}`);
  if (cv) {
    const { t, v } = cv;
    if (f <= t[0]) return v[0];
    if (f >= t[t.length - 1]) return v[v.length - 1];
    let i = 1;
    while (t[i] < f) i++;
    const u = (f - t[i - 1]) / (t[i] - t[i - 1] || 1);
    return v[i - 1] + (v[i] - v[i - 1]) * u;
  }
  const single = n.attrs.get(a);
  if (single?.length === 1 && typeof single[0] === 'number') return single[0];
  const vec = n.attrs.get(a[0]);
  const k = 'xyz'.indexOf(a[1]);
  if (a.length === 2 && k >= 0 && vec && typeof vec[k] === 'number') return vec[k] as number;
  return def;
}
/** Local matrix of a transform (row vectors: p·S·R·T), rotate order from .ro */
function localMatrix(sc: MayaScene, n: MNode, f: number): M4 {
  const ang = (v: number) => (sc.angle === 'degree' ? (v * Math.PI) / 180 : v);
  const r = { x: rx(ang(attrAt(sc, n, 'rx', f, 0))), y: ry(ang(attrAt(sc, n, 'ry', f, 0))), z: rz(ang(attrAt(sc, n, 'rz', f, 0))) };
  const ord = ORDERS[Math.round(Number(n.attrs.get('ro')?.[0] ?? 0))] ?? 'xyz';
  let R = I();
  for (const ax of ord) R = mul(R, r[ax as 'x' | 'y' | 'z']);
  const S = I(); S[0] = attrAt(sc, n, 'sx', f, 1); S[5] = attrAt(sc, n, 'sy', f, 1); S[10] = attrAt(sc, n, 'sz', f, 1);
  const T = I(); T[12] = attrAt(sc, n, 'tx', f, 0) * sc.linear; T[13] = attrAt(sc, n, 'ty', f, 0) * sc.linear; T[14] = attrAt(sc, n, 'tz', f, 0) * sc.linear;
  return mul(mul(S, R), T);
}
function worldMatrix(sc: MayaScene, n: MNode, f: number): M4 {
  let m = localMatrix(sc, n, f), p = n.parent;
  const seen = new Set<string>();
  while (p && !seen.has(p)) {
    seen.add(p);
    const pn = sc.nodes.find((x) => x.name === p && (x.type === 'transform' || x.type === 'joint'));
    if (!pn) break;
    m = mul(m, localMatrix(sc, pn, f));
    p = pn.parent;
  }
  return m;
}

export interface MayaImportResult { comp: Comp; cameras: string[]; nulls: string[]; frames: number; warnings: string[] }
/** Imports the cameras (and locators) of a Maya ASCII scene into a new composition (or `compId`). Run it inside
 *  e.batch: it is several operations. */
export function mayaImport(e: Editor, path: string, o: { compId?: string; origin?: 'corner' | 'center'; scale?: number; name?: string } = {}): MayaImportResult {
  if (extname(path).toLowerCase() === '.mb') throw new Error('Sólo son compatibles los archivos Ascii Maya (.ma): guarde la escena como Maya ASCII.');
  const sc = parseMaya(readFileSync(path, 'utf8'));
  const warnings: string[] = [];
  const shapes = sc.nodes.filter((n) => n.type === 'camera');
  let cams = shapes.filter((s) => { const t = sc.nodes.find((x) => x.name === s.parent); return t && !t.shared && !['persp', 'top', 'front', 'side'].includes(t.name); });
  if (!cams.length) cams = shapes.filter((s) => s.parent === 'persp');
  if (!cams.length) throw new Error('La escena Maya no tiene cámaras.');
  const locs = sc.nodes.filter((n) => n.type === 'locator');
  const frames = Math.max(1, Math.round(sc.end - sc.start) + 1);
  {
    let c: Comp;
    if (o.compId) c = (e.project.comps ?? []).find((x) => x.id === o.compId || x.name === o.compId) ?? (() => { throw new Error(`No existe la composición «${o.compId}».`); })();
    else {
      const W = sc.width || e.project.settings.width, H = sc.height || e.project.settings.height;
      c = motionOps.compNew(e, { name: o.name ?? `${basename(path, extname(path))} (Escena Maya)`, width: W, height: H, fps: sc.fps, duration: Math.round((frames / sc.fps) * 1000) / 1000 });
    }
    const W = c.width, H = c.height, k = o.scale ?? 1;
    const off = o.origin === 'center' ? [W / 2, H / 2, 0] : [0, 0, 0];
    const toAE = (p: number[]) => [off[0] + p[0] * k, off[1] - p[1] * k, off[2] - p[2] * k];
    const dirAE = (p: number[]) => [p[0], -p[1], -p[2]];
    const tOf = (f: number) => Math.round(((f - sc.start) / sc.fps) * 100000) / 100000;
    const animated = (n: MNode) => { const chain: string[] = []; let x: MNode | undefined = n; while (x) { chain.push(x.name); x = sc.nodes.find((q) => q.name === x!.parent); } return [...sc.curves.keys()].some((key) => chain.includes(key.split('.')[0])); };
    const cameras: string[] = [], nulls: string[] = [];
    for (const shape of cams) {
      const tr = sc.nodes.find((x) => x.name === shape.parent)!;
      const hfa = Number(shape.attrs.get('cap')?.[0] ?? shape.attrs.get('hfa')?.[0] ?? 1.41732), vfa = Number(shape.attrs.get('cap')?.[1] ?? shape.attrs.get('vfa')?.[0] ?? 0.94488);
      const fit = Number(shape.attrs.get('ff')?.[0] ?? 1);
      // focal length → After Effects zoom through the film gate (Fill / Horizontal / Vertical / Overscan)
      const horiz = fit === 1 || (fit === 0 && W / H >= hfa / vfa) || (fit === 3 && W / H < hfa / vfa);
      const zoomAt = (f: number) => { const fl = attrAt(sc, shape, 'fl', f, 35); return horiz ? (W * fl) / (hfa * 25.4) : (H * fl) / (vfa * 25.4); };
      const cam = motionOps.layerAdd(e, c.id, 'camera', { name: tr.name });
      const many = animated(tr) || sc.curves.has(`${shape.name}.fl`);
      const pos: { t: number; v: number[] }[] = [], poi: { t: number; v: number[] }[] = [], roll: { t: number; v: number }[] = [], zoom: { t: number; v: number }[] = [];
      for (let f = sc.start; f <= (many ? sc.end : sc.start); f++) {
        const m = worldMatrix(sc, tr, f), z = zoomAt(f);
        const eye = toAE([m[12], m[13], m[14]]);
        const fl = Math.hypot(m[8], m[9], m[10]) || 1, ul = Math.hypot(m[4], m[5], m[6]) || 1;
        const fwd = dirAE([-m[8] / fl, -m[9] / fl, -m[10] / fl]), down = dirAE([-m[4] / ul, -m[5] / ul, -m[6] / ul]);
        pos.push({ t: tOf(f), v: eye.map((v) => Math.round(v * 1000) / 1000) });
        poi.push({ t: tOf(f), v: eye.map((v, i) => Math.round((v + fwd[i] * z) * 1000) / 1000) });
        // roll: the camera's own down axis against the one a level look-at would give (y down)
        const cr = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        let rxv = cr([0, 1, 0], fwd); const lr = Math.hypot(rxv[0], rxv[1], rxv[2]) || 1; rxv = rxv.map((v) => v / lr);
        const uy = cr(fwd, rxv);
        roll.push({ t: tOf(f), v: Math.round(((Math.atan2(rxv[0] * down[0] + rxv[1] * down[1] + rxv[2] * down[2], uy[0] * down[0] + uy[1] * down[1] + uy[2] * down[2]) * 180) / Math.PI) * 1000) / 1000 });
        zoom.push({ t: tOf(f), v: Math.round(z * 1000) / 1000 });
      }
      const set = (p: string, keys: { t: number; v: number | number[] }[]) => motionOps.propSet(e, c.id, cam.id, p, keys.length > 1 ? { keys: keys.map((x) => ({ ...x, ease: 'linear' as const })), clearKeys: true } : { value: keys[0].v });
      set('position', pos); set('camera.poi', poi);
      if (roll.some((r) => Math.abs(r.v) > 0.001)) set('rotation', roll.every((r) => Math.abs(r.v - roll[0].v) < 1e-6) ? [roll[0]] : roll);
      set('camera.zoom', zoom.every((x) => Math.abs(x.v - zoom[0].v) < 1e-6) ? [zoom[0]] : zoom);
      cameras.push(cam.id);
    }
    for (const shape of locs) {
      const tr = sc.nodes.find((x) => x.name === shape.parent);
      if (!tr) continue;
      const nl = motionOps.layerAdd(e, c.id, 'null', { name: tr.name });
      motionOps.layerSet(e, c.id, nl.id, { threeD: true });
      const keys: { t: number; v: number[] }[] = [];
      for (let f = sc.start; f <= (animated(tr) ? sc.end : sc.start); f++) { const m = worldMatrix(sc, tr, f); keys.push({ t: tOf(f), v: toAE([m[12], m[13], m[14]]).map((v) => Math.round(v * 1000) / 1000) }); }
      motionOps.propSet(e, c.id, nl.id, 'position', keys.length > 1 ? { keys: keys.map((x) => ({ ...x, ease: 'linear' as const })), clearKeys: true } : { value: keys[0].v });
      nulls.push(nl.id);
    }
    if (!sc.width) warnings.push('La escena no indica la resolución de render: la composición usa el tamaño del proyecto.');
    return { comp: (e.project.comps ?? []).find((x) => x.id === c.id)!, cameras, nulls, frames, warnings };
  }
}
