import { app, BrowserWindow, ipcMain, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as url from 'url';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const toFileUrl = (p: string) => url.pathToFileURL(p).href;
const sha256    = (s: string) => createHash('sha256').update(s).digest('hex');
const DEBUG     = /^(1|true|yes)$/i.test(String(process.env.ZCAST_DEBUG_ASSETS || ''));
const dbg = (...a: any[]) => { if (DEBUG) console.log('[assets]', ...a); };

// -------- GPU / HW accel --------
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,CanvasOopRasterization');
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
  return getArg('manifest-file') || process.env.ZCAST_MANIFEST_FILE || packagedFallbackManifest() || '';
}
function prodIndexHtml(): string | null {
  const distIndex = path.resolve(__dirname, '../../dist/index.html');
  if (fs.existsSync(distIndex)) return distIndex;
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
      preload: path.join(__dirname, 'preload.js'),
      webgl: true,
      backgroundThrottling: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });

  const dev = !!process.env.VITE_DEV;
  if (dev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexFile = prodIndexHtml();
    if (!indexFile) win.loadURL('data:text/html,<h1>Missing dist/index.html</h1>');
    else win.loadFile(indexFile);
  }

  win.on('closed', () => (win = null));
}

const mf = manifestFilePath();
if (!mf) console.warn('[zcast] No ZCAST_MANIFEST_FILE or --manifest-file specified. Dev HMR only.');

app.whenReady().then(() => {
  // ---- paths ----
  const distIndex = prodIndexHtml();                          // /opt/.../app.asar/dist/index.html
  const distDir   = distIndex ? path.dirname(distIndex) : ''; // /opt/.../app.asar/dist
  const resFonts  = path.join(process.resourcesPath, 'fonts'); // **REAL font location**

  // Build a lowercase index of shipped fonts for case-insensitive lookup
  const fontCaseMap: Record<string, string> = {};
  try {
    for (const fn of fs.readdirSync(resFonts)) {
      fontCaseMap[fn.toLowerCase()] = fn;
    }
    if (DEBUG) console.log('[fonts] indexed', Object.keys(fontCaseMap).length, 'files');
  } catch (e) {
    console.warn('[fonts] cannot index resources/fonts:', e);
  }

  const FONT_FALLBACK = 'Hack-Regular.ttf'; // you ship Hack-*.ttf — safe fallback

  function resolveFontPath(fontRel: string): string | null {
    // Try resources/fonts exact
    let p = path.join(resFonts, fontRel);
    if (fs.existsSync(p)) return p;

    // Try resources/fonts case-insensitive
    const base = path.basename(fontRel);
    const ci = fontCaseMap[base.toLowerCase()];
    if (ci) {
      p = path.join(resFonts, ci);
      if (fs.existsSync(p)) return p;
    }

    // Try dist/fonts (legacy builds)
    if (distDir) {
      const d = path.join(distDir, 'fonts', fontRel);
      if (fs.existsSync(d)) return d;
    }

    // Fallback to a known shipped font to avoid 404 spam
    const fb = path.join(resFonts, FONT_FALLBACK);
    if (fs.existsSync(fb)) {
      if (DEBUG) console.log('[fonts] fallback', fontRel, '->', FONT_FALLBACK);
      return fb;
    }
    return null;
  }

  // ============================
  // file:// FONT hook (ONLY fonts here)
  // IMPORTANT: filter must be file://*/* (not *://*/* or file:///*)
  // ============================
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['file://*/*'] },
    (details, callback) => {
      try {
        const u = new URL(details.url);
        if (u.protocol !== 'file:') return callback({});
        const p = u.pathname; // already absolute

        // 1) ".../dist/index.html/fonts/<name>" -> resources/fonts/<name>"
        const bad1 = '/dist/index.html/fonts/';
        if (p.includes(bad1)) {
          const fontRel = p.slice(p.indexOf(bad1) + bad1.length);
          const target = resolveFontPath(fontRel);
          if (target) {
            if (DEBUG) console.log('[font hook] redirect1', p, '->', target);
            return callback({ redirectURL: toFileUrl(target) });
          }
        }

        // 2) ".../dist/assets/index-*.js/.../fonts/<name>" -> resources/fonts/<name>"
        if (p.includes('/dist/assets/') && p.includes('/fonts/')) {
          const fontRel = p.split('/fonts/')[1];
          const target  = resolveFontPath(fontRel);
          if (target) {
            if (DEBUG) console.log('[font hook] redirect2', p, '->', target);
            return callback({ redirectURL: toFileUrl(target) });
          }
        }

        // 3) root-absolute "/fonts/<name>" -> resources/fonts/<name>"
        if (p.startsWith('/fonts/')) {
          const fontRel = p.slice('/fonts/'.length);
          const target  = resolveFontPath(fontRel);
          if (target) {
            if (DEBUG) console.log('[font hook] redirect3', p, '->', target);
            return callback({ redirectURL: toFileUrl(target) });
          }
        }

        // Not a font request; let other handlers (media etc.) deal with it
        return callback({});
      } catch (e) {
        console.warn('[font hook] error:', e);
        return callback({});
      }
    }
  );

  // ====== (keep your existing IPC + watcher) ======

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

  function startWatch() {
    const file = manifestFilePath();
    if (!file) return;
    let timer: NodeJS.Timeout | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!win) return;
        try {
          const buf = await fs.promises.readFile(file);
          const json = JSON.parse(buf.toString('utf-8'));
          win.webContents.send('zcast:manifest-updated', json);
        } catch { /* transient write */ }
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
  }

  createWindow();
  startWatch();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
