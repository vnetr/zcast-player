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
      // allow file <-> http scheme changes triggered by our redirector
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
  // ---- paths we rely on ----
  const distIndex   = prodIndexHtml();                          // /opt/.../app.asar/dist/index.html
  const distDir     = distIndex ? path.dirname(distIndex) : ''; // /opt/.../app.asar/dist
  const resFonts    = path.join(process.resourcesPath, 'fonts'); // **YOUR fonts live here**

  // Hashed cache only here (do NOT use /media/schedule/assets)
  const ASSETS_ROOT = '/media/assets';
  const ASSETS_SUB  = path.join(ASSETS_ROOT, 'assets');         // u/, h/, assets-index.json
  const INDEX_PATH  = path.join(ASSETS_SUB, 'assets-index.json');

  let assetIndex: { items?: Array<{ url:string; urlHash:string; contentHash?:string; name:string }> } | null = null;

  function loadAssetIndex() {
    try {
      const txt = fs.readFileSync(INDEX_PATH, 'utf-8');
      assetIndex = JSON.parse(txt);
      console.info('[assets] index loaded:', assetIndex?.items?.length ?? 0, 'entries');
    } catch (e) {
      assetIndex = null;
      console.warn('[assets] index not readable – URL-hash alias only.', String(e));
    }
  }
  loadAssetIndex();

  // optional: reload index when your extractor touches marker
  try {
    fs.watch(ASSETS_ROOT, { persistent: false }, (_e, name) => {
      if (name === '.last_bundle_extracted') setTimeout(loadAssetIndex, 200);
    });
  } catch {}

  // ---- helpers ----
  const MEDIA_EXTS = new Set([
    'png','jpg','jpeg','webp','gif','svg',
    'mp4','m4v','mov','webm','mp3','wav','ogg','ogv','aac',
    'ttf','otf','woff','woff2'
  ]);

  function resolveFontPath(fontRel: string): string | null {
    // Prefer resources/fonts (where you actually ship fonts), then dist/fonts
    const tryRes = path.join(resFonts, fontRel);
    if (fs.existsSync(tryRes)) return tryRes;
    const tryDist = distDir ? path.join(distDir, 'fonts', fontRel) : '';
    if (tryDist && fs.existsSync(tryDist)) return tryDist;
    return null;
  }

  function mapRemoteToLocal(remoteUrl: string): string | null {
    try {
      const u = new URL(remoteUrl);
      const ext = (u.pathname.split('.').pop() || '').toLowerCase();
      if (!MEDIA_EXTS.has(ext)) return null;

      const uhash = sha256(remoteUrl);
      const name  = decodeURIComponent(u.pathname.split('/').pop() || 'asset');

      // url-hash alias
      const aliasPath = path.join(ASSETS_SUB, 'u', uhash, name);
      if (fs.existsSync(aliasPath)) return aliasPath;

      // optional: content-hash via index
      const items = assetIndex?.items || [];
      const hit   = items.find((x) => x.urlHash === uhash);
      if (hit?.contentHash) {
        const contentPath = path.join(ASSETS_SUB, 'h', hit.contentHash, hit.name);
        if (fs.existsSync(contentPath)) return contentPath;
      }
      return null;
    } catch {
      return null;
    }
  }

  // =========================================================
  // file:// remaps
  // 1) Fonts → /opt/zcast-player/resources/fonts
  // 2) “file://kraken...” salvage → map to local hashed cache (NO http redirect)
  // =========================================================
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['file://*/*'] },
    (details, callback) => {
      try {
        const u = new URL(details.url);
        if (u.protocol !== 'file:') return callback({});
        const p = decodeURIComponent(u.pathname);

        // Fonts: /dist/index.html/fonts/<name>
        const bad1 = '/dist/index.html/fonts/';
        if (p.includes(bad1)) {
          const fontRel = p.slice(p.indexOf(bad1) + bad1.length);
          const tgt = resolveFontPath(fontRel);
          if (tgt) {
            dbg('font redirect', p, '->', tgt);
            return callback({ redirectURL: toFileUrl(tgt) });
          }
        }
        // …/dist/assets/…/fonts/<name>
        if (p.includes('/dist/assets/') && p.includes('/fonts/')) {
          const fontRel = p.split('/fonts/')[1];
          const tgt = resolveFontPath(fontRel);
          if (tgt) {
            dbg('font redirect2', p, '->', tgt);
            return callback({ redirectURL: toFileUrl(tgt) });
          }
        }
        // /fonts/<name>
        if (p.startsWith('/fonts/')) {
          const fontRel = p.slice('/fonts/'.length);
          const tgt = resolveFontPath(fontRel);
          if (tgt) {
            dbg('font redirect3', p, '->', tgt);
            return callback({ redirectURL: toFileUrl(tgt) });
          }
        }

        // Renderer prefetch bug: file://kraken.zignage.com/media/...
        // Try to map to local hashed cache; if not found, fall back to http.
        if (u.hostname && u.hostname !== 'localhost') {
          const guessedHttp = `http://${u.hostname}${u.pathname}${u.search || ''}`;
          const local = mapRemoteToLocal(guessedHttp);
          if (local) {
            dbg('salvage file://host -> local cache', details.url, '->', local);
            return callback({ redirectURL: toFileUrl(local) });
          }
          // As a last resort, let it go to HTTP (we allow scheme changes)
          dbg('salvage file://host -> http', details.url, '->', guessedHttp);
          return callback({ redirectURL: guessedHttp });
        }

        return callback({});
      } catch (e) {
        console.warn('[assets file hook] error:', e);
        return callback({});
      }
    }
  );

  // =========================================================
  // http(s) -> local hashed cache for media
  // =========================================================
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        const local = mapRemoteToLocal(details.url);
        if (local) {
          dbg('url-hit', details.url, '->', local);
          return callback({ redirectURL: toFileUrl(local) });
        }
        return callback({}); // go to network
      } catch (e) {
        console.warn('[assets http hook] error:', e);
        return callback({});
      }
    }
  );

  // =========================================================
  // IPC: manifest read + watch
  // =========================================================
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
