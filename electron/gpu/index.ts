import type { App } from "electron";
import fs from "fs";
import { applyGpuProfile as applyNvidia } from "./profiles/nvidia.js";
import { applyGpuProfile as applyIntel } from "./profiles/intel.js";

type Profile = "nvidia" | "intel";

function looksLikeNvidiaDisplay(): boolean {
  try {
    return fs.existsSync("/proc/driver/nvidia/version") || fs.existsSync("/dev/nvidia0");
  } catch {
    return false;
  }
}

function pickProfileFromEnv(): Profile {
  const raw = (process.env.ZCAST_GPU_PROFILE || "").toLowerCase().trim();
  if (raw === "nvidia") return "nvidia";
  if (raw === "intel") return "intel";
  return looksLikeNvidiaDisplay() ? "nvidia" : "intel";
}

export function applyGpuProfile(app: App) {
  const profile = pickProfileFromEnv();
  console.info("[zcast][gpu] selected profile:", profile);
  if (profile === "nvidia") return applyNvidia(app);
  return applyIntel(app);
}
