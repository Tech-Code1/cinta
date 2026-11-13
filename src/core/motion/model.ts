// Advanced mode (motion graphics): compositions made of layers whose properties can be keyframed or driven by
// expressions, in the spirit of After Effects. Pure TypeScript — no Node APIs — so the same code runs in the
// main process, the MCP server (Node) and the renderer (browser), where the canvas engine draws it.
import { uid } from '../model';

/** number, vector (position, scale, colour as number[] is not used: colours are '#rrggbb[aa]' strings), or text */
export type PVal = number | number[] | string;

export type Interp = 'linear' | 'bezier' | 'hold';

export interface Key {
  t: number;
  v: PVal;
  /** interpolation of the segment that LEAVES this key (default linear) */
  i?: Interp;
  /** temporal ease: first control point of the leaving segment, normalised [x 0..1, y] (y may overshoot) */
  eo?: [number, number];
  /** temporal ease: second control point of the ARRIVING segment, normalised [x 0..1, y] */
  ei?: [number, number];
  /** spatial (position): straight segment instead of the auto-bezier curve */
  sl?: boolean;
  /** temporal Continuous Bezier: incoming and outgoing speed locked together (graph editor / velocity dialog) */
  tc?: boolean;
  /** temporal Auto Bezier (speeds set from the neighbours, influence 16.67 %) */
  ta?: boolean;
}

export interface Prop<T extends PVal = PVal> {
  v: T;
  k?: Key[];
  /** expression (JavaScript, After Effects style: wiggle(), loopOut(), time, value…) */
  x?: string;
  /** expression switched off (kept but not evaluated) */
  xOff?: boolean;
}

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'hard-light'
  | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity' | 'add';
export const BLEND_MODES: { id: BlendMode; name: string }[] = [
  { id: 'normal', name: 'Normal' }, { id: 'add', name: 'Añadir' }, { id: 'multiply', name: 'Multiplicar' },
  { id: 'screen', name: 'Trama' }, { id: 'overlay', name: 'Superponer' }, { id: 'soft-light', name: 'Luz suave' },
  { id: 'hard-light', name: 'Luz fuerte' }, { id: 'color-dodge', name: 'Sobreexponer color' },
  { id: 'color-burn', name: 'Subexponer color' }, { id: 'darken', name: 'Oscurecer' }, { id: 'lighten', name: 'Aclarar' },
  { id: 'difference', name: 'Diferencia' }, { id: 'exclusion', name: 'Exclusión' }, { id: 'hue', name: 'Tono' },
  { id: 'saturation', name: 'Saturación' }, { id: 'color', name: 'Color' }, { id: 'luminosity', name: 'Luminosidad' },
];

export type MatteMode = 'alpha' | 'alphaInv' | 'luma' | 'lumaInv';
export const MATTE_MODES: { id: MatteMode; name: string }[] = [
  { id: 'alpha', name: 'Mate alfa' }, { id: 'alphaInv', name: 'Mate alfa invertido' },
  { id: 'luma', name: 'Mate de luminancia' }, { id: 'lumaInv', name: 'Mate de luminancia invertido' },
];

export interface Transform {
  anchor: Prop<number[]>;
  position: Prop<number[]>;
  scale: Prop<number[]>;
  /** Z rotation in degrees */
  rotation: Prop<number>;
  rotationX: Prop<number>;
  rotationY: Prop<number>;
  opacity: Prop<number>;
  /** Separate Dimensions: when present, Position is these three properties (position is then ignored) */
  positionX?: Prop<number>;
  positionY?: Prop<number>;
  positionZ?: Prop<number>;
}

export type MaskMode = 'add' | 'subtract' | 'intersect' | 'none';
export interface Mask {
  id: string;
  name: string;
  mode: MaskMode;
  inverted: boolean;
  /** closed bezier path, flat [x, y, inX, inY, outX, outY, …] (tangents relative to the vertex), layer pixels */
  path: Prop<number[]>;
  feather: Prop<number>;
  opacity: Prop<number>;
  expansion: Prop<number>;
  /** RotoBezier (Capa ▸ Máscara y trazado de forma ▸ RotoBézier): tangents computed from the vertices (capas.ts) */
  rotoBezier?: boolean;
  /** RotoBezier tension of each vertex, % (default 33.33) */
  tension?: number[];
  /** variable feather (Herramienta Calado de máscara): points along the edge with their own radius and tension */
  featherPts?: FeatherPoint[];
}
/** A feather point: on segment `seg` (from vertex seg to the next) at parameter u; radius px (+ out, − in); tension % */
export interface FeatherPoint { seg: number; u: number; r: number; tension: number }

