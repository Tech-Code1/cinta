// Canal 3D (3D Channel) effects and the matte refiners of After Effects 2024. Parameters, defaults, ranges and
// popups follow each effect as After Effects shows it; the Refine mattes («ADBE RefineMatte» and «ADBE RefineMatte2»)
// follow Adobe's documentation. Names are those of AE's Spanish interface. Drawing: src/motion-render/fx-groups/canal3d.ts.
//
// Input of the 3D Channel effects, in this order:
//  1. EXR footage (exr_import) with the channel the effect reads (Z depth, object / material ID, normals, UV,
//     coverage, background RGB), found by its usual names or the one typed in «Canal EXR»;
//  2. Cinta's own 3D render: on a layer, the depth of the layer itself as seen by the comp camera (a 2D layer lies on
//     the z = 0 plane), its index as object / material ID; on an adjustment layer, the depth buffer of everything
//     below it in the comp (3D layers, 3D models and extruded layers by their per-pixel depth, 2D layers on z = 0),
//     each layer's index as object / material ID.
// Depth is the distance from the camera along its axis in comp pixels (AE's camera units); empty = infinitely far.
import type { FxDef } from '../effects';
import { n, pc, co, bo, ly, ch, tx } from '../fxparams';

const C3 = 'Canal 3D', MT = 'Mate';
/** 3D Channel Extract's channels (Aux_Channel_Extract: Z-Depth first) */
export const AUX_CHANNELS: [string, string][] = [['zDepth', 'Profundidad-Z'], ['objectId', 'ID del objeto'], ['uv', 'Textura UV'], ['normals', 'Superficie normal'], ['coverage', 'Cobertura'], ['bgRgb', 'RGB de fondo'], ['unclampedRgb', 'RGB liberado'], ['materialId', 'ID del material']];
const EXR = tx('exrChannel', 'Canal EXR (vacío: automático)');
/** Motion Blur and Decontamination groups shared by both Refine mattes */
const REFINE_TAIL = [pc('reduceChatter', 'Reducir inestabilidad', 0), bo('useMotionBlur', 'Usar desenfoque de movimiento'), n('mbSamples', 'Desenfoque de movimiento: muestras por fotograma', 16, 1, 64), n('mbShutter', 'Desenfoque de movimiento: ángulo de obturación', 180, 0, 720), bo('mbHigherQuality', 'Desenfoque de movimiento: calidad más alta', true),
  bo('decontaminate', 'Depurar colores de bordes', true), pc('deconAmount', 'Depuración: cantidad', 100), bo('deconExtend', 'Depuración: ampliar en zona de suavizado', true), n('deconRadius', 'Depuración: aumentar radio', 0, 0, 100), bo('deconView', 'Depuración: ver mapa')];

export const FX_CANAL3D: FxDef[] = [
  // 3D Channel Extract (Aux_Channel_Extract): channel Z-Depth; black point −10000, white point 10000 (valid ±10⁷,
  // slider ±10000) for Z; Anti-alias off, Clamp Output on, Invert Depth Map off
  { id: 'channel3dExtract', name: 'Extraer Canal 3D', cat: C3, params: [ch('channel', 'Canal 3D', AUX_CHANNELS), n('blackPoint', 'Punto negro', -10000, -10000000, 10000000), n('whitePoint', 'Punto blanco', 10000, -10000000, 10000000), bo('antiAlias', 'Suavizar'), bo('clamp', 'Salida de abrazadera', true), bo('invert', 'Invertir mapa de profundidad'), EXR] },
  // Depth of Field (Depth_Field): focal plane 0 (valid ±10⁷, slider ±10000), maximum radius 0 (0…1000, slider
  // 0…100), focal plane thickness 0 (0…10000, slider 0…1000), focal bias 50 (0…100)
  { id: 'depthOfField', name: 'Profundidad de campo', cat: C3, params: [n('focalPlane', 'Plano focal', 0, -10000000, 10000000), n('maxRadius', 'Radio máximo', 0, 0, 1000), n('thickness', 'Grosor del plano focal', 0, 0, 10000), n('bias', 'Referencia focal', 50, 0, 100), EXR], still: true }, // a flat layer has one depth: a uniform blur (the catalogue's ramp barely changes)
  // Depth Matte (Depth_Matte): depth 0 (valid ±10⁷, slider ±1000), feather 0 (0…10⁷, slider 0…1000), Invert off
  { id: 'depthMatte', name: 'Mate de profundidad', cat: C3, params: [n('depth', 'Profundidad', 0, -10000000, 10000000), n('feather', 'Calado', 0, 0, 10000000), bo('invert', 'Invertir'), EXR], probe: { depth: 100000 } },
  // Fog 3D (Fog_3d): white fog, start / end depth 0 (valid ±10⁷, slider ±1000), opacity 100, scattering density
  // 50 (0…100), Foggy Background on, gradient layer none, layer contribution 0 (0…100)
  { id: 'fog3d', name: 'Niebla 3D', cat: C3, params: [co('color', 'Color de niebla', '#ffffff'), n('start', 'Profundidad inicial de niebla', 0, -10000000, 10000000), n('end', 'Profundidad final de niebla', 0, -10000000, 10000000), n('opacity', 'Opacidad de niebla', 100, 0, 100), n('density', 'Densidad de dispersión', 50, 0, 100), bo('foggyBg', 'Fondo nubloso', true), ly('gradient', 'Capa de degradación'), n('contribution', 'Aportación de la capa', 0, 0, 100), EXR], probe: { end: 4000, opacity: 80 } },
  // ID Matte (ID_Matte): aux channel Object ID (Material ID | Object ID), ID selection 0 (0…32000, slider 0…50),
  // feather 0 (0…32000, slider 0…10), Invert and Use Coverage off
  { id: 'idMatte', name: 'ID de mate', cat: C3, params: [ch('aux', 'Canal auxiliar', [['materialId', 'ID del material'], ['objectId', 'ID del objeto']], 'objectId'), n('id', 'Selección de ID', 0, 0, 32000), n('feather', 'Calado', 0, 0, 32000), bo('invert', 'Invertir'), bo('coverage', 'Utilizar cobertura'), EXR] },
  // Refine Hard Matte («ADBE RefineMatte»): smooth, feather, choke and shift edge on a hard-edged matte, chatter
  // reduction across frames, motion blur of the matte and edge colour decontamination (on, 100 %)
  { id: 'refineHardMatte', name: 'Perfeccionar mate fuerte', cat: MT, params: [n('smooth', 'Suave', 0, 0, 100), pc('feather', 'Calado', 0), pc('choke', 'Retraer', 0, -100, 100), pc('shiftEdge', 'Desplazamiento de borde', 0, -100, 100), ...REFINE_TAIL], probe: { deconView: 1 } },
  // Refine Soft Matte («ADBE RefineMatte2»): edge details computed in a band round the matte edge (Calculate Edge
  // Details on, additional edge radius, view the band), then smooth, feather, contrast, shift edge and the same
  // chatter / motion blur / decontamination stages
  { id: 'refineSoftMatte', name: 'Perfeccionar mate suave', cat: MT, params: [bo('edgeDetails', 'Calcular detalles de borde', true), n('edgeRadius', 'Radio de borde adicional', 0, 0, 100), bo('viewEdge', 'Ver región de borde'), n('smooth', 'Suave', 0, 0, 100), pc('feather', 'Calado', 0), pc('contrast', 'Contraste', 0), pc('shiftEdge', 'Desplazamiento de borde', 0, -100, 100), ...REFINE_TAIL], probe: { viewEdge: 1 } },
];

