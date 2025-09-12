// renderer/index.ts
//import '@zignage/layout-renderer';
import { pickActiveContent } from './schedule';

async function loadRendererModule() {
  if (import.meta.env.DEV) {
    // Dev: normal node_modules import
    await import('@zignage/layout-renderer');
    return;
  }

  // Prod: read the vendor file text, neutralize TDZ patterns, import from a blob
  const url = new URL('../vendor/layout-renderer.js', import.meta.url).href;

  // 1) fetch the original source (from app.asar/dist/vendor/…)
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to fetch renderer: ${resp.status}`);
  const src = await resp.text();

  // 2) patch: replace any decorator metadata like e("design:type", <ident>)
  // with a harmless Object to avoid reading TDZ locals.
  // (multiple hits can exist; do a global replace)
  const patched = src.replace(/e\("design:type",\s*[A-Za-z_$][\w$]*\)/g, 'e("design:type", Object)');

  // 3) import the patched code from a blob URL
  const blob = new Blob([patched], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    await import(/* @vite-ignore */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

type LayoutRendererEl = HTMLElement & {
  document: any;
  editingMode: 'false' | 'true' | 'template';
  playbackMode: 'gpu' | 'cpu' | 'step';
  frameRate: number;
  zoomFactor: number;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
};

declare global {
  interface Window {
    zcast?: {
      readManifest: () => Promise<any>;
      onManifestUpdate: (cb: (data: any) => void) => () => void;
    };
  }
}

const root = document.getElementById('root')!;
let playerEl: LayoutRendererEl | null = null;
let scheduleCache: any = null;
let boundaryTimer: any = null;

async function ensureRenderer(): Promise<LayoutRendererEl> {
  if (playerEl) return playerEl;
  await loadRendererModule(); // <-- ensure the custom element is defined

  root.innerHTML = '';
  const el = document.createElement('layout-renderer') as LayoutRendererEl;
  el.editingMode = 'false';
  el.playbackMode = 'gpu';
  el.frameRate = 30;
  el.zoomFactor = 1;
  root.appendChild(el);
  playerEl = el;
  return el;
}

async function applySchedule(doc: any) {
  scheduleCache = doc;
  if (!doc) {
    console.warn('[zcast] No schedule manifest loaded.');
    return;
  }

  const pick = pickActiveContent(doc, new Date());
  if (pick.kind === 'layout') {
    const el = await ensureRenderer();
    el.document = pick.layout;
    try { await el.play(); } catch { }
    console.info('[zcast] Mounted layout from active event. Next check at', new Date(pick.nextCheck).toISOString());
  } else {
    console.info('[zcast] No active event right now. Next check at', new Date(pick.nextCheck).toISOString());
    // Optional: show a black screen or maintenance splash
    root.innerHTML = '<div style="width:100%;height:100%;background:#000"></div>';
    playerEl = null;
  }

  // Re-evaluate at the boundary without polling
  if (boundaryTimer) clearTimeout(boundaryTimer);
  const delay = Math.max(250, pick.nextCheck - Date.now());
  boundaryTimer = setTimeout(() => {
    if (scheduleCache) applySchedule(scheduleCache);
  }, delay);
}

async function boot() {
  if (import.meta.hot) {
    // Dev: load mock manifest via HMR
    const { default: manifest } = await import('./mock/manifest.json');
    await applySchedule(manifest);

    import.meta.hot.accept('./mock/manifest.json', (mod) => {
      const next = mod?.default ?? manifest;
      applySchedule(next);
      console.info('[HMR] schedule manifest hot-updated');
    });
  } else {
    // Prod: read local file via preload
    const json = await window.zcast?.readManifest?.();
    console.info('[zcast] manifest loaded type:',
      Array.isArray(json) ? `array(len=${json.length})` : typeof json,
      json && typeof json === 'object' && 'media' in json ? '(flat item)' : ''
    );
    await applySchedule(json);

    // Push updates when the file changes
    window.zcast?.onManifestUpdate?.((next) => {
      console.info('[zcast] Manifest file changed -> applying');
      applySchedule(next);
    });
  }
}

boot().catch((e) => {
  console.error('[zcast] Boot error:', e);
  root.innerHTML = '<div style="padding:20px;color:#f55">Boot error (see console)</div>';
});
