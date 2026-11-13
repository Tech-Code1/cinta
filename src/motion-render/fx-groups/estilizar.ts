// Drawing of the effects in src/core/motion/fx-groups/estilizar.ts. Helpers come from ../fx: only use them inside
// the functions (fx.ts imports this file while it is still loading). Effects of this line of work that already
// existed (Stylize, Generate, Simulation, Time) are redrawn here too: IMPL_ESTILIZAR is applied after fx.ts' own.
import type { FxFn, FxCtx, Params } from '../fx';
import { mk, ctx2d, blurCanvas } from '../fx';
import { fbm, hash2, parseColor, rnd } from '../../core/motion/anim';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec2 = (v: unknown): [number, number] => (Array.isArray(v) ? [num(v[0]), num(v[1])] : [0, 0]);
/** an effect point (layer px) in canvas px */
const ptc = (v: unknown, x: FxCtx): [number, number] => { const [a, b] = vec2(v); return [(a - (x.pox ?? 0) - x.ox) * x.res, (b - (x.poy ?? 0) - x.oy) * x.res]; };
/** colour param → [r, g, b] 0–255 */
const rgb = (c: unknown): [number, number, number] => { const [r, g, b] = parseColor(String(c ?? '#000')); return [r * 255, g * 255, b * 255]; };
const css = (c: unknown, a = 1) => { const [r, g, b] = rgb(c); return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`; };
const clamp = (v: number, a = 0, b = 255) => (v < a ? a : v > b ? b : v);
const clone = (cv: HTMLCanvasElement) => { const c = mk(cv.width, cv.height); ctx2d(c).drawImage(cv, 0, 0); return c; };
const data = (cv: HTMLCanvasElement) => ctx2d(cv, true).getImageData(0, 0, cv.width, cv.height);

/** «Blend With Original» (0–100 %): the original over the result, inside the layer's alpha */
function blendOrig(orig: HTMLCanvasElement, out: HTMLCanvasElement, blend: number): HTMLCanvasElement {
  if (blend <= 0) return out;
  const g = ctx2d(out);
  g.save(); g.globalAlpha = Math.min(1, blend / 100); g.globalCompositeOperation = 'source-atop'; g.drawImage(orig, 0, 0); g.restore();
  return out;
}

export const IMPL_ESTILIZAR: Record<string, FxFn> = {
  // Mosaic: the layer cut in h × v rectangles (spread evenly over the layer), each one filled with its average colour
  // or, with Sharp Colors, the colour of its centre pixel
  mosaic: (cv, p) => {
    const W = cv.width, H = cv.height, nx = Math.max(1, Math.min(W, Math.round(num(p.h, 10)))), ny = Math.max(1, Math.min(H, Math.round(num(p.v, 10))));
    const img = data(cv), d = img.data, sharp = !!num(p.sharp);
    for (let by = 0; by < ny; by++) {
      const y0 = Math.floor((by * H) / ny), y1 = Math.floor(((by + 1) * H) / ny);
      for (let bx = 0; bx < nx; bx++) {
        const x0 = Math.floor((bx * W) / nx), x1 = Math.floor(((bx + 1) * W) / nx);
        let r = 0, g = 0, b = 0, a = 0;
        if (sharp) { const i = (((y0 + y1) >> 1) * W + ((x0 + x1) >> 1)) * 4; a = d[i + 3]; r = d[i]; g = d[i + 1]; b = d[i + 2]; }
        else {
          // premultiplied average, so transparent pixels do not darken the block
          let n = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4, al = d[i + 3]; r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al; n++; }
          if (a > 0) { r /= a; g /= a; b /= a; }
          a = n ? a / n : 0;
        }
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; }
      }
    }
    const out = mk(W, H); ctx2d(out).putImageData(img, 0, 0);
    return out;
  },
  // Find Edges: per channel (coloured edges), dark lines on white; Invert gives bright lines on black
  findEdges: (cv, p) => {
    const orig = clone(cv), W = cv.width, H = cv.height, img = data(cv), d = img.data, s = d.slice(), inv = !!num(p.invert);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, l = (y * W + Math.max(0, x - 1)) * 4, r = (y * W + Math.min(W - 1, x + 1)) * 4, u = (Math.max(0, y - 1) * W + x) * 4, dn = (Math.min(H - 1, y + 1) * W + x) * 4;
      for (let c = 0; c < 3; c++) { const v = clamp(Math.hypot(s[r + c] - s[l + c], s[dn + c] - s[u + c]) * 2); d[i + c] = inv ? v : 255 - v; }
    }
    ctx2d(cv).putImageData(img, 0, 0);
    return blendOrig(orig, cv, num(p.blend));
  },
  // Emboss / Color Emboss: the difference of the image a «relief» away along the direction (light from there),
  // scaled by the contrast, around grey (Emboss) or around each pixel's colour (Color Emboss)
  // Motion Tile: the tile (a % of the layer around Tile Center) repeated over the output area; Mirror Edges flips
  // every other one; Phase shifts every other column vertically (or row horizontally) by a fraction of a tile
  motionTile: (cv, p, x) => {
    const [cx, cy] = ptc(p.center, x);
    const tw = Math.max(1, (cv.width * num(p.width, 100)) / 100), th = Math.max(1, (cv.height * num(p.height, 100)) / 100);
    const ow = (cv.width * num(p.outW, 100)) / 100, oh = (cv.height * num(p.outH, 100)) / 100;
    const tile = mk(tw, th);
    ctx2d(tile).drawImage(cv, cx - tw / 2, cy - th / 2, tw, th, 0, 0, tw, th);
    const out = mk(cv.width, cv.height), g = ctx2d(out);
    const mir = !!num(p.mirror), hs = !!num(p.hShift), ph = (((num(p.phase) / 360) % 1) + 1) % 1;
    const x0 = cv.width / 2 - ow / 2, y0 = cv.height / 2 - oh / 2;
    g.beginPath(); g.rect(x0, y0, ow, oh); g.clip();
    for (let j = Math.floor((y0 - cy + th / 2) / th) - 2; j * th + cy - th / 2 < y0 + oh + th; j++) for (let i = Math.floor((x0 - cx + tw / 2) / tw) - 2; i * tw + cx - tw / 2 < x0 + ow + tw; i++) {
      const sx = hs && j % 2 ? ph * tw : 0, sy = !hs && i % 2 ? ph * th : 0;
      g.save();
      g.translate(cx + i * tw + sx, cy + j * th + sy);
      if (mir) g.scale(i % 2 ? -1 : 1, j % 2 ? -1 : 1);
      g.drawImage(tile, -tw / 2, -th / 2);
      g.restore();
    }
    return out;
  },
  // Gradient Ramp: linear or radial ramp inside the layer's alpha; Ramp Scatter dithers it (± levels, fixed noise);
  // «Swap Colors» (a button in After Effects) is a checkbox here
  gradientRamp: (cv, p, x) => {
    const orig = clone(cv), out = clone(cv), g = ctx2d(out);
    const [x0, y0] = ptc(p.start, x), [x1, y1] = ptc(p.end, x), sw = !!num(p.swap);
    const gr = p.type === 'radial' ? g.createRadialGradient(x0, y0, 0, x0, y0, Math.hypot(x1 - x0, y1 - y0)) : g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, css(sw ? p.endColor : p.startColor));
    gr.addColorStop(1, css(sw ? p.startColor : p.endColor));
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = gr;
    g.fillRect(0, 0, out.width, out.height);
    const sc = num(p.scatter);
    if (sc > 0) {
      const img = data(out), d = img.data, W = out.width, amp = Math.min(255, sc);
      for (let i = 0; i < d.length; i += 4) { const k = i >> 2, h = Math.sin((k % W) * 12.9898 + Math.floor(k / W) * 78.233) * 43758.5453, r = (h - Math.floor(h) - 0.5) * amp; d[i] = clamp(d[i] + r); d[i + 1] = clamp(d[i + 1] + r); d[i + 2] = clamp(d[i + 2] + r); }
      g.putImageData(img, 0, 0);
    }
    return blendOrig(orig, out, num(p.blend));
  },
  // Grid: lines through Anchor every cell (from the Corner point, the Width slider or Width & Height), Border thick,
  // feathered across (Feather Width for the vertical lines, Height for the horizontal ones); Invert Grid fills the cells.
  // Projects from before the After Effects parameters (no «sizeFrom») keep their square cells drawn over the layer
  grid: (cv, p, x) => {
    const W = cv.width, H = cv.height, r = x.res, [ax, ay] = ptc(p.anchor, x);
    const from = p.sizeFrom === undefined ? 'width' : String(p.sizeFrom);
    let cw: number, chh: number;
    if (from === 'corner') { const [qx, qy] = ptc(p.corner, x); cw = Math.abs(qx - ax); chh = Math.abs(qy - ay); }
    else { cw = num(p.size, 32) * r; chh = from === 'widthHeight' ? num(p.height, 24) * r : cw; }
    cw = Math.max(1, cw); chh = Math.max(1, chh);
    const b = Math.max(0, num(p.width, 5) * r) / 2, fw = num(p.featherW) * r / 2, fh = num(p.featherH) * r / 2, inv = !!num(p.invert);
    const cover = (d: number, f: number) => (f <= 0 ? (d <= b ? 1 : 0) : clamp((b + f - d) / (2 * f), 0, 1));
    const gen = mk(W, H), img = new ImageData(W, H), d = img.data, [cr, cg, cb] = rgb(p.color ?? '#ffffff');
    for (let y = 0; y < H; y++) {
      const my = ((((y + 0.5 - ay) % chh) + chh) % chh), dy = Math.min(my, chh - my), hy = cover(dy, fh);
      for (let X = 0; X < W; X++) {
        const mx = ((((X + 0.5 - ax) % cw) + cw) % cw), dx = Math.min(mx, cw - mx);
        let c = Math.max(hy, cover(dx, fw));
        if (inv) c = 1 - c;
        const i = (y * W + X) * 4; d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = c * 255;
      }
    }
    ctx2d(gen).putImageData(img, 0, 0);
    return genBlend(cv, gen, p.blendMode === undefined ? 'normal' : String(p.blendMode), num(p.opacity, 100) / 100);
  },
  // Checkerboard: squares from Anchor (size from the Corner point, Width, or Width & Height), every other one filled,
  // edges feathered; projects from before the After Effects parameters keep their square cells drawn over the layer
  checkerboard: (cv, p, x) => {
    const W = cv.width, H = cv.height, r = x.res, [ax, ay] = ptc(p.anchor, x);
    const from = p.sizeFrom === undefined ? 'width' : String(p.sizeFrom);
    let cw: number, chh: number;
    if (from === 'corner') { const [qx, qy] = ptc(p.corner, x); cw = Math.abs(qx - ax); chh = Math.abs(qy - ay); }
    else { cw = num(p.size, 16) * r; chh = from === 'widthHeight' ? num(p.height, 8) * r : cw; }
    cw = Math.max(1, cw); chh = Math.max(1, chh);
    const fw = num(p.featherW) * r / 2, fh = num(p.featherH) * r / 2;
    // signed side of the cell along one axis, softened within the feather of its edges
    const side = (v: number, c: number, f: number) => { const k = Math.floor(v / c), m = v - k * c, d = Math.min(m, c - m), s = k % 2 === 0 ? 1 : -1; return f <= 0 ? s : s * Math.min(1, d / f); };
    const img = new ImageData(W, H), d = img.data, [cr, cg, cb] = rgb(p.color ?? '#ffffff');
    for (let y = 0; y < H; y++) {
      const sy = side(y + 0.5 - ay, chh, fh);
      for (let X = 0; X < W; X++) { const i = (y * W + X) * 4; d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = ((1 + side(X + 0.5 - ax, cw, fw) * sy) / 2) * 255; }
    }
    const gen = mk(W, H); ctx2d(gen).putImageData(img, 0, 0);
    return genBlend(cv, gen, p.blendMode === undefined ? 'normal' : String(p.blendMode), num(p.opacity, 100) / 100);
  },
  // Circle: a disc, or a ring (Edge: an Edge Radius, a Thickness, or a thickness — and feather — proportional to the
  // radius), outer and inner edges feathered, optionally inverted
  circle: (cv, p, x) => {
    const W = cv.width, H = cv.height, r = x.res, [cx, cy] = ptc(p.center, x);
    const R = Math.abs(num(p.radius, 75)) * r, e = String(p.edge ?? 'none'), t = num(p.thickness, 10) * r;
    let fo = num(p.feather) * r, fi = num(p.featherInner) * r, inner = -1, outer = R;
    if (e === 'edgeRadius') { inner = Math.min(R, t); outer = Math.max(R, t); }
    else if (e === 'thickness') { inner = R - t / 2; outer = R + t / 2; }
    else if (e === 'thicknessRadius' || e === 'thicknessFeather') {
      const k = R / (100 * r), th = t * k; inner = R - th / 2; outer = R + th / 2;
      if (e === 'thicknessFeather') { fo *= k; fi *= k; }
    }
    const inv = !!num(p.invert), [cr, cg, cb] = rgb(p.color ?? '#ffffff');
    // the feathers fade outwards from the edge (outer) and into the hole (inner)
    const edge = (v: number, f: number) => (f <= 0 ? (v >= 0 ? 1 : 0) : clamp(v / f + 1, 0, 1));
    const img = new ImageData(W, H), d = img.data;
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const dist = Math.hypot(X + 0.5 - cx, y + 0.5 - cy);
      let a = edge(outer - dist, fo) * (inner < 0 ? 1 : edge(dist - inner, fi));
      if (inv) a = 1 - a;
      const i = (y * W + X) * 4; d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = a * 255;
    }
    const gen = mk(W, H); ctx2d(gen).putImageData(img, 0, 0);
    return genBlend(cv, gen, p.blendMode === undefined ? 'normal' : String(p.blendMode), num(p.opacity, 100) / 100);
  },
  // Lens Flare: a light at Flare Center added onto the layer — core glow, streak, a halo ring for the primes, and the
  // ghost elements on the line through the layer's centre; each Lens Type has its own set of elements
  lensFlare: (cv, p, x) => {
    const orig = clone(cv), out = clone(cv), g = ctx2d(out);
    const [cx, cy] = ptc(p.center, x), b = Math.max(0, num(p.brightness, 100)) / 100, lens = String(p.lensType ?? 'zoom');
    const W = out.width, H = out.height, R = Math.hypot(W, H);
    g.globalCompositeOperation = 'lighter';
    const blob = (x0: number, y0: number, r: number, col: string, a: number, ring = 0) => {
      if (r <= 0 || a <= 0) return;
      const gr = g.createRadialGradient(x0, y0, ring ? r * (1 - ring) : 0, x0, y0, r);
      if (ring) { gr.addColorStop(0, css(col, 0)); gr.addColorStop(0.5, css(col, Math.min(1, a))); gr.addColorStop(1, css(col, 0)); }
      else { gr.addColorStop(0, css(col, Math.min(1, a))); gr.addColorStop(1, css(col, 0)); }
      g.fillStyle = gr; g.fillRect(x0 - r, y0 - r, r * 2, r * 2);
    };
    // [position along centre axis (0 = light, 1 = mirrored through the centre), radius (× diagonal), colour, alpha, ring]
    const SETS: Record<string, [number, number, string, number, number][]> = {
      zoom: [[0.25, 0.012, '#7fb2ff', 0.5, 0], [0.42, 0.03, '#61ff9b', 0.22, 0], [0.55, 0.018, '#ffb36b', 0.35, 0], [0.7, 0.05, '#b48cff', 0.18, 0], [0.82, 0.008, '#ffffff', 0.6, 0], [1.0, 0.035, '#6bd2ff', 0.25, 0], [1.15, 0.07, '#ff8a6b', 0.14, 0.35], [1.35, 0.02, '#ffe36b', 0.3, 0], [1.6, 0.11, '#6b8aff', 0.12, 0.2]],
      prime35: [[0.35, 0.04, '#ff9a6b', 0.25, 0], [0.75, 0.025, '#7fffd0', 0.3, 0], [1.2, 0.09, '#7fa0ff', 0.16, 0.3], [1.55, 0.05, '#ffd36b', 0.2, 0]],
      prime105: [[0.5, 0.015, '#ffcf8a', 0.4, 0], [0.9, 0.03, '#8ab4ff', 0.25, 0], [1.3, 0.05, '#ff8ad0', 0.15, 0.4]],
    };
    const glow = lens === 'prime105' ? 0.12 : lens === 'prime35' ? 0.3 : 0.22;
    blob(cx, cy, R * glow * Math.sqrt(b), '#fff1d0', 0.9 * b);
    blob(cx, cy, R * 0.05 * Math.sqrt(b), '#ffffff', Math.min(1, 1.2 * b));
    if (lens === 'prime35') blob(cx, cy, R * 0.16 * Math.sqrt(b), '#ffd6a0', 0.25 * b, 0.25);
    // the horizontal streak and a few rays
    g.save(); g.translate(cx, cy);
    const sl = R * (lens === 'prime105' ? 0.12 : 0.28) * b, sg = g.createLinearGradient(-sl, 0, sl, 0);
    sg.addColorStop(0, css('#ffe9c0', 0)); sg.addColorStop(0.5, css('#fff6e0', Math.min(1, 0.7 * b))); sg.addColorStop(1, css('#ffe9c0', 0));
    g.fillStyle = sg; g.fillRect(-sl, -Math.max(1, R * 0.0025), sl * 2, Math.max(2, R * 0.005));
    g.restore();
    const ax = W / 2 - cx, ay = H / 2 - cy;
    for (const [k, r, col, a, ring] of SETS[lens] ?? SETS.zoom) blob(cx + ax * k * 2, cy + ay * k * 2, R * r, col, a * b, ring);
    return blendOrig(orig, out, num(p.blend));
  },
  // CC Vignette: the natural light fall-off of a lens (cos⁴ of the angle off axis) for its Angle of View, around Center;
  // a negative Amount brightens the corners; Pin Highlights keeps the bright pixels. Projects from before (Amount / Size /
  // Softness) keep their soft dark ring
  vignette: (cv, p, x) => {
    const W = cv.width, H = cv.height;
    if (p.angleOfView === undefined && p.size !== undefined) {
      const out = clone(cv), g = ctx2d(out), r = Math.hypot(W, H) / 2;
      const size = num(p.size, 60) / 100, soft = Math.max(0.01, num(p.softness, 60) / 100);
      const gr = g.createRadialGradient(W / 2, H / 2, r * size * (1 - soft * 0.8), W / 2, H / 2, r * Math.min(1.4, size + soft * 0.6));
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${num(p.amount, 60) / 100})`);
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = gr; g.fillRect(0, 0, W, H);
      return out;
    }
    const [cx, cy] = p.center === undefined ? [W / 2, H / 2] : ptc(p.center, x);
    const amt = num(p.amount, 100) / 100, half = (Math.min(179, Math.max(0, num(p.angleOfView, 45))) * Math.PI) / 360, pin = num(p.pinHighlights) / 100;
    const R = Math.hypot(W, H) / 2, img = data(cv), d = img.data;
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const th = Math.atan((Math.hypot(X + 0.5 - cx, y + 0.5 - cy) / R) * Math.tan(half)), c = Math.cos(th), f = c * c * c * c;
      const i = (y * W + X) * 4, L = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      let k = amt >= 0 ? 1 - amt * (1 - f) : 1 + -amt * (1 / f - 1);
      k = 1 + (k - 1) * (1 - pin * L);
      d[i] = clamp(d[i] * k); d[i + 1] = clamp(d[i + 1] * k); d[i + 2] = clamp(d[i + 2] * k);
    }
    ctx2d(cv).putImageData(img, 0, 0);
    return cv;
  },
  // CC Light Rays: the light inside Radius around Center (Round or Square, turned by Direction, edge softened by Warp
  // Softness) streams outwards in rays; its colour comes from the layer or from Color; Transfer Mode puts the rays on
  // the layer (None: the rays alone). Old projects (Intensity 0–5 and Length) keep their zoom streaks
  lightRays: (cv, p, x) => {
    const W = cv.width, H = cv.height, [cx, cy] = ptc(p.center, x), legacy = p.radius === undefined;
    const I = legacy ? num(p.intensity, 1) : Math.max(0, num(p.intensity, 100)) / 100, len = legacy ? num(p.length, 30) / 100 : 1.5;
    let src: HTMLCanvasElement = cv;
    if (!legacy) {
      // the light source: the layer (or the colour) inside the radius
      const R = Math.max(0.5, num(p.radius, 40) * x.res), soft = Math.max(0, num(p.warpSoftness, 50)) / 100, sq = p.shape === 'square';
      src = mk(W, H); const sg = ctx2d(src);
      if (num(p.colorFromSource, 1)) sg.drawImage(cv, 0, 0); else { sg.fillStyle = css(p.color ?? '#ffffff'); sg.fillRect(0, 0, W, H); sg.globalCompositeOperation = 'destination-in'; sg.drawImage(cv, 0, 0); }
      const m = mk(W, H), mg = ctx2d(m);
      if (sq) { mg.translate(cx, cy); mg.rotate((num(p.direction) * Math.PI) / 180); mg.filter = soft > 0 ? `blur(${R * soft * 0.5}px)` : 'none'; mg.fillStyle = '#fff'; mg.fillRect(-R, -R, R * 2, R * 2); }
      else { const gr = mg.createRadialGradient(cx, cy, R * (1 - Math.min(1, soft)), cx, cy, R); gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)'); mg.fillStyle = gr; mg.fillRect(0, 0, W, H); }
      sg.globalCompositeOperation = 'destination-in'; sg.drawImage(m, 0, 0);
    }
    const n = 32, rays = mk(W, H), g = ctx2d(rays);
    g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n, s = 1 + f * len * (legacy ? 1 : 4);
      g.globalAlpha = Math.min(1, (legacy ? 1 : (1 - f) * 2) / n * (legacy ? 1 : 3));
      g.setTransform(s, 0, 0, s, cx - cx * s, cy - cy * s); g.drawImage(src, 0, 0);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (legacy) { const out = clone(cv), og = ctx2d(out); og.globalCompositeOperation = 'lighter'; for (let r = I; r > 0; r -= 1) { og.globalAlpha = Math.min(1, r); og.drawImage(rays, 0, 0); } return out; }
    const tm = String(p.transfer ?? 'add'), out = tm === 'none' ? mk(W, H) : clone(cv), og = ctx2d(out);
    // without Allow Brightening the rays never go past their own colour (lighten instead of add)
    og.globalCompositeOperation = tm === 'lighten' || (tm === 'add' && !num(p.allowBrightening, 1)) ? 'lighten' : tm === 'screen' ? 'screen' : 'lighter';
    for (let r = I; r > 0; r -= 1) { og.globalAlpha = Math.min(1, r); og.drawImage(rays, 0, 0); }
    return out;
  },
  cellPattern: (cv, p, x) => cellPattern(cv, p, x),
  fractalNoise: (cv, p, x) => fractalNoise(cv, p, x),
  emboss: (cv, p, x) => emboss(cv, p, x, false),
  colorEmboss: (cv, p, x) => emboss(cv, p, x, true),
};