/** merge: Combinar trazados — takes the closed outlines of the shapes below it (since the previous merge) and draws
 *  their boolean result with its own fill and stroke */
export type ShapeKind = 'rect' | 'ellipse' | 'star' | 'polygon' | 'path' | 'merge';
export type MergeMode = 'add' | 'subtract' | 'intersect' | 'exclude';
export interface ShapeItem {
  id: string;
  name: string;
  kind: ShapeKind;
  size: Prop<number[]>;
  roundness: Prop<number>;
  /** star / polygon */
  points: Prop<number>;
  outerRadius: Prop<number>;
  innerRadius: Prop<number>;
  /** path: flat bezier like masks */
  path: Prop<number[]>;
  closed: boolean;
  /** compound path: more closed contours (same flat bezier as path) filled together with it, like several Path
   *  items in one After Effects group; holes come from fill.rule */
  contours?: number[][];
  fill: { on: boolean; color: Prop<string>; opacity: Prop<number>; rule?: 'nonzero' | 'evenodd' };
  stroke: { on: boolean; color: Prop<string>; width: Prop<number>; opacity: Prop<number>; cap: 'butt' | 'round' | 'square'; join: 'miter' | 'round' | 'bevel'; dash: number[]; gradient?: { type: 'linear' | 'radial'; start: Prop<number[]>; end: Prop<number[]>; colors: string[] } };
  gradient?: { type: 'linear' | 'radial'; start: Prop<number[]>; end: Prop<number[]>; colors: string[] };
  trim?: { start: Prop<number>; end: Prop<number>; offset: Prop<number> };
  repeater?: { copies: Prop<number>; offset: number; position: Prop<number[]>; scale: Prop<number[]>; rotation: Prop<number>; startOpacity: Prop<number>; endOpacity: Prop<number> };
  /** Ondular trazados (Wiggle Paths): moves the outline with smooth noise; smooth = false keeps sharp corners (rock, crystal) */
  wiggle?: { size: Prop<number>; detail: Prop<number>; speed: Prop<number>; phase: Prop<number>; seed: number; smooth: boolean };
  /** Zigzag: alternating ridges along the outline (smooth = waves instead of points) */
  zigzag?: { size: Prop<number>; ridges: Prop<number>; smooth: boolean };
  /** Contraer y engordar: + pulls the vertices in and bulges the segments out (petals), − the opposite (spikes) */
  pucker?: { amount: Prop<number> };
  /** Redondear esquinas: radius px at every corner */
  roundCorners?: { radius: Prop<number> };
  /** Torcer: rotation that grows from the centre outwards */
  twist?: { angle: Prop<number>; center: Prop<number[]> };
  /** Desplazar trazados: grows (+) or shrinks (−) the outline */
  offset?: { amount: Prop<number>; join: 'miter' | 'round' | 'bevel'; miterLimit: number };
  merge?: { mode: MergeMode };
  /** Transformación de ondulación (Wiggle Transform): random wiggle of this group's transform, per repeater copy */
  wiggleTransform?: { speed: Prop<number>; correlation: Prop<number>; temporalPhase: Prop<number>; spatialPhase: Prop<number>; seed: number; anchor: Prop<number[]>; position: Prop<number[]>; scale: Prop<number[]>; rotation: Prop<number> };
  transform: { anchor: Prop<number[]>; position: Prop<number[]>; scale: Prop<number[]>; rotation: Prop<number>; opacity: Prop<number> };
}

