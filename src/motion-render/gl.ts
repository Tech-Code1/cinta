// WebGL quad renderer: draws a layer canvas onto 4 arbitrary corners with perspective-correct texturing.
// Used for 3D layers seen through the camera and for the Corner Pin effect.
const VS = `
attribute vec2 aPos;
attribute vec3 aUvq;
varying vec3 vUvq;
void main() { vUvq = aUvq; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FS = `
precision highp float;
varying vec3 vUvq;
uniform sampler2D uTex;
uniform float uAlpha;
void main() { vec2 uv = vUvq.xy / vUvq.z; gl_FragColor = texture2D(uTex, uv) * uAlpha; }`;

export class GLQuad {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private gl2: WebGL2RenderingContext | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private fboTex: WebGLTexture | null = null;
  private fboSize = [0, 0];
  private lastSrc: TexImageSource | null = null;
  /** float accumulation available (motion blur on the GPU) */
  readonly canAccumulate: boolean;
  private buf: WebGLBuffer;
  private tex: WebGLTexture;
  private uAlpha: WebGLUniformLocation;

  constructor() {
    this.canvas = document.createElement('canvas');
    const opts = { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true, alpha: true };
    const gl2 = this.canvas.getContext('webgl2', opts) as WebGL2RenderingContext | null;
    const gl = (gl2 ?? this.canvas.getContext('webgl', opts)) as WebGLRenderingContext | null;
    if (!gl) throw new Error('WebGL no está disponible: las capas 3D necesitan la tarjeta gráfica.');
    this.gl = gl;
    this.gl2 = gl2;
    this.canAccumulate = !!gl2 && !!gl2.getExtension('EXT_color_buffer_float');
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader'); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const aPos = gl.getAttribLocation(prog, 'aPos'), aUvq = gl.getAttribLocation(prog, 'aUvq');
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aUvq);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(aUvq, 3, gl.FLOAT, false, 20, 8);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.uAlpha = gl.getUniformLocation(prog, 'uAlpha')!;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Draws `src` with its corners (tl, tr, br, bl) at screen points `pts` (pixels of a W×H target).
   * `q` gives the perspective weight of each corner (1/z for a camera, or the corner-pin projective weight).
   * Returns the GL canvas (W×H) — draw it right away, it is reused.
   */
  draw(src: HTMLCanvasElement, W: number, H: number, pts: [number, number][], q: number[], alpha = 1): HTMLCanvasElement {
    const gl = this.gl;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.lastSrc = null;
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const v: number[] = [];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [x, y] = pts[i];
      v.push((x / W) * 2 - 1, 1 - (y / H) * 2, uv[i][0] * q[i], uv[i][1] * q[i], q[i]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
    gl.uniform1f(this.uAlpha, alpha);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return this.canvas;
  }

  private quad(pts: [number, number][], q: number[], W: number, H: number, flipV = false) {
    const gl = this.gl;
    const uv = flipV ? [[0, 1], [1, 1], [1, 0], [0, 0]] : [[0, 0], [1, 0], [1, 1], [0, 1]];
    const v: number[] = [];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [x, y] = pts[i];
      v.push((x / W) * 2 - 1, 1 - (y / H) * 2, uv[i][0] * q[i], uv[i][1] * q[i], q[i]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ───── motion blur: sum weighted sub-frames in a half-float buffer, then resolve to the canvas ─────
  beginAccum(W: number, H: number) {
    const gl = this.gl2!;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    if (!this.fbo || this.fboSize[0] !== W || this.fboSize[1] !== H) {
      if (this.fboTex) gl.deleteTexture(this.fboTex);
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      this.fboTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
      this.fboSize = [W, H];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.lastSrc = null;
  }
  addQuad(src: HTMLCanvasElement, pts: [number, number][], q: number[], weight: number) {
    const gl = this.gl2!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.lastSrc !== src) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); this.lastSrc = src; }
    gl.uniform1f(this.uAlpha, weight);
    this.quad(pts, q, this.fboSize[0], this.fboSize[1]);
  }
  /** Draws the accumulated buffer into the GL canvas and returns it (reused: copy it right away). */
  endAccum(): HTMLCanvasElement {
    const gl = this.gl2!;
    const [W, H] = this.fboSize;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.uniform1f(this.uAlpha, 1);
    this.quad([[0, 0], [W, 0], [W, H], [0, H]], [1, 1, 1, 1], W, H, true);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.lastSrc = null;
    return this.canvas;
  }
}

/** Projective weights for a quad (corner pin): from the intersection of its diagonals. */
export function quadWeights(p: [number, number][]): number[] {
  const [a, b, c, d] = p; // tl tr br bl
  const x1 = a[0], y1 = a[1], x2 = c[0], y2 = c[1], x3 = b[0], y3 = b[1], x4 = d[0], y4 = d[1];
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return [1, 1, 1, 1];
  const px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / den;
  const py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / den;
  const dist = (q: [number, number]) => Math.hypot(q[0] - px, q[1] - py);
  const da = dist(a), db = dist(b), dc = dist(c), dd = dist(d);
  return [(da + dc) / (dc || 1), (db + dd) / (dd || 1), (dc + da) / (da || 1), (dd + db) / (db || 1)];
}

// ───────────────────────── distortion effects (fragment shader) ─────────────────────────
const WARP_VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;
const WARP_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform int uMode;
uniform vec4 uP;
uniform vec4 uQ;
uniform vec2 uC;
uniform float uT;
float hash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)) * 2.0 - 1.0; }
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// fractal noise (x, y), about −1…1: octaves (a fractional count fades the last one in); smoother = higher octaves weaker
vec2 vturb(vec2 p, float ev, float seed, float size, float oct, float smo) {
  vec2 o = vec2(0.0); float amp = 1.0, f = 1.0, n = 0.0;
  for (int i = 0; i < 10; i++) {
    float w = clamp(oct - float(i), 0.0, 1.0);
    if (w <= 0.0) break;
    vec3 s = vec3(p / size * f, ev + float(i) * 3.1 + seed * 7.13);
    o += vec2(vnoise(s), vnoise(s + vec3(31.7, 17.3, 0.0))) * amp * w; n += amp * w; amp *= smo > 0.5 ? 0.3 : 0.5; f *= 2.0;
  }
  return o / max(n, 0.0001);
}
void main() {
  vec2 p = vUv * uSize;
  vec2 d = p - uC;
  float r = length(d);
  vec2 q = p;
  if (uMode == 0) { // twirl: angle uP.x (rad), radius uP.y
    if (r < uP.y) { float k = 1.0 - r / uP.y; float a = uP.x * k * k; float c = cos(a), s = sin(a); q = uC + vec2(c * d.x + s * d.y, -s * d.x + c * d.y); }
  } else if (uMode == 1) { // bulge: horizontal / vertical radius uP.xy, height uP.z, taper uP.w (share of the radius), pin all edges uQ.x
    float e = length(d / max(uP.xy, vec2(0.001)));
    if (e < 1.0) {
      float k = 1.0 - e * e, w = pow(k, 2.0 / (1.0 + 2.0 * uP.w));
      if (uQ.x > 0.5) w *= clamp(min(min(p.x, uSize.x - p.x), min(p.y, uSize.y - p.y)) / max(1.0, 0.05 * min(uSize.x, uSize.y)), 0.0, 1.0);
      q = uC + d * (1.0 - uP.z * 0.5 * w);
    }
  } else if (uMode == 2) { // ripple: radius uP.x, wavelength uP.y, amplitude uP.z, phase uT; uQ.x 1 = symmetric
    if (r < uP.x && r > 0.0) {
      float a = r / uP.y * 6.2831853 - uT, f = uP.z * (1.0 - r / uP.x);
      // symmetric: pixels move along the radius only; asymmetric: x and y follow the wave a quarter apart
      q = uQ.x > 0.5 ? p + d / r * sin(a) * f : p + vec2(d.x / r * sin(a), d.y / r * cos(a)) * f;
    }
  } else if (uMode == 4) { // wave warp: height uP.x, width uP.y, direction uP.z (rad), phase uP.w (cycles); kind uQ.x, pinning uQ.y
    vec2 u = vec2(sin(uP.z), -cos(uP.z)), v = vec2(-u.y, u.x);
    float s = dot(p, u) / uP.y - uP.w, f = fract(s), w;
    int k = int(uQ.x + 0.5);
    if (k == 0) w = sin(s * 6.2831853);
    else if (k == 1) w = f < 0.5 ? 1.0 : -1.0;
    else if (k == 2) w = 1.0 - 4.0 * abs(f - 0.5);
    else if (k == 3) w = 2.0 * f - 1.0;
    else if (k == 4) { float h = fract(s * 2.0) * 2.0 - 1.0; w = sqrt(max(0.0, 1.0 - h * h)) * (f < 0.5 ? 1.0 : -1.0); }
    else if (k == 5) { float h = f * 2.0 - 1.0; w = sqrt(max(0.0, 1.0 - h * h)) * 2.0 - 1.0; }
    else if (k == 6) { float h = f * 2.0 - 1.0; w = 1.0 - 2.0 * sqrt(max(0.0, 1.0 - h * h)); }
    else { float i = floor(s * 2.0), t = fract(s * 2.0); if (k == 8) t = t * t * (3.0 - 2.0 * t); w = mix(hash(vec3(i, 0.37, 1.7)), hash(vec3(i + 1.0, 0.37, 1.7)), t); }
    float pin = 1.0;
    int pm = int(uQ.y + 0.5);
    if (pm > 0) {
      vec2 n = p / uSize;
      if (pm == 1) pin = clamp(min(min(n.x, 1.0 - n.x), min(n.y, 1.0 - n.y)) * 10.0, 0.0, 1.0);
      else if (pm == 2) pin = clamp(length(n - 0.5) * 4.0, 0.0, 1.0);
      else if (pm == 3) pin = clamp(n.x * 4.0, 0.0, 1.0);
      else if (pm == 4) pin = clamp(n.y * 4.0, 0.0, 1.0);
      else if (pm == 5) pin = clamp((1.0 - n.x) * 4.0, 0.0, 1.0);
      else if (pm == 6) pin = clamp((1.0 - n.y) * 4.0, 0.0, 1.0);
      else if (pm == 7) pin = clamp(min(n.y, 1.0 - n.y) * 10.0, 0.0, 1.0);
      else pin = clamp(min(n.x, 1.0 - n.x) * 10.0, 0.0, 1.0);
    }
    q = p - v * w * uP.x * pin;
  } else { // turbulent displace: amount uP.x, size uP.y, octaves uP.z, kind uP.w; pinning uQ.x, cycle uQ.y (0 = off), seed uQ.z; noise offset uC, evolution uT
    int kind = int(uP.w + 0.5);
    float smo = (kind >= 3 && kind <= 5) ? 1.0 : 0.0;
    vec2 np = p - uC;
    float c = uQ.y * 4.0, e = c > 0.0 ? mod(uT, c) : uT;
    vec2 o = vturb(np, e, uQ.z, uP.y, uP.z, smo);
    // a looping evolution: blend with the field one cycle back, so the end meets the start
    if (c > 0.0) o = mix(o, vturb(np, e - c, uQ.z, uP.y, uP.z, smo), e / c);
    vec2 dsp = o;
    if (kind == 1 || kind == 4 || kind == 2 || kind == 5) {
      // bulge / twist: along (or across) the slope of one noise field
      float h = max(1.0, uP.y * 0.05);
      float n0 = vturb(np, e, uQ.z, uP.y, uP.z, smo).x;
      vec2 g = vec2(vturb(np + vec2(h, 0.0), e, uQ.z, uP.y, uP.z, smo).x - n0, vturb(np + vec2(0.0, h), e, uQ.z, uP.y, uP.z, smo).x - n0) / h * uP.y * 0.5;
      dsp = (kind == 1 || kind == 4) ? -g : vec2(-g.y, g.x);
    } else if (kind == 6) dsp = vec2(0.0, o.x);
    else if (kind == 7) dsp = vec2(o.x, 0.0);
    else if (kind == 8) dsp = vec2(o.x, o.x);
    float pin = 1.0;
    int pm = int(uQ.x + 0.5);
    if (pm > 0) {
      float m = max(1.0, 0.1 * min(uSize.x, uSize.y));
      float l = clamp(p.x / m, 0.0, 1.0), r2 = clamp((uSize.x - p.x) / m, 0.0, 1.0), t2 = clamp(p.y / m, 0.0, 1.0), b = clamp((uSize.y - p.y) / m, 0.0, 1.0);
      if (pm == 1) pin = l * r2 * t2 * b; else if (pm == 2) pin = t2 * b; else if (pm == 3) pin = l * r2;
      else if (pm == 4) pin = l; else if (pm == 5) pin = r2; else if (pm == 6) pin = t2; else pin = b;
    }
    q = p + dsp * uP.x * pin;
  }
  vec2 uv = q / uSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  gl_FragColor = texture2D(uTex, uv);
}`;
export class GLWarp {
  readonly canvas = document.createElement('canvas');
  private gl: WebGLRenderingContext;
  private u: Record<string, WebGLUniformLocation>;
  constructor() {
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
    if (!gl) throw new Error('WebGL no está disponible para los efectos de distorsión.');
    this.gl = gl;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader'); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, WARP_VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, WARP_FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 8, 0);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.u = Object.fromEntries(['uSize', 'uMode', 'uP', 'uQ', 'uC', 'uT'].map((n) => [n, gl.getUniformLocation(prog, n)!]));
  }
  /** mode: 0 twirl, 1 bulge, 2 ripple, 3 turbulent displace, 4 wave warp. Returns a new canvas. */
  run(src: HTMLCanvasElement, mode: number, p: [number, number, number, number], c: [number, number], t: number, q: [number, number, number, number] = [0, 0, 0, 0]): HTMLCanvasElement {
    const gl = this.gl;
    const W = src.width, H = src.height;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.uniform2f(this.u.uSize, W, H);
    gl.uniform1i(this.u.uMode, mode);
    gl.uniform4f(this.u.uP, ...p);
    gl.uniform4f(this.u.uQ, ...q);
    gl.uniform2f(this.u.uC, c[0], c[1]);
    gl.uniform1f(this.u.uT, t);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    out.getContext('2d')!.drawImage(this.canvas, 0, 0);
    return out;
  }
}

