// native.js — thin bridge to Capacitor's native features.
//
// The app stays framework/bundler-free: instead of importing Capacitor npm
// packages (which would need a bundler), we talk to the native layer through
// the `window.Capacitor` global that the native shell injects. On the plain
// web (no native shell) every call here is a safe no-op, so the same code runs
// in a browser, on the phone, and mirrored to a TV.

/** Are we running inside the native iOS/Android shell (vs a plain browser)? */
export function isNative() {
  const C = window.Capacitor;
  return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
}

/** 'ios' | 'android' | 'web' */
export function getPlatform() {
  return window.Capacitor?.getPlatform?.() ?? 'web';
}

/**
 * Go edge-to-edge and hide the status bar so a mirrored/AirPlayed screen shows
 * only the visuals — no clock, battery, or notch chrome. No-op on the web.
 */
export async function enterImmersive() {
  const StatusBar = window.Capacitor?.Plugins?.StatusBar;
  if (!StatusBar) return;
  try {
    await StatusBar.setOverlaysWebView?.({ overlay: true });
    await StatusBar.hide?.();
  } catch (_) {
    // Non-fatal: the visuals run regardless of the status bar.
  }
}
