// Image completion for Content-Aware Fill (pure TypeScript): a smooth membrane from the hole's border (Edge Blend)
// and a multi-scale patch-based completion (PatchMatch nearest-neighbour fields, Barnes et al. 2009, with the
// expectation–maximisation voting of Wexler et al. 2007), coarse to fine: every patch that touches the hole is
// replaced by its most similar patch of the known part of the image, and each hole pixel becomes the average of
// the patches over it. Images are float RGB (3 per pixel), holes 1 where the colour is to be made up.

export interface FImg { w: number; h: number; d: Float32Array }

/** Smooth fill: the hole's pixels solve Laplace's equation with the border as boundary (coarse-to-fine SOR). */
export function laplaceFill(img: FImg, hole: Uint8Array): void {
  const { w, h } = img;
  if (!hole.some((v) => v)) return;
  // a coarse solution first (half size, recursively) gives the starting values
  if (w > 24 && h > 24) {
    const [sm, sh] = downsample(img, hole);
    laplaceFill(sm, sh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!hole[i]) continue;
      const j = Math.min(sm.h - 1, y >> 1) * sm.w + Math.min(sm.w - 1, x >> 1);
      for (let c = 0; c < 3; c++) img.d[i * 3 + c] = sm.d[j * 3 + c];
    }
  } else {
    // tiny: start from the mean of the known pixels
    const m = [0, 0, 0]; let n = 0;
    for (let i = 0; i < w * h; i++) if (!hole[i]) { for (let c = 0; c < 3; c++) m[c] += img.d[i * 3 + c]; n++; }
    for (let i = 0; i < w * h; i++) if (hole[i]) for (let c = 0; c < 3; c++) img.d[i * 3 + c] = n ? m[c] / n : 128;
  }
  const idx: number[] = [];
  for (let i = 0; i < w * h; i++) if (hole[i]) idx.push(i);
  const omega = 1.8;
  for (let it = 0; it < 60; it++) {
    for (const i of idx) {
      const x = i % w, y = (i / w) | 0;
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        if (x > 0) { s += img.d[(i - 1) * 3 + c]; n++; }
        if (x < w - 1) { s += img.d[(i + 1) * 3 + c]; n++; }
        if (y > 0) { s += img.d[(i - w) * 3 + c]; n++; }
        if (y < h - 1) { s += img.d[(i + w) * 3 + c]; n++; }
        const v = img.d[i * 3 + c];
        img.d[i * 3 + c] = v + omega * (s / n - v);
      }
    }
  }
}

/** Half-size image and hole (a pixel is hole when any of its 2×2 is). */
export function downsample(img: FImg, hole: Uint8Array): [FImg, Uint8Array] {
  const { w, h } = img, W = Math.max(1, w >> 1), H = Math.max(1, h >> 1);
  const d = new Float32Array(W * H * 3), m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = y * W + x;
    let n = 0; const s = [0, 0, 0]; let any = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const X = Math.min(w - 1, x * 2 + dx), Y = Math.min(h - 1, y * 2 + dy), i = Y * w + X;
      if (hole[i]) { any = 1; continue; }
      for (let c = 0; c < 3; c++) s[c] += img.d[i * 3 + c];
      n++;
    }
    m[o] = any;
    for (let c = 0; c < 3; c++) d[o * 3 + c] = n ? s[c] / n : 0;
  }
  return [{ w: W, h: H, d }, m];
}

/** Deterministic random numbers (the same fill every run). */
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

/**
 * Patch-based completion of the hole (in place). `prior` (optional, same size) are starting colours for the hole
 * (e.g. what other frames saw there); without it the coarsest level starts from the membrane fill.
 */