export type SelectorShape = 'square' | 'rampUp' | 'rampDown' | 'triangle' | 'round' | 'smooth';
export type BasedOn = 'chars' | 'charsNoSpace' | 'words' | 'lines';
export interface RangeSelector {
  type: 'range';
  start: Prop<number>;
  end: Prop<number>;
  offset: Prop<number>;
  amount: Prop<number>;
  basedOn: BasedOn;
  shape: SelectorShape;
  mode: 'add' | 'subtract' | 'intersect';
  randomize: boolean;
  seed: number;
}
export interface WigglySelector {
  type: 'wiggly';
  maxAmount: Prop<number>;
  minAmount: Prop<number>;
  speed: Prop<number>;
  correlation: Prop<number>;
  basedOn: BasedOn;
  mode: 'add' | 'subtract' | 'intersect';
  seed: number;
}
export type Selector = RangeSelector | WigglySelector;
export interface TextAnimator {
  id: string;
  name: string;
  props: {
    position?: Prop<number[]>;
    scale?: Prop<number[]>;
    rotation?: Prop<number>;
    rotationY?: Prop<number>;
    /** X rotation (only with per-character 3D; Z is `rotation`) */
    rotationX?: Prop<number>;
    opacity?: Prop<number>;
    fill?: Prop<string>;
    stroke?: Prop<string>;
    tracking?: Prop<number>;
    blur?: Prop<number>;
    skew?: Prop<number>;
    /** shifts characters through the alphabet (decoder look) */
    charOffset?: Prop<number>;
    /** extruded 3D text (Animar ▸ Frontal / Bisel / Lateral / Posterior ▸ Color): colour of each surface */
    frontColor?: Prop<string>;
    bevelColor?: Prop<string>;
    sideColor?: Prop<string>;
    backColor?: Prop<string>;
  };
  selectors: Selector[];
}
export type AnimProp = keyof TextAnimator['props'];

export interface TextDoc {
  text: Prop<string>;
  font: string;
  weight: number;
  italic: boolean;
  size: Prop<number>;
  fill: Prop<string>;
  stroke: Prop<string>;
  strokeWidth: Prop<number>;
  tracking: Prop<number>;
  /** line height in px; 0 = 1.2 × size */
  leading: number;
  align: 'left' | 'center' | 'right';
  allCaps: boolean;
  animators: TextAnimator[];
  /** paragraph text: words wrap inside this box [width, height] centred on the layer origin; lines past it hide */
  box?: number[];
  /** After Effects' Enable Per-character 3D: every character is a card in 3D space (animator position z,
   *  X / Y / Z rotation), seen through the camera, hiding the others per pixel and lit by the lights */
  perChar3D?: boolean;
  /** text on a path (After Effects' Path Options): a mask of the layer; margins in px along it */
  path?: { mask: string; reverse: boolean; perpendicular: boolean; forceAlign: boolean; open?: boolean; firstMargin: Prop<number>; lastMargin: Prop<number> };
  /** variable font axes (tag → value, e.g. wght, wdth, slnt, opsz or the font's own), animatable; with any set,
   *  the glyphs are drawn from the font file's outlines at those values */
  axes?: Record<string, Prop<number>>;
  // ── «texto» line: After Effects' remaining Character / Paragraph attributes (all optional; see textstyle.ts) ──
  /** Character panel buttons (whole layer; `runs` override them for some characters) */
  fauxBold?: boolean;
  fauxItalic?: boolean;
  smallCaps?: boolean;
  /** Superíndice / Subíndice */
  script?: 'super' | 'sub' | 'none';
  /** Desplazamiento de línea de base (px, + up), Tsume (%), Ajustar verticalmente / horizontalmente (%) */
  baselineShift?: number;
  tsume?: number;
  vScale?: number;
  hScale?: number;
  /** Dígitos hindi (0-9 drawn as Arabic-Indic digits) */
  hindiDigits?: boolean;
  /** Tate-chu-yoko (vertical text: these characters sit side by side in one slot) */
  tcy?: boolean;
  /** character attributes applied to some characters: [s, e) UTF-16 offsets into the source text */
  runs?: { s: number; e: number; style: CharStyle }[];
  /** Orientación del texto: vertical (columns right to left) */
  vertical?: boolean;
  /** Alineación latina vertical estándar: half-width glyphs turn 90° in vertical text */
  romanStd?: boolean;
  /** Paragraph panel: justify (paragraph text) with the last line left / centre / right, or all */
  justify?: 'left' | 'center' | 'right' | 'all';
  indentLeft?: number;
  indentRight?: number;
  indentFirst?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  /** Separación automática (hyphenation of paragraph text) */
  hyphenate?: boolean;
  /** Composición multilínea (every) / línea por línea (single) de Adobe; absent = single, as before */
  composer?: 'every' | 'single';
}
/** Character attributes of a run of characters (After Effects applies them to the selected characters). */
export interface CharStyle {
  fauxBold?: boolean;
  fauxItalic?: boolean;
  allCaps?: boolean;
  smallCaps?: boolean;
  script?: 'super' | 'sub' | 'none';
  baselineShift?: number;
  tsume?: number;
  vScale?: number;
  hScale?: number;
  tcy?: boolean;
}