/** Echo: the layer now (k = 0) and its echoes (k = 1…n), each weighted start × decay^k, combined per pixel with the
 * Echo Operator (premultiplied): add, maximum, minimum, screen, composite in back (echoes behind the layer), composite
 * in front (echoes over it) or blend (their average). Old projects' 'composite' is «composite in back». */
export function echoCombine(layers: (HTMLCanvasElement | null)[], start: number, decay: number, op: string): HTMLCanvasElement {
  const base = layers[0]!, W = base.width, H = base.height, n = W * H * 4;
  const acc = new Float32Array(n);
  const ds = layers.map((c) => (c ? data(c).data : null));
  const wk = layers.map((_, k) => Math.max(0, start * Math.pow(decay, k)));
  const mn = op === 'min', count = ds.filter(Boolean).length || 1;
  if (mn) acc.fill(1);
  for (let k = 0; k < ds.length; k++) {
    const d = ds[k]; if (!d) continue;
    const w = wk[k];
    for (let i = 0; i < n; i += 4) {
      const a = (d[i + 3] / 255) * w;
      const c = [(d[i] / 255) * a, (d[i + 1] / 255) * a, (d[i + 2] / 255) * a, a];
      for (let j = 0; j < 4; j++) {
        const o = acc[i + j], v = c[j];
        acc[i + j] = op === 'max' ? Math.max(o, v) : mn ? Math.min(o, v) : op === 'screen' ? 1 - (1 - o) * (1 - v)
          : op === 'composite' ? o + (1 - acc[i + 3]) * v // behind what is there (alpha is updated last)
          : op === 'front' ? v + (1 - a) * o
          : o + v; // add, blend (divided below)
      }
    }
  }
  const img = new ImageData(W, H), d = img.data, div = op === 'blend' ? count : 1;
  for (let i = 0; i < n; i += 4) {
    const a = Math.min(1, acc[i + 3] / div);
    if (a <= 0) continue;
    d[i + 3] = a * 255;
    for (let j = 0; j < 3; j++) d[i + j] = clamp((acc[i + j] / div / a) * 255);
  }
  const out = mk(W, H); ctx2d(out).putImageData(img, 0, 0);
  return out;
}

/** After Effects' generator «Blending Mode» (Grid, Checkerboard, Circle, Fractal Noise…): what the effect drew (gen,
 * with its own alpha) at `opacity` on the layer: None = only the effect, Stencil Alpha = the layer cut by it, the rest
 * the usual blending modes over the layer */
const OPS: Record<string, GlobalCompositeOperation> = { normal: 'source-over', add: 'lighter', multiply: 'multiply', screen: 'screen', overlay: 'overlay', softLight: 'soft-light', hardLight: 'hard-light', colorDodge: 'color-dodge', colorBurn: 'color-burn', darken: 'darken', lighten: 'lighten', difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity' };
export function genBlend(orig: HTMLCanvasElement, gen: HTMLCanvasElement, mode: string, opacity: number): HTMLCanvasElement {
  const out = mk(orig.width, orig.height), g = ctx2d(out), a = Math.max(0, Math.min(1, opacity));
  if (mode === 'none') { g.globalAlpha = a; g.drawImage(gen, 0, 0); return out; }
  g.drawImage(orig, 0, 0);
  if (mode === 'stencilAlpha') {
    // the layer shows through the effect's alpha (opacity mixes towards the untouched layer)
    const m = mk(out.width, out.height), mg = ctx2d(m);
    mg.fillStyle = `rgba(0,0,0,${1 - a})`; mg.fillRect(0, 0, m.width, m.height);
    mg.globalAlpha = a; mg.drawImage(gen, 0, 0);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(m, 0, 0);
    return out;
  }
  g.globalAlpha = a; g.globalCompositeOperation = OPS[mode] ?? 'source-over'; g.drawImage(gen, 0, 0);
  return out;
}

/** After Effects' «Overflow» for values outside 0–1: Clip, Soft Clamp (an S curve) or Wrap Back (folded back) */
export function overflow(v: number, mode: string): number {
  if (mode === 'soft') return 1 / (1 + Math.exp(-(v - 0.5) * 6)) * 1.05 - 0.025;
  if (mode === 'wrap') { const t = ((v % 2) + 2) % 2; return t > 1 ? 2 - t : t; }
  return v;
}

/** Cell Pattern (Worley cells, our own shading per pattern): F1 / F2 = distances to the two nearest cell points */
function cellPattern(cv: HTMLCanvasElement, p: Params, x: FxCtx): HTMLCanvasElement {
  const W = cv.width, H = cv.height, type = String(p.type ?? 'bubbles'), hq = /HQ$/.test(type), base = type.replace(/HQ$/, '');
  const size = Math.max(2, num(p.size, 60)), disp = p.overflow === undefined ? num(p.disperse, 100) / 100 : num(p.disperse, 1); // old projects: a percentage
  const con = num(p.contrast, 100) / 100, inv = !!num(p.invert), seed = hash2(Math.round(num(p.seed)), 77), ov = String(p.overflow ?? 'clip');
  const tile = !!num(p.tiling), th = Math.max(1, Math.round(num(p.cellsH, 4))), tv = Math.max(1, Math.round(num(p.cellsV, 4)));
  const cyc = !!num(p.cycle), revs = Math.max(1, Math.round(num(p.cycleRevs, 1)));
  let evo = num(p.evolution) / 360; if (cyc) evo = ((evo % revs) + revs) % revs;
  const [offx, offy] = vec2(p.offset);
  // the offset point is where the pattern's origin sits (default the layer centre, so cells grow from the middle)
  const q = Math.max(1, Math.round(Math.min(W, H) / 400)), sw = Math.ceil(W / q), sh = Math.ceil(H / q);
  const feat = (ci: number, cj: number): [number, number, number] => {
    if (tile) { ci = ((ci % th) + th) % th; cj = ((cj % tv) + tv) % tv; }
    const h = hash2(hash2(seed, ci), cj), sp = cyc ? 1 + Math.floor(rnd(h, 4) * 2) : 0.6 + rnd(h, 4) * 0.8; // whole turns when cycling
    const a = rnd(h, 0) * Math.PI * 2 + evo * Math.PI * 2 * sp, r = rnd(h, 1) * 0.45 * disp;
    return [0.5 + Math.cos(a) * r + (rnd(h, 2) - 0.5) * 0.5 * disp, 0.5 + Math.sin(a) * r + (rnd(h, 3) - 0.5) * 0.5 * disp, h];
  };
  const img = new ImageData(sw, sh), d = img.data, nb = hq ? 2 : 1;
  for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
    const X = ((i * q) / x.res + x.ox - offx) / size, Y = ((j * q) / x.res + x.oy - offy) / size;
    const ci = Math.floor(X), cj = Math.floor(Y);
    let f1 = 9, f2 = 9, id = 0;
    for (let b = -nb; b <= nb; b++) for (let a = -nb; a <= nb; a++) {
      const [fx, fy, h] = feat(ci + a, cj + b), dd = Math.hypot(ci + a + fx - X, cj + b + fy - Y);
      if (dd < f1) { f2 = f1; f1 = dd; id = h; } else if (dd < f2) f2 = dd;
    }
    const e = f2 - f1, shade = rnd(id, 9);
    let v: number;
    switch (base) {
      case 'crystals': v = Math.min(1, e * 2.2); break;
      case 'plates': v = 0.15 + 0.85 * (0.5 + 0.5 * Math.cos((shade + evo) * Math.PI * 2)) * Math.min(1, e * 8); break;
      case 'staticPlates': v = (0.15 + 0.85 * shade) * Math.min(1, e * 8); break;
      case 'crystallize': v = shade * 0.75 + Math.min(1, e * 2) * 0.25; break;
      case 'pillow': v = Math.sqrt(Math.min(1, e * 2.5)); break;
      case 'mixedCrystals': v = Math.min(1, e * 2.2) * (0.35 + 0.65 * shade); break;
      case 'tubular': v = Math.max(0, 1 - Math.abs(e - 0.12) * 6); break;
      case 'cracks': v = Math.min(1, e * 4); break; // Cinta's earlier pattern (old projects)
      default: v = Math.max(0, 1 - f1 * 1.35); // bubbles: bright round cells
    }
    v = (v - 0.5) * con + 0.5 + num(p.brightness) / 100;
    v = overflow(v, ov);
    if (inv) v = 1 - v;
    const k = (j * sw + i) * 4;
    d[k] = d[k + 1] = d[k + 2] = clamp(v * 255); d[k + 3] = 255;
  }
  const small = mk(sw, sh); ctx2d(small).putImageData(img, 0, 0);
  const out = mk(W, H), g = ctx2d(out);
  g.imageSmoothingQuality = 'high'; g.drawImage(small, 0, 0, W, H);
  g.globalCompositeOperation = 'destination-in'; g.drawImage(cv, 0, 0);
  return blendOrig(cv, out, num(p.blend));
}

// ───────────── 3-D value noise (our own lattice noise; the Noise Type picks the interpolation) ─────────────
const PERM = (() => { const p = Array.from({ length: 256 }, (_, i) => i); let s = 1234567; for (let i = 255; i > 0; i--) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; } return Uint8Array.from([...p, ...p]); })();
const VAL = Float32Array.from({ length: 256 }, (_, i) => ((PERM[i] * 7919 + 31) % 256) / 127.5 - 1);
/** noise in [-1, 1]; kind: block | linear | soft (smoothstep) | spline (quintic) */
export function noise3(x: number, y: number, z: number, kind: string): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let u = x - xi, v = y - yi, w = z - zi;
  if (kind === 'block') { u = v = w = 0; }
  else if (kind === 'soft') { u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v); w = w * w * (3 - 2 * w); }
  else if (kind === 'spline') { u = u * u * u * (u * (u * 6 - 15) + 10); v = v * v * v * (v * (v * 6 - 15) + 10); w = w * w * w * (w * (w * 6 - 15) + 10); }
  const X = xi & 255, Y = yi & 255, Z = zi & 255;
  const a = PERM[X] + Y, b = PERM[X + 1] + Y, aa = PERM[a] + Z, ab = PERM[a + 1] + Z, ba = PERM[b] + Z, bb = PERM[b + 1] + Z;
  const l = (p: number, q: number, t: number) => p + (q - p) * t;
  return l(l(l(VAL[PERM[aa]], VAL[PERM[ba]], u), l(VAL[PERM[ab]], VAL[PERM[bb]], u), v), l(l(VAL[PERM[aa + 1]], VAL[PERM[ba + 1]], u), l(VAL[PERM[ab + 1]], VAL[PERM[bb + 1]], u), v), w);
}

/** Fractal Noise: octaves of noise (Complexity; each one scaled by Sub Scaling, weighted by Sub Influence, turned by
 * Sub Rotation and moved by Sub Offset) combined per Fractal Type, around Offset Turbulence, evolving along a third
 * axis (Evolution; Cycle Evolution loops it), then contrast, brightness, overflow and invert; drawn with Opacity and
 * Blending Mode. Old projects (no «fractal type» of After Effects) keep their scale-200 look, stretch and blend */
function fractalNoise(cv: HTMLCanvasElement, p: Params, x: FxCtx): HTMLCanvasElement {
  const W = cv.width, H = cv.height, legacy = p.noiseType === undefined;
  const type = String(p.type ?? 'basic'), kind = legacy ? 'soft' : String(p.noiseType);
  const uni = legacy ? false : !!num(p.uniform, 1), sc = num(p.scale, 100);
  const sw0 = Math.max(1, legacy ? sc : uni ? sc : num(p.scaleWidth, 100)), sh0 = Math.max(1, legacy ? sc * Math.max(0.05, num(p.stretch, 100) / 100) : uni ? sc : num(p.scaleHeight, 100));
  const rot = (num(p.rotation) * Math.PI) / 180, [ox, oy] = vec2(p.offset);
  const cplx = Math.max(1, Math.min(20, num(p.complexity, 6))), inf = num(p.subInfluence, 70) / 100, subS = Math.max(0.1, num(p.subScaling, 56) / 100);
  const subR = (num(p.subRotation) * Math.PI) / 180, [sox, soy] = vec2(p.subOffset), centre = !!num(p.centerSubscale);
  const seedZ = (num(p.seed) * 7.31) % 251, cyc = !!num(p.cycle), revs = Math.max(1, Math.round(num(p.cycleRevs, 1)));
  const evo = num(p.evolution) / 360, con = num(p.contrast, 100) / 100, bri = num(p.brightness) / 100, inv = !!num(p.invert);
  // perspective offset: deeper octaves drift less (a parallax), so moving Offset Turbulence looks three-dimensional
  const persp = !!num(p.perspective);
  const q = Math.max(1, Math.round(Math.min(W, H) / 300)), sw = Math.ceil(W / q), sh = Math.ceil(H / q);
  const cr = Math.cos(rot), sr = Math.sin(rot), n = Math.ceil(cplx);
  const oct = Array.from({ length: n }, (_, o) => {
    const s = Math.pow(subS, o), a = rot + subR * o;
    return { f: 1 / s, amp: Math.pow(inf, o) * (o === n - 1 && cplx % 1 ? cplx % 1 : 1), c: Math.cos(a), s: Math.sin(a), dx: (centre ? 0 : o * 13.7) + (sox * o) / sw0, dy: (centre ? 0 : o * 7.3) + (soy * o) / sh0, par: persp ? Math.pow(0.7, o) : 1 };
  });
  const N = (X: number, Y: number, z: number) => {
    if (!cyc) return noise3(X, Y, z, kind);
    // looping evolution: cross-fade the noise one cycle back
    const t = ((z % revs) + revs) % revs, k = t / revs;
    return noise3(X, Y, t + seedZ, kind) * (1 - k) + noise3(X, Y, t - revs + seedZ + 97, kind) * k;
  };
  const img = new ImageData(sw, sh), d = img.data;
  for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
    const gx = (i * q) / x.res + x.ox, gy = (j * q) / x.res + x.oy;
    let v = 0, norm = 0, mx = -1, wx = 0, wy = 0;
    for (let o = 0; o < n; o++) {
      const O = oct[o], lx = gx - ox * O.par, ly = gy - oy * O.par;
      const px = (lx * (o ? O.c : cr) + ly * (o ? O.s : sr)) / sw0, py = (-lx * (o ? O.s : sr) + ly * (o ? O.c : cr)) / sh0;
      let X = px * O.f + O.dx + wx, Y = py * O.f + O.dy + wy;
      if (type === 'swirly') { const r = Math.hypot(px, py), a = r * 2; const t = X; X = X * Math.cos(a) - Y * Math.sin(a); Y = t * Math.sin(a) + Y * Math.cos(a); }
      let nz = N(X, Y, cyc ? evo : evo + seedZ + o * 31.7);
      switch (type) {
        case 'turbulentSmooth': nz = nz * nz * 2 - 1; break;
        case 'turbulent': nz = Math.abs(nz) * 2 - 1; break;
        case 'turbulentSharp': nz = Math.sqrt(Math.abs(nz)) * 2 - 1; break;
        case 'rocky': nz = (1 - Math.abs(nz)) * 2 - 1; nz = nz * Math.abs(nz); break;
        case 'strings': nz = Math.pow(1 - Math.abs(nz), 6) * 2 - 1; break;
        case 'threads': nz = Math.pow(1 - Math.abs(nz), 3) * 2 - 1; break;
        case 'smallBumps': nz = o === 0 ? 0 : Math.abs(nz) * 2 - 1; break;
        case 'subscale': nz = o === 0 ? 0 : nz; break;
        case 'terrain': nz = o === 0 ? nz : nz * Math.max(0, v / Math.max(1e-6, norm) + 0.5); break;
        default:
      }
      // dynamic types warp the next octave with this one
      if (type === 'dynamic' || type === 'dynamicProgressive' || type === 'smeary') { wx += nz * (type === 'smeary' ? 1.6 : 0.6) * (type === 'dynamicProgressive' ? 1 + o * 0.3 : 1); wy += nz * 0.3; }
      if (type === 'dynamicTwist') { const t = wx; wx = wx * 0.8 - nz * 0.6; wy = t * 0.6 + nz * 0.8; }
      if (type === 'max') mx = Math.max(mx, nz * O.amp);
      v += nz * O.amp; norm += O.amp;
    }
    let val = type === 'max' ? mx : v / (norm || 1);
    if (type === 'cloudy') val = Math.tanh(val * 1.6);
    val = val * 0.5 * con + 0.5 + bri;
    val = overflow(val, legacy ? 'clip' : String(p.overflow ?? 'hdr'));
    if (inv) val = 1 - val;
    const k = (j * sw + i) * 4;
    d[k] = d[k + 1] = d[k + 2] = clamp(val * 255); d[k + 3] = 255;
  }
  const small = mk(sw, sh); ctx2d(small).putImageData(img, 0, 0);
  const gen = mk(W, H), g = ctx2d(gen);
  g.imageSmoothingQuality = 'high'; g.drawImage(small, 0, 0, W, H);
  if (legacy) { g.globalCompositeOperation = 'destination-in'; g.drawImage(cv, 0, 0); return blendOrig(cv, gen, num(p.blend)); }
  // the noise covers the layer's own area (its alpha), then goes on it with the blending mode
  g.globalCompositeOperation = 'destination-in'; g.drawImage(cv, 0, 0);
  return genBlend(cv, gen, String(p.blendMode ?? 'normal'), num(p.opacity, 100) / 100);
}

