# Propuesta — modo-avanzado

## Intención
Llevar Cinta de editor sencillo (clon de Movavi) a editor de **gráficos en movimiento y composición** al nivel de
After Effects, sin estorbar a quien edita en modo simple: un **interruptor Simple / Avanzado** cambia toda la
disposición de la ventana. Todo lo que se hace con el ratón se puede hacer por MCP y viceversa.

## Alcance
- Composiciones con capas (metraje, imagen, sólido, texto, forma, nulo, ajuste, cámara, audio, composición, secuencia).
- Animación por fotogramas clave con suavizado bezier, trayectorias curvas, editor de gráficos, expresiones,
  asistentes (Easy Ease, Wiggler, Smoother, secuenciar), parenting, desenfoque de movimiento, 3D con cámara.
- Texto con animadores y selectores; formas con relleno/trazo/degradado/recortar trazados/repetidor; máscaras.
- ~50 efectos propios (inventario en `docs/INVENTARIO-AE.md`) y ~40 ajustes preestablecidos propios.
- Motor de render único (Canvas 2D + WebGL) para vista previa y exportación (fotograma exacto, determinista).
- Integración: las composiciones se usan como clips en el modo simple; la línea de tiempo simple puede ser una capa.
- MCP: herramientas `comp_*`, `layer_*`, `prop_set`, `keyframe_*`, `expression_set`, `effect_*`, `mask_*`,
  `shape_add`, `text_animator_add`, `preset_apply`, `comp_frame`, `comp_render`, `comp_to_timeline`.

## Fuera de alcance
Rotoscopia, Puppet, seguimiento 3D, Cinema 4D/luces/materiales, Lumetri/OCIO, plugins de terceros.

## Riesgos
- Rendimiento del render por Canvas en 1080p/60 con muchos efectos → resolución de vista previa, previsualización RAM
  y exportación fuera de tiempo real.
- `eval` de expresiones en el renderizador → CSP con `unsafe-eval` solo en la ventana local; sin Node en el renderizador.
- Tamaño del cambio → por capas: núcleo puro probado en Node, render probado por píxeles, UI con autoprueba.
