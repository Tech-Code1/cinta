// Colour effects on the GPU: each one becomes an SVG filter (feColorMatrix / feComponentTransfer / feComposite)
// applied with the canvas `filter` property, instead of a per-pixel loop in JavaScript. Filters are cached by
// their (rounded) parameters; animated parameters reuse a bounded pool.
import { parseColor } from '../core/motion/anim';

const NS = 'http://www.w3.org/2000/svg';
const LUM = '0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0';
const cache = new Map<string, string>();
let seq = 0;

function root(): SVGSVGElement {
  let s = document.getElementById('cinta-fx-svg') as SVGSVGElement | null;
  if (!s) {
    s = document.createElementNS(NS, 'svg');
    s.id = 'cinta-fx-svg';
    s.setAttribute('width', '0');
    s.setAttribute('height', '0');
    s.style.position = 'absolute';
    s.style.pointerEvents = 'none';
    document.body.append(s);
  }
  return s;
}
/** CSS filter value for an SVG filter body (cached). */
function filter(key: string, body: string): string {
  let id = cache.get(key);
  if (id) return `url(#${id})`;
  if (cache.size > 400) {
    // forget the oldest half (animated parameters create one per frame)
    const keys = [...cache.keys()].slice(0, 200);
    for (const k of keys) { document.getElementById(cache.get(k)!)?.remove(); cache.delete(k); }
  }
  id = `cfx${seq++}`;
  const f = document.createElementNS(NS, 'filter');
  f.id = id;
  f.setAttribute('color-interpolation-filters', 'sRGB');
  f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', '1'); f.setAttribute('height', '1');
  f.setAttribute('filterUnits', 'objectBoundingBox');
  f.innerHTML = body;
  root().append(f);
  cache.set(key, id);
  return `url(#${id})`;
}
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const table = (fn: (x: number) => number, n = 33) => Array.from({ length: n }, (_, i) => r3(Math.max(0, Math.min(1, fn(i / (n - 1)))))).join(' ');
const funcs = (r: string, g = r, b = g) => `<feComponentTransfer><feFuncR ${r}/><feFuncG ${g}/><feFuncB ${b}/></feComponentTransfer>`;
const mixWithSource = (amount: number) => (amount >= 0.999 ? '' : `<feComposite in2="SourceGraphic" operator="arithmetic" k1="0" k2="${r3(amount)}" k3="${r3(1 - amount)}" k4="0"/>`);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Filter string for a colour effect, or null when it has no GPU version (the pixel version is used). */
export function colorFilter(fx: string, p: Record<string, unknown>): string | null {
  switch (fx) {
    case 'brightnessContrast': {
      if (num(p.legacy, 1) === 0) return null;
      const b = num(p.brightness) / 100, c = 1 + num(p.contrast) / 100;
      return filter(`bc|${r3(b)}|${r3(c)}`, funcs(`type="linear" slope="${r3(c)}" intercept="${r3((b * 255 / 255 - 0.5) * c + 0.5)}"`));
    }
    case 'levels': {
      // without Clip To Output Black / White the pixel version extends the range
      if (p.clipBlack === 'off' || p.clipWhite === 'off') return null;
      const ib = num(p.inBlack) / 255, iw = Math.max(ib + 1 / 255, num(p.inWhite, 255) / 255), gm = Math.max(0.01, num(p.gamma, 1)), ob = num(p.outBlack) / 255, ow = num(p.outWhite, 255) / 255;
      const t = table((x) => ob + (ow - ob) * Math.pow(Math.max(0, Math.min(1, (x - ib) / (iw - ib))), 1 / gm));
      return filter(`lv|${t}`, funcs(`type="table" tableValues="${t}"`));
    }
    case 'tint': {
      const b = parseColor(String(p.black ?? '#000')), w = parseColor(String(p.white ?? '#fff')), a = num(p.amount, 100) / 100;
      const f = (i: number) => `type="table" tableValues="${r3(b[i])} ${r3(w[i])}"`;
      return filter(`ti|${b}|${w}|${r3(a)}`, `<feColorMatrix type="matrix" values="${LUM}"/>${funcs(f(0), f(1), f(2))}${mixWithSource(a)}`);
    }
    case 'tritone': {
      const hi = parseColor(String(p.high)), mi = parseColor(String(p.mid)), lo = parseColor(String(p.low)), bl = num(p.blend) / 100;
      const f = (i: number) => `type="table" tableValues="${r3(lo[i])} ${r3(mi[i])} ${r3(hi[i])}"`;
      return filter(`tt|${hi}|${mi}|${lo}|${r3(bl)}`, `<feColorMatrix type="matrix" values="${LUM}"/>${funcs(f(0), f(1), f(2))}${mixWithSource(1 - bl)}`);
    }
    case 'invert': {
      if ((p.channel ?? 'rgb') !== 'rgb') return null;
      const bl = num(p.blend) / 100;
      return filter(`in|${r3(bl)}`, `${funcs('type="table" tableValues="1 0"')}${mixWithSource(1 - bl)}`);
    }
    case 'posterize': {
      const n = Math.max(2, Math.round(num(p.levels, 6)));
      const t = Array.from({ length: n }, (_, i) => r3(i / (n - 1))).join(' ');
      return filter(`po|${n}`, funcs(`type="discrete" tableValues="${t}"`));
    }
    case 'threshold': {
      const l = num(p.level, 128) / 255;
      return filter(`th|${r3(l)}`, `<feColorMatrix type="matrix" values="${LUM}"/>${funcs(`type="linear" slope="2000" intercept="${r3(-2000 * l)}"`)}`);
    }
    case 'toonBands': {
      // luminance → n flat colours (discrete transfer tables), balance shifts the thresholds
      const n = Math.max(2, Math.min(4, Math.round(num(p.bands, 3)))), bal = num(p.balance) / 200;
      const cols = ['c1', 'c2', 'c3', 'c4'].slice(0, n).map((k) => parseColor(String(p[k] ?? '#000')));
      const M = 64;
      const band = (j: number) => Math.max(0, Math.min(n - 1, Math.floor(Math.max(0, Math.min(0.9999, (j + 0.5) / M + bal)) * n)));
      const tv = (ch: number) => Array.from({ length: M }, (_, j) => r3(cols[band(j)][ch])).join(' ');
      return filter(`tb|${n}|${r3(bal)}|${cols.map((c) => c.join(',')).join('|')}`, `<feColorMatrix type="matrix" values="${LUM}"/>${funcs(`type="discrete" tableValues="${tv(0)}"`, `type="discrete" tableValues="${tv(1)}"`, `type="discrete" tableValues="${tv(2)}"`)}`);
    }
  }
  return null;
}

