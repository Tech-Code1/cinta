// Effects of the «tiempo» line of work (see fx-groups/index.ts): most of them read the layer at other moments (the
// time-effects block of src/motion-render/render.ts); the drawing is in src/motion-render/fx-groups/tiempo.ts.
// Names, defaults, ranges and choices follow each After Effects effect (Spanish names from AE's Spanish interface).
import type { FxDef } from '../effects';
import { n, pc, an, pt, bo, ly, ch } from '../fxparams';

/** CC Time Blend / Time Blend FX transfer modes (TimeBlendFX, 17 choices + a separator) */
const TRANSFER: [string, string][] = [['blend', 'Mezclar'], ['over', 'Componer encima'], ['under', 'Componer debajo'], ['screen', 'Trama'], ['add', 'Añadir'], ['softLight', 'Luz suave'], ['hardLight', 'Luz fuerte'], ['lighten', 'Aclarar'], ['darken', 'Oscurecer'], ['multiply', 'Multiplicar'], ['difference', 'Diferencia'], ['color', 'Color'], ['overlay', 'Superponer'], ['luminosity', 'Luminosidad'], ['blendClassic', 'Mezclar (clásico)'], ['overClassic', 'Componer encima (clásico)'], ['underClassic', 'Componer debajo (clásico)']];
/** CC Composite's «Composite Original» (CompositeObsolete, 35 modes in 8 groups; In Front by default) */
export const CC_COMPOSITE: [string, string][] = [['copy', 'Copiar'], ['behind', 'Detrás'], ['inFront', 'Delante'],
  ['darken', 'Oscurecer'], ['multiply', 'Multiplicar'], ['linearBurn', 'Subexposición lineal'], ['colorBurn', 'Subexponer color'], ['classicColorBurn', 'Subexponer color clásico'],
  ['add', 'Añadir'], ['lighten', 'Aclarar'], ['screen', 'Trama'], ['linearDodge', 'Sobreexposición lineal'], ['colorDodge', 'Sobreexponer color'], ['classicColorDodge', 'Sobreexponer color clásico'],
  ['overlay', 'Superponer'], ['softLight', 'Luz suave'], ['hardLight', 'Luz fuerte'], ['linearLight', 'Luz lineal'], ['vividLight', 'Luz intensa'], ['pinLight', 'Luz focal'], ['hardMix', 'Mezcla definida'],
  ['difference', 'Diferencia'], ['classicDifference', 'Diferencia clásica'], ['exclusion', 'Exclusión'],
  ['hue', 'Tono'], ['saturation', 'Saturación'], ['color', 'Color'], ['luminosity', 'Luminosidad'],
  ['stencilAlpha', 'Estarcir alfa'], ['stencilLuma', 'Estarcir luma'], ['silhouetteAlpha', 'Silueta alfa'], ['silhouetteLuma', 'Silueta luma'],
  ['addAlpha', 'Añadir alfa'], ['luminescentPremul', 'Premultiplicación luminiscente']];

