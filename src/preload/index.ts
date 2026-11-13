// Narrow bridge between the sandboxed UI and the main process.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, fn: (...args: unknown[]) => void) => {
    const h = (_: unknown, ...a: unknown[]) => fn(...a);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  pathOf: (f: File) => webUtils.getPathForFile(f),
};

contextBridge.exposeInMainWorld('cinta', api);
export type CintaApi = typeof api;