export interface FxInstance {
  id: string;
  fx: string;
  name: string;
  on: boolean;
  params: Record<string, Prop>;
  /** «Pintura» (paint tools): the strokes, in drawing order (see paint.ts) */
  strokes?: import('./paint').PaintStroke[];
  /** Warp Stabilizer: the analysis of the layer's footage (see warpstab.ts) */
  stab?: import('./warpstab').StabData;
  /** Roto Brush & Refine Edge: strokes, span and the propagated mattes (see roto.ts) */
  roto?: import('./roto').RotoData;
}

export type LayerType = 'video' | 'image' | 'solid' | 'text' | 'shape' | 'null' | 'adjustment' | 'camera' | 'light' | 'audio' | 'comp' | 'sequence' | 'model';

export type LightType = 'parallel' | 'spot' | 'point' | 'ambient' | 'environment';
export const LIGHT_TYPES: { id: LightType; name: string }[] = [
  { id: 'parallel', name: 'Paralela' }, { id: 'spot', name: 'Foco' }, { id: 'point', name: 'Puntual' }, { id: 'ambient', name: 'Ambiente' },
  { id: 'environment', name: 'Entorno' },
];
/** Light layer options (After Effects' Light Options). Lights only affect 3D layers. */
export interface LightOptions {
  type: LightType;
  color: Prop<string>;
  /** % (100 = full; may go above, or below 0 to darken) */
  intensity: Prop<number>;
  /** spot: cone angle and feather (°, %) */
  coneAngle: Prop<number>;
  coneFeather: Prop<number>;
  falloff: 'none' | 'smooth' | 'inverseSquare';
  radius: Prop<number>;
  falloffDistance: Prop<number>;
  castsShadows: boolean;
  shadowDarkness: Prop<number>;
  /** px of shadow softness */
  shadowDiffusion: Prop<number>;
  /** where parallel and spot lights point */
  poi: Prop<number[]>;
  /** environment light (Luz de entorno): the image or video layer used as the surrounding (HDRI) — lights 3D models
   *  and is reflected by them; Y rotation of the light layer turns it */
  envLayer?: string;
}
/** Material options of a 3D layer (how it takes lights and shadows). Percentages like After Effects. */
export interface Material {
  castsShadows: 'off' | 'on' | 'only';
  acceptsShadows: boolean;
  acceptsLights: boolean;
  ambient: Prop<number>;
  diffuse: Prop<number>;
  specular: Prop<number>;
  shininess: Prop<number>;
  metal: Prop<number>;
  /** extruded text and shapes (extrude.ts): colour of each surface (absent = automatic) */
  frontColor?: Prop<string>;
  bevelColor?: Prop<string>;
  sideColor?: Prop<string>;
  backColor?: Prop<string>;
}
export const newMaterial = (): Material => ({ castsShadows: 'off', acceptsShadows: true, acceptsLights: true, ambient: P(100), diffuse: P(50), specular: P(50), shininess: P(5), metal: P(100) });
export function newLightOptions(type: LightType, comp: { width: number; height: number }): LightOptions {
  return { type, color: P('#ffffff'), intensity: P(100), coneAngle: P(90), coneFeather: P(50), falloff: 'none', radius: P(500), falloffDistance: P(500), castsShadows: false, shadowDarkness: P(100), shadowDiffusion: P(0), poi: P([comp.width / 2, comp.height / 2, 0]) };
}
export const LAYER_TYPES: { id: LayerType; name: string }[] = [
  { id: 'text', name: 'Texto' }, { id: 'shape', name: 'Capa de forma' }, { id: 'solid', name: 'Sólido' },
  { id: 'null', name: 'Objeto nulo' }, { id: 'adjustment', name: 'Capa de ajuste' }, { id: 'camera', name: 'Cámara' },
  { id: 'light', name: 'Luz' }, { id: 'video', name: 'Vídeo' }, { id: 'image', name: 'Imagen' }, { id: 'audio', name: 'Audio' },
  { id: 'comp', name: 'Composición' }, { id: 'sequence', name: 'Secuencia (modo simple)' }, { id: 'model', name: 'Modelo 3D' },
];

