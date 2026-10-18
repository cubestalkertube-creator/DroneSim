// Platform bridge (PLAN.md 3 `platform/`): touch/native detection, haptics, keep-awake, fullscreen + landscape.
// Capacitor plugins are used when running inside the Android/iOS shell; the web build falls back to browser APIs.
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { App } from '@capacitor/app';

export const isNative = Capacitor.isNativePlatform();
/** touch-first device (phone/tablet): virtual sticks by default, Low quality profile */
const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;
export const isTouch = isNative || mq('(pointer: coarse)') || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 && !mq('(pointer: fine)'));

export type HapticKind = 'tick' | 'light' | 'medium' | 'heavy';
const VIBRATE_MS: Record<HapticKind, number> = { tick: 8, light: 15, medium: 30, heavy: 70 };
const IMPACT: Record<HapticKind, ImpactStyle> = { tick: ImpactStyle.Light, light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy };

let hapticsOn = true;
export function setHaptics(on: boolean) { hapticsOn = on; }

export function haptic(kind: HapticKind) {
  if (!hapticsOn) return;
  if (isNative) {
    (kind === 'tick' ? Haptics.selectionChanged() : Haptics.impact({ style: IMPACT[kind] })).catch(() => {});
  } else navigator.vibrate?.(VIBRATE_MS[kind]);
}

let wakeLock: { release(): Promise<void> } | null = null;
/** Keep the screen on while flying (Screen Wake Lock API: Chrome/Android WebView 84+, Safari 16.4+). */
export async function keepAwake(on: boolean) {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
  try {
    if (on && !wakeLock && wl) wakeLock = await wl.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not allowed (no user gesture / hidden tab) */ }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wakeLock) { wakeLock = null; void keepAwake(true); } });

/** Mobile web: go fullscreen and lock landscape on the first "take off" tap (the native shell is landscape already). */
export async function enterImmersive() {
  if (isNative || !isTouch) return;
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    await (screen.orientation as ScreenOrientation & { lock?(o: string): Promise<void> }).lock?.('landscape');
  } catch { /* iOS Safari: no fullscreen API for documents */ }
}

/** Android back button (native shell) -> `onBack`; app sent to background / tab hidden -> `onHide`. */
export function lifecycle(onBack: () => void, onHide: () => void) {
  if (isNative) {
    void App.addListener('backButton', onBack);
    void App.addListener('appStateChange', (st) => { if (!st.isActive) onHide(); });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onHide(); });
}
