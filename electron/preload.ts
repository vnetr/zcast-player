import { contextBridge, ipcRenderer } from 'electron';

function safe(v: any) {
  try {
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

['log','info','warn','error'].forEach((level) => {
  const orig = (console as any)[level].bind(console);
  (console as any)[level] = (...args: any[]) => {
    try { ipcRenderer.send('zcast:console', { level, args: args.map(safe) }); } catch {}
    orig(...args);
  };
});

window.addEventListener('error', (ev) => {
  ipcRenderer.send('zcast:console', {
    level: 'pageerror',
    message: ev.message,
    filename: ev.filename,
    lineno: ev.lineno,
    colno: ev.colno,
    stack: ev.error?.stack,
  });
});

window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  ipcRenderer.send('zcast:console', {
    level: 'unhandledrejection',
    reason: safe(ev.reason),
  });
});

contextBridge.exposeInMainWorld('zcast', {
  readManifest: () => ipcRenderer.invoke('zcast:read-manifest'),
  onManifestUpdate: (cb: (data: unknown) => void) => {
    const handler = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('zcast:manifest-updated', handler);
    return () => ipcRenderer.removeListener('zcast:manifest-updated', handler);
  },
});

// Main-side sink:
ipcRenderer.on('zcast:ping', (_e, msg) => console.log('[main->renderer]', msg));