/** A puppet pin: where it was put on the layer (rest, layer px) and where it is now (animatable, layer px). */
export interface PuppetPin { id: string; name: string; rest: number[]; position: Prop<number[]> }
/** Mesh: triangle size (px) and how far it reaches past the opaque edge (px). */
export interface Puppet { on: boolean; density: number; expansion: number; pins: PuppetPin[] }

/** Depth of field: layers away from the focus distance blur by aperture × |z − focus| / z × blur level. */
export interface CameraDof { on: boolean; focus: Prop<number>; aperture: Prop<number>; blur: Prop<number> }

/** Essential Graphics: a property of a layer inside this comp, exposed to every comp layer that nests it (path
 *  "source" on an image / video layer is Media Replacement: the override is a media id) */
export interface EssentialProp { id: string; name: string; layer: string; path: string }
/** Master Property of a comp layer: replaces the exposed property inside the nested comp, animated in this comp's time */
export interface EssentialOverride { id: string; name: string; prop: Prop }

export interface Layer {
  id: string;
  name: string;
  type: LayerType;
  /** label colour in the timeline */
  label: string;
  mediaId?: string;
  compId?: string;
  solid?: { color: string; width: number; height: number };
  text?: TextDoc;
  shapes?: ShapeItem[];
  camera?: { zoom: Prop<number>; poi: Prop<number[]>; dof?: CameraDof };
  light?: LightOptions;
  /** 3D layers: how lights and shadows act on it (defaults when absent) */
  material?: Material;
  /** 3D model layers (mediaId is the model file): animation clip, its speed / offset, scale and material overrides */
  model?: import('./model3d').ModelOptions;
  /** 3D text and shape layers: Opciones de geometría (bevel, extrusion — extrude.ts); flat when absent */
  geometry?: import('./extrude').GeometryOptions;
  /** comp time of source time 0 */
  start: number;
  /** visible span in comp time */
  in: number;
  out: number;
  /** time stretch (1 = 100 %, −1 = reversed) */
  stretch: number;
  timeRemap?: Prop<number>;
  hidden: boolean;
  solo: boolean;
  locked: boolean;
  shy: boolean;
  threeD: boolean;
  motionBlur: boolean;
  /** frame blending of a time-stretched / remapped video: cross-fade the two nearest source frames (Frame Mix; true is
   *  the same) or build the in-between frame from the motion of every pixel (Pixel Motion) */
  frameBlend?: boolean | 'mix' | 'pixel';
  /** footage drawn cropped to cover the layer's frame (set while rendering a Media Replacement) */
  fit?: 'cover';
  blend: BlendMode;
  matte?: { layer: string; mode: MatteMode };
  parent?: string;
  transform: Transform;
  masks: Mask[];
  effects: FxInstance[];
  /** layer styles (drop shadow, glows, bevel, overlays, stroke): one of each kind, drawn after the effects */
  styles?: FxInstance[];
  /** Puppet tool: pins that bend the layer (applied before masks' effects, like the Puppet effect at the top) */
  puppet?: Puppet;
  /** audio level in dB (video with sound, audio, sequence) */
  audio: { level: Prop<number>; muted: boolean };
  /** comp layers: Master Properties changed from the nested comp's Essential Graphics */
  overrides?: EssentialOverride[];
  /** open/closed state of the property tree in the timeline (UI only) */
  open?: string[];
  /** Capa de guía: shown in its own comp's panel, never rendered, exported or seen by comps that nest it */
  guide?: boolean;
}

