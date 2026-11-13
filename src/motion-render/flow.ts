// Pixel Motion (After Effects' frame blending / Timewarp «Pixel Motion»): an in-between frame built from the motion
// of every pixel instead of a cross-fade. Optical flow between two frames with pyramidal Lucas–Kanade on a grid,
// interpolated and smoothed into a dense field; then both frames are warped to the in-between time and mixed.

export interface Flow { w: number; h: number; u: Float32Array; v: Float32Array }

function gray(d: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return g;
}
function half(a: Float32Array, w: number, h: number): [Float32Array, number, number] {
  const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1), o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * 2 * w + x * 2; o[y * W + x] = (a[i] + a[Math.min(i + 1, a.length - 1)] + a[Math.min(i + w, a.length - 1)] + a[Math.min(i + w + 1, a.length - 1)]) / 4; }
  return [o, W, H];
}
const sample = (a: Float32Array, w: number, h: number, x: number, y: number) => {
  const xi = Math.max(0, Math.min(w - 2, Math.floor(x))), yi = Math.max(0, Math.min(h - 2, Math.floor(y)));
  const u = Math.max(0, Math.min(1, x - xi)), v = Math.max(0, Math.min(1, y - yi)), i = yi * w + xi;
  return (a[i] * (1 - u) + a[i + 1] * u) * (1 - v) + (a[i + w] * (1 - u) + a[i + w + 1] * u) * v;
};

/**
 * Flow from frame A to frame B (RGBA data of the same size): where each pixel of A went in B. `detail` 0…100 makes
 * the grid finer (After Effects' «Vector Detail»); `smooth` the field smoother.
 */
export function opticalFlow(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, detail = 20, smooth = 0.5): Flow {
  // work at ≤ 480 px: the field is smooth anyway
  const k = Math.min(1, 480 / Math.max(w, h)), W = Math.max(8, Math.round(w * k)), H = Math.max(8, Math.round(h * k));
  const scale = (g: Float32Array) => { const o = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o[y * W + x] = sample(g, w, h, x / k, y / k); return o; };
  const A0 = scale(gray(a, w, h)), B0 = scale(gray(b, w, h));
  const levels: { A: Float32Array; B: Float32Array; w: number; h: number }[] = [{ A: A0, B: B0, w: W, h: H }];
  while (levels.length < 5 && levels[levels.length - 1].w > 24) {
    const L = levels[levels.length - 1], [A, w2, h2] = half(L.A, L.w, L.h), [B] = half(L.B, L.w, L.h);
    levels.push({ A, B, w: w2, h: h2 });
  }
  // grid of tracked points (spacing from «vector detail»), pyramidal LK per point, coarse to fine
  const step = Math.max(3, Math.round(16 - detail * 0.12)), r = 4;
  const gw = Math.ceil(W / step) + 1, gh = Math.ceil(H / step) + 1, gu = new Float32Array(gw * gh), gv = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let du = 0, dv = 0;
    for (let li = levels.length - 1; li >= 0; li--) {
      const L = levels[li], s = 1 / 2 ** li, px = gx * step * s, py = gy * step * s;
      du *= li === levels.length - 1 ? 1 : 2; dv *= li === levels.length - 1 ? 1 : 2;
      for (let it = 0; it < 5; it++) {
        let gxx = 0, gxy = 0, gyy = 0, bx = 0, by = 0;
        for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
          const X = px + x, Y = py + y;
          const ix = (sample(L.A, L.w, L.h, X + 1, Y) - sample(L.A, L.w, L.h, X - 1, Y)) / 2, iy = (sample(L.A, L.w, L.h, X, Y + 1) - sample(L.A, L.w, L.h, X, Y - 1)) / 2;
          const it2 = sample(L.B, L.w, L.h, X + du, Y + dv) - sample(L.A, L.w, L.h, X, Y);
          gxx += ix * ix; gxy += ix * iy; gyy += iy * iy; bx -= ix * it2; by -= iy * it2;
        }
        const det = gxx * gyy - gxy * gxy;
        if (det < 1e-3) break;
        const ddx = (gyy * bx - gxy * by) / det, ddy = (gxx * by - gxy * bx) / det;
        du += Math.max(-3, Math.min(3, ddx)); dv += Math.max(-3, Math.min(3, ddy));
        if (Math.abs(ddx) < 0.02 && Math.abs(ddy) < 0.02) break;
      }
    }
    gu[gy * gw + gx] = du; gv[gy * gw + gx] = dv;
  }
  // smooth the grid (median-like: average of the 3×3 neighbours, weighted by «smooth»)
  for (let pass = 0; pass < Math.round(smooth * 3); pass++) {
    const u2 = gu.slice(), v2 = gv.slice();
    for (let gy = 1; gy < gh - 1; gy++) for (let gx = 1; gx < gw - 1; gx++) {
      let su = 0, sv = 0;
      for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) { su += gu[(gy + y) * gw + gx + x]; sv += gv[(gy + y) * gw + gx + x]; }
      u2[gy * gw + gx] = su / 9; v2[gy * gw + gx] = sv / 9;
    }
    gu.set(u2); gv.set(v2);
  }
  // dense field at full size (bilinear between grid points), in full-size pixels
  const u = new Float32Array(w * h), v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = (x * k) / step, fy = (y * k) / step;
    u[y * w + x] = sample(gu, gw, gh, fx, fy) / k; v[y * w + x] = sample(gv, gw, gh, fx, fy) / k;
  }
  return { w, h, u, v };
}

/** In-between frame at fraction t (0 = A, 1 = B): A pushed forward t × flow, B pulled back (1 − t) × flow, mixed. */
export function pixelMotion(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, t: number, flow: Flow, out: Uint8ClampedArray): void {
  const at = (d: Uint8ClampedArray, x: number, y: number, c: number) => {
    const xi = Math.max(0, Math.min(w - 2, Math.floor(x))), yi = Math.max(0, Math.min(h - 2, Math.floor(y)));
    const uu = Math.max(0, Math.min(1, x - xi)), vv = Math.max(0, Math.min(1, y - yi)), i = (yi * w + xi) * 4 + c;
    return (d[i] * (1 - uu) + d[i + 4] * uu) * (1 - vv) + (d[i + w * 4] * (1 - uu) + d[i + w * 4 + 4] * uu) * vv;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, fu = flow.u[i], fv = flow.v[i];
    // backward warping: the pixel at time t came from x − t·f in A and lands at x + (1 − t)·f in B
    for (let c = 0; c < 4; c++) out[i * 4 + c] = at(a, x - t * fu, y - t * fv, c) * (1 - t) + at(b, x + (1 - t) * fu, y + (1 - t) * fv, c) * t;
  }
}
