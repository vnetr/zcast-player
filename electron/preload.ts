import { contextBridge, ipcRenderer } from "electron";

function safe(v: any) {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

try {
  console.log("[preload] starting");

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
  });

  console.log("[preload] zcast exposed", {
    apiBase: process.env.ZCAST_API_BASE,
    deviceId: process.env.ZCAST_DEVICE_ID,
    hasToken: !!process.env.ZCAST_ANALYTICS_TOKEN,
  });

  // Optional: listen for ping from main if you ever send it
  ipcRenderer.on("zcast:ping", (_e, msg) => console.log("[main->renderer]", msg));
} catch (e) {
  console.error("[preload] failed", e);
}