export interface Comp {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  bg: string;
  /** render with a transparent background (exports with alpha) */
  transparent: boolean;
  layers: Layer[];
  workArea: [number, number];
  motionBlur: { on: boolean; shutter: number; phase: number; samples: number };
  markers: CompMarker[];
  /** Essential Graphics panel: properties exposed to the comps that nest this one (in panel order) */
  essential?: EssentialProp[];
  /** comp proxy: a pre-rendered movie (with alpha) the layers nesting this comp draw instead while `on` */
  proxy?: { path: string; on: boolean; hash?: string };
  /** Región de interés of the Composition panel (comp px [x, y, w, h]): previews draw only that area while on */
  roi?: { rect: [number, number, number, number]; on: boolean };
}
/** Composition marker: comment, duration (s) and Responsive Design – Time protected region */
export interface CompMarker { t: number; name: string; dur?: number; protected?: boolean }

// ───────────────────────── render queue ─────────────────────────
/** Render Settings of a queue item (After Effects' defaults are the "Best Settings" template). */
export interface RenderSettings {
  /** 1 full, 0.5 half, 1/3 third, 0.25 quarter (or any custom factor) */
  resolution: number;
  /** work area, the whole comp, or [from, to] in seconds */
  span: 'workArea' | 'comp' | [number, number];
  /** frames per second (null: the comp's) */
  fps: number | null;
  /** 'comp': as the comp's switches say; 'off': no motion blur */
  motionBlur: 'comp' | 'off';
  /** proxies: 'none' (final quality), 'current' (those switched on), 'all', 'comps' (comp proxies only) */
  proxies: 'none' | 'current' | 'all' | 'comps';
  /** 'draft' renders motion blur with fewer sub-frames (faster) */
  quality: 'best' | 'draft';
}
/** Output Module: one file per module, all fed with the same rendered frames. */
export interface OutputModule {
  id: string;
  format: string;
  /** file path or template: [projectName] [compName] [width] [height] [frameRate] [fileExtension] [date] */
  path: string;
  audio: boolean;
  quality?: 'high' | 'medium' | 'low';
}
export type RenderStatus = 'queued' | 'unqueued' | 'rendering' | 'done' | 'failed' | 'stopped';
export interface RenderItem {
  id: string;
  compId: string;
  status: RenderStatus;
  settings: RenderSettings;
  outputs: OutputModule[];
  /** last run: when, how long, what it wrote or why it failed */
  log?: { at: string; seconds: number; files: string[]; error?: string };
}
export const BEST_SETTINGS: RenderSettings = { resolution: 1, span: 'workArea', fps: null, motionBlur: 'comp', proxies: 'none', quality: 'best' };
export const DEFAULT_OUTPUT = '[compName].[fileExtension]';
/** Output file name from a template (After Effects' file name templates). */
export function outputName(tpl: string, o: { projectName: string; compName: string; width: number; height: number; fps: number; ext: string; date?: Date }): string {
  const d = o.date ?? new Date(), p2 = (n: number) => String(n).padStart(2, '0');
  const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_');
  return tpl.replace(/\[(\w+)\]/g, (all, k: string) => ({
    projectName: clean(o.projectName), compName: clean(o.compName), width: String(o.width), height: String(o.height), frameRate: String(o.fps), fileExtension: o.ext,
    date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
  } as Record<string, string>)[k] ?? all);
}

// ───────────────────────── factories ─────────────────────────
export const P = <T extends PVal>(v: T): Prop<T> => ({ v });

const LABELS = ['#e8455a', '#ff8a3d', '#ffd400', '#36c48f', '#1d6cff', '#6c5ce7', '#ff5fa2', '#00c2d1', '#a0a4b8'];
export const labelFor = (type: LayerType, i = 0) =>
  ({ text: '#e8455a', shape: '#1d6cff', solid: '#ff8a3d', null: '#a0a4b8', adjustment: '#ffffff', camera: '#ff5fa2', light: '#ffe08a', video: '#00c2d1', image: '#36c48f', audio: '#36c48f', comp: '#ffd400', sequence: '#6c5ce7', model: '#a0e0ff' } as Record<LayerType, string>)[type] ?? LABELS[i % LABELS.length];

