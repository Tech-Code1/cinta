// Effects of the «generar» line (see fx-groups/index.ts): After Effects 2024 effects Cinta lacked. Each entry follows
// After Effects' own plug-in (names from AE's Spanish interface; defaults, ranges, choices and order from
// the plug-in's parameter list); the drawing is in src/motion-render/fx-groups/generar.ts.
import type { FxDef } from '../effects';
import { n, pc, an, co, pt, bo, ch } from '../fxparams';

const GEN = 'Generar', NOISE = 'Ruido y granulado', UT = 'Utilidad', CC = 'Corrección de color', ST = 'Estilizar';
/** generator «Blending Mode» popups (ColorsQuad has Color too; TurbulentNoise does not) */
const BLEND: [string, string][] = [['none', 'Ninguno'], ['normal', 'Normal'], ['add', 'Añadir'], ['multiply', 'Multiplicar'], ['screen', 'Trama'], ['overlay', 'Superponer'], ['softLight', 'Luz suave'], ['hardLight', 'Luz fuerte'], ['colorDodge', 'Sobreexponer color'], ['colorBurn', 'Subexponer color'], ['darken', 'Oscurecer'], ['lighten', 'Aclarar'], ['difference', 'Diferencia'], ['exclusion', 'Exclusión'], ['hue', 'Tono'], ['saturation', 'Saturación'], ['color', 'Color'], ['luminosity', 'Luminosidad']];
/** Color Profile Converter's profiles: AE lists the ICC profiles installed; these are the common ones, built in */
export const PROFILES: [string, string][] = [['working', 'Espacio de trabajo del proyecto'], ['embedded', 'Incrustado'], ['srgb', 'sRGB IEC61966-2.1'], ['rec709', 'HDTV (Rec. 709)'], ['rec2020', 'ITU-R BT.2020'], ['adobeRgb', 'Adobe RGB (1998)'], ['prophoto', 'ProPhoto RGB'], ['linear', 'sRGB lineal (gamma 1,0)']];

