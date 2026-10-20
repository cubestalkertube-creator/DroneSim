// Flight HUD: FPV OSD (white mono with a shadow, artificial horizon) + glass gauges - throttle, speed, altitude with
// a vario, energy, race panel, mini sticks - toasts and centre messages. Menus and the start / pause overlays:
// ui/app (Preact). Elements are built once and only their text / styles change per frame.
import './style.css';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e;
};

export interface HudData {
  armed: boolean; mode: string; throttle: number; alt: number; speedKmh: number; flightTime: number;
  camera: string; device: string; fps: number; simHz: number; fpv: boolean;
  /** vertical speed (m/s, + up) */
  vs?: number;
  /** FPV artificial horizon: screen roll of the horizon (deg, CSS clockwise) and its offset from the centre
   *  (fraction of the half height, + = below); null hides it */
  horizon?: { roll: number; off: number } | null;
  /** sticks for the mini display (Mode 2), null hides it */
  rc?: { throttle: number; yaw: number; pitch: number; roll: number } | null;
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

/** set text only when it changed (no layout work for the 99 % of frames where nothing did) */
const txt = (e: HTMLElement, t: string) => { if (e.textContent !== t) e.textContent = t; };
const cls = (e: HTMLElement, c: string, on: boolean) => { if (e.classList.contains(c) !== on) e.classList.toggle(c, on); };

/** Battery / fuel gauge: segmented cell (battery) or tank (fuel) that drains, glows and turns amber / red. */
class EnergyGauge {
  readonly root = el('div', 'energy glass');
  private segs: HTMLElement[] = [];
  private pct: HTMLElement; private sub: HTMLElement; private meta: HTMLElement; private icon: HTMLElement;
  private kind: 'bat' | 'fuel' | '' = '';
  private lastLv = -1;
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
    const lv = Math.max(0, Math.min(1, level));
    if (Math.abs(lv - this.lastLv) > 0.002) {
      this.lastLv = lv;
      const x = lv * SEGS;
      for (let i = 0; i < SEGS; i++) {
        const f = Math.max(0, Math.min(1, x - i));
        const s = this.segs[i];
        s.style.opacity = f > 0 ? String(0.25 + 0.75 * f) : '';
        s.classList.toggle('on', f > 0);
      }
    }
    cls(this.root, 'warn', warn && !bad);
    cls(this.root, 'bad', bad);
    txt(this.pct, `${Math.round(lv * 100)}%`);
    txt(this.sub, sub);
    txt(this.meta, meta);
  }
}

const fmtD = (d: number) => `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`;

