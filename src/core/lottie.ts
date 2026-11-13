// Lottie export (the Bodymovin JSON that After Effects animations ship as on the web and in apps): a composition
// with its nested comps, solids, images (embedded), nulls, shapes (rect, ellipse, star, polygon, path, compound
// paths, fill, gradient, stroke, dashes, trim, repeater, round corners, pucker, twist, zigzag, offset, merge), text,
// masks, track mattes, parenting, blend modes and time remap. Keyframes keep their eases (Cinta stores them as the
// same normalised bezier handles Lottie uses) and motion paths their curves (Hermite tangents → to / ti);
// expressions are baked one key per frame. Effects, layer styles, 3D, video and audio are reported, not exported.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { Project } from './model';
import { valueAt, EASE_IN, EASE_OUT } from './motion/anim';
import { findComp, type BlendMode, type Comp, type Key, type Layer, type Prop, type PVal, type ShapeItem } from './motion/model';
import { comps, resolveProp } from './motion/ops';

type J = Record<string, unknown>;
export interface LottieResult { json: J; warnings: string[] }

const BM: Partial<Record<BlendMode, number>> = { normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5, 'color-dodge': 6, 'color-burn': 7, 'hard-light': 8, 'soft-light': 9, difference: 10, exclusion: 11, hue: 12, saturation: 13, color: 14, luminosity: 15, add: 16 };
const TT = { alpha: 1, alphaInv: 2, luma: 3, lumaInv: 4 } as const;
const rgb = (v: PVal): number[] => { const s = String(v).replace('#', ''); const h = s.length === 3 ? s.split('').map((c) => c + c).join('') : s.padEnd(6, '0'); return [0, 2, 4].map((i) => Math.round((parseInt(h.slice(i, i + 2), 16) / 255) * 1000) / 1000).concat(1); };
const arr = (v: PVal): number[] => (Array.isArray(v) ? (v as number[]) : [Number(v) || 0]);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** flat bezier [x, y, inX, inY, outX, outY…] (relative handles) → Lottie shape */
const shapeOf = (v: PVal, closed = true) => {
  const f = Array.isArray(v) ? (v as number[]) : [];
  const out = { i: [] as number[][], o: [] as number[][], v: [] as number[][], c: closed };
  for (let i = 0; i + 5 < f.length; i += 6) { out.v.push([r3(f[i]), r3(f[i + 1])]); out.i.push([r3(f[i + 2]), r3(f[i + 3])]); out.o.push([r3(f[i + 4]), r3(f[i + 5])]); }
  return out;
};

