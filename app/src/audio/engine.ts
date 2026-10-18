// Audio engine (PLAN.md 10): rotor synthesis in an AudioWorklet, spatial sound + doppler for the external
// cameras, "goggles" mix for FPV, airspeed wind, crash impacts, arming / low-battery beeps, indoor reverb.
import workletUrl from './motor.worklet.ts?worker&url';
import { MAX_ROTORS, type SynthParams } from './motorSynth';

const SPEED_OF_SOUND = 343;
const PARAM_HZ = 60;
const KEY = 'ds.audio';

export interface AudioFrame {
  /** rotor speeds rad/s and thrust (N) per rotor */
  omega: ArrayLike<number>; thrust: ArrayLike<number>;
  /** model constants: max rotor speed (rad/s), static thrust coefficient */
  omegaMax: number; kT0: number;
  vrs: number; airspeed: number;
  /** drone and listener (camera) world state */
  pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number };
  cam: { x: number; y: number; z: number }; camFwd: { x: number; y: number; z: number }; camUp: { x: number; y: number; z: number };
  fpv: boolean;
  lowBattery: boolean;
}

/** Master volume 0..1 and mute, shared by the menus and the engine. */
export function loadSoundPrefs(): { volume: number; muted: boolean } {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s) return { volume: Number.isFinite(s.volume) ? s.volume : 0.8, muted: !!s.muted };
  } catch { /* blocked storage */ }
  return { volume: 0.8, muted: false };
}
export function saveSoundPrefs(volume: number, muted: boolean) {
  try { localStorage.setItem(KEY, JSON.stringify({ volume, muted })); } catch { /* ignore */ }
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  volume = 0.8;
  muted = false;
  private motor!: AudioWorkletNode;
  private master!: GainNode;
  private fpvGain!: GainNode; private extGain!: GainNode;
  private goggles!: BiquadFilterNode;
  private panner!: PannerNode;
  private wind!: GainNode; private windFilter!: BiquadFilterNode;
  private noiseBuf!: AudioBuffer;
  private params: Partial<SynthParams> = { rpm: new Float32Array(MAX_ROTORS), load: new Float32Array(MAX_ROTORS) };
  private sendT = 0; private beepT = 0;
  private prevCam = { x: 0, y: 0, z: 0 }; private camVel = { x: 0, y: 0, z: 0 };
  private ready: Promise<void> | null = null;

  constructor(private blades: number, private polePairs: number, private indoor: boolean) {
    const s = loadSoundPrefs();
    this.volume = s.volume; this.muted = s.muted;
  }

  /** Must be called from a user gesture (autoplay policy). Safe to call repeatedly. */
  start(): Promise<void> {
    this.ready ??= this.init().catch((e) => { console.warn('audio disabled:', e); });
    void this.ctx?.resume();
    return this.ready;
  }

  private async init() {
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
    await ctx.audioWorklet.addModule(workletUrl);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);

    this.motor = new AudioWorkletNode(ctx, 'motor-synth', { numberOfInputs: 0, outputChannelCount: [1] });
    // FPV: the pilot's "in goggles" mix — mono, slightly muffled, no doppler
    this.goggles = ctx.createBiquadFilter(); this.goggles.type = 'lowpass'; this.goggles.frequency.value = 7000; this.goggles.Q.value = 0.5;
    this.fpvGain = ctx.createGain(); this.fpvGain.gain.value = 0.55;
    this.motor.connect(this.goggles).connect(this.fpvGain).connect(this.master);
    // external cameras: HRTF panner at the drone, inverse distance law
    this.panner = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1.5, rolloffFactor: 1.1, maxDistance: 2000 });
    this.extGain = ctx.createGain(); this.extGain.gain.value = 0;
    this.motor.connect(this.panner).connect(this.extGain).connect(this.master);

    // wind / air rush: looped noise through a band-pass that opens with airspeed
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 6; } // reddish noise
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type = 'bandpass'; this.windFilter.Q.value = 0.6;
    this.wind = ctx.createGain(); this.wind.gain.value = 0;
    src.connect(this.windFilter).connect(this.wind).connect(this.master);
    src.start();

    if (this.indoor) this.makeReverb(ctx, 1.6, 0.28);
    this.params.blades = this.blades; this.params.polePairs = this.polePairs;
    this.motor.port.postMessage(this.params);
  }

  /** Synthetic room impulse response (decaying stereo noise), fed from the motor bus. */
  private makeReverb(ctx: AudioContext, seconds: number, wet: number): GainNode {
    const n = Math.floor(ctx.sampleRate * seconds), ir = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c);
      for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2);
    }
    const conv = ctx.createConvolver(); conv.buffer = ir;
    const g = ctx.createGain(); g.gain.value = wet;
    this.goggles.connect(conv); this.panner.connect(conv);
    conv.connect(g).connect(this.master);
    return g;
  }

  setVolume(v: number, muted = this.muted) {
    this.volume = v; this.muted = muted;
    if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : v, this.ctx!.currentTime, 0.05);
    saveSoundPrefs(v, muted);
  }
  toggleMute() { this.setVolume(this.volume, !this.muted); return this.muted; }

  /** Call every rendered frame. */
  update(dt: number, f: AudioFrame) {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    // listener = camera
    const L = ctx.listener;
    if (dt > 0) {
      this.camVel.x = (f.cam.x - this.prevCam.x) / dt; this.camVel.y = (f.cam.y - this.prevCam.y) / dt; this.camVel.z = (f.cam.z - this.prevCam.z) / dt;
    }
    this.prevCam.x = f.cam.x; this.prevCam.y = f.cam.y; this.prevCam.z = f.cam.z;
    if (L.positionX) {
      L.positionX.value = f.cam.x; L.positionY.value = f.cam.y; L.positionZ.value = f.cam.z;
      L.forwardX.value = f.camFwd.x; L.forwardY.value = f.camFwd.y; L.forwardZ.value = f.camFwd.z;
      L.upX.value = f.camUp.x; L.upY.value = f.camUp.y; L.upZ.value = f.camUp.z;
    } else {
      L.setPosition(f.cam.x, f.cam.y, f.cam.z);
      L.setOrientation(f.camFwd.x, f.camFwd.y, f.camFwd.z, f.camUp.x, f.camUp.y, f.camUp.z);
    }
    this.panner.positionX.value = f.pos.x; this.panner.positionY.value = f.pos.y; this.panner.positionZ.value = f.pos.z;
    this.fpvGain.gain.setTargetAtTime(f.fpv ? 0.55 : 0, t, 0.08);
    this.extGain.gain.setTargetAtTime(f.fpv ? 0 : 1, t, 0.08);

    // doppler (external cameras): f' = f * c / (c + v_radial), v_radial = relative speed away from the listener
    let doppler = 1;
    if (!f.fpv) {
      const dx = f.pos.x - f.cam.x, dy = f.pos.y - f.cam.y, dz = f.pos.z - f.cam.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 0.5) {
        const vr = ((f.vel.x - this.camVel.x) * dx + (f.vel.y - this.camVel.y) * dy + (f.vel.z - this.camVel.z) * dz) / dist;
        doppler = SPEED_OF_SOUND / (SPEED_OF_SOUND + Math.max(-150, Math.min(150, vr)));
      }
    }

    // wind: air rush around the camera (FPV) or the map wind (ground pilot)
    const air = f.fpv ? f.airspeed : 0;
    this.wind.gain.setTargetAtTime(Math.min(0.5, (air / 40) ** 2 * 0.5), t, 0.1);
    this.windFilter.frequency.setTargetAtTime(250 + air * 35, t, 0.1);

    // rotor parameters to the worklet, rate-limited
    this.sendT += dt;
    if (this.sendT >= 1 / PARAM_HZ) {
      this.sendT = 0;
      const p = this.params, n = Math.min(MAX_ROTORS, f.omega.length);
      const tMax = f.kT0 * f.omegaMax * f.omegaMax;
      for (let i = 0; i < n; i++) {
        p.rpm![i] = Math.abs(f.omega[i]) * (60 / (2 * Math.PI)) * doppler;
        p.load![i] = Math.sqrt(Math.max(0, f.thrust[i]) / tMax);
      }
      p.n = n; p.rpmMax = f.omegaMax * (60 / (2 * Math.PI)); p.vrs = f.vrs; p.gain = 1;
      this.motor.port.postMessage(p);
    }

    // Betaflight-style low battery beeper
    if (f.lowBattery) {
      this.beepT -= dt;
      if (this.beepT <= 0) { this.beepT = 1.2; this.tone([2600], 0.09, 0.12); }
    } else this.beepT = 0;
  }

  /** short square-ish tones: arming chirps / beeper */
  tone(freqs: number[], dur: number, vol = 0.15, gap = 0.04) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    let t = ctx.currentTime + 0.01;
    for (const fr of freqs) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = fr;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.005); g.gain.setValueAtTime(vol, t + dur - 0.01); g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + dur + 0.02);
      t += dur + gap;
    }
  }

  armed(on: boolean) { if (on) this.tone([1400, 1900], 0.07, 0.1); else this.tone([1900, 1100], 0.07, 0.1); }

  /** crash / hard contact: low thump + filtered noise burst, scaled by impulse (N*s) */
  impact(impulse: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime, k = Math.min(1, impulse / 3);
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900 + 2500 * k;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9 * (0.3 + 0.7 * k), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random()); src.stop(t + 0.4);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
    og.gain.setValueAtTime(0.8 * (0.3 + 0.7 * k), t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(og).connect(this.master);
    o.start(t); o.stop(t + 0.32);
  }

  /** kamikaze blast: deep thump + rumbling noise + crackle, arriving after distance / c */
  explosion(distance: number, size = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + Math.min(1.5, distance / SPEED_OF_SOUND), k = Math.min(1, 0.5 + size * 0.1);
    const out = ctx.createGain(); out.gain.value = Math.min(1.2, 1.4 / (1 + distance / 60)) * k;
    out.connect(this.master);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(85, t); o.frequency.exponentialRampToValueAtTime(24, t + 1.2);
    og.gain.setValueAtTime(0, t); og.gain.linearRampToValueAtTime(1.2, t + 0.01); og.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
    o.connect(og).connect(out); o.start(t); o.stop(t + 1.7);
    const rum = ctx.createBufferSource(); rum.buffer = this.noiseBuf; rum.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(3000, t); lp.frequency.exponentialRampToValueAtTime(180, t + 2.5);
    const rg = ctx.createGain(); rg.gain.setValueAtTime(0, t); rg.gain.linearRampToValueAtTime(1, t + 0.008); rg.gain.exponentialRampToValueAtTime(0.001, t + 3.2);
    rum.connect(lp).connect(rg).connect(out); rum.start(t, Math.random()); rum.stop(t + 3.3);
    const cr = ctx.createBufferSource(); cr.buffer = this.noiseBuf; cr.loop = true; cr.playbackRate.value = 3;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
    const cg = ctx.createGain(); cg.gain.setValueAtTime(0.5, t); cg.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    cr.connect(hp).connect(cg).connect(out); cr.start(t, Math.random()); cr.stop(t + 0.7);
  }

  suspend() { void this.ctx?.suspend(); }
  resume() { void this.ctx?.resume(); }
}
