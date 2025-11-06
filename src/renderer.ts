// src/renderer.ts
import { CanvasManager } from "./canvas";
import { initAnalytics } from "./analytics";

declare global {
  interface Window {
    zcast?: {
      readManifest: () => Promise<any>;
      onManifestUpdate: (cb: (data: any) => void) => () => void;
      deviceId?: string;
      analyticsToken?: string;
      apiBase?: string;
    };
  }
}

const root = document.getElementById("root")!;
const mgr = new CanvasManager(root);
function bootAnalyticsFromManifest(manifest: any) {
  try {
    const items = Array.isArray(manifest) ? manifest : [];
    const first = (items[0]?.data ?? items[0]) || {};

    const defaults = {
      player: window.zcast?.deviceId || first.player || first.deviceId,
      customer: first.customer,
      user_group: first.user_group,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    };

    const endpointBase = window.zcast?.apiBase || location.origin;

    initAnalytics({
      endpointBase,
      authToken: window.zcast?.analyticsToken,
      flushIntervalMs: 2500,
      maxBatch: 60,
      defaults,
    });
  } catch {
    // no-op: analytics init is best-effort
  }
}

// ---------- manifest application ----------
async function applyManifest(manifest: any) {
  bootAnalyticsFromManifest(manifest);
  mgr.applyManifest(manifest);
}

// ---------- boot ----------
async function boot() {
  if (import.meta.hot) {
    const { default: manifest } = await import("./mock/manifest.json");
    console.info("[zcast] DEV manifest loaded (HMR)");
    await applyManifest(manifest);
    import.meta.hot.accept("./mock/manifest.json", (mod) => {
      console.info("[zcast] DEV manifest updated (HMR)");
      applyManifest(mod?.default ?? manifest);
    });
  } else {
    const json = await window.zcast?.readManifest?.();
    console.info("[zcast] manifest loaded");
    await applyManifest(json);
    window.zcast?.onManifestUpdate?.((next) => {
      console.info("[zcast] manifest file changed → applying");
      applyManifest(next);
    });
  }
}

boot().catch((e) => {
  console.error("[zcast] Boot error:", e);
  root.innerHTML =
    '<div style="padding:20px;color:#f55">Boot error (see console)</div>';
});
