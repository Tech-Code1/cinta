// Puppet tool (After Effects' Puppet Position pins): a mesh that follows the layer's opaque area is bent by pins.
// Each mesh vertex follows the pins with a rigid moving-least-squares deformation (Schaefer et al. 2006): the
// nearest pins weigh most and every neighbourhood only turns and moves, it is not sheared — like bending a sheet of
// rubber. Pure functions, shared by the renderer and the tests.

export interface PuppetMesh {
  /** rest vertices, layer px [x, y, …] */
  rest: Float64Array;
  /** triangles as vertex indices */
  tris: Uint32Array;
}

/**
 * Grid mesh over the opaque pixels of an alpha map: cells of `cell` px that have alpha within `expansion` px.
 * alpha: one byte per pixel of a w×h canvas whose top-left is layer point (ox, oy) at res canvas px per layer px.
 */
export function puppetMesh(alpha: Uint8ClampedArray | Uint8Array, w: number, h: number, ox: number, oy: number, res: number, cell: number, expansion: number, stride = 4, offset = 3): PuppetMesh {
  const step = Math.max(2, cell * res);
  const nx = Math.max(1, Math.ceil(w / step)), ny = Math.max(1, Math.ceil(h / step));
  // a cell is in when any pixel within it (grown by `expansion`) is opaque enough
  const grow = Math.max(0, expansion * res);
  const inCell = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x0 = Math.max(0, Math.floor(i * step - grow)), x1 = Math.min(w, Math.ceil((i + 1) * step + grow));
    const y0 = Math.max(0, Math.floor(j * step - grow)), y1 = Math.min(h, Math.ceil((j + 1) * step + grow));
    const sx = Math.max(1, Math.floor((x1 - x0) / 6)), sy = Math.max(1, Math.floor((y1 - y0) / 6));
    let hit = false;
    for (let y = y0; y < y1 && !hit; y += sy) for (let x = x0; x < x1; x += sx) if (alpha[(y * w + x) * stride + offset] > 8) { hit = true; break; }
    inCell[j * nx + i] = hit ? 1 : 0;
  }
  const index = new Int32Array((nx + 1) * (ny + 1)).fill(-1);
  const rest: number[] = [], tris: number[] = [];
  const vert = (i: number, j: number) => {
    const k = j * (nx + 1) + i;
    if (index[k] < 0) { index[k] = rest.length / 2; rest.push(ox + Math.min(w, i * step) / res, oy + Math.min(h, j * step) / res); }
    return index[k];
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!inCell[j * nx + i]) continue;
    const a = vert(i, j), b = vert(i + 1, j), c = vert(i + 1, j + 1), d = vert(i, j + 1);
    tris.push(a, b, c, a, c, d);
  }
  return { rest: Float64Array.from(rest), tris: Uint32Array.from(tris) };
}

/**
 * Distance from every pin to every mesh vertex measured ALONG the mesh (Dijkstra over the triangle edges), so a hand
 * hanging next to the hip is far from it: the arm is in between. Pins off the mesh use the nearest vertex.
 */