/** Gooey matte: blur, then a steep alpha curve around the threshold so nearby blobs melt into each other. */
export function gooeyFilter(sigma: number, threshold: number, softness: number): string {
  const th = Math.max(0.01, Math.min(0.99, threshold)), w = Math.max(0.004, softness);
  const slope = 1 / w;
  return filter(`goo|${r3(sigma)}|${r3(th)}|${r3(w)}`, `<feGaussianBlur in="SourceGraphic" stdDeviation="${r3(sigma)}" result="b"/><feComponentTransfer in="b"><feFuncA type="linear" slope="${r3(slope)}" intercept="${r3(-(th - w / 2) * slope)}"/></feComponentTransfer>`);
}

/** Bright pass for the glow: alpha = how far the luminance is above the threshold (optionally recoloured). */
export function brightPassFilter(threshold: number, tint: string | null): string {
  const th = Math.max(0, Math.min(0.99, threshold));
  const slope = 1 / Math.max(0.01, 1 - th);
  const lumToAlpha = `<feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0.2126 0.7152 0.0722 0 0" result="l"/><feComponentTransfer in="l" result="b"><feFuncA type="linear" slope="${r3(slope)}" intercept="${r3(-th * slope)}"/></feComponentTransfer><feComposite in="b" in2="SourceAlpha" operator="in" result="c"/>`;
  if (!tint) return filter(`bp|${r3(th)}`, lumToAlpha);
  const [r, g, b] = parseColor(tint);
  return filter(`bp|${r3(th)}|${tint}`, `${lumToAlpha}<feFlood flood-color="rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})"/><feComposite in2="c" operator="in"/>`);
}
