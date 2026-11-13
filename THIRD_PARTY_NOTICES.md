# Cinta — licencias de terceros

Cinta es software libre bajo la **GNU General Public License v3.0 o posterior** (archivo `LICENSE`).
Puede usarlo, copiarlo, compartirlo y modificarlo gratis; si lo redistribuye, debe hacerlo con la misma licencia
y ofreciendo el código fuente.

Cinta incluye o usa estos componentes, cada uno con su propia licencia:

| Componente | Uso en Cinta | Licencia | Código fuente |
| --- | --- | --- | --- |
| FFmpeg 6.1.1 (compilación «essentials» de gyan.dev, vía `ffmpeg-static`) | Vídeo y audio: decodificar, componer, exportar | GPL v3 (incluye x264, x265, libass, vid.stab, rubberband…) | https://github.com/FFmpeg/FFmpeg/commit/e38092ef93 · https://www.gyan.dev/ffmpeg/builds/ |
| FFprobe (compilación de gyan.dev, vía `@ffprobe-installer/win32-x64`) | Leer datos de los archivos | GPL v3 | https://github.com/FFmpeg/FFmpeg |
| sherpa-onnx 2.0.1 (`sherpa-onnx-node`, `sherpa-onnx-win-x64`) | Voz a texto local | Apache 2.0 | https://github.com/k2-fsa/sherpa-onnx |
| ONNX Runtime (dentro de sherpa-onnx) | Motor de inferencia | MIT | https://github.com/microsoft/onnxruntime |
| resvg 2.6.2 (`@resvg/resvg-js`) | Dibujar adhesivos y llamadas | MPL 2.0 | https://github.com/yisibl/resvg-js |
| Electron 45 (y Chromium, Node.js) | Aplicación de escritorio | MIT (Chromium: ver `LICENSES.chromium.html` junto a Cinta.exe) | https://github.com/electron/electron |
| Model Context Protocol SDK | Servidor MCP | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| Zod | Validación | MIT | https://github.com/colinhacks/zod |
| polygon-clipping 0.15.7 | Combinar trazados (operaciones booleanas de formas) | MIT | https://github.com/mfogel/polygon-clipping |
| three.js 0.186.1 | Modelos 3D (GLB, glTF, OBJ) y geometría extruida del modo avanzado | MIT | https://github.com/mrdoob/three.js |
| electron-updater 6.8.11 (con builder-util-runtime, js-yaml, semver, lazy-val, fs-extra) | Actualizaciones automáticas desde GitHub Releases | MIT (js-yaml: MIT; semver: ISC) | https://github.com/electron-userland/electron-builder |
| Vite, TypeScript, esbuild, electron-builder (solo para compilar) | Desarrollo | MIT / Apache 2.0 | — |

**No incluidos** (los descarga o copia el usuario): modelos Whisper (OpenAI, MIT) en formato sherpa-onnx y
Silero VAD (MIT).

**Contenido propio**: iconos, adhesivos, llamadas, estilos de título, música y efectos de sonido generados son
obra de Cinta y se distribuyen bajo la misma GPL v3. Cinta no contiene recursos, código ni marcas de Movavi;
«Movavi» es una marca de su propietario y solo se menciona para describir la compatibilidad de flujo de trabajo.
