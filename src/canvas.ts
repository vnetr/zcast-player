// src/canvas.ts
import { ScheduleEngine, normalize } from "./schedule";
import type { RendererKind, BaseRendererEl } from "./types/renderers";
import { loadRenderer, createRendererEl } from "./renderer/loader";
import { analytics, makeEventId } from "./analytics";

type CanvasCfg = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  frameRate?: number;
  resolution?: string;
};

type ManifestItem = any;

/* ===========================
   Utilities
   =========================== */

function parseResolution(res?: string): { w?: number; h?: number } {
  if (!res) return {};
  const m = res.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!m) return {};
  return { w: +m[1], h: +m[2] };
}

function pickCanvasCfg(item: ManifestItem): CanvasCfg | null {
  const data = item?.data ?? item;
  const c = data?.canvas;
  if (!c || !c.id) return null;

  const loc = c.location || {};
  const res = parseResolution(c.resolution);

  const width = Number(res.w ?? 1920);
  const height = Number(res.h ?? 1080);

  const x = Number(loc.x ?? c.x ?? 0);
  const y = Number(loc.y ?? c.y ?? 0);

  return {
    id: String(c.id),
    x,
    y,
    width,
    height,
    frameRate: c.frameRate,
    resolution: c.resolution,
  };
}

function cfgEquals(a: CanvasCfg, b: CanvasCfg): boolean {
  return (
    a.id === b.id &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.frameRate === b.frameRate &&
    a.resolution === b.resolution
  );
}

/* ===========================
   CanvasPlayer (per-canvas)
   =========================== */

export class CanvasPlayer {
  private root: HTMLElement;
  private cfg: CanvasCfg;
  private container!: HTMLDivElement;

  // Double buffer stages (A/B) – identical behavior to your single-canvas renderer.ts
  private stageA!: HTMLDivElement;
  private stageB!: HTMLDivElement;
  private activeStage!: HTMLDivElement;
  private backStage!: HTMLDivElement;

  private playerA: BaseRendererEl | null = null;
  private playerB: BaseRendererEl | null = null;
  private activePlayer: BaseRendererEl | null = null;
  private backPlayer: BaseRendererEl | null = null;
  private activeKind: RendererKind | null = null;
  private backKind: RendererKind | null = null;

  private loopTimer: ReturnType<typeof setTimeout> | null = null;

  private engine: ScheduleEngine | null = null;
  private manifestVersion = 0;

  // Track last successfully shown doc (by kind+id) to avoid redundant swaps
  private lastGood: { kind: RendererKind; id?: string | number } | null = null;
  private lastStartAt: number | null = null; // ms epoch when item became visible
  private lastEventId: string | null = null; // upsert key used for 'started'
  private lastMeta: any = null;

  // Blackout state: when schedule says "nothing active", force empty black canvas
  private isBlack = false;

  constructor(root: HTMLElement, cfg: CanvasCfg) {
    this.root = root;
    this.cfg = cfg;
  }

  id() {
    return this.cfg.id;
  }

  /* ---------- DOM bootstrap ---------- */
  mount() {
    if (this.container) return;

    const { x, y, width, height } = this.cfg;

    // Viewport container (cropping happens here)
    const canvas = document.createElement("div");
    canvas.className = "canvas";
    Object.assign(canvas.style, {
      position: "absolute",
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
      overflow: "hidden",
      userSelect: "none",
      pointerEvents: "none", // render-only surface; events disabled
      background: "black", // ✅ default black
    } as CSSStyleDeclaration);

    // A/B layers inside the canvas
    const stage = document.createElement("div");
    stage.className = "stage";
    stage.innerHTML = `
      <div class="layer visible"></div>
      <div class="layer hidden"></div>
    `;
    canvas.appendChild(stage);
    this.root.appendChild(canvas);

    this.container = canvas;
    this.stageA = stage.querySelector(".layer.visible") as HTMLDivElement;
    this.stageB = stage.querySelector(".layer.hidden") as HTMLDivElement;
    this.activeStage = this.stageA;
    this.backStage = this.stageB;
  }