export function meshDistances(mesh: PuppetMesh, pins: ArrayLike<number>): Float64Array[] {
  const nv = mesh.rest.length / 2, r = mesh.rest;
  // adjacency (each grid edge once is enough; duplicates are harmless)
  const adj: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < mesh.tris.length; t += 3) for (let k = 0; k < 3; k++) { const a = mesh.tris[t + k], b = mesh.tris[t + ((k + 1) % 3)]; adj[a].push(b); adj[b].push(a); }
  const out: Float64Array[] = [];
  for (let p = 0; p < pins.length / 2; p++) {
    const px = pins[p * 2], py = pins[p * 2 + 1];
    let start = 0, best = Infinity;
    for (let v = 0; v < nv; v++) { const d = Math.hypot(r[v * 2] - px, r[v * 2 + 1] - py); if (d < best) { best = d; start = v; } }
    const dist = new Float64Array(nv).fill(Infinity);
    dist[start] = best;
    // binary heap of [distance, vertex]
    const heap: number[] = [best, start];
    const push = (d: number, v: number) => { heap.push(d, v); let i = heap.length / 2 - 1; while (i > 0) { const pa = (i - 1) >> 1; if (heap[pa * 2] <= heap[i * 2]) break; [heap[pa * 2], heap[i * 2]] = [heap[i * 2], heap[pa * 2]]; [heap[pa * 2 + 1], heap[i * 2 + 1]] = [heap[i * 2 + 1], heap[pa * 2 + 1]]; i = pa; } };
    const pop = (): [number, number] => {
      const top: [number, number] = [heap[0], heap[1]];
      const lastV = heap.pop()!, lastD = heap.pop()!; // the last pair, (d, v) taken from the end
      if (heap.length) { heap[0] = lastD; heap[1] = lastV; let i = 0; const n = heap.length / 2; for (;;) { const l = i * 2 + 1, rr = l + 1; let m = i; if (l < n && heap[l * 2] < heap[m * 2]) m = l; if (rr < n && heap[rr * 2] < heap[m * 2]) m = rr; if (m === i) break; [heap[m * 2], heap[i * 2]] = [heap[i * 2], heap[m * 2]]; [heap[m * 2 + 1], heap[i * 2 + 1]] = [heap[i * 2 + 1], heap[m * 2 + 1]]; i = m; } }
      return top;
    };
    while (heap.length) {
      const [d, v] = pop();
      if (d > dist[v]) continue;
      for (const u of adj[v]) { const nd = d + Math.hypot(r[u * 2] - r[v * 2], r[u * 2 + 1] - r[v * 2 + 1]); if (nd < dist[u]) { dist[u] = nd; push(nd, u); } }
    }
    out.push(dist);
  }
  return out;
}

/** Rigid MLS: where the point v goes when pins at `from` are moved to `to` (flat [x, y, …] arrays). `dist` gives the
 *  distance from each pin to v (along the mesh); without it, the straight distance. */
export function mlsRigid(vx: number, vy: number, from: ArrayLike<number>, to: ArrayLike<number>, dist?: ArrayLike<number>): [number, number] {
  const n = from.length / 2;
  if (!n) return [vx, vy];
  let sw = 0, px = 0, py = 0, qx = 0, qy = 0;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = from[i * 2] - vx, dy = from[i * 2 + 1] - vy, d2 = dist ? dist[i] * dist[i] : dx * dx + dy * dy;
    if (d2 < 1e-9) return [vx + to[i * 2] - from[i * 2], vy + to[i * 2 + 1] - from[i * 2 + 1]]; // on a pin
    // falls off with the 3rd power of the distance: each part follows its own pins
    w[i] = 1 / (d2 * Math.sqrt(d2));
    sw += w[i]; px += w[i] * from[i * 2]; py += w[i] * from[i * 2 + 1]; qx += w[i] * to[i * 2]; qy += w[i] * to[i * 2 + 1];
  }
  px /= sw; py /= sw; qx /= sw; qy /= sw;
  // best rotation as a complex number: Σ w q̂ · conj(p̂), normalised
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) {
    const ax = from[i * 2] - px, ay = from[i * 2 + 1] - py, bx = to[i * 2] - qx, by = to[i * 2 + 1] - qy;
    re += w[i] * (bx * ax + by * ay);
    im += w[i] * (by * ax - bx * ay);
  }
  const m = Math.hypot(re, im);
  const c = m > 1e-12 ? re / m : 1, s = m > 1e-12 ? im / m : 0;
  const dx = vx - px, dy = vy - py;
  return [c * dx - s * dy + qx, s * dx + c * dy + qy];
}

/** Deforms every rest vertex of a mesh (with distances along the mesh when given, see meshDistances). */
export function deformMesh(rest: Float64Array, from: ArrayLike<number>, to: ArrayLike<number>, dists?: Float64Array[]): Float64Array {
  const out = new Float64Array(rest.length), d = new Float64Array(from.length / 2);
  for (let i = 0; i < rest.length; i += 2) {
    if (dists) for (let p = 0; p < d.length; p++) d[p] = dists[p][i / 2];
    const [x, y] = mlsRigid(rest[i], rest[i + 1], from, to, dists ? d : undefined);
    out[i] = x; out[i + 1] = y;
  }
  return out;
}
