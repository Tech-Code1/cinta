// Effects of this line of work (see fx-groups/index.ts). Each entry follows After Effects' own plug-in
// (names, defaults, ranges and choices); the drawing is in src/motion-render/fx-groups/distorsion.ts.
import type { FxDef } from '../effects';
import { n, pc, an, co, pt, bo, ch, ly, tx } from '../fxparams';

const COMPLETION = pc('completion', 'Completado', 0);
const ORDER: [string, string][] = [['xyz', 'XYZ'], ['xzy', 'XZY'], ['yxz', 'YXZ'], ['yzx', 'YZX'], ['zxy', 'ZXY'], ['zyx', 'ZYX']];
const RENDER3D: [string, string][] = [['full', 'Completo'], ['outside', 'Exterior'], ['inside', 'Interior']];
/** CycoreFX's Light and Shading groups (CC Cylinder, CC Sphere) */
const light = (h: number, dir: number, amb: number, dif: number, spec: number, rough: number) => [n('lightIntensity', 'Intensidad de luz', 100, 0, 1000), co('lightColor', 'Color de luz', '#ffffff'), n('lightHeight', 'Altura de luz', h, -100, 100), an('lightDirection', 'Dirección de luz', dir), n('ambient', 'Ambiente', amb, 0, 200), n('diffuse', 'Difusa', dif, 0, 100), n('specular', 'Especular', spec, 0, 100), n('roughness', 'Rugosidad', rough, 0.001, 0.5), n('metal', 'Metal', 100, 0, 100)];
const xyz = (pre: string, nm: string, min?: number, max?: number) => ['X', 'Y', 'Z'].map((a) => (min === undefined ? an(`${pre}${a}`, `${nm} ${a}`, 0) : n(`${pre}${a}`, `${nm} ${a}`, 0, min, max)));

const ELASTICITY: [string, string][] = [['stiff', 'Inflexible'], ['lessStiff', 'Menos inflexible'], ['belowNormal', 'Inferior al normal'], ['normal', 'Normal'], ['absNormal', 'Completamente normal'], ['aboveAverage', 'Superior al promedio'], ['loose', 'Suelto'], ['liquid', 'Líquido'], ['superFluid', 'Muy fluido']];
const INTERP: [string, string][] = [['discrete', 'Diferenciado'], ['linear', 'Lineal'], ['smooth', 'Suave']];
/** The camera and light groups shared by Card Wipe / Card Dance / Shatter (CAMLIGHT strings; Card Wipe) */
const TRANSFORM_ORDER: [string, string][] = [...ORDER.map(([k, v]): [string, string] => [`r${k}Pos`, `Girar ${v}, posición`]), ...ORDER.map(([k, v]): [string, string] => [`posR${k}`, `Posición, girar ${v}`])];
const CAMLIGHT = [
  ch('cameraSystem', 'Sistema de cámaras', [['position', 'Posición de la cámara'], ['cornerPins', 'Posicionamientos de los bordes'], ['comp', 'Cámara comp.']]),
  an('camRotX', 'Posición de la cámara: rotación X', 0), an('camRotY', 'Posición de la cámara: rotación Y', 0), an('camRotZ', 'Posición de la cámara: rotación Z', 0),
  pt('camXY', 'Posición de la cámara: posición X,Y'), n('camZ', 'Posición de la cámara: posición Z', 2, -1000, 1000), n('camFocal', 'Posición de la cámara: distancia focal', 70, 10, 1000),
  ch('transformOrder', 'Posición de la cámara: orden de transformación', TRANSFORM_ORDER),
  pt('pinUL', 'Borde superior izquierdo', 0, 0), pt('pinUR', 'Borde superior derecho', 1, 0), pt('pinLL', 'Borde inferior izquierdo', 0, 1), pt('pinLR', 'Borde inferior derecho', 1, 1),
  bo('autoFocal', 'Distancia focal automática'), n('pinFocal', 'Posicionamientos de los bordes: distancia focal', 70, 10, 1000),
  ch('lightType', 'Iluminación: tipo de luz', [['point', 'Origen del punto'], ['distant', 'Origen distante'], ['comp', 'Luz de la primera comp.']], 'distant'),
  n('lightIntensity', 'Iluminación: intensidad de la luz', 1, 0, 50), co('lightColor', 'Iluminación: color de luz', '#ffffff'), pt('lightPos', 'Iluminación: posición de la luz'),
  n('lightDepth', 'Iluminación: profundidad de la luz', 1, -100, 100), n('ambient', 'Iluminación: luz ambiental', 0.25, 0, 2),
  n('diffuse', 'Material: reflejo difuso', 0.75, 0, 2), n('specular', 'Material: reflejo especular', 0, 0, 2), n('sharpness', 'Material: nitidez del resalte', 10, 0, 100),
];