  unmount() {
    this.stopLoop();

    // Ensure renderers are fully stopped so nothing keeps drawing / playing audio
    this.blackout("unmount");

    if (this.container?.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
    this.container =
      this.stageA =
      this.stageB =
      this.activeStage =
      this.backStage =
      undefined as any;
    this.playerA = this.playerB = this.activePlayer = this.backPlayer = null;
    this.activeKind = this.backKind = null;
  }

  private getTopLevelIdentity(item: any, next: { kind: RendererKind; doc: any; id?: string | number }) {
    const anyItem = item as any;
    const data: any = anyItem?.data ?? anyItem ?? {};
    const media: any = data?.media ?? next.doc ?? {};

    // We ONLY care about top-level (layout or playlist), never children.
    // Prefer explicit layoutId/playlistId on schedule item (your schedule example has layoutId).
    const media_type: "layout" | "playlist" = next.kind === "playlist" ? "playlist" : "layout";

    const media_id =
      (media_type === "layout"
        ? (data?.layoutId || media?.id)
        : (data?.playlistId || media?.id)) ?? next.id;

    const media_name =
      media?.name ?? data?.scheduleName ?? data?.name ?? String(media_id ?? next.id ?? "UNKNOWN");

    return { media_type, media_id: String(media_id ?? ""), media_name };
  }


  /** Update canvas geometry live if manifest changed x/y/resolution */
  applyGeometry(cfg: CanvasCfg) {
    this.cfg = cfg;
    if (!this.container) return;
    const { x, y, width, height } = this.cfg;
    Object.assign(this.container.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
    } as CSSStyleDeclaration);
  }

  /* ---------- Manifest handling ---------- */
  updateManifest(fullManifest: any) {
    if (!this.engine) this.engine = new ScheduleEngine();

    // Filter manifest → only items for this canvas id
    const list = normalize(fullManifest);
    const filtered = list.filter((it: any) => {
      const cid =
        it?.canvasId ||
        it?.canvas?.id ||
        it?.data?.canvasId ||
        it?.data?.canvas?.id;
      return String(cid ?? "") === this.cfg.id;
    });

    this.engine.updateManifest(filtered);
    this.manifestVersion++;
    this.stopLoop();

    // ✅ If there are no items for this canvas at all, go black immediately.
    if (filtered.length === 0) {
      this.blackout("manifest-empty-for-canvas");
      this.scheduleNext(1000); // keep evaluating periodically (or wait for next manifest push)
      return;
    }

    this.tick(this.manifestVersion);
  }

