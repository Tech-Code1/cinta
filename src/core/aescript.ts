// After Effects scripting (ExtendScript .jsx / .js) on Cinta's advanced mode. The script runs in its own V8
// context (node:vm) with a time limit and no require / process / host objects: aescript-runtime.ts builds AE's
// globals there (app, CompItem, Property, File, $, alert…) as handles that talk to this file through a single
// JSON string bridge. Every change goes through the advanced-mode operations, and the whole run is ONE undo step
// (app.beginUndoGroup / endUndoGroup are recorded). File / Folder can only read, inside the script's and the
// project's folders. What is supported is listed in docs/scripts-ae.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import vm from 'node:vm';
import type { Editor } from './ops';
import type { Project } from './model';
import * as M from './motion/index';
import { aeRuntime } from './aescript-runtime';

type Comp = M.Comp; type Layer = M.Layer; type PVal = M.PVal;
export interface ScriptOptions {
  /** the script file (its folder can be read; #include is relative to it) */
  file?: string;
  /** milliseconds (default 10 s) */
  timeout?: number;
  /** comp shown in the viewer: app.project.activeItem */
  activeComp?: string | null;
  /** more folders File / Folder may read */
  roots?: string[];
}
export interface ScriptLogLine { kind: 'log' | 'write' | 'alert' | 'confirm' | 'prompt' | 'error'; text: string }
export interface ScriptResult {
  ok: boolean;
  error?: { message: string; line?: number };
  log: ScriptLogLine[];
  /** the text of the log as After Effects' Info panel / ExtendScript console would show it */
  output: string;
  undoGroups: string[];
  changes: { compsAdded: string[]; compsRemoved: string[]; layersAdded: { comp: string; layer: string; type: string }[]; layersRemoved: number; keyframes: number; expressions: number; effects: number; dataItems: number };
  /** comp to show after the run (openInViewer, or the comp it created) */
  openComp?: string;
  seconds: number;
}

// ───────────────────────── AE names ↔ Cinta ─────────────────────────
/** After Effects effect match names → Cinta effect ids (where Cinta has the effect). */
export const AE_EFFECTS: Record<string, string> = {
  'ADBE Gaussian Blur 2': 'gaussianBlur', 'ADBE Gaussian Blur': 'gaussianBlur', 'ADBE Motion Blur': 'directionalBlur', 'ADBE Radial Blur': 'radialBlur', 'ADBE Compound Blur': 'compoundBlur',
  'ADBE Sharpen': 'sharpen', 'ADBE Brightness & Contrast 2': 'brightnessContrast', 'ADBE HUE SATURATION': 'hueSat', 'ADBE Easy Levels2': 'levels', 'ADBE Exposure2': 'exposure',
  'ADBE Lumetri': 'lumetri', 'ADBE Change Color': 'changeColor', 'ADBE CHANNEL MIXER': 'channelMixer', 'ADBE Shadow/Highlight': 'shadowHighlight', 'APC Colorama': 'colorama',
  'ADBE Equalize': 'equalize', 'ADBE AutoLevels': 'autoLevels', 'ADBE AutoContrast': 'autoContrast', 'ADBE AutoColor': 'autoColor', 'ADBE Leave Color': 'leaveColor',
  'ADBE CurvesCustom': 'curves', 'ADBE Pro Levels2': 'levelsRGB', 'ADBE Color Balance 2': 'colorBalance', 'ADBE Change To Color': 'changeToColor', 'ADBE Apply Color LUT2': 'applyLut',
  'ADBE Tint': 'tint', 'ADBE Tritone': 'tritone', 'ADBE Photo Filter': 'photoFilter', 'ADBE Fill': 'fill', 'ADBE Invert': 'invert', 'ADBE Black&White': 'blackWhite',
  'ADBE Posterize': 'posterize', 'ADBE Threshold2': 'threshold', 'ADBE Vibrance': 'vibrance', 'ADBE Glo2': 'glow', 'ADBE Drop Shadow': 'dropShadow', 'ADBE Set Matte3': 'setMatte',
  'ADBE Mosaic': 'mosaic', 'ADBE Find Edges': 'findEdges', 'ADBE Emboss': 'emboss', 'CC Vignette': 'vignette', 'ADBE Ramp': 'gradientRamp', 'ADBE Grid': 'grid',
  'ADBE Checkerboard': 'checkerboard', 'ADBE Circle': 'circle', 'ADBE Lens Flare': 'lensFlare', 'ADBE Stroke': 'stroke', 'ADBE Write-on': 'writeOn', 'ADBE Scribble Fill': 'scribble',
  'ADBE Radio Waves': 'radioWaves', 'ADBE Laser': 'beam', 'ADBE Vegas': 'vegas', 'CC Light Rays': 'lightRays', 'ADBE Fractal Noise': 'fractalNoise', 'ADBE Lightning': 'lightning',
  'ADBE Lightning 2': 'advancedLightning', 'ADBE Cell Pattern': 'cellPattern', 'ADBE Shatter': 'shatter', 'ADBE Caustics': 'caustics', 'ADBE Wave World': 'waveWorld', 'ADBE Foam': 'foam',
  'CC Particle World': 'particleWorld', 'ADBE Geometry2': 'transformFx', 'ADBE Displacement Map': 'displacementMap', 'ADBE Mirror': 'mirror', 'ADBE Offset': 'offset',
  'ADBE Wave Warp': 'waveWarp', 'ADBE Polar Coordinates': 'polar', 'ADBE Spherize': 'spherize', 'ADBE BEZMESH': 'bezierWarp', 'ADBE MESH WARP': 'meshWarp', 'ADBE Liquify': 'liquify',
  'CC Bend It': 'bendIt', 'CC Power Pin': 'powerPin', 'ADBE Corner Pin': 'cornerPin', 'ADBE Tile': 'motionTile', 'ADBE Twirl': 'twirl', 'ADBE Bulge': 'bulge', 'ADBE Ripple': 'ripple',
  'ADBE Turbulent Displace': 'turbulentDisplace', 'ADBE Linear Wipe': 'linearWipe', 'ADBE Gradient Wipe': 'gradientWipe', 'ADBE Radial Wipe': 'radialWipe', 'ADBE IRIS_WIPE': 'iris',
  'ADBE Venetian Blinds': 'venetianBlinds', 'ADBE Block Dissolve': 'blockDissolve', 'ADBE Noise': 'noise', 'Keylight 906': 'keylight', 'ADBE KeyCleaner': 'keyCleaner',
  'ADBE Spill2': 'spillSuppressor', 'ADBE Simple Choker': 'simpleChoker', 'ADBE Matte Choker': 'matteChoker', 'ADBE Color Key': 'colorKey', 'ADBE Luma Key': 'lumaKey',
  'ADBE AudSpect': 'audioSpectrum', 'ADBE AudWave': 'audioWaveform', 'ADBE Timewarp': 'timewarp', 'ADBE Time Displacement': 'timeDisplacement', 'CC Wide Time': 'wideTime',
  'ADBE Echo': 'echo', 'ADBE Posterize Time': 'posterizeTime', 'ADBE Slider Control': 'slider', 'ADBE Angle Control': 'angleCtrl', 'ADBE Checkbox Control': 'checkboxCtrl',
  'ADBE Color Control': 'colorCtrl', 'ADBE Point Control': 'pointCtrl', 'ADBE Layer Control': 'layerCtrl', 'ADBE Dropdown Control': 'dropdownCtrl', 'ADBE Box Blur2': 'boxBlur',
  'ADBE Channel Blur': 'channelBlur', 'ADBE Unsharp Mask2': 'unsharpMask', 'ADBE Smart Blur': 'smartBlur', 'ADBE Bilateral': 'bilateralBlur', 'CC Cross Blur': 'ccCrossBlur',
  'CC Radial Blur': 'ccRadialBlur', 'CC Radial Fast Blur': 'ccRadialFastBlur', 'CC Vector Blur': 'ccVectorBlur', 'VISINF Grain Implant': 'addGrain', 'VISINF Grain Removal': 'removeGrain',
  'ADBE Median': 'median', 'ADBE Dust & Scratches': 'dustScratches', 'ADBE Noise HLS2': 'noiseHLS', 'ADBE Noise HLS Auto2': 'noiseHLSAuto', 'ADBE Noise Alpha2': 'noiseAlpha',
  'ADBE Minimax': 'minimax', 'ADBE Shift Channels': 'shiftChannels', 'ADBE Set Channels': 'setChannels', 'ADBE Arithmetic': 'arithmetic', 'ADBE Solid Composite': 'solidComposite',
  'ADBE Blend': 'blend', 'ADBE Calculations': 'calculations', 'ADBE Compound Arithmetic': 'compoundArithmetic', 'ADBE Bevel Alpha': 'bevelAlpha', 'ADBE Bevel Edges': 'bevelEdges',
  'ADBE Radial Shadow': 'radialShadow', 'ADBE Basic 3D': 'basic3d', 'CC Cylinder': 'ccCylinder', 'CC Sphere': 'ccSphere', 'CC Page Turn': 'ccPageTurn', 'ADBE Optics Compensation': 'opticsComp',
  'ADBE Magnify': 'magnify', 'ADBE Scatter': 'scatter', 'ADBE Strobe': 'strobeLight', 'ADBE Brush Strokes': 'brushStrokes', 'ADBE Texturize': 'texturize', 'ADBE Roughen Edges': 'roughenEdges',
  'CC Kaleida': 'ccKaleida', 'ADBE Timecode': 'timecode', 'ADBE Numbers2': 'numbers', 'ADBE Paint Bucket': 'paintBucket', 'ADBE Cartoonify': 'cartoon', 'ADBE Color Emboss': 'colorEmboss',
  'ADBE Card Wipe': 'cardWipe', 'ADBE Gamma/Pedestal/Gain2': 'gammaPedestalGain', 'ADBE Broadcast Colors': 'broadcastColors', 'ADBE Ellipse': 'ellipse', 'ADBE Eyedropper Fill': 'eyedropperFill',
  // distorsion, round 5 (match names as in After Effects)
  'ADBE 3D Glasses2': 'glasses3d', 'CC Blobbylize': 'ccBlobbylize', 'ADBE RESHAPE': 'reshape', 'ADBE SCHMEAR': 'smear', 'ADBE Rolling Shutter': 'rollingShutter',
  // final round (match names read from each plug-in's resources)
  'CC Particle Systems II': 'ccParticleSystems2', 'CC Mr. Mercury': 'ccMrMercury', 'CC Hair': 'ccHair', 'CC Glue Gun': 'ccGlueGun', 'CC Environment': 'ccEnvironment', 'ADBE Fractal': 'fractal', 'VISINF Grain Duplication': 'matchGrain', 'CC Force Motion Blur': 'ccForceMotionBlur', 'ADBE SubspaceStabilizer': 'warpStabilizer',
  // round 7, generar (match names as in After Effects)
  'ADBE 4ColorGradient': 'fourColorGradient', 'ADBE AIF Perlin Noise 3D': 'turbulentNoise', 'ADBE HDR ToneMap': 'hdrHighlightCompression', 'ADBE ProfileToProfile': 'colorProfileConverter', 'ADBE Deflicker': 'colorStabilizer', 'CC Threshold': 'ccThreshold', 'CC Threshold RGB': 'ccThresholdRGB', 'CC Burn Film': 'ccBurnFilm',
  // lente, round 7 (match names as in After Effects)
  'ADBE Camera Lens Blur': 'cameraLensBlur', 'ADBE Fast Blur': 'fastBlur', 'ADBE OFMotionBlur': 'pixelMotionBlur', 'ADBE CameraShakeDeblur': 'cameraShakeDeblur', 'ADBE Upscale': 'upscale',
  // canal3d (match names as in After Effects)
  'ADBE AUX CHANNEL EXTRACT': 'channel3dExtract', 'ADBE DEPTH FIELD': 'depthOfField', 'ADBE DEPTH MATTE': 'depthMatte', 'ADBE FOG_3D': 'fog3d', 'ADBE ID MATTE': 'idMatte', 'ADBE RefineMatte': 'refineHardMatte', 'ADBE RefineMatte2': 'refineSoftMatte',
  // tiempo, round 7 (match names from inventario.json)
  'ADBE Reduce Interlace Flicker': 'reduceInterlaceFlicker', 'ADBE Difference': 'timeDifference', 'CC Time Blend FX': 'ccTimeBlendFx', 'CS BlockLoad': 'ccBlockLoad', 'CC Mr. Smoothie': 'ccMrSmoothie', 'CC Composite': 'ccComposite', 'CC Ripple Pulse': 'ccRipplePulse',
};
const BLEND_AE: Record<number, M.BlendMode> = { 5212: 'normal', 5220: 'add', 5216: 'multiply', 5219: 'screen', 5224: 'overlay', 5225: 'soft-light', 5226: 'hard-light', 5221: 'color-dodge', 5217: 'color-burn', 5215: 'darken', 5218: 'lighten', 5231: 'difference', 5232: 'exclusion', 5234: 'hue', 5235: 'saturation', 5236: 'color', 5237: 'luminosity' };
const LIGHT_AE: Record<number, M.LightType> = { 4401: 'parallel', 4402: 'spot', 4403: 'point', 4404: 'ambient' };
const INTERP: Record<number, 'linear' | 'bezier' | 'hold'> = { 6612: 'linear', 6613: 'bezier', 6614: 'hold' };