export const FX_DISTORSION: FxDef[] = [
  // ── Perspective ──
  // Bevel_Alpha: edge thickness 2 (0–200, slider 0–10), light angle −60°, white light, intensity 0.4 (0–1)
  { id: 'bevelAlpha', name: 'Bisel alfa', cat: 'Perspectiva', params: [n('thickness', 'Grosor del borde', 2, 0, 200), an('lightAngle', 'Ángulo de luz', -60), co('lightColor', 'Color de luz', '#ffffff'), n('intensity', 'Intensidad de luz', 0.4, 0, 1)], probe: { thickness: 40, intensity: 1 } },
  // Bevel_Edges: edge thickness 0.1 (0–0.5, a share of the layer's smaller side), −60°, white, 0.4
  { id: 'bevelEdges', name: 'Biselar bordes', cat: 'Perspectiva', params: [n('thickness', 'Grosor del borde', 0.1, 0, 0.5), an('lightAngle', 'Ángulo de luz', -60), co('lightColor', 'Color de luz', '#ffffff'), n('intensity', 'Intensidad de luz', 0.4, 0, 1)] },
  // RadialShadow: shadow colour black, opacity 50 %, light source at 25 % / 25 %, projection distance 10 (0–100,
  // slider 0–50), softness 0 (0–100, slider 0–50), Regular|Glass Edge, colour influence 100 % (0–200 %), shadow only
  // off, resize layer off
  { id: 'radialShadow', name: 'Sombra radial', cat: 'Perspectiva', params: [co('color', 'Color de sombra', '#000000'), pc('opacity', 'Opacidad', 50), pt('light', 'Fuente de luz', 0.25, 0.25), n('distance', 'Distancia de proyección', 10, 0, 100), n('softness', 'Suavidad', 0, 0, 100), ch('render', 'Procesar', [['regular', 'Normal'], ['glass', 'Borde de cristal']]), pc('influence', 'Influencia del color', 100, 0, 200), bo('only', 'Solo sombra'), bo('resize', 'Cambiar el tamaño de la capa')], probe: { only: 1 } },
  // Basic_3D: swivel 0°, tilt 0°, distance to image 0 (±30000, slider 0–100), specular highlight off, preview
  // wireframe off
  { id: 'basic3d', name: '3D básico', cat: 'Perspectiva', params: [an('swivel', 'Girar', 0), an('tilt', 'Inclinar', 0), n('distance', 'Distancia a la imagen', 0, -30000, 30000), bo('specular', 'Mostrar resalte especular'), bo('preview', 'Dibujar estructura de previsualización')], probe: { swivel: 40 } },
  // CC Cylinder (Cylinder): radius 100 % (0–30000, slider 0–200), position X/Y/Z 0 (±30000, slider ±800),
  // rotation 0°, order YXZ, Full|Outside|Inside; light 100 (0–1000), white, height 25, direction −45°; ambient 50
  // (0–200), diffuse 50, specular 50, roughness 0.04 (0.001–0.5), metal 100
  { id: 'ccCylinder', name: 'CC Cylinder', cat: 'Perspectiva', params: [n('radius', 'Radio (%)', 100, 0, 30000), ...xyz('pos', 'Posición', -30000, 30000), ...xyz('rot', 'Rotación'), ch('rotOrder', 'Orden de rotación', ORDER, 'yxz'), ch('render', 'Procesar', RENDER3D), ...light(25, -45, 50, 50, 50, 0.04)] },
  // CC Sphere (Sphere): rotation 0°, order XYZ, radius 200 (0–10000, slider 0–800), offset at the centre,
  // Full|Outside|Inside; light 100, white, height 40, direction −85°; ambient 10, diffuse 100, specular 10, roughness
  // 0.05, metal 100, reflective 0, reflection map none, internal shadows off, transparency falloff off
  { id: 'ccSphere', name: 'CC Sphere', cat: 'Perspectiva', params: [...xyz('rot', 'Rotación'), ch('rotOrder', 'Orden de rotación', ORDER), n('radius', 'Radio', 200, 0, 10000), pt('offset', 'Desplazamiento'), ch('render', 'Procesar', RENDER3D), ...light(40, -85, 10, 100, 10, 0.05), n('reflective', 'Reflectante', 0, 0, 100), ly('reflectionMap', 'Mapa de reflexión'), bo('internalShadows', 'Sombras internas'), bo('transparencyFalloff', 'Atenuación de transparencia')] },
  // 3DGlasses (3D Glasses): left view and right view none (the layer itself), scene convergence 0 and vertical
  // alignment 0 (±32768, slider ±128), units Pixels|% of Source, swap left-right off, 3D view Stereo Pair (Side by
  // Side) of 9, balance 8 (0–50, slider 0–20)
  { id: 'glasses3d', name: 'Gafas 3D', cat: 'Perspectiva', params: [ly('left', 'Vista izquierda (vacía: la propia capa)'), ly('right', 'Vista derecha (vacía: la propia capa)'), n('convergence', 'Convergencia de escena', 0, -32768, 32768), n('vertical', 'Alineación vertical', 0, -32768, 32768), ch('units', 'Unidades', [['pixels', 'Píxeles'], ['percent', '% de origen']]), bo('swap', 'Cambiar izquierda-derecha'), ch('view', 'Vista 3D', [['stereoPair', 'Par estéreo (en paralelo)'], ['overUnder', 'Superior inferior'], ['interlace', 'Entrelazado superior I Inferior D'], ['difference', 'Diferencia'], ['redGreen', 'ID rojo verde'], ['redBlue', 'ID rojo azul'], ['balancedRedGreen', 'ID rojo verde equilibrado'], ['balancedRedBlue', 'ID rojo azul equilibrado'], ['balancedColored', 'Equilibrio de colores azul rojo']]), n('balance', 'Equilibrio', 8, 0, 50)] },
  // ── Distort ──
  // CC Blobbylize (Blobbylize): blob layer none (the layer itself), property Lightness (Red|Green|Blue|Alpha|
  // Luminance|Lightness), softness 20 (0–500, slider 1–50), cut away 25 (0–100); light using Effect Light|AE Lights,
  // intensity 100 (0–1000), white, Distant Light|Point Light, height 65, position 25 % / 25 %, direction −45°;
  // ambient 75, diffuse 25, specular 100, roughness 0.025 (0.001–0.5), metal 100
  { id: 'ccBlobbylize', name: 'CC Blobbylize', cat: 'Distorsionar', params: [ly('blobLayer', 'Capa de manchas (vacía: la propia capa)'), ch('property', 'Propiedad', [['red', 'Rojo'], ['green', 'Verde'], ['blue', 'Azul'], ['alpha', 'Alfa'], ['luminance', 'Luminancia'], ['lightness', 'Luminosidad']], 'lightness'), n('softness', 'Suavidad', 20, 0, 500), n('cutAway', 'Recortar', 25, 0, 100), ch('using', 'Usar', [['effect', 'Luz del efecto'], ['ae', 'Luces de AE']]), n('lightIntensity', 'Intensidad de luz', 100, 0, 1000), co('lightColor', 'Color de luz', '#ffffff'), ch('lightType', 'Tipo de luz', [['distant', 'Luz distante'], ['point', 'Luz puntual']]), n('lightHeight', 'Altura de luz', 65, -100, 100), pt('lightPosition', 'Posición de luz', 0.25, 0.25), an('lightDirection', 'Dirección de luz', -45), n('ambient', 'Ambiente', 75, 0, 200), n('diffuse', 'Difusa', 25, 0, 100), n('specular', 'Especular', 100, 0, 100), n('roughness', 'Rugosidad', 0.025, 0.001, 0.5), n('metal', 'Metal', 100, 0, 100)] },
  // Reshape_New (Reshape): source, destination and boundary masks (the layer's masks, by name), percent 0
  // (0–100), elasticity Stiff (of 9), correspondence points (pairs «source,destination» as 0–1 shares of each
  // outline; empty: one pair at the first vertices), interpolation method Discrete|Linear|Smooth (Discrete)
  { id: 'reshape', name: 'Dar nueva forma', cat: 'Distorsionar', params: [tx('source', 'Máscara de origen'), tx('destination', 'Máscara de destino'), tx('boundary', 'Máscara de contorno'), pc('percent', 'Porcentaje', 0), ch('elasticity', 'Elasticidad', ELASTICITY), tx('points', 'Puntos de correspondencia'), ch('interpolation', 'Método de interpolación', INTERP)], still: true },
  // Smear_New (Smear): source and boundary masks, mask offset 55 % / 50 %, mask rotation 0°, mask scale 1
  // (0.1–2), percent 0 (0–100), elasticity Stiff (of 9), interpolation method Linear
  { id: 'smear', name: 'Alargar', cat: 'Distorsionar', params: [tx('source', 'Máscara de origen'), tx('boundary', 'Máscara de contorno'), pt('offset', 'Desplazamiento de la máscara', 0.55, 0.5), an('rotation', 'Rotación de la máscara', 0), n('scale', 'Escala de la máscara', 1, 0.1, 2), pc('percent', 'Porcentaje', 0), ch('elasticity', 'Elasticidad', ELASTICITY), ch('interpolation', 'Método de interpolación', INTERP, 'linear')], still: true },
  // CC Page Turn (PageTurn): controls Bottom Right Corner (of Classic UI and the four corners), fold position
  // 75 % / 50 %, fold direction −60°, fold radius 50 (4–1000, slider 4–100), light direction −60°, Front & Back Page,
  // back page none, back opacity 85 %, paper colour #c4c4b4
  { id: 'ccPageTurn', name: 'CC Page Turn', cat: 'Distorsionar', params: [ch('controls', 'Controles', [['classic', 'Interfaz clásica'], ['topLeft', 'Esquina superior izquierda'], ['topRight', 'Esquina superior derecha'], ['bottomLeft', 'Esquina inferior izquierda'], ['bottomRight', 'Esquina inferior derecha']], 'bottomRight'), pt('foldPosition', 'Posición del pliegue', 0.75, 0.5), an('foldDirection', 'Dirección del pliegue', -60), n('foldRadius', 'Radio del pliegue', 50, 4, 1000), an('lightDirection', 'Dirección de luz', -60), ch('render', 'Procesar', [['frontBack', 'Página delantera y trasera'], ['back', 'Página trasera'], ['front', 'Página delantera']]), ly('backPage', 'Página trasera'), pc('backOpacity', 'Opacidad trasera', 85), co('paperColor', 'Color del papel', '#c4c4b4')] },
  // CC Bender (Bender): amount 0 (±250, slider ±100), Bend|Marilyn|Sharp|Boxer, adjust to distance off, top 50 %
  // / 25 %, base 50 % / 75 %
  { id: 'ccBender', name: 'CC Bender', cat: 'Distorsionar', params: [n('amount', 'Cantidad', 0, -250, 250), ch('style', 'Estilo', [['bend', 'Curvar'], ['marilyn', 'Marilyn'], ['sharp', 'Agudo'], ['boxer', 'Boxeador']]), bo('adjust', 'Ajustar a la distancia'), pt('top', 'Parte superior', 0.5, 0.25), pt('base', 'Base', 0.5, 0.75)], probe: { amount: 60 } },
  // CC Flo Motion (FloMotion): finer controls off, knot 1 at 25 %, amount 1 0 (±1600, slider ±100), knot 2 at
  // 75 %, amount 2 0, tile edges on, antialiasing Medium, falloff 1 (0–10, slider 0–3)
  { id: 'ccFloMotion', name: 'CC Flo Motion', cat: 'Distorsionar', params: [bo('finer', 'Controles más finos'), pt('knot1', 'Nudo 1', 0.25, 0.25), n('amount1', 'Cantidad 1', 0, -1600, 1600), pt('knot2', 'Nudo 2', 0.75, 0.75), n('amount2', 'Cantidad 2', 0, -1600, 1600), bo('tileEdges', 'Bordes en mosaico', true), ch('antialias', 'Suavizado', [['low', 'Bajo'], ['medium', 'Medio'], ['high', 'Alto']], 'medium'), n('falloff', 'Atenuación', 1, 0, 10)], probe: { amount1: 60 } },
  // CC Griddler (Griddler): horizontal / vertical scale 100 (±2000, slider ±100), tile size 10 (1–200, slider
  // 4–50), rotation 0°, cut tiles on
  { id: 'ccGriddler', name: 'CC Griddler', cat: 'Distorsionar', params: [n('hScale', 'Escala horizontal', 100, -2000, 2000), n('vScale', 'Escala vertical', 100, -2000, 2000), n('tileSize', 'Tamaño de mosaico', 10, 1, 200), an('rotation', 'Rotación', 0), bo('cut', 'Cortar mosaicos', true)], probe: { hScale: 50, rotation: 30 } },
  // CC Split (Split): point A 25 % / 50 %, point B 75 % / 50 %, split 0 (0–250, slider 0–100); CC Split 2
  // (Split2): the same with split 1 and split 2 for each side
  { id: 'ccSplit', name: 'CC Split', cat: 'Distorsionar', params: [pt('a', 'Punto A', 0.25, 0.5), pt('b', 'Punto B', 0.75, 0.5), n('split', 'Separar', 0, 0, 250)], probe: { split: 60 } },
  { id: 'ccSplit2', name: 'CC Split 2', cat: 'Distorsionar', params: [pt('a', 'Punto A', 0.25, 0.5), pt('b', 'Punto B', 0.75, 0.5), n('split1', 'Separar 1', 0, 0, 250), n('split2', 'Separar 2', 0, 0, 250)], probe: { split1: 60 } },
  // CC RepeTile (RepeTile): expand right / left / down / up 0 (0–20000, slider 0–400), 16 tilings (Repeat),
  // blend borders 0 %. The layer grows by the largest expansion (Cinta grows layers evenly); inside the layer's own
  // box nothing changes (still)
  { id: 'ccRepeTile', name: 'CC RepeTile', cat: 'Distorsionar', params: [n('right', 'Expandir a la derecha', 0, 0, 20000), n('left', 'Expandir a la izquierda', 0, 0, 20000), n('down', 'Expandir hacia abajo', 0, 0, 20000), n('up', 'Expandir hacia arriba', 0, 0, 20000), ch('tiling', 'Mosaico', [['repeat', 'Repetir'], ['flipH', 'Cuadros volteados H'], ['flipV', 'Cuadros volteados V'], ['unfold', 'Desplegar'], ['rot180', 'Cuadros 180°'], ['flip45', 'Cuadros volteados 45°'], ['rot90ccw', 'Cuadros 90° antihorario'], ['rot90cw', 'Cuadros 90° horario'], ['rosette', 'Roseta'], ['random', 'Aleatorio'], ['none', 'Ninguno'], ['turnCW', 'Girar horario'], ['turnCCW', 'Girar antihorario'], ['twist', 'Torcer'], ['slide', 'Deslizar'], ['brick', 'Ladrillo']]), pc('blend', 'Fundir bordes', 0)], still: true },
  // CC Smear (Smear): from 50 % / 50 %, to 75 % / 25 %, reach 100 (±1000, slider 0–100), radius 80 (0–4000,
  // slider 0–500)
  { id: 'ccSmear', name: 'CC Smear', cat: 'Distorsionar', params: [pt('from', 'Desde'), pt('to', 'Hasta', 0.75, 0.25), n('reach', 'Alcance', 100, -1000, 1000), n('radius', 'Radio', 80, 0, 4000)] },
  // RollingShutter (Rolling Shutter Repair): rolling shutter rate 50 (0–100), scan direction Top -> Bottom (of 4);
  // advanced: method Warp|Pixel Motion, detailed analysis off, pixel motion detail 20 (5–100). The motion is
  // measured per frame from the layer before and after (optical flow); a still layer is left as it is
  { id: 'rollingShutter', name: 'Reparación de obturación despl.', cat: 'Distorsionar', params: [n('rate', 'Velocidad obturación despl.', 50, 0, 100), ch('scan', 'Dirección de exploración', [['topBottom', 'Superior -> Inferior'], ['bottomTop', 'Inferior -> Superior'], ['leftRight', 'Izquierda -> Derecha'], ['rightLeft', 'Derecha -> Izquierda']]), ch('method', 'Avanzadas: método', [['warp', 'Deformar'], ['pixelMotion', 'Movimiento de píxeles']]), bo('detailed', 'Avanzadas: análisis detallado'), n('pixelDetail', 'Avanzadas: detalle movimiento de píxeles', 20, 5, 100)], still: true },
  // OpticsComp (Optics Compensation): field of view 0 (0–180, slider 0–90), reverse lens distortion off,
  // Horizontal|Vertical|Diagonal, view centre, optimal pixels off, resize Off|Max 2X|Max 4X|Unlimited (Off)
  { id: 'opticsComp', name: 'Compensación de óptica', cat: 'Distorsionar', params: [n('fov', 'Campo de visión (FOV)', 0, 0, 180), bo('reverse', 'Invertir distorsión de lente'), ch('orientation', 'Orientación de FOV', [['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['diagonal', 'Diagonal']]), pt('center', 'Centro de la vista'), bo('optimal', 'Píxeles óptimos (anula la inversión)'), ch('resize', 'Cambiar tamaño', [['off', 'Desactivado'], ['max2', 'Máx. 2X'], ['max4', 'Máx. 4X'], ['unlimited', 'Ilimitado']])], probe: { fov: 80 } },
  // Magnify: Circle|Square, centre, magnification 150 (100–20000, slider 100–600), link None (3), size 100
  // (1–4000, slider 10–600), feather 0 (0–1000, slider 0–50), opacity 100 %, scaling Standard|Soft|Scatter,
  // blending mode Normal (of None, Normal and the usual modes), resize layer off
  { id: 'magnify', name: 'Lupa', cat: 'Distorsionar', params: [ch('shape', 'Forma', [['circle', 'Círculo'], ['square', 'Cuadrado']]), pt('center', 'Centro'), n('magnification', 'Ampliación', 150, 100, 20000), ch('link', 'Vínculo', [['none', 'Ninguno'], ['size', 'Tamaño a ampliación'], ['sizeFeather', 'Tamaño y calado a ampliación']]), n('size', 'Tamaño', 100, 1, 4000), n('feather', 'Calado', 0, 0, 1000), pc('opacity', 'Opacidad', 100), ch('scaling', 'Escala', [['standard', 'Estándar'], ['soft', 'Suave'], ['scatter', 'Dispersión']]), ch('blend', 'Modo de fusión', [['none', 'Ninguno'], ['normal', 'Normal'], ['add', 'Añadir'], ['multiply', 'Multiplicar'], ['screen', 'Trama'], ['overlay', 'Superponer'], ['softLight', 'Luz suave'], ['hardLight', 'Luz fuerte'], ['colorDodge', 'Sobreexponer color'], ['colorBurn', 'Subexponer color'], ['darken', 'Oscurecer'], ['lighten', 'Aclarar'], ['difference', 'Diferencia'], ['exclusion', 'Exclusión'], ['hue', 'Tono'], ['saturation', 'Saturación'], ['color', 'Color'], ['luminosity', 'Luminosidad']], 'normal'), bo('resize', 'Cambiar el tamaño de la capa')] },
  // CannedWarp (Warp): 15 styles (Arc), axis Horizontal|Vertical, bend 50, horizontal / vertical distortion 0 (±100)
  { id: 'warp', name: 'Deformar', cat: 'Distorsionar', params: [ch('style', 'Estilo de deformación', [['arc', 'Arco'], ['arcLower', 'Arco inferior'], ['arcUpper', 'Arco superior'], ['arch', 'Arco con eje'], ['bulge', 'Abombar'], ['shellLower', 'Concha inferior'], ['shellUpper', 'Concha superior'], ['flag', 'Bandera'], ['wave', 'Onda'], ['fish', 'Pez'], ['rise', 'Ascendente'], ['fisheye', 'Ojo de pez'], ['inflate', 'Inflar'], ['twist', 'Torcer'], ['squeeze', 'Apretar']]), ch('axis', 'Eje de deformación', [['horizontal', 'Horizontal'], ['vertical', 'Vertical']]), n('bend', 'Curvar', 50, -100, 100), n('hDistortion', 'Distorsión horizontal', 0, -100, 100), n('vDistortion', 'Distorsión vertical', 0, -100, 100)] },
  // CC Lens (Lens): centre, size 50 (0–500, slider 0–100), convergence 100 (−200…100, slider ±100)
  { id: 'ccLens', name: 'CC Lens', cat: 'Distorsionar', params: [pt('center', 'Centro'), n('size', 'Tamaño', 50, 0, 500), n('convergence', 'Convergencia', 100, -200, 100)] },
  // CC Slant (Slant): slant 0 (±1000, slider ±100), stretching on, height 100 (±1000, slider 0–100), floor at the
  // bottom centre, set colour off, black
  { id: 'ccSlant', name: 'CC Slant', cat: 'Distorsionar', params: [n('slant', 'Inclinación', 0, -1000, 1000), bo('stretching', 'Estirar', true), n('height', 'Altura', 100, -1000, 1000), pt('floor', 'Suelo', 0.5, 1), bo('setColor', 'Establecer color'), co('color', 'Color', '#000000')], probe: { slant: 40 } },
  // CC Tiler (Tiler): scale 100 %, centre, blend with original 0 %
  { id: 'ccTiler', name: 'CC Tiler', cat: 'Distorsionar', params: [pc('scale', 'Escala', 100), pt('center', 'Centro'), pc('blend', 'Mezclar con original', 0)], probe: { scale: 40 } },
  // ── Transition ──
  // CC Radial ScaleWipe (RadialScaleWipe): completion 0 %, centre, reverse off
  { id: 'ccRadialScaleWipe', name: 'CC Radial ScaleWipe', cat: 'Transición', params: [COMPLETION, pt('center', 'Centro'), bo('reverse', 'Invertir transición')] },
  // CC Scale Wipe (ScaleWipe): stretch 0 (±100, slider ±10), centre, direction 0°
  { id: 'ccScaleWipe', name: 'CC Scale Wipe', cat: 'Transición', params: [n('stretch', 'Estirar', 0, -100, 100), pt('center', 'Centro'), an('direction', 'Dirección', 0)], probe: { stretch: 5 } },
  // CC Grid Wipe (GridWipe): completion 0 %, centre, rotation 45°, border 75 (30–200), tiles 10 (1–25),
  // Doors|Radial|Rectangular (Radial), reverse off
  { id: 'ccGridWipe', name: 'CC Grid Wipe', cat: 'Transición', params: [COMPLETION, pt('center', 'Centro'), an('rotation', 'Rotación', 45), n('border', 'Borde', 75, 30, 200), n('tiles', 'Mosaicos', 10, 1, 25), ch('shape', 'Forma', [['doors', 'Puertas'], ['radial', 'Radial'], ['rectangular', 'Rectangular']], 'radial'), bo('reverse', 'Invertir transición')] },
  // CC Jaws (Jaws): completion 0 %, centre, direction 0°, height 10 %, width 10 (2–…, slider 2–20),
  // Spikes|RoboJaw|Block|Waves
  { id: 'ccJaws', name: 'CC Jaws', cat: 'Transición', params: [COMPLETION, pt('center', 'Centro'), an('direction', 'Dirección', 0), pc('height', 'Altura', 10), n('width', 'Anchura', 10, 2, 100), ch('shape', 'Forma', [['spikes', 'Picos'], ['roboJaw', 'Mandíbula robot'], ['block', 'Bloque'], ['waves', 'Ondas']])] },
  // CC Line Sweep (LineSweep): completion 0 (0–100), direction 180°, thickness 50 (1–1000, slider 20–200),
  // slant 50 (…99, slider …80), flip direction off
  { id: 'ccLineSweep', name: 'CC Line Sweep', cat: 'Transición', params: [n('completion', 'Completado', 0, 0, 100), an('direction', 'Dirección', 180), n('thickness', 'Grosor', 50, 1, 1000), n('slant', 'Inclinación', 50, -99, 99), bo('flip', 'Invertir dirección')] },
  // Card Wipe: completion 25 %, width 50 %, back layer none (the layer), Independent rows & columns, 9 rows and
  // 12 columns (1–1000, slider 1–250), card scale 1 (0–10, slider 0–1), flip axis X|Y|Random, Positive|Negative|Random,
  // 9 flip orders (Left to Right), gradient layer, timing randomness 0 (0–1), seed 1 (1–1000, slider 1–10), position
  // jitter X / Y 0 (0–5, slider 0–1) and Z 0 (0–25), rotation jitter 0 (0–360, slider 0–90), speeds 1 (0–1000, slider
  // 0–10).
  // Camera System Camera Position|Corner Pins|Comp Camera; Camera Position: rotation X / Y / Z 0°, X,Y position at
  // the centre, Z position 2 (±1000, slider 0.1–10), focal length 70 (10–1000, slider 20–300), transform order Rotate
  // XYZ, Position (of 12); Corner Pins: the layer's four corners, auto focal length off, focal length 70; Lighting:
  // light type Distant Source (Point Source|Distant Source|First Comp Light), intensity 1 (0–50, slider 0–5), white,
  // position at the centre, depth 1 (±100, slider ±5), ambient 0.25 (0–2); Material: diffuse 0.75 (0–2), specular 0
  // (0–2), highlight sharpness 10 (0–100, slider 0–50). Projects saved before these groups existed keep the old view
  { id: 'cardWipe', name: 'Barrido de tarjetas', cat: 'Transición', params: [pc('completion', 'Completado de la transición', 25), pc('width', 'Anchura de la transición', 50), ly('back', 'Capa posterior (vacía: la propia capa)'), ch('rowsCols', 'Filas y columnas', [['independent', 'Independientes'], ['follow', 'Columnas siguen a filas']]), n('rows', 'Filas', 9, 1, 1000), n('columns', 'Columnas', 12, 1, 1000), n('cardScale', 'Escala de tarjeta', 1, 0, 10), ch('flipAxis', 'Eje de giro', [['x', 'X'], ['y', 'Y'], ['random', 'Aleatorio']]), ch('flipDirection', 'Dirección de giro', [['positive', 'Positiva'], ['negative', 'Negativa'], ['random', 'Aleatoria']]), ch('flipOrder', 'Orden de giro', [['lr', 'De izquierda a derecha'], ['rl', 'De derecha a izquierda'], ['tb', 'De arriba abajo'], ['bt', 'De abajo arriba'], ['tlbr', 'De arriba izquierda a abajo derecha'], ['trbl', 'De arriba derecha a abajo izquierda'], ['bltr', 'De abajo izquierda a arriba derecha'], ['brtl', 'De abajo derecha a arriba izquierda'], ['gradient', 'Degradado']]), ly('gradient', 'Capa de degradado'), n('timing', 'Aleatoriedad de tiempo', 0, 0, 1), n('seed', 'Semilla aleatoria', 1, 1, 1000), ...CAMLIGHT, n('xJitter', 'Cantidad de oscilación X', 0, 0, 5), n('xJitterSpeed', 'Velocidad de oscilación X', 1, 0, 1000), n('yJitter', 'Cantidad de oscilación Y', 0, 0, 5), n('yJitterSpeed', 'Velocidad de oscilación Y', 1, 0, 1000), n('zJitter', 'Cantidad de oscilación Z', 0, 0, 25), n('zJitterSpeed', 'Velocidad de oscilación Z', 1, 0, 1000), n('xRotJitter', 'Cantidad de oscilación de rotación X', 0, 0, 360), n('xRotJitterSpeed', 'Velocidad de oscilación de rotación X', 1, 0, 1000), n('yRotJitter', 'Cantidad de oscilación de rotación Y', 0, 0, 360), n('yRotJitterSpeed', 'Velocidad de oscilación de rotación Y', 1, 0, 1000), n('zRotJitter', 'Cantidad de oscilación de rotación Z', 0, 0, 360), n('zRotJitterSpeed', 'Velocidad de oscilación de rotación Z', 1, 0, 1000)] },
  // CC Glass Wipe (GlassWipe): completion 0 %, layer to reveal, gradient layer, softness 10 (5–100, slider 5–20),
  // displacement amount 25 (0–500, slider 0–50)
  { id: 'ccGlassWipe', name: 'CC Glass Wipe', cat: 'Transición', params: [COMPLETION, ly('reveal', 'Capa que mostrar'), ly('gradient', 'Capa de degradado (vacía: la propia capa)'), n('softness', 'Suavidad', 10, 5, 100), n('displacement', 'Cantidad de desplazamiento', 25, 0, 500)] },
  // CC Image Wipe (ImageWipe): completion 0 %, border softness 10 %, auto softness off; gradient: layer, property
  // Luminance (of 8), blur 0 (0–100, slider 0–25), inverse gradient off
  { id: 'ccImageWipe', name: 'CC Image Wipe', cat: 'Transición', params: [COMPLETION, pc('softness', 'Suavidad del borde', 10), bo('autoSoftness', 'Suavidad automática'), ly('gradient', 'Capa de degradado (vacía: la propia capa)'), ch('property', 'Propiedad', [['red', 'Rojo'], ['green', 'Verde'], ['blue', 'Azul'], ['alpha', 'Alfa'], ['luminance', 'Luminancia'], ['lightness', 'Luminosidad'], ['hue', 'Tono'], ['saturation', 'Saturación']], 'luminance'), n('blur', 'Desenfoque', 0, 0, 100), bo('inverse', 'Invertir degradado')] },
  // CC Light Wipe (LightWipe): completion 0 %, centre, intensity 100 (0–400, slider 0–200), Doors|Round|Square
  // (Round), direction 0°, colour from source off, white, reverse transition off
  { id: 'ccLightWipe', name: 'CC Light Wipe', cat: 'Transición', params: [COMPLETION, pt('center', 'Centro'), n('intensity', 'Intensidad', 100, 0, 400), ch('shape', 'Forma', [['doors', 'Puertas'], ['round', 'Redonda'], ['square', 'Cuadrada']], 'round'), an('direction', 'Dirección', 0), bo('fromSource', 'Color del original'), co('color', 'Color', '#ffffff'), bo('reverse', 'Invertir transición')] },
  // CC Twister (Twister): completion 0 %, backside none, shading on, centre, axis −120°
  { id: 'ccTwister', name: 'CC Twister', cat: 'Transición', params: [COMPLETION, ly('backside', 'Reverso (vacío: la propia capa)'), bo('shading', 'Sombreado', true), pt('center', 'Centro'), an('axis', 'Eje', -120)] },
  // CC WarpoMatic (WarpoMatic): completion 0 (0–100), layer to reveal, reactor Brightness (of 4), smoothness 50
  // (5–250, slider 20–150), warp amount 25 (±1000, slider ±100), Joint|Opposing|Twisting, blend span 75 (1–100,
  // slider 50–100)
  { id: 'ccWarpoMatic', name: 'CC WarpoMatic', cat: 'Transición', params: [COMPLETION, ly('reveal', 'Capa que mostrar'), ch('reactor', 'Reactor', [['brightness', 'Brillo'], ['contrastDiff', 'Diferencias de contraste'], ['brightnessDiff', 'Diferencias de brillo'], ['localDiff', 'Diferencias locales']]), n('smoothness', 'Suavidad', 50, 5, 250), n('warpAmount', 'Cantidad de deformación', 25, -1000, 1000), ch('warpDirection', 'Dirección de deformación', [['joint', 'Conjunta'], ['opposing', 'Opuesta'], ['twisting', 'Torsión']]), n('blendSpan', 'Amplitud de fusión', 75, 1, 100)] },
];