// ───────────────────────── EXR channels ─────────────────────────
const low = (s: string) => s.toLowerCase();
/** The first name of `names` matching one of the patterns (tried in order). */
const pick = (names: string[], pats: RegExp[]) => { for (const re of pats) { const n0 = names.find((c) => re.test(c)); if (n0) return n0; } return ''; };
/** Z depth: Z, depth.Z, ZDepth, Z_depth, depth.R/V… (never a normal's or a position's .Z) */
export const exrDepth = (names: string[]) => pick(names, [/^z$/i, /^(depth|zdepth|z_depth|z)\.(z|r|v|y)$/i, /^(zdepth|z_depth|depth)$/i, /(^|[._])(z_?depth|depth)(\.(z|r|v|y))?$/i]);
export const exrObjectId = (names: string[]) => pick(names, [/^(objectid|object_id|objid|id)$/i, /(^|\.)(objectid|object_id|objid|id)(\.(r|x|v))?$/i]);
export const exrMaterialId = (names: string[]) => pick(names, [/^(materialid|material_id|matid|mat_id)$/i, /(^|\.)(materialid|material_id|matid|mat_id)(\.(r|x|v))?$/i]);
export const exrCoverage = (names: string[]) => pick(names, [/^(coverage|cov)$/i, /(^|\.)(coverage|cov)(\.(r|a|v))?$/i]);
/** three channels of a layer (normals N.X/Y/Z or .R/G/B, UV, background), or [] */
function triple(names: string[], layers: RegExp, comps: string[][]): string[] {
  for (const set of comps) {
    const found = set.map((c) => names.find((nm) => { const i = nm.lastIndexOf('.'); return i > 0 && layers.test(nm.slice(0, i)) && low(nm.slice(i + 1)) === c; }));
    if (found.every(Boolean)) return found as string[];
  }
  return [];
}
export const exrNormals = (names: string[]) => triple(names, /^(n|normal|normals|nn|ns)$/i, [['x', 'y', 'z'], ['r', 'g', 'b']]);
export const exrUV = (names: string[]) => triple(names, /^(uv|st|texcoord|uvs)$/i, [['u', 'v'], ['x', 'y'], ['r', 'g'], ['s', 't']]);
export const exrBackground = (names: string[]) => triple(names, /^(background|bg|back)$/i, [['r', 'g', 'b'], ['red', 'green', 'blue']]);
export const exrBeauty = (names: string[]) => ['R', 'G', 'B'].every((c) => names.includes(c)) ? ['R', 'G', 'B'] : [];

/** The EXR channels an effect of this file reads from footage (render.ts asks the EXR reader for them). */
export function canal3dChannels(fx: string, v: (k: string) => string, names: string[]): string[] {
  const own = v('exrChannel');
  if (own && names.includes(own)) return [own];
  const out: string[] = [];
  const add = (...c: string[]) => { for (const k of c) if (k) out.push(k); };
  if (fx === 'depthOfField' || fx === 'depthMatte' || fx === 'fog3d') add(exrDepth(names));
  else if (fx === 'idMatte') { add(v('aux') === 'materialId' ? exrMaterialId(names) : exrObjectId(names)); if (v('coverage') === '1') add(exrCoverage(names)); }
  else if (fx === 'channel3dExtract') {
    const c = v('channel') || 'zDepth';
    if (c === 'zDepth') add(exrDepth(names));
    else if (c === 'objectId') add(exrObjectId(names));
    else if (c === 'materialId') add(exrMaterialId(names));
    else if (c === 'coverage') add(exrCoverage(names));
    else if (c === 'normals') add(...exrNormals(names));
    else if (c === 'uv') add(...exrUV(names));
    else if (c === 'bgRgb') add(...exrBackground(names));
    else if (c === 'unclampedRgb') add(...exrBeauty(names));
  }
  return out;
}
