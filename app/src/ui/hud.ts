// Betaflight-style OSD + toasts + centre messages. Menus and the start / pause overlays: ui/app (Preact).
import './style.css';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e;
};

export interface HudData {
  armed: boolean; mode: string; throttle: number; alt: number; speedKmh: number; flightTime: number;
  camera: string; device: string; fps: number; simHz: number; fpv: boolean;
  /** gate race: next gate, lap timer, last / best lap (NaN last = lap not counted); split delta to the best lap
   *  (shown for a few seconds after a gate, + = slower), missed gates and penalty of the current lap */
  lap?: { next: number; total: number; current: number; last: number; best: number; delta?: number | null; missed?: number; penalty?: number } | null;
  warn?: string;
  /** GPS drones: distance home / horizontal / vertical speed line */
  nav?: string;
  /** pack: bus voltage (OSD-filtered), per cell, current, drawn mAh, warnings; state of charge 0..1 and the
   *  time left at the recent average draw (s, null while it cannot be estimated) */
  bat?: { volts: number; cell: number; amps: number; mah: number; low: boolean; cutoff: boolean; soc: number; remainS: number | null } | null;
  /** piston engine: fuel left / tank (l), time left at the recent burn rate (s) */
  fuel?: { l: number; max: number; remainS: number | null } | null;
  /** kamikaze charge: live (motors armed) or safe; the key / button that sets it off */
  charge?: { live: boolean; key: string } | null;
}

const SEGS = 10;
/** time left as m:ss or h:mm:ss */
const fmtLeft = (s: number | null) => {
  if (s == null || !isFinite(s)) return '--:--';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};

/** Battery / fuel gauge: segmented cell (battery) or tank (fuel) that drains, glows and turns amber / red. */
class EnergyGauge {
  readonly root = el('div', 'energy');
  private segs: HTMLElement[] = [];
  private pct: HTMLElement; private sub: HTMLElement; private meta: HTMLElement; private icon: HTMLElement;
  private kind: 'bat' | 'fuel' | '' = '';
  constructor() {
    this.root.innerHTML = `<div class="eicon"></div><div class="ebody"><div class="egauge"><div class="esegs"></div><div class="enub"></div></div>
      <div class="einfo"><span class="epct"></span><span class="esub"></span></div><div class="emeta"></div></div>`;
    const segs = this.root.querySelector('.esegs')!;
    for (let i = 0; i < SEGS; i++) { const s = el('i'); segs.append(s); this.segs.push(s); }
    this.pct = this.root.querySelector('.epct')!; this.sub = this.root.querySelector('.esub')!;
    this.meta = this.root.querySelector('.emeta')!; this.icon = this.root.querySelector('.eicon')!;
  }
  set(kind: 'bat' | 'fuel', level: number, sub: string, meta: string, warn: boolean, bad: boolean) {
    if (kind !== this.kind) {
      this.kind = kind;
      this.root.classList.toggle('fuel', kind === 'fuel');
      this.icon.innerHTML = kind === 'bat'
        ? '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7h1a2 2 0 0 1 2 2v3a1 1 0 0 0 2 0V9l-3-3 1.4-1.4L22 8.2V17a3 3 0 0 1-6 0v-3h-1v7zm3-15v5h6V6z" fill="currentColor"/></svg>';
    }
    const lv = Math.max(0, Math.min(1, level)), x = lv * SEGS;
    for (let i = 0; i < SEGS; i++) {
      const f = Math.max(0, Math.min(1, x - i));
      const s = this.segs[i];
      s.style.opacity = f > 0 ? String(0.25 + 0.75 * f) : '';
      s.classList.toggle('on', f > 0);
    }
    this.root.classList.toggle('warn', warn && !bad);
    this.root.classList.toggle('bad', bad);
    this.pct.textContent = `${Math.round(lv * 100)}%`;
    this.sub.textContent = sub;
    this.meta.textContent = meta;
  }
}

const fmtD = (d: number) => `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`;