/** Property groups and properties: [English name, match name, Spanish name, Cinta path or group key]. */
type Child = [string, string, string, string];
const TRANSFORM: Child[] = [
  ['Anchor Point', 'ADBE Anchor Point', 'Punto de anclaje', 'transform.anchor'], ['Position', 'ADBE Position', 'Posición', 'transform.position'],
  ['X Position', 'ADBE Position_0', 'Posición X', 'transform.positionX'], ['Y Position', 'ADBE Position_1', 'Posición Y', 'transform.positionY'], ['Z Position', 'ADBE Position_2', 'Posición Z', 'transform.positionZ'],
  ['Scale', 'ADBE Scale', 'Escala', 'transform.scale'], ['X Rotation', 'ADBE Rotate X', 'Rotación X', 'transform.rotationX'], ['Y Rotation', 'ADBE Rotate Y', 'Rotación Y', 'transform.rotationY'],
  ['Rotation', 'ADBE Rotate Z', 'Rotación', 'transform.rotation'], ['Opacity', 'ADBE Opacity', 'Opacidad', 'transform.opacity'],
];
const ALIASES: Record<string, string> = { 'z rotation': 'transform.rotation', 'rotación z': 'transform.rotation', anchorpoint: 'transform.anchor', xrotation: 'transform.rotationX', yrotation: 'transform.rotationY', zrotation: 'transform.rotation', xposition: 'transform.positionX', yposition: 'transform.positionY', zposition: 'transform.positionZ' };
const CAMERA: Child[] = [['Zoom', 'ADBE Camera Zoom', 'Zoom', 'camera.zoom'], ['Focus Distance', 'ADBE Camera Focus Distance', 'Distancia de enfoque', 'camera.dof.focus'], ['Aperture', 'ADBE Camera Aperture', 'Apertura', 'camera.dof.aperture'], ['Blur Level', 'ADBE Camera Blur Level', 'Nivel de desenfoque', 'camera.dof.blur']];
const LIGHT: Child[] = [['Intensity', 'ADBE Light Intensity', 'Intensidad', 'light.intensity'], ['Color', 'ADBE Light Color', 'Color', 'light.color'], ['Cone Angle', 'ADBE Light Cone Angle', 'Ángulo de cono', 'light.coneAngle'], ['Cone Feather', 'ADBE Light Cone Feather 2', 'Desvanecimiento de cono', 'light.coneFeather'], ['Radius', 'ADBE Light Falloff Start', 'Radio', 'light.radius'], ['Falloff Distance', 'ADBE Light Falloff Distance', 'Distancia de atenuación', 'light.falloffDistance'], ['Shadow Darkness', 'ADBE Light Shadow Darkness', 'Oscuridad de sombra', 'light.shadowDarkness'], ['Shadow Diffusion', 'ADBE Light Shadow Diffusion', 'Difusión de sombra', 'light.shadowDiffusion']];
const SHAPE_ADD: Record<string, M.ShapeKind> = { 'ADBE Vector Shape - Rect': 'rect', 'ADBE Vector Shape - Ellipse': 'ellipse', 'ADBE Vector Shape - Star': 'star', 'ADBE Vector Shape - Group': 'path', 'ADBE Vector Filter - Merge': 'merge' };
const SHAPE_PROPS: Child[] = [
  ['Size', 'ADBE Vector Rect Size', 'Tamaño', 'size'], ['Size', 'ADBE Vector Ellipse Size', 'Tamaño', 'size'], ['Roundness', 'ADBE Vector Rect Roundness', 'Redondez', 'roundness'],
  ['Position', 'ADBE Vector Rect Position', 'Posición', 'transform.position'], ['Position', 'ADBE Vector Ellipse Position', 'Posición', 'transform.position'],
  ['Points', 'ADBE Vector Star Points', 'Puntos', 'points'], ['Outer Radius', 'ADBE Vector Star Outer Radius', 'Radio exterior', 'outerRadius'], ['Inner Radius', 'ADBE Vector Star Inner Radius', 'Radio interior', 'innerRadius'],
  ['Path', 'ADBE Vector Shape', 'Trazado', 'path'],
];
const VG_TRANSFORM: Child[] = [['Anchor Point', 'ADBE Vector Anchor', 'Punto de anclaje', 'transform.anchor'], ['Position', 'ADBE Vector Position', 'Posición', 'transform.position'], ['Scale', 'ADBE Vector Scale', 'Escala', 'transform.scale'], ['Rotation', 'ADBE Vector Rotation', 'Rotación', 'transform.rotation'], ['Opacity', 'ADBE Vector Group Opacity', 'Opacidad', 'transform.opacity']];
const FILL_PROPS: Child[] = [['Color', 'ADBE Vector Fill Color', 'Color', 'fill.color'], ['Opacity', 'ADBE Vector Fill Opacity', 'Opacidad', 'fill.opacity']];
const STROKE_PROPS: Child[] = [['Color', 'ADBE Vector Stroke Color', 'Color', 'stroke.color'], ['Opacity', 'ADBE Vector Stroke Opacity', 'Opacidad', 'stroke.opacity'], ['Stroke Width', 'ADBE Vector Stroke Width', 'Anchura del trazo', 'stroke.width']];
const lc = (s: unknown) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