const fmtT = (t: number) => {
  if (!isFinite(t) || t <= 0) return '--:--.--';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

/** mode chip colour: manual modes lime, self-levelling cyan, automation amber */
const modeTone = (m: string) => (/acro|manual|turtle/i.test(m) ? 'acro' : /rth|rtl|home|land|rescue|auto|mission|loiter/i.test(m) ? 'auto' : 'level');

export class Hud {
  private osd = el('div', 'osd');
  private tl = el('div', 'p tl'); private tr = el('div', 'p tr'); private tc = el('div', 'p tc');
  private bl = el('div', 'p bl'); private br = el('div', 'p br'); private bc = el('div', 'p bc');
  private lm = el('div', 'p lm'); private rm = el('div', 'p rm');
  private cross = el('div', 'cross', '<svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="2" fill="#fff"/><path d="M22 9v8M22 27v8M9 22h8M27 22h8" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>');
  private hz = el('div', 'hz', '<i class="hzl"></i><i class="hzr"></i>');
  private msg = el('div', 'msg'); private toastEl = el('div', 'toast'); private dbg = el('div', 'debug hidden');
  private toastTimer = 0;
  private gauge = new EnergyGauge();
  private chg = el('div', 'chg hidden');
  private noSig = el('div', 'nosig hidden', '<div class="nsnoise"></div><div class="nstext">NO SIGNAL<small>видеосигнал потерян</small></div>');
  // cached pieces
  private mode = el('span', 'mode'); private arm = el('span', 'arm', '<i></i><b></b>'); private dev = el('div', 'dev');
  private timer = el('div', 'timer glass', '<small>ПОЛЁТ</small><b></b>');
  private warns = el('div', 'warns');
  private cam = el('span', 'chip'); private perf = el('div', 'perf');
  private thr = el('div', 'thr', '<div class="bar"><i></i><span class="tick"></span></div><div class="lbl"><b></b><small>THR</small></div>');
  private spd = el('div', 'readout', '<b></b><small>KM/H</small>');
  private altE = el('div', 'readout', '<b></b><small>M · ALT</small>');
  private vario = el('div', 'vario', '<i></i><span></span>');
  private navE = el('div', 'nav glass hidden');
  private rcE = el('div', 'rc', '<div class="gim"><i></i></div><div class="gim"><i></i></div>');
  private lapE = el('div', 'lap glass hidden', '<div class="lrow"><span class="lg"></span><b class="lt"></b><span class="ld"></span></div><div class="lmiss"></div><div class="lsub"></div>');
  /** touch: one compact row instead of the side readouts (the sticks own the screen edges) */
  private compact = el('div', 'compact');
  private lastWarn = '';

  constructor(root: HTMLElement) {
    this.bl.append(this.gauge.root);
    const stat = el('div', 'hstat'); stat.append(this.mode, this.arm);
    this.tl.append(stat, this.dev, this.chg);
    this.tc.append(this.timer, this.warns);
    this.tr.append(this.cam, this.perf);
    this.lm.append(this.thr, this.spd);
    this.rm.append(this.altE, this.vario);
    this.br.append(this.navE, this.rcE, this.compact);
    this.bc.append(this.lapE);
    this.osd.append(this.noSig, this.hz, this.tl, this.tr, this.tc, this.lm, this.rm, this.bl, this.br, this.bc, this.cross, this.msg, this.toastEl, this.dbg);
    root.append(this.osd);
  }

  /** FPV feed lost (the drone blew up): static + NO SIGNAL; false hides it */
  noSignal(on: boolean) { this.noSig.classList.toggle('hidden', !on); }

  /** full-screen white-orange flash (the blast seen through any camera), 0..1 */
  flash(k: number) { this.osd.style.setProperty('--flash', k.toFixed(3)); }

  setVisible(on: boolean) { this.osd.classList.toggle('hidden', !on); }

  toast(text: string, ms = 1600) {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('show');
    void this.toastEl.offsetWidth; // restart the pop-in
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  message(html: string) { if (this.msg.innerHTML !== html) this.msg.innerHTML = html; this.msg.style.opacity = html ? '1' : '0'; }

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
    // --- status: mode, arm state, input device, charge
    txt(this.mode, d.mode.toUpperCase());
    const tone = modeTone(d.mode);
    if (this.mode.dataset.tone !== tone) this.mode.dataset.tone = tone;
    cls(this.arm, 'on', d.armed);
    txt(this.arm.lastElementChild as HTMLElement, d.armed ? 'ARMED' : 'DISARMED');
    txt(this.dev, d.device);
    const c = d.charge;
    cls(this.chg, 'hidden', !c);
    if (c) {
      cls(this.chg, 'live', c.live);
      const html = `<b>✸</b> ЗАРЯД ${c.live ? 'ВЗВЕДЁН' : '· ПРЕДОХР.'}<small>${c.key} — подрыв</small>`;
      if (this.chg.innerHTML !== html) this.chg.innerHTML = html;
    }

    // --- top centre: flight timer and warnings
    txt(this.timer.lastElementChild as HTMLElement, fmtT(d.flightTime).slice(0, 5));
    cls(this.timer, 'live', d.armed);
    const w = d.bat?.cutoff ? 'bad|BATTERY CUTOFF' : d.bat?.low ? 'warn|LOW BATTERY' : '';
    const warnKey = `${w}#${d.warn ?? ''}`;
    if (warnKey !== this.lastWarn) {
      this.lastWarn = warnKey;
      this.warns.innerHTML = (w ? `<div class="pill ${w.split('|')[0]} blink">${w.split('|')[1]}</div>` : '') + (d.warn ? `<div class="pill warn">${d.warn}</div>` : '');
    }

    // --- top right: camera, performance
    txt(this.cam, d.camera);
    txt(this.perf, `${d.fps} FPS · ${d.simHz} Hz`);

    // --- left: throttle bar + speed
    const t = Math.max(0, Math.min(1, d.throttle));
    (this.thr.querySelector('.bar i') as HTMLElement).style.transform = `scaleY(${t.toFixed(3)})`;
    txt(this.thr.querySelector('.lbl b') as HTMLElement, `${Math.round(t * 100)}`);
    cls(this.thr, 'hot', t > 0.85);
    txt(this.spd.firstElementChild as HTMLElement, `${Math.round(d.speedKmh)}`);

    // --- right: altitude + vario
    txt(this.altE.firstElementChild as HTMLElement, d.alt.toFixed(Math.abs(d.alt) < 100 ? 1 : 0));
    const vs = d.vs ?? 0;
    cls(this.vario, 'up', vs > 0.3); cls(this.vario, 'down', vs < -0.3);
    txt(this.vario.lastElementChild as HTMLElement, `${vs >= 0 ? '+' : '−'}${Math.abs(vs).toFixed(1)} m/s`);
    txt(this.compact, `⇡ ${d.alt.toFixed(1)} m · ${Math.round(d.speedKmh)} km/h`);

    // --- energy
    const b = d.bat, fu = d.fuel;
    cls(this.gauge.root, 'hidden', !b && !fu);
    if (fu) {
      const lv = fu.max > 0 ? fu.l / fu.max : 0;
      this.gauge.set('fuel', lv, `${fu.l.toFixed(1)} / ${fu.max.toFixed(0)} L`, `осталось ≈ ${fmtLeft(fu.remainS)}`, lv < 0.25, lv < 0.1);
    } else if (b) {
      this.gauge.set('bat', b.soc, `${b.volts.toFixed(1)}V · ${b.cell.toFixed(2)}V/яч`,
        `${b.amps.toFixed(1)}A · ${Math.round(b.mah)}mAh · ≈ ${fmtLeft(b.remainS)}`, b.low || b.soc < 0.3, b.cutoff || b.soc < 0.12);
    }

    // --- bottom right: GPS nav line, mini sticks
    cls(this.navE, 'hidden', !d.nav);
    if (d.nav) txt(this.navE, d.nav);
    cls(this.rcE, 'hidden', !d.rc);
    if (d.rc) {
      const [l, r] = this.rcE.querySelectorAll('i') as NodeListOf<HTMLElement>;
      const put = (e: HTMLElement, x: number, y: number) => { e.style.left = `${(50 + x * 40).toFixed(1)}%`; e.style.top = `${(50 - y * 40).toFixed(1)}%`; };
      put(l, d.rc.yaw, d.rc.throttle * 2 - 1);
      put(r, d.rc.roll, d.rc.pitch);
    }

    // --- race panel
    const L = d.lap;
    cls(this.lapE, 'hidden', !L);
    if (L) {
      const q = (s: string) => this.lapE.querySelector(s) as HTMLElement;
      txt(q('.lg'), `GATE ${L.next + 1}/${L.total}`);
      txt(q('.lt'), fmtT(L.current));
      const dl = q('.ld');
      txt(dl, L.delta != null ? fmtD(L.delta) : '');
      cls(dl, 'acc', L.delta != null && L.delta <= 0); cls(dl, 'bad', L.delta != null && L.delta > 0);
      txt(q('.lmiss'), L.missed ? `MISSED ${L.missed}${L.penalty ? ` · +${L.penalty.toFixed(0)} s` : ' · DNF'}` : '');
      txt(q('.lsub'), `LAST ${Number.isNaN(L.last) ? 'DNF' : fmtT(L.last)} · BEST ${fmtT(L.best)}`);
    }

    // --- FPV: crosshair, lens vignette and artificial horizon
    this.cross.style.display = d.fpv ? '' : 'none';
    cls(this.osd, 'fpv', d.fpv);
    const h = d.fpv ? d.horizon : null;
    if (h && Math.abs(h.off) < 0.95) {
      this.hz.style.display = '';
      this.hz.style.transform = `translate(-50%, -50%) rotate(${h.roll.toFixed(2)}deg) translateY(${(h.off * 50).toFixed(2)}vh)`;
    } else this.hz.style.display = 'none';
  }
}