export function inpaint(img: FImg, hole: Uint8Array, o: { patch?: number; seed?: number; prior?: Float32Array | null; iterations?: number } = {}): void {
  if (!hole.some((v) => v)) return;
  const pr = Math.max(1, Math.floor((o.patch ?? 7) / 2));
  // pyramid until the hole is small
  const levels: { img: FImg; hole: Uint8Array; prior: Float32Array | null }[] = [{ img, hole, prior: o.prior ?? null }];
  for (;;) {
    const L = levels[levels.length - 1];
    let x0 = L.img.w, x1 = 0, y0 = L.img.h, y1 = 0;
    for (let i = 0; i < L.hole.length; i++) if (L.hole[i]) { const x = i % L.img.w, y = (i / L.img.w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (Math.max(x1 - x0, y1 - y0) <= pr * 4 || L.img.w < pr * 8 || L.img.h < pr * 8 || levels.length > 7) break;
    const [si, sh] = downsample(L.img, L.hole);
    let sp: Float32Array | null = null;
    if (L.prior) { const [p2] = downsample({ w: L.img.w, h: L.img.h, d: L.prior }, new Uint8Array(L.hole.length)); sp = p2.d; }
    levels.push({ img: si, hole: sh, prior: sp });
  }
  const rand = rng(o.seed ?? 1234567);
  let nnf: Int32Array | null = null, nnW = 0, nnH = 0;
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li], { w, h } = L.img, N = w * h;
    // starting colours of the hole
    if (li === levels.length - 1) {
      if (L.prior) { for (let i = 0; i < N; i++) if (L.hole[i]) for (let c = 0; c < 3; c++) L.img.d[i * 3 + c] = L.prior[i * 3 + c]; }
      else laplaceFill(L.img, L.hole);
    } else {
      const U = levels[li + 1];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!L.hole[i]) continue;
        const j = Math.min(U.img.h - 1, y >> 1) * U.img.w + Math.min(U.img.w - 1, x >> 1);
        for (let c = 0; c < 3; c++) L.img.d[i * 3 + c] = U.img.d[j * 3 + c];
      }
    }
    // valid source centres: the whole patch inside the image and outside the hole
    const bad = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (L.hole[i]) bad[i] = 1;
    const valid: number[] = [];
    const isValid = new Uint8Array(N);
    {
      // a patch is valid when no hole pixel within pr (square)
      const rowHit = new Uint8Array(N);
      for (let y = 0; y < h; y++) { let cnt = 0; for (let x = 0; x <= Math.min(w - 1, pr); x++) cnt += bad[y * w + x]; for (let x = 0; x < w; x++) { rowHit[y * w + x] = cnt > 0 ? 1 : 0; if (x + pr + 1 < w) cnt += bad[y * w + x + pr + 1]; if (x - pr >= 0) cnt -= bad[y * w + x - pr]; } }
      for (let x = 0; x < w; x++) { let cnt = 0; for (let y = 0; y <= Math.min(h - 1, pr); y++) cnt += rowHit[y * w + x]; for (let y = 0; y < h; y++) { const ok = cnt === 0 && x >= pr && y >= pr && x < w - pr && y < h - pr; if (ok) { isValid[y * w + x] = 1; valid.push(y * w + x); } if (y + pr + 1 < h) cnt += rowHit[(y + pr + 1) * w + x]; if (y - pr >= 0) cnt -= rowHit[(y - pr) * w + x]; } }
    }
    if (!valid.length) { laplaceFill(L.img, L.hole); continue; }
    // target patches: centres within pr of a hole pixel (clamped inside the image)
    const tgt: number[] = [];
    {
      const near = new Uint8Array(N);
      for (let i = 0; i < N; i++) if (L.hole[i]) { const x = i % w, y = (i / w) | 0; for (let dy = -pr; dy <= pr; dy++) for (let dx = -pr; dx <= pr; dx++) { const X = x + dx, Y = y + dy; if (X >= pr && Y >= pr && X < w - pr && Y < h - pr) near[Y * w + X] = 1; } }
      for (let i = 0; i < N; i++) if (near[i]) tgt.push(i);
    }
    const D = new Float32Array(N).fill(Infinity), NN = new Int32Array(N).fill(-1);
    const dist = (t: number, s: number, cap: number) => {
      const tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0;
      let sum = 0;
      for (let dy = -pr; dy <= pr; dy++) {
        const ro = (ty + dy) * w, so = (sy + dy) * w;
        for (let dx = -pr; dx <= pr; dx++) {
          const a = (ro + tx + dx) * 3, b = (so + sx + dx) * 3;
          const e0 = L.img.d[a] - L.img.d[b], e1 = L.img.d[a + 1] - L.img.d[b + 1], e2 = L.img.d[a + 2] - L.img.d[b + 2];
          sum += e0 * e0 + e1 * e1 + e2 * e2;
        }
        if (sum > cap) return sum;
      }
      return sum;
    };
    // initial field: the coarser level's (scaled) or random
    for (const t of tgt) {
      let s = -1;
      if (nnf && li < levels.length - 1) {
        const tx = t % w, ty = (t / w) | 0, j = Math.min(nnH - 1, ty >> 1) * nnW + Math.min(nnW - 1, tx >> 1), q = nnf[j];
        if (q >= 0) { const X = Math.min(w - 1 - pr, Math.max(pr, (q % nnW) * 2 + (tx & 1))), Y = Math.min(h - 1 - pr, Math.max(pr, ((q / nnW) | 0) * 2 + (ty & 1))); if (isValid[Y * w + X]) s = Y * w + X; }
      }
      if (s < 0) s = valid[Math.floor(rand() * valid.length)];
      NN[t] = s; D[t] = dist(t, s, Infinity);
    }
    const iters = o.iterations ?? (li === 0 ? 3 : 5);
    for (let em = 0; em < iters; em++) {
      // PatchMatch: propagation + random search, alternating scan direction
      for (let pass = 0; pass < 4; pass++) {
        const fwd = pass % 2 === 0, step = fwd ? 1 : -1;
        for (let k = fwd ? 0 : tgt.length - 1; fwd ? k < tgt.length : k >= 0; k += step) {
          const t = tgt[k], tx = t % w;
          // propagation from the left / up (right / down going backwards)
          for (const off of [step, step * w]) {
            const nb = t - off;
            if (nb < 0 || nb >= N || NN[nb] < 0) continue;
            if (off === step && Math.abs((nb % w) - tx) > 1) continue;
            const c = NN[nb] + off;
            if (c >= 0 && c < N && isValid[c] && c !== NN[t]) { const d2 = dist(t, c, D[t]); if (d2 < D[t]) { D[t] = d2; NN[t] = c; } }
          }
          // random search round the current match, radius halving
          let rad = Math.max(w, h);
          const cx = NN[t] % w, cy = (NN[t] / w) | 0;
          while (rad >= 1) {
            const X = Math.round(cx + (rand() * 2 - 1) * rad), Y = Math.round(cy + (rand() * 2 - 1) * rad);
            if (X >= 0 && Y >= 0 && X < w && Y < h) { const c = Y * w + X; if (isValid[c]) { const d2 = dist(t, c, D[t]); if (d2 < D[t]) { D[t] = d2; NN[t] = c; } } }
            rad = Math.floor(rad / 2);
          }
        }
      }
      // voting: each hole pixel = weighted mean of the source pixels of the patches over it
      const acc = new Float32Array(N * 3), wsum = new Float32Array(N);
      const sig = Math.max(1, median(tgt.map((t) => D[t])) / ((2 * pr + 1) ** 2));
      for (const t of tgt) {
        const s = NN[t];
        if (s < 0) continue;
        const tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0;
        const wt = Math.exp(-D[t] / ((2 * pr + 1) ** 2) / (2 * sig));
        for (let dy = -pr; dy <= pr; dy++) for (let dx = -pr; dx <= pr; dx++) {
          const i = (ty + dy) * w + tx + dx;
          if (!L.hole[i]) continue;
          const j = ((sy + dy) * w + sx + dx) * 3;
          acc[i * 3] += L.img.d[j] * wt; acc[i * 3 + 1] += L.img.d[j + 1] * wt; acc[i * 3 + 2] += L.img.d[j + 2] * wt;
          wsum[i] += wt;
        }
      }
      for (let i = 0; i < N; i++) if (L.hole[i] && wsum[i] > 0) for (let c = 0; c < 3; c++) L.img.d[i * 3 + c] = acc[i * 3 + c] / wsum[i];
      // distances change with the new colours
      for (const t of tgt) if (NN[t] >= 0) D[t] = dist(t, NN[t], Infinity);
    }
    nnf = NN; nnW = w; nnH = h;
  }
}
function median(a: number[]): number { if (!a.length) return 0; const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; }
