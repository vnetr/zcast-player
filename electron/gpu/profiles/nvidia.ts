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

    app.commandLine.appendSwitch('enable-features', [...enableFeatures].join(','));
    if (disableFeatures.size) {
        app.commandLine.appendSwitch('disable-features', [...disableFeatures].join(','));
    }

    // GL backend: portable choice
    app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
    app.commandLine.appendSwitch('ozone-platform', 'x11'); // belt + suspenders

    // ---- GL backend: vendor-aware ----
    // Inference from the crash logs: this host only exposed EGL+ANGLE as an
    // allowed implementation, so prefer that path by default on NVIDIA.
    const forceGL = (process.env.ZCAST_FORCE_USE_GL || process.env.ZCAST_NVIDIA_USE_GL || '').trim();
    const forceANGLE = (process.env.ZCAST_FORCE_USE_ANGLE || process.env.ZCAST_NVIDIA_USE_ANGLE || '').trim();
    const cliHasUseGl = process.argv.some(a => a.startsWith('--use-gl='));
    const cliHasUseAngle = process.argv.some(a => a.startsWith('--use-angle='));
    const useGl = forceGL || 'egl-angle';
    const useAngle = useGl === 'egl-angle'
        ? (forceANGLE || 'default')
        : forceANGLE;

    if (!cliHasUseGl && useGl) {
        console.log('[zcast][gpu] NVIDIA: use-gl =', useGl);
        app.commandLine.appendSwitch('use-gl', useGl);
    }
    if (!cliHasUseAngle && useAngle) {
        console.log('[zcast][gpu] NVIDIA: use-angle =', useAngle);
        app.commandLine.appendSwitch('use-angle', useAngle);
    }
}
