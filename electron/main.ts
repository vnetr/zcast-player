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

  // ===== Fonts: build lookup maps =====
  const FALLBACK_BASE = 'Hack-Regular';
  const fontCaseMap: Record<string, string> = {};     // exact filename by lowercase
  const fontNormMap: Record<string, string> = {};     // normalized filename → real filename

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  let resFontsExists = false;
  try {
    const files = fs.readdirSync(resFonts);
    for (const fn of files) {
      fontCaseMap[fn.toLowerCase()] = fn;
      fontNormMap[normalize(fn)] = fn;
    }
    resFontsExists = true;
    if (DEBUG) console.log('[fonts] indexed', files.length, 'files in', resFonts);
  } catch (e) {
    console.warn('[fonts] cannot index resources/fonts:', e);
  }

  function pickFallback(extWanted: string): string | null {
    if (!resFontsExists) return null;
    const candidates = [
      `${FALLBACK_BASE}.${extWanted}`,              // exact extension
      `${FALLBACK_BASE}.woff2`,
      `${FALLBACK_BASE}.ttf`,
      `${FALLBACK_BASE}.otf`,
      `${FALLBACK_BASE}.woff`,
    ];
    for (const c of candidates) {
      const p = path.join(resFonts, c);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  function resolveFontPath(requestName: string): string | null {
    if (!resFontsExists) return null;
    const base = path.basename(requestName);                 // "uni.next-pro-thin.ttf"
    const lc   = base.toLowerCase();
    const norm = normalize(base);
    // 1) exact (case-insensitive)
    let real = fontCaseMap[lc];
    if (real) {
      const p = path.join(resFonts, real);
      if (fs.existsSync(p)) return p;
    }
    // 2) normalized (handles dots/underscores/dashes variations)
    real = fontNormMap[norm];
    if (real) {
      const p = path.join(resFonts, real);
      if (fs.existsSync(p)) return p;
    }
    // 3) legacy dist/fonts lookup
    if (distDir) {
      const d1 = path.join(distDir, 'fonts', base);
      if (fs.existsSync(d1)) return d1;
      // also try normalized search inside dist/fonts
      try {
        for (const fn of fs.readdirSync(path.join(distDir, 'fonts'))) {
          if (normalize(fn) === norm) {
            const p = path.join(distDir, 'fonts', fn);
            if (fs.existsSync(p)) return p;
          }
        }
      } catch {}
    }
    // 4) fallback to Hack-Regular.* (match requested extension if possible)
    const ext = (base.split('.').pop() || '').toLowerCase();
    const fb  = pickFallback(ext);
    if (fb) {
      if (DEBUG) console.log('[fonts] fallback', base, '->', path.basename(fb));
      return fb;
    }
    return null;
  }

  // ============================
  // (1) file:// FONT hook — runs FIRST
  // Catch *any* ".../fonts/<name>.(ttf|otf|woff|woff2)" including:
  //   - /dist/index.html/fonts/<name>
  //   - /dist/assets/**/fonts/<name>
  //   - /fonts/<name>
  // ============================
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['file://*/*'] },
    (details, callback) => {
      try {
        const u = new URL(details.url);
        if (u.protocol !== 'file:') return callback({});

        // decode path safely (handles %20 etc.)
        const p = decodeURIComponent(u.pathname);

        // quick path filter (avoid touching non-font file:// loads)
        const isFont = p.includes('/fonts/') && /\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/.test(p);
        if (!isFont) return callback({});

        const reqName = p.substring(p.lastIndexOf('/fonts/') + '/fonts/'.length); // "<name>.<ext>"
        const target  = resolveFontPath(reqName);
        if (target && fs.existsSync(target)) {
          if (DEBUG) console.log('[font hook] redirect', p, '->', target);
          return callback({ redirectURL: toFileUrl(target) });
        }

        // If we somehow fail resolution, let it fall through (will 404), but we try hard above.
        return callback({});
      } catch (e) {
        console.warn('[font hook] error:', e);
        return callback({});
      }
    }
  );

  // ============================
  // MEDIA hashed cache (unchanged from your working version)
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

  // (2) http(s) → local hashed cache
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const local = mapRemoteToLocal(details.url);
      if (local) {
        if (DEBUG) console.log('[assets] http url-hit', details.url, '->', local);
        return callback({ redirectURL: toFileUrl(local) });
      }
      return callback({}); // allow network fetch
    }
  );

  // (3) file://host/... (renderer prefetch) → local hashed cache or http
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['file://*/*'] },
    (details, callback) => {
      try {
        const u = new URL(details.url);
        // Only handle "file://<hostname>/..." shapes; normal file:/// paths have no hostname.
        if (u.protocol !== 'file:' || !u.hostname || u.hostname === 'localhost') {
          return callback({});
        }
        const httpGuess = `http://${u.hostname}${decodeURIComponent(u.pathname)}${u.search || ''}`;
        const local     = mapRemoteToLocal(httpGuess);
        if (local) {
          if (DEBUG) console.log('[assets] salvage file://host -> local', details.url, '->', local);
          return callback({ redirectURL: toFileUrl(local) });
        }
        if (DEBUG) console.log('[assets] salvage file://host -> http', details.url, '->', httpGuess);
        return callback({ redirectURL: httpGuess });
      } catch {
        return callback({});
      }
    }
  );

  // ====== IPC + manifest watcher ======
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
