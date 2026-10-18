// Touch controls (PLAN.md 5.4): two virtual sticks (multitouch Pointer Events), ARM swipe slider, buttons,
// haptics, and a drag-and-drop layout editor. Left stick: throttle (no spring for FPV) / yaw; right: pitch / roll.
import type { Sticks } from '../sim/fc/betaflight';
import { haptic, setHaptics } from '../platform/platform';
import type { Action } from './input';

export interface TouchLayout {
  /** stick centres as fractions of the viewport */
  left: { x: number; y: number }; right: { x: number; y: number };
  /** stick radius as a fraction of min(viewport width, height) */
  size: number;
  opacity: number;
  /** cubic expo on roll/pitch/yaw (fingers are less precise than gimbals) */
  expo: number;
  /** the stick base appears where the finger lands */
  floating: boolean;
  haptics: boolean;
}

export const DEFAULT_LAYOUT: TouchLayout = {
  left: { x: 0.16, y: 0.68 }, right: { x: 0.84, y: 0.68 }, size: 0.2, opacity: 0.55, expo: 0.25, floating: false, haptics: true,
};
const KEY = 'ds.touchLayout';
const DEAD_ZONE = 0.04;

/** Finger offset (px) -> stick value -1..1 with a centre dead zone. */
export function stickFromOffset(offset: number, radius: number, dz = DEAD_ZONE): number {
  const v = Math.max(-1, Math.min(1, offset / radius));
  const a = Math.abs(v);
  return a < dz ? 0 : (Math.sign(v) * (a - dz)) / (1 - dz);
}
const expo = (v: number, e: number) => v * (1 - e) + v * v * v * e;

function loadLayout(): TouchLayout {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s) return { ...DEFAULT_LAYOUT, ...s, left: { ...DEFAULT_LAYOUT.left, ...s.left }, right: { ...DEFAULT_LAYOUT.right, ...s.right } };
  } catch { /* corrupted / blocked storage */ }
  return structuredClone(DEFAULT_LAYOUT);
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = '') => {
  const e = document.createElement(tag); e.className = cls; if (html) e.innerHTML = html; return e;
};

class VirtualStick {
  readonly base = h('div', 'tstick');
  readonly knob = h('div', 'tknob');
  pointer = -1;
  /** current centre in px */
  cx = 0; cy = 0; r = 60;
  /** knob offset in px (y up positive) */
  kx = 0; ky = 0;
  // throttle drag is relative: no jump when the finger lands somewhere else than the knob
  private y0 = 0; private thr0 = 0;
  private lastSign = [0, 0];

  constructor(parent: HTMLElement, readonly isThrottle: boolean) {
    if (isThrottle) this.ky = -this.r; // throttle starts at zero (bottom)
    this.base.append(h('i', 'tcross'), this.knob);
    parent.append(this.base);
  }

  place(cx: number, cy: number, r: number) {
    this.kx *= r / this.r; this.ky *= r / this.r; // keep the stick value when the size changes
    this.cx = cx; this.cy = cy; this.r = r;
    Object.assign(this.base.style, { left: `${cx - r}px`, top: `${cy - r}px`, width: `${2 * r}px`, height: `${2 * r}px` });
    this.draw();
  }

  draw() {
    const kr = this.r * 0.36;
    Object.assign(this.knob.style, { width: `${2 * kr}px`, height: `${2 * kr}px`, transform: `translate(${this.r - kr + this.kx}px, ${this.r - kr - this.ky}px)` });
  }

  down(e: PointerEvent, floating: boolean, throttle: number) {
    this.pointer = e.pointerId;
    if (floating) {
      // throttle: put the base so the knob (current throttle) sits under the finger
      const ky = this.isThrottle ? (throttle * 2 - 1) * this.r : 0;
      this.place(e.clientX, e.clientY + ky, this.r);
    }
    this.y0 = e.clientY; this.thr0 = throttle;
    this.move(e);
    this.base.classList.add('on');
  }

  move(e: PointerEvent): void {
    this.kx = Math.max(-this.r, Math.min(this.r, e.clientX - this.cx));
    if (this.isThrottle) {
      const t = Math.max(0, Math.min(1, this.thr0 + (this.y0 - e.clientY) / (2 * this.r)));
      this.ky = (t * 2 - 1) * this.r;
    } else this.ky = Math.max(-this.r, Math.min(this.r, this.cy - e.clientY));
    this.draw();
  }

  up(springY: boolean) {
    this.pointer = -1; this.kx = 0; if (springY) this.ky = 0;
    this.base.classList.remove('on');
    this.draw();
  }

  get x() { return stickFromOffset(this.kx, this.r); }
  get y() { return this.isThrottle ? (this.ky / this.r + 1) / 2 : stickFromOffset(this.ky, this.r); }