const fmtT = (t: number) => {
  if (!isFinite(t) || t <= 0) return '--:--.--';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

export class Hud {
  private osd = el('div', 'osd');
  private tl = el('div', 'p tl'); private tr = el('div', 'p tr'); private tc = el('div', 'p tc');
  private bl = el('div', 'p bl'); private br = el('div', 'p br'); private bc = el('div', 'p bc');
  private cross = el('div', 'cross', '<svg viewBox="0 0 44 44"><path d="M22 13v7M22 24v7M13 22h7M24 22h7" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg>');
  private msg = el('div', 'msg'); private toastEl = el('div', 'toast'); private dbg = el('div', 'debug hidden');
  private toastTimer = 0;
  private gauge = new EnergyGauge();
  private blRows = el('div');
  private tlRows = el('div');
  private chg = el('div', 'chg hidden');
  private noSig = el('div', 'nosig hidden', '<div class="nsnoise"></div><div class="nstext">NO SIGNAL<small>видеосигнал потерян</small></div>');

  constructor(root: HTMLElement) {
    this.bl.append(this.gauge.root, this.blRows);
    this.tl.append(this.tlRows, this.chg);
    this.osd.append(this.noSig, this.tl, this.tr, this.tc, this.bl, this.br, this.bc, this.cross, this.msg, this.toastEl, this.dbg);
    root.append(this.osd);
  }

  /** FPV feed lost (the drone blew up): static + NO SIGNAL; false hides it */
  noSignal(on: boolean) { this.noSig.classList.toggle('hidden', !on); }

  /** full-screen white-orange flash (the blast seen through any camera), 0..1 */
  flash(k: number) { this.osd.style.setProperty('--flash', k.toFixed(3)); }

  setVisible(on: boolean) { this.osd.classList.toggle('hidden', !on); }

  toast(text: string, ms = 1600) {
    this.toastEl.textContent = text;
    this.toastEl.style.opacity = '1';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.style.opacity = '0'), ms);
  }

  message(html: string) { this.msg.innerHTML = html; this.msg.style.opacity = html ? '1' : '0'; }

  /** transmitter sticks (Mode 2: left = throttle / yaw, right = pitch / roll); null hides them */
  sticks(s: { throttle: number; yaw: number; pitch: number; roll: number } | null, hl?: 'left' | 'right' | 'both') {
    if (!s) { if (this.stk) this.stk.root.style.display = 'none'; return; }
    if (!this.stk) {
      const root = el('div', 'sticks');
      const mk = (label: string) => { const g = el('div', 'gim', `<i></i><span>${label}</span>`); root.append(g); return g; };
      const l = mk('газ · рыскание'), r = mk('тангаж · крен');
      this.osd.append(root);
      this.stk = { root, l, r, ld: l.querySelector('i')!, rd: r.querySelector('i')! };
    }
    const k = this.stk;
    k.root.style.display = '';
    k.l.classList.toggle('hl', hl === 'left' || hl === 'both');
    k.r.classList.toggle('hl', hl === 'right' || hl === 'both');
    const put = (d: HTMLElement, x: number, y: number) => {
      d.style.left = `calc(${(50 + x * 42).toFixed(1)}% - 9px)`; d.style.top = `calc(${(50 - y * 42).toFixed(1)}% - 9px)`;
    };
    put(k.ld, s.yaw, s.throttle * 2 - 1);
    put(k.rd, s.roll, s.pitch);
  }
  private stk: { root: HTMLElement; l: HTMLElement; r: HTMLElement; ld: HTMLElement; rd: HTMLElement } | null = null;

  toggleDebug() { this.dbg.classList.toggle('hidden'); }
  get debugVisible() { return !this.dbg.classList.contains('hidden'); }
  debug(text: string) { if (this.debugVisible) this.dbg.textContent = text; }

  update(d: HudData) {
    const armed = d.armed ? '<span class="acc">ARMED</span>' : '<span class="warn">DISARMED</span>';
    const batWarn = d.bat?.cutoff ? '<div class="row bad blink">BATTERY CUTOFF</div>' : d.bat?.low ? '<div class="row warn blink">LOW BATTERY</div>' : '';
    this.tc.innerHTML = `<div class="row">${d.mode.toUpperCase()}</div><div class="row">${armed}</div>${batWarn}${d.warn ? `<div class="row warn">${d.warn}</div>` : ''}`;
    this.tlRows.innerHTML = `<div class="row">THR ${Math.round(d.throttle * 100).toString().padStart(3)}%</div>
      <div class="row dim">${d.device}</div>`;
    const c = d.charge;
    this.chg.classList.toggle('hidden', !c);
    if (c) {
      this.chg.classList.toggle('live', c.live);
      const html = `<b>✸</b> ЗАРЯД ${c.live ? 'ВЗВЕДЁН' : '· ПРЕДОХР.'}<small>${c.key} — подрыв</small>`;
      if (this.chg.innerHTML !== html) this.chg.innerHTML = html;
    }
    this.tr.innerHTML = `<div class="row">⏱ ${fmtT(d.flightTime).slice(0, 5)}</div><div class="row dim">${d.fps} FPS · ${d.simHz} Hz</div>`;
    const b = d.bat, fu = d.fuel;
    this.gauge.root.classList.toggle('hidden', !b && !fu);
    if (fu) {
      const lv = fu.max > 0 ? fu.l / fu.max : 0;
      this.gauge.set('fuel', lv, `${fu.l.toFixed(1)} / ${fu.max.toFixed(0)} L`, `осталось ≈ ${fmtLeft(fu.remainS)}`, lv < 0.25, lv < 0.1);
    } else if (b) {
      this.gauge.set('bat', b.soc, `${b.volts.toFixed(1)}V · ${b.cell.toFixed(2)}V/яч`,
        `${b.amps.toFixed(1)}A · ${Math.round(b.mah)}mAh · ≈ ${fmtLeft(b.remainS)}`, b.low || b.soc < 0.3, b.cutoff || b.soc < 0.12);
    }
    this.blRows.innerHTML = `<div class="row">⇡ ${d.alt.toFixed(1)} m</div>`;
    this.br.innerHTML = `<div class="row">${Math.round(d.speedKmh)} km/h</div>${d.nav ? `<div class="row">${d.nav}</div>` : ''}<div class="row dim">${d.camera}</div>`;
    const L = d.lap;
    this.bc.innerHTML = L
      ? `<div class="row">GATE ${L.next + 1}/${L.total} · ${fmtT(L.current)}${L.delta != null ? ` <span class="${L.delta <= 0 ? 'acc' : 'bad'}">${fmtD(L.delta)}</span>` : ''}</div>
         ${L.missed ? `<div class="row warn">MISSED ${L.missed}${L.penalty ? ` · +${L.penalty.toFixed(0)} s` : ' · DNF'}</div>` : ''}
         <div class="row dim">LAST ${Number.isNaN(L.last) ? 'DNF' : fmtT(L.last)} · BEST ${fmtT(L.best)}</div>` : '';
    this.cross.style.display = d.fpv ? '' : 'none';
  }
}
