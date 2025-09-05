import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('zcast', {
  readManifest: () => ipcRenderer.invoke('zcast:read-manifest'),
  onManifestUpdate: (cb: (data: unknown) => void) => {
    const handler = (_ev: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('zcast:manifest-updated', handler);
    // return unsubscribe function
    return () => ipcRenderer.removeListener('zcast:manifest-updated', handler);
  }
});
