# Propuesta: Cinta — editor de vídeo (fase 1, clon funcional)

## Intención

Shot captura pantalla y hace guías; su `video_edit` re-renderiza en tiempo real y es lento y limitado. Hace falta un
editor de vídeo serio y separado, con el flujo de Movavi Video Suite 22 «Editar vídeo» (programa que el usuario
conoce), y que **todas** sus funciones se puedan usar por MCP para que una IA edite vídeos con facilidad.

## Alcance

**Dentro (fase 1)**
- App de escritorio Windows (Electron + Vite + TypeScript), portable e instalador NSIS, interfaz en español.
- Disposición y flujo de Movavi: riel de iconos, categorías, colección, reproductor, barra de edición, línea de
  tiempo con pista principal magnética, pistas superpuestas, de títulos y de audio; exportación.
- Motor de render sobre ffmpeg (portátil, incluido). Un único compositor para vista previa, exportación y MCP.
- Proyecto `.cinta` (JSON abierto y versionado) + exportación a MLT XML (Shotcut/Kdenlive).
- Todas las funciones del inventario marcadas F1 (`docs/INVENTARIO.md`).
- Servidor MCP (stdio, sin interfaz) que opera sobre proyectos y renderiza; la app abierta recarga el proyecto
  cuando el MCP lo cambia.
- Automatizaciones del kit de shorts: quitar silencios, subtítulos automáticos (Whisper local), reencuadre 9:16/1:1,
  música con ducking, normalización −14 LUFS.
- Pruebas de extremo a extremo por MCP que verifican resultados por contenido (duraciones, píxeles, sonido).

**Fuera**
- Servicios de Movavi (tienda, cuenta, nube, subir a redes), cuestionarios, DVD/SWF.
- Activos propietarios de Movavi (iconos, imágenes, fuentes, muestras, marca). Todo se dibuja o genera.
- Fase 2: rediseño UX y funciones originales (rastreo de movimiento IA, partículas, plantillas).

## Enfoque

- `src/core`: lógica pura de Node (modelo, operaciones con deshacer, catálogos, compilador a filtergraph de ffmpeg,
  análisis). Lo comparten la app y el MCP; se prueba sin Electron.
- La vista previa usa el mismo compilador: fotograma suelto al buscar y flujo fMP4 de baja resolución
  (MediaSource) al reproducir, así lo que se ve es lo que se exporta.
- Nombre propio: **Cinta**. Iconos SVG propios con el mismo tamaño y posición que los de Movavi.

## Riesgos

- Rendimiento de la vista previa con proyectos pesados → resolución de vista previa baja y caché de fotogramas.
- `xfade` exige mismas dimensiones/fps/base de tiempo → normalizar cada clip antes de encadenar.
- Tamaño del paquete (ffmpeg + ffprobe ≈ 160 MB) → compresión máxima; aceptable para el usuario.
- Modelos Whisper (≈ 100 MB–1 GB) → no se incluyen; se usa una carpeta de modelos configurable (el kit de shorts
  ya tiene `whisper-turbo`) o se descargan bajo demanda.

## Criterio de éxito

Inventario completo; la app reproduce los flujos principales (importar → cortar → transiciones → títulos → música →
exportar); cada función F1 tiene herramienta MCP con prueba e2e en verde; `Cinta-Portable-1.0.0.exe` y
`Cinta-Setup-1.0.0.exe` generados y probados.