export const FX_GENERAR: FxDef[] = [
  // 4-Color Gradient (ColorsQuad): points at 10 % / 90 % of the layer, yellow / green / magenta / blue, blend 100
  // (5…10000, slider 10…500), jitter 0 (0…500), opacity 100 %, blending mode None
  { id: 'fourColorGradient', name: 'Degradado de 4 colores', cat: GEN, params: [pt('point1', 'Posiciones y colores: punto 1', 0.1, 0.1), co('color1', 'Posiciones y colores: color 1', '#ffff00'), pt('point2', 'Posiciones y colores: punto 2', 0.9, 0.1), co('color2', 'Posiciones y colores: color 2', '#00ff00'),
    pt('point3', 'Posiciones y colores: punto 3', 0.1, 0.9), co('color3', 'Posiciones y colores: color 3', '#ff00ff'), pt('point4', 'Posiciones y colores: punto 4', 0.9, 0.9), co('color4', 'Posiciones y colores: color 4', '#0000ff'),
    n('blend', 'Fusionar', 100, 5, 10000), n('jitter', 'Variación', 0, 0, 500), pc('opacity', 'Opacidad', 100), ch('blendMode', 'Modo de fusión', BLEND, 'none')] },
  // Turbulent Noise (TurbulentNoise, «ADBE AIF Perlin Noise 3D»): Fractal Noise's parameters without Sub Rotation,
  // Sub Offset, Center Subscale and Cycle Evolution, plus Turbulence Factor (1.5, 1…4) in Evolution Options; blending
  // mode Normal
  { id: 'turbulentNoise', name: 'Ruido de turbulencia', cat: NOISE, params: [ch('type', 'Tipo fractal', [['basic', 'Básica'], ['turbulentSmooth', 'Turbulencia suave'], ['turbulent', 'Turbulencia básica'], ['turbulentSharp', 'Turbulencia intensa'], ['dynamic', 'Dinámica'], ['dynamicProgressive', 'Dinámica progresiva'], ['dynamicTwist', 'Giro dinámico'], ['max', 'Máx.'], ['smeary', 'Con marcas'], ['swirly', 'Espiral'], ['rocky', 'Rocoso'], ['cloudy', 'Nublado'], ['terrain', 'Terreno'], ['subscale', 'Subescala'], ['smallBumps', 'Pequeños golpes'], ['strings', 'Cadenas'], ['threads', 'Hebras']]),
    ch('noiseType', 'Tipo de ruido', [['block', 'Bloque'], ['linear', 'Lineal'], ['soft', 'Lineal suave'], ['spline', 'Polinomio']], 'soft'), bo('invert', 'Invertir'), n('contrast', 'Contraste', 100, 0, 10000), n('brightness', 'Brillo', 0, -10000, 10000),
    ch('overflow', 'Desbordamiento', [['clip', 'Clip'], ['soft', 'Fijación suave'], ['wrap', 'Volver a ajustar'], ['hdr', 'Permitir resultados HDR']], 'hdr'), an('rotation', 'Transformar: rotación', 0), bo('uniform', 'Transformar: escala uniforme', true),
    n('scale', 'Transformar: escala', 100, 1, 10000), n('scaleWidth', 'Transformar: anchura de la escala', 100, 1, 10000), n('scaleHeight', 'Transformar: altura de la escala', 100, 1, 10000), pt('offset', 'Transformar: turbulencias de desplazamiento'),
    bo('perspective', 'Transformar: desplazamiento de la perspectiva'), n('complexity', 'Complejidad', 6, 1, 20), pc('subInfluence', 'Configuración secundaria: influencia secundaria (%)', 70, 0, 10000), pc('subScaling', 'Configuración secundaria: escala secundaria', 56, 10, 10000),
    an('evolution', 'Evolución', 0), n('turbulence', 'Opciones de evolución: factor de turbulencia', 1.5, 1, 4), n('seed', 'Opciones de evolución: raíz aleatoria', 0, 0, 100000), pc('opacity', 'Opacidad', 100), ch('blendMode', 'Modo de fusión', BLEND.filter(([k]) => k !== 'color'), 'normal')] },
  // HDR Highlight Compression (ProfileToProfile, «ADBE HDR ToneMap»): Amount 0…100 (100), an ACE tone-mapping
  // transform of the highlights into the 0…1 range
  { id: 'hdrHighlightCompression', name: 'Compresión de resalte HDR', cat: UT, params: [n('amount', 'Nivel', 100, 0, 100)] },
  // Color Profile Converter (ProfileToProfile, «ADBE ProfileToProfile»): input profile and Linearize, output
  // profile and Linearize, Intent Relative Colorimetric, Black Point Compensation on, Scene-referred Profile
  // Compensation from the project (still: both profiles are the working space by default)
  { id: 'colorProfileConverter', name: 'Convertidor perfiles de color', cat: UT, params: [ch('input', 'Perfil de entrada', PROFILES, 'working'), bo('linearizeIn', 'Alinear perfil de entrada'), ch('output', 'Perfil de salida', PROFILES, 'working'), bo('linearizeOut', 'Alinear perfil de salida'),
    ch('intent', 'Propósito', [['perceptual', 'Perceptivo'], ['saturation', 'Saturación'], ['relative', 'Colorimétrica relativa'], ['absolute', 'Colorimétrica absoluta']], 'relative'), bo('bpc', 'Utilizar compensación de puntos negros', true),
    ch('sceneComp', 'Ref-escena: compens. de perfil', [['project', 'Utilizar ajuste del proyecto'], ['on', 'Activado'], ['off', 'Desactivado']])], probe: { output: 'rec2020' } },
  // Color Stabilizer (Deflicker, «ADBE Deflicker»): Set Frame (here the reference time in seconds of the
  // composition), Stabilize Levels (Brightness / Levels / Curves), Black Point (20 %, 50 %), Mid Point (50 %, 50 %),
  // White Point (80 %, 50 %), Sample Size 3 (1…50) (still: a still layer already matches its reference frame)
  { id: 'colorStabilizer', name: 'Estabilizador del color', cat: CC, still: true, params: [n('setFrame', 'Definir fotograma (s)', 0, 0, 100000), ch('stabilize', 'Estabilizar', [['brightness', 'Brillo'], ['levels', 'Niveles'], ['curves', 'Curvas']], 'levels'),
    pt('blackPoint', 'Punto negro', 0.2, 0.5), pt('midPoint', 'Punto medio', 0.5, 0.5), pt('whitePoint', 'Punto blanco', 0.8, 0.5), n('sampleSize', 'Tamaño de la muestra', 3, 1, 50)] },
  // CC Threshold (CycoreFXHD Threshold): Threshold 127.5 (half of 0…1), Channel Luminance / RGB / Saturation /
  // Alpha, Invert off, Blend w. Original 0 %
  { id: 'ccThreshold', name: 'CC Threshold', cat: ST, params: [n('threshold', 'Umbral', 127.5, 0, 255), ch('channel', 'Canal', [['luminance', 'Luminancia'], ['rgb', 'RGB'], ['saturation', 'Saturación'], ['alpha', 'Alfa']]), bo('invert', 'Invertir'), pc('blend', 'Mezclar con original', 0)] },
  // CC Threshold RGB (CycoreFXHD ThresholdRGB): a threshold per channel (127.5), an Invert per channel, blend 0 %
  { id: 'ccThresholdRGB', name: 'CC Threshold RGB', cat: ST, params: [n('red', 'Umbral de rojo', 127.5, 0, 255), n('green', 'Umbral de verde', 127.5, 0, 255), n('blue', 'Umbral de azul', 127.5, 0, 255), bo('invertRed', 'Invertir canal rojo'), bo('invertGreen', 'Invertir canal verde'), bo('invertBlue', 'Invertir canal azul'), pc('blend', 'Mezclar con original', 0)] },
  // CC Burn Film (CycoreFXHD BurnFilm): Burn 0 (0…100), Center (50 %, 50 %), Random Seed 0 (0…5000)
  { id: 'ccBurnFilm', name: 'CC Burn Film', cat: ST, params: [n('burn', 'Quemar', 0, 0, 100), pt('center', 'Centro'), n('seed', 'Semilla aleatoria', 0, 0, 5000)], probe: { burn: 50 } },
];