// ───────────────────────── lit 3D layers ─────────────────────────
/** One light at a frame, in world space (comp pixels, z into the screen). */
export interface LitLight {
  type: 'parallel' | 'spot' | 'point' | 'ambient';
  pos: number[];
  /** unit vector the light shines along (parallel, spot) */
  dir: number[];
  /** colour × intensity */
  color: number[];
  cosOuter: number;
  cosInner: number;
  falloff: 'none' | 'smooth' | 'inverseSquare';
  radius: number;
  distance: number;
  shadow: boolean;
  darkness: number;
  /** softness, caster layer px */
  diffusion: number;
}
/** A shadow caster: its texture, the matrix from world space to its layer space and its rectangle there (x, y, w, h). */
export interface LitCaster { src: HTMLCanvasElement; inv: ArrayLike<number>; rect: [number, number, number, number] }
export interface LitMaterial { ambient: number; diffuse: number; specular: number; shininess: number; metal: number; acceptsShadows: boolean }

const MAX_LIGHTS = 8, MAX_CASTERS = 4;
const LVS = `
attribute vec2 aPos;
attribute vec3 aUvq;
attribute vec4 aWq;
attribute float aZ;
varying vec3 vUvq;
varying vec4 vWq;
// aZ = camera depth: with w = z the GPU interpolates in perspective and the depth test works per pixel
void main() { vUvq = aUvq; vWq = aWq; float n = 1.0, f = 100000.0; gl_Position = vec4(aPos * aZ, ((f + n) / (f - n)) * aZ - 2.0 * f * n / (f - n), aZ); }`;
const LFS = `
precision highp float;
varying vec3 vUvq;
varying vec4 vWq;
uniform sampler2D uTex;
uniform float uAlpha;
uniform vec3 uN;
uniform vec3 uEye;
uniform int uNL;
uniform vec4 uLType[${MAX_LIGHTS}];
uniform vec3 uLPos[${MAX_LIGHTS}];
uniform vec3 uLDir[${MAX_LIGHTS}];
uniform vec3 uLCol[${MAX_LIGHTS}];
uniform vec4 uLCone[${MAX_LIGHTS}];
uniform float uLDiff[${MAX_LIGHTS}];
uniform vec4 uMat;
uniform float uMetal;
uniform float uAcceptShadow;
uniform float uUnlit;
uniform int uNC;
uniform sampler2D uC0;
uniform sampler2D uC1;
uniform sampler2D uC2;
uniform sampler2D uC3;
uniform mat4 uCInv[${MAX_CASTERS}];
uniform vec4 uCRect[${MAX_CASTERS}];
float casterAlpha(int i, vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  if (i == 0) return texture2D(uC0, uv).a;
  if (i == 1) return texture2D(uC1, uv).a;
  if (i == 2) return texture2D(uC2, uv).a;
  return texture2D(uC3, uv).a;
}
float lightPass(vec3 P, vec3 L, float diff) {
  float pass = 1.0;
  for (int i = 0; i < ${MAX_CASTERS}; i++) {
    if (i >= uNC) break;
    vec4 p = uCInv[i] * vec4(P, 1.0);
    vec4 l = uCInv[i] * vec4(L, 1.0);
    float d = p.z - l.z;
    if (abs(d) < 1e-4) continue;
    float t = p.z / d;
    if (t <= 0.0 || t >= 1.0 || t * length(l.xyz - p.xyz) < 0.5) continue; // the caster is not between P and the light
    vec2 hit = p.xy + (l.xy - p.xy) * t;
    vec2 uv = (hit - uCRect[i].xy) / uCRect[i].zw;
    vec2 o = vec2(diff * t) / uCRect[i].zw;
    float a = casterAlpha(i, uv) * 0.4 + (casterAlpha(i, uv + vec2(o.x, 0.0)) + casterAlpha(i, uv - vec2(o.x, 0.0)) + casterAlpha(i, uv + vec2(0.0, o.y)) + casterAlpha(i, uv - vec2(0.0, o.y))) * 0.15;
    pass *= 1.0 - a;
  }
  return pass;
}
void main() {
  vec4 c = texture2D(uTex, vUvq.xy / vUvq.z);
  if (c.a < 0.02) discard;
  if (uUnlit > 0.5) { gl_FragColor = c * uAlpha; return; }
  vec3 P = vWq.xyz / vWq.w;
  vec3 V = normalize(uEye - P);
  vec3 N = dot(uN, V) < 0.0 ? -uN : uN;
  vec3 amb = vec3(0.0);
  vec3 dif = vec3(0.0);
  vec3 spe = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uNL) break;
    vec4 T = uLType[i];
    if (T.x < 0.5) { amb += uLCol[i]; continue; }
    vec3 L;
    vec3 Lpos;
    float att = 1.0;
    if (T.x < 1.5) { L = -uLDir[i]; Lpos = P + L * 1.0e5; }
    else {
      vec3 d = uLPos[i] - P;
      float dist = length(d);
      L = d / max(dist, 1e-3);
      Lpos = uLPos[i];
      if (T.y > 0.5 && T.y < 1.5) att = 1.0 - smoothstep(T.z, T.z + max(T.w, 1.0), dist);
      else if (T.y > 1.5) att = dist <= T.z ? 1.0 : (T.z * T.z) / (dist * dist);
      if (T.x > 2.5) { float cs = dot(-L, uLDir[i]); att *= smoothstep(uLCone[i].x, max(uLCone[i].y, uLCone[i].x + 1e-4), cs); }
    }
    float nl = max(dot(N, L), 0.0);
    if (nl <= 0.0 || att <= 0.0) continue;
    float sh = 1.0;
    if (uLCone[i].z > 0.5 && uAcceptShadow > 0.5 && uNC > 0) sh = 1.0 - uLCone[i].w * (1.0 - lightPass(P, Lpos, uLDiff[i]));
    vec3 lc = uLCol[i] * att * sh;
    dif += lc * nl;
    vec3 R = reflect(-L, N);
    spe += lc * pow(max(dot(R, V), 0.0), 1.0 + uMat.w * 99.0);
  }
  vec3 rgb = c.rgb * (amb * uMat.x + dif * uMat.y);
  vec3 hl = spe * uMat.z * mix(vec3(c.a), c.rgb, uMetal);
  gl_FragColor = vec4(rgb + hl, c.a) * uAlpha;
}`;
/** Draws 3D layers lit by the comp lights (ambient, diffuse and specular per pixel) with shadows from other layers. */
export class GLLit {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private buf: WebGLBuffer;
  private tex: WebGLTexture;
  private ctex: WebGLTexture[] = [];
  private u = new Map<string, WebGLUniformLocation | null>();
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true, alpha: true, depth: true }) as WebGLRenderingContext | null;
    if (!gl) throw new Error('WebGL no está disponible: las luces 3D necesitan la tarjeta gráfica.');
    this.gl = gl;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader'); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, LVS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, LFS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);
    this.prog = prog;
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const aPos = gl.getAttribLocation(prog, 'aPos'), aUvq = gl.getAttribLocation(prog, 'aUvq'), aWq = gl.getAttribLocation(prog, 'aWq');
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aUvq);
    gl.enableVertexAttribArray(aWq);
    const aZ = gl.getAttribLocation(prog, 'aZ');
    gl.enableVertexAttribArray(aZ);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 40, 0);
    gl.vertexAttribPointer(aUvq, 3, gl.FLOAT, false, 40, 8);
    gl.vertexAttribPointer(aWq, 4, gl.FLOAT, false, 40, 20);
    gl.vertexAttribPointer(aZ, 1, gl.FLOAT, false, 40, 36);
    const mkTex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    };
    this.tex = mkTex();
    for (let i = 0; i < MAX_CASTERS; i++) this.ctex.push(mkTex());
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.uniform1i(this.loc('uTex'), 0);
    for (let i = 0; i < MAX_CASTERS; i++) gl.uniform1i(this.loc(`uC${i}`), i + 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  private loc(name: string) { if (!this.u.has(name)) this.u.set(name, this.gl.getUniformLocation(this.prog, name)); return this.u.get(name)!; }
  /** Starts a batch: the 3D layers drawn until end() share one depth buffer (they hide each other per pixel). */
  begin(W: number, H: number) {
    const gl = this.gl;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.batch = true;
  }
  /** Ends the batch and returns the GL canvas (reused: draw it right away). */
  end(): HTMLCanvasElement { this.batch = false; this.gl.disable(this.gl.DEPTH_TEST); return this.canvas; }
  private batch = false;
  /**
   * Like GLQuad.draw, lit: `world` are the world positions of the 4 corners, `normal` the layer's world normal and
   * `eye` the camera position; no lights = drawn as is (still depth-tested in a batch). Outside a batch it returns the
   * GL canvas with only this layer (reused: draw it right away).
   */
  draw(src: HTMLCanvasElement, W: number, H: number, pts: [number, number][], q: number[], world: number[][], normal: number[], eye: number[], lights: LitLight[], mat: LitMaterial, casters: LitCaster[], alpha = 1): HTMLCanvasElement {
    const gl = this.gl;
    if (!this.batch) {
      if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.uniform1f(this.loc('uUnlit'), lights.length ? 0 : 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const cs = casters.slice(0, MAX_CASTERS);
    cs.forEach((c, i) => { gl.activeTexture(gl.TEXTURE1 + i); gl.bindTexture(gl.TEXTURE_2D, this.ctex[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c.src); });
    gl.activeTexture(gl.TEXTURE0);
    const ls = lights.slice(0, MAX_LIGHTS);
    const flat = (n: number, f: (l: LitLight) => number[]) => { const a = new Float32Array(MAX_LIGHTS * n); ls.forEach((l, i) => a.set(f(l), i * n)); return a; };
    const TYPE = { ambient: 0, parallel: 1, point: 2, spot: 3 }, FALL = { none: 0, smooth: 1, inverseSquare: 2 };
    gl.uniform1i(this.loc('uNL'), ls.length);
    gl.uniform4fv(this.loc('uLType'), flat(4, (l) => [TYPE[l.type], FALL[l.falloff], l.radius, l.distance]));
    gl.uniform3fv(this.loc('uLPos'), flat(3, (l) => l.pos.slice(0, 3)));
    gl.uniform3fv(this.loc('uLDir'), flat(3, (l) => l.dir.slice(0, 3)));
    gl.uniform3fv(this.loc('uLCol'), flat(3, (l) => l.color.slice(0, 3)));
    gl.uniform4fv(this.loc('uLCone'), flat(4, (l) => [l.cosOuter, l.cosInner, l.shadow ? 1 : 0, l.darkness]));
    gl.uniform1fv(this.loc('uLDiff'), flat(1, (l) => [l.diffusion]));
    gl.uniform3fv(this.loc('uN'), normal.slice(0, 3));
    gl.uniform3fv(this.loc('uEye'), eye.slice(0, 3));
    gl.uniform4fv(this.loc('uMat'), [mat.ambient, mat.diffuse, mat.specular, mat.shininess]);
    gl.uniform1f(this.loc('uMetal'), mat.metal);
    gl.uniform1f(this.loc('uAcceptShadow'), mat.acceptsShadows ? 1 : 0);
    gl.uniform1i(this.loc('uNC'), cs.length);
    const inv = new Float32Array(MAX_CASTERS * 16), rect = new Float32Array(MAX_CASTERS * 4);
    cs.forEach((c, i) => { inv.set(Array.from(c.inv), i * 16); rect.set(c.rect, i * 4); });
    gl.uniformMatrix4fv(this.loc('uCInv'), false, inv);
    gl.uniform4fv(this.loc('uCRect'), rect);
    gl.uniform1f(this.loc('uAlpha'), alpha);
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const v: number[] = [];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [x, y] = pts[i], w = world[i];
      v.push((x / W) * 2 - 1, 1 - (y / H) * 2, uv[i][0] * q[i], uv[i][1] * q[i], q[i], w[0] * q[i], w[1] * q[i], w[2] * q[i], q[i], 1 / q[i]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return this.canvas;
  }

  // ── a pre-rendered image with per-pixel depth (3D models from scene3d.ts) in the batch's depth buffer ──
  private dprog: WebGLProgram | null = null;
  private dbuf: WebGLBuffer | null = null;
  private dtex: WebGLTexture | null = null;
  private ztex: WebGLTexture | null = null;
  /** false when the GPU cannot write depth per pixel (EXT_frag_depth): the image is then drawn at one depth */
  get fragDepth() { return !!this.gl.getExtension('EXT_frag_depth'); }
  /**
   * Draws `src` (premultiplied, the whole W×H frame) with its depth: `depth` is window depth packed in 24-bit RGB,
   * bottom row first (scene3d.ts Rendered.depth), the same depth equation as the layers drawn by draw(). Pixels
   * behind what the batch already holds are hidden, and they hide what is drawn after them. Without per-pixel depth
   * the whole image gets `flat` (window depth).
   */
  drawDepthImage(src: HTMLCanvasElement, depth: Uint8Array, W: number, H: number, alpha = 1, flat = 0.5): HTMLCanvasElement {
    const gl = this.gl, ext = gl.getExtension('EXT_frag_depth');
    if (!this.dprog) {
      const sh = (type: number, s: string) => { const o = gl.createShader(type)!; gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o) ?? 'shader'); return o; };
      const prog = gl.createProgram()!;
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, `attribute vec2 aPos; uniform float uFlat; varying vec2 vUv; void main() { vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, uFlat * 2.0 - 1.0, 1.0); }`));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `${ext ? '#extension GL_EXT_frag_depth : enable\n' : ''}precision highp float;
varying vec2 vUv; uniform sampler2D uTex; uniform sampler2D uZ; uniform vec2 uPx; uniform float uAlpha;
float dec(vec2 uv) { vec4 c = texture2D(uZ, uv) * 255.0; return (c.r * 65536.0 + c.g * 256.0 + c.b) / 16777215.0; }
void main() {
  vec4 c = texture2D(uTex, vUv);
  if (c.a < 0.003) discard;
  ${ext ? `// the nearest depth around the pixel: antialiased edges belong to the object they fringe
  vec2 zu = vec2(vUv.x, 1.0 - vUv.y);
  float d = 1.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) d = min(d, dec(zu + vec2(float(i), float(j)) * uPx));
  if (d >= 1.0) discard;
  gl_FragDepthEXT = d;` : ''}
  gl_FragColor = c * uAlpha;
}`));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
      this.dprog = prog;
      this.dbuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dbuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const mk = (filter: number) => { const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter); return t; };
      this.dtex = mk(gl.NEAREST); this.ztex = mk(gl.NEAREST);
    }
    if (!this.batch) {
      if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    const prog = this.dprog!;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dtex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ztex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, depth);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uZ'), 1);
    gl.uniform2f(gl.getUniformLocation(prog, 'uPx'), 1 / W, 1 / H);
    gl.uniform1f(gl.getUniformLocation(prog, 'uAlpha'), alpha);
    gl.uniform1f(gl.getUniformLocation(prog, 'uFlat'), Math.max(0, Math.min(1, flat)));
    // the lit program's attributes are switched off while this one draws, then restored with their layout
    const p = this.prog, at = (n: string) => gl.getAttribLocation(p, n), litAttrs = ['aPos', 'aUvq', 'aWq', 'aZ'].map(at);
    for (const a of litAttrs) gl.disableVertexAttribArray(a);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dbuf);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 8, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(aPos);
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    for (const a of litAttrs) gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(at('aPos'), 2, gl.FLOAT, false, 40, 0);
    gl.vertexAttribPointer(at('aUvq'), 3, gl.FLOAT, false, 40, 8);
    gl.vertexAttribPointer(at('aWq'), 4, gl.FLOAT, false, 40, 20);
    gl.vertexAttribPointer(at('aZ'), 1, gl.FLOAT, false, 40, 36);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    return this.canvas;
  }
}

