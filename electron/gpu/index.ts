import type { App } from "electron";
import { applyGpuProfile as applyNvidia } from "./profiles/nvidia.js";
import { applyGpuProfile as applyIntel } from "./profiles/intel.js";

type Profile = "nvidia" | "intel";

function pickProfileFromEnv(): Profile {
  const raw = (process.env.ZCAST_GPU_PROFILE || "").toLowerCase().trim();
  if (raw === "nvidia") return "nvidia";
  if (raw === "intel") return "intel";
  // default if not set:
  return "intel";
}

export function applyGpuProfile(app: App) {
  const profile = pickProfileFromEnv();
  if (profile === "nvidia") return applyNvidia(app);
  return applyIntel(app);
}