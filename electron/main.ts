// src/electron/main.ts
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
// ---- ESM friendly __dirname ----
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---- Force GPU / HW accel on Linux ----
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,CanvasOopRasterization');
// 'egl' is usually best on modern Linux; swap to 'desktop' if a specific device needs it
app.commandLine.appendSwitch('use-angle', 'gl-egl');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

let win: BrowserWindow | null = null;

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function packagedFallbackManifest(): string | '' {
  return app.isPackaged ? path.join(process.resourcesPath, 'mock', 'manifest.json') : '';
}
function manifestFilePath(): string {
  return (
    getArg('manifest-file') ||
    process.env.ZCAST_MANIFEST_FILE ||
    packagedFallbackManifest() ||
    ''
  );
}
function prodIndexHtml(): string | null {
  // When compiled, this file lives at build/electron/main.js
  // Vite outputs index.html at dist/index.html
  const distIndex = path.resolve(__dirname, '../../dist/index.html');
  if (fs.existsSync(distIndex)) return distIndex;

  // Fallback to your previous relative path if you keep another build layout
  const legacy = path.resolve(__dirname, '../renderer/index.html');
  if (fs.existsSync(legacy)) return legacy;

  return null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1920,
    height: 1080,
    fullscreen: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // IMPORTANT: preload compiled as *CommonJS* (see tsconfig.electron.json below)
      preload: path.join(__dirname, 'preload.js'),
      webgl: true,
      backgroundThrottling: false,
    },
  });

  const dev = !!process.env.VITE_DEV;

  if (dev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexFile = prodIndexHtml();
    if (!indexFile) {
      // Last-resort message if packaging paths are wrong
      win.loadURL('data:text/html,<h1>Missing dist/index.html</h1>');
    } else {
      win.loadFile(indexFile);
    }
  }

  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {

  const mf = manifestFilePath();
  if (!mf) {
    console.warn('[zcast] No ZCAST_MANIFEST_FILE or --manifest-file specified. Dev HMR only.');
  }

  // IPC: read manifest (renderer calls this via preload bridge)
  ipcMain.handle('zcast:read-manifest', async () => {
    const file = manifestFilePath();
    if (!file) return null;
    try {
      const buf = await fs.promises.readFile(file);
      return JSON.parse(buf.toString('utf-8'));
    } catch (e) {
      console.error('[zcast] read-manifest error:', e);
      return null;
    }
  });

  // Watch for changes (rename|change) and push to renderer
  const startWatch = () => {
    const file = manifestFilePath();
    if (!file) return;

    // small debounce to coalesce rapid changes
    let timer: NodeJS.Timeout | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!win) return;
        try {
          const buf = await fs.promises.readFile(file);
          const json = JSON.parse(buf.toString('utf-8'));
          win.webContents.send('zcast:manifest-updated', json);
        } catch {
          // file might be briefly missing during write; ignore
        }
      }, 100);
    };

    try {
      fs.watch(file, { persistent: true }, (event) => {
        if (event === 'rename' || event === 'change') bump();
      });
      console.info('[zcast] Watching manifest:', file);
    } catch (e) {
      console.warn('[zcast] fs.watch failed:', e);
    }
  };

  createWindow();
  startWatch();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
