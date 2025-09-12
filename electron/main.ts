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
      webSecurity: false,               // allow scheme changes
      allowRunningInsecureContent: true // http assets alongside file://
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

  const FONT_FALLBACK = 'Hack-Regular.ttf'; // safe fallback

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
  // file:// FONT hook (FIRST) — catch every “.../fonts/<name>.(ttf|otf|woff|woff2)”
  // IMPORTANT: filter must be file://*/* (not *://*/* or file:///*)
  // ============================
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['file://*/*'] },
    (details, callback) => {
      try {
        const u = new URL(details.url);
        if (u.protocol !== 'file:') return callback({});
        const p = decodeURIComponent(u.pathname); // <- decode in case of %20 etc.

        // If it looks like a font path anywhere under /fonts/, handle it
        if (p.includes('/fonts/') && /\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/.test(p)) {
          const fontRel = p.substring(p.lastIndexOf('/fonts/') + '/fonts/'.length);
          const target  = resolveFontPath(fontRel);
          if (target) {
            if (DEBUG) console.log('[font hook] redirect', p, '->', target);
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

  // ============================
  // MEDIA: hashed cache (NO schedule assets)
  //   /media/assets/assets/
  //     u/<urlSha>/<filename>
  //     h/<contentSha>/<filename>
  //     assets-index.json  (optional)
  // ============================
  const ASSETS_ROOT = '/media/assets';
  const ASSETS_SUB  = path.join(ASSETS_ROOT, 'assets');
  const INDEX_PATH  = path.join(ASSETS_SUB, 'assets-index.json');

  const MEDIA_EXTS = new Set([
    'png','jpg','jpeg','webp','gif','svg',
    'mp4','m4v','mov','webm','mp3','wav','ogg','ogv','aac'
  ]);

  let assetIndex:
    | { items?: Array<{ url:string; urlHash:string; contentHash?:string; name:string }> }
    | null = null;

  function loadAssetIndex() {
    try {
      const txt = fs.readFileSync(INDEX_PATH, 'utf-8');
      assetIndex = JSON.parse(txt);
      if (DEBUG) console.log('[assets] index loaded:', assetIndex?.items?.length ?? 0, 'entries');
    } catch {
      assetIndex = null;
      if (DEBUG) console.log('[assets] no readable assets-index.json (url-hash aliases only)');
    }
  }
  loadAssetIndex();

  try {
    fs.watch(ASSETS_ROOT, { persistent: false }, (_e, name) => {
      if (name === '.last_bundle_extracted') setTimeout(loadAssetIndex, 200);
    });
  } catch {}

  function mapRemoteToLocal(remoteUrl: string): string | null {
    try {
      const u = new URL(remoteUrl);
      const ext = (u.pathname.split('.').pop() || '').toLowerCase();
      if (!MEDIA_EXTS.has(ext)) return null;

      const uhash = sha256(remoteUrl);
      const name  = decodeURIComponent(u.pathname.split('/').pop() || 'asset');

      // 1) url-hash alias
      const aliasPath = path.join(ASSETS_SUB, 'u', uhash, name);
      if (fs.existsSync(aliasPath)) return aliasPath;

      // 2) content-hash via index
      const hit = assetIndex?.items?.find((x) => x.urlHash === uhash);
      if (hit?.contentHash) {
        const contentPath = path.join(ASSETS_SUB, 'h', hit.contentHash, hit.name);
        if (fs.existsSync(contentPath)) return contentPath;
      }
      return null;
    } catch {
      return null;
    }
  }

  // (A) http(s) → local hashed cache (preferred path)
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const local = mapRemoteToLocal(details.url);
      if (local) {
        if (DEBUG) console.log('[assets] http url-hit', details.url, '->', local);
        return callback({ redirectURL: toFileUrl(local) });
      }
      return callback({}); // let network fetch if not cached
    }
  );

  // (B) file://kraken... (renderer prefetch) → local hashed cache (or http as last resort)
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['file://*/*'] },
    (details, callback) => {
      try {
        const u = new URL(details.url);
        if (u.protocol !== 'file:' || !u.hostname || u.hostname === 'localhost') {
          return callback({});
        }
        // Convert file://<host>/<path> → http://<host>/<path> and map to cache
        const httpGuess = `http://${u.hostname}${decodeURIComponent(u.pathname)}${u.search || ''}`;
        const local     = mapRemoteToLocal(httpGuess);
        if (local) {
          if (DEBUG) console.log('[assets] salvage file://host -> local', details.url, '->', local);
          return callback({ redirectURL: toFileUrl(local) });
        }
        if (DEBUG) console.log('[assets] salvage file://host -> http', details.url, '->', httpGuess);
        return callback({ redirectURL: httpGuess }); // allowed by window flags
      } catch {
        return callback({});
      }
    }
  );

  // ====== (your IPC + watcher remain) ======
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
