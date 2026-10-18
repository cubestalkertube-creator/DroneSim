// Menu navigation without a mouse (DESIGN.md principle 5): arrows / Enter / Esc on the keyboard, D-pad / A / B
// (or the left stick) on a gamepad, the sticks of an RC transmitter (pitch = up / down, roll right = select,
// roll left / yaw left = back; on a slider roll changes the value). Focus moves through the focusable elements of
// the visible menu in DOM order.
import { axisValue, calState } from '../../input/calibration';
import { activePad, padProfile } from '../../input/input';
import { back, ui } from './store';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** The menu layer that currently takes input (null while flying). */
function layer(): HTMLElement | null {
  const app = document.getElementById('app');
  if (!app) return null;
  const modal = app.querySelector<HTMLElement>('.modal');
  if (modal) return modal;
  return app.querySelector<HTMLElement>('.scr, .ov');
}

export function moveFocus(dir: 1 | -1) {
  const root = layer();
  if (!root) return;
  const els = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => e.offsetParent !== null);
  if (!els.length) return;
  const i = els.indexOf(document.activeElement as HTMLElement);
  const next = els[i < 0 ? (dir > 0 ? 0 : els.length - 1) : (i + dir + els.length) % els.length];
  next.focus();
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function activate() {
  const a = document.activeElement as HTMLElement | null;
  if (a && layer()?.contains(a)) a.click(); else moveFocus(1);
}

/** Esc / B: close a modal, leave a sub-page; in the pause main page the flight's own Esc (resume) handles it. */
function goBack(): boolean {
  const app = document.getElementById('app');
  const close = app?.querySelector<HTMLElement>('.modal [data-close]');
  if (close) { close.click(); return true; }
  if (ui.screen.value === 'flight') {
    if (ui.flight.value.page === 'menu') return false;
    back(); return true;
  }
  if (ui.screen.value === 'main') return false;
  back(); return true;
}

const textTarget = (t: EventTarget | null) => {
  const e = t as HTMLElement | null;
  return !!e && (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && (e as HTMLInputElement).type !== 'range' && (e as HTMLInputElement).type !== 'checkbox'));
};

export function installMenuNav() {
  // capture phase on document: runs before the flight's InputManager (window, bubble phase)
  document.addEventListener('keydown', (e) => {
    if (!layer()) return;
    const range = (e.target as HTMLInputElement | null)?.type === 'range';
    if (textTarget(e.target)) { if (e.code === 'Escape') (e.target as HTMLElement).blur(); e.stopPropagation(); return; }
    switch (e.code) {
      case 'ArrowDown': moveFocus(1); break;
      case 'ArrowUp': moveFocus(-1); break;
      case 'ArrowRight': case 'ArrowLeft': if (range) { e.stopPropagation(); return; } moveFocus(e.code === 'ArrowRight' ? 1 : -1); break;
      case 'Escape': case 'Backspace': if (!goBack()) return; break;
      default: return;
    }
    e.preventDefault(); e.stopPropagation();
  }, true);

  // gamepad: D-pad 12..15, A 0, B 1, left stick with auto-repeat
  const prev: boolean[] = [];
  let repeatAt = 0;
  const rc = { y: 0, x: 0, back: false, at: 0 };
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (!layer() || calState.active) return;
    const pad = Array.from(navigator.getGamepads?.() ?? []).find((p) => p && p.connected && p.mapping === 'standard');
    if (!pad) { rcNav(now); return; }
    const b = (i: number) => !!pad.buttons[i]?.pressed;
    const edge = (i: number) => { const p = b(i), r = p && !prev[i]; prev[i] = p; return r; };
    if (edge(12) || edge(14)) moveFocus(-1);
    if (edge(13) || edge(15)) moveFocus(1);
    if (edge(0)) activate();
    if (edge(1)) goBack();
    const y = pad.axes[1] ?? 0;
    if (Math.abs(y) > 0.6) { if (now > repeatAt) { moveFocus(y > 0 ? 1 : -1); repeatAt = now + 220; } } else repeatAt = 0;
  };
  /** transmitter sticks (calibrated or built-in profile): edges with auto-repeat, like the gamepad stick */
  const rcNav = (now: number) => {
    const pad = activePad();
    const prof = pad && padProfile(pad);
    if (!pad || !prof) return;
    const v = (k: 'pitch' | 'roll' | 'yaw') => axisValue(pad.axes[prof.axes[k].index] ?? 0, prof.axes[k], false);
    const dir = (x: number, prevDir: number) => (Math.abs(x) > 0.6 ? Math.sign(x) : Math.abs(x) < 0.3 ? 0 : prevDir);
    const y = dir(v('pitch'), rc.y), x = dir(v('roll'), rc.x), yawBack = v('yaw') < -0.6;
    const range = (document.activeElement as HTMLInputElement | null)?.type === 'range' ? document.activeElement as HTMLInputElement : null;
    const repeat = (d: number, prevD: number) => d !== 0 && (d !== prevD ? (rc.at = now + 380, true) : now > rc.at && (rc.at = now + 160, true));
    if (repeat(y, rc.y)) moveFocus(y > 0 ? -1 : 1); // stick forward = up the list
    if (range) {
      if (repeat(x, rc.x)) {
        range.value = String(+range.value + x * (+range.step || 1));
        range.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (x !== rc.x && x > 0) activate();
    else if (x !== rc.x && x < 0) goBack();
    if (yawBack && !rc.back) goBack();
    rc.y = y; rc.x = x; rc.back = yawBack;
  };
  requestAnimationFrame(loop);
}
