# Tareas — editor-fase1

## 1. Base
- [x] 1.1 Proyecto Electron + Vite + TS, build de main con esbuild, electron-builder (NSIS + portable)
- [x] 1.2 ffmpeg/ffprobe portátiles resueltos dentro y fuera del asar

## 2. Núcleo (`src/core`)
- [x] 2.1 Modelo, valores por defecto, empaquetado de la pista principal
- [x] 2.2 Editor con operaciones y deshacer/rehacer
- [x] 2.3 Catálogos propios (filtros, transiciones, títulos, adhesivos, llamadas, máscaras, PiP, panorámica, animaciones, audio, exportación)
- [x] 2.4 Compositor (render.ts) con rango, fotograma y vista previa
- [x] 2.5 ASS para títulos/subtítulos; gráficos SVG → PNG
- [x] 2.6 Análisis: silencios, escenas, ritmo, sincronización, estabilización, forma de onda
- [x] 2.7 Voz a texto (sherpa-onnx), SRT, MLT, automatizaciones

## 3. MCP
- [x] 3.1 Servidor stdio con herramientas para todo el inventario F1
- [x] 3.2 Pruebas e2e `scripts/mcp-test.mjs` verificando por contenido

## 4. Interfaz
- [x] 4.1 Ventana principal con la disposición de Movavi y menús
- [x] 4.2 Colecciones (importar, filtros, transiciones, títulos, adhesivos, más herramientas)
- [x] 4.3 Reproductor (fotograma + flujo fMP4), línea de tiempo interactiva
- [x] 4.4 Paneles de herramientas y propiedades; exportación con progreso
- [x] 4.5 Recarga cuando el MCP cambia el proyecto; atajos de teclado

## 5. Entrega
- [x] 5.1 Prueba de la interfaz (autoprueba `--selftest`)
- [x] 5.2 Portable e instalador generados y probados (MCP con el ejecutable empaquetado)
- [x] 5.3 README, guardar en engram
