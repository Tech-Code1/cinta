// Unit tests of extruded 3D text and shapes (src/core/motion/extrude.ts): mesh counts, bevel offsets, depth, holes,
// winding agreeing with the normals, stroke rings, the geometry options and their editing with undo.
export default ({ test, ok, near, M, core }) => {
  const sq = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
  const tris = (m) => m.indices.length / 3;
  const surf = (m, s) => m.groups.find((g) => g.surface === s)?.count / 3 || 0;
  /** every triangle's winding agrees with its vertices' normals (lighting and culling right) */
  const windingOk = (m) => {
    const P = m.positions, N = m.normals, I = m.indices;
    for (let i = 0; i < I.length; i += 3) {
      const [a, b, c] = [I[i], I[i + 1], I[i + 2]];
      const u = [0, 1, 2].map((k) => P[b * 3 + k] - P[a * 3 + k]), v = [0, 1, 2].map((k) => P[c * 3 + k] - P[a * 3 + k]);
      const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const n = [0, 1, 2].map((k) => N[a * 3 + k] + N[b * 3 + k] + N[c * 3 + k]);
      const area = Math.hypot(...cr);
      if (area > 1e-6 && cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) return false;
    }
    return true;
  };
  /** the area of a surface's triangles projected on the layer plane */
  const capArea = (m, s) => {
    const g = m.groups.find((x) => x.surface === s);
    let A = 0;
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const [a, b, c] = [m.indices[i], m.indices[i + 1], m.indices[i + 2]];
      A += Math.abs((m.positions[b * 3] - m.positions[a * 3]) * (m.positions[c * 3 + 1] - m.positions[a * 3 + 1]) - (m.positions[c * 3] - m.positions[a * 3]) * (m.positions[b * 3 + 1] - m.positions[a * 3 + 1])) / 2;
    }
    return A;
  };

  test('extrusion: cuadrado extruido 50 px sin bisel: 12 triángulos, caras frontal (z 0) y posterior (z 50), normales coherentes', () => {
    const s = M.solidsFromRings([sq(0, 0, 100, 100)]);
    const m = M.extrude(s, { style: 'none', bevel: 0, hole: 1, depth: 50 });
    ok(tris(m) === 12, `triángulos ${tris(m)}`);
    ok(surf(m, 0) === 2 && surf(m, 3) === 2 && surf(m, 2) === 8 && surf(m, 1) === 0, JSON.stringify(m.groups));
    ok(near(m.bbox.min[2], 0) && near(m.bbox.max[2], 50) && near(m.bbox.max[0], 100), JSON.stringify(m.bbox));
    ok(windingOk(m), 'sentido de los triángulos');
    // the front normals face the camera (−z), the back ones away
    const g0 = m.groups.find((g) => g.surface === 0), v0 = m.indices[g0.start];
    ok(m.normals[v0 * 3 + 2] === -1, 'normal frontal');
  });

  test('extrusion: bisel angular 10 px: cara frontal reducida 10 px, bisel hasta z 10, lateral de 10 a 40', () => {
    const s = M.solidsFromRings([sq(0, 0, 100, 100)]);
    const m = M.extrude(s, { style: 'angular', bevel: 10, hole: 1, depth: 50 });
    ok(near(capArea(m, 0), 80 * 80, 1e-3), `área frontal ${capArea(m, 0)}`);
    const side = m.groups.find((g) => g.surface === 2);
    const zs = new Set(); for (let i = side.start; i < side.start + side.count; i++) zs.add(Math.round(m.positions[m.indices[i] * 3 + 2]));
    ok([...zs].sort((a, b) => a - b).join() === '10,40', `z laterales ${[...zs]}`);
    ok(surf(m, 1) === 2 * 4 * 2, `bisel ${surf(m, 1)}`);
    ok(windingOk(m), 'sentido');
    // a bevel normal leans out and to the front at 45°
    const b = m.groups.find((g) => g.surface === 1), vb = m.indices[b.start];
    ok(near(m.normals[vb * 3 + 2], -Math.SQRT1_2, 1e-3) || near(m.normals[vb * 3 + 2], Math.SQRT1_2, 1e-3), `normal ${m.normals.slice(vb * 3, vb * 3 + 3)}`);
  });

  test('extrusion: biseles convexo y cóncavo: 6 segmentos; profundidad del bisel limitada a la mitad de la extrusión', () => {
    const s = M.solidsFromRings([sq(0, 0, 100, 100)]);
    for (const style of ['convex', 'concave']) {
      const m = M.extrude(s, { style, bevel: 30, hole: 1, depth: 20 });
      ok(surf(m, 1) === 2 * 4 * 6 * 2, `${style}: ${surf(m, 1)}`);
      ok(surf(m, 2) === 0, `${style}: sin lateral (biseles de 10 + 10)`);
      ok(near(m.bbox.max[2], 20) && windingOk(m), style);
    }
    const p = M.bevelProfile('convex');
    ok(near(p[0].h, 1) && near(p[0].z, 0) && near(p.at(-1).h, 0) && near(p.at(-1).z, 1) && p[3].h < 0.5, JSON.stringify(p[3]));
  });

  test('extrusion: un agujero se conserva (anillo): área frontal = exterior − agujero; profundidad de bisel de hueco', () => {
    const outer = sq(0, 0, 100, 100), hole = sq(30, 30, 70, 70).reduce((a, _, i, r) => (i % 2 ? a : [r[i], r[i + 1], ...a]), []);
    const s = M.solidsFromRings([outer, hole]);
    ok(s.length === 1 && s[0].holes.length === 1, JSON.stringify(s));
    const m = M.extrude(s, { style: 'none', bevel: 0, hole: 1, depth: 10 });
    ok(near(capArea(m, 0), 100 * 100 - 40 * 40, 1e-3), `área ${capArea(m, 0)}`);
    ok(surf(m, 2) === 16 && windingOk(m), `lateral ${surf(m, 2)}`);
    // hole bevel 50 %: the hole grows by 5 px, the outline shrinks by 10
    const b = M.extrude(s, { style: 'angular', bevel: 10, hole: 0.5, depth: 30 });
    ok(near(capArea(b, 0), 80 * 80 - 50 * 50, 1e-3), `área con bisel ${capArea(b, 0)}`);
    // evenodd: the same contours turning the same way also make a hole
    const e = M.solidsFromRings([outer, sq(30, 30, 70, 70)], 'evenodd');
    ok(e.length === 1 && e[0].holes.length === 1, 'evenodd');
  });

  test('extrusion: contorno de un glifo con hueco («O» de dos contornos bezier) triangulado sin perder área', () => {
    const circle = (r, dir) => { const o = []; for (let k = 0; k < 64; k++) { const a = dir * k / 64 * Math.PI * 2; o.push(100 + Math.cos(a) * r, 100 + Math.sin(a) * r); } return o; };
    const s = M.solidsFromRings([circle(80, 1), circle(50, -1)]);
    const m = M.extrude(s, { style: 'convex', bevel: 4, hole: 1, depth: 20 });
    const want = Math.PI * (76 * 76 - 54 * 54);
    ok(Math.abs(capArea(m, 0) - want) / want < 0.01, `área ${capArea(m, 0)} ≈ ${want}`);
    ok(windingOk(m), 'sentido');
    ok(m.positions.length / 3 <= 128 * (2 + 4 + 7 * 2 * 2), `vértices ${m.positions.length / 3}`);
  });

  test('extrusion: trazo extruido como su anillo (rectángulo cerrado de trazo 10 → anillo con hueco)', () => {
    const r = M.strokeSolids(sq(0, 0, 100, 100), true, 10, 'miter');
    ok(r.length === 1 && r[0].holes.length === 1, JSON.stringify(r.map((x) => x.holes.length)));
    const A = Math.abs(M.ringArea(r[0].outer)) - Math.abs(M.ringArea(r[0].holes[0]));
    ok(near(A, 110 * 110 - 90 * 90, 1), `área ${A}`);
    const open = M.strokeSolids([0, 0, 100, 0], false, 10, 'round', 'round');
    ok(open.length === 1 && !open[0].holes.length && near(Math.abs(M.ringArea(open[0].outer)), 1000 + Math.PI * 25, 4), `abierto ${M.ringArea(open[0]?.outer ?? [])}`);
  });

  test('extrusion: opciones de geometría: valores de AE, plano con profundidad 0, geometry_set con deshacer, prop_set geometry.*', () => {
    const g = M.newGeometry();
    ok(g.bevelStyle === 'none' && g.bevelDepth.v === 2 && g.holeBevelDepth.v === 100 && g.extrusionDepth.v === 0, JSON.stringify(g));
    const comp = M.newComp({ width: 640, height: 360 });
    const l = M.newLayer('text', comp, {});
    comp.layers.push(l);
    l.geometry = M.newGeometry();
    ok(!M.geometryAt(comp, l, 0), 'plano: profundidad 0 sin bisel');
    l.threeD = true;
    ok(!M.geometryAt(comp, l, 0), 'plano también en 3D');
    l.geometry.extrusionDepth = { v: 0, k: [{ t: 0, v: 0 }, { t: 1, v: 100 }] };
    ok(!M.geometryAt(comp, l, 0) && near(M.geometryAt(comp, l, 0.5).depth, 50) && M.mayExtrude(l), 'animada');
    l.threeD = false;
    ok(!M.geometryAt(comp, l, 0.5), 'una capa 2D no se extruye');
    l.threeD = true; l.geometry.bevelStyle = 'angular'; l.geometry.extrusionDepth = { v: 0 };
    ok(M.geometryAt(comp, l, 0)?.bevel === 2, 'solo bisel');
    ok(M.autoSurfaceColor(l, 'sideColor') === String(l.text.fill.v), 'lateral = relleno sin trazo');
    l.text.strokeWidth.v = 3; l.text.stroke.v = '#ff0000';
    ok(M.autoSurfaceColor(l, 'sideColor') === '#ff0000' && M.autoSurfaceColor(l, 'frontColor') === String(l.text.fill.v), 'lateral = trazo');
    // editing through the Editor with undo
    const e = new core.Editor(core.newProject());
    (e.project.comps ??= []).push(comp);
    M.motionOps.geometrySet(e, comp.id, l.id, { bevelStyle: 'convex', bevelDepth: 5, extrusionDepth: 80, holeBevelDepth: 0, sideColor: '#00ff00' });
    const L = () => e.project.comps.find((x) => x.id === comp.id).layers[0];
    ok(L().geometry.bevelStyle === 'convex' && L().geometry.extrusionDepth.v === 80 && L().geometry.holeBevelDepth.v === 1 && L().material.sideColor.v === '#00ff00', JSON.stringify(L().geometry));
    M.motionOps.propSet(e, comp.id, l.id, 'geometry.extrusionDepth', { value: 120 });
    ok(L().geometry.extrusionDepth.v === 120, 'prop_set');
    M.motionOps.propSet(e, comp.id, l.id, 'material.bevelColor', { value: '#0000ff' });
    ok(L().material.bevelColor.v === '#0000ff', 'color de bisel');
    e.undo(); e.undo(); e.undo();
    ok(L().geometry.bevelStyle === 'angular' && !L().material?.sideColor, 'deshacer');
  });
};
