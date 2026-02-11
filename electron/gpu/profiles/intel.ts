import type { App } from "electron";
import fs from "fs";

export function applyGpuProfile(app: App) {
    const enableFeatures = new Set<string>([
        'CanvasOopRasterization',
    ]);

    const disableFeatures = new Set<string>();

    const hwDecodeMode = (process.env.ZCAST_HW_DECODE || 'auto').toLowerCase();
    // auto | vaapi | off
    const isNvidiaDisplay = looksLikeNvidiaDisplay();
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
        enableFeatures.add('VaapiVideoDecoder');
    } else if (hwDecodeMode === 'off') {
        disableFeatures.add('VaapiVideoDecoder');
        disableFeatures.add('VaapiIgnoreDriverChecks');
    } else {
        // auto:
        // - if NVIDIA display, don't force VAAPI (prevents your 200% CPU thrash)
        // - if user pinned VAAPI to a render node, allow it
        if (!isNvidiaDisplay || hasVaapiPin()) {
            enableFeatures.add('VaapiVideoDecoder');
        }
    }

    // Extra: only Nvidia gets the aggressive ZeroCopy feature
    if (isNvidiaDisplay) {
        enableFeatures.add('VideoDecodeLinuxZeroCopyGL');
    }


    // Apply switches ONCE
    if (isNvidiaDisplay) {
        // These were tuned for the Nvidia signage boxes
        app.commandLine.appendSwitch('ignore-gpu-blocklist');
        app.commandLine.appendSwitch('enable-gpu-rasterization');
        app.commandLine.appendSwitch('enable-zero-copy');
    } else {
        console.log('[zcast][gpu] non-Nvidia: using conservative defaults (no explicit zero-copy/raster switches).');
    }

    app.commandLine.appendSwitch('enable-features', [...enableFeatures].join(','));
    if (disableFeatures.size) {
        app.commandLine.appendSwitch('disable-features', [...disableFeatures].join(','));
    }


    // GL backend: portable choice
    app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
    app.commandLine.appendSwitch('ozone-platform', 'x11'); // belt + suspenders

    // ---- GL backend: vendor-aware ----
    const forceGL = (process.env.ZCAST_FORCE_USE_GL || '').trim();
    const forceANGLE = (process.env.ZCAST_FORCE_USE_ANGLE || '').trim();
    const cliHasUseGl = process.argv.some(a => a.startsWith('--use-gl='));
    const cliHasUseAngle = process.argv.some(a => a.startsWith('--use-angle='));

    if (isNvidiaDisplay) {
        // Old behavior for Nvidia boxes: ANGLE + EGL
        let useGl = forceGL || 'egl-angle';
        let useAngle = forceANGLE || 'default';

        if (!cliHasUseGl) {
            console.log('[zcast][gpu] NVIDIA: use-gl =', useGl);
            app.commandLine.appendSwitch('use-gl', useGl);
        }
        if (!cliHasUseAngle) {
            console.log('[zcast][gpu] NVIDIA: use-angle =', useAngle);
            app.commandLine.appendSwitch('use-angle', useAngle);
        }
    } else {
        // Intel / anything else: DO NOT force ANGLE; let Electron pick what works.
        if (!cliHasUseGl && forceGL) {
            console.log('[zcast][gpu] non-NVIDIA: honoring forced use-gl =', forceGL);
            app.commandLine.appendSwitch('use-gl', forceGL);
        }
        if (!cliHasUseAngle && forceANGLE) {
            console.log('[zcast][gpu] non-NVIDIA: honoring forced use-angle =', forceANGLE);
            app.commandLine.appendSwitch('use-angle', forceANGLE);
        }
        console.log('[zcast][gpu] non-NVIDIA: using default GL backend (no ANGLE override).');
    }
}