/** bilinear sample of channel c of RGBA data at (x, y), clamped to the edges */
function samp(s: Uint8ClampedArray, W: number, H: number, x: number, y: number, c: number): number {
  x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = x - x0, fy = y - y0;
  const a = s[(y0 * W + x0) * 4 + c], b = s[(y0 * W + x1) * 4 + c], d = s[(y1 * W + x0) * 4 + c], e = s[(y1 * W + x1) * 4 + c];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
}

function emboss(cv: HTMLCanvasElement, p: Params, x: FxCtx, color: boolean): HTMLCanvasElement {
  const orig = clone(cv), W = cv.width, H = cv.height, img = data(cv), d = img.data, s = d.slice();
  const a = (num(p.direction, 45) * Math.PI) / 180, r = num(p.relief, 1) * x.res, k = num(p.contrast, 100) / 100;
  const dx = Math.cos(a) * r, dy = -Math.sin(a) * r;
  for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
    const i = (y * W + X) * 4;
    if (color) for (let c = 0; c < 3; c++) d[i + c] = clamp(s[i + c] + (samp(s, W, H, X + dx, y + dy, c) - samp(s, W, H, X - dx, y - dy, c)) * k);
    else {
      const L = (xx: number, yy: number) => 0.299 * samp(s, W, H, xx, yy, 0) + 0.587 * samp(s, W, H, xx, yy, 1) + 0.114 * samp(s, W, H, xx, yy, 2);
      d[i] = d[i + 1] = d[i + 2] = clamp(128 + (L(X + dx, y + dy) - L(X - dx, y - dy)) * k);
    }
  }
  ctx2d(cv).putImageData(img, 0, 0);
  return blendOrig(orig, cv, num(p.blend));
}

// ───────────────────────── effects added from After Effects (fx-groups/estilizar.ts catalog) ─────────────────────────

/** a fixed per-pixel random number in [0, 1) */
const prand = (a: number, b: number, s: number) => rnd(hash2(a, b), s);

Object.assign(IMPL_ESTILIZAR, {
  // Scatter: every pixel takes the one at a random offset within ±amount/2 (horizontal, vertical or both); the
  // pattern is fixed unless Randomize Every Frame
  scatter: (cv, p, x) => {
    const W = cv.width, H = cv.height, amt = Math.max(0, num(p.amount)) * x.res;
    if (amt < 0.5) return cv;
    const s = data(cv).data, img = new ImageData(W, H), d = img.data, g = String(p.grain ?? 'both');
    const fr = num(p.randomize) ? Math.round(x.t * (x.fps || 30)) + 1 : 0;
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const dx = g === 'v' ? 0 : Math.round((prand(X, y, 11 + fr) - 0.5) * amt), dy = g === 'h' ? 0 : Math.round((prand(X, y, 23 + fr) - 0.5) * amt);
      const sx = Math.max(0, Math.min(W - 1, X + dx)), sy = Math.max(0, Math.min(H - 1, y + dy)), i = (y * W + X) * 4, j = (sy * W + sx) * 4;
      d[i] = s[j]; d[i + 1] = s[j + 1]; d[i + 2] = s[j + 2]; d[i + 3] = s[j + 3];
    }
    ctx2d(cv).putImageData(img, 0, 0);
    return cv;
  },
  // Strobe Light: during the first «duration» of every «period» (and on random frames with the probability) the layer
  // is combined with the strobe colour by the operator, or made transparent
  strobeLight: (cv, p, x) => {
    const per = Math.max(1e-3, num(p.period, 1)), t = x.t, k = Math.floor(t / per + 1e-9), fps = x.fps || 30;
    const on = t - k * per < num(p.duration, 0.5) || (num(p.probability) > 0 && rnd(hash2(Math.round(num(p.seed)), 9), Math.round(t * fps)) < num(p.probability) / 100);
    if (!on) return cv;
    const orig = clone(cv), img = data(cv), d = img.data, [cr, cg, cb] = rgb(p.color ?? '#ffffff'), op = String(p.operator ?? 'copy');
    if (p.strobe === 'transparent') { for (let i = 3; i < d.length; i += 4) d[i] = 0; }
    else {
      const f = (a: number, c: number): number => {
        switch (op) {
          case 'add': return a + c; case 'subtract': return a - c; case 'multiply': return (a * c) / 255; case 'difference': return Math.abs(a - c);
          case 'and': return a & c; case 'or': return a | c; case 'xor': return a ^ c;
          case 'lighter': case 'maximum': return Math.max(a, c); case 'darker': case 'minimum': return Math.min(a, c);
          case 'screen': return 255 - ((255 - a) * (255 - c)) / 255; default: return c;
        }
      };
      for (let i = 0; i < d.length; i += 4) { d[i] = clamp(f(d[i], cr)); d[i + 1] = clamp(f(d[i + 1], cg)); d[i + 2] = clamp(f(d[i + 2], cb)); }
    }
    ctx2d(cv).clearRect(0, 0, cv.width, cv.height); ctx2d(cv).putImageData(img, 0, 0);
    const b = num(p.blend) / 100;
    if (b <= 0) return cv;
    const out = mk(cv.width, cv.height), g = ctx2d(out);
    g.globalAlpha = 1 - b; g.drawImage(cv, 0, 0); g.globalAlpha = b; g.globalCompositeOperation = 'lighter'; g.drawImage(orig, 0, 0);
    return out;
  },
  // Brush Strokes: each pixel averages the image along a short stroke (Stroke Angle, Length), the strokes jittered per
  // brush-sized cell (Randomness); Density below 1 leaves gaps that show the Paint Surface
  brushStrokes: (cv, p, x) => {
    const W = cv.width, H = cv.height, orig = clone(cv), s = data(cv).data, img = new ImageData(W, H), d = img.data;
    const a = (num(p.angle, 135) * Math.PI) / 180, ux = Math.cos(a), uy = -Math.sin(a), L = Math.max(0, num(p.length, 5)) * x.res;
    const cell = Math.max(1, (num(p.brushSize, 2) + 1) * x.res), rnd0 = num(p.randomness, 1), dens = num(p.density, 1), surf = String(p.surface ?? 'original');
    const n = Math.max(1, Math.round(L));
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const cx = Math.floor(X / cell), cy = Math.floor(y / cell), i = (y * W + X) * 4;
      // each cell's stroke: a random shift along the stroke and across it, and whether it is painted at all
      const along = (prand(cx, cy, 1) - 0.5) * L * rnd0, across = (prand(cx, cy, 2) - 0.5) * cell * rnd0;
      if (prand(cx, cy, 3) > dens) {
        if (surf === 'original') { d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = s[i + 3]; }
        else if (surf !== 'transparent') { d[i] = d[i + 1] = d[i + 2] = surf === 'white' ? 255 : 0; d[i + 3] = 255; }
        continue;
      }
      let r = 0, g = 0, b = 0, al = 0;
      for (let k = 0; k < n; k++) {
        const t = n === 1 ? 0 : k / (n - 1) - 0.5, sx = Math.round(X + ux * (t * L + along) - uy * across), sy = Math.round(y + uy * (t * L + along) + ux * across);
        const j = (Math.max(0, Math.min(H - 1, sy)) * W + Math.max(0, Math.min(W - 1, sx))) * 4, w = s[j + 3];
        r += s[j] * w; g += s[j + 1] * w; b += s[j + 2] * w; al += w;
      }
      if (al > 0) { d[i] = r / al; d[i + 1] = g / al; d[i + 2] = b / al; }
      d[i + 3] = al / n;
    }
    ctx2d(cv).putImageData(img, 0, 0);
    return blendOrig(orig, cv, num(p.blend));
  },
  // Texturize: the texture layer's relief (its brightness seen with a light from Light Direction) shades the layer
  texturize: (cv, p, x) => {
    const T = p.texture && x.layer ? x.layer(String(p.texture)) : null;
    if (!T) return cv;
    const W = cv.width, H = cv.height, tex = mk(W, H), tg = ctx2d(tex), pl = String(p.placement ?? 'tile');
    if (pl === 'stretch') tg.drawImage(T.cv, 0, 0, W, H);
    else if (pl === 'center') tg.drawImage(T.cv, (W - T.cv.width) / 2, (H - T.cv.height) / 2);
    else { tg.fillStyle = tg.createPattern(T.cv, 'repeat')!; tg.fillRect(0, 0, W, H); }
    const t = data(tex).data, img = data(cv), d = img.data, a = (num(p.light, 135) * Math.PI) / 180, k = num(p.contrast, 1);
    const dx = Math.round(Math.cos(a)), dy = Math.round(-Math.sin(a));
    const lum = (X: number, y: number) => { const j = (Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, X))) * 4; return (0.299 * t[j] + 0.587 * t[j + 1] + 0.114 * t[j + 2]) * (t[j + 3] / 255); };
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const i = (y * W + X) * 4, sh = 1 + ((lum(X + dx, y + dy) - lum(X - dx, y - dy)) / 255) * k * 1.5;
      d[i] = clamp(d[i] * sh); d[i + 1] = clamp(d[i + 1] * sh); d[i + 2] = clamp(d[i + 2] * sh);
    }
    ctx2d(cv).putImageData(img, 0, 0);
    return cv;
  },
  // Roughen Edges: the alpha edge eaten by fractal noise within «border» of it; the colour types tint the eaten band,
  // spiky / rusty / photocopy change the noise and the cut
  roughenEdges: (cv, p, x) => {
    const W = cv.width, H = cv.height, r = x.res, bd = Math.max(0, num(p.border, 8)) * r, type = String(p.type ?? 'roughen');
    if (bd <= 0) return cv;
    const blurred = mk(W, H), bg = ctx2d(blurred);
    bg.filter = `blur(${bd / 2}px)`; bg.drawImage(cv, 0, 0);
    const A = data(blurred).data, img = data(cv), d = img.data, [er, eg, eb] = rgb(p.edgeColor ?? '#993300');
    const sc = Math.max(1, num(p.scale, 100)), st = num(p.stretch) / 100, sx = sc * (st > 0 ? 1 + st * 4 : 1), sy = sc * (st < 0 ? 1 - st * 4 : 1);
    const [ox, oy] = vec2(p.offset), oct = Math.max(1, Math.min(10, Math.round(num(p.complexity, 2)))), infl = num(p.influence, 1), sharp = Math.max(0.01, num(p.sharpness, 1));
    const revs = Math.max(1, Math.round(num(p.cycleRevs, 1))); let ev = num(p.evolution) / 360; if (num(p.cycle)) ev = ((ev % revs) + revs) % revs;
    const zs = num(p.seed) * 3.17, color = /Color$/.test(type);
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const i = (y * W + X) * 4, a0 = d[i + 3] / 255, ab = A[i + 3] / 255;
      if (a0 <= 0) continue;
      const lx = (X / r + x.ox - ox) / sx, ly = (y / r + x.oy - oy) / sy;
      let nz = 0, amp = 1, nrm = 0, f = 4;
      for (let o = 0; o < oct; o++) { nz += noise3(lx * f, ly * f, ev + zs + o * 17, 'soft') * amp; nrm += amp; amp *= 0.5; f *= 2; }
      nz /= nrm;
      if (type === 'spiky') nz = Math.sign(nz) * Math.pow(Math.abs(nz), 0.5);
      if (type.startsWith('rusty')) nz = nz * 1.4 + (prand(X, y, 5) - 0.5) * 0.25;
      let v = ab + nz * infl * 0.5;
      if (type.startsWith('photocopy')) v = Math.round(v * 3) / 3;
      const cut = type === 'cut' ? (v > 0.5 ? 1 : 0) : clamp((v - 0.5) * sharp * 6 + 0.5, 0, 1);
      if (color) { const e = clamp(1 - Math.abs(v - 0.62) * 8, 0, 1) * (ab < 0.999 ? 1 : 0); d[i] = d[i] + (er - d[i]) * e; d[i + 1] = d[i + 1] + (eg - d[i + 1]) * e; d[i + 2] = d[i + 2] + (eb - d[i + 2]) * e; }
      d[i + 3] = a0 * Math.min(1, cut) * 255;
    }
    ctx2d(cv).putImageData(img, 0, 0);
    return cv;
  },
  // CC Kaleida: the image around Center folded into mirrored wedges (or Unfold's mirror tiles); Size scales the source
  ccKaleida: (cv, p, x) => {
    const W = cv.width, H = cv.height, s = data(cv).data, img = new ImageData(W, H), d = img.data;
    const [cx, cy] = ptc(p.center, x), [sxc, syc] = num(p.floating) ? [W / 2, H / 2] : [cx, cy];
    const k = Math.max(0.01, num(p.size, 20) / 100), rot = (num(p.rotation) * Math.PI) / 180, m = String(p.mirroring ?? 'flower');
    const N: Record<string, number> = { unfold: 2, wheel: 8, fishHead: 3, canMeas: 4, flipFlop: 2, flower: 6, diaCross: 4, flipper: 2, starlish: 5 };
    const n = N[m] ?? 6, seg = (Math.PI * 2) / n, R = Math.hypot(W, H) * k;
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const dx = X + 0.5 - cx, dy = y + 0.5 - cy;
      let a = Math.atan2(dy, dx) - rot + (m === 'diaCross' ? Math.PI / 4 : 0), r = Math.hypot(dx, dy);
      a = ((a % seg) + seg) % seg; if (a > seg / 2 && m !== 'wheel') a = seg - a;
      if (m === 'unfold' || m === 'flipFlop' || m === 'flipper') { r = r % (R * 2); if (r > R) r = R * 2 - r; }
      if (m === 'fishHead' || m === 'starlish') r = r * (1 + 0.25 * Math.cos(a * n));
      const u = Math.round(sxc + Math.cos(a + rot) * r * k * 2), v = Math.round(syc + Math.sin(a + rot) * r * k * 2);
      const j = (Math.max(0, Math.min(H - 1, v)) * W + Math.max(0, Math.min(W - 1, u))) * 4, i = (y * W + X) * 4;
      d[i] = s[j]; d[i + 1] = s[j + 1]; d[i + 2] = s[j + 2]; d[i + 3] = s[j + 3];
    }
    ctx2d(cv).putImageData(img, 0, 0);
    return cv;
  },
  // CC HexTile: a hexagonal grid (Radius, Center, Rotate); Tile repeats the central hexagon, the Fold modes mirror it so
  // neighbours meet; Smearing mixes in the image's own position
  ccHexTile: (cv, p, x) => {
    const W = cv.width, H = cv.height, s = data(cv).data, img = new ImageData(W, H), d = img.data;
    const [cx, cy] = ptc(p.center, x), R = Math.max(1, num(p.radius, 50) * x.res), rot = (num(p.rotate) * Math.PI) / 180, sm = num(p.smearing) / 100, mode = String(p.render ?? 'tile');
    const c = Math.cos(rot), sn = Math.sin(rot);
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const px = (X + 0.5 - cx) * c + (y + 0.5 - cy) * sn, py = -(X + 0.5 - cx) * sn + (y + 0.5 - cy) * c;
      // axial coordinates of the hexagon (pointy-top), rounded in cube space
      const qf = ((Math.sqrt(3) / 3) * px - py / 3) / R, rf = ((2 / 3) * py) / R;
      let q = Math.round(qf), rr = Math.round(rf); const sf = -qf - rf, ss = Math.round(sf);
      const dq = Math.abs(q - qf), dr = Math.abs(rr - rf), ds = Math.abs(ss - sf);
      if (dq > dr && dq > ds) q = -rr - ss; else if (dr > ds) rr = -q - ss;
      const hx = R * Math.sqrt(3) * (q + rr / 2), hy = R * 1.5 * rr;
      let lx = px - hx, ly = py - hy;
      if (mode !== 'tile' && ((q + rr) & 1)) { lx = -lx; if (mode === 'foldSeamless') ly = -ly; }
      lx = lx + (px - lx) * sm; ly = ly + (py - ly) * sm;
      const u = Math.round(cx + lx * c - ly * sn), v = Math.round(cy + lx * sn + ly * c);
      const j = (Math.max(0, Math.min(H - 1, v)) * W + Math.max(0, Math.min(W - 1, u))) * 4, i = (y * W + X) * 4;
      d[i] = s[j]; d[i + 1] = s[j + 1]; d[i + 2] = s[j + 2]; d[i + 3] = s[j + 3];
    }
    ctx2d(cv).putImageData(img, 0, 0);
    return cv;
  },
  // Ellipse: an elliptical ring (Width × Height around Center, Thickness), Inside Colour in its core fading to Outside
  // Colour at its edges (Softness), on transparent or composited on the layer
  ellipse: (cv, p, x) => {
    const W = cv.width, H = cv.height, r = x.res, [cx, cy] = ptc(p.center, x), ew = Math.max(0.5, num(p.width, 50) * r / 2), eh = Math.max(0.5, num(p.height, 50) * r / 2);
    const th = Math.max(0.5, num(p.thickness, 8) * r) / 2, soft = clamp(num(p.softness, 50) / 100, 0, 1), [ir, ig, ib] = rgb(p.inside ?? '#ffbefa'), [or, og, ob] = rgb(p.outside ?? '#ff1919');
    const img = new ImageData(W, H), d = img.data, k = Math.min(ew, eh);
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const nx = (X + 0.5 - cx) / ew, ny = (y + 0.5 - cy) / eh, dist = Math.abs(Math.hypot(nx, ny) - 1) * k;
      if (dist > th + 1) continue;
      const t = clamp(dist / th, 0, 1), core = clamp(1 - t / Math.max(0.01, 1 - soft * 0.9), 0, 1), al = clamp(th + 0.5 - dist, 0, 1) * (soft > 0 ? clamp((1 - t) / Math.max(0.01, soft), 0, 1) : 1);
      const i = (y * W + X) * 4;
      d[i] = or + (ir - or) * core; d[i + 1] = og + (ig - og) * core; d[i + 2] = ob + (ib - ob) * core; d[i + 3] = al * 255;
    }
    const gen = mk(W, H); ctx2d(gen).putImageData(img, 0, 0);
    if (!num(p.composite)) return gen;
    const g = ctx2d(cv); g.drawImage(gen, 0, 0);
    return cv;
  },
  // Eyedropper Fill: the average colour within Sample Radius of Sample Point fills the layer
  eyedropperFill: (cv, p, x) => {
    const W = cv.width, H = cv.height, orig = clone(cv), s = data(cv).data, [px, py] = ptc(p.point, x), rad = Math.max(0.5, num(p.radius, 10) * x.res), mode = String(p.average ?? 'skipEmpty');
    let r = 0, g = 0, b = 0, a = 0, n = 0, wsum = 0;
    for (let y = Math.max(0, Math.floor(py - rad)); y <= Math.min(H - 1, Math.ceil(py + rad)); y++) for (let X = Math.max(0, Math.floor(px - rad)); X <= Math.min(W - 1, Math.ceil(px + rad)); X++) {
      if (Math.hypot(X + 0.5 - px, y + 0.5 - py) > rad) continue;
      const i = (y * W + X) * 4, al = s[i + 3] / 255;
      if (mode === 'skipEmpty' && al <= 0) continue;
      const w = mode === 'all' ? 1 : al;
      r += s[i] * w; g += s[i + 1] * w; b += s[i + 2] * w; a += al; n++; wsum += w;
    }
    const div = mode === 'all' ? Math.max(1, n) : Math.max(1e-6, wsum);
    const col = n ? [r / div, g / div, b / div] : [0, 0, 0], alpha = mode === 'alpha' ? (n ? a / n : 0) : 1;
    const out = mk(W, H), og = ctx2d(out);
    og.fillStyle = `rgba(${Math.round(col[0])},${Math.round(col[1])},${Math.round(col[2])},${alpha})`; og.fillRect(0, 0, W, H);
    if (num(p.keepAlpha)) { og.globalCompositeOperation = 'destination-in'; og.drawImage(orig, 0, 0); }
    return blendOrig(orig, out, num(p.blend));
  },
  // CC Light Burst 2.5: rays streaming out of the bright parts of the layer away from Center (Ray Length; negative
  // pulls them in), Straight / Fade / Center weighting; Set Color tints them; Halo Alpha keeps the halo outside the layer
  ccLightBurst: (cv, p, x) => {
    const W = cv.width, H = cv.height, [cx, cy] = ptc(p.center, x), len = num(p.rayLength, 50) / 100, I = Math.max(0, num(p.intensity, 100)) / 100, mode = String(p.burst ?? 'fade');
    const tint = (c0: HTMLCanvasElement) => { const c = clone(c0), g = ctx2d(c); g.globalCompositeOperation = 'multiply'; g.fillStyle = css(p.color ?? '#ffe640'); g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'destination-in'; g.drawImage(c0, 0, 0); return c; };
    const src = num(p.setColor) ? tint(cv) : cv;
    const n = 32, rays = mk(W, H), g = ctx2d(rays);
    g.globalCompositeOperation = 'lighter';
    for (let k = 1; k <= n; k++) {
      const f = k / n, s = 1 + f * len, w = mode === 'straight' ? 1 : mode === 'center' ? f : 1 - f;
      g.globalAlpha = Math.min(1, (w * I * 2.2) / n);
      g.setTransform(s, 0, 0, s, cx - cx * s, cy - cy * s); g.drawImage(src, 0, 0);
    }
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
    const out = clone(cv), og = ctx2d(out);
    og.globalCompositeOperation = num(p.haloAlpha) ? 'source-atop' : 'lighter'; og.drawImage(rays, 0, 0);
    return out;
  },
  // CC Light Sweep: a band of light (Shape across Width) through Center at Direction, plus a highlight on the layer's
  // alpha edges inside the band; Add lights the layer, Composite puts the light over it, Cutout keeps only the light
  ccLightSweep: (cv, p, x) => {
    const W = cv.width, H = cv.height, r = x.res, [cx, cy] = ptc(p.center, x), a = (num(p.direction, -30) * Math.PI) / 180;
    const nx = Math.cos(a), ny = Math.sin(a), hw = Math.max(0.5, num(p.width, 50) * r / 2), shape = String(p.shape ?? 'sharp');
    const si = num(p.sweepIntensity, 25) / 100, ei = num(p.edgeIntensity, 50) / 100, et = Math.max(0, num(p.edgeThickness, 4)) * r, [lr, lg, lb] = rgb(p.color ?? '#fffaf0'), rec = String(p.reception ?? 'add');
    const img = data(cv), d = img.data, src = d.slice();
    const al = (X: number, y: number) => src[((Math.max(0, Math.min(H - 1, y)) * W) + Math.max(0, Math.min(W - 1, X))) * 4 + 3] / 255;
    const e = Math.max(1, Math.round(et));
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const dist = Math.abs((X + 0.5 - cx) * nx + (y + 0.5 - cy) * ny), t = clamp(1 - dist / hw, 0, 1);
      const prof = shape === 'linear' ? t : shape === 'smooth' ? t * t * (3 - 2 * t) : Math.pow(t, 3);
      const i = (y * W + X) * 4, a0 = src[i + 3] / 255;
      // edge: how much alpha changes within the edge thickness
      const edge = et > 0 && a0 > 0 ? clamp(Math.max(a0 - al(X - e, y), a0 - al(X + e, y), a0 - al(X, y - e), a0 - al(X, y + e)), 0, 1) : 0;
      const L = prof * (si + edge * ei * 2);
      if (rec === 'cutout') { d[i] = lr; d[i + 1] = lg; d[i + 2] = lb; d[i + 3] = clamp(L * 255) * a0; continue; }
      if (rec === 'composite') { const la = clamp(L); d[i] = d[i] * (1 - la) + lr * la; d[i + 1] = d[i + 1] * (1 - la) + lg * la; d[i + 2] = d[i + 2] * (1 - la) + lb * la; d[i + 3] = 255 * (a0 + (1 - a0) * la); continue; }
      if (a0 <= 0) continue;
      d[i] = clamp(d[i] + lr * L); d[i + 1] = clamp(d[i + 1] + lg * L); d[i + 2] = clamp(d[i + 2] + lb * L);
    }
    ctx2d(cv).clearRect(0, 0, W, H); ctx2d(cv).putImageData(img, 0, 0);
    return cv;
  },
  // CC Star Burst: the layer broken into dots on a grid (Grid Spacing) flying towards the viewer from the centre —
  // each dot keeps its colour, travels at Speed (Phase offsets the flight), spreads by Scatter, grows with Size
  ccStarBurst: (cv, p, x) => {
    const W = cv.width, H = cv.height, s = data(cv).data, orig = clone(cv), out = mk(W, H), g = ctx2d(out);
    const sp = Math.max(1, num(p.spacing, 4)) * x.res, sc = num(p.scatter, 100) / 100, speed = num(p.speed, 1), ph = num(p.phase) / 360, size = num(p.size, 100) / 100;
    const cx = W / 2, cy = H / 2;
    const dots: [number, number, number, string][] = [];
    for (let gy = sp / 2; gy < H; gy += sp) for (let gx = sp / 2; gx < W; gx += sp) {
      const i = (Math.floor(gy) * W + Math.floor(gx)) * 4;
      if (s[i + 3] <= 0) continue;
      const kx = Math.round(gx / sp), ky = Math.round(gy / sp);
      // depth cycles 0→1 (far → near) with time; each dot starts at its own depth
      const z = (((prand(kx, ky, 31) + x.t * speed * 0.25 + ph) % 1) + 1) % 1, persp = 1 / (1.05 - z * 0.95);
      const jx = (prand(kx, ky, 32) - 0.5) * sp * sc * 4, jy = (prand(kx, ky, 33) - 0.5) * sp * sc * 4;
      const X = cx + (gx - cx + jx) * persp * 0.35, Y = cy + (gy - cy + jy) * persp * 0.35;
      if (X < -10 || Y < -10 || X > W + 10 || Y > H + 10) continue;
      dots.push([z, X, Y, `rgba(${s[i]},${s[i + 1]},${s[i + 2]},${(s[i + 3] / 255) * Math.min(1, z * 3)})`]);
    }
    dots.sort((a, b) => a[0] - b[0]);
    for (const [z, X, Y, c] of dots) { const r = Math.max(0.3, sp * 0.18 * size * (0.3 + z * 2.2)); g.fillStyle = c; g.beginPath(); g.arc(X, Y, r, 0, Math.PI * 2); g.fill(); }
    return blendOrig(orig, out, num(p.blend));
  },
} as Record<string, FxFn>);