// ── nombres (round 7): the rest of the catalog, and the AE display names ──
// Match names of the After Effects 2024 effects (the ones scripts use with addProperty). Also the real match name of effects that the table above
// lists under an early guess: the guess keeps working (AE_EFFECT_ALIASES), but AE's name is the one reported.
Object.assign(AE_EFFECTS, {
  'ADBE Three-Way Color Corrector': 'threeWay', 'ADBE Remove Color Matting': 'removeMatting', 'APC CardDanceCam': 'cardDance', 'CC Rain': 'rain', 'CC Snow': 'snow',
  'CC Time Blend': 'timeBlend', 'EXtractoR': 'extractor', 'IDentifier': 'identifier', 'Cryptomatte': 'cryptomatte', 'CC Simple Wire Removal': 'ccSimpleWireRemoval',
  'ADBE Channel Combiner': 'channelCombiner', 'ADBE Alpha Levels2': 'alphaLevels', 'ADBE Color Difference Key': 'colorDifferenceKey', 'ADBE Color Range': 'colorRange', 'ADBE ATG Extract': 'innerOuterKey',
  'ADBE Spill Suppressor': 'spillSuppression', 'ADBE Linear Color Key2': 'linearColorKey', 'ADBE Extract': 'extract', 'ADBE Difference Matte2': 'differenceMatte', 'ADBE Compander': 'hdrCompander',
  'ADBE Color Balance (HLS)': 'colorBalanceHLS', 'ADBE SelectiveColor': 'selectiveColor', 'ADBE Color Link': 'colorLink', 'ADBE Cineon Converter2': 'cineonConverter', 'CC Toner': 'ccToner',
  'CC Color Offset': 'ccColorOffset', 'CS Kernel': 'ccKernel', 'CS Color Neutralizer': 'ccColorNeutralizer', 'ADBE DigitalVideoLimiter': 'videoLimiter', 'ADBE GROW BOUNDS': 'growBounds',
  'CC Overbrights': 'ccOverbrights', 'ADBE PS Arbitrary Map': 'psArbMap', 'ADBE Color Balance': 'colorBalanceLegacy', 'CC Bender': 'ccBender', 'CC Flo Motion': 'ccFloMotion',
  'CC Griddler': 'ccGriddler', 'CC Split': 'ccSplit', 'CC Split 2': 'ccSplit2', 'CC RepeTile': 'ccRepeTile', 'CC Smear': 'ccSmear',
  'ADBE WRPMESH': 'warp', 'CC Lens': 'ccLens', 'CC Slant': 'ccSlant', 'CC Tiler': 'ccTiler', 'CC Radial ScaleWipe': 'ccRadialScaleWipe',
  'CC Scale Wipe': 'ccScaleWipe', 'CC Grid Wipe': 'ccGridWipe', 'CC Jaws': 'ccJaws', 'CS LineSweep': 'ccLineSweep', 'CC Glass Wipe': 'ccGlassWipe',
  'CC Image Wipe': 'ccImageWipe', 'CC Light Wipe': 'ccLightWipe', 'CC Twister': 'ccTwister', 'CC WarpoMatic': 'ccWarpoMatic', 'CS HexTile': 'ccHexTile',
  'CC Light Burst 2.5': 'ccLightBurst', 'CC Light Sweep': 'ccLightSweep', 'CC Star Burst': 'ccStarBurst', 'CSRainfall': 'ccRainfall', 'CSSnowfall': 'ccSnowfall',
  'CC Spotlight': 'ccSpotlight', 'CC Glass': 'ccGlass', 'CC Plastic': 'ccPlastic', 'CS Threads': 'ccThreads', 'CC Ball Action': 'ccBallAction',
  'CC Pixel Polly': 'ccPixelPolly', 'CC Scatterize': 'ccScatterize', 'CC Bubbles': 'ccBubbles', 'CC Drizzle': 'ccDrizzle', 'ADBE Aud Reverse': 'audioBackwards',
  'ADBE Aud BT': 'audioBassTreble', 'ADBE Aud Delay': 'audioDelay', 'ADBE Aud_Flange': 'audioFlange', 'ADBE Aud HiLo': 'audioHiLo', 'ADBE Aud Modulator': 'audioModulator',
  'ADBE Param EQ': 'audioParamEQ', 'ADBE Aud Reverb': 'audioReverb', 'ADBE Aud Stereo Mixer': 'audioStereoMixer', 'ADBE Aud Tone': 'audioTone', 'ADBE Paint': 'paint',
  'ADBE ShadowHighlight': 'shadowHighlight', 'ADBE LIQUIFY': 'liquify', 'ADBE ELLIPSE': 'ellipse', 'CS Vignette': 'vignette', 'CS CrossBlur': 'ccCrossBlur',
  'APC Caustics': 'caustics', 'APC Shatter': 'shatter', 'APC Wave World': 'waveWorld', 'APC Foam': 'foam', 'APC Radio Waves': 'radioWaves',
  'APC Vegas': 'vegas', 'APC CardWipeCam': 'cardWipe',
});
// particulas (round 7)
// ia (round 8): Roto Brush & Refine Edge («ADBE Samurai»)
Object.assign(AE_EFFECTS, { 'ADBE Samurai': 'rotoBrush' });
Object.assign(AE_EFFECTS, { 'ADBE Playgnd': 'particlePlayground', 'CC PS Classic': 'ccPsClassic', 'CC PS LE Classic': 'ccPsLe', 'ADBE Basic Text2': 'basicText', 'ADBE Path Text': 'pathText', 'ADBE Vector Paint': 'vectorPaint' });
export const AE_EFFECT_ALIASES: ReadonlySet<string> = new Set([
  'ADBE Shadow/Highlight', 'ADBE Liquify', 'ADBE Ellipse', 'CC Vignette', 'CC Cross Blur', 'ADBE Caustics', 'ADBE Shatter',
  'ADBE Wave World', 'ADBE Foam', 'ADBE Radio Waves', 'ADBE Vegas', 'ADBE Card Wipe',
]);
export const AE_EFFECT_NAMES: Record<string, [string, string]> = {
  'ADBE Gaussian Blur 2': ['Gaussian Blur', 'Desenfoque gaussiano'], 'ADBE Gaussian Blur': ['Gaussian Blur (Legacy)', 'Desenfoque gaussiano (heredado)'], 'ADBE Motion Blur': ['Directional Blur', 'Desenfoque direccional'], 'ADBE Radial Blur': ['Radial Blur', 'Desenfoque radial'],
  'ADBE Compound Blur': ['Compound Blur', 'Componer desenfoque'], 'ADBE Sharpen': ['Sharpen', 'Enfocar'], 'ADBE Brightness & Contrast 2': ['Brightness & Contrast', 'Brillo y contraste'], 'ADBE HUE SATURATION': ['Hue/Saturation', 'Tono/Saturación'],
  'ADBE Easy Levels2': ['Levels', 'Niveles'], 'ADBE Exposure2': ['Exposure', 'Exposición'], 'ADBE Lumetri': ['Lumetri Color', 'Color de Lumetri'], 'ADBE Change Color': ['Change Color', 'Cambiar color'],
  'ADBE CHANNEL MIXER': ['Channel Mixer', 'Mezclador de canales'], 'APC Colorama': ['Colorama', 'Colorama'], 'ADBE Equalize': ['Equalize', 'Ecualizar'], 'ADBE AutoLevels': ['Auto Levels', 'Niveles automáticos'],
  'ADBE AutoContrast': ['Auto Contrast', 'Contraste automático'], 'ADBE AutoColor': ['Auto Color', 'Color automático'], 'ADBE Leave Color': ['Leave Color', 'Conservar color'], 'ADBE CurvesCustom': ['Curves', 'Curvas'],
  'ADBE Pro Levels2': ['Levels (Individual Controls)', 'Niveles (contr. individuales)'], 'ADBE Color Balance 2': ['Color Balance', 'Equilibrio de color'], 'ADBE Change To Color': ['Change to Color', 'Cambio de color'], 'ADBE Apply Color LUT2': ['Apply Color LUT', 'Aplicar tabla de búsq. de color'],
  'ADBE Tint': ['Tint', 'Tinción'], 'ADBE Tritone': ['Tritone', 'Tritono'], 'ADBE Photo Filter': ['Photo Filter', 'Filtro de fotos'], 'ADBE Fill': ['Fill', 'Relleno'],
  'ADBE Invert': ['Invert', 'Invertir'], 'ADBE Black&White': ['Black & White', 'Blanco y negro'], 'ADBE Posterize': ['Posterize', 'Posterización'], 'ADBE Threshold2': ['Threshold', 'Umbral'],
  'ADBE Vibrance': ['Vibrance', 'Intensidad'], 'ADBE Glo2': ['Glow', 'Resplandor'], 'ADBE Drop Shadow': ['Drop Shadow', 'Sombra paralela'], 'ADBE Set Matte3': ['Set Matte', 'Definir mate'],
  'ADBE Mosaic': ['Mosaic', 'Mosaico'], 'ADBE Find Edges': ['Find Edges', 'Encontrar bordes'], 'ADBE Emboss': ['Emboss', 'Relieve'], 'ADBE Ramp': ['Gradient Ramp', 'Gradación de degradado'],
  'ADBE Grid': ['Grid', 'Cuadrícula'], 'ADBE Checkerboard': ['Checkerboard', 'Tablero de ajedrez'], 'ADBE Circle': ['Circle', 'Círculo'], 'ADBE Lens Flare': ['Lens Flare', 'Destello de lente'],
  'ADBE Stroke': ['Stroke', 'Trazo'], 'ADBE Write-on': ['Write-on', 'Simulación de escritura'], 'ADBE Scribble Fill': ['Scribble', 'Garabato'], 'ADBE Laser': ['Beam', 'Haz'],
  'CC Light Rays': ['CC Light Rays', 'CC Light Rays'], 'ADBE Fractal Noise': ['Fractal Noise', 'Ruido fractal'], 'ADBE Lightning': ['Lightning', 'Relámpago'], 'ADBE Lightning 2': ['Advanced Lightning', 'Relámpago avanzado'],
  'ADBE Cell Pattern': ['Cell Pattern', 'Patrón de celdas'], 'CC Particle World': ['CC Particle World', 'CC Particle World'], 'ADBE Geometry2': ['Transform', 'Transformar'], 'ADBE Displacement Map': ['Displacement Map', 'Mapa de desplazamiento'],
  'ADBE Mirror': ['Mirror', 'Espejo'], 'ADBE Offset': ['Offset', 'Desplazamiento'], 'ADBE Wave Warp': ['Wave Warp', 'Deformación con ondas'], 'ADBE Polar Coordinates': ['Polar Coordinates', 'Coordenadas polares'],
  'ADBE Spherize': ['Spherize', 'Esferizar'], 'ADBE BEZMESH': ['Bezier Warp', 'Deformación Bézier'], 'ADBE MESH WARP': ['Mesh Warp', 'Deformación de malla'], 'CC Bend It': ['CC Bend It', 'CC Bend It'],
  'CC Power Pin': ['CC Power Pin', 'CC Power Pin'], 'ADBE Corner Pin': ['Corner Pin', 'Posicionar bordes'], 'ADBE Tile': ['Motion Tile', 'Mosaico en movimiento'], 'ADBE Twirl': ['Twirl', 'Molinete'],
  'ADBE Bulge': ['Bulge', 'Abombar'], 'ADBE Ripple': ['Ripple', 'Ondulación'], 'ADBE Turbulent Displace': ['Turbulent Displace', 'Desplazamiento turbulento'], 'ADBE Linear Wipe': ['Linear Wipe', 'Barrido lineal'],
  'ADBE Gradient Wipe': ['Gradient Wipe', 'Barrido de degradado'], 'ADBE Radial Wipe': ['Radial Wipe', 'Barrido radial'], 'ADBE IRIS_WIPE': ['Iris Wipe', 'Barrido irisado'], 'ADBE Venetian Blinds': ['Venetian Blinds', 'Barridos venecianos'],
  'ADBE Block Dissolve': ['Block Dissolve', 'Disolver en bloques'], 'ADBE Noise': ['Noise', 'Ruido'], 'Keylight 906': ['Keylight (1.2)', 'Keylight (1.2)'], 'ADBE KeyCleaner': ['Key Cleaner', 'Key Cleaner'],
  'ADBE Spill2': ['Advanced Spill Suppressor', 'Advanced Spill Suppressor'], 'ADBE Simple Choker': ['Simple Choker', 'Retractor simple'], 'ADBE Matte Choker': ['Matte Choker', 'Retractor de mate'], 'ADBE Color Key': ['Color Key', 'Croma lineal'],
  'ADBE Luma Key': ['Luma Key', 'Incrustación por luminancia'], 'ADBE AudSpect': ['Audio Spectrum', 'Espectro de audio'], 'ADBE AudWave': ['Audio Waveform', 'Forma de onda de audio'], 'ADBE Timewarp': ['Timewarp', 'Deformación de tiempo'],
  'ADBE Time Displacement': ['Time Displacement', 'Desplazamiento de tiempo'], 'CC Wide Time': ['CC Wide Time', 'CC Wide Time'], 'ADBE Echo': ['Echo', 'Eco'], 'ADBE Posterize Time': ['Posterize Time', 'Tiempo de posterización'],
  'ADBE Slider Control': ['Slider Control', 'Control del deslizador'], 'ADBE Angle Control': ['Angle Control', 'Control de ángulo'], 'ADBE Checkbox Control': ['Checkbox Control', 'Control casilla verific.'], 'ADBE Color Control': ['Color Control', 'Control de color'],
  'ADBE Point Control': ['Point Control', 'Control de puntos'], 'ADBE Layer Control': ['Layer Control', 'Control de capa'], 'ADBE Dropdown Control': ['Dropdown Menu Control', 'Control del menú desplegable'], 'ADBE Box Blur2': ['Fast Box Blur', 'Desenfoque de cuadro rápido'],
  'ADBE Channel Blur': ['Channel Blur', 'Desenfoque del canal'], 'ADBE Unsharp Mask2': ['Unsharp Mask', 'Máscara de enfoque'], 'ADBE Smart Blur': ['Smart Blur', 'Desenfoque inteligente'], 'ADBE Bilateral': ['Bilateral Blur', 'Desenfoque bilateral'],
  'CC Radial Blur': ['CC Radial Blur', 'CC Radial Blur'], 'CC Radial Fast Blur': ['CC Radial Fast Blur', 'CC Radial Fast Blur'], 'CC Vector Blur': ['CC Vector Blur', 'CC Vector Blur'], 'VISINF Grain Implant': ['Add Grain', 'Añadir granulado'],
  'VISINF Grain Removal': ['Remove Grain', 'Eliminar granulado'], 'ADBE Median': ['Median (Legacy)', 'Mediana (heredado)'], 'ADBE Dust & Scratches': ['Dust & Scratches', 'Polvo y arañazos'], 'ADBE Noise HLS2': ['Noise HLS', 'Ruido HLS'],
  'ADBE Noise HLS Auto2': ['Noise HLS Auto', 'Ruido HLS automático'], 'ADBE Noise Alpha2': ['Noise Alpha', 'Ruido alfa'], 'ADBE Minimax': ['Minimax', 'Mínimo/máximo'], 'ADBE Shift Channels': ['Shift Channels', 'Cambiar canales'],
  'ADBE Set Channels': ['Set Channels', 'Definir canales'], 'ADBE Arithmetic': ['Arithmetic', 'Aritmética'], 'ADBE Solid Composite': ['Solid Composite', 'Composición sólida'], 'ADBE Blend': ['Blend', 'Fusionar'],
  'ADBE Calculations': ['Calculations', 'Cálculos'], 'ADBE Compound Arithmetic': ['Compound Arithmetic', 'Aritmética compuesta'], 'ADBE Bevel Alpha': ['Bevel Alpha', 'Biselar alfa'], 'ADBE Bevel Edges': ['Bevel Edges', 'Bordes biselados'],
  'ADBE Radial Shadow': ['Radial Shadow', 'Sombra radial'], 'ADBE Basic 3D': ['Basic 3D', '3D básico'], 'CC Cylinder': ['CC Cylinder', 'CC Cylinder'], 'CC Sphere': ['CC Sphere', 'CC Sphere'],
  'CC Page Turn': ['CC Page Turn', 'CC Page Turn'], 'ADBE Optics Compensation': ['Optics Compensation', 'Compensación óptica'], 'ADBE Magnify': ['Magnify', 'Aumentar'], 'ADBE Scatter': ['Scatter', 'Dispersión'],
  'ADBE Strobe': ['Strobe Light', 'Luz estroboscópica'], 'ADBE Brush Strokes': ['Brush Strokes', 'Trazos de pincel'], 'ADBE Texturize': ['Texturize', 'Texturizar'], 'ADBE Roughen Edges': ['Roughen Edges', 'Bordes rugosos'],
  'CC Kaleida': ['CC Kaleida', 'CC Kaleida'], 'ADBE Timecode': ['Timecode', 'Código de tiempo'], 'ADBE Numbers2': ['Numbers', 'Números'], 'ADBE Paint Bucket': ['Paint Bucket', 'Bote de pintura'],
  'ADBE Cartoonify': ['Cartoon', 'Dibujos animados'], 'ADBE Color Emboss': ['Color Emboss', 'Relieve de color'], 'ADBE Gamma/Pedestal/Gain2': ['Gamma/Pedestal/Gain', 'Gama/pedestal/ganancia'], 'ADBE Broadcast Colors': ['Broadcast Colors', 'Colores de emisión'],
  'ADBE Eyedropper Fill': ['Eyedropper Fill', 'Relleno de cuentagotas'], 'ADBE 3D Glasses2': ['3D Glasses', 'Gafas 3D'], 'CC Blobbylize': ['CC Blobbylize', 'CC Blobbylize'], 'ADBE RESHAPE': ['Reshape', 'Dar nueva forma'],
  'ADBE SCHMEAR': ['Smear', 'Alargar'], 'ADBE Rolling Shutter': ['Rolling Shutter Repair', 'Reparación de obturación despl.'], 'CC Particle Systems II': ['CC Particle Systems II', 'CC Particle Systems II'], 'CC Mr. Mercury': ['CC Mr. Mercury', 'CC Mr. Mercury'],
  'CC Hair': ['CC Hair', 'CC Hair'], 'CC Glue Gun': ['CC Glue Gun', 'CC Glue Gun'], 'CC Environment': ['CC Environment', 'CC Environment'], 'ADBE Fractal': ['Fractal', 'Fractal'],
  'VISINF Grain Duplication': ['Match Grain', 'Aplicar granulado'], 'CC Force Motion Blur': ['CC Force Motion Blur', 'CC Force Motion Blur'], 'ADBE SubspaceStabilizer': ['Warp Stabilizer', 'Estabilizador de deformación'], 'ADBE Three-Way Color Corrector': ['Three-Way Color Corrector', 'Corrección de color tridireccional'],
  'ADBE Remove Color Matting': ['Remove Color Matting', 'Eliminar los halos de color'], 'APC CardDanceCam': ['Card Dance', 'Baile de cartas'], 'CC Rain': ['CC Rain', 'CC Rain'], 'CC Snow': ['CC Snow', 'CC Snow'],
  'CC Time Blend': ['CC Time Blend', 'CC Time Blend'], 'EXtractoR': ['EXtractoR', 'EXtractoR'], 'IDentifier': ['IDentifier', 'IDentifier'], 'Cryptomatte': ['Cryptomatte', 'Cryptomatte'],
  'CC Simple Wire Removal': ['CC Simple Wire Removal', 'CC Simple Wire Removal'], 'ADBE Channel Combiner': ['Channel Combiner', 'Combinador de canales'], 'ADBE Alpha Levels2': ['Alpha Levels', 'Niveles alfa'], 'ADBE Color Difference Key': ['Color Difference Key', 'Incrustación de dif. de color'],
  'ADBE Color Range': ['Color Range', 'Gama de colores'], 'ADBE ATG Extract': ['Inner/Outer Key', 'Incrustación interior/exterior'], 'ADBE Spill Suppressor': ['Spill Suppressor', 'Supresión de rebase'], 'ADBE Linear Color Key2': ['Linear Color Key', 'Incrustación por croma lineal'],
  'ADBE Extract': ['Extract', 'Extraer'], 'ADBE Difference Matte2': ['Difference Matte', 'Mate de diferencia'], 'ADBE Compander': ['HDR Compander', 'HDR Compander'], 'ADBE Color Balance (HLS)': ['Color Balance (HLS)', 'Equilibrio de color (HLS)'],
  'ADBE SelectiveColor': ['Selective Color', 'Color selectivo'], 'ADBE Color Link': ['Color Link', 'Enlace de colores'], 'ADBE Cineon Converter2': ['Cineon Converter', 'Convertidor Cineon'], 'CC Toner': ['CC Toner', 'CC Toner'],
  'CC Color Offset': ['CC Color Offset', 'CC Color Offset'], 'CS Kernel': ['CC Kernel', 'CC Kernel'], 'CS Color Neutralizer': ['CC Color Neutralizer', 'CC Color Neutralizer'], 'ADBE DigitalVideoLimiter': ['Video Limiter', 'Limitador de vídeo'],
  'ADBE GROW BOUNDS': ['Grow Bounds', 'Extender límites'], 'CC Overbrights': ['CC Overbrights', 'CC Overbrights'], 'ADBE PS Arbitrary Map': ['PS Arbitrary Map', 'Mapa arbitrario de Photoshop'], 'ADBE Color Balance': ['Color Balance', 'Equilibrio de color'],
  'CC Bender': ['CC Bender', 'CC Bender'], 'CC Flo Motion': ['CC Flo Motion', 'CC Flo Motion'], 'CC Griddler': ['CC Griddler', 'CC Griddler'], 'CC Split': ['CC Split', 'CC Split'],
  'CC Split 2': ['CC Split 2', 'CC Split 2'], 'CC RepeTile': ['CC RepeTile', 'CC RepeTile'], 'CC Smear': ['CC Smear', 'CC Smear'], 'ADBE WRPMESH': ['Warp', 'Deformación'],
  'CC Lens': ['CC Lens', 'CC Lens'], 'CC Slant': ['CC Slant', 'CC Slant'], 'CC Tiler': ['CC Tiler', 'CC Tiler'], 'CC Radial ScaleWipe': ['CC Radial ScaleWipe', 'CC Radial ScaleWipe'],
  'CC Scale Wipe': ['CC Scale Wipe', 'CC Scale Wipe'], 'CC Grid Wipe': ['CC Grid Wipe', 'CC Grid Wipe'], 'CC Jaws': ['CC Jaws', 'CC Jaws'], 'CS LineSweep': ['CC Line Sweep', 'CC Line Sweep'],
  'CC Glass Wipe': ['CC Glass Wipe', 'CC Glass Wipe'], 'CC Image Wipe': ['CC Image Wipe', 'CC Image Wipe'], 'CC Light Wipe': ['CC Light Wipe', 'CC Light Wipe'], 'CC Twister': ['CC Twister', 'CC Twister'],
  'CC WarpoMatic': ['CC WarpoMatic', 'CC WarpoMatic'], 'CS HexTile': ['CC HexTile', 'CC HexTile'], 'CC Light Burst 2.5': ['CC Light Burst 2.5', 'CC Light Burst 2.5'], 'CC Light Sweep': ['CC Light Sweep', 'CC Light Sweep'],
  'CC Star Burst': ['CC Star Burst', 'CC Star Burst'], 'CSRainfall': ['CC Rainfall', 'CC Rainfall'], 'CSSnowfall': ['CC Snowfall', 'CC Snowfall'], 'CC Spotlight': ['CC Spotlight', 'CC Spotlight'],
  'CC Glass': ['CC Glass', 'CC Glass'], 'CC Plastic': ['CC Plastic', 'CC Plastic'], 'CS Threads': ['CC Threads', 'CC Threads'], 'CC Ball Action': ['CC Ball Action', 'CC Ball Action'],
  'CC Pixel Polly': ['CC Pixel Polly', 'CC Pixel Polly'], 'CC Scatterize': ['CC Scatterize', 'CC Scatterize'], 'CC Bubbles': ['CC Bubbles', 'CC Bubbles'], 'CC Drizzle': ['CC Drizzle', 'CC Drizzle'],
  'ADBE Aud Reverse': ['Backwards', 'Hacia atrás'], 'ADBE Aud BT': ['Bass & Treble', 'Graves y agudos'], 'ADBE Aud Delay': ['Delay', 'Retardo'], 'ADBE Aud_Flange': ['Flange & Chorus', 'Desdoblamiento y coro'],
  'ADBE Aud HiLo': ['High-Low Pass', 'Recorrido alto-bajo'], 'ADBE Aud Modulator': ['Modulator', 'Modulador'], 'ADBE Param EQ': ['Parametric EQ', 'EQ paramétrica'], 'ADBE Aud Reverb': ['Reverb', 'Reverberación'],
  'ADBE Aud Stereo Mixer': ['Stereo Mixer', 'Mezclador estéreo'], 'ADBE Aud Tone': ['Tone', 'Tono'], 'ADBE Paint': ['Paint', 'Pintura'], 'ADBE ShadowHighlight': ['Shadow/Highlight', 'Sombra/iluminación'],
  'ADBE LIQUIFY': ['Liquify', 'Licuar'], 'ADBE ELLIPSE': ['Ellipse', 'Elipse'], 'CS Vignette': ['CC Vignette', 'CC Vignette'], 'CS CrossBlur': ['CC Cross Blur', 'CC Cross Blur'],
  'APC Caustics': ['Caustics', 'Cáustico'], 'APC Shatter': ['Shatter', 'Dispersión'], 'APC Wave World': ['Wave World', 'Mundo marino'], 'APC Foam': ['Foam', 'Espuma'],
  'APC Radio Waves': ['Radio Waves', 'Ondas de radio'], 'APC Vegas': ['Vegas', 'Vegas'], 'APC CardWipeCam': ['Card Wipe', 'Barrido de cartas'],
  'ADBE 4ColorGradient': ['4-Color Gradient', 'Degradado de 4 colores'], 'ADBE AIF Perlin Noise 3D': ['Turbulent Noise', 'Ruido de turbulencia'], 'ADBE HDR ToneMap': ['HDR Highlight Compression', 'Compresión de resalte HDR'], 'ADBE ProfileToProfile': ['Color Profile Converter', 'Convertidor perfiles de color'], 'ADBE Deflicker': ['Color Stabilizer', 'Estabilizador del color'], 'CC Threshold': ['CC Threshold', 'CC Threshold'], 'CC Threshold RGB': ['CC Threshold RGB', 'CC Threshold RGB'], 'CC Burn Film': ['CC Burn Film', 'CC Burn Film'],
  'ADBE Camera Lens Blur': ['Camera Lens Blur', 'Desenfoque de lente de cámara'], 'ADBE Fast Blur': ['Fast Blur (Legacy)', 'Desenfoque rápido (heredado)'], 'ADBE OFMotionBlur': ['Pixel Motion Blur', 'Desenfoque de movimiento de píxeles'], 'ADBE CameraShakeDeblur': ['Camera-Shake Deblur', 'Estabilización del desenfoque de temblores'], 'ADBE Upscale': ['Detail-preserving Upscale', 'Conservar detalles (ampliación)'],
  // canal3d
  'ADBE AUX CHANNEL EXTRACT': ['3D Channel Extract', 'Extraer Canal 3D'], 'ADBE DEPTH FIELD': ['Depth of Field', 'Profundidad de campo'], 'ADBE DEPTH MATTE': ['Depth Matte', 'Mate de profundidad'], 'ADBE FOG_3D': ['Fog 3D', 'Niebla 3D'],
  'ADBE ID MATTE': ['ID Matte', 'ID de mate'], 'ADBE RefineMatte': ['Refine Hard Matte', 'Perfeccionar mate fuerte'], 'ADBE RefineMatte2': ['Refine Soft Matte', 'Perfeccionar mate suave'],
  // tiempo, round 7 (names from AE's Spanish interface; CycoreFX keeps its English names)
  'ADBE Reduce Interlace Flicker': ['Reduce Interlace Flicker', 'Reducir parpadeo entrelazado'], 'ADBE Difference': ['Time Difference', 'Diferencia de tiempo'], 'CC Time Blend FX': ['CC Time Blend FX', 'CC Time Blend FX'],
  'CS BlockLoad': ['CC Block Load', 'CC Block Load'], 'CC Mr. Smoothie': ['CC Mr. Smoothie', 'CC Mr. Smoothie'], 'CC Composite': ['CC Composite', 'CC Composite'], 'CC Ripple Pulse': ['CC Ripple Pulse', 'CC Ripple Pulse'],
};
Object.assign(AE_EFFECT_NAMES, { 'ADBE Samurai': ['Roto Brush & Refine Edge', 'Pincel rotoscopia y Perf. borde'] });
Object.assign(AE_EFFECT_NAMES, { 'ADBE Playgnd': ['Particle Playground', 'Animación del objeto'], 'CC PS Classic': ['CC PS Classic (obsolete)', 'CC PS Classic (obsolete)'], 'CC PS LE Classic': ['CC PS LE Classic (obsolete)', 'CC PS LE Classic (obsolete)'], 'ADBE Basic Text2': ['Basic Text', 'Texto básico'], 'ADBE Path Text': ['Path Text', 'Texto de trazado'], 'ADBE Vector Paint': ['Vector Paint', 'Pintura vectorial'] });
/** Cinta effects with no After Effects 2024 counterpart (scripts reach them by Cinta id or name only). */
export const CINTA_ONLY_EFFECTS: readonly string[] = ['toonBands', 'gooey', 'rimLight', 'outline', 'particles', 'scanlines', 'deflicker'];
/** Cinta effects whose After Effects look-alike is only a VR (equirectangular) effect: not mapped. */
export const AE_UNMAPPED_EFFECTS: Record<string, string> = { chromaticAberration: 'Mettle SkyBox Chromatic Aberrations', glitch: 'Mettle SkyBox Digital Glitch' };
const AE_BY_NAME = new Map<string, string>();
for (const [m, names] of Object.entries(AE_EFFECT_NAMES)) for (const n of names) if (AE_EFFECTS[m] && !AE_BY_NAME.has(lc(n))) AE_BY_NAME.set(lc(n), AE_EFFECTS[m]);
/** The match name After Effects gives a Cinta effect (undefined for Cinta's own effects). */
export function aeMatchName(fx: string): string | undefined {
  let alias: string | undefined;
  for (const [m, id] of Object.entries(AE_EFFECTS)) if (id === fx) { if (!AE_EFFECT_ALIASES.has(m)) return m; alias ??= m; }
  return alias;
}
/** Cinta effect id for an AE match name (any case) or display name (English or Spanish, as AE's menus show it). */
export function aeEffectId(name: string): string | undefined {
  if (AE_EFFECTS[name]) return AE_EFFECTS[name];
  const k = lc(name);
  return AE_BY_NAME.get(k) ?? Object.entries(AE_EFFECTS).find(([m]) => lc(m) === k)?.[1];
}
const pickChild = (list: Child[], key: unknown): { c: Child; i: number } | null => {
  if (typeof key === 'number') return list[key - 1] ? { c: list[key - 1], i: key } : null;
  const k = lc(key);
  const i = list.findIndex((c) => lc(c[0]) === k || lc(c[1]) === k || lc(c[2]) === k || lc(c[0]).replace(/ /g, '') === k.replace(/ /g, ''));
  return i >= 0 ? { c: list[i], i: i + 1 } : null;
};

