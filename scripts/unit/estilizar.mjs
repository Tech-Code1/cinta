// Unit tests of the estilizar effects (fidelity with After Effects).
export default ({ test, ok, near, M, core }) => {
  const fx = (id) => M.FX.find((f) => f.id === id);
  const def = (id, p) => fx(id).params.find((q) => q.id === p);
  const ids = (id) => fx(id).params.map((p) => p.id).join(',');
  const choices = (id, p) => def(id, p).choices.map((c) => c.id).join(',');

  test('estilizar: Mosaico, Detectar bordes, Relieve y Mosaico de movimiento', () => {
    // Mosaic: 10 × 10 blocks (valid 1–4000), Sharp Colors off
    ok(ids('mosaic') === 'h,v,sharp' && def('mosaic', 'h').def === 10 && def('mosaic', 'v').def === 10 && def('mosaic', 'h').max === 4000 && def('mosaic', 'sharp').def === 0, `Mosaico: ${ids('mosaic')}`);
    // Find_Edges: Invert off, Blend With Original 0 %
    ok(ids('findEdges') === 'invert,blend' && def('findEdges', 'invert').def === 0 && def('findEdges', 'blend').def === 0, 'Detectar bordes');
    // Emboss: Direction 45°, Relief 1 (0–10), Contrast 100 (0–32767), Blend 0 %
    ok(ids('emboss') === 'direction,relief,contrast,blend' && def('emboss', 'direction').def === 45 && def('emboss', 'relief').def === 1 && def('emboss', 'relief').min === 0 && def('emboss', 'contrast').def === 100 && def('emboss', 'contrast').max === 32767, `Relieve: ${ids('emboss')}`);
    // Tile: centre, tile 100 % (0–100), output 100 % (0–30000), Mirror Edges, Phase 0°, Horizontal Phase Shift
    ok(ids('motionTile') === 'center,width,height,outW,outH,mirror,phase,hShift' && def('motionTile', 'width').min === 0 && def('motionTile', 'outW').def === 100 && def('motionTile', 'outW').max === 30000 && def('motionTile', 'phase').def === 0 && def('motionTile', 'hShift').def === 0, `Mosaico de movimiento: ${ids('motionTile')}`);
  });

  test('efectos nuevos de After Effects: parámetros, valores por defecto y rangos', () => {
    ok(ids('colorEmboss') === ids('emboss') && def('colorEmboss', 'relief').def === 1 && def('colorEmboss', 'contrast').def === 100, 'Relieve de color = Relieve');
    ok(ids('scatter') === 'amount,grain,randomize' && def('scatter', 'amount').def === 0 && def('scatter', 'amount').max === 1000 && choices('scatter', 'grain') === 'both,h,v', 'Dispersar');
    ok(def('strobeLight', 'duration').def === 0.5 && def('strobeLight', 'period').def === 1 && def('strobeLight', 'period').max === 32000 && def('strobeLight', 'operator').choices.length === 13 && def('strobeLight', 'operator').def === 'copy' && def('strobeLight', 'strobe').def === 'color' && def('strobeLight', 'color').def === '#ffffff', 'Luz estroboscópica');
    ok(def('brushStrokes', 'angle').def === 135 && def('brushStrokes', 'brushSize').def === 2 && def('brushStrokes', 'brushSize').max === 5 && def('brushStrokes', 'length').def === 5 && def('brushStrokes', 'length').max === 40 && def('brushStrokes', 'density').max === 2 && def('brushStrokes', 'surface').choices.length === 4, 'Pinceladas');
    ok(ids('texturize') === 'texture,light,contrast,placement' && def('texturize', 'light').def === 135 && def('texturize', 'contrast').def === 1 && def('texturize', 'placement').def === 'tile', 'Texturizar');
    ok(def('roughenEdges', 'type').choices.length === 8 && def('roughenEdges', 'edgeColor').def === '#993300' && def('roughenEdges', 'border').def === 8 && def('roughenEdges', 'border').max === 500 && def('roughenEdges', 'scale').def === 100 && def('roughenEdges', 'scale').min === 10 && def('roughenEdges', 'complexity').def === 2, 'Bordes irregulares');
    ok(def('ccKaleida', 'size').def === 20 && def('ccKaleida', 'mirroring').choices.length === 9 && def('ccKaleida', 'mirroring').def === 'flower', 'CC Kaleida');
    ok(def('ccHexTile', 'radius').def === 50 && def('ccHexTile', 'radius').min === 3 && def('ccHexTile', 'render').def === 'tile' && def('ccHexTile', 'smearing').min === -100, 'CC HexTile');
    ok(def('ellipse', 'width').def === 50 && def('ellipse', 'width').max === 2000 && def('ellipse', 'thickness').def === 8 && def('ellipse', 'softness').def === 50 && def('ellipse', 'inside').def === '#ffbefa' && def('ellipse', 'outside').def === '#ff1919', 'Elipse');
    ok(def('eyedropperFill', 'radius').def === 10 && def('eyedropperFill', 'radius').min === 0.5 && def('eyedropperFill', 'radius').max === 200 && def('eyedropperFill', 'average').def === 'skipEmpty', 'Relleno de cuentagotas');
    ok(def('ccLightBurst', 'intensity').def === 100 && def('ccLightBurst', 'rayLength').def === 50 && def('ccLightBurst', 'burst').def === 'fade' && def('ccLightBurst', 'color').def === '#ffe640', 'CC Light Burst 2.5');
    ok(near(def('ccLightSweep', 'center').def[1], 0.25) && def('ccLightSweep', 'direction').def === -30 && def('ccLightSweep', 'shape').def === 'sharp' && def('ccLightSweep', 'width').def === 50 && def('ccLightSweep', 'sweepIntensity').def === 25 && def('ccLightSweep', 'edgeIntensity').def === 50 && def('ccLightSweep', 'edgeThickness').def === 4 && def('ccLightSweep', 'reception').def === 'add', 'CC Light Sweep');
    ok(def('ccStarBurst', 'scatter').def === 100 && def('ccStarBurst', 'speed').def === 1 && def('ccStarBurst', 'spacing').def === 4 && def('ccStarBurst', 'size').def === 100 && def('ccStarBurst', 'size').min === 20, 'CC Star Burst');
  });

  test('generar: Rampa de degradado, Cuadrícula, Tablero de ajedrez y Círculo', () => {
    // Ramp: start (50 %, 0) black, end (50 %, 100 %) white, Linear, scatter 0 (0–512), blend 0, Swap Colors
    ok(ids('gradientRamp') === 'start,startColor,end,endColor,type,scatter,blend,swap' && def('gradientRamp', 'startColor').def === '#000000' && def('gradientRamp', 'endColor').def === '#ffffff' && def('gradientRamp', 'type').def === 'linear' && def('gradientRamp', 'scatter').max === 512, `Rampa: ${ids('gradientRamp')}`);
    ok(near(def('gradientRamp', 'start').def[0], 0.5) && def('gradientRamp', 'start').def[1] === 0 && def('gradientRamp', 'end').def[1] === 1, 'Rampa: puntos');
    // 19 generator blending modes (None … Luminosity), default None
    const bm = 'none,normal,stencilAlpha,add,multiply,screen,overlay,softLight,hardLight,colorDodge,colorBurn,darken,lighten,difference,exclusion,hue,saturation,color,luminosity';
    for (const f of ['grid', 'checkerboard', 'circle']) ok(choices(f, 'blendMode') === bm && def(f, 'blendMode').def === 'none' && def(f, 'opacity').def === 100 && def(f, 'color').def === '#ffffff', `${f}: modo de fusión, opacidad, color`);
    // Grid: Corner Point (60 %), width 32, height 24 (1–4000), border 5 (0–2000), feather 0 (0–400)
    ok(def('grid', 'sizeFrom').def === 'corner' && choices('grid', 'sizeFrom') === 'corner,width,widthHeight' && near(def('grid', 'corner').def[0], 0.6) && def('grid', 'size').def === 32 && def('grid', 'height').def === 24 && def('grid', 'size').max === 4000 && def('grid', 'width').def === 5 && def('grid', 'width').max === 2000 && def('grid', 'featherW').max === 400 && def('grid', 'invert').def === 0, 'Cuadrícula');
    // Checkerboard: Width Slider (corner 58 %), width 16, height 8
    ok(def('checkerboard', 'sizeFrom').def === 'width' && near(def('checkerboard', 'corner').def[0], 0.58) && def('checkerboard', 'size').def === 16 && def('checkerboard', 'height').def === 8, 'Tablero de ajedrez');
    // Circle: radius 75 (±10000), Edge None (5 choices), 10, feathers 0
    // Lens_Flare: centre 40 %, brightness 100 (0–300), 3 lens types (50-300mm Zoom), blend 0
    ok(ids('lensFlare') === 'center,brightness,lensType,blend' && near(def('lensFlare', 'center').def[0], 0.4) && def('lensFlare', 'brightness').def === 100 && def('lensFlare', 'brightness').max === 300 && choices('lensFlare', 'lensType') === 'zoom,prime35,prime105', 'Destello de lente');
    // Echo: −1/30 s, 1 echo, intensity 1, decay 1 (0–100), 7 operators (Add)
    ok(near(def('echo', 'time').def, -1 / 30) && def('echo', 'count').def === 1 && def('echo', 'start').def === 1 && def('echo', 'decay').def === 1 && def('echo', 'decay').max === 100 && choices('echo', 'op') === 'add,max,min,screen,composite,front,blend' && def('echo', 'op').def === 'add', 'Eco');
    // CC Vignette (Vignette): Amount 100 (±1000), Angle of View 45 (0–120), Center, Pin Highlights 0
    ok(ids('vignette') === 'amount,angleOfView,center,pinHighlights' && def('vignette', 'amount').def === 100 && def('vignette', 'amount').min === -1000 && def('vignette', 'angleOfView').def === 45 && def('vignette', 'angleOfView').max === 120 && def('vignette', 'pinHighlights').def === 0, 'CC Vignette');
    // Posterize_Time 24 fps (0.01–999); Time_Displace 1 s (±3600), 60 fps, stretch on; CC Wide Time 1 / 1 (0–126);
    // CC Time Blend 17 transfer modes (Blend), accumulation 0.75, clear to Transparent
    ok(def('posterizeTime', 'fps').def === 24 && def('posterizeTime', 'fps').min === 0.01 && def('posterizeTime', 'fps').max === 999, 'Posterizar tiempo');
    ok(def('timeDisplacement', 'maxTime').def === 1 && def('timeDisplacement', 'maxTime').max === 3600 && def('timeDisplacement', 'resolution').def === 60 && def('timeDisplacement', 'stretch').def === 1, 'Desplazamiento de tiempo');
    ok(def('wideTime', 'forward').def === 1 && def('wideTime', 'backward').def === 1 && def('wideTime', 'forward').max === 126 && def('wideTime', 'nativeBlur').def === 0, 'CC Wide Time');
    ok(def('timeBlend', 'mode').choices.length === 17 && def('timeBlend', 'mode').def === 'blend' && def('timeBlend', 'accumulation').def === 0.75 && def('timeBlend', 'clearTo').def === 'transparent', 'CC Time Blend');
    // CellPattern: 12 patterns, Bubbles, contrast 100, Clip, disperse 1 (0–1.5), size 60 (2–2000), 4 × 4 tiles, seed 0
    ok(def('cellPattern', 'type').choices.length === 12 && def('cellPattern', 'type').def === 'bubbles' && def('cellPattern', 'contrast').max === 10000 && def('cellPattern', 'overflow').def === 'clip' && def('cellPattern', 'disperse').def === 1 && def('cellPattern', 'disperse').max === 1.5 && def('cellPattern', 'size').def === 60 && def('cellPattern', 'size').min === 2 && def('cellPattern', 'cellsH').def === 4 && def('cellPattern', 'seed').def === 0 && def('cellPattern', 'cycleRevs').max === 88, 'Patrón de celdas');
    // FractalNoise: 17 fractal types (Basic), Soft Linear, Allow HDR, scale 100, complexity 6 (1–20), 70 % / 56 %, Normal
    ok(def('fractalNoise', 'type').choices.length === 17 && def('fractalNoise', 'type').def === 'basic' && def('fractalNoise', 'noiseType').def === 'soft' && def('fractalNoise', 'overflow').def === 'hdr' && def('fractalNoise', 'scale').def === 100 && def('fractalNoise', 'uniform').def === 1 && def('fractalNoise', 'complexity').def === 6 && def('fractalNoise', 'complexity').max === 20 && def('fractalNoise', 'subInfluence').def === 70 && def('fractalNoise', 'subScaling').def === 56 && def('fractalNoise', 'blendMode').def === 'normal' && def('fractalNoise', 'blendMode').choices.length === 17 && def('fractalNoise', 'seed').def === 0, 'Ruido fractal');
    // CC Light Rays: intensity 100, centre 25 %, radius 40, warp softness 50, Round, colour from source, Add
    ok(ids('lightRays') === 'intensity,center,radius,warpSoftness,shape,direction,colorFromSource,allowBrightening,color,transfer' && def('lightRays', 'intensity').def === 100 && near(def('lightRays', 'center').def[0], 0.25) && def('lightRays', 'radius').def === 40 && def('lightRays', 'warpSoftness').def === 50 && def('lightRays', 'colorFromSource').def === 1 && def('lightRays', 'transfer').def === 'add' && choices('lightRays', 'transfer') === 'none,add,lighten,screen', 'CC Light Rays');
    // Audio Spectrum / Waveform
    ok(def('audioSpectrum', 'maxHeight').def === 480 && def('audioSpectrum', 'endFreq').max === 22050 && def('audioSpectrum', 'insideColor').def === '#ff00ff' && def('audioSpectrum', 'outsideColor').def === '#ff3296' && choices('audioSpectrum', 'side') === 'a,b,both' && def('audioSpectrum', 'side').def === 'both', 'Espectro de audio');
    ok(def('audioWaveform', 'samples').def === 120 && def('audioWaveform', 'maxHeight').def === 120 && def('audioWaveform', 'duration').def === 125 && def('audioWaveform', 'thickness').def === 3 && choices('audioWaveform', 'display') === 'digital,lines,dots' && def('audioWaveform', 'display').def === 'lines', 'Forma de onda de audio');
    ok(def('circle', 'radius').def === 75 && def('circle', 'radius').min === -10000 && choices('circle', 'edge') === 'none,edgeRadius,thickness,thicknessRadius,thicknessFeather' && def('circle', 'thickness').def === 10 && def('circle', 'feather').def === 0 && def('circle', 'featherInner').def === 0 && def('circle', 'invert').def === 0, 'Círculo');
  });

  test('simulación (ronda 2): Estallido, Card Dance, Cáusticas, Mundo de olas, Espuma y CC Particle World', () => {
    // Shatter: View «Wireframe + Forces», repetitions 10 (1–200), extrusion 0.2 (0–10), force 1 r 0.4 (0–5) s 5 (±50),
    // force 2 at (75 %, 50 %) with radius 0, gravity 3 (0–100), 8 tumble axes
    ok(def('shatter', 'view').def === 'wireForces' && def('shatter', 'view').choices.length === 5 && def('shatter', 'repetitions').max === 200 && def('shatter', 'depth').max === 10 && def('shatter', 'radius').max === 5 && def('shatter', 'strength').min === -50 && near(def('shatter', 'force2').def[0], 0.75) && def('shatter', 'force2Radius').def === 0 && def('shatter', 'gravity').max === 100 && def('shatter', 'tumble').choices.length === 8, 'Estallido');
    // Card Dance: Independent, 9 × 12, 19 sources, multipliers 1 (rotation 90°), scale offset 1
    ok(def('cardDance', 'rowsColumns').def === 'independent' && def('cardDance', 'rows').def === 9 && def('cardDance', 'columns').def === 12 && def('cardDance', 'xPosSrc').choices.length === 19 && def('cardDance', 'xPosMul').def === 1 && def('cardDance', 'xRotMul').def === 90 && def('cardDance', 'xRotMul').max === 1800 && def('cardDance', 'xScaleOff').def === 1 && def('cardDance', 'focal').min === 10, 'Card Dance');
    // Caustics: wave height 0.2 (0–1), smoothing 5 (1–50), refraction 1.2 (1–2), surface #007fff, strength 0–5; light
    // 1 (0–50) distant, ambient 0.25, diffuse 0.75, specular 0.1, sharpness 10 (0–100)
    ok(def('caustics', 'waveHeight').min === 0 && def('caustics', 'smoothing').min === 1 && def('caustics', 'smoothing').max === 50 && def('caustics', 'refraction').max === 2 && def('caustics', 'surfaceColor').def === '#007fff' && def('caustics', 'causticsStrength').max === 5 && def('caustics', 'lightType').def === 'distant' && def('caustics', 'lightIntensity').max === 50 && def('caustics', 'ambient').def === 0.25 && def('caustics', 'diffuse').def === 0.75 && def('caustics', 'specular').def === 0.1 && def('caustics', 'highlightSharpness').def === 10, 'Cáusticas');
    // Wave World: Wireframe Preview, 12° / 20°, brightness 0.5 (±5), contrast 0.25, grid 40 (10–1000), speed 0.5,
    // damping 0.01, 16 edge choices, producer 2 0.5 × 0.5
    ok(def('waveWorld', 'view').def === 'wireframe' && def('waveWorld', 'hRotation').def === 12 && def('waveWorld', 'vRotation').def === 20 && def('waveWorld', 'brightness').def === 0.5 && def('waveWorld', 'brightness').max === 5 && def('waveWorld', 'contrast').def === 0.25 && def('waveWorld', 'gridResolution').def === 40 && def('waveWorld', 'gridResolution').max === 1000 && def('waveWorld', 'waveSpeed').def === 0.5 && def('waveWorld', 'damping').def === 0.01 && def('waveWorld', 'reflect').choices.length === 16 && def('waveWorld', 'p2Width').def === 0.5 && def('waveWorld', 'p1Amplitude').max === 5, 'Mundo de olas');
    // Foam: Draft, producer 0.03 (0–0.45), rate 0–100, turbulence 0–2, wobble 0–0.4, 17 textures, seed 1 (0–16)
    ok(def('foam', 'view').def === 'draft' && def('foam', 'view').choices.length === 3 && def('foam', 'producerX').def === 0.03 && def('foam', 'producerX').max === 0.45 && def('foam', 'rate').max === 100 && def('foam', 'turbulence').max === 2 && def('foam', 'wobble').max === 0.4 && def('foam', 'texture').choices.length === 17 && def('foam', 'seed').max === 16, 'Espuma');
    // PW: birth rate 2 (0–30000), extra 0.5, sizes 0.25, size variation 50 %, colours #ffff50 → #c82828, Composite,
    // camera distance 1, FOV 45 (0–160)
    ok(def('particleWorld', 'birthRate').def === 2 && def('particleWorld', 'birthRate').max === 30000 && def('particleWorld', 'extra').def === 0.5 && def('particleWorld', 'birthSize').def === 0.25 && def('particleWorld', 'sizeVariation').def === 50 && def('particleWorld', 'birthColor').def === '#ffff50' && def('particleWorld', 'deathColor').def === '#c82828' && def('particleWorld', 'transfer').def === 'composite' && def('particleWorld', 'distance').def === 1 && def('particleWorld', 'fov').def === 45 && def('particleWorld', 'animation').choices.length === 11, 'CC Particle World');
  });

  test('generar (ronda 2): Ondas de radio, Vegas, Trazo, Escritura y Haz', () => {
    // Radio_Waves: sides 64 (3–128), star depth −0.5 (−1…10), frequency 0–500, expansion 0–1000, 7 profiles (Bell),
    // fade-out 5, widths 1–100, value channel Alpha
    ok(def('radioWaves', 'sides').max === 128 && def('radioWaves', 'starDepth').def === -0.5 && def('radioWaves', 'starDepth').max === 10 && def('radioWaves', 'frequency').max === 500 && def('radioWaves', 'expansion').max === 1000 && choices('radioWaves', 'profile') === 'square,triangle,sawOut,sawIn,gaussian,bell,sine' && def('radioWaves', 'fadeOut').def === 5 && def('radioWaves', 'startWidth').min === 1 && def('radioWaves', 'valueChannel').def === 'alpha' && choices('radioWaves', 'waveType') === 'polygon,contours,mask', 'Ondas de radio');
    // Vegas: 9 channels, segments 32 (1–250), length 1, Even, seed 1 (1–1000), Over, width 2 (0.5–100), hardness 0,
    // opacities 1 / 0 (−1…1) / 0
    ok(def('vegas', 'channel').choices.length === 9 && def('vegas', 'segments').max === 250 && def('vegas', 'length').def === 1 && def('vegas', 'distribution').def === 'even' && def('vegas', 'seed').min === 1 && choices('vegas', 'blend') === 'transparent,over,under,stencil' && def('vegas', 'blend').def === 'over' && def('vegas', 'width').min === 0.5 && def('vegas', 'hardness').def === 0 && def('vegas', 'midOpacity').def === 0 && def('vegas', 'midOpacity').min === -1 && def('vegas', 'endOpacity').def === 0, 'Vegas');
    // Stroke / Write-on: hardness valid 0–95 %; Write-on spacing up to 3000 s; Beam thickness 0–4000
    ok(def('stroke', 'hardness').max === 95 && def('writeOn', 'hardness').max === 95 && def('writeOn', 'spacing').max === 3000 && def('beam', 'startThickness').max === 4000, 'Trazo, Escritura y Haz');
  });

  test('efectos nuevos de la ronda 2: CycoreFX, Rayo avanzado, Código de tiempo, Números, Cubo de pintura y Caricatura', () => {
    // Rainfall / Snowfall
    ok(def('ccRainfall', 'drops').def === 5000 && def('ccRainfall', 'drops').max === 2000000 && def('ccRainfall', 'speed').def === 4000 && def('ccRainfall', 'spread').def === 6 && def('ccRainfall', 'opacity').def === 25 && def('ccRainfall', 'spreadHeight').def === 15 && def('ccRainfall', 'transfer').def === 'lighten' && def('ccRainfall', 'appearance').def === 'softSolid' && def('ccRainfall', 'composite').def === 1, 'CC Rainfall');
    ok(def('ccSnowfall', 'flakes').def === 10000 && def('ccSnowfall', 'speed').def === 250 && def('ccSnowfall', 'speed').max === 2000 && def('ccSnowfall', 'spread').def === 15 && def('ccSnowfall', 'wiggle').def === 20 && def('ccSnowfall', 'frequencyVariation').def === 75 && def('ccSnowfall', 'opacity').def === 50 && def('ccSnowfall', 'spreadHeight').def === 50, 'CC Snowfall');
    // Lightning2
    ok(def('advancedLightning', 'type').choices.length === 8 && near(def('advancedLightning', 'origin').def[0], 0.45) && near(def('advancedLightning', 'direction').def[1], 0.95) && def('advancedLightning', 'conductivity').max === 32767 && def('advancedLightning', 'coreRadius').def === 2 && def('advancedLightning', 'coreOpacity').def === 75 && def('advancedLightning', 'glowRadius').def === 50 && def('advancedLightning', 'glowColor').def === '#3232ff' && def('advancedLightning', 'forking').def === 25 && def('advancedLightning', 'decay').def === 0.3 && def('advancedLightning', 'complexity').def === 6 && def('advancedLightning', 'minForkDistance').def === 64 && def('advancedLightning', 'forkStrength').def === 70, 'Rayo avanzado');
    // Timecode, Numbers, PaintBucket, Cartoon
    ok(def('timecode', 'format').choices.length === 4 && def('timecode', 'units').def === 30 && def('timecode', 'size').def === 36 && def('timecode', 'size').max === 128 && def('timecode', 'showBox').def === 1 && def('timecode', 'composite').def === 1, 'Código de tiempo');
    ok(def('numbers', 'type').choices.length === 10 && def('numbers', 'display').choices.length === 4 && def('numbers', 'fillColor').def === '#ff0000', 'Números');
    ok(def('paintBucket', 'tolerance').def === 50 && def('paintBucket', 'tolerance').max === 255 && def('paintBucket', 'selector').choices.length === 5 && def('paintBucket', 'stroke').def === 'antialias' && def('paintBucket', 'amount').def === 3 && def('paintBucket', 'blendMode').choices.length === 19 && def('paintBucket', 'blendMode').def === 'normal' && def('paintBucket', 'color').def === '#ff0000', 'Cubo de pintura');
    ok(def('cartoon', 'render').def === 'fillEdges' && def('cartoon', 'detailRadius').def === 8 && def('cartoon', 'steps').def === 8 && def('cartoon', 'steps').max === 30 && def('cartoon', 'edgeThreshold').def === 1.6 && def('cartoon', 'edgeWidth').def === 1.5 && def('cartoon', 'edgeContrast').def === 0.5, 'Caricatura');
    // CycoreFX: Spotlight, Glass, Plastic, Threads, Ball Action, Pixel Polly, Scatterize, Bubbles, Drizzle
    ok(near(def('ccSpotlight', 'from').def[0], 0.9) && def('ccSpotlight', 'cone').def === 10 && def('ccSpotlight', 'intensity').def === 75 && def('ccSpotlight', 'render').def === 'lightShadow' && def('ccSpotlight', 'render').choices.length === 8, 'CC Spotlight');
    ok(def('ccGlass', 'property').def === 'lightness' && def('ccGlass', 'softness').def === 20 && def('ccGlass', 'displacement').def === 100 && def('ccGlass', 'lightHeight').def === 65 && def('ccGlass', 'lightDirection').def === -45 && def('ccGlass', 'roughness').def === 0.025, 'CC Glass');
    ok(def('ccPlastic', 'property').def === 'luminance' && def('ccPlastic', 'ambient').def === 75 && def('ccPlastic', 'dust').def === 25 && near(def('ccPlastic', 'lightPosition').def[0], 0.25), 'CC Plastic');
    ok(def('ccThreads', 'width').def === 50 && def('ccThreads', 'width').min === 3 && def('ccThreads', 'overlaps').def === 3 && def('ccThreads', 'coverage').def === 75 && def('ccThreads', 'texture').def === 15, 'CC Threads');
    ok(def('ccBallAction', 'axis').choices.length === 9 && def('ccBallAction', 'twistProperty').choices.length === 13 && def('ccBallAction', 'spacing').def === 5 && def('ccBallAction', 'ballSize').def === 100, 'CC Ball Action');
    ok(def('ccPixelPolly', 'force').def === 100 && def('ccPixelPolly', 'grid').def === 25 && def('ccPixelPolly', 'object').def === 'texturedPolygon' && def('ccPixelPolly', 'spinning').def === 360, 'CC Pixel Polly');
    ok(def('ccScatterize', 'transfer').choices.length === 4 && def('ccBubbles', 'amount').def === 150 && def('ccBubbles', 'shading').def === 'fadeIn' && def('ccBubbles', 'size').min === 1, 'CC Scatterize / CC Bubbles');
    ok(def('ccDrizzle', 'rippling').def === 360 && def('ccDrizzle', 'displacement').def === 20 && def('ccDrizzle', 'spreading').def === 100 && def('ccDrizzle', 'diffuse').def === 0 && def('ccDrizzle', 'roughness').def === 0.015, 'CC Drizzle');
  });

  test('ronda final: CC Particle Systems II, CC Mr. Mercury, CC Hair, CC Glue Gun, CC Environment y Fractal', () => {
    // ParticleSystemsII: birth rate 4 (0–1000), longevity 2, radius 3 (0–1000), 11 animations (2 separators), velocity
    // 1 (±1000), inherit 0 (±10000), gravity 1 (±100), resistance 0 (0–200), extra 1; 21 types (3 separators), sizes
    // 0.15 / 0.75 (0–100), Fade Out (6), 75 %, Birth to Death (4), #fafa20 → #c81010, Composite (4), seed 0–10000
    const ps = 'ccParticleSystems2';
    ok(def(ps, 'birthRate').def === 4 && def(ps, 'birthRate').max === 1000 && def(ps, 'longevity').def === 2 && def(ps, 'radiusX').def === 3 && def(ps, 'radiusX').max === 1000, 'PS II: productor');
    ok(def(ps, 'animation').choices.length === 9 && def(ps, 'animation').def === 'explosive' && def(ps, 'velocity').min === -1000 && def(ps, 'inheritVelocity').max === 10000 && def(ps, 'gravity').def === 1 && def(ps, 'gravity').max === 100 && def(ps, 'resistance').max === 200 && def(ps, 'extra').def === 1, 'PS II: física');
    ok(def(ps, 'particleType').choices.length === 18 && def(ps, 'particleType').def === 'line' && def(ps, 'birthSize').def === 0.15 && def(ps, 'deathSize').def === 0.75 && def(ps, 'sizeVariation').def === 50 && def(ps, 'opacityMap').choices.length === 6 && def(ps, 'opacityMap').def === 'fadeOut' && def(ps, 'maxOpacity').def === 75, 'PS II: partícula');
    ok(def(ps, 'colorMap').choices.length === 4 && def(ps, 'birthColor').def === '#fafa20' && def(ps, 'deathColor').def === '#c81010' && def(ps, 'transfer').choices.length === 4 && def(ps, 'transfer').def === 'composite' && def(ps, 'seed').max === 10000 && def(ps, 'sourceAlpha').def === 0, 'PS II: color');
    // MrMercury: radius 5 (0–1024), birth rate 1, longevity 2, 14 animations (2 separators), influence 100 %, Blob In
    // & Out (5), sizes 0.15 / 0.75, Effect Light, ambient 100 (0–200), diffuse 25, specular 100, metal 100, opacity 100
    const mm = 'ccMrMercury';
    ok(def(mm, 'radiusX').def === 5 && def(mm, 'radiusX').max === 1024 && def(mm, 'birthRate').def === 1 && def(mm, 'animation').choices.length === 12 && def(mm, 'influenceMap').choices.length === 5 && def(mm, 'influenceMap').def === 'blobInOut' && def(mm, 'blobBirthSize').def === 0.15 && def(mm, 'blobDeathSize').def === 0.75, 'Mr. Mercury: gotas');
    ok(def(mm, 'using').def === 'effect' && def(mm, 'lightType').def === 'distant' && def(mm, 'lightHeight').def === 65 && near(def(mm, 'lightPosition').def[0], 0.25) && def(mm, 'ambient').def === 100 && def(mm, 'ambient').max === 200 && def(mm, 'diffuse').def === 25 && def(mm, 'specular').def === 100 && def(mm, 'roughness').def === 0.025 && def(mm, 'materialOpacity').def === 100, 'Mr. Mercury: luz y sombreado');
    // Hair: length 25 (0–500), thickness 0.7 (0–4), weight 1 (±10), density 200 (0–10000), map strength 60, 8
    // properties (Luminance), softness 25 (0–511), noise 2 %, #513916, inheritance 25 %, opacity 50 %, light 70 / −45°,
    // ambient 10, diffuse 50, specular 30 (0–200), roughness 0.075
    const h = 'ccHair';
    ok(ids(h) === 'length,thickness,weight,constantMass,density,mapStrength,mapLayer,mapProperty,mapSoftness,addNoise,color,colorInheritance,opacity,lightHeight,lightDirection,ambient,diffuse,specular,roughness', `CC Hair: ${ids(h)}`);
    ok(def(h, 'length').def === 25 && def(h, 'length').max === 500 && def(h, 'thickness').def === 0.7 && def(h, 'thickness').max === 4 && def(h, 'weight').min === -10 && def(h, 'density').def === 200 && def(h, 'density').max === 10000 && def(h, 'mapStrength').def === 60 && def(h, 'mapProperty').choices.length === 8 && def(h, 'mapProperty').def === 'luminance' && def(h, 'mapSoftness').max === 511 && def(h, 'addNoise').def === 2, 'CC Hair: pelo y mapa');
    ok(def(h, 'color').def === '#513916' && def(h, 'colorInheritance').def === 25 && def(h, 'opacity').def === 50 && def(h, 'lightHeight').def === 70 && def(h, 'lightDirection').def === -45 && def(h, 'ambient').def === 10 && def(h, 'diffuse').def === 50 && def(h, 'specular').def === 30 && def(h, 'specular').max === 200 && def(h, 'roughness').def === 0.075, 'CC Hair: color y luz');
    // GlueGun: width 4 (0–1024), density 25 (0–200), span 0 (0–3000), reflection 100 (0–200), strength 100 %, Plain
    // (2), wobble 2.5 / 2.5 / 100 (0–30000)
    const gg = 'ccGlueGun';
    ok(def(gg, 'strokeWidth').def === 4 && def(gg, 'strokeWidth').max === 1024 && def(gg, 'density').def === 25 && def(gg, 'density').max === 200 && def(gg, 'timeSpan').def === 0 && def(gg, 'reflection').def === 100 && def(gg, 'reflection').max === 200 && def(gg, 'strength').def === 100 && def(gg, 'paintStyle').choices.length === 2 && def(gg, 'wobbleWidth').def === 2.5 && def(gg, 'wobbleSpeed').def === 100 && def(gg, 'wobbleSpeed').max === 30000 && def(gg, 'metal').def === 100, 'CC Glue Gun');
    // Environment: layer, Spherical | Probe | Vertical Cross, pan 0 (±10000), Filter off, lens distortion 0 (±1000)
    ok(ids('ccEnvironment') === 'environment,mapping,horizontalPan,filter,lensDistortion' && choices('ccEnvironment', 'mapping') === 'spherical,probe,verticalCross' && def('ccEnvironment', 'horizontalPan').max === 10000 && def('ccEnvironment', 'lensDistortion').min === -1000, 'CC Environment');
    // Fractal: 6 sets, 4 equations, X −0.703, magnification 0 (−29–100), escape 300 (1–10⁶), 7 palettes, cycle
    // steps 29 (1–32768), Edge Detect, factor 4 (2–16)
    const f = 'fractal';
    ok(def(f, 'setChoice').choices.length === 6 && def(f, 'equation').choices.length === 4 && def(f, 'mX').def === -0.703 && def(f, 'mY').def === 0 && def(f, 'mMag').min === -29 && def(f, 'mMag').max === 100 && def(f, 'mEscape').def === 300 && def(f, 'mEscape').max === 1e6 && def(f, 'jX').def === 0 && def(f, 'jEscape').def === 300, 'Fractal: conjuntos');
    ok(def(f, 'palette').choices.length === 7 && def(f, 'palette').def === 'lightness' && def(f, 'cycleSteps').def === 29 && def(f, 'cycleSteps').max === 32768 && def(f, 'oversample').def === 'edge' && def(f, 'oversampleFactor').def === 4 && def(f, 'oversampleFactor').min === 2 && def(f, 'oversampleFactor').max === 16 && fx(f).cat === 'Generar', 'Fractal: color y calidad');
  });

  test('Estallido y Card Dance: sistema de cámaras, posición de cámara, esquinas, iluminación y material', () => {
    // CAMLIGHT (Shatter / Card Dance): Camera Position | Corner Pins | Comp Camera; rotations 0, X,Y centre, Z 2
    // (±1000), focal 70 (10–1000), 12 transform orders (Rotate XYZ, Position); pins at the corners, Auto Focal off;
    // Point | Distant (default) | First Comp Light, intensity 1 (0–50), white, centre, depth 1 (±100), ambient 0.25 (0–2),
    // diffuse 0.75, specular 0 (0–2), highlight sharpness 10 (0–100)
    for (const [id, focal] of [['shatter', 'camFocal'], ['cardDance', 'focal']]) {
      ok(choices(id, 'cameraSystem') === 'position,cornerPins,comp' && def(id, 'camRotX').def === 0 && near(def(id, 'camPos').def[0], 0.5) && def(id, 'camZ').def === 2 && def(id, 'camZ').min === -1000 && def(id, focal).def === 70 && def(id, focal).min === 10 && def(id, focal).max === 1000, `${id}: cámara`);
      ok(def(id, 'camOrder').choices.length === 12 && def(id, 'camOrder').def === 'rotXYZ' && def(id, 'camOrder').choices[6].id === 'posXYZ', `${id}: orden de transformación`);
      ok(def(id, 'pinUL').def.join() === '0,0' && def(id, 'pinUR').def.join() === '1,0' && def(id, 'pinLL').def.join() === '0,1' && def(id, 'pinLR').def.join() === '1,1' && def(id, 'autoFocal').def === 0 && def(id, 'pinFocal').def === 70, `${id}: esquinas`);
      ok(choices(id, 'lightType') === 'point,distant,firstComp' && def(id, 'lightType').def === 'distant' && def(id, 'lightIntensity').def === 1 && def(id, 'lightIntensity').max === 50 && def(id, 'lightColor').def === '#ffffff' && def(id, 'lightDepth').def === 1 && def(id, 'lightDepth').min === -100 && def(id, 'ambient').def === 0.25 && def(id, 'ambient').max === 2, `${id}: iluminación`);
      ok(def(id, 'diffuse').def === 0.75 && def(id, 'diffuse').max === 2 && def(id, 'specular').def === 0 && def(id, 'sharpness').def === 10 && def(id, 'sharpness').max === 100, `${id}: material`);
    }
    // Card Dance: Rotation Order XYZ (6), Transformation Order «Scale, Rotate, Position» (6th of 6)
    ok(choices('cardDance', 'rotationOrder') === 'xyz,xzy,yxz,yzx,zxy,zyx' && def('cardDance', 'rotationOrder').def === 'xyz' && choices('cardDance', 'transformOrder') === 'prs,psr,rps,rsp,spr,srp' && def('cardDance', 'transformOrder').def === 'srp', 'Card Dance: órdenes');
    const cd = ids('cardDance').split(',');
    ok(cd.indexOf('rotationOrder') === cd.indexOf('gradient2') + 1 && cd.indexOf('transformOrder') === cd.indexOf('rotationOrder') + 1, 'Card Dance: órdenes tras las capas de degradado');
  });
};