  /** haptic tick when an axis crosses the centre / the throttle hits an end stop */
  feel(values: [number, number]) {
    for (let a = 0; a < 2; a++) {
      const v = values[a], thr = this.isThrottle && a === 1;
      const s = thr ? (v <= 0.001 ? -1 : v >= 0.999 ? 1 : 0) : Math.sign(v);
      const p = this.lastSign[a];
      this.lastSign[a] = s;
      if (this.pointer < 0 || s === p) continue;
      if (thr ? s !== 0 : s === 0 || s * p < 0) haptic('tick');
    }
  }
}

export class TouchControls {
  readonly root = h('div', 'touch');
  layout = loadLayout();
  enabled = true;
  /** FPV throttle stays where the finger leaves it; GPS drones centre (altitude hold) */
  throttleSpring = false;
  editing = false;
  private left: VirtualStick; private right: VirtualStick;
  private zoneL = h('div', 'tzone l'); private zoneR = h('div', 'tzone r');
  private arm = h('div', 'tarm', '<i></i><span>СВАЙП — ARM</span>');
  private armKnob: HTMLElement;
  private modeBtn = h('button', 'tbtn tr1', 'ANGLE');
  private editor = h('div', 'tedit hidden');
  private armed = false;
  private onAction: (a: Action) => void;
  private aux!: HTMLButtonElement;
  private auxAction: Action = 'turtle';
  private gimbal: HTMLButtonElement[] = [];
  private det!: HTMLButtonElement;