// ───────────────────────── handles ─────────────────────────
type H = { k: string; [x: string]: unknown };
const KINDS: Record<string, { cls: string; fn: string[]; idx?: string; sub?: Record<string, string> }> = {
  App: { cls: 'Application', fn: ['beginUndoGroup', 'endUndoGroup', 'activate', 'purge', 'scheduleTask', 'cancelTask', 'executeCommand', 'findMenuCommandId', 'quit', 'newProject', 'open', 'setMemoryUsageLimits', 'setSavePreferencesOnQuit', 'parseSwatchFile', 'watchFolder', 'pauseWatchFolder', 'endWatchFolder', '__log', '__read', '__fileName', '__fs'] },
  Settings: { cls: 'Item', fn: ['haveSetting', 'getSetting', 'saveSetting', 'getAsString'] },
  Project: { cls: 'Project', fn: ['item', 'itemByID', 'importFile', 'importFileWithDialog', 'importPlaceholder', 'save', 'saveWithDialog', 'close', 'consolidateFootage', 'removeUnusedFootage', 'reduceProject', 'autoFixExpressions', 'showWindow', 'setDefaultImportFolder'] },
  Items: { cls: 'ItemCollection', fn: ['item', 'addComp', 'addFolder'], idx: 'item' },
  Comp: { cls: 'CompItem', fn: ['layer', 'duplicate', 'remove', 'openInViewer'] },
  Footage: { cls: 'FootageItem', fn: ['remove', 'reload', 'replace', 'openInViewer'] },
  FolderItem: { cls: 'FolderItem', fn: ['item', 'remove'] },
  Layers: { cls: 'LayerCollection', fn: ['layer', 'addSolid', 'addText', 'addBoxText', 'addShape', 'addNull', 'addCamera', 'addLight', 'add', 'byName', 'precompose'], idx: 'layer' },
  Layer: { cls: 'AVLayer', sub: { text: 'TextLayer', shape: 'ShapeLayer', camera: 'CameraLayer', light: 'LightLayer' }, fn: ['property', 'propertyGroup', 'remove', 'duplicate', 'moveToBeginning', 'moveToEnd', 'moveAfter', 'moveBefore', 'setParentWithJump', 'openInViewer', 'activeAtTime'] },
  Group: { cls: 'PropertyGroup', fn: ['property', 'addProperty', 'canAddProperty', 'remove', 'moveTo', 'duplicate', 'propertyGroup'] },
  Prop: { cls: 'Property', fn: ['setValue', 'setValueAtTime', 'setValuesAtTimes', 'valueAtTime', 'addKey', 'removeKey', 'keyTime', 'keyValue', 'nearestKeyIndex', 'setValueAtKey', 'setInterpolationTypeAtKey', 'keyInInterpolationType', 'keyOutInterpolationType', 'setTemporalEaseAtKey', 'keyInTemporalEase', 'keyOutTemporalEase', 'setTemporalContinuousAtKey', 'keyTemporalContinuous', 'setTemporalAutoBezierAtKey', 'keyTemporalAutoBezier', 'setSpatialTangentsAtKey', 'setSpatialContinuousAtKey', 'setSpatialAutoBezierAtKey', 'setRovingAtKey', 'keySelected', 'setSelectedAtKey', 'propertyGroup', 'getSeparationFollower', 'addToMotionGraphicsTemplate'] },
};
class ScriptError extends Error {}
const fail = (m: string): never => { throw new ScriptError(m); };

interface VGroup { c: string; l: string; shapes: string[]; fill?: { color: string; opacity: number }; stroke?: { color: string; opacity: number; width: number }; name: string; parent: string }

// ───────────────────────── the host side ─────────────────────────
class Host {
  log: ScriptLogLine[] = [];
  undoGroups: string[] = [];
  depth = 0;
  times: Record<string, number> = {};
  vgroups = new Map<string, VGroup>();
  folders: { id: string; name: string }[] = [];
  openComp?: string;
  roots: string[];
  constructor(public e: Editor, public o: ScriptOptions) {
    const proj = e.path ? dirname(e.path) : null;
    this.roots = [o.file ? dirname(resolve(o.file)) : null, proj, ...(o.roots ?? [])].filter((x): x is string => !!x).map((x) => resolve(x));
  }
  get p(): Project { return this.e.project; }
  comps(): Comp[] { return this.p.comps ?? []; }
  comp(id: unknown): Comp { const c = this.comps().find((x) => x.id === id); if (!c) fail('El objeto ya no es válido: la composición se ha eliminado.'); return c!; }
  layer(h: H): Layer { const l = this.comp(h.c).layers.find((x) => x.id === h.l); if (!l) fail('El objeto ya no es válido: la capa se ha eliminado.'); return l!; }
  time(c: string) { return this.times[c] ?? 0; }
  ops = M.motionOps as unknown as typeof M.motionOps;

  // descriptors
  compH = (c: Comp): H => ({ k: 'Comp', id: c.id });
  layerH = (c: string, l: Layer): H => ({ k: 'Layer', c, l: l.id, t: l.type === 'text' || l.type === 'shape' || l.type === 'camera' || l.type === 'light' ? l.type : 'av' });
  items(): H[] {
    return [...this.comps().map(this.compH), ...this.folders.map((f) => ({ k: 'FolderItem', id: f.id })),
      ...(this.p.dataItems ?? []).map((d) => ({ k: 'Footage', id: d.id, s: 'data' })), ...this.p.media.filter((m) => !m.compId).map((m) => ({ k: 'Footage', id: m.id, s: 'media' }))];
  }

