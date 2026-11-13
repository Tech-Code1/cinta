// Unit tests of the distorsion effects (fidelity with After Effects).
export default ({ test, ok, near, M, core }) => {
  const fx = (id) => { const f = M.FX.find((d) => d.id === id); ok(f, `existe ${id}`); return f; };
  const par = (id, p) => { const q = fx(id).params.find((x) => x.id === p); ok(q, `${id}.${p}`); return q; };
  const ids = (id) => fx(id).params.map((p) => p.id).join(',');
  const choices = (id, p) => par(id, p).choices.map((c) => c.id).join('|');

  test('distorsionar: Remolino, Abombar y Ondas como Twirl, Bulge y Ripple', () => {
    ok(ids('twirl') === 'angle,twirlRadius,center' && par('twirl', 'angle').def === 0, 'Remolino: ángulo 0, radio, centro');
    ok(par('twirl', 'twirlRadius').def === 30 && par('twirl', 'twirlRadius').max === 100, 'Remolino: radio 30 (0–100)');
    ok(ids('bulge') === 'hRadius,vRadius,center,height,taper,antialias,pin', ids('bulge'));
    ok(par('bulge', 'hRadius').def === 50 && par('bulge', 'vRadius').max === 8000 && par('bulge', 'height').def === 1 && par('bulge', 'height').min === -4 && par('bulge', 'taper').def === 0, 'Abombar: radios 50, altura 1 (−4…4), estrechamiento 0');
    ok(choices('bulge', 'antialias') === 'low|high' && par('bulge', 'pin').def === 0, 'Abombar: suavizado Bajo|Alto, sin fijar bordes');
    ok(ids('ripple') === 'rippleRadius,center,conversion,speed,wavelength,amplitude,phase', ids('ripple'));
    ok(par('ripple', 'rippleRadius').def === 0 && choices('ripple', 'conversion') === 'asymmetric|symmetric' && par('ripple', 'conversion').def === 'asymmetric', 'Ondas: radio 0, asimétrico');
    ok(par('ripple', 'speed').def === 1 && par('ripple', 'speed').min === -15 && par('ripple', 'wavelength').def === 20 && par('ripple', 'wavelength').min === 2 && par('ripple', 'amplitude').def === 20 && par('ripple', 'amplitude').max === 400, 'Ondas: velocidad 1 (±15), anchura 20 (2–100), altura 20 (0–400)');
  });
  test('distorsionar: Desplazamiento turbulento, Deformación de onda y Transformar', () => {
    ok(ids('turbulentDisplace') === 'kind,amount,size,offset,complexity,evolution,cycle,cycleRevs,seed,pinning,resize,antialias', ids('turbulentDisplace'));
    ok(par('turbulentDisplace', 'kind').choices.length === 9 && par('turbulentDisplace', 'kind').def === 'turbulent' && par('turbulentDisplace', 'pinning').choices.length === 15 && par('turbulentDisplace', 'pinning').def === 'all', 'Desplazamiento turbulento: 9 tipos (turbulento), 15 fijaciones (fijar todo)');
    ok(par('turbulentDisplace', 'amount').def === 50 && par('turbulentDisplace', 'amount').min === -10000 && par('turbulentDisplace', 'size').def === 100 && par('turbulentDisplace', 'size').max === 1000 && par('turbulentDisplace', 'complexity').def === 1 && par('turbulentDisplace', 'complexity').max === 10, 'Desplazamiento turbulento: cantidad 50, tamaño 100, complejidad 1');
    ok(ids('waveWarp') === 'type,height,width,direction,speed,pinning,phase,antialias', ids('waveWarp'));
    ok(par('waveWarp', 'type').choices.length === 9 && par('waveWarp', 'height').def === 10 && par('waveWarp', 'width').def === 40 && par('waveWarp', 'direction').def === 90 && par('waveWarp', 'speed').def === 1 && par('waveWarp', 'pinning').choices.length === 9 && par('waveWarp', 'pinning').def === 'none' && choices('waveWarp', 'antialias') === 'low|medium|high', 'Deformación de onda: seno, 10, 40, 90°, 1, sin fijar, suavizado bajo');
    ok(ids('transformFx') === 'anchor,position,uniform,scale,scaleWidth,skew,skewAxis,rotation,opacity,compShutter,shutterAngle,sampling', ids('transformFx'));
    ok(par('polar', 'conversion').def === 'polarToRect' && par('polar', 'interpolation').def === 0, 'Coordenadas polares: Polar a rectangular, 0 %');
    ok(par('displacementMap', 'fit').def === 'center' && par('displacementMap', 'hMax').max === 32000 && par('displacementMap', 'expand').def === 1, 'Mapa de desplazamiento: centrar mapa, ±32000, expandir salida');
    ok(par('spherize', 'radius').max === 2500 && par('spherize', 'radius').def === 0, 'Esferizar: radio 0 (0–2500)');
    ok(par('transformFx', 'uniform').def === 1 && par('transformFx', 'scale').max === 30000 && par('transformFx', 'skew').max === 70 && par('transformFx', 'compShutter').def === 1 && par('transformFx', 'shutterAngle').def === 0 && choices('transformFx', 'sampling') === 'bilinear|bicubic', 'Transformar: escala uniforme, ±30000, sesgo ±70, obturación de la composición, bilineal');
  });
  test('transiciones: Barrido lineal, radial, de iris, Persianas venecianas y Disolución en bloques', () => {
    ok(par('linearWipe', 'angle').def === 90 && par('linearWipe', 'feather').max === 32000, 'Barrido lineal: 90°, calado hasta 32000');
    ok(choices('radialWipe', 'wipe') === 'cw|ccw|both' && par('radialWipe', 'wipe').def === 'cw' && par('radialWipe', 'feather').max === 32000, 'Barrido radial: horario|antihorario|ambos');
    ok(ids('iris') === 'center,points,outerRadius,useInner,innerRadius,rotation,feather', ids('iris'));
    ok(par('iris', 'points').def === 6 && par('iris', 'points').min === 6 && par('iris', 'points').max === 32 && par('iris', 'outerRadius').def === 0 && par('iris', 'outerRadius').max === 2000 && par('iris', 'useInner').def === 0 && par('iris', 'feather').max === 1000, 'Barrido de iris: 6 puntos, radios 0–2000, calado 0–1000');
    ok(par('venetianBlinds', 'width').def === 20 && par('venetianBlinds', 'width').min === 1 && par('venetianBlinds', 'feather').max === 32000, 'Persianas venecianas: anchura 20');
    ok(ids('blockDissolve') === 'completion,blockWidth,blockHeight,feather,soft' && par('blockDissolve', 'blockWidth').def === 1 && par('blockDissolve', 'soft').def === 1, 'Disolución en bloques: bloques 1 × 1, bordes suaves');
  });
  test('efectos nuevos de distorsión, perspectiva y transición', () => {
    ok(ids('bevelAlpha') === 'thickness,lightAngle,lightColor,intensity' && par('bevelAlpha', 'thickness').def === 2 && par('bevelAlpha', 'thickness').max === 200 && par('bevelAlpha', 'lightAngle').def === -60 && par('bevelAlpha', 'intensity').def === 0.4 && fx('bevelAlpha').cat === 'Perspectiva', 'Bisel alfa: 2 (0–200), −60°, 0,4');
    ok(par('bevelEdges', 'thickness').def === 0.1 && par('bevelEdges', 'thickness').max === 0.5 && par('bevelEdges', 'lightColor').def === '#ffffff', 'Biselar bordes: 0,1 (0–0,5)');
    ok(ids('magnify') === 'shape,center,magnification,link,size,feather,opacity,scaling,blend,resize', ids('magnify'));
    ok(par('magnify', 'magnification').def === 150 && par('magnify', 'magnification').min === 100 && par('magnify', 'magnification').max === 20000 && par('magnify', 'size').def === 100 && par('magnify', 'size').max === 4000 && par('magnify', 'blend').def === 'normal' && par('magnify', 'blend').choices.length === 18 && choices('magnify', 'scaling') === 'standard|soft|scatter', 'Lupa: 150 %, tamaño 100, Normal');
    ok(par('warp', 'style').choices.length === 15 && par('warp', 'style').def === 'arc' && par('warp', 'bend').def === 50 && par('warp', 'hDistortion').min === -100 && choices('warp', 'axis') === 'horizontal|vertical', 'Deformar: 15 estilos (arco), curvar 50');
    ok(par('ccLens', 'size').def === 50 && par('ccLens', 'size').max === 500 && par('ccLens', 'convergence').def === 100 && par('ccLens', 'convergence').min === -200, 'CC Lens: 50, convergencia 100 (−200…100)');
    ok(par('ccSlant', 'slant').def === 0 && par('ccSlant', 'stretching').def === 1 && par('ccSlant', 'height').def === 100 && par('ccSlant', 'floor').def[1] === 1, 'CC Slant: 0, estirar, 100, suelo abajo');
    ok(par('ccTiler', 'scale').def === 100 && par('ccTiler', 'blend').def === 0, 'CC Tiler: 100 %');
    ok(ids('ccGridWipe') === 'completion,center,rotation,border,tiles,shape,reverse' && par('ccGridWipe', 'rotation').def === 45 && par('ccGridWipe', 'border').def === 75 && par('ccGridWipe', 'tiles').def === 10 && par('ccGridWipe', 'tiles').max === 25 && par('ccGridWipe', 'shape').def === 'radial', 'CC Grid Wipe: 45°, borde 75, 10 mosaicos, radial');
    ok(par('ccJaws', 'height').def === 10 && par('ccJaws', 'width').def === 10 && choices('ccJaws', 'shape') === 'spikes|roboJaw|block|waves', 'CC Jaws: 10 %, 10, picos');
    ok(par('ccLineSweep', 'direction').def === 180 && par('ccLineSweep', 'thickness').def === 50 && par('ccLineSweep', 'thickness').max === 1000 && par('ccLineSweep', 'slant').def === 50, 'CC Line Sweep: 180°, grosor 50, inclinación 50');
    ok(ids('ccRadialScaleWipe') === 'completion,center,reverse' && ids('ccScaleWipe') === 'stretch,center,direction' && par('ccScaleWipe', 'stretch').max === 100, 'CC Radial ScaleWipe y CC Scale Wipe');
  });
  test('ronda 2: perspectiva — Sombra radial, 3D básico, CC Cylinder y CC Sphere', () => {
    ok(ids('radialShadow') === 'color,opacity,light,distance,softness,render,influence,only,resize' && fx('radialShadow').cat === 'Perspectiva', ids('radialShadow'));
    ok(par('radialShadow', 'opacity').def === 50 && par('radialShadow', 'light').def[0] === 0.25 && par('radialShadow', 'distance').def === 10 && par('radialShadow', 'distance').max === 100 && par('radialShadow', 'influence').def === 100 && par('radialShadow', 'influence').max === 200 && choices('radialShadow', 'render') === 'regular|glass', 'Sombra radial: 50 %, luz 25 %, 10, normal, 100 % (0–200)');
    ok(ids('basic3d') === 'swivel,tilt,distance,specular,preview' && par('basic3d', 'distance').min === -30000 && par('basic3d', 'specular').def === 0, '3D básico');
    ok(par('ccCylinder', 'radius').def === 100 && par('ccCylinder', 'radius').max === 30000 && par('ccCylinder', 'posZ').min === -30000 && par('ccCylinder', 'rotOrder').def === 'yxz' && par('ccCylinder', 'lightHeight').def === 25 && par('ccCylinder', 'lightDirection').def === -45 && par('ccCylinder', 'ambient').def === 50 && par('ccCylinder', 'roughness').def === 0.04, 'CC Cylinder: 100 %, YXZ, luz 25 / −45°, ambiente 50, rugosidad 0,04');
    ok(par('ccSphere', 'radius').def === 200 && par('ccSphere', 'rotOrder').def === 'xyz' && par('ccSphere', 'lightHeight').def === 40 && par('ccSphere', 'lightDirection').def === -85 && par('ccSphere', 'ambient').def === 10 && par('ccSphere', 'diffuse').def === 100 && par('ccSphere', 'specular').def === 10 && par('ccSphere', 'roughness').def === 0.05 && choices('ccSphere', 'render') === 'full|outside|inside', 'CC Sphere: 200, XYZ, luz 40 / −85°, 10 / 100 / 10, 0,05');
  });
  test('ronda 2: distorsionar — CC Page Turn, Bender, Flo Motion, Griddler, Split, RepeTile, Smear y Compensación de óptica', () => {
    ok(par('ccPageTurn', 'controls').def === 'bottomRight' && par('ccPageTurn', 'foldPosition').def[0] === 0.75 && par('ccPageTurn', 'foldDirection').def === -60 && par('ccPageTurn', 'foldRadius').def === 50 && par('ccPageTurn', 'foldRadius').min === 4 && par('ccPageTurn', 'backOpacity').def === 85 && par('ccPageTurn', 'paperColor').def === '#c4c4b4', 'CC Page Turn: esquina inferior derecha, 75 %, −60°, radio 50, 85 %');
    ok(choices('ccBender', 'style') === 'bend|marilyn|sharp|boxer' && par('ccBender', 'amount').max === 250 && par('ccBender', 'top').def[1] === 0.25 && par('ccBender', 'base').def[1] === 0.75, 'CC Bender');
    ok(par('ccFloMotion', 'amount1').max === 1600 && par('ccFloMotion', 'tileEdges').def === 1 && par('ccFloMotion', 'antialias').def === 'medium' && par('ccFloMotion', 'falloff').def === 1, 'CC Flo Motion');
    ok(par('ccGriddler', 'tileSize').def === 10 && par('ccGriddler', 'tileSize').max === 200 && par('ccGriddler', 'hScale').min === -2000 && par('ccGriddler', 'cut').def === 1, 'CC Griddler');
    ok(par('ccSplit', 'split').max === 250 && par('ccSplit', 'a').def[0] === 0.25 && ids('ccSplit2') === 'a,b,split1,split2', 'CC Split / Split 2');
    ok(par('ccRepeTile', 'tiling').choices.length === 16 && par('ccRepeTile', 'right').max === 20000 && par('ccRepeTile', 'blend').def === 0, 'CC RepeTile: 16 mosaicos');
    ok(par('ccSmear', 'to').def[0] === 0.75 && par('ccSmear', 'reach').def === 100 && par('ccSmear', 'radius').def === 80 && par('ccSmear', 'radius').max === 4000, 'CC Smear');
    ok(ids('opticsComp') === 'fov,reverse,orientation,center,optimal,resize' && par('opticsComp', 'fov').max === 180 && choices('opticsComp', 'resize') === 'off|max2|max4|unlimited', 'Compensación de óptica');
    ok(par('liquify', 'distortion').max === 200, 'Licuar: porcentaje de distorsión 0–200');
  });
  test('ronda 2: transiciones — Barrido de tarjetas, CC Glass / Image / Light Wipe, Twister y WarpoMatic', () => {
    ok(par('cardWipe', 'completion').def === 25 && par('cardWipe', 'width').def === 50 && par('cardWipe', 'rows').def === 9 && par('cardWipe', 'columns').def === 12 && par('cardWipe', 'cardScale').def === 1 && par('cardWipe', 'flipOrder').choices.length === 9 && par('cardWipe', 'seed').def === 1 && par('cardWipe', 'zJitter').max === 25, 'Barrido de tarjetas: 25 %, 50 %, 9 × 12, escala 1');
    ok(par('ccGlassWipe', 'softness').def === 10 && par('ccGlassWipe', 'softness').min === 5 && par('ccGlassWipe', 'displacement').def === 25, 'CC Glass Wipe');
    ok(par('ccImageWipe', 'softness').def === 10 && par('ccImageWipe', 'property').def === 'luminance' && par('ccImageWipe', 'property').choices.length === 8, 'CC Image Wipe');
    ok(par('ccLightWipe', 'intensity').def === 100 && par('ccLightWipe', 'shape').def === 'round' && par('ccLightWipe', 'color').def === '#ffffff', 'CC Light Wipe');
    ok(par('ccTwister', 'axis').def === -120 && par('ccTwister', 'shading').def === 1, 'CC Twister');
    ok(par('ccWarpoMatic', 'smoothness').def === 50 && par('ccWarpoMatic', 'warpAmount').def === 25 && par('ccWarpoMatic', 'blendSpan').def === 75 && choices('ccWarpoMatic', 'warpDirection') === 'joint|opposing|twisting', 'CC WarpoMatic');
    for (const id of ['cardWipe', 'ccGlassWipe', 'ccImageWipe', 'ccLightWipe', 'ccTwister', 'ccWarpoMatic']) ok(fx(id).params[0].id === 'completion' && fx(id).cat === 'Transición', `${id}: completado primero`);
  });
  test('ronda 5: Barrido de tarjetas — Sistema de cámaras, Iluminación y Material como Card Wipe', () => {
    const cw = ids('cardWipe');
    ok(cw.includes('seed,cameraSystem,camRotX,camRotY,camRotZ,camXY,camZ,camFocal,transformOrder,pinUL,pinUR,pinLL,pinLR,autoFocal,pinFocal,lightType,lightIntensity,lightColor,lightPos,lightDepth,ambient,diffuse,specular,sharpness,xJitter'), cw);
    ok(choices('cardWipe', 'cameraSystem') === 'position|cornerPins|comp' && par('cardWipe', 'cameraSystem').def === 'position', 'Sistema de cámaras: posición de la cámara');
    ok(par('cardWipe', 'camZ').def === 2 && par('cardWipe', 'camZ').min === -1000 && par('cardWipe', 'camZ').max === 1000 && par('cardWipe', 'camFocal').def === 70 && par('cardWipe', 'camFocal').min === 10 && par('cardWipe', 'camFocal').max === 1000, 'Posición Z 2 (±1000), distancia focal 70 (10–1000)');
    ok(par('cardWipe', 'transformOrder').choices.length === 12 && par('cardWipe', 'transformOrder').def === 'rxyzPos' && par('cardWipe', 'camXY').def.join() === '0.5,0.5', 'Orden de transformación: girar XYZ, posición (de 12)');
    ok(par('cardWipe', 'pinUL').def.join() === '0,0' && par('cardWipe', 'pinLR').def.join() === '1,1' && par('cardWipe', 'autoFocal').def === 0 && par('cardWipe', 'pinFocal').def === 70, 'Posicionamientos de los bordes: las esquinas, distancia focal automática desactivada');
    ok(choices('cardWipe', 'lightType') === 'point|distant|comp' && par('cardWipe', 'lightType').def === 'distant' && par('cardWipe', 'lightIntensity').def === 1 && par('cardWipe', 'lightIntensity').max === 50, 'Luz: origen distante, intensidad 1 (0–50)');
    ok(par('cardWipe', 'lightDepth').def === 1 && par('cardWipe', 'lightDepth').min === -100 && par('cardWipe', 'ambient').def === 0.25 && par('cardWipe', 'ambient').max === 2, 'Profundidad 1 (±100), ambiente 0.25 (0–2)');
    ok(par('cardWipe', 'diffuse').def === 0.75 && par('cardWipe', 'specular').def === 0 && par('cardWipe', 'specular').max === 2 && par('cardWipe', 'sharpness').def === 10 && par('cardWipe', 'sharpness').max === 100, 'Material: difuso 0.75, especular 0, nitidez 10 (0–100)');
  });
  test('ronda 5: Gafas 3D, CC Blobbylize, Dar nueva forma, Alargar y Reparación de obturación despl.', () => {
    ok(ids('glasses3d') === 'left,right,convergence,vertical,units,swap,view,balance' && fx('glasses3d').cat === 'Perspectiva', ids('glasses3d'));
    ok(par('glasses3d', 'convergence').def === 0 && par('glasses3d', 'convergence').max === 32768 && par('glasses3d', 'vertical').min === -32768 && choices('glasses3d', 'units') === 'pixels|percent', 'Gafas 3D: convergencia y alineación 0 (±32768), píxeles');
    ok(par('glasses3d', 'view').choices.length === 9 && par('glasses3d', 'view').def === 'stereoPair' && par('glasses3d', 'balance').def === 8 && par('glasses3d', 'balance').max === 50 && par('glasses3d', 'swap').def === 0, 'Gafas 3D: par estéreo (de 9), equilibrio 8 (0–50)');
    ok(ids('ccBlobbylize') === 'blobLayer,property,softness,cutAway,using,lightIntensity,lightColor,lightType,lightHeight,lightPosition,lightDirection,ambient,diffuse,specular,roughness,metal', ids('ccBlobbylize'));
    ok(par('ccBlobbylize', 'property').def === 'lightness' && par('ccBlobbylize', 'property').choices.length === 6 && par('ccBlobbylize', 'softness').def === 20 && par('ccBlobbylize', 'softness').max === 500 && par('ccBlobbylize', 'cutAway').def === 25, 'CC Blobbylize: luminosidad, suavidad 20 (0–500), recortar 25');
    ok(par('ccBlobbylize', 'lightHeight').def === 65 && par('ccBlobbylize', 'lightDirection').def === -45 && par('ccBlobbylize', 'lightPosition').def.join() === '0.25,0.25' && par('ccBlobbylize', 'ambient').def === 75 && par('ccBlobbylize', 'diffuse').def === 25 && par('ccBlobbylize', 'specular').def === 100 && par('ccBlobbylize', 'roughness').def === 0.025, 'CC Blobbylize: luz y sombreado');
    ok(ids('reshape') === 'source,destination,boundary,percent,elasticity,points,interpolation' && par('reshape', 'percent').def === 0 && par('reshape', 'elasticity').choices.length === 9 && par('reshape', 'elasticity').def === 'stiff' && choices('reshape', 'interpolation') === 'discrete|linear|smooth' && par('reshape', 'interpolation').def === 'discrete', 'Dar nueva forma');
    ok(ids('smear') === 'source,boundary,offset,rotation,scale,percent,elasticity,interpolation' && par('smear', 'offset').def.join() === '0.55,0.5' && par('smear', 'scale').def === 1 && par('smear', 'scale').min === 0.1 && par('smear', 'scale').max === 2 && par('smear', 'interpolation').def === 'linear', 'Alargar: desplazamiento 55 % / 50 %, escala 1 (0.1–2), lineal');
    ok(ids('rollingShutter') === 'rate,scan,method,detailed,pixelDetail' && par('rollingShutter', 'rate').def === 50 && par('rollingShutter', 'rate').max === 100 && choices('rollingShutter', 'scan') === 'topBottom|bottomTop|leftRight|rightLeft' && choices('rollingShutter', 'method') === 'warp|pixelMotion' && par('rollingShutter', 'detailed').def === 0 && par('rollingShutter', 'pixelDetail').def === 20 && par('rollingShutter', 'pixelDetail').min === 5, 'Reparación de obturación despl.: 50, superior → inferior, deformar, detalle 20 (5–100)');
  });
};
