// electron/main.ts
import { app, BrowserWindow, ipcMain, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as url from 'url';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import chokidar from 'chokidar';

// =======================
// Safety: never die on EPIPE / logging
// =======================
const wrapWrite = (orig: (chunk: any, ...rest: any[]) => any) =>
  function safeWrite(this: any, chunk: any, ...rest: any[]) {
    try { return orig.call(this, chunk, ...rest); }
    catch (e: any) { if (e && e.code === 'EPIPE') return true; throw e; }
  };

try {
  // @ts-ignore
  process.stdout.write = wrapWrite(process.stdout.write.bind(process.stdout));
  // @ts-ignore
  process.stderr.write = wrapWrite(process.stderr.write.bind(process.stderr));
} catch { /* no-op */ }

process.on('uncaughtException', (err: any) => {
  if (err && err.code === 'EPIPE') return;
  try { console.error('[main] uncaughtException:', err); } catch {}
});

process.on('unhandledRejection', (reason: any) => {
  try { console.error('[main] unhandledRejection:', reason); } catch {}
});

// (Dev only) silence Electron’s CSP banner; prod doesn’t show it anyway
if (!app.isPackaged) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

// =======================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const toFileUrl = (p: string) => url.pathToFileURL(p).href;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Debug toggles
const DEBUG_ALL     = /^(1|true|yes)$/i.test(String(process.env.ZCAST_DEBUG || ''));
const DEBUG_ASSETS  = DEBUG_ALL || /^(1|true|yes)$/i.test(String(process.env.ZCAST_DEBUG_ASSETS || ''));
const DEBUG_MAN     = DEBUG_ALL || /^(1|true|yes)$/i.test(String(process.env.ZCAST_DEBUG_MANIFEST || ''));

// Manifest read/watch tuning
const READ_BUDGET_MS   = Number(process.env.ZCAST_MANIFEST_READ_BUDGET_MS ?? 2500);
const QUIET_MS         = Number(process.env.ZCAST_MANIFEST_QUIET_MS ?? 120);
const WATCH_USE_POLL   = /^(1|true|yes)$/i.test(String(process.env.ZCAST_MANIFEST_WATCH_POLL || ''));
const WATCH_INTERVAL   = Number(process.env.ZCAST_MANIFEST_WATCH_INTERVAL ?? 500);

// -------- GPU / HW accel --------
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,CanvasOopRasterization');
app.commandLine.appendSwitch('use-angle', 'gl-egl');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
      enableBlinkFeatures: 'WebXR,WebXRIncubations',
      preload: path.join(__dirname, 'preload.js'),
      webgl: true,
      backgroundThrottling: false,

      // Signage-friendly security posture
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
  const distIndex = prodIndexHtml();                            // /opt/.../app.asar/dist/index.html
  const distDir = distIndex ? path.dirname(distIndex) : '';     // /opt/.../app.asar/dist
  const resFonts = path.join(process.resourcesPath, 'fonts');   // **REAL font location**
  const resFontsSlash = resFonts.replace(/\\/g, '/');           // normalize for comparisons

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
    if (DEBUG_ASSETS) console.log('[fonts] indexed', Object.keys(fontCaseMap).length, 'files in', resFonts);
  } catch (e) {
    console.warn('[fonts] cannot index resources/fonts:', e);
  }

  function pickFallback(extWanted: string): string | null {
    if (!resFontsExists) return null;
    const candidates = [
      `${FALLBACK_BASE}.${extWanted}`,
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
    const base = path.basename(requestName);                 // e.g. "uni.next-pro-thin.ttf"
    const lc = base.toLowerCase();
    const norm = normalize(base);

    // 1) resources/fonts (case-insensitive)
    let real = fontCaseMap[lc];
    if (real) {
      const p = path.join(resFonts, real);
      if (fs.existsSync(p)) return p;
    }
    // 2) normalized
    real = fontNormMap[norm];
    if (real) {
      const p = path.join(resFonts, real);
      if (fs.existsSync(p)) return p;
    }
    // 3) legacy dist/fonts
    if (distDir) {
      const d1 = path.join(distDir, 'fonts', base);
      if (fs.existsSync(d1)) return d1;
      try {
        const distFontsDir = path.join(distDir, 'fonts');
        for (const fn of fs.readdirSync(distFontsDir)) {
          if (normalize(fn) === norm) {
            const p = path.join(distFontsDir, fn);
            if (fs.existsSync(p)) return p;
          }
        }
      } catch { }
    }
    // 4) fallback
    const ext = (base.split('.').pop() || '').toLowerCase();
    const fb = pickFallback(ext);
    if (fb) {
      if (DEBUG_ASSETS) console.log('[fonts] fallback', base, '->', path.basename(fb));
      return fb;
    }
    return null;
  }

  // ============================
  // MEDIA hashed cache (unchanged)
  // ============================
  const ASSETS_ROOT = '/media/assets';
  const ASSETS_SUB = path.join(ASSETS_ROOT, 'assets');
  const INDEX_PATH = path.join(ASSETS_SUB, 'assets-index.json');

  const MEDIA_EXTS = new Set([
    'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
    'mp4', 'm4v', 'mov', 'webm', 'mp3', 'wav', 'ogg', 'ogv', 'aac'
  ]);

  let assetIndex:
    | { items?: Array<{ url: string; urlHash: string; contentHash?: string; name: string }> }
    | null = null;

  function loadAssetIndex() {
    try {
      const txt = fs.readFileSync(INDEX_PATH, 'utf-8');
      assetIndex = JSON.parse(txt);
      if (DEBUG_ASSETS) console.log('[assets] index loaded:', assetIndex?.items?.length ?? 0, 'entries');
    } catch {
      assetIndex = null;
      if (DEBUG_ASSETS) console.log('[assets] no readable assets-index.json (url-hash aliases only)');
    }
  }
  loadAssetIndex();

  try {
    fs.watch(ASSETS_ROOT, { persistent: false }, (_e, name) => {
      if (name === '.last_bundle_extracted') setTimeout(loadAssetIndex, 200);
    });
  } catch { }

  function mapRemoteToLocal(remoteUrl: string): string | null {
    try {
      const u = new URL(remoteUrl);
      const ext = (u.pathname.split('.').pop() || '').toLowerCase();
      if (!MEDIA_EXTS.has(ext)) return null;

      const uhash = sha256(remoteUrl);
      const name = decodeURIComponent(u.pathname.split('/').pop() || 'asset');

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

  // ============================
  // (A) http(s) → local hashed cache (unchanged)
  // ============================
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const local = mapRemoteToLocal(details.url);
      if (local) return callback({ redirectURL: toFileUrl(local) });
      return callback({});
    }
  );

  // ============================
  // (B) SINGLE file:// hook (fonts FIRST, then salvage)
  // ============================
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['file://*/*'] },
    (details, callback) => {
      try {
        const u = new URL(details.url);
        if (u.protocol !== 'file:') return callback({});

        // decoded absolute path (posix-like)
        const p = decodeURIComponent(u.pathname);
        const pSlash = p.replace(/\\/g, '/');

        // --- Loop guard: if we're already pointing into resources/fonts, pass through
        if (pSlash.startsWith(resFontsSlash.replace(/\\/g, '/'))) {
          return callback({});
        }

        // --- 1) FONTS: catch any ".../fonts/<name>.(ttf|otf|woff|woff2)"
        const isFont = pSlash.includes('/fonts/') && /\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/.test(pSlash);
        if (isFont) {
          const reqName = pSlash.substring(pSlash.lastIndexOf('/fonts/') + '/fonts/'.length);
          const target = resolveFontPath(reqName);
          if (target && fs.existsSync(target)) {
            const redirectURL = toFileUrl(target);
            if (DEBUG_ASSETS) console.log('[font hook] redirect', pSlash, '->', redirectURL);
            return callback({ redirectURL });
          }
          return callback({});
        }

        // --- 2) SALVAGE: file://<host>/... → try local cache or http
        if (u.hostname && u.hostname !== 'localhost') {
          const httpGuess = `http://${u.hostname}${decodeURIComponent(u.pathname)}${u.search || ''}`;
          const local = mapRemoteToLocal(httpGuess);
          if (local) {
            if (DEBUG_ASSETS) console.log('[assets] salvage file://host -> local', details.url, '->', local);
            return callback({ redirectURL: toFileUrl(local) });
          }
          if (DEBUG_ASSETS) console.log('[assets] salvage file://host -> http', details.url, '->', httpGuess);
          return callback({ redirectURL: httpGuess });
        }

        // anything else: pass through
        return callback({});
      } catch (e) {
        console.warn('[file hook] error:', e);
        return callback({});
      }
    }
  );

  // Relax Permissions-Policy for signage use-cases (fullscreen / XR)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};

    // Remove any existing restrictive policy headers we don't want
    Object.keys(headers).forEach(k => {
      if (k.toLowerCase() === 'permissions-policy' || k.toLowerCase() === 'feature-policy') {
        delete headers[k];
      }
    });

    headers['Permissions-Policy'] = [
      'fullscreen=(self "*"), xr-spatial-tracking=(self "*")'
    ];

    callback({ responseHeaders: headers });
  });

  // ====== IPC + robust manifest watcher (stable reads + hash coalescing) ======
  let lastManifestHash: string = '';
  let lastManifestObject: any = null;

  const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

  /**
   * Read JSON only when the manifest looks stable:
   *  - size & mtime unchanged across QUIET_MS
   *  - text ends well and parses
   * Returns parsed object or `null` if couldn't get a stable read inside READ_BUDGET_MS.
   */
  async function readManifestStable(file: string): Promise<any | null> {
    const deadline = Date.now() + READ_BUDGET_MS;
    let lastErr: any = null;

    while (Date.now() < deadline) {
      try {
        const s1 = await fs.promises.stat(file);
        const buf = await fs.promises.readFile(file); // single read
        await sleep(QUIET_MS);                        // quiet window
        const s2 = await fs.promises.stat(file);

        if (s2.size !== s1.size || s2.mtimeMs !== s1.mtimeMs) {
          // still being written; retry
          continue;
        }

        // sanitize & quick tail check
        let txt = buf.toString('utf-8');
        if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1); // strip BOM
        txt = txt.replace(/\u0000/g, '');
        const tr = txt.trim();
        if (!tr || !/[}\]]$/.test(tr)) {
          lastErr = new Error('truncated-json-tail');
          continue;
        }

        return JSON.parse(tr);
      } catch (e) {
        lastErr = e;
        await sleep(80);
      }
    }

    if (DEBUG_MAN) console.warn('[zcast] readManifestStable: timeout (returning null):', String(lastErr?.message || lastErr));
    return null;
  }

  function computeHash(obj: any): string {
    try { return sha256(JSON.stringify(obj)); } catch { return ''; }
  }

  function sendToRenderer(json: any, why: string) {
    if (!win) return;
    try {
      win.webContents.send('zcast:manifest-updated', json);
      if (DEBUG_MAN) console.info(`[zcast] manifest broadcast (${why})`);
    } catch (e) {
      console.warn('[zcast] failed to send manifest to renderer:', e);
    }
  }

  async function maybeBroadcastFromDisk(file: string, why: string) {
    const json = await readManifestStable(file);
    if (json === null) return; // not ready yet
    const h = computeHash(json);
    if (h && h !== lastManifestHash) {
      lastManifestHash = h;
      lastManifestObject = json;
      sendToRenderer(json, why);
    } else if (DEBUG_MAN) {
      console.log('[zcast] manifest changed on disk but content hash identical; skipping broadcast.');
    }
  }

  ipcMain.handle('zcast:read-manifest', async () => {
    const file = manifestFilePath();
    if (!file) return null;
    // Serve last good quickly; otherwise try a stable read (quietly returns null if not ready)
    if (lastManifestObject) return lastManifestObject;
    const json = await readManifestStable(file);
    if (json) {
      lastManifestObject = json;
      lastManifestHash = computeHash(json);
      return json;
    }
    return null;
  });

  function startWatch() {
    const file = manifestFilePath();
    if (!file) {
      console.warn('[zcast] No manifest file provided; watcher not started.');
      return;
    }

    // Prime cache on boot (quiet; no spam)
    (async () => {
      const json = await readManifestStable(file);
      if (json) {
        lastManifestObject = json;
        lastManifestHash = computeHash(json);
        if (DEBUG_MAN) console.log('[zcast] initial manifest loaded');
      } else if (DEBUG_MAN) {
        console.log('[zcast] initial manifest not ready; waiting for change…');
      }
    })();

    const watcher = chokidar.watch(file, {
      persistent: true,
      ignoreInitial: false,  // 'add' fires on startup if file exists
      awaitWriteFinish: {
        stabilityThreshold: Math.max(QUIET_MS, 120),
        pollInterval: 50,
      },
      disableGlobbing: true,
      depth: 0,
      atomic: 100,
      usePolling: WATCH_USE_POLL,
      interval: WATCH_INTERVAL,
      binaryInterval: WATCH_INTERVAL,
    });

    watcher
      .on('add',    () => { if (DEBUG_MAN) console.log('[zcast] manifest add');    maybeBroadcastFromDisk(file, 'add'); })
      .on('change', () => { if (DEBUG_MAN) console.log('[zcast] manifest change'); maybeBroadcastFromDisk(file, 'change'); })
      .on('unlink', () => {
        lastManifestHash = '';
        lastManifestObject = null;
        if (DEBUG_MAN) console.warn('[zcast] manifest file unlinked; waiting for re-create…');
      })
      .on('error',  (err) => console.warn('[zcast] chokidar watcher error:', err));

    console.info('[zcast] Watching manifest (chokidar):', file, WATCH_USE_POLL ? '(polling)' : '');
  }

  createWindow();
  startWatch();

  // If the renderer missed an event during boot, sync once after load.
  const sendOnReady = () => {
    if (win && lastManifestObject) {
      sendToRenderer(lastManifestObject, 'renderer-ready');
    }
  };
  win?.webContents.on('did-finish-load', sendOnReady);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
