// Unit tests of the 3D model layers (src/core/motion/model3d.ts): Cinta's camera seen by three.js projects every
// point where Cinta's own projection puts it, light conversion, clip time, model files read without three.js.
import * as THREE from 'three';

export default ({ test, ok, near, M, core }) => {
  const comp = M.newComp({ width: 1280, height: 720, duration: 5 });
  const cinta = (c, t, p) => { const cam = M.cameraAt(c, t); const q = M.apply(cam.view, p[0], p[1], p[2]); return M.project(c.width, c.height, cam.zoom, q); };
  const viaThree = (c, t, p) => {
    const tc = M.threeCamera(c, t);
    const cam = new THREE.PerspectiveCamera();
    cam.matrixAutoUpdate = false;
    cam.matrix.fromArray(Array.from(tc.matrixWorld));
    cam.updateMatrixWorld(true);
    cam.projectionMatrix.fromArray(Array.from(tc.projection));
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(cam);
    return [(v.x + 1) * c.width / 2, (1 - v.y) * c.height / 2, v.z];
  };
  const pts = [[640, 360, 0], [100, 50, 300], [1200, 700, -400], [0, 720, 1500], [333, 444, -100]];

  test('modelos3d: cámara por defecto (50 mm): three.js proyecta igual que Cinta', () => {
    for (const p of pts) { const a = cinta(comp, 0, p), b = viaThree(comp, 0, p); ok(near(a[0], b[0], 1e-6) && near(a[1], b[1], 1e-6), `${p}: ${a} vs ${b}`); }
    const tc = M.threeCamera(comp, 0);
    ok(near(tc.fov, 2 * Math.atan(360 / M.defaultZoom(1280)) * 180 / Math.PI, 1e-9) && near(tc.aspect, 1280 / 720, 1e-12), `fov ${tc.fov}`);
  });

  test('modelos3d: cámara animada con punto de interés, zoom y rotación Z: misma proyección; profundidad = la de gl.ts', () => {
    const c = M.newComp({ width: 800, height: 600, duration: 5 });
    const cam = M.newLayer('camera', c, {});
    cam.camera.zoom = { v: 0, k: [{ t: 0, v: 500 }, { t: 2, v: 1400 }] };
    cam.camera.poi = { v: [300, 250, 100] };
    cam.transform.position = { v: [0, 0, 0], k: [{ t: 0, v: [-200, -300, -900] }, { t: 2, v: [900, 100, -500] }] };
    cam.transform.rotation = { v: 17 };
    c.layers.push(cam);
    for (const t of [0, 0.7, 2]) for (const p of pts) {
      const a = cinta(c, t, p), b = viaThree(c, t, p);
      if (a[2] < 1) continue;
      ok(near(a[0], b[0], 1e-5) && near(a[1], b[1], 1e-5), `t ${t} ${p}: ${a} vs ${b}`);
      // three's window depth (z in NDC → 0..1) is the depth the 3D-layer compositing writes for that distance
      ok(near((b[2] + 1) / 2, M.depthOfZ(a[2]), 1e-7) && near(M.zOfDepth(M.depthOfZ(a[2])), a[2], 1e-3 * a[2]), `profundidad ${b[2]} / ${a[2]}`);
    }
    const tp = M.threeProject(M.threeCamera(c, 1), 800, 600, [10, 20, 30]), cp = cinta(c, 1, [10, 20, 30]);
    ok(near(tp[0], cp[0], 1e-6) && near(tp[1], cp[1], 1e-6), 'threeProject');
  });

  test('modelos3d: base del modelo: y arriba / z hacia el espectador → píxeles de capa (giro de 180° en X, sin espejo)', () => {
    const b = M.modelBasis(100);
    const p = M.apply(b, 1, 2, 3);
    ok(p[0] === 100 && p[1] === -200 && p[2] === -300, String(p));
    const det = b[0] * (b[5] * b[10] - b[6] * b[9]);
    ok(det > 0, 'determinante positivo');
    ok(M.modelToLayer(150, [0.5, 0.5, 0.5]).join() === '75,-75,-75', 'modelToLayer');
  });

  test('modelos3d: luces → three.js (ambiente, paralela, foco con cono y calado, atenuación, sombras, entorno)', () => {
    const c = M.newComp({ width: 1000, height: 500, duration: 5 });
    const mk = (type, f) => { const l = M.newLayer('light', c, {}); l.light = M.newLightOptions(type, c); f?.(l); c.layers.push(l); return l; };
    mk('ambient', (l) => { l.light.intensity.v = 50; l.light.color.v = '#ff0000'; });
    mk('spot', (l) => { l.light.coneAngle.v = 60; l.light.coneFeather.v = 25; l.light.castsShadows = true; l.light.shadowDarkness.v = 40; l.light.falloff = 'smooth'; l.light.radius.v = 100; l.light.falloffDistance.v = 300; l.transform.position.v = [10, 20, -30]; l.light.poi.v = [500, 250, 0]; });
    mk('point', (l) => { l.light.falloff = 'inverseSquare'; l.light.radius.v = 200; });
    const env = mk('environment', (l) => { l.light.envLayer = 'imagen'; l.transform.rotationY.v = 90; });
    const L = M.sceneLights(c, 0);
    ok(L.length === 4, String(L.length));
    ok(L[0].type === 'ambient' && near(L[0].intensity, 0.5 * Math.PI, 1e-12) && L[0].color === '#ff0000', 'ambiente');
    const s = L[1];
    ok(near(s.angle, Math.PI / 6, 1e-12) && near(s.penumbra, 0.25, 1e-12) && s.castShadow && near(s.shadowDarkness, 0.4, 1e-12), 'foco');
    // three's spot cone: smoothstep(cos(angle), cos(angle·(1 − penumbra))) = Cinta's cosOuter / cosInner
    ok(near(Math.cos(s.angle * (1 - s.penumbra)), Math.cos((30 * Math.PI / 180) * (1 - 0.25)), 1e-12), 'cono interior');
    ok(s.pos.join() === '10,20,-30' && s.target.join() === '500,250,0' && s.distance === 400 && s.decay === 0, `foco ${s.pos} ${s.distance}`);
    ok(L[2].decay === 2 && near(L[2].intensity, Math.PI * 200 * 200, 1e-6) && L[2].distance === 0, 'cuadrado inverso: r² / d²');
    ok(L[3].type === 'environment' && L[3].envLayer === 'imagen' && L[3].envRotation === 90 && !L[3].castShadow, 'entorno');
    env.hidden = true;
    ok(M.sceneLights(c, 0).length === 3, 'luz oculta');
    const d = M.defaultLights(M.newComp({ width: 100, height: 100 }), 0);
    ok(d.length === 2 && d[0].type === 'ambient' && d[1].type === 'parallel', 'iluminación por defecto');
    const lin = M.linearRgb('#808080');
    ok(near(lin[0], 0.2158605, 1e-6), `sRGB → lineal ${lin}`);
  });

  test('modelos3d: tiempo del clip (velocidad, desplazamiento, bucle o retener, estiramiento, reasignación)', () => {
    const c = M.newComp({ width: 100, height: 100, duration: 10 });
    const l = M.newLayer('model', c, {});
    l.model = M.newModelOptions({ clips: [{ name: 'A', duration: 2 }], bbox: { min: [0, 0, 0], max: [1, 1, 1] } }, 100);
    l.start = 1;
    ok(l.threeD && l.model.clip === 'A' && l.model.unit === 50, JSON.stringify(l.model));
    ok(near(M.modelClipTime(c, l, 1.5, 2), 0.5) && near(M.modelClipTime(c, l, 3.5, 2), 0.5), 'bucle');
    l.model.speed.v = 2; l.model.offset.v = 0.25;
    ok(near(M.modelClipTime(c, l, 1.5, 2), 1.25), String(M.modelClipTime(c, l, 1.5, 2)));
    l.model.loop = false;
    ok(near(M.modelClipTime(c, l, 9, 2), 2) && near(M.modelClipTime(c, l, 0, 2), 0), 'retener');
    l.model.speed.v = 1; l.model.offset.v = 0; l.model.loop = true; l.stretch = 2;
    ok(near(M.modelClipTime(c, l, 2, 2), 0.5), 'estiramiento 200 %');
    l.timeRemap = { v: 0, k: [{ t: 0, v: 1.75 }, { t: 10, v: 1.75 }] };
    ok(near(M.modelClipTime(c, l, 6, 2), 1.75), 'reasignación de tiempo');
  });

  test('modelos3d: leer glTF (nodos con TRS, animaciones, archivos externos), GLB y OBJ / MTL sin three.js', () => {
    const j = {
      scene: 0, scenes: [{ nodes: [0] }],
      nodes: [{ translation: [10, 0, 0], scale: [2, 2, 2], children: [1] }, { mesh: 0, rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [{ count: 8, min: [-1, 0, 0], max: [1, 2, 0.5] }, { count: 36 }, { count: 3, max: [2.5] }],
      animations: [{ samplers: [{ input: 2 }] }],
      buffers: [{ uri: 'a%20b.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }], images: [{ uri: 'tex/c.png' }],
    };
    const info = M.gltfInfo(j, 'gltf');
    ok(info.meshes.join() === 'Malla_1' && info.clips[0].name === 'Animación_1' && info.clips[0].duration === 2.5 && info.triangles === 12 && info.vertices === 8, JSON.stringify(info));
    // the 90° turn about Y swaps x and z, then ×2 and +10 in x
    ok(info.bbox.min.map((v) => Math.round(v * 1e6) / 1e6).join() === '10,0,-2' && info.bbox.max.map((v) => Math.round(v * 1e6) / 1e6).join() === '11,4,2', JSON.stringify(info.bbox));
    ok(info.files.join() === 'a b.bin,tex/c.png', info.files.join());
    // GLB container
    const js = Buffer.from(JSON.stringify(j).padEnd(Math.ceil(JSON.stringify(j).length / 4) * 4, ' '));
    const glb = Buffer.alloc(20 + js.length); glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(js.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); js.copy(glb, 20);
    ok(M.gltfJson(new Uint8Array(glb)).nodes.length === 2, 'GLB');
    const o = M.objInfo('mtllib m.mtl\no A\nv 0 0 0\nv 1 2 3\nv -1 0 0\nusemtl Rojo\nf 1 2 3\ng B\nf 1 2 3 1\n');
    ok(o.meshes.join() === 'A,B' && o.materials.join() === 'Rojo' && o.triangles === 3 && o.files.join() === 'm.mtl' && o.bbox.max.join() === '1,2,3' && o.bbox.min.join() === '-1,0,0', JSON.stringify(o));
    ok(M.mtlTextures('newmtl a\nmap_Kd -s 1 1 1 tex/d.png\nbump b.jpg\n').join() === 'tex/d.png,b.jpg', 'texturas del MTL');
    ok(M.defaultModelUnit(o, 1080) === 180 && M.defaultModelUnit(undefined, 1080) === 100, String(M.defaultModelUnit(o, 1080)));
  });

  test('modelos3d: capa de modelo con deshacer: anclaje en el centro, escala que mantiene el sitio, sustituciones de material', () => {
    const e = new core.Editor();
    const c = M.motionOps.compNew(e, { name: 'M', width: 400, height: 300, duration: 2 });
    const info = { format: 'glb', meshes: ['Cubo'], clips: [{ name: 'Girar', duration: 1 }], materials: [], bbox: { min: [0, 0, 0], max: [2, 1, 1] }, vertices: 8, triangles: 12, files: [] };
    e.mutate('test', (p) => { p.media.push({ id: 'mod', path: 'C:/x/cubo.glb', kind: 'model', duration: 1, width: 0, height: 0, fps: 0, hasAudio: false, hasVideo: false, model: info }); });
    const l = M.motionOps.layerAdd(e, c.id, 'model', { mediaId: 'mod' });
    // half the comp height over the largest side (2 units) → 75 px per unit; anchor = box centre (1, 0.5, 0.5)
    ok(l.model.unit === 75 && l.transform.anchor.v.join() === '75,-37.5,-37.5' && l.material && l.threeD, JSON.stringify([l.model, l.transform.anchor.v]));
    M.motionOps.modelSet(e, c.id, l.id, { unit: 150, metalness: 80, emissive: '#ff0000' });
    let y = M.findLayer(M.findComp(e.project.comps, c.id), l.id);
    ok(y.transform.anchor.v.join() === '150,-75,-75' && y.model.metalness.v === 80 && y.model.emissive.v === '#ff0000' && y.model.emissiveIntensity.v === 100, JSON.stringify(y.model));
    let err = ''; try { M.motionOps.modelSet(e, c.id, l.id, { clip: 'Saltar' }); } catch (x) { err = x.message; }
    ok(/Girar/.test(err), err);
    M.motionOps.propSet(e, c.id, l.id, 'model.roughness', { keys: [{ t: 0, v: 10 }, { t: 1, v: 90 }] });
    const sum = M.compSummary(e.project, M.findComp(e.project.comps, c.id)).layers[0];
    ok(sum.model.clips[0].name === 'Girar' && sum.animated['model.roughness'] && sum.model.layerBox.min.join() === '0,-150,-150', JSON.stringify(sum.model));
    e.undo(); e.undo();
    y = M.findLayer(M.findComp(e.project.comps, c.id), l.id);
    ok(y.model.unit === 75 && !y.model.metalness, 'deshacer');
    err = ''; try { M.motionOps.layerAdd(e, c.id, 'model', {}); } catch (x) { err = x.message; }
    ok(/modelo 3D/.test(err), err);
  });
};