  /* ---------- helpers: readiness & events ---------- */
  private waitLoaded(
    el: HTMLElement,
    kind: RendererKind,
    timeoutMs = 6000
  ): Promise<void> {
    // Playlist renderer does not expose a "loaded" event; skip.
    if (kind === "playlist") return Promise.resolve();

    const eventName = "layoutLoaded";
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const onLoaded = () => {
        if (!done) {
          done = true;
          cleanup();
          resolve();
        }
      };
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          cleanup();
          reject(new Error(`${eventName} timeout`));
        }
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(t);
        el.removeEventListener(eventName as any, onLoaded as any);
      };
      el.addEventListener(eventName as any, onLoaded as any, { once: true });
    });
  }

  private async waitReady(el: BaseRendererEl, timeoutMs = 6000) {
    try {
      await el.play();
    } catch { }

    const rafSettled = new Promise<void>((resolve) => {
      let ticks = 0;
      const step = () => {
        if (++ticks >= 3) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    await Promise.race([
      rafSettled,
      new Promise<void>((_, rej) =>
        setTimeout(() => rej(new Error("ready-timeout")), timeoutMs)
      ),
    ]);
  }

  /* ---------- analytics helper: finish previous "started" item ---------- */
  private finishLastEventIfAny() {
    try {
      if (this.lastEventId && this.lastStartAt) {
        const durSec = Math.max(
          0,
          Math.floor((Date.now() - this.lastStartAt) / 1000)
        );
        const m = this.lastMeta || {};

        const playerName =
          m.player ||
          m.deviceId ||
          (typeof window !== "undefined" && (window as any).zcast?.deviceId) ||
          m.canvasName ||
          "UNKNOWN";

        analytics.logEventCompleted({
          event_id: this.lastEventId,
          duration: durSec,
          status: "completed",
          player: playerName,
          schedule: m.scheduleName,

          // ✅ correct identity
          media: m.mediaId,            // UUID
          media_name: m.mediaName,     // name
          media_type: m.mediaType,     // layout|playlist

          customer: m.customer,
          user_group: m.user_group,
        });
      }
    } catch { }

    this.lastStartAt = null;
    this.lastEventId = null;
    this.lastMeta = null;
  }

  /* ---------- blackout: force empty black surface (stop & remove renderers) ---------- */
  private blackout(reason: string) {
    this.mount();

    // If already black, avoid repeated heavy cleanup.
    if (this.isBlack) return;
    this.isBlack = true;

    console.info("[canvas] BLACK:", this.cfg.id, reason);

    // Finish analytics session for whatever was visible.
    this.finishLastEventIfAny();

    const kill = (p: BaseRendererEl | null) => {
      if (!p) return;
      try {
        p.pause?.();
      } catch { }
      try {
        p.stop?.();
      } catch { }
      try {
        if ((p as any).parentElement) {
          (p as any).parentElement.removeChild(p as any);
        }
      } catch { }
    };

    // Stop/remove both visible & hidden renderers
    kill(this.activePlayer);
    kill(this.backPlayer);

    // Clear stages fully and force black backgrounds
    const clearStage = (st: HTMLDivElement) => {
      try {
        st.innerHTML = "";
      } catch { }
      try {
        (st.style as any).background = "black";
      } catch { }
    };
    if (this.activeStage) clearStage(this.activeStage);
    if (this.backStage) clearStage(this.backStage);

    // Reset renderer pointers so next item recreates cleanly
    this.playerA = this.playerB = null;
    this.activePlayer = this.backPlayer = null;
    this.activeKind = this.backKind = null;

    // Reset "lastGood" so next render will proceed
    this.lastGood = null;
  }

  /* ---------- ensure the back layer has the right element ---------- */
  private async ensureBackRenderer(kind: RendererKind, doc: any) {
    // Ensure custom elements are defined
    if (kind === "playlist") {
      await loadRenderer("layout");
      await customElements.whenDefined("layout-renderer");
      await loadRenderer("playlist");
      await customElements.whenDefined("playlist-renderer");
    } else {
      await loadRenderer("layout");
      await customElements.whenDefined("layout-renderer");
      await loadRenderer("playlist");
      await customElements.whenDefined("playlist-renderer");
    }

    // If the back element is missing or a different kind, replace it.
    if (!this.backPlayer || this.backKind !== kind) {
      if (this.backPlayer?.parentElement) {
        try {
          this.backPlayer.pause?.();
        } catch { }
        try {
          this.backPlayer.stop?.();
        } catch { }
        this.backPlayer.parentElement.removeChild(this.backPlayer);
      }

      // Create, assign .document FIRST, then append → avoids null-first-render in Lit
      const el = createRendererEl(kind);
      (el as any).document = doc;

      // Fill the viewport (the container is the cropper)
      Object.assign(el.style, {
        position: "absolute",
        inset: "0",
      } as CSSStyleDeclaration);

      // Optional per-canvas frame rate (layout/playlist both accept frameRate in your wrappers)
      try {
        (el as any).frameRate =
          this.cfg.frameRate ?? (el as any).frameRate ?? 30;
      } catch { }

      this.backStage.appendChild(el);

      this.backPlayer = el;
      this.backKind = kind;

      if (!this.playerA) this.playerA = el;
      else if (!this.playerB) this.playerB = el;

      return;
    }

    // Same kind already mounted on back stage → just update the doc before it updates
    (this.backPlayer as any).document = doc;
  }

  /* ---------- render off-screen (generic for both kinds) ---------- */
  private async prepareOffscreen(kind: RendererKind, doc: any) {
    this.mount();
    await this.ensureBackRenderer(kind, doc);

    try {
      await this.backPlayer?.stop?.();
    } catch { }

    await this.waitLoaded(
      this.backPlayer as unknown as HTMLElement,
      kind
    ).catch(() => { });
    try {
      await this.backPlayer?.play?.();
    } catch { }

    await this.waitReady(this.backPlayer!).catch(() => { });
  }

  /* ---------- atomic swap ---------- */
  private async swapLayers() {
    this.finishLastEventIfAny();

    this.activeStage.classList.remove("visible");
    this.activeStage.classList.add("hidden");
    this.backStage.classList.remove("hidden");
    this.backStage.classList.add("visible");

    // swap refs & kinds
    [this.activeStage, this.backStage] = [this.backStage, this.activeStage];
    [this.activePlayer, this.backPlayer] = [this.backPlayer, this.activePlayer];
    [this.activeKind, this.backKind] = [
      this.backKind as RendererKind,
      this.activeKind as RendererKind,
    ];

    // Ensure the now-visible player is actually playing
    try {
      await this.activePlayer?.play?.();
    } catch { }
    requestAnimationFrame(async () => {
      try {
        await this.activePlayer?.play?.();
      } catch { }
    });

    // Quiet the hidden one
    try {
      this.backPlayer?.pause?.();
    } catch { }
    try {
      const meta: any = (this as any)._nextMeta;
      if (meta && meta.kind && meta.id) {
        const playerName =
          meta.player ||
          meta.deviceId ||
          (typeof window !== "undefined" && (window as any).zcast?.deviceId) ||
          meta.canvasName ||
          "UNKNOWN";

        const eid = makeEventId(String(playerName), String(meta.id), Date.now());

        analytics.logEventStart({
          event_id: eid,
          timestamp: new Date().toISOString(),
          player: playerName,
          schedule: meta.scheduleName,

          // ✅ correct identity
          media: meta.mediaId,           // UUID
          media_name: meta.mediaName,    // name
          media_type: meta.mediaType,    // layout|playlist

          customer: meta.customer,
          user_group: meta.user_group,
          status: "started",
          actions: ["started"],
        });

        this.lastStartAt = Date.now();
        this.lastEventId = eid;
        this.lastMeta = meta;
      } else {
        this.lastStartAt = Date.now();
        this.lastEventId = null;
        this.lastMeta = null;
      }
      (this as any)._nextMeta = undefined;
    } catch { }
  }

  /* ---------- loop control ---------- */
  private stopLoop() {
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }
  private scheduleNext(ms: number) {
    this.stopLoop();
    this.loopTimer = setTimeout(() => this.tick(this.manifestVersion), ms);
  }

  /* ---------- engine integration ---------- */
  private resolveNextFromEngineItem(item: any): {
    kind: RendererKind;
    doc: any;
    id?: string | number;
  } {
    // Common shapes coming from schedule engine or raw manifest:
    // - item.layout (could be a layout or a playlist doc)
    // - item.media (schedule.data.media)
    // - item.document (defensive)
    const raw = item?.layout ?? item?.media ?? item?.document ?? item;

    // Identify playlist vs layout by explicit type or presence of items[]
    const looksPlaylist =
      !!raw && (raw.type === "playlist" || Array.isArray(raw.items));
    const kind: RendererKind = looksPlaylist ? "playlist" : "layout";

    // Use raw as the doc directly (both renderers accept `.document`)
    const doc = raw;

    // Prefer explicit id; fall back to name if present
    const id = doc?.id ?? doc?.name;
    return { kind, doc, id };
  }

  private async tick(versionAtStart: number) {
    if (!this.engine) {
      this.scheduleNext(500);
      return;
    }

    const { item, tickMs } = this.engine.next(new Date());
    if (versionAtStart !== this.manifestVersion) return;

    if (!item) {
      // ✅ Nothing active right now => force black + remove old content
      this.blackout("no-active-now");
      this.scheduleNext(Math.min(1000, Math.max(250, tickMs)));
      return;
    }

    // We have content => leave black mode
    this.isBlack = false;

    const next = this.resolveNextFromEngineItem(item);

    const idn = this.getTopLevelIdentity(item, next);

    const same =
      this.lastGood &&
      this.lastGood.kind === next.kind &&
      this.lastGood.id &&
      idn.media_id &&
      this.lastGood.id === idn.media_id;

    if (same) {
      this.scheduleNext(Math.max(500, tickMs));
      return;
    }

    // Capture metadata for analytics to use after the swap
    const anyItem = item as any;
    const data: any = anyItem?.data ?? anyItem ?? {};
    const canvas: any = data.canvas ?? {};
    const media: any = data.media ?? {};
    (this as any)._nextMeta = {
      kind: next.kind,
      id: idn.media_id,              // top-level UUID string
      mediaId: idn.media_id,         // explicit (for readability)
      mediaName: idn.media_name,     // display name
      mediaType: idn.media_type,     // "layout" | "playlist"

      scheduleName: data?.scheduleName ?? data?.name,
      customer: data?.customer,
      user_group: data?.user_group,
      player: data?.player,
      deviceId: data?.deviceId,
      canvasName: canvas?.name,
    };

    try {
      await this.prepareOffscreen(next.kind, next.doc);
      if (versionAtStart !== this.manifestVersion) return;
      await this.swapLayers();
      this.lastGood = { kind: next.kind, id: idn.media_id };
    } catch (e) {
      console.error("[canvas] prepare/swap failed; keeping current item", e);
    }

    this.scheduleNext(Math.max(500, tickMs));
  }
}

/* ===========================
   CanvasManager (multi-canvas)
   =========================== */

export class CanvasManager {
  private root: HTMLElement;
  private players = new Map<string, CanvasPlayer>();
  private lastCfg = new Map<string, CanvasCfg>();

  constructor(root: HTMLElement) {
    this.root = root;

    // ✅ Global fallback: if no canvases exist, root stays black
    try {
      this.root.style.background = "black";
    } catch { }
  }

  applyManifest(manifest: any) {
    // Build desired canvas set from manifest
    const items = normalize(manifest);
    const wanted = new Map<string, CanvasCfg>();

    for (const it of items) {
      const cfg = pickCanvasCfg({ data: it, ...it });
      if (cfg) wanted.set(cfg.id, cfg); // last wins if duplicates
    }

    // Remove players no longer present
    for (const [id, player] of this.players) {
      if (!wanted.has(id)) {
        player.unmount();
        this.players.delete(id);
        this.lastCfg.delete(id);
      }
    }

    // Ensure / update players
    for (const [id, cfg] of wanted) {
      const prev = this.lastCfg.get(id);
      let p = this.players.get(id);

      if (!p) {
        p = new CanvasPlayer(this.root, cfg);
        p.mount();
        this.players.set(id, p);
        this.lastCfg.set(id, cfg);
      } else {
        if (!prev || !cfgEquals(prev, cfg)) {
          p.applyGeometry(cfg);
          this.lastCfg.set(id, cfg);
        }
      }
      // Always pass the full manifest (player filters by its id)
      p.updateManifest(manifest);
    }
  }
}
