// Effects of this line of work (see fx-groups/index.ts). Each entry follows After Effects' own plug-in
// (names, defaults, ranges and choices); the drawing is in src/motion-render/fx-groups/color.ts.
import type { FxDef, ParamDef } from '../effects';
import { n, pc, an, co, bo, ly, ch, tx } from '../fxparams';

const CC = 'Corrección de color', UT = 'Utilidad';
/** Selective Color's colours (PSL_Adjustments, Photoshop's order) */
export const SEL_COLORS: [string, string][] = [['reds', 'Rojos'], ['yellows', 'Amarillos'], ['greens', 'Verdes'], ['cyans', 'Cianes'], ['blues', 'Azules'], ['magentas', 'Magentas'], ['whites', 'Blancos'], ['neutrals', 'Neutros'], ['blacks', 'Negros']];
const CMYK: [string, string][] = [['C', 'cian'], ['M', 'magenta'], ['Y', 'amarillo'], ['K', 'negro']];
const rgbGroup = (pre: string, nm: string, d: [number, number, number], mn: number, mx: number): ParamDef[] => [['R', 'rojo'], ['G', 'verde'], ['B', 'azul']].map(([k, c], i) => n(`${pre}${k}`, `${nm}: ${c}`, d[i], mn, mx));

export const FX_COLOR: FxDef[] = [
  // HDR Compander (Exposure): Compress Range divides by Gain and applies 1/Gamma, Expand Range
  // undoes it (values above 1 can then go through 8-bit effects and come back)
  { id: 'hdrCompander', name: 'Compansor HDR', cat: UT, params: [ch('mode', 'Modo', [['compress', 'Comprimir rango'], ['expand', 'Expandir rango']]), n('gain', 'Ganancia', 1, 0.01, 100), n('gamma', 'Gamma', 1, 0.1, 10)], probe: { gain: 2 } },
  // Color Balance (HLS) (Color_HLS): hue angle, lightness and saturation ±100
  { id: 'colorBalanceHLS', name: 'Equilibrio de color (HLS)', cat: CC, params: [an('hue', 'Tono', 0), n('lightness', 'Luminosidad', 0, -100, 100), n('saturation', 'Saturación', 0, -100, 100)], probe: { hue: 90 } },
  // Gamma/Pedestal/Gain (Gpg): black stretch 1…4; per channel gamma (slider 0…3), pedestal and gain (slider ±2)
  { id: 'gammaPedestalGain', name: 'Gamma/Pedestal/Ganancia', cat: CC, params: [n('blackStretch', 'Estiramiento de negro', 1, 1, 4),
    ...[['r', 'Rojo'], ['g', 'Verde'], ['b', 'Azul']].flatMap(([k, nm]) => [n(`${k}Gamma`, `${nm}: gamma`, 1, 0, 3), n(`${k}Pedestal`, `${nm}: pedestal`, 0, -2, 2), n(`${k}Gain`, `${nm}: ganancia`, 1, -2, 2)])], probe: { rGain: 0.5 } },
  // Broadcast Colors (Broadcast_Colors): NTSC / PAL, how to make the colour safe (reduce luminance by default),
  // maximum signal amplitude 90…120 IRE (110)
  { id: 'broadcastColors', name: 'Colores de emisión', cat: CC, params: [ch('locale', 'Configuración regional de emisión', [['ntsc', 'NTSC'], ['pal', 'PAL']]), ch('method', 'Cómo hacer el color seguro', [['luma', 'Reducir luminancia'], ['sat', 'Reducir saturación'], ['keyUnsafe', 'Eliminar zonas no seguras'], ['keySafe', 'Eliminar zonas seguras']]), n('ire', 'Amplitud máxima de señal (IRE)', 110, 90, 120)], probe: { ire: 90 } },
  // Selective Color (PSL_Adjustments, Photoshop's): Relative / Absolute; cyan, magenta, yellow and black ±100 for
  // each of the nine colours
  { id: 'selectiveColor', name: 'Color selectivo', cat: CC, params: [ch('method', 'Método', [['relative', 'Relativo'], ['absolute', 'Absoluto']]),
    ...SEL_COLORS.flatMap(([k, nm]) => CMYK.map(([c, cn]) => n(`${k}${c}`, `${nm}: ${cn}`, 0, -100, 100)))], probe: { neutralsC: 100, blacksY: 100 } },
  // Color Link (ColorLink): a layer's sample colour (average by default, 5 % clipped) filling the layer with
  // its blending mode (Normal), opacity 100 %, optionally stenciled by the original alpha
  { id: 'colorLink', name: 'Vínculo de color', cat: CC, params: [ly('source', 'Capa de origen (vacía: la propia capa)'), ch('sample', 'Muestra', [['average', 'Promedio'], ['median', 'Mediana'], ['brightest', 'Más brillante'], ['darkest', 'Más oscuro'], ['maxRGB', 'RGB máximo'], ['minRGB', 'RGB mínimo'], ['avgAlpha', 'Alfa promedio'], ['medAlpha', 'Alfa mediana'], ['maxAlpha', 'Alfa máximo'], ['minAlpha', 'Alfa mínimo']]), n('clip', 'Recortar (%)', 5, 0, 50), bo('stencil', 'Estarcir alfa original'), pc('opacity', 'Opacidad', 100),
    ch('mode', 'Modo de fusión', [['normal', 'Normal'], ['add', 'Añadir'], ['multiply', 'Multiplicar'], ['screen', 'Trama'], ['overlay', 'Superponer'], ['soft-light', 'Luz suave'], ['hard-light', 'Luz fuerte'], ['color-dodge', 'Sobreexponer color'], ['color-burn', 'Subexponer color'], ['darken', 'Oscurecer'], ['lighten', 'Aclarar'], ['difference', 'Diferencia'], ['exclusion', 'Exclusión'], ['hue', 'Tono'], ['saturation', 'Saturación'], ['color', 'Color'], ['luminosity', 'Luminosidad']])] },
  // Cineon Converter (CineonEffect): Log to Linear by default, 10-bit black 95 / white 685, internal 0…1,
  // gamma 1.7, highlight rolloff 20
  { id: 'cineonConverter', name: 'Convertidor Cineon', cat: UT, params: [ch('type', 'Tipo de conversión', [['linToLog', 'Lineal a logarítmico'], ['logToLin', 'Logarítmico a lineal'], ['logToLog', 'Logarítmico a logarítmico']], 'logToLin'), n('black10', 'Punto negro de 10 bits', 95, 0, 1023), n('blackInt', 'Punto negro interno', 0, 0, 1), n('white10', 'Punto blanco de 10 bits', 685, 0, 1023), n('whiteInt', 'Punto blanco interno', 1, 0, 1), n('gamma', 'Gamma', 1.7, 0.01, 5), n('rolloff', 'Atenuación de iluminaciones', 20, 0, 150)] },
  // CC Toner (Toner): Duotone / Tritone (default) / Pentone / Solid, tones from white to black, blend 0 %
  { id: 'ccToner', name: 'CC Toner', cat: CC, params: [ch('tones', 'Tonos', [['duotone', 'Duotono'], ['tritone', 'Tritono'], ['pentone', 'Pentono'], ['solid', 'Sólido']], 'tritone'), co('highlights', 'Iluminaciones', '#ffffff'), co('brights', 'Brillos', '#c0aa78'), co('midtones', 'Medios tonos', '#806446'), co('darktones', 'Tonos oscuros', '#40320a'), co('shadows', 'Sombras', '#000000'), pc('blend', 'Mezclar con original', 0)] },
  // CC Color Offset (ColorOffset): a phase per channel; Wrap / Solarize / Polarize past the end
  { id: 'ccColorOffset', name: 'CC Color Offset', cat: CC, params: [an('red', 'Fase de rojo', 0), an('green', 'Fase de verde', 0), an('blue', 'Fase de azul', 0), ch('overflow', 'Desbordamiento', [['wrap', 'Envolver'], ['solarize', 'Solarizar'], ['polarize', 'Polarizar']])], probe: { red: 120 } },
  // CC Kernel (Kernel): a 3×3 convolution (identity by default, ±100), absolute values, divider 0.01…10000
  { id: 'ccKernel', name: 'CC Kernel', cat: UT, params: [bo('absolute', 'Valores absolutos'), ...[1, 2, 3].flatMap((l) => [1, 2, 3].map((c) => n(`k${l}${c}`, `Línea ${l}: ${c}`, l === 2 && c === 2 ? 1 : 0, -100, 100))), n('divider', 'Divisor', 1, 0.01, 10000), pc('blend', 'Mezclar con original', 0)], probe: { k22: 2 } },
  // CC Color Neutralizer (ColorNeutralizer): the colours sampled as unbalanced shadows / midtones / highlights
  // become neutral, plus a red / green / blue trim per range (±100); pinning keeps black and white, blend 0 %
  { id: 'ccColorNeutralizer', name: 'CC Color Neutralizer', cat: CC, params: [co('shadowsUnbalance', 'Desequilibrio de sombras', '#000000'), ...rgbGroup('sh', 'Sombras', [0, 0, 0], -100, 100), co('midtonesUnbalance', 'Desequilibrio de medios tonos', '#7f7f7f'), ...rgbGroup('mid', 'Medios tonos', [0, 0, 0], -100, 100), co('highlightsUnbalance', 'Desequilibrio de iluminaciones', '#ffffff'), ...rgbGroup('hi', 'Iluminaciones', [0, 0, 0], -100, 100), pc('pinning', 'Fijación', 0), pc('blend', 'Mezclar con original', 0)], probe: { midtonesUnbalance: '#9f6f5f' } },
  // Video Limiter (VideoLimiter): clip level 103 IRE (100 / 103 / 105 / 109), compression before clipping None
  // (3 / 5 / 10 / 20 %), gamut warning off in (240, 10, 220); it limits the composite signal (luma ± chroma)
  // (still: a legal image such as the catalogue test's stays as it is)
  { id: 'videoLimiter', name: 'Limitador de vídeo', cat: CC, still: true, params: [ch('clip', 'Nivel de recorte', [['100', '100 IRE (rango SMPTE)'], ['103', '103 IRE'], ['105', '105 IRE (preferido EBU R103)'], ['109', '109 IRE (límite SDI)']], '103'), ch('compression', 'Compresión antes de recortar', [['0', 'Ninguna'], ['3', '3 %'], ['5', '5 %'], ['10', '10 %'], ['20', '20 %']]), bo('gamutWarning', 'Advertencia de gama'), co('warningColor', 'Color de advertencia de gama', '#f00adc')] },
  // Grow Bounds (Grow_Bounds): 10 pixels (0…10000, slider 0…100) more room round the layer for the next effects
  { id: 'growBounds', name: 'Ampliar límites', cat: UT, still: true, params: [n('pixels', 'Píxeles', 10, 0, 10000)] },
  // CC Overbrights (CycoreFX Overbrights): shows what is over 1.0 (32 bpc): the Solid views scale the image down
  // to fit, the Clip views paint it in the clip colour (red); RGB Clip by default
  { id: 'ccOverbrights', name: 'CC Overbrights', cat: UT, still: true, params: [ch('channel', 'Canal', [['rgbSolid', 'RGB sólido'], ['lightSolid', 'Luminosidad sólida'], ['lumSolid', 'Luminancia sólida'], ['rgbClip', 'RGB recortado'], ['lightClip', 'Luminosidad recortada'], ['lumClip', 'Luminancia recortada']], 'rgbClip'), co('clipColor', 'Color de recorte', '#ff0000')] },
  // PS Arbitrary Map (PS_Arb_Map): a Photoshop .amp map (256 bytes: one curve; 768: red, green, blue; 1024 /
  // 1280: master + RGB (+ alpha)); identity until one is loaded; phase 0° shifts the input round the map, optionally
  // on alpha too
  { id: 'psArbMap', name: 'PS Mapa arbitrario', cat: CC, params: [an('phase', 'Fase', 0), bo('alphaPhase', 'Aplicar mapa de fase a alfa'), tx('map', 'Mapa (.amp, en hexadecimal)')], probe: { phase: 90 } },
  // Color Balance (Color_Balance, the old one): red / green / blue balance ±100 adds ±100 % to each channel
  { id: 'colorBalanceLegacy', name: 'Equilibrio de color (heredado)', cat: CC, params: [n('red', 'Equilibrio de rojo', 0, -100, 100), n('green', 'Equilibrio de verde', 0, -100, 100), n('blue', 'Equilibrio de azul', 0, -100, 100)], probe: { red: 50 } },
];
