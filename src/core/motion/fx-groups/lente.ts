// Effects of the «lente» line of work (see fx-groups/index.ts): camera lens blur, the legacy Fast Blur, Pixel Motion
// Blur, Camera-Shake Deblur and Detail-preserving Upscale. Names, defaults, ranges and choices come from each plug-in's
// parameter list and AE's Spanish interface; the drawing is in src/motion-render/fx-groups/lente.ts.
// min / max are After Effects' valid ranges (its sliders are often narrower).
import type { FxDef } from '../effects';
import { n, pc, an, ly, ch, bo } from '../fxparams';

const BLUR = 'Desenfocar y enfocar';
/** ShapeBlur iris shapes (8; default Hexagon) */
const IRIS: [string, string][] = [['triangle', 'Triángulo'], ['square', 'Cuadrado'], ['pentagon', 'Pentágono'], ['hexagon', 'Hexágono'], ['heptagon', 'Heptágono'], ['octagon', 'Octágono'], ['nonagon', 'Nonágono'], ['decagon', 'Decágono']];

export const FX_LENTE: FxDef[] = [
  // ShapeBlur (Camera Lens Blur, ADBE Camera Lens Blur): blur radius 5 (0–500, slider 0–100); Iris Properties: shape
  // Hexagon, roundness 0 %, aspect ratio 1 (0.01–100, slider 0.01–4), rotation 0°, diffraction fringe 100 (0–500,
  // slider 0–100); Blur Map: layer (none), channel Luminance (5), placement Center Map, blur focal distance 0 (0–255:
  // a 0–1 value shown as a pixel level), invert off; Highlight: gain 0 (0–100), threshold 204 (0.8 shown as 0–255),
  // saturation 0 (0–100); Edge Behavior: repeat edge pixels on; use linear working space on
  { id: 'cameraLensBlur', name: 'Desenfoque de lente de cámara', cat: BLUR, params: [n('radius', 'Radio de desenfoque', 5, 0, 500),
    ch('shape', 'Propiedades de iris: forma', IRIS, 'hexagon'), pc('roundness', 'Propiedades de iris: redondez', 0), n('aspect', 'Propiedades de iris: proporción', 1, 0.01, 100), an('rotation', 'Propiedades de iris: rotación', 0), n('fringe', 'Propiedades de iris: halo de difracción', 100, 0, 500),
    ly('map', 'Desenfocar mapa: capa'), ch('mapChannel', 'Desenfocar mapa: canal', [['luma', 'Luminancia'], ['red', 'Rojo'], ['green', 'Verde'], ['blue', 'Azul'], ['alpha', 'Alfa']]), ch('mapPlacement', 'Desenfocar mapa: posición', [['center', 'Centrar mapa'], ['stretch', 'Estirar y ajustar mapa']]), n('focal', 'Desenfocar mapa: distancia focal de desenfoque', 0, 0, 255), bo('mapInvert', 'Desenfocar mapa: invertir desenfoque de mapa'),
    n('gain', 'Resaltar: ganancia', 0, 0, 100), n('threshold', 'Resaltar: umbral', 204, 0, 255), n('saturation', 'Resaltar: saturación', 0, 0, 100),
    bo('repeat', 'Comportamiento de borde: repetir píxeles del borde', true), bo('linear', 'Utilizar espacio de trabajo lineal', true)], probe: { radius: 12 } },
  // Fast_Blur (Fast Blur (Legacy), ADBE Fast Blur; in AE 2024's Obsolete menu): blurriness 0 (0–30000, slider 0–127),
  // Horizontal and Vertical (3), repeat edge pixels on
  { id: 'fastBlur', name: 'Desenfoque rápido (heredado)', cat: 'Obsoleto', params: [n('blurriness', 'Difuminación', 0, 0, 30000), ch('dims', 'Dimensiones de desenfoque', [['both', 'Horizontal y vertical'], ['h', 'Horizontal'], ['v', 'Vertical']]), bo('repeat', 'Repetir píxeles del borde', true)], probe: { blurriness: 20 } },
  // RollingShutter (Pixel Motion Blur, ADBE OFMotionBlur; Timewarp family strings): shutter control Manual (of
  // Manual | Automatic), shutter angle 180° (0–5000, slider 0–360), shutter samples 5 (1–256, slider 1–20), vector
  // detail 20 (5–100). Blurs along each pixel's motion, measured with optical flow between the neighbouring frames
  { id: 'pixelMotionBlur', name: 'Desenfoque de movimiento de píxeles', cat: 'Tiempo', still: true, params: [ch('shutterControl', 'Control del obturador', [['manual', 'Manual'], ['auto', 'Automático']]), n('shutterAngle', 'Ángulo de obturación', 180, 0, 5000), n('shutterSamples', 'Muestras del obturador', 5, 1, 256), n('vectorDetail', 'Detalle del vector', 20, 5, 100)] },
  // Deblur (Camera-Shake Deblur, ADBE CameraShakeDeblur): blur duration 5 frames (5 | 7 | 9), deblur method
  // Standard (| High Quality (slower)), strength 100 (0–200), shake sensitivity 50 (0–100). Blurry frames take the
  // detail of the sharpest frame around them, aligned with optical flow
  { id: 'cameraShakeDeblur', name: 'Estabilización del desenfoque de temblores', cat: BLUR, still: true, params: [ch('duration', 'Duración del desenfoque', [['5', '5 fotogramas'], ['7', '7 fotogramas'], ['9', '9 fotogramas']]), ch('method', 'Método de estabilización', [['standard', 'Estándar'], ['high', 'Calidad alta (más lento)']]), n('strength', 'Intensidad', 100, 0, 200), n('sensitivity', 'Sensibilidad de temblores', 50, 0, 100)] },
  // Upscale (Detail-preserving Upscale, ADBE Upscale; Distort): the buttons Fit to Comp Width / Height (here
  // switches that set the scale from the comp's size while on), scale 100 % (100–30000, slider 100–500), reduce noise
  // 0 %, detail 50 %, alpha Bicubic (of Detail-preserving | Bicubic)
  { id: 'upscale', name: 'Conservar detalles (ampliación)', cat: 'Distorsionar', params: [bo('fitWidth', 'Ajustar a ancho de comp.'), bo('fitHeight', 'Ajustar a alto de comp.'), pc('scale', 'Escala', 100, 100, 30000), pc('noise', 'Reducir ruido', 0), pc('detail', 'Detalle', 50), ch('alpha', 'Alfa', [['detail', 'Conservar detalles'], ['bicubic', 'Bicúbico']], 'bicubic')], probe: { scale: 150 } },
];
