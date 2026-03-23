import { contextBridge, ipcRenderer } from "electron";

type MediaPrefetchMode = "none" | "metadata" | "full";

function safe(v: any) {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function envFlag(name: string, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return /^(1|true|yes)$/i.test(String(raw));
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function mediaPrefetchModeFromEnv(): MediaPrefetchMode {
  const raw = String(process.env.ZCAST_MEDIA_PREFETCH_MODE || "none").toLowerCase().trim();
  if (raw === "metadata") return "metadata";
  if (raw === "full") return "full";
  return "none";
}

function disableRendererDebugFromEnv() {
  return !/^(0|false|no)$/i.test(String(process.env.ZCAST_DISABLE_RENDERER_DEBUG || "1"));
}

try {
  console.log("[preload] starting");

  const perf = {
    disableHwAccel: envFlag("ZCAST_DISABLE_HW_ACCEL", false),
    mediaPrefetchMode: mediaPrefetchModeFromEnv(),
    disableRendererDebug: disableRendererDebugFromEnv(),
    avPrefetchTimeoutMs: envNumber("ZCAST_AV_PREFETCH_TIMEOUT_MS", 750),
    imagePrefetchTimeoutMs: envNumber("ZCAST_IMAGE_PREFETCH_TIMEOUT_MS", 1500),
  };
  const forwardRendererConsole = envFlag("ZCAST_FORWARD_RENDERER_CONSOLE", false);

  if (forwardRendererConsole) {
    ["log", "info", "warn", "error"].forEach((level) => {
      const orig = (console as any)[level]?.bind(console) ?? (() => {});
      (console as any)[level] = (...args: any[]) => {
        try {
          ipcRenderer.send("zcast:console", { level, args: args.map(safe) });
        } catch {}
        orig(...args);
      };
    });

    window.addEventListener("error", (ev) => {
      try {
        ipcRenderer.send("zcast:console", {
          level: "pageerror",
          message: ev.message,
          filename: ev.filename,
          lineno: ev.lineno,
          colno: ev.colno,
          stack: (ev as any).error?.stack,
        });
      } catch {}
    });

    window.addEventListener("unhandledrejection", (ev: any) => {
      try {
        ipcRenderer.send("zcast:console", {
          level: "unhandledrejection",
          reason: safe(ev.reason),
        });
      } catch {}
    });
  }

  contextBridge.exposeInMainWorld("zcast", {
    readManifest: () => ipcRenderer.invoke("zcast:read-manifest"),
    onManifestUpdate: (cb: (data: unknown) => void) => {
      const handler = (_: unknown, payload: unknown) => cb(payload);
      ipcRenderer.on("zcast:manifest-updated", handler);
      return () => ipcRenderer.removeListener("zcast:manifest-updated", handler);
    },

    // Analytics / config
    apiBase: process.env.ZCAST_API_BASE || undefined,
    deviceId: process.env.ZCAST_DEVICE_ID || undefined,
    analyticsToken: process.env.ZCAST_ANALYTICS_TOKEN || undefined,
    perf,
  });

  console.log("[preload] zcast exposed", {
    apiBase: process.env.ZCAST_API_BASE,
    deviceId: process.env.ZCAST_DEVICE_ID,
    hasToken: !!process.env.ZCAST_ANALYTICS_TOKEN,
    perf,
    forwardRendererConsole,
  });

  // Optional: listen for ping from main if you ever send it
  ipcRenderer.on("zcast:ping", (_e, msg) => console.log("[main->renderer]", msg));
} catch (e) {
  console.error("[preload] failed", e);
}
