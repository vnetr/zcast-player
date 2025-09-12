// src/renderer.ts
import { ScheduleEngine } from './schedule';

async function loadRendererModule() {
  if (import.meta.env.DEV) {
    await import('@zignage/layout-renderer');
    return;
  }
  const url = new URL('../vendor/layout-renderer.js', import.meta.url).href;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to fetch layout-renderer: ${resp.status}`);
  const src = await resp.text();
  const patched = src.replace(/e\("design:type",\s*[A-Za-z_$][\w$]*\)/g, 'e("design:type", Object)');
  const blob = new Blob([patched], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  try { await import(/* @vite-ignore */ blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
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
  // some builds dispatch 'ready' when scene is playable; if not, we fall back to heuristics
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
let engine: ScheduleEngine | null = null;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let manifestVersion = 0;

// double buffer containers / players
let stageA!: HTMLDivElement;
let stageB!: HTMLDivElement;
let activeStage!: HTMLDivElement;
let backStage!: HTMLDivElement;
let playerA!: LayoutRendererEl;
let playerB!: LayoutRendererEl;
let activePlayer!: LayoutRendererEl;
let backPlayer!: LayoutRendererEl;

let lastGoodLayout: any = null;

// ---------- DOM bootstrap (once) ----------
async function ensureStages() {
  if (stageA) return;

  await loadRendererModule();

  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.innerHTML = `
    <div id="layerA" class="layer visible"></div>
    <div id="layerB" class="layer hidden"></div>
  `;
  root.innerHTML = '';
  root.appendChild(stage);

  stageA = stage.querySelector('#layerA') as HTMLDivElement;
  stageB = stage.querySelector('#layerB') as HTMLDivElement;

  playerA = document.createElement('layout-renderer') as LayoutRendererEl;
  playerB = document.createElement('layout-renderer') as LayoutRendererEl;

  for (const el of [playerA, playerB]) {
    el.editingMode = 'false';
    el.playbackMode = 'gpu';
    el.frameRate = 30;
    el.zoomFactor = 1;
    // Ensure they fill the layer
    (el.style as any).position = 'absolute';
    (el.style as any).inset = '0';
  }

  stageA.appendChild(playerA);
  stageB.appendChild(playerB);

  activeStage = stageA; backStage = stageB;
  activePlayer = playerA; backPlayer = playerB;
}

// ---------- ready wait (robust, event or heuristic) ----------
async function waitReady(el: LayoutRendererEl, timeoutMs = 6000) {
  // If your layout-renderer dispatches a 'ready' event, prefer that:
  const hasReadyListener = new Promise<void>((resolve) => {
    const onReady = () => { el.removeEventListener('ready', onReady as any); resolve(); };
    el.addEventListener('ready', onReady as any, { once: true });
    // If no event fires quickly, we’ll resolve on play() completion below.
    setTimeout(() => { el.removeEventListener('ready', onReady as any); resolve(); }, 150); // small grace
  });

  // Try a quick play() to initialize scene graph; ignore errors (we retry)
  try { await el.play(); } catch {}

  // Fallback: small raf sequence (scene stabilized)
  const rafSettled = new Promise<void>((resolve) => {
    let ticks = 0;
    const step = () => {
      if (++ticks >= 3) return resolve(); // ~2-3 frames
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  await Promise.race([
    (async () => { await hasReadyListener; await rafSettled; })(),
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error('ready-timeout')), timeoutMs)),
  ]);
}

// ---------- layout render off-screen ----------
async function prepareOffscreen(layout: any) {
  // reset back player cleanly to avoid carry-over
  try { await backPlayer.stop(); } catch {}
  backPlayer.document = layout;

  // wait until it’s safe to show
  await waitReady(backPlayer);
}

// ---------- atomic swap ----------
function swapLayers() {
  activeStage.classList.remove('visible'); activeStage.classList.add('hidden');
  backStage.classList.remove('hidden');    backStage.classList.add('visible');

  // swap refs
  [activeStage, backStage] = [backStage, activeStage];
  [activePlayer, backPlayer] = [backPlayer, activePlayer];

  // optional: free the now-hidden player’s scene to reduce VRAM
  // but keep the element so future prepareOffscreen has a target
  try { backPlayer.pause(); } catch {}
}

// ---------- loop control ----------
function stopLoop() {
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
}

function scheduleNext(ms: number) {
  stopLoop();
  loopTimer = setTimeout(() => tick(manifestVersion), ms);
}

async function tick(versionAtStart: number) {
  if (!engine) { scheduleNext(500); return; }

  const { item, tickMs } = engine.next(new Date());

  // If manifest changed mid-tick, abandon this tick
  if (versionAtStart !== manifestVersion) return;

  if (!item) {
    // Keep last good on screen; retry fast—do NOT blank
    scheduleNext(Math.min(1000, Math.max(250, tickMs)));
    return;
  }

  const nextLayout = item.layout;
  const same =
    lastGoodLayout &&
    nextLayout &&
    ((lastGoodLayout === nextLayout) || (lastGoodLayout.id && nextLayout.id && lastGoodLayout.id === nextLayout.id));

  if (same) {
    scheduleNext(Math.max(500, tickMs));
    return;
  }

  try {
    await prepareOffscreen(nextLayout);
    if (versionAtStart !== manifestVersion) return; // manifest changed while preparing
    swapLayers();
    lastGoodLayout = nextLayout;
  } catch (e) {
    console.error('[renderer] prepare/swap failed; keep current', e);
    // stay on current; try again soon
  }

  scheduleNext(Math.max(500, tickMs));
}

// ---------- manifest application ----------
async function applyManifest(manifest: any) {
  await ensureStages();
  if (!engine) engine = new ScheduleEngine();
  engine.updateManifest(manifest);
  manifestVersion++;
  stopLoop();
  tick(manifestVersion);
}

// ---------- boot ----------
async function boot() {
  if (import.meta.hot) {
    const { default: manifest } = await import('./mock/manifest.json');
    console.info('[zcast] DEV manifest loaded (HMR)');
    await applyManifest(manifest);
    import.meta.hot.accept('./mock/manifest.json', (mod) => {
      console.info('[zcast] DEV manifest updated (HMR)');
      applyManifest(mod?.default ?? manifest);
    });
  } else {
    const json = await window.zcast?.readManifest?.();
    console.info('[zcast] manifest loaded');
    await applyManifest(json);
    window.zcast?.onManifestUpdate?.((next) => {
      console.info('[zcast] manifest file changed → applying');
      applyManifest(next);
    });
  }
}

boot().catch((e) => {
  console.error('[zcast] Boot error:', e);
  root.innerHTML = '<div style="padding:20px;color:#f55">Boot error (see console)</div>';
});
