# Especificación — motion (modo avanzado)

## Requisito: Interruptor de modo
- DADO el editor en modo simple, CUANDO se activa «Avanzado», ENTONCES la ventana muestra Proyecto, Composición,
  Línea de tiempo de capas, Controles de efectos, Efectos y ajustes preestablecidos, Carácter, Alinear y Previsualizar,
  y oculta las colecciones de Movavi. Volver a «Simple» restaura la disposición. La elección se recuerda.

## Requisito: Composición y capas
- Una composición tiene tamaño, fps, duración y fondo, y una lista ordenada de capas (la primera, arriba).
- Cada capa tiene entrada/salida, inicio, estiramiento, visible/solo/bloqueo, 3D, desenfoque de movimiento, modo de
  fusión, mate de seguimiento y primario. Deshacer/rehacer cubre todo, también entre llamadas MCP.

## Requisito: Propiedades animables
- Toda propiedad numérica, vectorial o de color puede tener valor fijo, fotogramas clave o expresión.
- Interpolación lineal, bezier (curva cúbica por segmento) o mantener; la posición sigue una trayectoria curva.
- ESCENARIO: con claves 0 s → 0 y 1 s → 100 y Easy Ease, el valor en 0.5 s es 50 y en 0.1 s es < 10.
- ESCENARIO: `wiggle(2, 30)` es determinista (mismo valor al volver a renderizar) y está dentro de ±30.
- ESCENARIO: `loopOut('cycle')` repite el tramo de claves.

## Requisito: Render
- El fotograma t de la composición es idéntico en vista previa y exportación (mismo motor).
- El desenfoque de movimiento promedia subfotogramas según el ángulo de obturación.
- Las capas 3D se proyectan con la cámara activa (o una por defecto) y se ordenan por profundidad.
- Mates de seguimiento, máscaras (añadir/restar/intersecar, calado, invertida) y modos de fusión se respetan.
- La exportación produce MP4/MOV/WebM/GIF/PNG con el audio de las capas mezclado; MOV ProRes 4444 y WebM conservan alfa.

## Requisito: Texto, formas, efectos y preajustes
- Los animadores de texto afectan por carácter, palabra o línea según el selector.
- Recortar trazados dibuja la fracción [inicio, fin] del contorno; el repetidor crea N copias transformadas.
- Cada efecto del catálogo se aplica, se anima y se quita; un preajuste crea claves, expresiones o animadores.

## Requisito: Integración y MCP
- Una composición puede añadirse a la línea de tiempo simple (se renderiza en caché por contenido).
- La línea de tiempo simple puede usarse como capa «Secuencia» (sin referencias circulares).
- Cada operación de la interfaz tiene herramienta MCP; `comp_frame` devuelve el PNG de un instante.