export function compToLottie(p: Project, compId: string): LottieResult {
  const main = findComp(comps(p), compId);
  const warnings = new Set<string>();
  const warn = (s: string) => warnings.add(s);
  const assets: J[] = [];
  const fonts = new Map<string, J>();
  const assetIds = new Map<string, string>();

  const convComp = (c: Comp, depth: number): J[] => {
    const fps = c.fps;
    const layers: J[] = [];
    const index = new Map(c.layers.map((l, i) => [l.id, i + 1]));
    let extra = c.layers.length;
    for (const l of c.layers) {
      // guide layers are never exported (After Effects' Capa de guía)
      if (l.guide) continue;
      const conv = convLayer(c, l, index, depth, fps);
      if (!conv) continue;
      // track matte: a hidden copy of the matte layer goes right above (Lottie reads the layer above as the matte)
      if (l.matte) {
        const ml = c.layers.find((x) => x.id === l.matte!.layer);
        const mc = ml && convLayer(c, ml, index, depth, fps);
        if (mc) { mc.ind = ++extra; mc.td = 1; delete mc.hd; layers.push(mc); conv.tt = TT[l.matte.mode]; }
      }
      layers.push(conv);
    }
    return layers;
  };

  /** Lottie property (static, keyed or baked expression); times in the layer's frames */
  const prop = (c: Comp, l: Layer, pr: Prop | undefined, path: string, conv: (v: PVal) => unknown = arr, o: { spatial?: boolean; scalar?: boolean } = {}): J => {
    const fps = c.fps, local = (t: number) => r3(((t - l.start) * fps) / (l.stretch || 1));
    const pack = (v: PVal) => { const x = conv(v); return o.scalar && Array.isArray(x) ? x[0] : x; };
    if (!pr) return { a: 0, k: pack(0) };
    if (pr.x && !pr.xOff) {
      // expression: one linear key per frame over the layer's span
      const f0 = Math.floor(l.in * fps), f1 = Math.ceil(l.out * fps), k: J[] = [];
      for (let f = f0; f <= f1; f++) { const v = valueAt(pr, f / fps, { comp: c, layer: l, path }); k.push({ t: local(f / fps), s: arr(conv(v) as PVal), o: { x: 0, y: 0 }, i: { x: 1, y: 1 }, ...(o.spatial ? { to: [0, 0, 0], ti: [0, 0, 0] } : {}) }); }
      return { a: 1, k };
    }
    if (!pr.k?.length) return { a: 0, k: pack(pr.v) };
    const ks = pr.k;
    const tan = (i: number) => { const v = arr(ks[i].v), pv = ks[i - 1] && arr(ks[i - 1].v), nx = ks[i + 1] && arr(ks[i + 1].v); return pv && nx ? nx.map((x, d) => (x - pv[d]) / 2) : nx ? nx.map((x, d) => x - v[d]) : pv ? v.map((x, d) => x - pv[d]) : v.map(() => 0); };
    const k = ks.map((k0: Key, i): J => {
      const s = conv(k0.v);
      const k1 = ks[i + 1];
      if (!k1) return { t: local(k0.t), s: Array.isArray(s) ? s : [s] };
      const lin = (k0.i ?? 'linear') === 'linear' && !k0.eo && !k1.ei;
      const eo = k0.eo ?? (lin ? [0, 0] : EASE_OUT), ei = k1.ei ?? (lin ? [1, 1] : EASE_IN);
      const out: J = { t: local(k0.t), s: Array.isArray(s) ? s : [s], o: { x: eo[0], y: eo[1] }, i: { x: ei[0], y: ei[1] } };
      if (k0.i === 'hold') out.h = 1;
      if (o.spatial) {
        const curved = !(k0.sl || k1.sl || ks.length < 3);
        const m0 = curved ? tan(i) : [0, 0], m1 = curved ? tan(i + 1) : [0, 0];
        out.to = [r3((m0[0] ?? 0) / 3), r3((m0[1] ?? 0) / 3), 0]; out.ti = [r3(-(m1[0] ?? 0) / 3), r3(-(m1[1] ?? 0) / 3), 0];
      }
      return out;
    });
    return { a: 1, k };
  };
  const v3 = (z: number) => (v: PVal) => { const a = arr(v); return [a[0] ?? 0, a[1] ?? 0, z]; };

  const transform = (c: Comp, l: Layer): J => {
    const tr = l.transform;
    if (l.threeD) warn('Capas 3D: se exportan en 2D (sin cámara, luces ni rotación X/Y).');
    return { o: prop(c, l, tr.opacity, 'transform.opacity', arr, { scalar: true }), r: prop(c, l, tr.rotation, 'transform.rotation', arr, { scalar: true }), p: tr.positionX ? { s: true, x: prop(c, l, tr.positionX, 'transform.positionX', arr, { scalar: true }), y: prop(c, l, tr.positionY, 'transform.positionY', arr, { scalar: true }) } : prop(c, l, tr.position, 'transform.position', v3(0), { spatial: true }), a: prop(c, l, tr.anchor, 'transform.anchor', v3(0), { spatial: true }), s: prop(c, l, tr.scale, 'transform.scale', v3(100)) };
  };

  const convLayer = (c: Comp, l: Layer, index: Map<string, number>, depth: number, fps: number): J | null => {
    const base: J = { ddd: 0, ind: index.get(l.id), nm: l.name, sr: l.stretch || 1, ks: transform(c, l), ao: 0, ip: Math.round(l.in * fps), op: Math.round(l.out * fps), st: r3(l.start * fps), bm: BM[l.blend] ?? 0 };
    if ((l.stretch || 1) < 0) warn(`«${l.name}»: la reproducción invertida no existe en Lottie.`);
    if (BM[l.blend] === undefined) warn(`«${l.name}»: modo de fusión «${l.blend}» exportado como normal.`);
    if (l.hidden) base.hd = true;
    if (l.parent && index.has(l.parent)) base.parent = index.get(l.parent);
    if (l.effects.some((f) => f.on)) warn(`«${l.name}»: los efectos (${l.effects.filter((f) => f.on).map((f) => f.name).join(', ')}) no se exportan a Lottie.`);
    if (l.styles?.some((s) => s.on)) warn(`«${l.name}»: los estilos de capa no se exportan a Lottie.`);
    if (l.masks.length) {
      base.hasMask = true;
      base.masksProperties = l.masks.map((m) => {
        if (Number(m.feather.v) > 0 || m.feather.k?.length) warn(`«${l.name}»: el calado de máscara no se exporta (la mayoría de reproductores Lottie no lo dibujan).`);
        return { nm: m.name, inv: m.inverted, mode: ({ add: 'a', subtract: 's', intersect: 'i', none: 'n' } as const)[m.mode], pt: prop(c, l, m.path, `masks.${m.id}.path`, (v) => shapeOf(v)), o: prop(c, l, m.opacity, `masks.${m.id}.opacity`, arr, { scalar: true }), x: prop(c, l, m.expansion, `masks.${m.id}.expansion`, arr, { scalar: true }) };
      });
    }
    switch (l.type) {
      case 'null': return { ...base, ty: 3 };
      case 'solid': return { ...base, ty: 1, sc: l.solid!.color, sw: l.solid!.width, sh: l.solid!.height };
      case 'image': {
        const m = p.media.find((x) => x.id === l.mediaId);
        if (!m) return null;
        let id = assetIds.get(m.id);
        if (!id) {
          const ext = extname(m.path).slice(1).toLowerCase(), mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : '';
          if (!mime) { warn(`«${l.name}»: imagen ${ext} sin formato web (use PNG, JPG o WebP).`); return null; }
          id = `image_${assetIds.size}`;
          assets.push({ id, w: m.width, h: m.height, u: '', p: `data:${mime};base64,${readFileSync(m.path).toString('base64')}`, e: 1 });
          assetIds.set(m.id, id);
        }
        return { ...base, ty: 2, refId: id };
      }
      case 'comp': {
        let sub = comps(p).find((x) => x.id === l.compId);
        if (!sub || depth > 8) return null;
        // Essential Graphics: the nested comp with this layer's Master Properties (their value at the layer's start)
        let key = sub.id;
        if (l.overrides?.length && sub.essential?.length) {
          sub = JSON.parse(JSON.stringify(sub)) as Comp;
          for (const o of l.overrides) {
            const ep = sub.essential!.find((x) => x.id === o.id), y = ep && sub.layers.find((z) => z.id === ep.layer);
            if (!ep || !y) continue;
            if (o.prop.k?.length || o.prop.x) warn(`«${l.name}»: la propiedad esencial «${o.name}» animada se exporta con su primer valor.`);
            const v = valueAt(o.prop, l.in, { comp: c, layer: l, path: `essential.${o.id}` });
            if (ep.path === 'source') { y.mediaId = String(v); continue; }
            try { const pr = resolveProp(y, ep.path, false); pr.v = v; delete pr.k; delete pr.x; } catch { /* gone */ }
          }
          key = `${sub.id}_${l.id}`;
        }
        if (!assetIds.has(key)) { const id = `comp_${assetIds.size}`; assetIds.set(key, id); assets.push({ id, nm: sub.name, fr: sub.fps, layers: convComp(sub, depth + 1) }); }
        const out: J = { ...base, ty: 0, refId: assetIds.get(key), w: sub.width, h: sub.height };
        // time remap is in seconds in Lottie
        if (l.timeRemap) out.tm = prop(c, l, l.timeRemap, 'timeRemap', arr, { scalar: true });
        return out;
      }
      case 'text': {
        const d = l.text!;
        if (d.animators.length) warn(`«${l.name}»: los animadores de texto no se exportan.`);
        if (d.path || d.box) warn(`«${l.name}»: texto en trazado o en caja se exporta como texto de punto.`);
        if (d.perChar3D) warn(`«${l.name}»: el 3D por carácter no existe en Lottie (se exporta plano).`);
        const at = (t: number) => {
          const ev = (pr: Prop, k: string) => valueAt(pr, t, { comp: c, layer: l, path: `text.${k}` });
          const size = Number(ev(d.size, 'size')) || 48, sw = Number(ev(d.strokeWidth, 'strokeWidth')) || 0;
          return { s: size, f: d.font, t: String(ev(d.text, 'text')).replace(/\n/g, '\r'), j: d.align === 'right' ? 1 : d.align === 'center' ? 2 : 0, tr: Number(ev(d.tracking, 'tracking')) || 0, lh: d.leading || size * 1.2, ls: 0, fc: rgb(ev(d.fill, 'fill')).slice(0, 3), ...(sw > 0 ? { sc: rgb(ev(d.stroke, 'stroke')).slice(0, 3), sw, of: true } : {}), ...(d.allCaps ? { ca: 1 } : {}) };
        };
        // the text document is hold-keyed in Lottie: one document per source-text key
        const times = d.text.k?.length ? d.text.k.map((k) => k.t) : [l.in];
        if (d.size.k?.length || d.fill.k?.length || d.tracking.k?.length) warn(`«${l.name}»: el tamaño, el color o el interletraje animados se exportan con su valor en cada clave de texto.`);
        fonts.set(d.font, { fName: d.font, fFamily: d.font, fStyle: `${d.weight >= 600 ? 'Bold' : 'Regular'}${d.italic ? ' Italic' : ''}`, ascent: 75 });
        return { ...base, ty: 5, t: { d: { k: times.map((t) => ({ s: at(t), t: r3(((t - l.start) * fps) / (l.stretch || 1)) })) }, p: {}, m: { g: 1, a: { a: 0, k: [0, 0] } }, a: [] } };
      }
      case 'shape': return { ...base, ty: 4, shapes: shapesOf(c, l) };
      default:
        warn(`Capas de tipo ${l.type} no existen en Lottie: «${l.name}» no se exporta.`);
        return null;
    }
  };

  const shapesOf = (c: Comp, l: Layer): J[] => {
    const items = l.shapes ?? [];
    const pp = (s: ShapeItem, pr: Prop | undefined, k: string, conv: (v: PVal) => unknown = arr, o: { spatial?: boolean; scalar?: boolean } = {}) => prop(c, l, pr, `shapes.${s.id}.${k}`, conv, o);
    const geom = (s: ShapeItem): J[] => {
      switch (s.kind) {
        case 'rect': return [{ ty: 'rc', d: 1, p: { a: 0, k: [0, 0] }, s: pp(s, s.size, 'size'), r: pp(s, s.roundness, 'roundness', arr, { scalar: true }) }];
        case 'ellipse': return [{ ty: 'el', d: 1, p: { a: 0, k: [0, 0] }, s: pp(s, s.size, 'size') }];
        case 'star': case 'polygon': return [{ ty: 'sr', d: 1, sy: s.kind === 'star' ? 1 : 2, p: { a: 0, k: [0, 0] }, pt: pp(s, s.points, 'points', arr, { scalar: true }), or: pp(s, s.outerRadius, 'outerRadius', arr, { scalar: true }), os: { a: 0, k: 0 }, r: { a: 0, k: 0 }, ...(s.kind === 'star' ? { ir: pp(s, s.innerRadius, 'innerRadius', arr, { scalar: true }), is: { a: 0, k: 0 } } : {}) }];
        case 'path': return [{ ty: 'sh', d: 1, ks: pp(s, s.path, 'path', (v) => shapeOf(v, s.closed)) }, ...(s.contours ?? []).map((cp) => ({ ty: 'sh', d: 1, ks: { a: 0, k: shapeOf(cp, true) } }))];
        default: return [];
      }
    };
    const modifiers = (s: ShapeItem): J[] => {
      const out: J[] = [];
      if (s.pucker) out.push({ ty: 'pb', a: pp(s, s.pucker.amount, 'pucker.amount', arr, { scalar: true }) });
      if (s.roundCorners) out.push({ ty: 'rd', r: pp(s, s.roundCorners.radius, 'roundCorners.radius', arr, { scalar: true }) });
      if (s.offset) out.push({ ty: 'op', a: pp(s, s.offset.amount, 'offset.amount', arr, { scalar: true }), lj: { miter: 1, round: 2, bevel: 3 }[s.offset.join], ml: { a: 0, k: s.offset.miterLimit } });
      if (s.zigzag) out.push({ ty: 'zz', s: pp(s, s.zigzag.size, 'zigzag.size', arr, { scalar: true }), r: pp(s, s.zigzag.ridges, 'zigzag.ridges', arr, { scalar: true }), pt: { a: 0, k: s.zigzag.smooth ? 2 : 1 } });
      if (s.twist) out.push({ ty: 'tw', a: pp(s, s.twist.angle, 'twist.angle', arr, { scalar: true }), c: pp(s, s.twist.center, 'twist.center') });
      if (s.wiggle) warn(`«${l.name}»: «Ondular trazados» no existe en los reproductores Lottie.`);
      if (s.trim) out.push({ ty: 'tm', s: pp(s, s.trim.start, 'trim.start', arr, { scalar: true }), e: pp(s, s.trim.end, 'trim.end', arr, { scalar: true }), o: pp(s, s.trim.offset, 'trim.offset', arr, { scalar: true }), m: 1 });
      return out;
    };
    const gradient = (s: ShapeItem, g: NonNullable<ShapeItem['gradient']>, base: string, op: Prop) => ({
      t: g.type === 'radial' ? 2 : 1, s: pp(s, g.start, `${base}.start`), e: pp(s, g.end, `${base}.end`), o: pp(s, op, base === 'gradient' ? 'fill.opacity' : 'stroke.opacity', arr, { scalar: true }),
      g: { p: g.colors.length, k: { a: 0, k: g.colors.flatMap((col, i) => [r3(g.colors.length > 1 ? i / (g.colors.length - 1) : 0), ...rgb(col).slice(0, 3)]) } },
    });
    // Lottie draws the first item on top: stroke before fill, so the stroke covers the fill as in Cinta
    const paints = (s: ShapeItem): J[] => {
      const out: J[] = [];
      if (s.stroke.on) {
        const st: J = { lc: { butt: 1, round: 2, square: 3 }[s.stroke.cap], lj: { miter: 1, round: 2, bevel: 3 }[s.stroke.join], ml: 4, w: pp(s, s.stroke.width, 'stroke.width', arr, { scalar: true }) };
        if (s.stroke.dash.length) st.d = s.stroke.dash.map((v, i) => ({ n: i % 2 ? 'g' : 'd', nm: i % 2 ? 'gap' : 'dash', v: { a: 0, k: v } }));
        out.push(s.stroke.gradient ? { ty: 'gs', ...st, ...gradient(s, s.stroke.gradient, 'stroke.gradient', s.stroke.opacity) } : { ty: 'st', ...st, c: pp(s, s.stroke.color, 'stroke.color', rgb), o: pp(s, s.stroke.opacity, 'stroke.opacity', arr, { scalar: true }) });
      }
      if (s.fill.on) out.push(s.gradient ? { ty: 'gf', r: s.fill.rule === 'evenodd' ? 2 : 1, ...gradient(s, s.gradient, 'gradient', s.fill.opacity) } : { ty: 'fl', c: pp(s, s.fill.color, 'fill.color', rgb), o: pp(s, s.fill.opacity, 'fill.opacity', arr, { scalar: true }), r: s.fill.rule === 'evenodd' ? 2 : 1 });
      return out;
    };
    const tr = (s: ShapeItem): J => ({ ty: 'tr', p: pp(s, s.transform.position, 'transform.position', arr, { spatial: true }), a: pp(s, s.transform.anchor, 'transform.anchor', arr, { spatial: true }), s: pp(s, s.transform.scale, 'transform.scale'), r: pp(s, s.transform.rotation, 'transform.rotation', arr, { scalar: true }), o: pp(s, s.transform.opacity, 'transform.opacity', arr, { scalar: true }), sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 } });
    const repeater = (s: ShapeItem): J[] => {
      const r = s.repeater;
      if (!r) return [];
      return [{ ty: 'rp', c: pp(s, r.copies, 'repeater.copies', arr, { scalar: true }), o: { a: 0, k: r.offset }, m: 1, tr: { ty: 'tr', p: pp(s, r.position, 'repeater.position', arr, { spatial: true }), a: { a: 0, k: [0, 0] }, s: pp(s, r.scale, 'repeater.scale'), r: pp(s, r.rotation, 'repeater.rotation', arr, { scalar: true }), so: pp(s, r.startOpacity, 'repeater.startOpacity', arr, { scalar: true }), eo: pp(s, r.endOpacity, 'repeater.endOpacity', arr, { scalar: true }) } }];
    };
    const group = (s: ShapeItem, it: J[]): J => ({ ty: 'gr', nm: s.name, it: [...it, tr(s)] });
    // in Cinta a «Combinar trazados» joins the items below it (up to the previous merge): in Lottie they go into
    // one group with the merge after their outlines and its own paint
    const out: J[] = [];
    for (let i = 0; i < items.length; i++) {
      const s = items[i];
      if (s.kind !== 'merge') { out.push(group(s, [...geom(s), ...modifiers(s), ...paints(s), ...repeater(s)])); continue; }
      let j = i + 1;
      while (j < items.length && items[j].kind !== 'merge') j++;
      const inner = items.slice(i + 1, j).map((x) => group(x, [...geom(x), ...modifiers(x)]));
      out.push(group(s, [...inner, { ty: 'mm', mm: { add: 2, subtract: 3, intersect: 4, exclude: 5 }[s.merge?.mode ?? 'add'] ?? 1 }, ...paints(s)]));
      i = j - 1;
    }
    return out;
  };

  const layers = convComp(main, 0);
  const json: J = {
    v: '5.7.4', fr: main.fps, ip: 0, op: Math.round(main.duration * main.fps), w: main.width, h: main.height, nm: main.name, ddd: 0,
    assets, layers, markers: main.markers.map((m) => ({ tm: Math.round(m.t * main.fps), cm: m.name, dr: 0 })),
    ...(fonts.size ? { fonts: { list: [...fonts.values()] } } : {}),
  };
  if (!main.transparent) warn('El fondo de la composición no forma parte de Lottie (se exporta transparente): añada un sólido si lo necesita.');
  return { json, warnings: [...warnings] };
}
