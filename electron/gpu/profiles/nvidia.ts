import type { App } from "electron";
import fs from "fs";

export function applyGpuProfile(app: App) {
    const enableFeatures = new Set<string>([
        'CanvasOopRasterization',
        'VideoDecodeLinuxZeroCopyGL',
    ]);

    const disableFeatures = new Set<string>();

    const hwDecodeMode = (process.env.ZCAST_HW_DECODE || 'auto').toLowerCase();
    // auto | vaapi | off

    function looksLikeNvidiaDisplay(): boolean {
        // Cheap heuristic: if NVIDIA kernel driver is present, treat as NVIDIA display box
        // (works for most of your fleet; hybrids can override via env)
        try {
            return fs.existsSync('/proc/driver/nvidia/version') ||
                fs.existsSync('/dev/nvidia0');
        } catch {
            return false;
        }
    }

    function hasVaapiPin(): boolean {
        return !!process.env.LIBVA_DRIVER_NAME || !!process.env.LIBVA_DRM_DEVICE;
    }

    // VAAPI decision
    if (hwDecodeMode === 'vaapi') {
        enableFeatures.add('VaapiVideoDecoder'); // DO NOT add IgnoreDriverChecks
    } else if (hwDecodeMode === 'off') {
        disableFeatures.add('VaapiVideoDecoder');
        disableFeatures.add('VaapiIgnoreDriverChecks');
    } else {
        // auto:
        // - if NVIDIA display, don't force VAAPI (prevents your 200% CPU thrash)
        // - if user pinned VAAPI to a render node, allow it
        if (!looksLikeNvidiaDisplay() || hasVaapiPin()) {
            enableFeatures.add('VaapiVideoDecoder');
        }
    }

    // Apply switches ONCE
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');

    app.commandLine.appendSwitch('enable-features', [...enableFeatures].join(','));
    if (disableFeatures.size) {
        app.commandLine.appendSwitch('disable-features', [...disableFeatures].join(','));
    }

    // GL backend: portable choice
    app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
    app.commandLine.appendSwitch('ozone-platform', 'x11'); // belt + suspenders

    // ---- GL backend: vendor-aware ----
    const forceGL = process.env.ZCAST_FORCE_USE_GL;
    const forceANGLE = process.env.ZCAST_FORCE_USE_ANGLE;
    const cliHasUseGl = process.argv.some(a => a.startsWith('--use-gl='));
    const cliHasUseAngle = process.argv.some(a => a.startsWith('--use-angle='));
    if (forceGL && !cliHasUseGl) {
        app.commandLine.appendSwitch('use-gl', forceGL);
    }
    if (forceANGLE && !cliHasUseAngle) {
        app.commandLine.appendSwitch('use-angle', forceANGLE);
    }
}