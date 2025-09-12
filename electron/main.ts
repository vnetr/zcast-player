// src/electron/main.ts
import { app, BrowserWindow, ipcMain, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as url from 'url';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

// ---- ESM friendly __dirname ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- helpers ----
const toFileUrl = (p: string) => url.pathToFileURL(p).href;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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
  const hit = process.argv.find((a) => a.startsWith(prefix));
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
  const distIndex = prodIndexHtml();
  const distDir = distIndex ? path.dirname(distIndex) : '';
  const resFonts = path.join(process.resourcesPath, 'fonts');
  const manifestDir = mf ? path.dirname(mf) : '';

  // ============================
  // Hashed cache layout
  //   /media/assets/assets/
  //     assets-index.json
  //     u/<urlSha>/<name>
  //     h/<contentSha>/<name>
  // ============================
  const ASSETS_ROOT = '/media/assets';
  const ASSETS_SUB = path.join(ASSETS_ROOT, 'assets');
  const INDEX_PATH = path.join(ASSETS_SUB, 'assets-index.json');
  const BUNDLE_MARKER_PATH = path.join(ASSETS_ROOT, '.last_bundle_extracted');

  let assetIndex: {
    items?: Array<{ url: string; urlHash: string; contentHash?: string; name: string; size: number }>;
  } | null = null;

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

  try {
    fs.watch(ASSETS_ROOT, { persistent: false }, (_e, name) => {
      if (name === '.last_bundle_extracted') {
        setTimeout(loadAssetIndex, 200);
      }
    });
  } catch {}

  // ============================
  // file:// remaps
  // ============================
  const BARE_MEDIA_RE =
    /\.(png|jpe?g|webp|gif|svg|mp4|m4v|mov|webm|mp3|wav|ogg|ogv|aac|ttf|otf|woff2?)$/i;

  session.defaultSession.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
    try {
      const u = new URL(details.url);
      if (u.protocol !== 'file:') return callback({});
      const p = u.pathname;

      // Fonts — catch FIRST
      const bad1 = '/dist/index.html/fonts/';
      if (p.includes(bad1) && distDir) {
        const fontRel = p.slice(p.indexOf(bad1) + bad1.length);
        return callback({ redirectURL: toFileUrl(path.join(distDir, 'fonts', fontRel)) });
      }
      if (p.includes('/dist/assets/') && p.includes('/fonts/')) {
        const fontRel = p.split('/fonts/')[1];
        return callback({ redirectURL: toFileUrl(path.join(distDir, 'fonts', fontRel)) });
      }
      if (p.startsWith('/fonts/')) {
        const fontRel = p.slice('/fonts/'.length);
        return callback({ redirectURL: toFileUrl(path.join(resFonts, fontRel)) });
      }

      // Player-bundled assets
      if (manifestDir) {
        if (p.includes('/dist/assets/')) {
          const rel = p.split('/dist/assets/')[1];
          const clean = rel.split(/[?#]/)[0];
          const ext = (clean.split('.').pop() || '').toLowerCase();
          const MEDIA = new Set([
            'png','jpg','jpeg','webp','gif','svg',
            'mp4','m4v','mov','webm','mp3','wav','ogg','ogv','aac',
            'ttf','otf','woff','woff2'
          ]);
          if (MEDIA.has(ext)) {
            return callback({ redirectURL: toFileUrl(path.join(manifestDir, 'assets', rel)) });
          }
        }
        const badAssets = '/dist/index.html/assets/';
        if (p.includes(badAssets)) {
          const rel = p.slice(p.indexOf(badAssets) + badAssets.length);
          return callback({ redirectURL: toFileUrl(path.join(manifestDir, 'assets', rel)) });
        }
        if (p.startsWith('/assets/')) {
          const rel = p.slice('/assets/'.length);
          return callback({ redirectURL: toFileUrl(path.join(manifestDir, 'assets', rel)) });
        }
      }

      // Fallback
      if (manifestDir && p.includes('/dist/') && BARE_MEDIA_RE.test(p)) {
        const file = p.split('/').pop()!;
        const target = path.join(manifestDir, 'assets', file);
        return callback({ redirectURL: toFileUrl(target) });
      }

      return callback({});
    } catch (e) {
      console.warn('[assets file hook] error:', e);
      return callback({});
    }
  });

  // ============================
  // http(s) -> hashed cache redirect
  // ============================
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        const remote = details.url;
        const uhash = sha256(remote);
        const name = decodeURIComponent(new URL(remote).pathname.split('/').pop() || 'asset');

        const aliasPath = path.join(ASSETS_SUB, 'u', uhash, name);
        if (fs.existsSync(aliasPath)) {
          console.log('[assets] url-hit', remote, '→', aliasPath);
          return callback({ redirectURL: toFileUrl(aliasPath) });
        }

        const items = assetIndex?.items || [];
        const hit = items.find((x) => x.urlHash === uhash);
        if (hit?.contentHash) {
          const contentPath = path.join(ASSETS_SUB, 'h', hit.contentHash, hit.name);
          if (fs.existsSync(contentPath)) {
            console.log('[assets] content-hit', remote, '→', contentPath);
            return callback({ redirectURL: toFileUrl(contentPath) });
          }
        }

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

  const startWatch = () => {
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
        } catch {}
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
