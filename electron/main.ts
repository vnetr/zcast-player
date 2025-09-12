import { app, BrowserWindow, ipcMain, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as url from 'url';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

// ---- ESM friendly __dirname ----
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---- helpers ----
const toFileUrl = (p: string) => url.pathToFileURL(p).href;
const sha256    = (s: string) => createHash('sha256').update(s).digest('hex');
const DEBUG     = /^(1|true|yes)$/i.test(String(process.env.ZCAST_DEBUG_ASSETS || ''));

function dbg(...args: any[]) { if (DEBUG) console.log('[assets]', ...args); }

// ---- Force GPU / HW accel on Linux ----
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
      // IMPORTANT: allow http(s) -> file:// redirects for media
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
  const distIndex   = prodIndexHtml();                          // /opt/.../app.asar/dist/index.html
  const distDir     = distIndex ? path.dirname(distIndex) : ''; // /opt/.../app.asar/dist
  const resFonts    = path.join(process.resourcesPath, 'fonts'); // /opt/.../resources/fonts
  const manifestDir = mf ? path.dirname(mf) : '';               // e.g. /media/schedule

  // ============================
  // Hashed cache layout (extractor output)
  //   /media/assets/
  //     assets/
  //       assets-index.json
  //       u/<urlSha>/<name>
  //       h/<contentSha>/<name>
  // ============================
  const ASSETS_ROOT = '/media/assets';
  const ASSETS_SUB  = path.join(ASSETS_ROOT, 'assets');           // where u/, h/, assets-index.json live
  const INDEX_PATH  = path.join(ASSETS_SUB, 'assets-index.json'); // mapping (optional)

  let assetIndex: { items?: Array<{ url:string; urlHash:string; contentHash?:string; name:string; size:number }> } | null = null;

  function loadAssetIndex() {
    try {
      const txt = fs.readFileSync(INDEX_PATH, 'utf-8');
      assetIndex = JSON.parse(txt);
      console.info('[assets] index loaded:', assetIndex?.items?.length ?? 0, 'entries');
    } catch (e) {
      assetIndex = null;
      console.warn('[assets] index not readable yet – URL-hash alias only.', String(e));
    }
  }
  loadAssetIndex();

  // Watch for extractor marker (your script should: touch /media/assets/.last_bundle_extracted)
  try {
    fs.watch(ASSETS_ROOT, { persistent: false }, (_event, name) => {
      if (name === '.last_bundle_extracted') setTimeout(loadAssetIndex, 200);
    });
  } catch { /* ignore */ }

  // ============================
  // file:// remaps (fonts + local bundle assets)
  // ============================
  const MEDIA_EXTS = new Set([
    'png','jpg','jpeg','webp','gif','svg',
    'mp4','m4v','mov','webm','mp3','wav','ogg','ogv','aac',
    'ttf','otf','woff','woff2'
  ]);
  const BARE_MEDIA_RE = /\.(png|jpe?g|webp|gif|svg|mp4|m4v|mov|webm|mp3|wav|ogg|ogv|aac|ttf|otf|woff2?)$/i;

  function resolveFontPath(fontRel: string): string | null {
    const tryDist = path.join(distDir, 'fonts', fontRel);
    if (distDir && fs.existsSync(tryDist)) return tryDist;
    const tryRes = path.join(resFonts, fontRel);
    if (fs.existsSync(tryRes)) return tryRes;
    return null;
  }

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['file://*/*'] },
    (details, callback) => {
      try {
        const u = new URL(details.url);
        if (u.protocol !== 'file:') return callback({});
        const p = u.pathname;

        // ---- fonts FIRST (more robust: try dist/fonts then resources/fonts) ----
        const bad1 = '/dist/index.html/fonts/';
        if (p.includes(bad1)) {
          const fontRel = p.slice(p.indexOf(bad1) + bad1.length);
          const tgt = resolveFontPath(fontRel);
          if (tgt) {
            dbg('font redirect', p, '->', tgt);
            return callback({ redirectURL: toFileUrl(tgt) });
          }
        }
        // “/dist/assets/.../fonts/<name>”
        if (p.includes('/dist/assets/') && p.includes('/fonts/')) {
          const fontRel = p.split('/fonts/')[1];
          const tgt = resolveFontPath(fontRel);
          if (tgt) {
            dbg('font redirect2', p, '->', tgt);
            return callback({ redirectURL: toFileUrl(tgt) });
          }
        }
        // root-absolute “/fonts/<name>”
        if (p.startsWith('/fonts/')) {
          const fontRel = p.slice('/fonts/'.length);
          const tgt = resolveFontPath(fontRel);
          if (tgt) {
            dbg('font redirect3', p, '->', tgt);
            return callback({ redirectURL: toFileUrl(tgt) });
          }
        }

        // ---- local assets placed by extractor next to manifest ----
        if (manifestDir) {
          // /dist/assets/<file> → <manifestDir>/assets/<file> (ONLY media, not js/css chunks)
          if (p.includes('/dist/assets/')) {
            const rel = p.split('/dist/assets/')[1];
            const clean = rel.split(/[?#]/)[0];
            const ext = (clean.split('.').pop() || '').toLowerCase();
            if (MEDIA_EXTS.has(ext)) {
              const target = path.join(manifestDir, 'assets', rel);
              dbg('media redirect dist/assets', p, '->', target);
              return callback({ redirectURL: toFileUrl(target) });
            }
          }
          // /dist/index.html/assets/<file>
          const badAssets = '/dist/index.html/assets/';
          if (p.includes(badAssets)) {
            const rel = p.slice(p.indexOf(badAssets) + badAssets.length);
            const target = path.join(manifestDir, 'assets', rel);
            dbg('media redirect idx/assets', p, '->', target);
            return callback({ redirectURL: toFileUrl(target) });
          }
          // absolute /assets/<file>
          if (p.startsWith('/assets/')) {
            const rel = p.slice('/assets/'.length);
            const target = path.join(manifestDir, 'assets', rel);
            dbg('media redirect /assets', p, '->', target);
            return callback({ redirectURL: toFileUrl(target) });
          }
        }

        // Failsafe: any bare media under /dist/* → <manifestDir>/assets/<filename> if present
        if (manifestDir && p.includes('/dist/') && BARE_MEDIA_RE.test(p)) {
          const base = path.join(manifestDir, 'assets');
          const fname = p.split('/').pop()!;
          const target = path.join(base, fname);
          if (fs.existsSync(target)) {
            dbg('media fallback dist/* -> manifest assets', p, '->', target);
            return callback({ redirectURL: toFileUrl(target) });
          }
        }

        return callback({});
      } catch (e) {
        console.warn('[assets file hook] error:', e);
        return callback({});
      }
    }
  );

  // ============================
  // http(s) -> local hashed cache redirect (for remote media)
  // ============================
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        const remote = details.url;

        // only consider recognizable media extensions
        const pathPart = new URL(remote).pathname;
        const ext = (pathPart.split('.').pop() || '').toLowerCase();
        if (!MEDIA_EXTS.has(ext)) return callback({});

        const uhash = sha256(remote);
        const name  = decodeURIComponent(pathPart.split('/').pop() || 'asset');

        // 1) URL-hash alias: assets/u/<urlHash>/<name>
        const aliasPath = path.join(ASSETS_SUB, 'u', uhash, name);
        if (fs.existsSync(aliasPath)) {
          dbg('url-hit', remote, '->', aliasPath);
          return callback({ redirectURL: toFileUrl(aliasPath) });
        }

        // 2) content-hash bucket via index: assets/h/<contentHash>/<name>
        const items = assetIndex?.items || [];
        const hit   = items.find((x) => x.urlHash === uhash);
        if (hit?.contentHash) {
          const contentPath = path.join(ASSETS_SUB, 'h', hit.contentHash, hit.name);
          if (fs.existsSync(contentPath)) {
            dbg('content-hit', remote, '->', contentPath);
            return callback({ redirectURL: toFileUrl(contentPath) });
          }
        }

        // 3) otherwise let it go to network
        return callback({});
      } catch (e) {
        console.warn('[assets http hook] error:', e);
        return callback({});
      }
    }
  );

  // ============================
  // IPC: manifest read + watch
  // ============================
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