export function newComp(o: Partial<Pick<Comp, 'name' | 'width' | 'height' | 'fps' | 'duration' | 'bg' | 'transparent'>> = {}): Comp {
  const duration = o.duration ?? 10;
  return {
    id: uid('k'),
    name: o.name ?? 'Composición 1',
    width: Math.max(2, Math.round(o.width ?? 1920)),
    height: Math.max(2, Math.round(o.height ?? 1080)),
    fps: o.fps ?? 30,
    duration,
    bg: o.bg ?? '#000000',
    transparent: o.transparent ?? false,
    layers: [],
    workArea: [0, duration],
    motionBlur: { on: true, shutter: 180, phase: -90, samples: 12 },
    markers: [],
  };
}

export function newTransform(w: number, h: number, cx: number, cy: number): Transform {
  return {
    anchor: P([w / 2, h / 2, 0]),
    position: P([cx, cy, 0]),
    scale: P([100, 100, 100]),
    rotation: P(0),
    rotationX: P(0),
    rotationY: P(0),
    opacity: P(100),
  };
}

export function newTextDoc(text: string, o: Partial<{ font: string; size: number; fill: string; weight: number; align: TextDoc['align'] }> = {}): TextDoc {
  return {
    text: P(text),
    font: o.font ?? 'Segoe UI',
    weight: o.weight ?? 700,
    italic: false,
    size: P(o.size ?? 96),
    fill: P(o.fill ?? '#ffffff'),
    stroke: P('#000000'),
    strokeWidth: P(0),
    tracking: P(0),
    leading: 0,
    align: o.align ?? 'center',
    allCaps: false,
    animators: [],
  };
}

export function newShape(kind: ShapeKind, o: Partial<{ w: number; h: number; color: string; stroke: string; strokeWidth: number; points: number; name: string; path: number[]; closed: boolean }> = {}): ShapeItem {
  const w = o.w ?? 400, h = o.h ?? (kind === 'ellipse' || kind === 'star' || kind === 'polygon' ? w : 300);
  const names: Record<ShapeKind, string> = { rect: 'Rectángulo', ellipse: 'Elipse', star: 'Estrella', polygon: 'Polígono', path: 'Trazado', merge: 'Combinar trazados' };
  return {
    id: uid('s'),
    name: o.name ?? names[kind],
    kind,
    size: P([w, h]),
    roundness: P(0),
    points: P(o.points ?? (kind === 'polygon' ? 6 : 5)),
    outerRadius: P(w / 2),
    innerRadius: P(w / 4),
    path: P(o.path ?? []),
    closed: o.closed ?? true,
    fill: { on: !!o.color || !o.stroke, color: P(o.color ?? '#1d6cff'), opacity: P(100) },
    stroke: { on: !!o.stroke, color: P(o.stroke ?? '#ffffff'), width: P(o.strokeWidth ?? 8), opacity: P(100), cap: 'round', join: 'round', dash: [] },
    transform: { anchor: P([0, 0]), position: P([0, 0]), scale: P([100, 100]), rotation: P(0), opacity: P(100) },
  };
}

/** Rectangle / ellipse as a closed bezier path (for masks and the pen tool). */
export function rectPath(x: number, y: number, w: number, h: number): number[] {
  return [x, y, 0, 0, 0, 0, x + w, y, 0, 0, 0, 0, x + w, y + h, 0, 0, 0, 0, x, y + h, 0, 0, 0, 0];
}
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): number[] {
  const k = 0.5523;
  return [
    cx, cy - ry, -rx * k, 0, rx * k, 0,
    cx + rx, cy, 0, -ry * k, 0, ry * k,
    cx, cy + ry, rx * k, 0, -rx * k, 0,
    cx - rx, cy, 0, ry * k, 0, -ry * k,
  ];
}

export function newMask(path: number[], name = 'Máscara 1'): Mask {
  return { id: uid('m'), name, mode: 'add', inverted: false, path: P(path), feather: P(0), opacity: P(100), expansion: P(0) };
}