  constructor(parent: HTMLElement, onAction: (a: Action) => void) {
    this.onAction = onAction;
    const r = this.root;
    r.append(this.zoneL, this.zoneR);
    this.left = new VirtualStick(r, true);
    this.right = new VirtualStick(r, false);
    const btn = (cls: string, html: string, a: Action) => {
      const b = h('button', `tbtn ${cls}`, html);
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); haptic('light'); onAction(b === this.aux ? this.auxAction : a); });
      r.append(b); return b;
    };
    btn('tl1 icon', '☰', 'pause');
    btn('tl2', '⟲ Рестарт', 'reset');
    this.aux = btn('tl3', 'Turtle', 'turtle');
    btn('tr2', '◉ Камера', 'camera');
    this.gimbal = [btn('tr3 icon', '▲', 'uptilt_up'), btn('tr4 icon', '▼', 'uptilt_down')];
    this.gimbal.forEach((b) => b.classList.add('hidden'));
    this.det = btn('tdet hidden', '<b>✸</b> ПОДРЫВ', 'detonate');
    this.modeBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); haptic('light'); onAction('mode_next'); });
    r.append(this.modeBtn, this.arm, this.editor);
    this.armKnob = this.arm.querySelector('i')!;
    this.setupArm();
    this.setupZones();
    this.setupEditor();
    parent.append(r);
    addEventListener('resize', () => this.relayout());
    this.relayout();
    setHaptics(this.layout.haptics);
  }

  setVisible(v: boolean) { this.root.classList.toggle('hidden', !v); }
  /** GPS drones: spring throttle, RTH instead of Turtle, gimbal tilt buttons; kamikaze: the detonate button */
  configure(gps: boolean, gimbal: boolean, warhead = false) {
    this.det.classList.toggle('hidden', !warhead);
    this.throttleSpring = gps;
    this.auxAction = gps ? 'rth' : 'turtle';
    this.aux.textContent = gps ? '⌂ RTH' : 'Turtle';
    this.gimbal.forEach((b) => b.classList.toggle('hidden', !gimbal));
    this.setThrottle(gps ? 0.5 : 0);
  }
  setMode(label: string) { if (this.modeBtn.textContent !== label) this.modeBtn.textContent = label; }
  setArmed(a: boolean) {
    if (a === this.armed) return;
    this.armed = a;
    this.arm.classList.toggle('armed', a);
    this.arm.querySelector('span')!.textContent = a ? 'ARMED · ТАП — ДИЗАРМ' : 'СВАЙП — ARM';
    this.armKnob.style.transform = '';
  }

  private relayout() {
    const W = innerWidth, H = innerHeight, L = this.layout;
    const R = Math.round(Math.min(W, H) * L.size);
    this.left.place(L.left.x * W, L.left.y * H, R);
    this.right.place(L.right.x * W, L.right.y * H, R);
    this.root.style.setProperty('--tops', String(L.opacity));
  }

  /** Write stick values into the control frame. */
  apply(s: Sticks) {
    const L = this.layout;
    const lx = this.left.x, ly = this.left.y, rx = this.right.x, ry = this.right.y;
    s.throttle = ly; // GPS drones: the stick springs back to 0.5 = hold altitude
    s.yaw = expo(lx, L.expo);
    s.roll = expo(rx, L.expo);
    s.pitch = expo(ry, L.expo);
    if (L.haptics) { this.left.feel([lx, ly]); this.right.feel([rx, ry]); }
  }

  /** e.g. after a restart the throttle goes back to zero */
  setThrottle(t: number) {
    if (this.left.pointer >= 0) return;
    this.left.ky = (t * 2 - 1) * this.left.r; this.left.draw();
  }

  private setupZones() {
    for (const [zone, st] of [[this.zoneL, this.left], [this.zoneR, this.right]] as const) {
      zone.addEventListener('pointerdown', (e) => {
        if (this.editing || st.pointer >= 0) return;
        zone.setPointerCapture(e.pointerId);
        st.down(e, this.layout.floating, st.y);
      });
      zone.addEventListener('pointermove', (e) => { if (e.pointerId === st.pointer) st.move(e); });
      const end = (e: PointerEvent) => {
        if (e.pointerId !== st.pointer) return;
        st.up(!st.isThrottle || this.throttleSpring);
        if (this.layout.floating) this.relayout();
      };
      zone.addEventListener('pointerup', end);
      zone.addEventListener('pointercancel', end);
    }
  }

  /** ARM: drag the knob to the right end (no accidental arming); when armed a tap disarms instantly. */
  private setupArm() {
    let id = -1, x0 = 0, travel = 1;
    this.arm.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (this.editing) return;
      if (this.armed) { haptic('medium'); this.onAction('arm'); return; }
      id = e.pointerId; x0 = e.clientX;
      travel = this.arm.clientWidth - this.armKnob.offsetWidth - 8;
      this.arm.setPointerCapture(id);
    });
    this.arm.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const d = Math.max(0, Math.min(travel, e.clientX - x0));
      this.armKnob.style.transform = `translateX(${d}px)`;
      if (d >= travel * 0.92) { id = -1; haptic('heavy'); this.onAction('arm'); this.armKnob.style.transform = ''; }
    });
    const end = (e: PointerEvent) => { if (e.pointerId === id) { id = -1; this.armKnob.style.transform = ''; } };
    this.arm.addEventListener('pointerup', end);
    this.arm.addEventListener('pointercancel', end);
  }

  // ---- layout editor: drag the stick bases, sliders for size / opacity / expo, toggles -------------
  private setupEditor() {
    const ed = this.editor;
    ed.innerHTML = `<div class="tedit-card">
      <b>Раскладка стиков</b><span class="dim">Перетащите стики пальцем</span>
      <label>Размер <input type="range" name="size" min="0.12" max="0.3" step="0.01"></label>
      <label>Прозрачность <input type="range" name="opacity" min="0.15" max="1" step="0.05"></label>
      <label>Экспо <input type="range" name="expo" min="0" max="0.7" step="0.05"></label>
      <label class="chk"><input type="checkbox" name="floating"> Плавающий центр</label>
      <label class="chk"><input type="checkbox" name="haptics"> Вибро-отклик</label>
      <div class="row"><button class="btn ghost" data-a="reset">Сброс</button><button class="btn" data-a="done">Готово</button></div></div>`;
    const inputs = ed.querySelectorAll('input');
    inputs.forEach((inp) => inp.addEventListener('input', () => {
      const L = this.layout as unknown as Record<string, number | boolean>;
      L[inp.name] = inp.type === 'checkbox' ? inp.checked : +inp.value;
      setHaptics(this.layout.haptics);
      this.relayout();
    }));
    ed.querySelector('[data-a=reset]')!.addEventListener('click', () => { this.layout = structuredClone(DEFAULT_LAYOUT); this.syncEditor(); this.relayout(); });
    ed.querySelector('[data-a=done]')!.addEventListener('click', () => this.edit(false));
    // drag bases while editing
    for (const [st, side] of [[this.left, 'left'], [this.right, 'right']] as const) {
      let id = -1, dx = 0, dy = 0;
      st.base.addEventListener('pointerdown', (e) => {
        if (!this.editing) return;
        id = e.pointerId; dx = e.clientX - st.cx; dy = e.clientY - st.cy;
        st.base.setPointerCapture(id);
      });
      st.base.addEventListener('pointermove', (e) => {
        if (e.pointerId !== id) return;
        const p = this.layout[side];
        p.x = Math.max(0.05, Math.min(0.95, (e.clientX - dx) / innerWidth));
        p.y = Math.max(0.2, Math.min(0.95, (e.clientY - dy) / innerHeight));
        this.relayout();
      });
      st.base.addEventListener('pointerup', () => { id = -1; });
    }
  }

  private syncEditor() {
    this.editor.querySelectorAll('input').forEach((inp) => {
      const v = (this.layout as unknown as Record<string, number | boolean>)[inp.name];
      if (inp.type === 'checkbox') inp.checked = !!v; else inp.value = String(v);
    });
  }

  onEditDone?: () => void;

  edit(on: boolean) {
    this.editing = on;
    this.root.classList.toggle('editing', on);
    this.editor.classList.toggle('hidden', !on);
    if (on) this.syncEditor();
    else {
      try { localStorage.setItem(KEY, JSON.stringify(this.layout)); } catch { /* ignore */ }
      this.onEditDone?.();
    }
  }
}
