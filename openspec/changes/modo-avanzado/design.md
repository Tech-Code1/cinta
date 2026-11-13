# Diseño — modo-avanzado

## Módulos
- `src/core/motion/` (Node puro, lo usan la app y el MCP)
  - `model.ts` tipos (`Comp`, `Layer`, `Prop`, `Key`, `Mask`, `ShapeItem`, `TextAnimator`, `FxInstance`) y fábricas.
  - `anim.ts` evaluación: bezier temporal (cúbica por segmento, `x→t` por Newton + bisección), trayectoria espacial
    Catmull-Rom reparametrizada por longitud, `hold`; expresiones (`new Function` + `with` + `eval` para el valor de la
    última línea) con `wiggle` (ruido suave con octavas sembrado por capa y propiedad), `loopOut/loopIn`,
    `linear/ease`, `random/seedRandom`, `valueAtTime`, `thisComp.layer(n)`.
  - `geom.ts` matrices 4×4, parenting, trazados de formas (aplanado bezier), recortar trazados.
  - `text.ts` disposición por caracteres (medida inyectada) y pesos de los selectores.
  - `effects.ts` catálogo (parámetros, rangos, valores por defecto); `presets.ts` ajustes preestablecidos propios.
  - `ops.ts` operaciones sobre `Project.comps` con `Editor.mutate` (deshacer incluido).
- `src/motion-render/` (navegador: ventana principal y ventana oculta de exportación)
  - `render.ts` `renderComp(comp, t, sources)` → canvas. Por capa: fuente → máscaras → efectos → transformación
    (2D con `setTransform`; 3D con WebGL) → mate → fusión (`globalCompositeOperation`). Desenfoque de movimiento con
    N subfotogramas promediados. Capa de ajuste: sus efectos sobre lo que hay debajo.
  - `fx.ts` efectos con filtros de Canvas, `getImageData` (niveles, umbral, clave, enfocar) y composición.
  - Fuentes: vídeo por `HTMLVideoElement` con el protocolo `cinta-media:` (vista previa y exportación con espera de
    `seeked` + `requestVideoFrameCallback`, fotograma exacto).
- `src/main/motion.ts` ventana oculta de render, bucle de fotogramas → ffmpeg (stdin rawvideo) + mezcla de audio;
  caché por hash; modo CLI `--render-comp` para el servidor MCP (que corre como Node).
- `src/renderer/advanced/` interfaz del modo avanzado.

## Decisiones
- **Canvas 2D + WebGL en lugar de ffmpeg** para el modo avanzado: ffmpeg no permite de forma práctica trayectorias
  bezier, animadores por carácter, expresiones ni 3D con cámara; el navegador sí, y es el mismo motor en vista previa y
  exportación. El modo simple sigue con ffmpeg.
- **Edición local + confirmación**: la interfaz edita una copia durante el arrastre y confirma un solo paso de deshacer
  al soltar (`setComp`).
- **Determinismo**: toda aleatoriedad es sembrada (capa, propiedad, tiempo); partículas analíticas sin estado.
- **Integración**: `MediaItem.kind = 'comp'` con `compId`; el compositor ffmpeg usa el archivo en caché.