  // ── File / Folder (read only, inside the roots) ──
  allowed(path: string) {
    const r = resolve(path).toLowerCase();
    return this.roots.some((x) => r === x.toLowerCase() || r.startsWith(x.toLowerCase().replace(/[\\/]$/, '') + sep));
  }
  guard(path: string) { if (!this.allowed(path)) fail(`Acceso denegado a «${path}»: los scripts solo leen dentro de su carpeta y de la del proyecto.`); return path; }
  fs(op: string, path: string, a?: unknown): unknown {
    switch (op) {
      case 'resolve': {
        let s = String(path ?? '').trim();
        if (!s) return this.roots[0] ?? resolve('.');
        s = s.replace(/^~(?=[\\/]|$)/, homedir()).replace(/^\/([a-zA-Z])\//, '$1:/');
        return isAbsolute(s) ? resolve(s) : resolve(this.roots[0] ?? '.', s);
      }
      case 'cwd': return this.roots[0] ?? resolve('.');
      case 'special': return ({ temp: tmpdir(), desktop: join(homedir(), 'Desktop'), myDocuments: join(homedir(), 'Documents') } as Record<string, string>)[path] ?? homedir();
      case 'exists': { if (!this.allowed(path)) return false; if (!existsSync(path)) return false; const d = statSync(path).isDirectory(); return a ? d : !d; }
      case 'size': return this.allowed(path) && existsSync(path) ? statSync(path).size : -1;
      case 'mtime': return this.allowed(path) && existsSync(path) ? statSync(path).mtimeMs : 0;
      case 'read': { this.guard(path); if (!existsSync(path)) fail(`No se puede encontrar el archivo ${path}.`); const b = readFileSync(path); if (b.length > 64 * 1024 * 1024) fail('Archivo demasiado grande para un script.'); return b.toString('utf8').replace(/^﻿/, ''); }
      case 'list': { this.guard(path); return existsSync(path) ? readdirSync(path, { withFileTypes: true }).map((d) => ({ path: join(path, d.name), dir: d.isDirectory() })) : []; }
    }
    return fail(`Operación de archivo desconocida ${op}`);
  }

  // ── conversions between After Effects values and Cinta's ──
  toAE(l: Layer, path: string, v: PVal): unknown {
    if (path === 'text.text' && l.text) return { $td: { text: String(v), fontSize: l.text.size.v, fillColor: M.parseColor(String(l.text.fill.v)).slice(0, 3), font: l.text.font, justification: ({ left: 7413, right: 7414, center: 7415 } as Record<string, number>)[l.text.align] ?? 7415, applyFill: true, applyStroke: Number(l.text.strokeWidth.v) > 0, strokeWidth: l.text.strokeWidth.v, tracking: l.text.tracking.v } };
    if (path === 'audio.level') return [v, v];
    if (M.isColor(v)) return M.parseColor(v);
    const ch = this.choice(l, path);
    if (ch && typeof v === 'string') return Math.max(1, ch.findIndex((x) => x.id === v) + 1);
    return v;
  }
  choice(l: Layer, path: string) {
    const m = /^effects\.([^.]+)\.([^.]+)$/.exec(path);
    if (!m) return null;
    const fx = l.effects.find((f) => f.id === m[1]);
    const d = fx ? M.FX.find((x) => x.id === fx.fx)?.params.find((x) => x.id === m[2]) : undefined;
    return d?.type === 'choice' ? d.choices ?? null : null;
  }
  fromAE(c: Comp, l: Layer, path: string, v: unknown, cur: PVal): PVal {
    if (path === 'text.text') {
      const td = v && typeof v === 'object' && '$td' in (v as object) ? (v as { $td: Record<string, unknown> }).$td : null;
      if (td) this.textStyle(c, l, td);
      return String(td ? td.text ?? '' : v);
    }
    if (path === 'audio.level') return Array.isArray(v) ? (Number(v[0]) + Number(v[1] ?? v[0])) / 2 : Number(v);
    if (M.isColor(cur) && Array.isArray(v)) return M.colorStr(v.map(Number));
    const ch = this.choice(l, path);
    if (ch && typeof v === 'number') return ch[Math.max(0, Math.min(ch.length - 1, Math.round(v) - 1))].id;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (Array.isArray(cur) && Array.isArray(v)) return cur.map((x, i) => (v[i] === undefined || v[i] === null ? x : Number(v[i])));
    return v as PVal;
  }
  textStyle(c: Comp, l: Layer, td: Record<string, unknown>) {
    const style: Record<string, unknown> = {};
    if (typeof td.font === 'string' && td.font) style.font = td.font;
    const j = ({ 7413: 'left', 7414: 'right', 7415: 'center' } as Record<number, string>)[Number(td.justification)];
    if (j) style.align = j;
    if (Object.keys(style).length) this.ops.layerSet(this.e, c.id, l.id, { text: style });
    const set = (path: string, v: PVal) => { const pr = M.resolveProp(l, path); if (!pr.k?.length) this.ops.propSet(this.e, c.id, l.id, path, { value: v }); };
    if (typeof td.fontSize === 'number') set('text.size', td.fontSize);
    if (Array.isArray(td.fillColor) && td.applyFill !== false) set('text.fill', M.colorStr((td.fillColor as number[]).map(Number)));
    if (Array.isArray(td.strokeColor) && td.applyStroke) set('text.stroke', M.colorStr((td.strokeColor as number[]).map(Number)));
    if (typeof td.strokeWidth === 'number' && td.applyStroke) set('text.strokeWidth', td.strokeWidth);
    if (typeof td.tracking === 'number') set('text.tracking', td.tracking);
  }

  // ── the bridge ──
  handle(msg: string): string {
    try {
      const { h, op, n, a } = JSON.parse(msg) as { h: H; op: 'get' | 'set' | 'call' | 'has'; n: string; a: unknown[] };
      const v = this.dispatch(h, op, n, a ?? []);
      return JSON.stringify({ v: v === undefined ? null : v });
    } catch (e) {
      return JSON.stringify({ e: String((e as Error).message ?? e) });
    }
  }
  dispatch(h: H, op: string, n: string, a: unknown[]): unknown {
    const fn = (this as unknown as Record<string, (h: H, op: string, n: string, a: unknown[]) => unknown>)[`k${h.k}`];
    if (!fn) fail(`Objeto desconocido ${h.k}`);
    if (op === 'has' && n === '__valid') { try { this.valid(h); return true; } catch { return false; } }
    return fn.call(this, h, op, n, a);
  }
  valid(h: H) {
    if (h.k === 'Comp') this.comp(h.id);
    if (h.k === 'Layer' || h.k === 'Group' || h.k === 'Prop') this.layer(h);
  }
  unsupported(what: string): never { return fail(`${what} no está disponible en los scripts de Cinta (consulte docs/scripts-ae.md).`); }

  kApp(_h: H, op: string, n: string, a: unknown[]): unknown {
    if (op === 'set') return undefined;
    if (op === 'get') {
      switch (n) {
        case 'project': return { $h: { k: 'Project' } };
        case 'version': return '24.0x0';
        case 'buildName': return 'Cinta';
        case 'buildNumber': return 0;
        case 'language': case 'isoLanguage': return n === 'language' ? 'es' : 'es_ES';
        case 'settings': case 'preferences': return { $h: { k: 'Settings' } };
        case 'isWatchFolder': case 'isRenderEngine': case 'isUISuppressed': return false;
        case 'memoryInUse': return 0;
        case 'activeViewer': return null;
        case 'exitCode': return 0;
        case 'exitAfterLaunchAndEval': case 'saveProjectOnCrash': case 'onError': return null;
      }
      return undefined;
    }
    switch (n) {
      case '__log': this.log.push({ kind: a[0] as ScriptLogLine['kind'], text: String(a[1]) }); return null;
      case '__read': return this.fs('read', String(this.fs('resolve', String(a[0]))));
      case '__fileName': return this.o.file ? resolve(this.o.file) : '';
      case '__fs': return this.fs(String(a[0]), String(a[1]), a[2]);
      case 'beginUndoGroup': this.depth++; if (this.depth === 1) this.undoGroups.push(String(a[0] ?? '')); return null;
      case 'endUndoGroup': this.depth = Math.max(0, this.depth - 1); return null;
      case 'findMenuCommandId': return 0;
      case 'scheduleTask': return 0;
      case 'executeCommand': this.log.push({ kind: 'log', text: `(app.executeCommand(${a[0]}) no tiene efecto en Cinta)` }); return null;
      case 'newProject': case 'open': return this.unsupported(`app.${n}()`);
      default: return null;
    }
  }
  kSettings(_h: H, op: string, n: string): unknown { if (op !== 'call') return undefined; return n === 'haveSetting' ? false : n === 'getSetting' || n === 'getAsString' ? '' : null; }

  kProject(_h: H, op: string, n: string, a: unknown[]): unknown {
    const items = this.items();
    if (op === 'get') {
      switch (n) {
        case 'items': return { $h: { k: 'Items' } };
        case 'numItems': return items.length;
        case 'activeItem': {
          const id = this.openComp ?? this.o.activeComp;
          const c = id ? this.comps().find((x) => x.id === id) : undefined;
          return c ? { $h: this.compH(c) } : null;
        }
        case 'file': return this.e.path ? { $file: this.e.path } : null;
        case 'rootFolder': return { $h: { k: 'FolderItem', id: 'root' } };
        case 'selection': return [];
        case 'bitsPerChannel': return this.p.motionColor?.depth ?? 8;
        case 'linearBlending': return !!this.p.motionColor?.blendGamma1;
        case 'dirty': return true;
        case 'renderQueue': return null;
      }
      return undefined;
    }
    if (op === 'set') {
      if (n === 'bitsPerChannel') this.ops.colorSettings(this.e, { depth: Number(a[0]) as 8 | 16 | 32 });
      else if (n === 'linearBlending') this.ops.colorSettings(this.e, { blendGamma1: !!a[0] });
      return null;
    }
    switch (n) {
      case 'item': { const i = Number(a[0]); return items[i - 1] ? { $h: items[i - 1] } : fail(`app.project.item(${i}): el índice está fuera del intervalo (1–${items.length}).`); }
      case 'itemByID': { const x = items.find((y) => y.id === a[0]); return x ? { $h: x } : null; }
      case 'importFile': return this.importFile(a[0]);
      case 'save': case 'close': case 'showWindow': case 'setDefaultImportFolder': case 'autoFixExpressions': return null;
      case 'removeUnusedFootage': case 'consolidateFootage': case 'reduceProject': return 0;
      default: return this.unsupported(`app.project.${n}()`);
    }
  }
  importFile(o: unknown): unknown {
    const f = (o as { file?: { $file?: string } } | null)?.file?.$file ?? (o as { $file?: string } | null)?.$file;
    if (!f) fail('importFile necesita un ImportOptions con un archivo (new ImportOptions(new File(ruta))).');
    const path = String(f);
    if (!M.dataKind(path)) return this.unsupported('Importar vídeo, audio o imágenes desde un script (impórtelos en el panel Proyecto)');
    const [d] = this.ops.dataAdd(this.e, [{ path, text: String(this.fs('read', path)) }]);
    return { $h: { k: 'Footage', id: d.id, s: 'data' } };
  }

  kItems(_h: H, op: string, n: string, a: unknown[]): unknown {
    if (op === 'get') return n === 'length' ? this.items().length : undefined;
    if (op !== 'call') return null;
    switch (n) {
      case 'item': { const it = this.items(), i = Number(a[0]); return it[i - 1] ? { $h: it[i - 1] } : fail(`ItemCollection: el índice ${i} está fuera del intervalo (1–${it.length}).`); }
      case 'addComp': {
        const [name, w, h, pa, dur, fps] = a as [string, number, number, number, number, number];
        if (!(Number(w) >= 4 && Number(w) <= 30000 && Number(h) >= 4 && Number(h) <= 30000)) fail('addComp: anchura y altura deben estar entre 4 y 30000.');
        if (!(Number(dur) > 0)) fail('addComp: la duración debe ser mayor que 0.');
        if (!(Number(fps) >= 1 && Number(fps) <= 999)) fail('addComp: la velocidad de fotogramas debe estar entre 1 y 999.');
        if (pa !== undefined && Math.abs(Number(pa) - 1) > 1e-6) this.log.push({ kind: 'log', text: `(addComp: proporción de píxeles ${pa} no admitida; se usa 1)` });
        const c = this.ops.compNew(this.e, { name: String(name ?? 'Composición'), width: Number(w), height: Number(h), duration: Number(dur), fps: Number(fps) });
        this.openComp ??= c.id;
        return { $h: this.compH(c) };
      }
      case 'addFolder': { const f = { id: `folder${this.folders.length + 1}`, name: String(a[0] ?? 'Carpeta') }; this.folders.push(f); return { $h: { k: 'FolderItem', id: f.id } }; }
    }
    return null;
  }

  kFolderItem(h: H, op: string, n: string): unknown {
    const f = this.folders.find((x) => x.id === h.id);
    if (op === 'get') return ({ name: h.id === 'root' ? 'Raíz' : f?.name, numItems: h.id === 'root' ? this.items().length : 0, typeName: 'Carpeta', id: h.id, parentFolder: null } as Record<string, unknown>)[n];
    if (op === 'set' && n === 'name' && f) return null;
    if (op === 'call' && n === 'remove' && f) { this.folders = this.folders.filter((x) => x !== f); return null; }
    if (op === 'call' && n === 'item' && h.id === 'root') return this.kItems(h, 'call', 'item', []);
    return null;
  }

  kFootage(h: H, op: string, n: string, a: unknown[]): unknown {
    const d = h.s === 'data' ? (this.p.dataItems ?? []).find((x) => x.id === h.id) : undefined;
    const m = h.s === 'media' ? this.p.media.find((x) => x.id === h.id) : undefined;
    if (!d && !m) fail('El objeto ya no es válido: el material de archivo se ha eliminado.');
    if (op === 'get') {
      switch (n) {
        case 'name': return d ? d.name : m!.path.split(/[\\/]/).pop();
        case 'file': return { $file: d ? d.path : m!.path };
        case 'width': return m?.width ?? 0;
        case 'height': return m?.height ?? 0;
        case 'duration': return m?.duration ?? 0;
        case 'frameRate': return m?.fps ?? 0;
        case 'frameDuration': return m?.fps ? 1 / m.fps : 0;
        case 'pixelAspect': return 1;
        case 'hasVideo': return !!m?.hasVideo || m?.kind === 'image';
        case 'hasAudio': return !!m?.hasAudio;
        case 'id': return h.id;
        case 'typeName': return 'Material de archivo';
        case 'mainSource': return { $h: h };
        case 'isStill': return m?.kind === 'image';
        case 'parentFolder': return { $h: { k: 'FolderItem', id: 'root' } };
        case 'usedIn': return [];
      }
      return undefined;
    }
    if (op === 'set') { if (n === 'name' && d) this.ops.dataSet(this.e, d.id, { name: String(a[0]) }); return null; }
    if (n === 'reload' && d) { this.ops.dataReload(this.e, d.id, String(this.fs('read', d.path))); return null; }
    if (n === 'remove' && d) { this.ops.dataRemove(this.e, [d.id]); return null; }
    return this.unsupported(`FootageItem.${n}()`);
  }

  kComp(h: H, op: string, n: string, a: unknown[]): unknown {
    const c = this.comp(h.id);
    if (op === 'get') {
      switch (n) {
        case 'name': return c.name;
        case 'width': return c.width;
        case 'height': return c.height;
        case 'duration': return c.duration;
        case 'frameRate': return c.fps;
        case 'frameDuration': return 1 / c.fps;
        case 'pixelAspect': return 1;
        case 'bgColor': return M.parseColor(c.bg).slice(0, 3);
        case 'numLayers': return c.layers.length;
        case 'layers': return { $h: { k: 'Layers', c: c.id } };
        case 'workAreaStart': return c.workArea[0];
        case 'workAreaDuration': return c.workArea[1] - c.workArea[0];
        case 'time': return this.time(c.id);
        case 'id': return c.id;
        case 'typeName': return 'Composición';
        case 'selectedLayers': case 'selectedProperties': case 'usedIn': return [];
        case 'selected': return false;
        case 'motionBlur': return c.motionBlur.on;
        case 'shutterAngle': return c.motionBlur.shutter;
        case 'shutterPhase': return c.motionBlur.phase;
        case 'displayStartTime': return 0;
        case 'hideShyLayers': return false;
        case 'comment': return '';
        case 'parentFolder': return { $h: { k: 'FolderItem', id: 'root' } };
        case 'hasVideo': return true;
        case 'hasAudio': return false;
      }
      return undefined;
    }
    if (op === 'set') {
      const v = a[0];
      switch (n) {
        case 'name': this.ops.compSet(this.e, c.id, { name: String(v) }); break;
        case 'width': this.ops.compSet(this.e, c.id, { width: Number(v) }); break;
        case 'height': this.ops.compSet(this.e, c.id, { height: Number(v) }); break;
        case 'duration': this.ops.compSet(this.e, c.id, { duration: Number(v) }); break;
        case 'frameRate': this.ops.compSet(this.e, c.id, { fps: Number(v) }); break;
        case 'frameDuration': this.ops.compSet(this.e, c.id, { fps: 1 / Number(v) }); break;
        case 'bgColor': this.ops.compSet(this.e, c.id, { bg: M.colorStr((v as number[]).map(Number)) }); break;
        case 'workAreaStart': this.ops.compSet(this.e, c.id, { workArea: [Number(v), Math.max(Number(v), c.workArea[1])] }); break;
        case 'workAreaDuration': this.ops.compSet(this.e, c.id, { workArea: [c.workArea[0], c.workArea[0] + Number(v)] }); break;
        case 'time': this.times[c.id] = Number(v) || 0; break;
        case 'motionBlur': this.ops.compSet(this.e, c.id, { motionBlur: { on: !!v } }); break;
        case 'shutterAngle': this.ops.compSet(this.e, c.id, { motionBlur: { shutter: Number(v) } }); break;
        case 'shutterPhase': this.ops.compSet(this.e, c.id, { motionBlur: { phase: Number(v) } }); break;
      }
      return null;
    }
    switch (n) {
      case 'layer': return this.kLayers({ k: 'Layers', c: c.id }, 'call', 'layer', a);
      case 'duplicate': return { $h: this.compH(this.ops.compDuplicate(this.e, c.id)) };
      case 'remove': this.ops.compDelete(this.e, c.id); if (this.openComp === c.id) this.openComp = undefined; return null;
      case 'openInViewer': this.openComp = c.id; return null;
    }
    return null;
  }

  kLayers(h: H, op: string, n: string, a: unknown[]): unknown {
    const c = this.comp(h.c);
    if (op === 'get') return n === 'length' ? c.layers.length : undefined;
    if (op !== 'call') return null;
    const add = (type: M.LayerType, o: Record<string, unknown>) => {
      const l = this.ops.layerAdd(this.e, c.id, type, o as never);
      return { $h: this.layerH(c.id, l) };
    };
    const dur = (x: unknown) => (x === undefined || x === null ? undefined : Number(x));
    switch (n) {
      case 'layer': {
        const x = a[0];
        if (typeof x === 'string') { const l = c.layers.find((y) => y.name === x); return l ? { $h: this.layerH(c.id, l) } : null; }
        const i = Number(x);
        if (!c.layers[i - 1]) fail(`El índice de capa ${i} está fuera del intervalo (1–${c.layers.length}).`);
        return { $h: this.layerH(c.id, c.layers[i - 1]) };
      }
      case 'byName': { const l = c.layers.find((y) => y.name === a[0]); return l ? { $h: this.layerH(c.id, l) } : null; }
      case 'addSolid': {
        const [color, name, w, hh, , d] = a as [number[], string, number, number, number, number];
        if (!Array.isArray(color)) fail('addSolid: el color es una matriz [r, g, b] de 0 a 1.');
        return add('solid', { color: M.colorStr(color.map(Number)), name: name === undefined ? undefined : String(name), width: Number(w) || c.width, height: Number(hh) || c.height, duration: dur(d) });
      }
      case 'addText': case 'addBoxText': {
        const src = n === 'addBoxText' ? a[1] : a[0];
        const td = src && typeof src === 'object' && '$td' in (src as object) ? (src as { $td: Record<string, unknown> }).$td : null;
        const text = td ? String(td.text ?? '') : src === undefined ? '' : String(src);
        const r = add('text', { text }) as { $h: H };
        const l = this.layer(r.$h);
        if (td) this.textStyle(c, l, td);
        if (n === 'addBoxText' && Array.isArray(a[0])) this.ops.layerSet(this.e, c.id, l.id, { text: { box: (a[0] as number[]).map(Number) } });
        return r;
      }
      case 'addShape': return add('shape', {});
      case 'addNull': return add('null', { duration: dur(a[0]) });
      case 'addCamera': {
        const r = add('camera', { name: a[0] === undefined ? undefined : String(a[0]) }) as { $h: H };
        if (Array.isArray(a[1])) { const l = this.layer(r.$h); this.ops.propSet(this.e, c.id, l.id, 'camera.poi', { value: [Number(a[1][0]), Number(a[1][1]), 0] }); }
        return r;
      }
      case 'addLight': {
        const r = add('light', { name: a[0] === undefined ? undefined : String(a[0]) }) as { $h: H };
        if (Array.isArray(a[1])) { const l = this.layer(r.$h); try { this.ops.propSet(this.e, c.id, l.id, 'light.poi', { value: [Number(a[1][0]), Number(a[1][1]), 0] }); } catch { /* point lights have no point of interest */ } }
        return r;
      }
      case 'add': {
        const it = a[0] as { $h?: H } | null;
        if (!it?.$h) fail('layers.add necesita un elemento del proyecto (CompItem o FootageItem).');
        const x = it!.$h!;
        if (x.k === 'Comp') return add('comp', { compId: x.id, duration: dur(a[1]) });
        if (x.k === 'Footage' && x.s === 'media') {
          const m = this.p.media.find((y) => y.id === x.id)!;
          return add(m.kind === 'audio' ? 'audio' : m.kind === 'image' ? 'image' : 'video', { mediaId: m.id, duration: dur(a[1]) });
        }
        return this.unsupported('Añadir un archivo de datos como capa');
      }
      case 'precompose': {
        const idx = (a[0] as number[]).map(Number);
        const ids = idx.map((i) => c.layers[i - 1]?.id ?? fail(`precompose: no existe la capa ${i}.`));
        const r = this.ops.layerPrecompose(this.e, c.id, ids as string[], a[1] === undefined ? undefined : String(a[1]));
        return { $h: this.compH(r.comp) };
      }
    }
    return null;
  }

  // ── layers ──
  /** Top-level groups of a layer: [English name, match name, Spanish name, group key]. */
  layerGroups(l: Layer): Child[] {
    const g: Child[] = [];
    if (l.type === 'text') g.push(['Text', 'ADBE Text Properties', 'Texto', 'text']);
    if (l.type === 'shape') g.push(['Contents', 'ADBE Root Vectors Group', 'Contenido', 'contents']);
    if (l.camera) g.push(['Camera Options', 'ADBE Camera Options Group', 'Opciones de cámara', 'camera']);
    if (l.light) g.push(['Light Options', 'ADBE Light Options Group', 'Opciones de luz', 'light']);
    g.push(['Effects', 'ADBE Effect Parade', 'Efectos', 'effects'], ['Transform', 'ADBE Transform Group', 'Transformar', 'transform']);
    if (l.type === 'video' || l.type === 'audio' || l.type === 'comp' || l.type === 'sequence') g.push(['Audio', 'ADBE Audio Group', 'Audio', 'audio']);
    if (l.timeRemap) g.unshift(['Time Remap', 'ADBE Time Remapping', 'Reasignación de tiempo', 'prop:timeRemap']);
    return g;
  }
  kLayer(h: H, op: string, n: string, a: unknown[]): unknown {
    const c = this.comp(h.c), l = this.layer(h);
    const set = (patch: Record<string, unknown>) => this.ops.layerSet(this.e, c.id, l.id, patch as never);
    if (op === 'get') {
      switch (n) {
        case 'name': return l.name;
        case 'index': return c.layers.indexOf(l) + 1;
        case 'inPoint': return l.in;
        case 'outPoint': return l.out;
        case 'startTime': return l.start;
        case 'stretch': return l.stretch * 100;
        case 'enabled': return !l.hidden;
        case 'active': return !l.hidden && this.time(c.id) >= l.in && this.time(c.id) < l.out;
        case 'solo': return l.solo;
        case 'locked': return l.locked;
        case 'shy': return l.shy;
        case 'threeDLayer': return l.threeD;
        case 'motionBlur': return l.motionBlur;
        case 'parent': { const p = l.parent ? c.layers.find((x) => x.id === l.parent) : undefined; return p ? { $h: this.layerH(c.id, p) } : null; }
        case 'hasVideo': return l.type !== 'audio' && l.type !== 'camera' && l.type !== 'light';
        case 'hasAudio': return l.type === 'video' || l.type === 'audio';
        case 'nullLayer': return l.type === 'null';
        case 'adjustmentLayer': return l.type === 'adjustment';
        case 'isNameSet': return true;
        case 'comment': return '';
        case 'label': return 0;
        case 'containingComp': return { $h: this.compH(c) };
        case 'source': {
          if (l.compId) { const s = this.comps().find((x) => x.id === l.compId); return s ? { $h: this.compH(s) } : null; }
          if (l.mediaId) return { $h: { k: 'Footage', id: l.mediaId, s: 'media' } };
          return null;
        }
        case 'blendingMode': return Number(Object.entries(BLEND_AE).find(([, v]) => v === l.blend)?.[0] ?? 5212);
        case 'lightType': return l.light ? Number(Object.entries(LIGHT_AE).find(([, v]) => v === l.light!.type)?.[0] ?? 4403) : undefined;
        case 'timeRemapEnabled': return !!l.timeRemap;
        case 'numProperties': return this.layerGroups(l).length;
        case 'matchName': return l.type === 'text' ? 'ADBE Text Layer' : l.type === 'shape' ? 'ADBE Vector Layer' : l.type === 'camera' ? 'ADBE Camera Layer' : l.type === 'light' ? 'ADBE Light Layer' : 'ADBE AV Layer';
        case 'propertyDepth': return 0;
        case 'propertyType': return 6214;
        case 'parentProperty': return null;
        case 'id': return l.id;
        case 'selected': return false;
        case 'selectedProperties': return [];
        // attribute access to groups and transform properties: layer.transform, layer.Effects, layer.position…
        case 'transform': return { $h: { k: 'Group', c: c.id, l: l.id, g: 'transform' } };
        case 'text': return l.text ? { $h: { k: 'Group', c: c.id, l: l.id, g: 'text' } } : undefined;
        case 'effect': case 'effects': case 'Effects': return { $h: { k: 'Group', c: c.id, l: l.id, g: 'effects' } };
      }
      return this.child(c, l, 'layer', n) ?? undefined;
    }
    if (op === 'set') {
      const v = a[0];
      switch (n) {
        case 'name': set({ name: String(v) }); break;
        case 'inPoint': set({ in: Number(v) }); break;
        case 'outPoint': set({ out: Number(v) }); break;
        case 'startTime': { const d = Number(v) - l.start; set({ start: Number(v), in: l.in + d, out: Math.min(c.duration, l.out + d) }); break; }
        case 'stretch': set({ stretch: Number(v) / 100 }); break;
        case 'enabled': set({ hidden: !v }); break;
        case 'solo': set({ solo: !!v }); break;
        case 'locked': set({ locked: !!v }); break;
        case 'shy': set({ shy: !!v }); break;
        case 'threeDLayer': set({ threeD: !!v }); break;
        case 'motionBlur': set({ motionBlur: !!v }); break;
        case 'parent': set({ parent: v && typeof v === 'object' && '$h' in (v as object) ? (v as { $h: H }).$h.l as string : null }); break;
        case 'blendingMode': { const b = BLEND_AE[Number(v)]; if (!b) fail(`Modo de fusión desconocido ${v}.`); set({ blend: b }); break; }
        case 'lightType': { const t = LIGHT_AE[Number(v)]; if (!t) fail(`Tipo de luz desconocido ${v}.`); set({ light: { type: t } }); break; }
        case 'timeRemapEnabled': if (v) M.motionOps.propSet(this.e, c.id, l.id, 'timeRemap', {}); break;
        case 'label': case 'comment': case 'selected': case 'autoOrient': break;
        default: return this.unsupported(`Layer.${n} =`);
      }
      return null;
    }
    switch (n) {
      case 'property': case 'propertyGroup': return this.child(c, l, 'layer', a[0]);
      case 'remove': this.ops.layerDelete(this.e, c.id, [l.id]); return null;
      case 'duplicate': return { $h: this.layerH(c.id, this.ops.layerDuplicate(this.e, c.id, l.id)) };
      case 'moveToBeginning': this.ops.layerReorder(this.e, c.id, l.id, 1); return null;
      case 'moveToEnd': this.ops.layerReorder(this.e, c.id, l.id, c.layers.length); return null;
      case 'moveBefore': case 'moveAfter': {
        const o = (a[0] as { $h: H }).$h, other = this.layer(o);
        const cur = c.layers.indexOf(l), to = c.layers.indexOf(other);
        let idx = n === 'moveBefore' ? to : to + 1;
        if (cur < idx) idx--;
        this.ops.layerReorder(this.e, c.id, l.id, idx + 1);
        return null;
      }
      case 'setParentWithJump': { const o = a[0] as { $h: H } | null; set({ parent: o?.$h ? (o.$h.l as string) : null }); return null; }
      case 'openInViewer': this.openComp = c.id; return null;
      case 'activeAtTime': return !l.hidden && Number(a[0]) >= l.in && Number(a[0]) < l.out;
    }
    return null;
  }

  // ── property groups ──
  /** child `key` (name, match name, Spanish name or 1-based index) of a group */
  child(c: Comp, l: Layer, g: string, key: unknown): unknown {
    const H0 = { c: c.id, l: l.id };
    const grp = (k: string, extra: Record<string, unknown> = {}) => ({ $h: { k: 'Group', ...H0, g: k, ...extra } });
    const prop = (path: string, ch: Child, i: number, parent: string) => ({ $h: { k: 'Prop', ...H0, p: [path], n: ch[0], m: ch[1], i, g: parent } });
    if (g === 'layer') {
      const list = this.layerGroups(l);
      const hit = pickChild(list, key);
      if (!hit) {
        // shortcuts: layer.property("Position") works in After Effects only through Transform, but layer.position does
        const t = typeof key === 'string' ? pickChild(TRANSFORM, key) ?? (ALIASES[lc(key).replace(/ /g, '')] ? pickChild(TRANSFORM, TRANSFORM.findIndex((x) => x[3] === ALIASES[lc(key).replace(/ /g, '')]) + 1) : null) : null;
        if (t) return this.transformProp(c, l, t.c, t.i);
        // textLayer.property("Source Text") / layer.sourceText
        if (l.text && typeof key === 'string' && ['source text', 'adbe text document', 'texto de origen', 'sourcetext'].includes(lc(key))) return this.child(c, l, 'text', 1);
        if (typeof key === 'string' && /^(marker|Marker|ADBE Marker)$/.test(key)) return null;
        return null;
      }
      const k = hit.c[3];
      if (k.startsWith('prop:')) return prop(k.slice(5), hit.c, hit.i, 'layer');
      return grp(k);
    }
    if (g === 'transform') { const t = pickChild(TRANSFORM, key); return t ? this.transformProp(c, l, t.c, t.i) : null; }
    if (g === 'camera' || g === 'light') { const t = pickChild(g === 'camera' ? CAMERA : LIGHT, key); return t ? prop(t.c[3], t.c, t.i, g) : null; }
    if (g === 'audio') { const ch: Child = ['Audio Levels', 'ADBE Audio Levels', 'Niveles de audio', 'audio.level']; return key === 1 || pickChild([ch], key) ? prop('audio.level', ch, 1, 'audio') : null; }
    if (g === 'text') {
      const ch: Child = ['Source Text', 'ADBE Text Document', 'Texto de origen', 'text.text'];
      return key === 1 || pickChild([ch], key) ? prop('text.text', ch, 1, 'text') : null;
    }
    if (g === 'effects') {
      const fx = typeof key === 'number' ? l.effects[key - 1] : l.effects.find((f) => f.name === key || f.id === key) ?? l.effects.find((f) => lc(f.name) === lc(key) || f.fx === key || AE_EFFECTS[String(key)] === f.fx || aeEffectId(String(key)) === f.fx);
      return fx ? grp(`fx:${fx.id}`) : null;
    }
    if (g.startsWith('fx:')) {
      const fx = l.effects.find((f) => f.id === g.slice(3));
      if (!fx) return null;
      const defs = M.FX.find((d) => d.id === fx.fx)?.params ?? [];
      const ids = Object.keys(fx.params);
      let i = -1;
      if (typeof key === 'number') i = key - 1;
      else {
        const k = lc(key);
        const m = /-(\d{4})$/.exec(String(key));
        i = m ? Number(m[1]) - 1 : ids.findIndex((id) => lc(id) === k || lc(defs.find((d) => d.id === id)?.name ?? '') === k || lc((defs.find((d) => d.id === id)?.name ?? '').split(':').pop()!) === k);
      }
      const id = ids[i];
      if (!id) return null;
      return { $h: { k: 'Prop', ...H0, p: [`effects.${fx.id}.${id}`], n: defs.find((d) => d.id === id)?.name ?? id, m: `${aeMatchName(fx.fx) ?? fx.fx}-${String(i + 1).padStart(4, '0')}`, i: i + 1, g } };
    }
    // shape layers: Contents / Vector Group / its Contents / Fill / Stroke / Transform
    if (g === 'contents' || g.startsWith('vgc:')) {
      const vg = g === 'contents' ? '' : g.slice(4);
      const groups = [...this.vgroups.entries()].filter(([, x]) => x.l === l.id && x.parent === vg);
      const shapes = (l.shapes ?? []).filter((s) => (vg ? this.vgroups.get(vg)?.shapes.includes(s.id) : ![...this.vgroups.values()].some((x) => x.shapes.includes(s.id))));
      const list: [string, Record<string, unknown>][] = [...groups.map(([id, x]) => [x.name, { g: `vg:${id}` }] as [string, Record<string, unknown>]), ...shapes.map((s) => [s.name, { g: `sh:${s.id}` }] as [string, Record<string, unknown>])];
      const hit = typeof key === 'number' ? list[key - 1] : list.find(([nm]) => nm === key || lc(nm) === lc(key));
      return hit ? grp(String(hit[1].g)) : null;
    }
    if (g.startsWith('vg:')) {
      const k = lc(key);
      if (key === 2 || k === 'contents' || k === 'adbe vectors group' || k === 'contenido') return grp(`vgc:${g.slice(3)}`);
      if (key === 3 || k === 'transform' || k === 'adbe vector transform group' || k === 'transformar') return grp(`vgt:${g.slice(3)}`);
      return null;
    }
    if (g.startsWith('vgt:')) {
      const t = pickChild(VG_TRANSFORM, key);
      if (!t) return null;
      const ids = this.vgroups.get(g.slice(4))?.shapes ?? [];
      return { $h: { k: 'Prop', ...H0, p: ids.map((id) => `shapes.${id}.${t.c[3]}`), n: t.c[0], m: t.c[1], i: t.i, g } };
    }
    if (g.startsWith('sh:')) {
      const s = l.shapes?.find((x) => x.id === g.slice(3));
      if (!s) return null;
      const t = pickChild(SHAPE_PROPS.filter((x) => x[3] !== 'path' || s.kind === 'path'), key);
      return t ? { $h: { k: 'Prop', ...H0, p: [`shapes.${s.id}.${t.c[3]}`], n: t.c[0], m: t.c[1], i: t.i, g } } : null;
    }
    if (g.startsWith('fill:') || g.startsWith('stroke:')) {
      const [kind, vg] = g.split(':');
      const t = pickChild(kind === 'fill' ? FILL_PROPS : STROKE_PROPS, key);
      const ids = this.vgroups.get(vg)?.shapes ?? (l.shapes ?? []).map((s) => s.id);
      return t ? { $h: { k: 'Prop', ...H0, p: ids.map((id) => `shapes.${id}.${t.c[3]}`), n: t.c[0], m: t.c[1], i: t.i, g, vg, fs: kind } } : null;
    }
    return null;
  }
  transformProp(c: Comp, l: Layer, ch: Child, i: number) {
    return { $h: { k: 'Prop', c: c.id, l: l.id, p: [ch[3]], n: ch[0], m: ch[1], i, g: 'transform' } };
  }
  groupInfo(h: H, l: Layer): { name: string; match: string; n: number; index: number; parent: H | null; depth: number } {
    const g = String(h.g);
    const L = { k: 'Layer', c: h.c, l: h.l, t: l.type };
    const top = this.layerGroups(l);
    const ti = top.findIndex((x) => x[3] === g);
    if (ti >= 0) {
      const n = g === 'transform' ? TRANSFORM.length : g === 'effects' ? l.effects.length : g === 'camera' ? CAMERA.length : g === 'light' ? LIGHT.length : g === 'contents' ? this.countContents(l, '') : 1;
      return { name: top[ti][0], match: top[ti][1], n, index: ti + 1, parent: L, depth: 1 };
    }
    if (g.startsWith('fx:')) {
      const fx = l.effects.find((f) => f.id === g.slice(3));
      if (!fx) fail('El efecto se ha eliminado.');
      return { name: fx!.name, match: aeMatchName(fx!.fx) ?? fx!.fx, n: Object.keys(fx!.params).length, index: l.effects.indexOf(fx!) + 1, parent: { k: 'Group', c: h.c, l: h.l, g: 'effects' }, depth: 2 };
    }
    if (g.startsWith('vg:')) { const v = this.vgroups.get(g.slice(3)); return { name: v?.name ?? 'Grupo', match: 'ADBE Vector Group', n: 3, index: 1, parent: { k: 'Group', c: h.c, l: h.l, g: v?.parent ? `vgc:${v.parent}` : 'contents' }, depth: 2 }; }
    if (g.startsWith('vgc:')) return { name: 'Contents', match: 'ADBE Vectors Group', n: this.countContents(l, g.slice(4)), index: 2, parent: { k: 'Group', c: h.c, l: h.l, g: `vg:${g.slice(4)}` }, depth: 3 };
    if (g.startsWith('vgt:')) return { name: 'Transform', match: 'ADBE Vector Transform Group', n: VG_TRANSFORM.length, index: 3, parent: { k: 'Group', c: h.c, l: h.l, g: `vg:${g.slice(4)}` }, depth: 3 };
    if (g.startsWith('sh:')) { const s = l.shapes?.find((x) => x.id === g.slice(3)); return { name: s?.name ?? '', match: Object.entries(SHAPE_ADD).find(([, v]) => v === s?.kind)?.[0] ?? 'ADBE Vector Shape - Group', n: 3, index: 1, parent: null, depth: 3 }; }
    if (g.startsWith('fill:')) return { name: 'Fill 1', match: 'ADBE Vector Graphic - Fill', n: FILL_PROPS.length, index: 1, parent: null, depth: 3 };
    if (g.startsWith('stroke:')) return { name: 'Stroke 1', match: 'ADBE Vector Graphic - Stroke', n: STROKE_PROPS.length, index: 1, parent: null, depth: 3 };
    return { name: g, match: g, n: 0, index: 1, parent: L, depth: 1 };
  }
  countContents(l: Layer, vg: string) {
    return [...this.vgroups.values()].filter((x) => x.l === l.id && x.parent === vg).length + (l.shapes ?? []).filter((s) => (vg ? this.vgroups.get(vg)?.shapes.includes(s.id) : ![...this.vgroups.values()].some((x) => x.shapes.includes(s.id)))).length;
  }
  kGroup(h: H, op: string, n: string, a: unknown[]): unknown {
    const c = this.comp(h.c), l = this.layer(h), g = String(h.g);
    if (op === 'get') {
      const info = this.groupInfo(h, l);
      switch (n) {
        case 'name': return info.name;
        case 'matchName': return info.match;
        case 'numProperties': return info.n;
        case 'propertyIndex': return info.index;
        case 'parentProperty': return info.parent ? { $h: info.parent } : null;
        case 'propertyDepth': return info.depth;
        case 'propertyType': return g === 'effects' || g === 'contents' || g.startsWith('vgc:') ? 6213 : 6214;
        case 'enabled': return g.startsWith('fx:') ? l.effects.find((f) => f.id === g.slice(3))?.on !== false : true;
        case 'active': case 'canSetEnabled': return true;
        case 'isEffect': return g.startsWith('fx:');
        case 'isModified': return true;
        case 'isMask': return false;
        case 'elided': return false;
        case 'selected': return false;
      }
      return this.child(c, l, g, n) ?? undefined;
    }
    if (op === 'set') {
      if (n === 'enabled' && g.startsWith('fx:')) this.ops.effectSet(this.e, c.id, l.id, g.slice(3), { on: !!a[0] });
      else if (n === 'name' && g.startsWith('fx:')) this.ops.effectSet(this.e, c.id, l.id, g.slice(3), { name: String(a[0]) });
      else if (n === 'name' && g.startsWith('vg:')) { const v = this.vgroups.get(g.slice(3)); if (v) v.name = String(a[0]); }
      else if (n === 'name' && g.startsWith('sh:')) this.ops.shapeSet(this.e, c.id, l.id, g.slice(3), { name: String(a[0]) });
      return null;
    }
    switch (n) {
      case 'property': return this.child(c, l, g, a[0]);
      case 'propertyGroup': { const up = Math.max(1, Number(a[0] ?? 1)); let cur: H | null = h; for (let i = 0; i < up && cur; i++) cur = cur.k === 'Layer' ? null : this.groupInfo(cur, l).parent; return cur ? { $h: cur } : null; }
      case 'canAddProperty': return this.addTarget(l, g, String(a[0])) !== null;
      case 'addProperty': return this.addProperty(c, l, g, String(a[0]));
      case 'remove':
        if (g.startsWith('fx:')) { this.ops.effectRemove(this.e, c.id, l.id, g.slice(3)); return null; }
        if (g.startsWith('sh:')) { this.ops.shapeRemove(this.e, c.id, l.id, g.slice(3)); return null; }
        if (g.startsWith('vg:')) { const v = this.vgroups.get(g.slice(3)); for (const s of v?.shapes ?? []) this.ops.shapeRemove(this.e, c.id, l.id, s); this.vgroups.delete(g.slice(3)); return null; }
        return this.unsupported(`Quitar «${g}»`);
      case 'moveTo': if (g.startsWith('fx:')) { this.ops.effectSet(this.e, c.id, l.id, g.slice(3), { index: Number(a[0]) }); return null; } return this.unsupported('moveTo');
      case 'duplicate': return this.unsupported('PropertyGroup.duplicate()');
    }
    return null;
  }
  /** What addProperty(name) would add on this group: an effect id, a shape kind, a group, a fill / stroke. */
  addTarget(l: Layer, g: string, name: string): { fx?: string; shape?: M.ShapeKind; vg?: true; paint?: 'fill' | 'stroke' } | null {
    if (g === 'effects') {
      const id = AE_EFFECTS[name] ?? M.FX.find((d) => d.id === name || lc(d.name) === lc(name))?.id ?? aeEffectId(name) ?? M.FX.find((d) => lc(d.id) === lc(name.replace(/^ADBE /, '').replace(/[^a-z0-9]/gi, '')))?.id;
      return id ? { fx: id } : null;
    }
    if (l.type === 'shape' && (g === 'contents' || g.startsWith('vgc:'))) {
      if (name === 'ADBE Vector Group' || lc(name) === 'group') return { vg: true };
      const k = SHAPE_ADD[name] ?? (({ rectangle: 'rect', rect: 'rect', ellipse: 'ellipse', star: 'star', polystar: 'star', path: 'path' } as Record<string, M.ShapeKind>)[lc(name)]);
      if (k) return { shape: k };
      if (name === 'ADBE Vector Graphic - Fill' || lc(name) === 'fill') return { paint: 'fill' };
      if (name === 'ADBE Vector Graphic - Stroke' || lc(name) === 'stroke') return { paint: 'stroke' };
    }
    return null;
  }
  addProperty(c: Comp, l: Layer, g: string, name: string): unknown {
    const t = this.addTarget(l, g, name);
    if (!t) return fail(`No se puede añadir «${name}» a este grupo de propiedades${g === 'effects' ? ' (Cinta no tiene ese efecto)' : ''}.`);
    if (t.fx) { const r = this.ops.effectAdd(this.e, c.id, l.id, t.fx); return { $h: { k: 'Group', c: c.id, l: l.id, g: `fx:${r.id}` } }; }
    const vgKey = g.startsWith('vgc:') ? g.slice(4) : '';
    if (t.vg) {
      const id = `g${this.vgroups.size + 1}`;
      this.vgroups.set(id, { c: c.id, l: l.id, shapes: [], name: `Grupo ${[...this.vgroups.values()].filter((x) => x.l === l.id).length + 1}`, parent: vgKey });
      return { $h: { k: 'Group', c: c.id, l: l.id, g: `vg:${id}` } };
    }
    const vg = vgKey ? this.vgroups.get(vgKey) : undefined;
    const targets = () => (vg ? vg.shapes : (l.shapes ?? []).map((s) => s.id));
    if (t.shape) {
      const r = this.ops.shapeAdd(this.e, c.id, l.id, { kind: t.shape, color: vg?.fill ? vg.fill.color : null, stroke: vg?.stroke?.color, strokeWidth: vg?.stroke?.width, ...(t.shape === 'rect' ? { width: 100, height: 100 } : t.shape === 'ellipse' ? { width: 100, height: 100 } : {}) });
      if (!vg?.stroke) this.ops.shapeSet(this.e, c.id, l.id, r.shape.id, { stroke: false });
      vg?.shapes.push(r.shape.id);
      return { $h: { k: 'Group', c: c.id, l: l.id, g: `sh:${r.shape.id}` } };
    }
    // Fill / Stroke: paints every shape of the group (and the ones added to it later), white fill / white 2 px stroke like AE… with AE's defaults (red fill, white stroke)
    const kind = t.paint!;
    if (vg) { if (kind === 'fill') vg.fill = { color: '#ff0000', opacity: 100 }; else vg.stroke = { color: '#ffffff', opacity: 100, width: 2 }; }
    for (const id of targets()) {
      this.ops.shapeSet(this.e, c.id, l.id, id, kind === 'fill' ? { fill: true } : { stroke: true });
      this.ops.propSet(this.e, c.id, l.id, `shapes.${id}.${kind}.color`, { value: kind === 'fill' ? '#ff0000' : '#ffffff' });
      if (kind === 'stroke') this.ops.propSet(this.e, c.id, l.id, `shapes.${id}.stroke.width`, { value: 2 });
    }
    return { $h: { k: 'Group', c: c.id, l: l.id, g: `${kind}:${vgKey}` } };
  }

  // ── properties ──
  kProp(h: H, op: string, n: string, a: unknown[]): unknown {
    const c = this.comp(h.c), l = this.layer(h);
    const paths = (h.p as string[]) ?? [];
    if (!paths.length) fail('El grupo todavía no tiene formas: añada primero un rectángulo, una elipse o una estrella.');
    const path = paths[0];
    if (/^transform\.position[XYZ]$/.test(path) && !M.isSeparated(l) && !['name', 'matchName', 'propertyIndex', 'parentProperty', 'propertyDepth', 'isSeparationFollower', 'dimensionsSeparated'].includes(n)) fail(`«${h.n}» solo existe con las dimensiones separadas (Position.dimensionsSeparated = true).`);
    if (path === 'transform.position' && M.isSeparated(l) && (n === 'setValue' || n === 'setValueAtTime' || n === 'setValuesAtTimes')) fail('Las dimensiones de la posición están separadas: anime Posición X / Posición Y.');
    const prop = () => M.resolveProp(l, path);
    const spatial = M.isSpatial(M.canonPath(path));
    const env = () => ({ comp: c, layer: l, path: M.stablePath(l, path) });
    const key = (i: unknown) => { const k = prop().k?.[Number(i) - 1]; if (!k) fail(`El índice de fotograma clave ${i} está fuera del intervalo (1–${prop().k?.length ?? 0}).`); return k!; };
    const each = (fn: (p: string) => void) => { for (const p of paths) fn(p); };
    const fromAE = (v: unknown, p = path) => this.fromAE(c, l, p, v, M.resolveProp(l, p).v);
    if (op === 'get') {
      const pr = prop();
      switch (n) {
        case 'value': M.useProjectData(this.p); return this.toAE(l, path, M.valueAt(pr, this.time(c.id), env()));
        case 'name': return h.n;
        case 'matchName': return h.m;
        case 'numKeys': return pr.k?.length ?? 0;
        case 'expression': return pr.x ?? '';
        case 'expressionEnabled': return !!pr.x && !pr.xOff;
        case 'expressionError': return M.exprErrors.get(`${l.id}|${M.stablePath(l, path)}`) ?? '';
        case 'canSetExpression': case 'canVaryOverTime': case 'enabled': case 'active': return true;
        case 'isTimeVarying': return !!pr.k?.length || (!!pr.x && !pr.xOff);
        case 'isSpatial': return spatial;
        case 'propertyIndex': return h.i ?? 1;
        case 'parentProperty': return h.g === 'layer' ? { $h: { k: 'Layer', c: c.id, l: l.id, t: l.type } } : { $h: { k: 'Group', c: c.id, l: l.id, g: h.g } };
        case 'propertyDepth': return String(h.g).startsWith('fx:') ? 3 : 2;
        case 'propertyType': return 6212;
        case 'propertyValueType': { const v = pr.v; return path === 'text.text' ? 6424 : M.isColor(v) ? 6418 : Array.isArray(v) ? (v.length >= 3 ? (spatial ? 6413 : 6414) : (spatial ? 6415 : 6416)) : 6417; }
        case 'dimensionsSeparated': return path === 'transform.position' ? M.isSeparated(l) : false;
        case 'isSeparationLeader': return path === 'transform.position';
        case 'isSeparationFollower': return /^transform\.position[XYZ]$/.test(path);
        case 'hasMin': case 'hasMax': return false;
        case 'unitsText': return '';
        case 'selectedKeys': return [];
        case 'isModified': return true;
        case 'elided': case 'selected': return false;
      }
      return undefined;
    }
    if (op === 'set') {
      const v = a[0];
      switch (n) {
        case 'expression': each((p) => this.ops.propSet(this.e, c.id, l.id, p, { expression: v === '' || v === null ? null : String(v) })); return null;
        case 'expressionEnabled': this.e.mutate('Expresión', () => { for (const p of paths) { const pr = M.resolveProp(l, p); if (v) delete pr.xOff; else if (pr.x) pr.xOff = true; } }); return null;
        case 'dimensionsSeparated': if (path === 'transform.position') this.ops.separateDimensions(this.e, c.id, l.id, !!v); return null;
        case 'selected': return null;
      }
      return this.unsupported(`Property.${n} =`);
    }
    switch (n) {
      case 'setValue': each((p) => {
        const pr = M.resolveProp(l, p);
        if (pr.k?.length) fail(`No se puede usar setValue en «${h.n}» porque tiene fotogramas clave: use setValueAtTime.`);
        this.ops.propSet(this.e, c.id, l.id, p, { value: fromAE(a[0], p) as PVal });
      }); return null;
      case 'setValueAtTime': each((p) => this.ops.propSet(this.e, c.id, l.id, p, { t: Number(a[0]), value: fromAE(a[1], p) as PVal })); return null;
      case 'setValuesAtTimes': {
        const ts = a[0] as number[], vs = a[1] as unknown[];
        if (!Array.isArray(ts) || !Array.isArray(vs) || ts.length !== vs.length) fail('setValuesAtTimes: las matrices de tiempos y valores deben tener la misma longitud.');
        each((p) => { for (let i = 0; i < ts.length; i++) this.ops.propSet(this.e, c.id, l.id, p, { t: Number(ts[i]), value: fromAE(vs[i], p) as PVal }); });
        return null;
      }
      case 'valueAtTime': { const t = Number(a[0]); M.useProjectData(this.p); return this.toAE(l, path, a[1] ? M.keyedAt(prop(), t, spatial) : M.valueAt(prop(), t, env())); }
      case 'addKey': {
        const t = Number(a[0]);
        each((p) => { const pr = M.resolveProp(l, p); this.ops.propSet(this.e, c.id, l.id, p, { t, value: M.keyedAt(pr, t, M.isSpatial(M.canonPath(p))) }); });
        return (prop().k ?? []).findIndex((k) => Math.abs(k.t - t) < 1e-4) + 1;
      }
      case 'removeKey': { const t = key(a[0]).t; each((p) => this.ops.keyframeRemove(this.e, c.id, l.id, p, [t])); return null; }
      case 'keyTime': return key(a[0]).t;
      case 'keyValue': return this.toAE(l, path, key(a[0]).v);
      case 'setValueAtKey': { const t = key(a[0]).t; each((p) => this.ops.propSet(this.e, c.id, l.id, p, { t, value: fromAE(a[1], p) as PVal })); return null; }
      case 'nearestKeyIndex': { const ks = prop().k ?? []; if (!ks.length) fail(`«${h.n}» no tiene fotogramas clave.`); const t = Number(a[0]); let b = 0; ks.forEach((k, i) => { if (Math.abs(k.t - t) < Math.abs(ks[b].t - t)) b = i; }); return b + 1; }
      case 'keyInInterpolationType': case 'keyOutInterpolationType': {
        const ks = prop().k ?? [], i = Number(a[0]) - 1; key(a[0]);
        const seg = n === 'keyOutInterpolationType' ? ks[i] : ks[i - 1];
        if (!seg) return 6612;
        return seg.i === 'hold' ? 6614 : seg.i === 'bezier' ? 6613 : 6612;
      }
      case 'setInterpolationTypeAtKey': {
        const i = Number(a[0]) - 1; key(a[0]);
        const tin = INTERP[Number(a[1])] ?? fail(`Tipo de interpolación desconocido ${a[1]}.`);
        const tout = a[2] === undefined ? tin : INTERP[Number(a[2])] ?? fail(`Tipo de interpolación desconocido ${a[2]}.`);
        this.e.mutate('Interpolación de fotogramas clave', () => {
          for (const p of paths) {
            const ks = M.resolveProp(l, p).k ?? [];
            const k = ks[i], prev = ks[i - 1];
            if (!k) continue;
            // the segment leaving the key takes the out type; the one arriving, the in type
            if (tout === 'hold') k.i = 'hold'; else if (tout === 'linear') { k.i = 'linear'; delete k.eo; } else { k.i = 'bezier'; k.eo ??= [1 / 3, 1 / 3]; }
            if (prev) { if (tin === 'hold') prev.i = 'hold'; else if (tin === 'linear') { delete k.ei; if (prev.i === 'hold') prev.i = 'linear'; } else { k.ei ??= [2 / 3, 2 / 3]; if (prev.i !== 'bezier') { prev.i = 'bezier'; prev.eo ??= [1 / 3, 1 / 3]; } } }
          }
        });
        return null;
      }
      case 'setTemporalEaseAtKey': {
        const t = key(a[0]).t;
        const side = (x: unknown) => { const arr = x as { speed: number; influence: number }[] | undefined; if (!Array.isArray(arr) || !arr.length) return undefined; return { speed: arr.length > 1 ? arr.map((e) => Number(e.speed)) : Number(arr[0].speed), influence: Number(arr[0].influence) }; };
        const sIn = side(a[1]), sOut = side(a[2] ?? a[1]);
        each((p) => this.ops.keyframeVelocity(this.e, c.id, l.id, p, { times: [t], set: { in: sIn, out: sOut } }));
        return null;
      }
      case 'keyInTemporalEase': case 'keyOutTemporalEase': {
        const t = key(a[0]).t;
        const v = (this.ops.keyframeVelocity(this.e, c.id, l.id, path, { times: [t] }) as M.KeyVel[])[0];
        const s = n === 'keyInTemporalEase' ? v.in : v.out;
        const dims = spatial ? 1 : v.dims;
        return Array.from({ length: dims }, (_, d) => ({ $ease: [s ? (spatial ? s.speed[0] : s.speed[d] ?? s.speed[0]) : 0, s ? s.influence : 16.666667] }));
      }
      case 'setTemporalContinuousAtKey': { const t = key(a[0]).t; each((p) => this.ops.keyframeVelocity(this.e, c.id, l.id, p, { times: [t], set: { continuous: !!a[1] } })); return null; }
      case 'keyTemporalContinuous': return !!key(a[0]).tc;
      case 'setTemporalAutoBezierAtKey': { const t = key(a[0]).t; if (a[1]) each((p) => this.ops.keyframeInterp(this.e, c.id, l.id, p, 'auto', [t])); return null; }
      case 'keyTemporalAutoBezier': return !!key(a[0]).ta;
      case 'keySelected': return false;
      case 'setSelectedAtKey': case 'setSpatialTangentsAtKey': case 'setSpatialContinuousAtKey': case 'setSpatialAutoBezierAtKey': case 'setRovingAtKey': return null;
      case 'propertyGroup': return this.kGroup({ k: 'Group', c: c.id, l: l.id, g: h.g }, 'call', 'propertyGroup', [Math.max(1, Number(a[0] ?? 1)) - 1 || 0]) ?? { $h: { k: 'Group', c: c.id, l: l.id, g: h.g } };
      case 'getSeparationFollower': { const d = Number(a[0]); const t = TRANSFORM[2 + d]; return t ? this.transformProp(c, l, t, 3 + d) : null; }
      case 'addToMotionGraphicsTemplate': return false;
    }
    return null;
  }
}

// ───────────────────────── running ─────────────────────────
/** ExtendScript preprocessor: #include / //@include inlined, #target and friends removed. */
export function preprocess(code: string, file: string | undefined, read: (path: string) => string, depth = 0): string {
  const dir = file ? dirname(resolve(file)) : resolve('.');
  return code.replace(/^﻿/, '').replace(/^[ \t]*(?:#|\/\/@)(include|includepath|target|targetengine|strict|script|engine)\b[^\n]*$/gm, (line, kw: string) => {
    if (kw !== 'include') return '';
    const m = /["']([^"']+)["']/.exec(line);
    if (!m || depth > 8) return '';
    const p = resolve(dir, m[1]);
    return preprocess(read(p), p, read, depth + 1).replace(/\n/g, ' ');
  });
}

function count(p: Project) {
  let keys = 0, expr = 0, fx = 0;
  const layers = new Map<string, { comp: string; layer: string; type: string }>();
  for (const c of p.comps ?? []) for (const l of c.layers) {
    layers.set(l.id, { comp: c.name, layer: l.name, type: l.type });
    fx += l.effects.length;
    M.forEachProp(l, (pr) => { keys += pr.k?.length ?? 0; if (pr.x) expr++; });
  }
  return { comps: new Map((p.comps ?? []).map((c) => [c.id, c.name])), layers, keys, expr, fx, data: p.dataItems?.length ?? 0 };
}

/** The run itself, synchronous: every operation is its own undo step unless the caller groups them (runScript). */
export function runScriptSync(e: Editor, code: string, o: ScriptOptions = {}): ScriptResult {
  const t0 = Date.now();
  const host = new Host(e, o);
  const before = count(e.project);
  const ctx = vm.createContext(Object.create(null), { name: 'Cinta script', codeGeneration: { strings: true, wasm: false } });
  const runtime = vm.runInContext(`(${aeRuntime.toString()})`, ctx) as (b: (s: string) => string, k: string) => void;
  runtime((s: string) => host.handle(String(s)), JSON.stringify(KINDS));
  let error: ScriptResult['error'];
  const name = o.file ? resolve(o.file) : 'script.jsx';
  M.useProjectData(e.project);
  {
    try {
      const src = preprocess(code, o.file, (p) => String(host.fs('read', p)));
      new vm.Script(src, { filename: name }).runInContext(ctx, { timeout: o.timeout ?? 10000, breakOnSigint: true });
    } catch (err) {
      const x = err as { message?: string; stack?: string; code?: string };
      const msg = x?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? `El script superó el tiempo máximo (${+((o.timeout ?? 10000) / 1000).toFixed(1)} s).` : String(x?.message ?? err);
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const line = Number(new RegExp(`${esc}:(\\d+)`).exec(String(x?.stack ?? ''))?.[1]) || undefined;
      error = { message: msg, line };
      host.log.push({ kind: 'error', text: `Se produjo el error siguiente durante la ejecución del script: ${msg}${line ? ` (línea ${line})` : ''}` });
    }
  }
  M.useProjectData(e.project);
  const after = count(e.project);
  const compsAdded = [...after.comps].filter(([id]) => !before.comps.has(id)).map(([, n]) => n);
  const compsRemoved = [...before.comps].filter(([id]) => !after.comps.has(id)).map(([, n]) => n);
  const layersAdded = [...after.layers].filter(([id]) => !before.layers.has(id)).map(([, v]) => v);
  const layersRemoved = [...before.layers.keys()].filter((id) => !after.layers.has(id)).length;
  const openComp = host.openComp && (e.project.comps ?? []).some((c) => c.id === host.openComp) ? host.openComp : undefined;
  return {
    ok: !error, error, log: host.log, output: host.log.map((x) => (x.kind === 'alert' ? `[alert] ${x.text}` : x.text)).join('\n'), undoGroups: host.undoGroups,
    changes: { compsAdded, compsRemoved, layersAdded, layersRemoved, keyframes: after.keys - before.keys, expressions: after.expr - before.expr, effects: after.fx - before.fx, dataItems: after.data - before.data },
    openComp, seconds: (Date.now() - t0) / 1000,
  };
}
/** Runs an After Effects script on the project: one undo step for the whole run (nothing changes if it fails
 *  before changing anything; a script that throws keeps what it did up to there, like After Effects, and one undo
 *  removes it). */
export async function runScript(e: Editor, code: string, o: ScriptOptions = {}): Promise<ScriptResult> {
  return e.batch(async () => runScriptSync(e, code, o));
}
/** Reads and runs a .jsx / .js file. */
export async function runScriptFile(e: Editor, file: string, o: Omit<ScriptOptions, 'file'> = {}): Promise<ScriptResult> {
  if (!existsSync(file)) throw new Error(`No se puede encontrar el archivo ${file}.`);
  if (/\.jsxbin$/i.test(file)) throw new Error('Los archivos JavaScript binarios (.jsxbin) no se pueden ejecutar en Cinta.');
  return runScript(e, readFileSync(file, 'utf8'), { ...o, file });
}