// ───────────── round 2: effects added (see the catalogue for their values) ─────────────

/** the layer's pixel (0–255 RGBA) at canvas coordinates, clamped to the edges */
const pix = (s: Uint8ClampedArray, W: number, H: number, x: number, y: number) => { const i = ((Math.max(0, Math.min(H - 1, Math.round(y))) * W) + Math.max(0, Math.min(W - 1, Math.round(x)))) * 4; return [s[i], s[i + 1], s[i + 2], s[i + 3]]; };
/** a smooth random value in −1…1 that changes continuously with `t` (value noise between integer steps) */
const smoothRand = (id: number, t: number, s: number) => { const k = Math.floor(t), f = t - k, u = f * f * (3 - 2 * f); return (prand(id, k, s) * (1 - u) + prand(id, k + 1, s) * u) * 2 - 1; };

/** CC Rainfall and CC Snowfall: drops / flakes spread through the scene depth (nearer = bigger, faster), falling at
 * Speed with Wind, wrapped round the layer so any frame stands on its own; their colour borrows from the background */
function precipitation(cv: HTMLCanvasElement, p: Params, x: FxCtx, snow: boolean): HTMLCanvasElement {
  const W = cv.width, H = cv.height, res = x.res, t = x.t, fps = x.fps || 30;
  const src = data(cv).data, out = num(p.composite, 1) ? clone(cv) : mk(W, H), g = ctx2d(out);
  // the count is for a 1920 × 1080 frame: a smaller layer gets proportionally fewer
  const total = num(snow ? p.flakes : p.drops, snow ? 10000 : 5000), n = Math.min(40000, Math.round(total * ((W / res) * (H / res)) / (1920 * 1080)));
  const depth = Math.max(100, num(p.sceneDepth, 5000)), near = 100, seed = Math.round(num(p.seed)) * 7 + (snow ? 3 : 1);
  const [cr, cg, cb] = rgb(p.color ?? '#ffffff'), op = num(p.opacity, snow ? 50 : 25) / 100, infl = num(p.influence, 80) / 100;
  const sw = num(p.spreadWidth, 150) * res, sh = num(p.spreadHeight, snow ? 50 : 15) * res;
  const [ofx, ofy] = ptc(p.offset, x), offx = ofx - W / 2, offy = ofy - H / 2;
  const spread = num(p.spread, snow ? 15 : 6), ground = num(p.ground, 100) / 100, embed = num(p.embed, 100) / 100;
  g.globalCompositeOperation = String(p.transfer ?? 'lighten') === 'lighten' ? 'lighten' : 'source-over';
  g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const r = (k: number) => prand(i, k, seed);
    const z = near + r(1) * (depth - near), k = 1000 / z, kn = (depth - z) / (depth - near);
    const sv = snow ? 1 + (num(p.speedVariation, 50) / 100) * (r(2) * 2 - 1) : 1;
    const v = num(p.speed, snow ? 250 : 4000) * sv * k * res * 0.25;
    const ang = ((r(3) * 2 - 1) * spread * Math.PI) / 180;
    const wind = num(p.wind) * (1 + (num(p.windVariation) / 100) * (r(4) * 2 - 1)) * k * res * 0.25;
    const vx = Math.sin(ang) * v + wind, vy = Math.cos(ang) * v;
    const sz = Math.max(0.3, num(p.size, 3) * (snow ? 1 + (num(p.sizeVariation, 25) / 100) * (r(5) * 2 - 1) : 1) * k * res * 0.5);
    const m = sz * 4 + Math.abs(vx) / fps + 20, spanX = W + 2 * m, spanY = H + 2 * m;
    let px = ((((r(6) * spanX + vx * t) % spanX) + spanX) % spanX) - m + offx, py = ((((r(7) * spanY + vy * t) % spanY) + spanY) % spanY) - m + offy;
    if (snow) {
      // wiggle: a sideways sway (two waves when stochastic), its amount and frequency varied per flake
      const amt = num(p.wiggle, 20) * (1 + (num(p.wiggleVariation) / 100) * (r(8) * 2 - 1)) * k * res * 0.25;
      const fq = num(p.frequency, 1) * (1 + (num(p.frequencyVariation, 75) / 100) * (r(9) * 2 - 1)), ph = r(10) * 6.283;
      px += amt * (Math.sin(t * fq * 6.283 + ph) + (num(p.stochastic, 1) ? 0.5 * Math.sin(t * fq * 2.7 * 6.283 + ph * 3) : 0));
    }
    // the ground: nearer drops reach lower (Embed Depth spreads the far ones up towards the horizon)
    if (py > H * ground * (1 - embed * (1 - kn) * 0.5)) continue;
    // background: the layer under a random point of the spread area
    const bg = pix(src, W, H, px + (r(11) - 0.5) * sw, py - r(12) * sh), a = op * (0.35 + 0.65 * kn) * (bg[3] / 255 * infl + (1 - infl));
    const col = [0, 1, 2].map((c) => [cr, cg, cb][c] * (1 - infl) + bg[c] * infl * (snow ? 1.4 : p.appearance === 'refracting' ? 1.3 : 1.1) + (snow ? 40 : 0) * infl);
    const cs = `rgba(${Math.round(clamp(col[0]))},${Math.round(clamp(col[1]))},${Math.round(clamp(col[2]))},${Math.min(1, a)})`;
    if (snow) {
      const fl = 1 - (num(p.flatness, 50) / 100) * 0.6 * Math.abs(Math.sin(t * 2 + r(13) * 6.283));
      g.fillStyle = cs; g.beginPath(); g.ellipse(px, py, sz, sz * fl, r(14) * 3.14, 0, Math.PI * 2); g.fill();
    } else {
      // motion blur: the streak a drop travels in half a frame
      const len = Math.max(sz * 2, v / fps * 0.5), dl = Math.hypot(vx, vy) || 1;
      g.strokeStyle = cs; g.lineWidth = Math.max(0.5, sz * 0.5); g.beginPath(); g.moveTo(px - (vx / dl) * len, py - (vy / dl) * len); g.lineTo(px, py); g.stroke();
    }
  }
  return out;
}

/** CycoreFX lighting (CC Glass, CC Plastic, CC Drizzle): the light direction at a pixel */
function cyLightDir(p: Params, x: FxCtx, W: number, X: number, Y: number): [number, number, number] {
  const el = (Math.max(-100, Math.min(100, num(p.lightHeight, 65))) / 100) * (Math.PI / 2);
  if (String(p.lightType ?? 'distant') === 'point') {
    const [lx, ly] = ptc(p.lightPosition, x), lz = Math.tan(Math.min(1.5, Math.abs(el))) * W * 0.5 * Math.sign(el || 1);
    const dx = lx - X, dy = ly - Y, l = Math.hypot(dx, dy, lz) || 1;
    return [dx / l, dy / l, lz / l];
  }
  const a = (num(p.lightDirection, -45) * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(a), -Math.cos(el) * Math.cos(a), Math.sin(el)];
}
/** a bump height map (0…1) from a layer's property, softened by Softness */
function bumpMap(cv: HTMLCanvasElement, p: Params, x: FxCtx): Float32Array {
  const W = cv.width, H = cv.height, L = p.bump && x.layer ? x.layer(String(p.bump)) : null;
  const c = mk(W, H), cg = ctx2d(c);
  if (L) cg.drawImage(L.cv, (L.ox - x.ox) * x.res, (L.oy - x.oy) * x.res, (L.cv.width / L.res) * x.res, (L.cv.height / L.res) * x.res); else cg.drawImage(cv, 0, 0);
  const soft = num(p.softness, 20) * x.res * 0.5, b = soft > 0.3 ? blurCanvas(c, soft) : c;
  const d = data(b).data, h = new Float32Array(W * H), pr = String(p.property ?? 'lightness');
  for (let i = 0; i < W * H; i++) {
    const r = d[i * 4], gg = d[i * 4 + 1], bb = d[i * 4 + 2], a = d[i * 4 + 3];
    h[i] = (pr === 'red' ? r : pr === 'green' ? gg : pr === 'blue' ? bb : pr === 'alpha' ? a : pr === 'luminance' ? r * 0.299 + gg * 0.587 + bb * 0.114 : (Math.max(r, gg, bb) + Math.min(r, gg, bb)) / 2) / 255;
  }
  return h;
}
/** Phong shading of a colour (0–255) with normal n: ambient + diffuse, plus a specular highlight that Metal tints with
 * the surface colour */
function cyShade(col: number[], nx: number, ny: number, nz: number, L: [number, number, number], p: Params, lc: number[], amb = num(p.ambient, 50)): number[] {
  const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  const li = num(p.lightIntensity, 100) / 100, ndl = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
  const hx = L[0], hy = L[1], hz = L[2] + 1, hl = Math.hypot(hx, hy, hz) || 1, ndh = Math.max(0, (nx * hx + ny * hy + nz * hz) / hl);
  const spec = (num(p.specular, 50) / 100) * Math.pow(ndh, 0.5 / Math.max(1e-6, num(p.roughness, 0.025) ** 2)) * li, metal = num(p.metal, 100) / 100;
  return [0, 1, 2].map((c) => col[c] * (amb / 100 + (num(p.diffuse, 50) / 100) * ndl * li) * (lc[c] / 255) + spec * 255 * (metal * (col[c] / 255) + (1 - metal)) * (lc[c] / 255));
}