export function newLayer(type: LayerType, comp: Comp, o0: Partial<Layer> & { w?: number; h?: number } = {}): Layer {
  const o = Object.fromEntries(Object.entries(o0).filter(([, v]) => v !== undefined)) as typeof o0;
  const w = o.w ?? comp.width, h = o.h ?? comp.height;
  // text, shape, null and camera layers have their origin at (0,0): anchor 0, position = comp centre
  const originAtZero = type === 'text' || type === 'shape' || type === 'null' || type === 'camera' || type === 'light' || type === 'model';
  const tr = originAtZero ? newTransform(0, 0, comp.width / 2, comp.height / 2) : newTransform(w, h, comp.width / 2, comp.height / 2);
  const names: Record<LayerType, string> = { text: 'Texto', shape: 'Capa de forma', solid: 'Sólido', null: 'Nulo', adjustment: 'Capa de ajuste', camera: 'Cámara 1', light: 'Luz 1', video: 'Vídeo', image: 'Imagen', audio: 'Audio', comp: 'Composición', sequence: 'Secuencia', model: 'Modelo 3D' };
  const layer: Layer = {
    id: uid('l'),
    name: names[type],
    type,
    label: labelFor(type, comp.layers.length),
    start: 0,
    in: 0,
    out: comp.duration,
    stretch: 1,
    hidden: false,
    solo: false,
    locked: false,
    shy: false,
    threeD: type === 'camera' || type === 'light' || type === 'model',
    motionBlur: false,
    blend: 'normal',
    transform: tr,
    masks: [],
    effects: [],
    audio: { level: P(0), muted: false },
    ...o,
  };
  delete (layer as Partial<Layer> & { w?: number }).w;
  delete (layer as Partial<Layer> & { h?: number }).h;
  if (type === 'solid' || type === 'adjustment') layer.solid ??= { color: type === 'adjustment' ? '#ffffff' : '#1d6cff', width: w, height: h };
  if (type === 'text') layer.text ??= newTextDoc('Texto');
  if (type === 'shape') layer.shapes ??= [];
  if (type === 'light') {
    layer.light ??= newLightOptions('point', comp);
    layer.transform.position = P([comp.width * 0.3, comp.height * 0.3, -comp.width * 0.4]);
  }
  if (type === 'camera') {
    const zoom = defaultZoom(comp.width);
    layer.camera ??= { zoom: P(zoom), poi: P([comp.width / 2, comp.height / 2, 0]) };
    layer.transform.position = P([comp.width / 2, comp.height / 2, -zoom]);
  }
  return layer;
}

/** After Effects' 50 mm preset: the z = 0 plane is shown at 100 %. */
export const defaultZoom = (compWidth: number) => Math.round((compWidth / 2) / Math.tan((39.6 / 2) * (Math.PI / 180)));

/** Layer time (source seconds) for a comp time. */
export function sourceTime(l: Layer, t: number): number {
  return (t - l.start) / (l.stretch || 1);
}

export function findComp(comps: Comp[] | undefined, id: string): Comp {
  const c = comps?.find((x) => x.id === id || x.name === id);
  if (!c) throw new Error(`No existe la composición «${id}».`);
  return c;
}
export function findLayer(comp: Comp, id: string | number): Layer {
  const l = typeof id === 'number' ? comp.layers[id - 1] : comp.layers.find((x) => x.id === id || x.name === id);
  if (!l) throw new Error(`No existe la capa «${id}» en «${comp.name}».`);
  return l;
}

/** Fills defaults of compositions read from disk (older files, hand-written JSON from the MCP). */
export function validateComps<T extends { comps?: Comp[] }>(p: T): T {
  for (const c of p.comps ?? []) {
    c.layers ??= [];
    c.markers ??= [];
    c.workArea ??= [0, c.duration];
    c.motionBlur ??= { on: true, shutter: 180, phase: -90, samples: 12 };
    for (const l of c.layers) {
      l.masks ??= [];
      l.effects ??= [];
      l.audio ??= { level: P(0), muted: false };
      l.stretch ||= 1;
      l.blend ??= 'normal';
      for (const k of ['rotationX', 'rotationY'] as const) l.transform[k] ??= P(0);
      if (l.text) l.text.animators ??= [];
    }
  }
  return p;
}