// ───────────────────────── textured triangle mesh (puppet pins) ─────────────────────────
const MVS = `
attribute vec2 aPos;
attribute vec2 aUv;
uniform vec2 uSize;
varying vec2 vUv;
void main() { vUv = aUv; gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, 0.0, 1.0); }`;
const MFS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;
/** Draws a texture through a triangle mesh: positions in target pixels, uv in 0…1 of the source. */
export class GLMesh {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private pbuf: WebGLBuffer;
  private ubuf: WebGLBuffer;
  private ibuf: WebGLBuffer;
  private tex: WebGLTexture;
  private uSize: WebGLUniformLocation;
  private uint32: boolean;
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true, alpha: true }) as WebGLRenderingContext | null;
    if (!gl) throw new Error('WebGL no está disponible: la marioneta necesita la tarjeta gráfica.');
    this.gl = gl;
    this.uint32 = !!gl.getExtension('OES_element_index_uint');
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader'); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, MVS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, MFS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.pbuf = gl.createBuffer()!;
    this.ubuf = gl.createBuffer()!;
    this.ibuf = gl.createBuffer()!;
    const aPos = gl.getAttribLocation(prog, 'aPos'), aUv = gl.getAttribLocation(prog, 'aUv');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pbuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ubuf);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
    this.uSize = gl.getUniformLocation(prog, 'uSize')!;
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  /** Returns the GL canvas (W×H, reused: draw it right away). */
  draw(src: HTMLCanvasElement, W: number, H: number, pos: Float32Array, uv: Float32Array, tris: Uint32Array): HTMLCanvasElement {
    const gl = this.gl;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.uniform2f(this.uSize, W, H);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pbuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ubuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibuf);
    if (this.uint32) {
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, tris, gl.DYNAMIC_DRAW);
      gl.drawElements(gl.TRIANGLES, tris.length, gl.UNSIGNED_INT, 0);
    } else {
      // without 32-bit indices: unindexed triangles
      const p = new Float32Array(tris.length * 2), u = new Float32Array(tris.length * 2);
      tris.forEach((v, i) => { p[i * 2] = pos[v * 2]; p[i * 2 + 1] = pos[v * 2 + 1]; u[i * 2] = uv[v * 2]; u[i * 2 + 1] = uv[v * 2 + 1]; });
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pbuf); gl.bufferData(gl.ARRAY_BUFFER, p, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ubuf); gl.bufferData(gl.ARRAY_BUFFER, u, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, tris.length);
    }
    return this.canvas;
  }
}