/** the shared midpoint-displacement bolt of Advanced Lightning: a polyline from a to b */
function boltPath(ax: number, ay: number, bx: number, by: number, levels: number, turb: number, cond: number, id: number, fractal: string): number[] {
  let pts = [ax, ay, bx, by];
  for (let lv = 0; lv < levels; lv++) {
    const next: number[] = [];
    for (let i = 0; i < pts.length - 2; i += 2) {
      const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3], len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const off = smoothRand(id * 131 + lv * 17 + i, cond, 3) * len * 0.3 * turb * (fractal === 'linear' ? 1 : 0.7);
      next.push(x0, y0, (x0 + x1) / 2 - ((y1 - y0) / len) * off, (y0 + y1) / 2 + ((x1 - x0) / len) * off);
    }
    next.push(pts[pts.length - 2], pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

Object.assign(IMPL_ESTILIZAR, {
  ccRainfall: (cv, p, x) => precipitation(cv, p, x, false),
  ccSnowfall: (cv, p, x) => precipitation(cv, p, x, true),

  // Advanced Lightning: a fractal bolt (midpoint displacement, Complexity levels, Turbulence) from the origin towards the
  // direction point, forking with Forking / Fork Strength and fading with Decay; Conductivity State changes its path
  // smoothly. The glow is the bolt blurred by Glow Radius in the glow colour, the core drawn on top
  advancedLightning: (cv, p, x) => {
    const W = cv.width, H = cv.height, res = x.res;
    const [ax, ay] = ptc(p.origin, x); let [bx, by] = ptc(p.direction, x);
    const type = String(p.type ?? 'direction'), cond = num(p.conductivity), turb = num(p.turbulence, 1), lv = Math.max(1, Math.min(10, Math.round(num(p.complexity, 6))));
    const reach = Math.hypot(bx - ax, by - ay) || W * 0.5, fractal = String(p.fractalType ?? 'linear');
    if (type === 'vertical') { bx = ax; by = H; }
    if (type === 'anywhere') { bx = (smoothRand(7, cond * 0.25, 9) * 0.5 + 0.5) * W; by = (smoothRand(8, cond * 0.25, 9) * 0.5 + 0.5) * H; }
    const starts: [number, number, number, number][] = [];
    if (type === 'omni') for (let k = 0; k < 4; k++) { const a = k * 1.571 + smoothRand(k, cond * 0.2, 5); starts.push([ax, ay, ax + Math.cos(a) * reach, ay + Math.sin(a) * reach]); }
    else starts.push([ax, ay, bx, by]);
    const tb = turb * (type === 'breaking' ? 1.6 : type === 'bouncey' ? 1.3 : 1);
    type Seg = { pts: number[]; w: number; a: number; decay: boolean };
    const segs: Seg[] = [];
    const fork = num(p.forking, 25) / 100, fs = num(p.forkStrength, 70) / 100, fv = num(p.forkVariation, 20) / 100, minFork = num(p.minForkDistance, 64) * res * 0.25;
    const grow = (x0: number, y0: number, x1: number, y1: number, depth: number, w: number, a: number, id: number) => {
      const pts = boltPath(x0, y0, x1, y1, Math.max(1, lv - depth), tb, cond, id, fractal);
      segs.push({ pts, w, a, decay: depth > 0 || !!num(p.decayMainCore) });
      if (depth >= 3) return;
      // forks leave from points along the path, at an angle, shorter and weaker
      const nPts = pts.length / 2;
      for (let i = 2; i < nPts - 2; i += 2) {
        if (prand(id, i, 41) >= fork * 0.35) continue;
        const px0 = pts[i * 2], py0 = pts[i * 2 + 1], rest = Math.hypot(x1 - px0, y1 - py0);
        if (rest < minFork) continue;
        const dir = Math.atan2(y1 - y0, x1 - x0) + (prand(id, i, 43) * 2 - 1) * 0.9, L = rest * (0.35 + 0.3 * prand(id, i, 47)) * (1 + fv * (prand(id, i, 53) * 2 - 1));
        grow(px0, py0, px0 + Math.cos(dir) * L, py0 + Math.sin(dir) * L, depth + 1, w * 0.6, a * fs, id * 7 + i + 1);
      }
    };
    starts.forEach((s, k) => grow(s[0], s[1], s[2], s[3], 0, 1, 1, k + 1));
    const decay = num(p.decay, 0.3), drain = num(p.coreDrain) / 100;
    const draw = (g: CanvasRenderingContext2D, width: number, color: string, alpha: number) => {
      g.strokeStyle = color; g.lineCap = 'round'; g.lineJoin = 'round';
      for (const s of segs) {
        const n = s.pts.length / 2;
        for (let i = 0; i < n - 1; i++) {
          const u = i / Math.max(1, n - 1), fade = s.decay ? Math.exp(-decay * 3 * u) : 1;
          g.globalAlpha = Math.max(0, Math.min(1, alpha * s.a * fade));
          g.lineWidth = Math.max(0.5, width * s.w * (1 - drain * u));
          g.beginPath(); g.moveTo(s.pts[i * 2], s.pts[i * 2 + 1]); g.lineTo(s.pts[i * 2 + 2], s.pts[i * 2 + 3]); g.stroke();
        }
      }
      g.globalAlpha = 1;
    };
    const core = num(p.coreRadius, 2) * res;
    const glow = mk(W, H); draw(ctx2d(glow), core * 2 + 2 * res, css(p.glowColor ?? '#3232ff'), 1);
    const gb = blurCanvas(glow, Math.max(0.5, num(p.glowRadius, 50) * res * 0.25));
    const out = num(p.composite) ? clone(cv) : mk(W, H), g = ctx2d(out);
    g.globalCompositeOperation = 'lighter'; g.globalAlpha = num(p.glowOpacity, 50) / 100 * 2; g.drawImage(gb, 0, 0); g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over'; draw(g, core * 2, css(p.coreColor ?? '#ffffff'), num(p.coreOpacity, 75) / 100);
    return out;
  },

  // Timecode: the layer's (or a custom) time as SMPTE, frames or feet + frames, in a box at the text position
  timecode: (cv, p, x) => {
    const custom = String(p.source ?? 'layer') === 'custom', fps = custom ? Math.max(1, num(p.units, 30)) : x.fps || 30;
    const fr = Math.floor(x.t * fps + 1e-6) + (custom ? Math.round(num(p.startFrame)) : 0), fmt = String(p.format ?? 'smpte');
    const z = (v: number, n = 2) => String(Math.abs(Math.trunc(v))).padStart(n, '0'), nf = Math.round(fps), sign = fr < 0 ? '-' : '';
    let txt: string;
    if (fmt === 'frames') txt = sign + z(fr, 5);
    else if (fmt === 'feet35' || fmt === 'feet16') { const per = fmt === 'feet35' ? 16 : 40; txt = `${sign}${z(Math.floor(Math.abs(fr) / per), 4)}+${z(Math.abs(fr) % per)}`; }
    else {
      let f = Math.abs(fr);
      // drop frame (29.97 / 59.94): two (four) frame numbers skipped each minute except every tenth
      const drop = !!num(p.dropFrame) && (nf === 30 || nf === 60), dn = nf === 60 ? 4 : 2;
      if (drop) { const d10 = Math.floor(f / (nf * 600 - dn * 9)), m = f % (nf * 600 - dn * 9); f += dn * 9 * d10 + (m > dn ? dn * Math.floor((m - dn) / (nf * 60 - dn)) : 0); }
      txt = `${sign}${z(f / (nf * 3600))}:${z((f / (nf * 60)) % 60)}:${z((f / nf) % 60)}${drop ? ';' : ':'}${z(f % nf)}`;
    }
    const out = num(p.composite, 1) ? clone(cv) : mk(cv.width, cv.height), g = ctx2d(out), size = num(p.size, 36) * x.res;
    g.font = `bold ${size}px Consolas, "Courier New", monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const [px, py] = ptc(p.position, x), w = g.measureText(txt).width, op = num(p.opacity, 100) / 100;
    g.globalAlpha = op;
    if (num(p.showBox, 1)) { g.fillStyle = css(p.boxColor ?? '#000000'); g.fillRect(px - w / 2 - size * 0.2, py - size * 0.6, w + size * 0.4, size * 1.2); }
    g.fillStyle = css(p.color ?? '#ffffff'); g.fillText(txt, px, py);
    g.globalAlpha = 1;
    return out;
  },

  // Numbers: a value (or a random one each frame) as a number, timecode, time, date or hexadecimal; Current Time adds the
  // layer time. Dates count days from 1 January 2000 (a fixed day, so preview and export match)
  numbers: (cv, p, x) => {
    const type = String(p.type ?? 'number'), dec = Math.max(0, Math.min(10, Math.round(num(p.decimals, 2))));
    let v = num(p.value);
    if (num(p.random)) v = v * prand(Math.round(x.t * (x.fps || 30)), 5, 77);
    if (num(p.currentTime)) v += type === 'number' || type === 'leadingZeros' || type === 'hex' ? 0 : x.t;
    const z = (a: number, n = 2) => String(Math.abs(Math.trunc(a))).padStart(n, '0');
    const tc = (sec: number, f: number) => { const fr = Math.floor(Math.abs(sec) * f + 1e-6); return `${sec < 0 ? '-' : ''}${z(fr / (f * 3600))}:${z((fr / (f * 60)) % 60)}:${z((fr / f) % 60)}:${z(fr % f)}`; };
    const day = new Date(Date.UTC(2000, 0, 1) + Math.floor(v) * 86400000);
    const M = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const txt = type === 'leadingZeros' ? (v < 0 ? '-' : '') + Math.abs(v).toFixed(dec).padStart(dec ? 6 + dec : 5, '0')
      : type === 'tc30' ? tc(v, 30) : type === 'tc25' ? tc(v, 25) : type === 'tc24' ? tc(v, 24)
      : type === 'time' ? `${z(Math.abs(v) / 3600)}:${z((Math.abs(v) / 60) % 60)}:${z(Math.abs(v) % 60)}`
      : type === 'numDate' ? `${z(day.getUTCDate())}/${z(day.getUTCMonth() + 1)}/${day.getUTCFullYear()}`
      : type === 'shortDate' ? `${day.getUTCDate()} ${M[day.getUTCMonth()].slice(0, 3)} ${day.getUTCFullYear()}`
      : type === 'longDate' ? `${day.getUTCDate()} de ${M[day.getUTCMonth()]} de ${day.getUTCFullYear()}`
      : type === 'hex' ? (v < 0 ? '-' : '') + Math.trunc(Math.abs(v)).toString(16).toUpperCase() : v.toFixed(dec);
    const out = num(p.composite) ? clone(cv) : mk(cv.width, cv.height), g = ctx2d(out), size = num(p.size, 36) * x.res;
    g.font = `${size}px ${num(p.proportional, 1) ? 'Arial, sans-serif' : 'Consolas, monospace'}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    try { (g as unknown as { letterSpacing: string }).letterSpacing = `${num(p.tracking) * size * 0.01}px`; } catch { /* older canvases */ }
    const [px, py] = ptc(p.position, x), disp = String(p.display ?? 'fill');
    g.lineWidth = num(p.strokeWidth, 2) * x.res; g.lineJoin = 'round'; g.strokeStyle = css(p.strokeColor ?? '#ffffff'); g.fillStyle = css(p.fillColor ?? '#ff0000');
    const fill = () => g.fillText(txt, px, py), stroke = () => { if (g.lineWidth > 0) g.strokeText(txt, px, py); };
    if (disp === 'fill') fill(); else if (disp === 'stroke') stroke(); else if (disp === 'fillOverStroke') { stroke(); fill(); } else { fill(); stroke(); }
    return out;
  },

  // Paint Bucket: a flood fill from the fill point of the pixels within Tolerance of it (by colour, alpha…), its edge
  // antialiased, feathered, spread, choked or turned into a stroke, filled with the colour and blended with the layer
  paintBucket: (cv, p, x) => {
    const W = cv.width, H = cv.height, s = data(cv).data, [fx, fy] = ptc(p.point, x).map(Math.round), sel = String(p.selector ?? 'colorAlpha'), tol = num(p.tolerance, 50);
    const mask = new Uint8Array(W * H);
    if (fx >= 0 && fy >= 0 && fx < W && fy < H) {
      const i0 = (fy * W + fx) * 4, ref = [s[i0], s[i0 + 1], s[i0 + 2], s[i0 + 3]];
      const like = (i: number) => {
        const j = i * 4;
        if (sel === 'color') return Math.max(Math.abs(s[j] - ref[0]), Math.abs(s[j + 1] - ref[1]), Math.abs(s[j + 2] - ref[2])) <= tol;
        if (sel === 'colorAlpha') return Math.max(Math.abs(s[j] - ref[0]), Math.abs(s[j + 1] - ref[1]), Math.abs(s[j + 2] - ref[2]), Math.abs(s[j + 3] - ref[3])) <= tol;
        if (sel === 'transparency') return s[j + 3] <= tol;
        return Math.abs(s[j + 3] - ref[3]) <= tol;
      };
      // Alpha Channel fills every pixel like the point, connected or not; the others flood from it
      if (sel === 'alpha') { for (let i = 0; i < W * H; i++) if (like(i)) mask[i] = 1; }
      else {
        const st = [fy * W + fx]; mask[st[0]] = 1;
        while (st.length) {
          const i = st.pop()!, X = i % W, Y = (i - X) / W;
          for (const j of [X > 0 ? i - 1 : -1, X < W - 1 ? i + 1 : -1, Y > 0 ? i - W : -1, Y < H - 1 ? i + W : -1]) if (j >= 0 && !mask[j] && like(j)) { mask[j] = 1; st.push(j); }
        }
      }
    }
    if (num(p.invert)) for (let i = 0; i < W * H; i++) mask[i] ^= 1;
    const mc = mk(W, H), mi = new ImageData(W, H);
    for (let i = 0; i < W * H; i++) { mi.data[i * 4] = mi.data[i * 4 + 1] = mi.data[i * 4 + 2] = 255; mi.data[i * 4 + 3] = mask[i] * 255; }
    ctx2d(mc).putImageData(mi, 0, 0);
    // the edge: blurred and re-thresholded to grow or shrink it, or the outline alone for Stroke
    const st = String(p.stroke ?? 'antialias'), amt = num(p.amount, 3) * x.res;
    const alphaMap = (c: HTMLCanvasElement, f: (a: number) => number) => { const im = data(c); for (let i = 3; i < im.data.length; i += 4) im.data[i] = f(im.data[i]); ctx2d(c).putImageData(im, 0, 0); return c; };
    let m: HTMLCanvasElement = mc;
    if (st === 'antialias') m = blurCanvas(mc, 0.6 * x.res);
    else if (st === 'feather') m = amt > 0 ? blurCanvas(mc, amt / 2) : mc;
    else if (st === 'spread' && amt > 0) m = alphaMap(blurCanvas(mc, amt / 2), (a) => clamp(a * 4));
    else if (st === 'choke' && amt > 0) m = alphaMap(blurCanvas(mc, amt / 2), (a) => clamp((a - 191) * 4));
    else if (st === 'stroke' && amt > 0) m = alphaMap(blurCanvas(mc, amt / 2), (a) => clamp(255 - Math.abs(a - 128) * 4));
    if (num(p.viewThreshold)) { const o = mk(W, H), og = ctx2d(o); og.fillStyle = '#000'; og.fillRect(0, 0, W, H); og.drawImage(m, 0, 0); return o; }
    const fill = mk(W, H), fg = ctx2d(fill);
    fg.fillStyle = css(p.color ?? '#ff0000'); fg.fillRect(0, 0, W, H); fg.globalCompositeOperation = 'destination-in'; fg.drawImage(m, 0, 0);
    const mode = String(p.blendMode ?? 'normal');
    return genBlend(cv, fill, mode === 'fillOnly' ? 'none' : mode, num(p.opacity, 100) / 100);
  },

  // Cartoon: the image smoothed inside its regions (Detail Radius / Threshold), its luminance quantised in Shading Steps
  // with soft transitions (Smoothness), and dark edges where a difference of Gaussians crosses the edge threshold
  cartoon: (cv, p, x) => {
    const W = cv.width, H = cv.height, s = data(cv).data, mode = String(p.render ?? 'fillEdges');
    const rad = Math.max(0.5, num(p.detailRadius, 8) * x.res * 0.5), thr = num(p.detailThreshold, 10) * 2.55;
    const bl = data(blurCanvas(cv, rad)).data, img = new ImageData(W, H), d = img.data;
    const steps = Math.max(2, num(p.steps, 8)), sm = Math.max(0.001, num(p.smoothness, 70)) / 100;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4, L0 = s[j] * 0.299 + s[j + 1] * 0.587 + s[j + 2] * 0.114, Lb = bl[j] * 0.299 + bl[j + 1] * 0.587 + bl[j + 2] * 0.114;
      // keep detail where the pixel differs from its neighbourhood by more than the threshold
      const k = Math.abs(L0 - Lb) > thr ? 0.3 : 1, c = [0, 1, 2].map((q) => s[j + q] * (1 - k) + bl[j + q] * k);
      const L = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114, f = (L / 255) * (steps - 1), fl = Math.floor(f), fr = f - fl;
      const e = Math.min(1, Math.max(0, (fr - 0.5) / (sm * 0.5) + 0.5)), q = ((fl + (sm > 0 ? e : fr >= 0.5 ? 1 : 0)) / (steps - 1)) * 255, r = L > 0.5 ? q / L : 0;
      for (let ch = 0; ch < 3; ch++) d[j + ch] = mode === 'edges' ? 255 : clamp(c[ch] * r);
      d[j + 3] = s[j + 3];
    }
    if (mode !== 'fill') {
      // edges: difference of two Gaussians of the luminance, past the threshold, widened by Width, softened by Softness
      const w = Math.max(0.3, num(p.edgeWidth, 1.5) * x.res), a1 = data(blurCanvas(cv, w)).data, a2 = data(blurCanvas(cv, w * num(p.edgeThreshold, 1.6))).data;
      const soft = num(p.edgeSoftness, 60) / 100, op = num(p.edgeOpacity, 100) / 100, en = num(p.enhancement, 1), con = num(p.edgeContrast, 0.5), blk = num(p.blackLevel);
      for (let i = 0; i < W * H; i++) {
        const j = i * 4, l1 = a1[j] * 0.299 + a1[j + 1] * 0.587 + a1[j + 2] * 0.114, l2 = a2[j] * 0.299 + a2[j + 1] * 0.587 + a2[j + 2] * 0.114;
        const dog = ((l2 - l1) / 255) * en * 20 * (1 + con), ink = Math.max(0, Math.min(1, soft > 0 ? (dog - 0.1) / (soft * 0.6 + 0.05) : dog > 0.1 ? 1 : 0)) * op;
        const black = clamp(blk * 25.5);
        for (let ch = 0; ch < 3; ch++) d[j + ch] = d[j + ch] * (1 - ink) + black * ink;
      }
    }
    const out = mk(W, H); ctx2d(out).putImageData(img, 0, 0); return out;
  },

  // CC Spotlight: a cone of light from «From» (at Height above the layer) towards «To»; Light Shadow darkens the rest,
  // Light Add adds the light, Light Only shows only the light; the Gel versions colour it with the gel layer
  ccSpotlight: (cv, p, x) => {
    const W = cv.width, H = cv.height, s = data(cv).data, img = new ImageData(W, H), d = img.data;
    const [fx, fy] = ptc(p.from, x), [tx, ty] = ptc(p.to, x), hz = (num(p.height, 50) / 100) * Math.max(W, H);
    const ax = tx - fx, ay = ty - fy, az = -hz, al = Math.hypot(ax, ay, az) || 1, cone = (Math.max(0.1, num(p.cone, 10)) * Math.PI) / 180, soft = num(p.softness, 25) / 100;
    const [lr, lg, lb] = rgb(p.color ?? '#ffffff'), inten = num(p.intensity, 75) / 100, mode = String(p.render ?? 'lightShadow');
    const gelL = mode.startsWith('gel') && p.gel && x.layer ? x.layer(String(p.gel)) : null;
    let gel: Uint8ClampedArray | null = null;
    if (gelL) { const c = mk(W, H); ctx2d(c).drawImage(gelL.cv, (gelL.ox - x.ox) * x.res, (gelL.oy - x.oy) * x.res, (gelL.cv.width / gelL.res) * x.res, (gelL.cv.height / gelL.res) * x.res); gel = data(c).data; }
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const vx = X - fx, vy = y - fy, vz = -hz, vl = Math.hypot(vx, vy, vz) || 1, ang = Math.acos(Math.max(-1, Math.min(1, (vx * ax + vy * ay + vz * az) / (vl * al))));
      // full light inside the cone, fading over the soft edge
      const e = cone * (1 - soft * 0.9), k = ang <= e ? 1 : ang >= cone * (1 + soft) ? 0 : 1 - (ang - e) / (cone * (1 + soft) - e);
      const i = (y * W + X) * 4, light = [lr, lg, lb].map((c, q) => c * (gel ? gel[i + q] / 255 : 1) * k * inten);
      for (let q = 0; q < 3; q++) {
        const v = s[i + q];
        d[i + q] = clamp(mode.endsWith('Only') ? light[q] : mode.endsWith('AddPlus') ? v + light[q] : mode.endsWith('Add') ? v + light[q] * (v / 255) : v * (light[q] / 255) * 1.3);
      }
      d[i + 3] = mode.endsWith('Only') ? clamp(k * 255 * inten) : s[i + 3];
    }
    const out = mk(W, H); ctx2d(out).putImageData(img, 0, 0); return out;
  },

  // CC Glass: the bump map's property as a surface, its slope displacing the image (Displacement) and shading it
  ccGlass: (cv, p, x) => {
    const W = cv.width, H = cv.height, s = data(cv).data, h = bumpMap(cv, p, x), img = new ImageData(W, H), d = img.data;
    const hk = num(p.height, 25) * x.res * 0.1, disp = num(p.displacement, 100) / 100, lc = rgb(p.lightColor ?? '#ffffff');
    const at = (X: number, Y: number) => h[Math.max(0, Math.min(H - 1, Y)) * W + Math.max(0, Math.min(W - 1, X))];
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const gx = (at(X + 1, y) - at(X - 1, y)) * hk * 10, gy = (at(X, y + 1) - at(X, y - 1)) * hk * 10;
      const c = pix(s, W, H, X + gx * disp * 2, y + gy * disp * 2), o = cyShade(c, -gx, -gy, 1, cyLightDir(p, x, W, X, y), p, lc), i = (y * W + X) * 4;
      d[i] = clamp(o[0]); d[i + 1] = clamp(o[1]); d[i + 2] = clamp(o[2]); d[i + 3] = s[i + 3];
    }
    const out = mk(W, H); ctx2d(out).putImageData(img, 0, 0); return out;
  },

  // CC Plastic: the layer lit as a plastic surface embossed by the bump layer (heights cut to Cut Min…Max), Dust dulling
  // the highlights
  ccPlastic: (cv, p, x) => {
    const W = cv.width, H = cv.height, s = data(cv).data, h = bumpMap(cv, p, x), img = new ImageData(W, H), d = img.data;
    const lo = num(p.cutMin) / 100, hi = Math.max(lo + 1e-3, num(p.cutMax, 100) / 100), hk = num(p.height, 25) * x.res;
    const lc = rgb(p.lightColor ?? '#ffffff'), ac = rgb(p.ambientColor ?? '#ffffff'), dust = num(p.dust, 25) / 100;
    const at = (X: number, Y: number) => Math.max(0, Math.min(1, (h[Math.max(0, Math.min(H - 1, Y)) * W + Math.max(0, Math.min(W - 1, X))] - lo) / (hi - lo)));
    const q: Params = { ...p, specular: num(p.specular, 100) * (1 - dust * 0.7) };
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const gx = (at(X + 1, y) - at(X - 1, y)) * hk, gy = (at(X, y + 1) - at(X, y - 1)) * hk, i = (y * W + X) * 4;
      const c = [s[i] * ac[0] / 255, s[i + 1] * ac[1] / 255, s[i + 2] * ac[2] / 255], o = cyShade(c, -gx, -gy, 1, cyLightDir(p, x, W, X, y), q, lc, num(p.ambient, 75));
      d[i] = clamp(o[0]); d[i + 1] = clamp(o[1]); d[i + 2] = clamp(o[2]); d[i + 3] = s[i + 3];
    }
    const out = mk(W, H); ctx2d(out).putImageData(img, 0, 0); return out;
  },

  // CC Threads: the layer woven from threads Width × Height apart (turned by Direction round the centre); a thread passes
  // over Overlaps crossings and under one; Coverage leaves gaps, Shadowing darkens the threads where they go under,
  // Texture adds fibres
  ccThreads: (cv, p, x) => {
    const W = cv.width, H = cv.height, s = data(cv).data, img = new ImageData(W, H), d = img.data;
    const tw = Math.max(1, num(p.width, 50) * x.res), th = Math.max(1, num(p.height, 50) * x.res), ov = Math.max(1, Math.round(num(p.overlaps, 3)));
    const a = (num(p.direction) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a), [cx, cy] = ptc(p.center, x);
    const cov = num(p.coverage, 75) / 100, sh = num(p.shadowing, 50) / 100, tex = num(p.texture, 15) / 100;
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const u = (X - cx) * ca + (y - cy) * sa, v = -(X - cx) * sa + (y - cy) * ca;
      const iu = Math.floor(u / tw), iv = Math.floor(v / th), fu = u / tw - iu, fv = v / th - iv;
      // across each thread: inside its covered width? (vertical threads run along v, horizontal ones along u)
      const inV = Math.abs(fu - 0.5) * 2 <= cov, inH = Math.abs(fv - 0.5) * 2 <= cov, i = (y * W + X) * 4;
      if (!inV && !inH) { d[i + 3] = 0; continue; }
      const hTop = ((iu + iv) % (ov + 1) + ov + 1) % (ov + 1) !== 0, top = inH && (hTop || !inV) ? 'h' : 'v';
      const across = top === 'h' ? (fv - 0.5) * 2 / cov : (fu - 0.5) * 2 / cov, along = top === 'h' ? fu : fv;
      // round thread profile; darker where the thread dives under the crossing one
      const under = top === 'h' ? (inV && !hTop ? 1 : 0) : (inH && hTop ? 1 : 0);
      let k = Math.sqrt(Math.max(0, 1 - across * across)) * 0.6 + 0.4;
      k *= 1 - sh * 0.6 * Math.max(0, 1 - Math.abs(along - 0.5) * 2) * (inV && inH ? 1 : 0.3) * (under ? 1 : 0.5);
      k *= 1 - tex * 0.5 * prand(Math.round((top === 'h' ? v : u) * 1.5), top === 'h' ? iv : iu, 5);
      d[i] = clamp(s[i] * k); d[i + 1] = clamp(s[i + 1] * k); d[i + 2] = clamp(s[i + 2] * k); d[i + 3] = s[i + 3];
    }
    const out = mk(W, H); ctx2d(out).putImageData(img, 0, 0); return out;
  },

  // CC Ball Action: the layer as a grid of shaded balls (Grid Spacing, Ball Size) turned in 3D about the rotation axis,
  // each ball twisted further by Twist Angle × its Twist Property, scattered and unsettled by Instability
  ccBallAction: (cv, p, x) => {
    const W = cv.width, H = cv.height, s = data(cv).data, out = mk(W, H), g = ctx2d(out);
    const sp = Math.max(2, (Math.max(0, num(p.spacing, 5)) + 1) * x.res), r0 = (sp / 2) * (num(p.ballSize, 100) / 100);
    const axis = String(p.axis ?? 'x'), rot = (num(p.rotation) * Math.PI) / 180, tw = (num(p.twist) * Math.PI) / 180, prop = String(p.twistProperty ?? 'x');
    const sc = num(p.scatter) * x.res, inst = (num(p.instability) * Math.PI) / 180, focal = Math.max(W, H) * 2;
    const balls: { x: number; y: number; z: number; r: number; c: number[] }[] = [];
    for (let y = sp / 2; y < H; y += sp) for (let X = sp / 2; X < W; X += sp) {
      const c = pix(s, W, H, X, y);
      if (c[3] < 8) continue;
      const nx = X / W, ny = y / H, gi = Math.round(X / sp), gj = Math.round(y / sp);
      const pv = prop === 'x' ? nx : prop === 'y' ? ny : prop === 'centerX' ? Math.abs(nx - 0.5) * 2 : prop === 'centerY' ? Math.abs(ny - 0.5) * 2 : prop === 'radius' ? Math.hypot(nx - 0.5, ny - 0.5) * 2 : prop === 'random' ? prand(gi, gj, 3) : prop === 'red' ? c[0] / 255 : prop === 'green' ? c[1] / 255 : prop === 'blue' ? c[2] / 255 : prop === 'brightness' ? (c[0] + c[1] + c[2]) / 765 : prop === 'diamond' ? Math.abs(nx - 0.5) + Math.abs(ny - 0.5) : prop === 'rect' ? Math.max(Math.abs(nx - 0.5), Math.abs(ny - 0.5)) * 2 : 1 - Math.hypot(nx - 0.5, ny - 0.5);
      const ang = rot + tw * pv + inst * (prand(gi, gj, 9) * 2 - 1) * 0.2;
      let px = X - W / 2 + (prand(gi, gj, 1) * 2 - 1) * sc, py = y - H / 2 + (prand(gi, gj, 2) * 2 - 1) * sc, pz = (prand(gi, gj, 4) * 2 - 1) * sc;
      const turn = (a: 'x' | 'y' | 'z', t: number) => { const C = Math.cos(t), S = Math.sin(t); if (a === 'x') [py, pz] = [py * C - pz * S, py * S + pz * C]; else if (a === 'y') [px, pz] = [px * C + pz * S, -px * S + pz * C]; else [px, py] = [px * C - py * S, px * S + py * C]; };
      if (axis.includes('15')) turn('x', 0.26);
      for (const a of ['x', 'y', 'z'] as const) if (axis.replace('15', '').includes(a)) turn(a, ang);
      const k = focal / Math.max(1, focal + pz);
      balls.push({ x: W / 2 + px * k, y: H / 2 + py * k, z: pz, r: r0 * k, c });
    }
    balls.sort((a, b) => b.z - a.z);
    for (const b of balls) {
      if (b.r < 0.3) continue;
      const gr = g.createRadialGradient(b.x - b.r * 0.35, b.y - b.r * 0.35, b.r * 0.05, b.x, b.y, b.r);
      const [r, gg, bb, a] = b.c, ad = a / 255;
      gr.addColorStop(0, `rgba(${Math.min(255, r + 90)},${Math.min(255, gg + 90)},${Math.min(255, bb + 90)},${ad})`); gr.addColorStop(0.5, `rgba(${r},${gg},${bb},${ad})`); gr.addColorStop(1, `rgba(${r * 0.35},${gg * 0.35},${bb * 0.35},${ad})`);
      g.fillStyle = gr; g.beginPath(); g.arc(b.x, b.y, b.r, 0, Math.PI * 2); g.fill();
    }
    return out;
  },

  // CC Pixel Polly: from Start Time the layer breaks into squares or triangles (Grid Spacing) blown away from the force
  // centre (Force, randomised direction and speed), falling with Gravity and spinning
  ccPixelPolly: (cv, p, x) => {
    const W = cv.width, H = cv.height, t = x.t - num(p.start);
    if (t <= 0) return cv;
    const s = data(cv).data, out = mk(W, H), g = ctx2d(out), gs = Math.max(2, num(p.grid, 25) * x.res), [cx, cy] = ptc(p.center, x);
    const obj = String(p.object ?? 'texturedPolygon'), tri = obj.endsWith('olygon'), textured = obj.startsWith('textured');
    const force = num(p.force, 100) * x.res, grav = num(p.gravity, 1) * 300 * x.res, spin = (num(p.spinning, 360) * Math.PI) / 180;
    const dr = num(p.dirRandom, 10) / 100, srn = num(p.speedRandom, 15) / 100;
    for (let y = 0; y < H; y += gs) for (let X = 0; X < W; X += gs) {
      const gi = Math.round(X / gs), gj = Math.round(y / gs);
      const pieces: number[][] = tri ? [[X, y, X + gs, y, X, y + gs], [X + gs, y, X + gs, y + gs, X, y + gs]] : [[X, y, X + gs, y, X + gs, y + gs, X, y + gs]];
      pieces.forEach((pc, k) => {
        let mx = 0, my = 0; for (let q = 0; q < pc.length; q += 2) { mx += pc[q]; my += pc[q + 1]; } mx /= pc.length / 2; my /= pc.length / 2;
        const col = pix(s, W, H, mx, my);
        if (col[3] < 4) return;
        const dist = Math.hypot(mx - cx, my - cy) || 1, dir = Math.atan2(my - cy, mx - cx) + (prand(gi * 2 + k, gj, 1) * 2 - 1) * Math.PI * dr;
        const v = (force / Math.sqrt(1 + dist / Math.max(W, H))) * (1 + srn * (prand(gi * 2 + k, gj, 2) * 2 - 1));
        const ox = Math.cos(dir) * v * t, oy = Math.sin(dir) * v * t + 0.5 * grav * t * t, a = spin * t * (prand(gi * 2 + k, gj, 3) * 2 - 1);
        g.save(); g.translate(mx + ox, my + oy); g.rotate(a); g.translate(-mx, -my);
        const path = new Path2D(); for (let q = 0; q < pc.length; q += 2) { if (q) path.lineTo(pc[q], pc[q + 1]); else path.moveTo(pc[q], pc[q + 1]); } path.closePath();
        if (textured) { g.clip(path); g.drawImage(cv, 0, 0); } else { g.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${col[3] / 255})`; g.fill(path); }
        g.restore();
      });
    }
    return out;
  },

  // CC Scatterize: every pixel thrown a random distance up to Scatter (a fixed pattern), the throws twisted by Left
  // Twist on the left of the layer and Right Twist on the right; Transfer Mode puts them over the layer
  ccScatterize: (cv, p, x) => {
    const W = cv.width, H = cv.height, amt = num(p.scatter) * x.res;
    if (Math.abs(amt) < 0.5) return cv;
    const s = data(cv).data, img = new ImageData(W, H), d = img.data, lt = (num(p.leftTwist) * Math.PI) / 180, rtw = (num(p.rightTwist) * Math.PI) / 180;
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const j = (y * W + X) * 4;
      if (s[j + 3] === 0) continue;
      const r = prand(X, y, 61), a = prand(X, y, 67) * Math.PI * 2 + (X < W / 2 ? lt * (1 - (2 * X) / W) : rtw * ((2 * X) / W - 1)), dd = amt * r * r;
      const tx = Math.round(X + Math.cos(a) * dd), ty = Math.round(y + Math.sin(a) * dd);
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const i = (ty * W + tx) * 4;
      d[i] = s[j]; d[i + 1] = s[j + 1]; d[i + 2] = s[j + 2]; d[i + 3] = Math.max(d[i + 3], s[j + 3]);
    }
    const sc = mk(W, H); ctx2d(sc).putImageData(img, 0, 0);
    const tm = String(p.transfer ?? 'composite');
    if (tm === 'composite') return sc;
    const out = clone(cv), g = ctx2d(out);
    g.globalCompositeOperation = tm === 'screen' ? 'screen' : 'lighter'; g.drawImage(sc, 0, 0);
    if (tm === 'alphaAdd') { const o2 = clone(cv), g2 = ctx2d(o2); g2.globalCompositeOperation = 'destination-over'; g2.drawImage(sc, 0, 0); return o2; }
    return out;
  },

  // CC Bubbles: bubbles rising (Speed) and wobbling, each reflecting the layer (Liquid: in colour; Metal: in grey with
  // contrast), shaded by the shading type; the layer itself is replaced by them
  ccBubbles: (cv, p, x) => {
    const W = cv.width, H = cv.height, out = mk(W, H), g = ctx2d(out), t = x.t;
    const n = Math.min(5000, Math.round(num(p.amount, 150))), speed = num(p.speed, 1) * H * 0.15, amp = num(p.wobbleAmp, 10) * x.res, fq = num(p.wobbleFreq, 1);
    const metal = String(p.reflection ?? 'liquid') === 'metal', shade = String(p.shading ?? 'fadeIn');
    for (let i = 0; i < n; i++) {
      const r = Math.max(1, num(p.size, 4) * x.res * 2.5 * (0.5 + prand(i, 1, 71))), span = H + 4 * r;
      const by = H + 2 * r - ((((prand(i, 2, 71) * span + speed * (0.6 + 0.8 * prand(i, 3, 71)) * t) % span) + span) % span);
      const bx = prand(i, 4, 71) * W + amp * Math.sin(t * fq * 6.283 + prand(i, 5, 71) * 6.283);
      g.save(); g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2); g.clip();
      // the layer reflected in the bubble: the whole layer shrunk into it, upside down
      g.translate(bx, by); g.scale(1, -1); g.filter = metal ? 'grayscale(1) contrast(1.6)' : 'none';
      g.drawImage(cv, -r, -r, r * 2, r * 2); g.filter = 'none'; g.setTransform(1, 0, 0, 1, 0, 0);
      if (shade !== 'none') {
        const gr = g.createRadialGradient(bx, by, 0, bx, by, r), inw = shade === 'fadeIn', dk = shade === 'darken';
        if (shade === 'lighten' || dk) { gr.addColorStop(0, dk ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(bx - r, by - r, r * 2, r * 2); }
        else { gr.addColorStop(0, inw ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0)'); gr.addColorStop(1, inw ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,1)'); g.globalCompositeOperation = 'destination-out'; g.fillStyle = gr; g.fillRect(bx - r, by - r, r * 2, r * 2); g.globalCompositeOperation = 'source-over'; }
      }
      // a highlight
      g.fillStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.ellipse(bx - r * 0.35, by - r * 0.4, r * 0.22, r * 0.14, -0.6, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    return out;
  },

  // CC Drizzle: drops fall on the layer at Drip Rate, each spreading a ring of ripples (Rippling, Ripple Height,
  // Spreading) that lives Longevity seconds; the ripples displace and light the layer
  ccDrizzle: (cv, p, x) => {
    const W = cv.width, H = cv.height, t = x.t, life = Math.max(0.01, num(p.longevity, 1)), rate = num(p.rate, 1) * 8;
    if (rate <= 0) return cv;
    const drops: { x: number; y: number; age: number }[] = [];
    for (let i = Math.max(0, Math.floor((t - life) * rate)); i <= Math.floor(t * rate); i++) { const age = t - i / rate; if (age >= 0 && age <= life) drops.push({ x: prand(i, 1, 81) * W, y: prand(i, 2, 81) * H, age }); }
    if (!drops.length) return cv;
    const s = data(cv).data, img = new ImageData(W, H), d = img.data, spreadV = num(p.spreading, 100) * x.res * 0.6, waves = num(p.rippling, 360) / 360;
    const hk = num(p.rippleHeight, 100) / 100, disp = num(p.displacement, 20) * x.res * 0.05, lc = rgb(p.lightColor ?? '#ffffff');
    const height = (X: number, Y: number) => {
      let h = 0;
      for (const q of drops) {
        const R = q.age * spreadV, dd = Math.hypot(X - q.x, Y - q.y), w = Math.max(4, R * 0.5);
        if (Math.abs(dd - R * 0.75) > w) continue;
        h += Math.cos(((dd - R) / w) * Math.PI * Math.max(0.5, waves * 2)) * Math.max(0, 1 - Math.abs(dd - R * 0.75) / w) * (1 - q.age / life) * hk;
      }
      return h;
    };
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const gx = height(X + 1, y) - height(X - 1, y), gy = height(X, y + 1) - height(X, y - 1), i = (y * W + X) * 4;
      const c = pix(s, W, H, X + gx * disp * 10, y + gy * disp * 10), o = cyShade(c, -gx * 3, -gy * 3, 1, cyLightDir(p, x, W, X, y), p, lc, num(p.ambient, 100));
      d[i] = clamp(o[0]); d[i + 1] = clamp(o[1]); d[i + 2] = clamp(o[2]); d[i + 3] = s[i + 3];
    }
    const out = mk(W, H); ctx2d(out).putImageData(img, 0, 0); return out;
  },
} as Record<string, FxFn>);

// ───────────────────────── final round: CycoreFX particles, hair, glue, environment and Fractal ─────────────────────────

/** layer width in layer px (the canvas may be grown by earlier effects: close enough for the effects' units) */
const layerW = (cv: HTMLCanvasElement, x: FxCtx) => cv.width / x.res;
/** an angle param (0° = up, clockwise) → unit vector in canvas space */
const dirVec = (deg: number): [number, number] => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)];

/** The CycoreFX 2D emitter shared by CC Particle Systems II and CC Mr. Mercury: particles born at Birth Rate in the
 * producer's ellipse (Radius X / Y), launched by the animation (Velocity, Direction, Extra), pulled by Gravity and slowed
 * by Resistance; Inherit Velocity adds the producer's own motion. Positions are worked out from the birth time, so a
 * frame only depends on its time (canvas px). */
function cyEmit(p: Params, x: FxCtx, cv: HTMLCanvasElement, o: { perSec: number; prod: string; seed: number; max: number }) {
  const t = Math.max(0, x.t), rate = Math.max(0, num(p.birthRate, 1)) * o.perSec, life = Math.max(1e-3, num(p.longevity, 2));
  const out: { x: number; y: number; px: number; py: number; f: number; i: number; bx: number; by: number; vx: number; vy: number }[] = [];
  if (rate <= 0) return out;
  const U = layerW(cv, x) * 0.25 * x.res, vel = num(p.velocity, 1), grav = num(p.gravity, 1) * U, extra = num(p.extra, 1);
  const res = Math.max(-5, num(p.resistance) / 10), anim = String(p.animation ?? 'explosive'), inh = num(p.inheritVelocity) / 100;
  const [dx0, dy0] = dirVec(num(p.direction)), rx = num(p.radiusX, 3) * x.res, ry = num(p.radiusY, 3) * x.res;
  const prodAt = (tt: number) => ptc(x.at ? x.at(o.prod, tt) ?? p[o.prod] : p[o.prod], x);
  const first = Math.max(0, Math.floor((t - life) * rate)), last = Math.floor(t * rate);
  for (let i = Math.max(first, last - o.max); i <= last; i++) {
    const born = i / rate, age = t - born, f = age / life;
    if (age < 0 || f > 1) continue;
    const r = (k: number) => prand(i, k, o.seed);
    const [px0, py0] = prodAt(born), ea = r(0) * 2 * Math.PI, er = Math.sqrt(r(1));
    const bx = px0 + Math.cos(ea) * er * rx, by = py0 + Math.sin(ea) * er * ry;
    // launch velocity of the animation
    let vx: number, vy: number, sp = vel * U * (0.5 + 0.5 * r(2));
    const a = r(3) * 2 * Math.PI, jit = (r(4) - 0.5) * Math.min(Math.PI, Math.abs(extra) * 0.35);
    const along = (sgn: number, k: number) => { const c = Math.cos(jit), s = Math.sin(jit); vx = (dx0 * c - dy0 * s) * sgn * k; vy = (dx0 * s + dy0 * c) * sgn * k; };
    vx = Math.cos(a) * sp; vy = Math.sin(a) * sp;
    if (anim === 'direction') along(1, sp);
    else if (anim === 'directionNormalized') along(1, vel * U);
    else if (anim === 'biDirectional') along(r(5) < 0.5 ? 1 : -1, sp);
    else if (anim === 'biDirectionalNormalized') along(r(5) < 0.5 ? 1 : -1, vel * U);
    else if (anim === 'jet') { const c = Math.cos(jit * 0.25), s = Math.sin(jit * 0.25); vx = (dx0 * c - dy0 * s) * vel * U; vy = (dx0 * s + dy0 * c) * vel * U; }
    else if (anim === 'jetSideways') { const sg = r(5) < 0.5 ? 1 : -1; vx = -dy0 * sg * vel * U + (r(6) - 0.5) * extra * U * 0.2; vy = dx0 * sg * vel * U + (r(7) - 0.5) * extra * U * 0.2; }
    else if (anim === 'fire') { vx = (r(5) - 0.5) * U * 0.4 * Math.abs(extra); vy = -Math.abs(vel) * U * (0.5 + 0.5 * r(6)); }
    if (inh) { const [ax, ay] = prodAt(born - 0.04), [bx2, by2] = prodAt(born + 0.04); vx += ((bx2 - ax) / 0.08) * inh; vy += ((by2 - ay) / 0.08) * inh; }
    const pos = (g: number): [number, number] => {
      const dd = res > 1e-4 ? (1 - Math.exp(-res * g)) / res : res < -1e-4 ? (Math.exp(-res * g) - 1) / -res : g;
      // fire rises (gravity works as buoyancy, a third as strong) and flickers sideways
      const gy = anim === 'fire' ? -Math.abs(grav) * 0.3 : grav;
      let X = bx + vx * dd, Y = by + vy * dd + 0.5 * gy * g * g;
      if (anim === 'twirl' || anim === 'twirly' || anim === 'vortex') {
        // around the producer: Twirl turns with age, Twirly faster (Extra), Vortex also draws the particles in
        const turn = g * (anim === 'twirl' ? 1.5 : 3 + Math.abs(extra)) * Math.sign(vel || 1), c = Math.cos(turn), s = Math.sin(turn);
        let qx = X - px0, qy = Y - py0; if (anim === 'vortex') { const k = 1 / (1 + g); qx *= k; qy *= k; }
        X = px0 + qx * c - qy * s; Y = py0 + qx * s + qy * c;
      }
      if (anim === 'fractalExplosive' || anim === 'fire') { X += fbm(g * 2.5 + i * 0.37, o.seed + i, 2) * U * 0.15 * extra * g; if (anim === 'fractalExplosive') Y += fbm(g * 2.5 + 40 + i * 0.37, o.seed + i, 2) * U * 0.15 * extra * g; }
      return [X, Y];
    };
    const [X, Y] = pos(age), [PX, PY] = pos(Math.max(0, age - 0.05));
    out.push({ x: X, y: Y, px: PX, py: PY, f, i, bx, by, vx: X - PX, vy: Y - PY });
  }
  return out;
}

/** a CycoreFX light from the comp («Using: AE Lights»): the direction towards the first light at a canvas pixel, or
 * null without lights (then the effect's own light is used) */
function aeLight(x: FxCtx): ((X: number, Y: number) => [number, number, number]) | null {
  const L = x.scene?.()?.lights.find((q) => q.type !== 'ambient');
  if (!L) return null;
  if (L.type === 'parallel') { const v: [number, number, number] = [-L.dir[0], -L.dir[1], L.dir[2]]; return () => v; }
  const lx = (L.pos[0] - x.ox) * x.res, ly = (L.pos[1] - x.oy) * x.res, lz = -L.pos[2] * x.res;
  return (X, Y) => { const dx = lx - X, dy = ly - Y, l = Math.hypot(dx, dy, lz) || 1; return [dx / l, dy / l, lz / l]; };
}

/** Liquid blobs (CC Mr. Mercury, CC Glue Gun): metaballs that melt into one another (Influence), shaded as a reflective
 * material: the normals bend the layer's reflection (Reflection) and light it like CC Glass (ambient, diffuse,
 * specular, roughness, metal). Returns the blobs alone, on transparent. */
function blobs(cv: HTMLCanvasElement, src: Uint8ClampedArray, list: { x: number; y: number; r: number }[], p: Params, x: FxCtx, infl: number, refl: number, opacity: number): HTMLCanvasElement {
  const W = cv.width, H = cv.height, F = new Float32Array(W * H), out = mk(W, H);
  const reach = 1.05 + 1.5 * Math.max(0, Math.min(1, infl)), T = (1 - 1 / (reach * reach)) ** 2;
  for (const b of list) {
    if (b.r < 0.3) continue;
    const R = b.r * reach, R2 = R * R, x0 = Math.max(0, Math.floor(b.x - R)), x1 = Math.min(W - 1, Math.ceil(b.x + R)), y0 = Math.max(0, Math.floor(b.y - R)), y1 = Math.min(H - 1, Math.ceil(b.y + R));
    for (let y = y0; y <= y1; y++) for (let X = x0; X <= x1; X++) { const d2 = (X - b.x) ** 2 + (y - b.y) ** 2; if (d2 < R2) F[y * W + X] += (1 - d2 / R2) ** 2; }
  }
  // a dome of height ∝ how far inside the surface a pixel is
  const rAvg = list.length ? list.reduce((s, b) => s + b.r, 0) / list.length : 1, h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) h[i] = F[i] > T ? rAvg * Math.sqrt(1 - T / F[i]) : 0;
  const img = new ImageData(W, H), d = img.data, lc = rgb(p.lightColor ?? '#ffffff'), ae = String(p.using ?? 'effect') === 'ae' ? aeLight(x) : null;
  for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
    const i = y * W + X;
    if (h[i] <= 0) continue;
    const gx = (h[y * W + Math.min(W - 1, X + 1)] - h[y * W + Math.max(0, X - 1)]) / 2, gy = (h[Math.min(H - 1, y + 1) * W + X] - h[Math.max(0, y - 1) * W + X]) / 2;
    const c = pix(src, W, H, X - gx * refl * rAvg * 0.5, y - gy * refl * rAvg * 0.5);
    const L = ae ? ae(X, y) : cyLightDir(p, x, W, X, y);
    const o = cyShade(c, -gx, -gy, 1, L, p, lc, num(p.ambient, 100)), k = i * 4;
    d[k] = clamp(o[0]); d[k + 1] = clamp(o[1]); d[k + 2] = clamp(o[2]); d[k + 3] = clamp(Math.min(1, h[i] * 1.5) * opacity * 255);
  }
  ctx2d(out).putImageData(img, 0, 0);
  return out;
}

/** the 6 colours of the Apple ][ palette (Fractal) */
const APPLE2 = [[0, 0, 0], [20, 245, 60], [255, 68, 253], [255, 106, 60], [20, 207, 253], [255, 255, 255]];
const hsl = (hDeg: number, s: number, l: number): [number, number, number] => {
  const h = (((hDeg % 360) + 360) % 360) / 60, c = (1 - Math.abs(2 * l - 1)) * s, xx = c * (1 - Math.abs((h % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 1 ? [c, xx, 0] : h < 2 ? [xx, c, 0] : h < 3 ? [0, c, xx] : h < 4 ? [0, xx, c] : h < 5 ? [xx, 0, c] : [c, 0, xx];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
};

Object.assign(IMPL_ESTILIZAR, {
  // CC Particle Systems II: the layer is replaced by 2D particles from the shared CycoreFX emitter, each sized from
  // Birth to Death Size (± Size Variation), faded by the Opacity Map and coloured by the Color Map (Origin = the
  // layer's colour where the particle was born); Transfer Mode blends them with one another (Black Matte: on black)
  ccParticleSystems2: (cv, p, x) => {
    const W = cv.width, H = cv.height, out = mk(W, H), g = ctx2d(out), seed = num(p.seed) + 7, src = data(cv).data;
    const parts = cyEmit(p, x, cv, { perSec: 60, prod: 'position', seed, max: 20000 });
    const tm = String(p.transfer ?? 'composite'), type = String(p.particleType ?? 'line'), om = String(p.opacityMap ?? 'fadeOut'), cm = String(p.colorMap ?? 'birthDeath');
    if (tm === 'blackMatte') { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
    g.globalCompositeOperation = tm === 'screen' ? 'screen' : tm === 'add' ? 'lighter' : 'source-over';
    const bc = rgb(p.birthColor ?? '#fafa20'), dc = rgb(p.deathColor ?? '#c81010'), maxOp = num(p.maxOpacity, 75) / 100, sv = num(p.sizeVariation, 50) / 100;
    const unit = layerW(cv, x) * x.res / 40, b0 = num(p.birthSize, 0.15), d0 = num(p.deathSize, 0.75), alphaInh = !!num(p.sourceAlpha);
    for (const q of parts) {
      const f = q.f, org = pix(src, W, H, q.bx, q.by);
      let al = om === 'constant' ? 1 : om === 'fadeOutSharp' ? (f < 0.8 ? 1 : (1 - f) / 0.2) : om === 'fadeOut' ? 1 - f : om === 'fadeIn' ? f : om === 'fadeInOut' ? Math.sin(Math.PI * f) : 0.5 + 0.5 * Math.cos(f * Math.PI * 8);
      al *= maxOp * (alphaInh ? org[3] / 255 : 1);
      if (al <= 0.003) continue;
      const lerp = (a: number[], b: number[]) => [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * f);
      const c = cm === 'originDeath' ? lerp(org, dc) : cm === 'birthOrigin' ? lerp(bc, org) : cm === 'originConstant' ? org.slice(0, 3) : lerp(bc, dc);
      const col = (k = 1, a = al) => `rgba(${Math.round(clamp(c[0] * k))},${Math.round(clamp(c[1] * k))},${Math.round(clamp(c[2] * k))},${a})`;
      const size = Math.max(0.3, (b0 + (d0 - b0) * f) * unit * (1 - sv * prand(q.i, 9, seed)));
      const spin = prand(q.i, 10, seed) * 6.283 + f * 8 * (prand(q.i, 11, seed) - 0.5);
      g.save();
      if (type === 'line') { g.strokeStyle = col(); g.lineWidth = Math.max(0.5, size * 0.4); g.lineCap = 'round'; g.beginPath(); g.moveTo(q.px, q.py); g.lineTo(q.x, q.y); g.stroke(); }
      else if (type === 'star') { g.fillStyle = col(); g.beginPath(); for (let k = 0; k < 10; k++) { const a = spin + (k * Math.PI) / 5, rr = k % 2 ? size * 0.4 : size; g.lineTo(q.x + Math.cos(a) * rr, q.y + Math.sin(a) * rr); } g.fill(); }
      else if (type.endsWith('Sphere') || type === 'bubble') {
        const sh = type.startsWith('shaded'), fd = type.includes('aded') && type !== 'shadedSphere', off = sh ? size * 0.35 : 0;
        const gr = g.createRadialGradient(q.x - off, q.y - off, 0, q.x, q.y, size);
        if (type === 'bubble') { gr.addColorStop(0, col(1, al * 0.15)); gr.addColorStop(0.8, col(1, al * 0.4)); gr.addColorStop(0.95, col(1.3, al)); gr.addColorStop(1, col(1, 0)); }
        else { gr.addColorStop(0, sh ? col(1.6) : col()); gr.addColorStop(0.6, col(sh ? 0.9 : 1, fd ? al * 0.5 : al)); gr.addColorStop(1, col(sh ? 0.45 : 1, fd ? 0 : al)); }
        g.fillStyle = gr; g.beginPath(); g.arc(q.x, q.y, size, 0, Math.PI * 2); g.fill();
      } else if (type === 'motionPolygon') {
        // a quad stretched along the motion
        const vl = Math.hypot(q.vx, q.vy) || 1, ux = q.vx / vl, uy = q.vy / vl, L = Math.max(size, vl * 1.5);
        g.fillStyle = col(); g.beginPath(); g.moveTo(q.x + ux * L * 0.5 - uy * size * 0.5, q.y + uy * L * 0.5 + ux * size * 0.5); g.lineTo(q.x + ux * L * 0.5 + uy * size * 0.5, q.y + uy * L * 0.5 - ux * size * 0.5); g.lineTo(q.x - ux * L * 0.5 + uy * size * 0.5, q.y - uy * L * 0.5 - ux * size * 0.5); g.lineTo(q.x - ux * L * 0.5 - uy * size * 0.5, q.y - uy * L * 0.5 + ux * size * 0.5); g.fill();
      } else if (type.startsWith('lens')) {
        // lenses show the layer through them: convex magnifies, concave shrinks; the faded ones soften to the edge
        const k = type === 'lensConcave' ? 0.6 : 1.6, R = size * 1.5;
        g.beginPath(); g.arc(q.x, q.y, R, 0, Math.PI * 2); g.clip();
        g.globalAlpha = al; g.translate(q.x, q.y); g.scale(k, k); g.translate(-q.x, -q.y); g.drawImage(cv, 0, 0); g.setTransform(1, 0, 0, 1, 0, 0);
        if (type === 'lensDarkenFade') { g.globalAlpha = 1; g.fillStyle = `rgba(0,0,0,${al * 0.45})`; g.fill(); }
        if (type === 'lensFade' || type === 'lensDarkenFade') { g.globalCompositeOperation = 'destination-out'; const gr = g.createRadialGradient(q.x, q.y, R * 0.3, q.x, q.y, R); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)'); g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(q.x - R, q.y - R, 2 * R, 2 * R); }
        if (type === 'lensBubble') { g.globalAlpha = al; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = Math.max(0.5, R * 0.1); g.beginPath(); g.arc(q.x, q.y, R * 0.95, 0, Math.PI * 2); g.stroke(); }
      } else {
        // flat or solid polygons turning as they fly; the textured ones carry the layer from where they were born
        const nv = type.includes('Tri') || type === 'tetrahedron' ? 3 : 4, tilt = Math.abs(Math.cos(spin * 1.3));
        const P: number[] = []; for (let k = 0; k < nv; k++) { const a = spin + (k * 2 * Math.PI) / nv + Math.PI / 4; P.push(q.x + Math.cos(a) * size, q.y + Math.sin(a) * size * (type === 'cube' || type === 'tetrahedron' ? 1 : 0.3 + 0.7 * tilt)); }
        g.beginPath(); for (let k = 0; k < nv; k++) g.lineTo(P[k * 2], P[k * 2 + 1]); g.closePath();
        if (type.startsWith('textured')) { g.clip(); g.globalAlpha = al; g.drawImage(cv, q.bx - size, q.by - size, size * 2, size * 2, q.x - size, q.y - size, size * 2, size * 2); }
        else {
          g.fillStyle = col(type === 'cube' || type === 'tetrahedron' ? 0.7 : 0.6 + 0.6 * tilt); g.fill();
          if (type === 'cube' || type === 'tetrahedron') { g.fillStyle = col(1.25); g.beginPath(); g.moveTo(q.x, q.y); for (let k = 0; k < 2; k++) g.lineTo(P[k * 2], P[k * 2 + 1]); g.closePath(); g.fill(); }
        }
      }
      g.restore();
    }
    g.globalCompositeOperation = 'source-over';
    return out;
  },
  // CC Mr. Mercury: blobs from the shared emitter (Blob Birth / Death Size, Influence Map over each blob's life) melt
  // together (Blob Influence) into liquid metal that reflects the layer; the layer itself is replaced by the blobs
  ccMrMercury: (cv, p, x) => {
    const src = data(cv).data;
    const parts = cyEmit(p, x, cv, { perSec: 25, prod: 'producer', seed: 31, max: 3000 });
    const im = String(p.influenceMap ?? 'blobInOut'), unit = layerW(cv, x) * x.res / 12, b0 = num(p.blobBirthSize, 0.15), d0 = num(p.blobDeathSize, 0.75);
    const list = parts.map((q) => {
      const f = q.f, k = im === 'blobOut' ? 1 - f : im === 'blobIn' ? Math.min(1, f * 4) : im === 'blobOutSharp' ? (f < 0.85 ? 1 : (1 - f) / 0.15) : im === 'constant' ? 1 : Math.sin(Math.PI * Math.min(1, f));
      return { x: q.x, y: q.y, r: (b0 + (d0 - b0) * f) * unit * Math.max(0, k) };
    });
    return blobs(cv, src, list, p, x, num(p.blobInfluence, 100) / 100, 1, num(p.materialOpacity, 100) / 100);
  },
  // CC Glue Gun: a bead of glue left by the brush along its path (since Time Span seconds ago; 0 = since the start),
  // Density blobs a second; Wobbly wobbles it (Wobble Width / Height at Wobble Speed). The bead reflects the layer
  // (Reflection) and is lit like CC Glass; Strength is its opacity over the layer
  ccGlueGun: (cv, p, x) => {
    const t = Math.max(0, x.t), span = num(p.timeSpan), t0 = span > 0 ? Math.max(0, t - span) : 0;
    const dt = 1 / Math.max(1, num(p.density, 25) * 4), r = num(p.strokeWidth, 4) * x.res * 2, wob = String(p.paintStyle ?? 'plain') === 'wobbly';
    if (r <= 0.3) return cv;
    const list: { x: number; y: number; r: number }[] = [], n = Math.min(4000, Math.floor((t - t0) / dt));
    for (let k = 0; k <= n; k++) {
      const tt = Math.min(t, t0 + k * dt);
      let [bx, by] = ptc(x.at ? x.at('brush', tt) ?? p.brush : p.brush, x), rr = r;
      if (wob) { const ph = tt * num(p.wobbleSpeed, 100) * 0.05; bx += Math.sin(ph * 1.7) * num(p.wobbleWidth, 2.5) * x.res; by += Math.cos(ph * 1.3) * num(p.wobbleHeight, 2.5) * x.res; rr *= 1 + 0.25 * Math.sin(ph * 2.3); }
      list.push({ x: bx, y: by, r: rr });
    }
    const glue = blobs(cv, data(cv).data, list, p, x, 0.8, num(p.reflection, 100) / 100, num(p.strength, 100) / 100);
    const out = clone(cv); ctx2d(out).drawImage(glue, 0, 0);
    return out;
  },
  // CC Hair: hairs grow over the layer (Density per 100 × 100 px where it is opaque), Length long, Thickness thick; they
  // stand towards the viewer and fall under their Weight (Constant Mass: long hairs do not bend more). The Hairfall
  // Map (a layer's property, softened) makes hair shorter where it is dark and combs it down its slope, with some
  // noise; the colour mixes Hair Color with the layer's (Color Inheritance) and is lit as fibres (ambient, diffuse,
  // specular with Roughness) from Light Height / Direction
  ccHair: (cv, p, x) => {
    const W = cv.width, H = cv.height, src = data(cv).data, out = clone(cv), g = ctx2d(out);
    const area = (W / x.res) * (H / x.res), N = Math.min(40000, Math.round(num(p.density, 200) * area / 10000 * 0.5));
    const len = num(p.length, 25) * x.res, thick = Math.max(0.25, num(p.thickness, 0.7) * x.res * 1.4), wt = num(p.weight, 1), cmass = !!num(p.constantMass);
    if (N <= 0 || len <= 0) return out;
    // hairfall map
    const ML = p.mapLayer && x.layer ? x.layer(String(p.mapLayer)) : null, mc = mk(W, H), mg = ctx2d(mc);
    if (ML) mg.drawImage(ML.cv, (ML.ox - x.ox) * x.res, (ML.oy - x.oy) * x.res, (ML.cv.width / ML.res) * x.res, (ML.cv.height / ML.res) * x.res); else mg.drawImage(cv, 0, 0);
    const soft = num(p.mapSoftness, 25) * x.res * 0.3, md = data(soft > 0.3 ? blurCanvas(mc, soft) : mc).data, prop = String(p.mapProperty ?? 'luminance');
    const mv = (X: number, Y: number) => {
      const q = pix(md, W, H, X, Y), r = q[0], gg = q[1], b = q[2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      if (prop === 'hue') { if (mx === mn) return 0; const h = mx === r ? (gg - b) / (mx - mn) : mx === gg ? 2 + (b - r) / (mx - mn) : 4 + (r - gg) / (mx - mn); return (((h * 60) + 360) % 360) / 360; }
      if (prop === 'saturation') return mx ? (mx - mn) / mx : 0;
      return (prop === 'red' ? r : prop === 'green' ? gg : prop === 'blue' ? b : prop === 'alpha' ? q[3] : prop === 'lightness' ? (mx + mn) / 2 : r * 0.299 + gg * 0.587 + b * 0.114) / 255;
    };
    const ms = num(p.mapStrength, 60) / 100, noise = num(p.addNoise, 2) / 100, hc = rgb(p.color ?? '#513916'), inh = num(p.colorInheritance, 25) / 100, op = num(p.opacity, 50) / 100;
    const el = (Math.max(-100, Math.min(100, num(p.lightHeight, 70))) / 100) * (Math.PI / 2), la = (num(p.lightDirection, -45) * Math.PI) / 180;
    const L = [Math.cos(el) * Math.sin(la), -Math.cos(el) * Math.cos(la), Math.sin(el)], Hv = [L[0], L[1], L[2] + 1], hl = Math.hypot(Hv[0], Hv[1], Hv[2]);
    const amb = num(p.ambient, 10) / 100, dif = num(p.diffuse, 50) / 100, spc = num(p.specular, 30) / 100, ex = 0.5 / Math.max(1e-4, num(p.roughness, 0.075) ** 2) * 0.05;
    const roots: number[] = [];
    for (let i = 0; i < N; i++) roots.push(i);
    // back rows first, so the hairs in front lie over them
    const rx = (i: number) => prand(i, 1, 57) * W, ry = (i: number) => prand(i, 2, 57) * H;
    roots.sort((a, b) => ry(a) - ry(b));
    g.lineCap = 'round'; g.lineWidth = thick;
    const SEG = 6;
    for (const i of roots) {
      const X0 = rx(i), Y0 = ry(i), s0 = pix(src, W, H, X0, Y0);
      if (s0[3] < 8) continue;
      const m = mv(X0, Y0), L1 = len * Math.max(0, ms >= 0 ? 1 - ms + ms * m : 1 + ms * m) * (0.75 + 0.5 * prand(i, 3, 57));
      if (L1 < 0.5) continue;
      // lean: down the map's slope, plus noise
      const sx = mv(X0 + 3, Y0) - mv(X0 - 3, Y0), sy = mv(X0, Y0 + 3) - mv(X0, Y0 - 3), nz = 0.25 + noise * 4;
      let d = [-sx * ms * 6 + (prand(i, 4, 57) - 0.5) * nz, -sy * ms * 6 + (prand(i, 5, 57) - 0.5) * nz, 1];
      const bend = wt * 0.18 * (cmass ? 1 : L1 / (25 * x.res) + 0.3), sl = L1 / SEG, base = [0, 1, 2].map((k) => hc[k] + (s0[k] - hc[k]) * inh);
      let X = X0, Y = Y0;
      for (let k = 0; k < SEG; k++) {
        d[1] += bend; const dl = Math.hypot(d[0], d[1], d[2]) || 1; d = d.map((v) => v / dl);
        const tl = d[0] * L[0] + d[1] * L[1] + d[2] * L[2], th = (d[0] * Hv[0] + d[1] * Hv[1] + d[2] * Hv[2]) / hl;
        const kd = amb + dif * Math.sqrt(Math.max(0, 1 - tl * tl)), ks = spc * Math.pow(Math.sqrt(Math.max(0, 1 - th * th)), ex) * 255;
        const nx = X + d[0] * sl, ny = Y + d[1] * sl;
        g.strokeStyle = `rgba(${Math.round(clamp(base[0] * kd + ks))},${Math.round(clamp(base[1] * kd + ks))},${Math.round(clamp(base[2] * kd + ks))},${op * (1 - (k / SEG) * 0.4)})`;
        g.beginPath(); g.moveTo(X, Y); g.lineTo(nx, ny); g.stroke();
        X = nx; Y = ny;
      }
    }
    return out;
  },
  // CC Environment: the layer becomes an environment map (Spherical / latitude-longitude, Probe / angular map, or a
  // Vertical Cross of cube faces) seen through the comp camera (or straight ahead without one), turned by Horizontal
  // Pan; Lens Distortion bends the rays (barrel / pincushion), Filter Environment smooths the lookups
  ccEnvironment: (cv, p, x) => {
    const W = cv.width, H = cv.height, E = p.environment && x.layer ? x.layer(String(p.environment)) : null, env = E ? E.cv : cv;
    const ew = env.width, eh = env.height, ed = data(env).data, out = new ImageData(W, H), o = out.data, map = String(p.mapping ?? 'spherical');
    const sc = x.scene?.() ?? null, zoom = (sc ? sc.zoom : layerW(cv, x) * 1.3889) * x.res, R = sc ? sc.rot : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const pan = (num(p.horizontalPan) * Math.PI) / 180, cp = Math.cos(pan), sp = Math.sin(pan), k = num(p.lensDistortion) / 100, filt = !!num(p.filter);
    const cx = W / 2, cy = H / 2;
    const look = (u: number, v: number, i: number) => {
      u = (((u % 1) + 1) % 1) * ew - 0.5; v = Math.max(0, Math.min(eh - 1, v * eh - 0.5));
      if (!filt) { const j = (Math.min(eh - 1, Math.round(v)) * ew + ((Math.round(u) % ew) + ew) % ew) * 4; o[i] = ed[j]; o[i + 1] = ed[j + 1]; o[i + 2] = ed[j + 2]; o[i + 3] = 255; return; }
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      for (let c = 0; c < 3; c++) {
        const at = (a: number, b: number) => ed[(Math.min(eh - 1, b) * ew + ((a % ew) + ew) % ew) * 4 + c];
        o[i + c] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
      }
      o[i + 3] = 255;
    };
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      let dx = (X - cx) / zoom, dy = (y - cy) / zoom;
      const r2 = dx * dx + dy * dy; dx *= 1 + k * r2; dy *= 1 + k * r2;
      // camera ray → layer space (transpose of the layer → camera rotation), then the pan around the vertical axis
      const c0 = dx, c1 = dy, c2 = 1;
      let vx = R[0] * c0 + R[3] * c1 + R[6] * c2, vy = R[1] * c0 + R[4] * c1 + R[7] * c2, vz = R[2] * c0 + R[5] * c1 + R[8] * c2;
      const l = Math.hypot(vx, vy, vz) || 1; vx /= l; vy /= l; vz /= l;
      [vx, vz] = [vx * cp - vz * sp, vx * sp + vz * cp];
      const i = (y * W + X) * 4;
      if (map === 'probe') {
        const q = Math.hypot(vx, vy), r = q > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, vz))) / (Math.PI * q) : 0;
        look(0.5 + vx * r * 0.5, 0.5 + vy * r * 0.5, i);
      } else if (map === 'verticalCross') {
        // 3 × 4 cross: top (+Y up) in the first row, left / front / right in the second, bottom, then back upside down
        const ax = Math.abs(vx), ay = Math.abs(vy), az = Math.abs(vz);
        let col: number, row: number, s: number, t: number;
        if (az >= ax && az >= ay) { if (vz > 0) { col = 1; row = 1; s = vx / az; t = vy / az; } else { col = 1; row = 3; s = vx / az; t = -vy / az; } }
        else if (ax >= ay) { row = 1; if (vx > 0) { col = 2; s = -vz / ax; t = vy / ax; } else { col = 0; s = vz / ax; t = vy / ax; } }
        else { col = 1; if (vy < 0) { row = 0; s = vx / ay; t = vz / ay; } else { row = 2; s = vx / ay; t = -vz / ay; } }
        const u = (col + (s + 1) / 2) / 3, v = (row + (t + 1) / 2) / 4;
        look(Math.min(u, (col + 1) / 3 - 1e-6), v, i);
      } else look(0.5 + Math.atan2(vx, vz) / (2 * Math.PI), 0.5 + Math.asin(Math.max(-1, Math.min(1, vy))) / Math.PI, i);
    }
    const c = mk(W, H); ctx2d(c).putImageData(out, 0, 0); return c;
  },
  // Fractal: the Mandelbrot set (c = the pixel, from z = 0) or the Julia set (z = the pixel, c = the Mandelbrot's
  // centre X / Y) of z = z^n + c; Inverse turns the plane inside out (1 / p, then the Post-Inversion Offset); «over
  // Julia» shows the Julia set where the Mandelbrot one does not escape. Magnification doubles per unit; the escape
  // count colours the pixel through the palette (Cycle Steps per cycle, Hue, Cycle Offset), the set itself black (or
  // transparent). High Quality oversamples the edges (Edge Detect) or every pixel (Brute Force)
  fractal: (cv, p, x) => {
    const W = cv.width, H = cv.height, out = new ImageData(W, H), o = out.data, set = String(p.setChoice ?? 'mandelbrot');
    const pw = { z2: 2, z3: 3, z5: 5, z7: 7 }[String(p.equation ?? 'z2')] ?? 2, pal = String(p.palette ?? 'lightness');
    const lw = layerW(cv, x), lh = H / x.res, unit = 3 / Math.min(lw, lh), steps = Math.max(1, num(p.cycleSteps, 29)), hue = num(p.hue), off = num(p.cycleOffset) / 360;
    const mX = num(p.mX, -0.703), mY = num(p.mY), offX = num(p.offX), offY = num(p.offY), transp = !!num(p.transparency);
    const view = (j: boolean) => { const mag = Math.pow(2, num(j ? p.jMag : p.mMag)); return { cx: j ? num(p.jX) : mX, cy: j ? num(p.jY) : mY, s: unit / mag, lim: Math.max(1, Math.min(1e6, Math.round(num(j ? p.jEscape : p.mEscape, 300)))) }; };
    const VM = view(false), VJ = view(true), inv = set.includes('Inverse') || set === 'juliaInverse';
    // escape count (−1 = inside) and the angle of z when it escaped
    const iterate = (lx: number, ly: number, julia: boolean): [number, number] => {
      const V = julia ? VJ : VM;
      let a = V.cx + lx * V.s, b = V.cy + ly * V.s;
      if (inv) { const d = a * a + b * b || 1e-30; a = a / d + offX; b = -b / d + offY; }
      let zr = julia ? a : 0, zi = julia ? b : 0;
      const cr = julia ? mX : a, ci = julia ? mY : b;
      for (let n = 0; n < V.lim; n++) {
        let pr = zr, pi = zi;
        for (let e = 1; e < pw; e++) { const t = pr * zr - pi * zi; pi = pr * zi + pi * zr; pr = t; }
        zr = pr + cr; zi = pi + ci;
        if (zr * zr + zi * zi > 4) return [n, Math.atan2(zi, zr)];
      }
      return [-1, 0];
    };
    const colour = (n: number, ang: number): [number, number, number, number] => {
      if (n < 0) return transp ? [0, 0, 0, 0] : [0, 0, 0, 255];
      const ph = n / steps + off, fr = ((ph % 1) + 1) % 1;
      const c = pal === 'hueWheel' ? hsl(hue + fr * 360, 1, 0.5) : pal === 'blackWhite' ? (Math.floor(n + off * 2) % 2 ? [255, 255, 255] : [0, 0, 0]) : pal === 'solid' ? hsl(hue, 1, 0.5)
        : pal === 'escapeAngle' ? hsl(hue + (ang / (2 * Math.PI)) * 360 + off * 360, 1, 0.5) : pal === 'grayscale' ? [fr * 255, fr * 255, fr * 255] : pal === 'apple2' ? APPLE2[((Math.floor(n + off * 6) % 6) + 6) % 6] : hsl(hue, 1, fr);
      return [c[0], c[1], c[2], 255];
    };
    const sample = (lx: number, ly: number): [number, number, number, number] => {
      if (set === 'julia' || set === 'juliaInverse') { const [n, a] = iterate(lx, ly, true); return colour(n, a); }
      const [n, a] = iterate(lx, ly, false);
      if (n < 0 && set.endsWith('OverJulia')) { const [m, b] = iterate(lx, ly, true); return colour(m, b); }
      return colour(n, a);
    };
    const N = new Int32Array(W * H);
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const c = sample((X + 0.5 - W / 2) / x.res, (y + 0.5 - H / 2) / x.res), i = (y * W + X) * 4;
      o[i] = c[0]; o[i + 1] = c[1]; o[i + 2] = c[2]; o[i + 3] = c[3]; N[y * W + X] = c[0] * 65536 + c[1] * 256 + c[2] + (c[3] ? 0 : 1 << 25);
    }
    const edge = (X: number, y: number) => { const v = N[y * W + X]; return (X > 0 && N[y * W + X - 1] !== v) || (X < W - 1 && N[y * W + X + 1] !== v) || (y > 0 && N[(y - 1) * W + X] !== v) || (y < H - 1 && N[(y + 1) * W + X] !== v); };
    if (num(p.edgeHighlight)) {
      // edges of the colour bands drawn white (After Effects forces draft quality with it, so no oversampling)
      const hi: number[] = []; for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) if (edge(X, y)) hi.push(y * W + X);
      for (const j of hi) { o[j * 4] = o[j * 4 + 1] = o[j * 4 + 2] = o[j * 4 + 3] = 255; }
    } else {
      const brute = String(p.oversample ?? 'edge') === 'brute';
      let f = Math.max(2, Math.min(16, Math.round(num(p.oversampleFactor, 4))));
      while (f > 2 && W * H * f * f * (brute ? 1 : 0.15) > 6e6) f--;
      for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
        if (!brute && !edge(X, y)) continue;
        const acc = [0, 0, 0, 0];
        for (let a = 0; a < f; a++) for (let b = 0; b < f; b++) { const c = sample((X + (b + 0.5) / f - W / 2) / x.res, (y + (a + 0.5) / f - H / 2) / x.res); acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3]; }
        const i = (y * W + X) * 4, al = acc[3] || 1;
        o[i] = acc[0] / al; o[i + 1] = acc[1] / al; o[i + 2] = acc[2] / al; o[i + 3] = acc[3] / (f * f);
      }
    }
    const c = mk(W, H), g = ctx2d(c); g.putImageData(out, 0, 0);
    if (num(p.overlay) && !set.startsWith('julia')) {
      // the overlay marks the point the Julia set is drawn for (the Mandelbrot's centre)
      const px = W / 2, py = H / 2, s = 6 * x.res;
      g.strokeStyle = '#ffffff'; g.lineWidth = Math.max(1, x.res); g.beginPath(); g.moveTo(px - s, py); g.lineTo(px + s, py); g.moveTo(px, py - s); g.lineTo(px, py + s); g.stroke();
    }
    return c;
  },
} as Record<string, FxFn>);