export const FX_TIEMPO: FxDef[] = [
  // Deflicker as asked for (no After Effects 2024 plug-in has these controls: its «ADBE Deflicker» is the Color
  // Stabilizer, in fx-groups/generar.ts): Timelapse evens out each frame's exposure against the frames around it; High Frequency evens
  // out each row (the bands of lights flickering at the mains frequency with a rolling shutter); Detail Preservation
  // keeps the frame's own detail (100 %) or takes the average of the frames (0 %). Still: nothing flickers.
  { id: 'deflicker', name: 'Eliminar parpadeo', cat: 'Tiempo', still: true, params: [ch('mode', 'Modo', [['timelapse', 'Timelapse'], ['highFrequency', 'Alta frecuencia']]), n('frequency', 'Frecuencia de parpadeo (Hz)', 100, 1, 1000), n('frames', 'Fotogramas que promediar', 5, 2, 31), pc('detail', 'Conservación de detalles', 100)] },
  // Reduce Interlace Flicker (Fast_Blur, «ADBE Reduce Interlace Flicker»): softness 0 (valid 0…1000, slider
  // 0…3) blurs only vertically, taking away the high vertical frequencies that flicker on interlaced displays
  { id: 'reduceInterlaceFlicker', name: 'Reducir parpadeo entrelazado', cat: 'Desenfocar y enfocar', params: [n('softness', 'Suavizado', 0, 0, 1000)], probe: { softness: 3 } },
  // Time Difference (Difference2, «ADBE Difference»): target layer (none: flat «no difference»), time offset
  // 0 s (±2000), contrast 50 (±10000), absolute difference off, alpha channel Original (11 choices with two
  // separators): with contrast c, 127.5 + (layer − target) × c / 100, or |layer − target| × 2c / 100
  { id: 'timeDifference', name: 'Diferencia de tiempo', cat: 'Tiempo', params: [ly('target', 'Destino (la propia capa: otro momento de ella)'), n('offset', 'Compens. de tiempo (seg.)', 0, -2000, 2000), n('contrast', 'Contraste', 50, -10000, 10000), bo('absolute', 'Diferencia absoluta'), ch('alpha', 'Canal alfa', [['original', 'Original'], ['target', 'Destino'], ['blend', 'Fusionar'], ['max', 'Máx.'], ['full', 'Lleno'], ['lightness', 'Luminosidad del resultado'], ['maxResult', 'Resultado máx.'], ['alphaDiff', 'Diferencia alfa'], ['alphaDiffOnly', 'Sólo diferencia alfa']])] },
  // CC Time Blend FX (TimeBlendFX): one accumulation buffer shared by a Paste instance (blends the buffer into the
  // layer: transfer Blend, accumulation 0.75, clear to Transparent) and a Copy instance below it (Copy by default:
  // stores the image there for the next frame), so the effects between them feed back frame after frame
  { id: 'ccTimeBlendFx', name: 'CC Time Blend FX', cat: 'Tiempo', still: true, params: [ch('instance', 'Instancia', [['copy', 'Copiar'], ['paste', 'Pegar']]), ch('mode', 'Transferencia', TRANSFER), n('accumulation', 'Acumulación', 0.75, 0, 1), ch('clearTo', 'Borrar a', [['transparent', 'Transparente'], ['current', 'Fotograma actual']])] },
  // CC Block Load (BlockLoad): progressive loading in Scans passes (4, 1…16), each with blocks half the size of
  // the one before, loaded from the top; Completion 0…100 %; Start Cleared on; Bilinear off
  { id: 'ccBlockLoad', name: 'CC Block Load', cat: 'Estilizar', params: [n('completion', 'Finalización', 0, 0, 100), n('scans', 'Pasadas', 4, 1, 16), bo('startCleared', 'Empezar borrado', true), bo('bilinear', 'Bilineal')] },
  // CC Mr. Smoothie (MrSmoothie): the colours along the line from Sample A (25 %, 25 %) to Sample B (75 %, 75 %),
  // smoothed (4, 0…511), become a palette that the flow layer's property (Luminance by default) picks from, turned
  // by Phase and looped AB / BA / ABA / BAB (still: a plain solid has one colour along the line)
  { id: 'ccMrSmoothie', name: 'CC Mr. Smoothie', cat: 'Estilizar', still: true, params: [ly('flow', 'Capa de flujo (vacía: la propia capa)'), ch('property', 'Propiedad', [['red', 'Rojo'], ['green', 'Verde'], ['blue', 'Azul'], ['alpha', 'Alfa'], ['luminance', 'Luminancia'], ['lightness', 'Luminosidad'], ['hue', 'Tono'], ['saturation', 'Saturación']], 'luminance'), n('smoothness', 'Suavizado', 4, 0, 511), pt('sampleA', 'Muestra A', 0.25, 0.25), pt('sampleB', 'Muestra B', 0.75, 0.75), an('phase', 'Fase', 0), ch('loop', 'Bucle de color', [['AB', 'AB'], ['BA', 'BA'], ['ABA', 'ABA'], ['BAB', 'BAB']])] },
  // CC Composite (CompositeObsolete, «CC Composite»): the layer before its effects composited with the result:
  // opacity 100 %, In Front by default, RGB Only on (the result keeps its alpha)
  { id: 'ccComposite', name: 'CC Composite', cat: 'Canal', params: [pc('opacity', 'Opacidad', 100), ch('mode', 'Componer original', CC_COMPOSITE, 'inFront'), bo('rgbOnly', 'Solo RGB', true)], probe: { mode: 'difference' } },
  // CC Ripple Pulse (RipplePulse): the history of Pulse Level (100, ±10000: it must be animated) over the last
  // Time Span (1 s, 0…10) is the profile of a ripple spreading from Center to the layer's farthest corner; Amplitude
  // 100 (±10000) bends the image through its slope; Render Bump Map (RGBA) shows the height instead
  { id: 'ccRipplePulse', name: 'CC Ripple Pulse', cat: 'Distorsionar', still: true, params: [pt('center', 'Centro'), n('pulse', 'Nivel de pulso (animar)', 100, -10000, 10000), n('timeSpan', 'Intervalo de tiempo (s)', 1, 0, 10), n('amplitude', 'Amplitud', 100, -10000, 10000), bo('bumpMap', 'Procesar mapa de relieve (RGBA)')] },
];
