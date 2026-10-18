// Procedural rotor sound (PLAN.md 10), DSP core shared by the AudioWorklet and the tests (no Web Audio globals).
// Per rotor: blade-pass tone f = rpm/60 * blades with harmonics x2..x6 (brighter under load), shaft-rate
// imbalance modulation, broadband blade noise band-passed around 2 x BPF, the motor's electrical whine
// (f_e = rpm/60 * pole pairs) proportional to current, and prop-wash "bubbling" (random AM) from the VRS level.

export const MAX_ROTORS = 8;
const HARM = [1, 0.55, 0.38, 0.22, 0.14, 0.08];

/** Parameter frame sent from the game ~60 times a second. */
export interface SynthParams {
  /** rotor speed, rev/min (doppler already applied) */
  rpm: Float32Array;
  /** rotor load 0..1+ (thrust / hover-max), drives brightness and blade noise */
  load: Float32Array;
  n: number;
  blades: number;
  polePairs: number;
  /** reference rpm (full throttle) for loudness normalisation */
  rpmMax: number;
  /** prop wash / VRS 0..1 */
  vrs: number;
  gain: number;
}

export function emptyParams(): SynthParams {
  return { rpm: new Float32Array(MAX_ROTORS), load: new Float32Array(MAX_ROTORS), n: 0, blades: 3, polePairs: 7, rpmMax: 30000, vrs: 0, gain: 1 };
}

const TAU = Math.PI * 2;

class Rotor {
  bp = Math.random() * TAU; sh = 0; el = 0; // blade-pass, shaft, electrical phases
  f = 0; load = 0; amp = 0;                  // smoothed
  // state-variable band-pass for blade noise
  lo = 0; bd = 0;
}

export class MotorSynthCore {
  readonly p = emptyParams();
  private rotors = Array.from({ length: MAX_ROTORS }, () => new Rotor());
  private seed = 22222;
  private wash = 0; private washT = 0;
  private gain = 0;

  constructor(readonly sampleRate: number) {}

  set(p: Partial<SynthParams>) { Object.assign(this.p, p); }

  private noise() { // xorshift white noise -1..1 (cheap, no Math.random per sample)
    let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x;
    return ((x >>> 0) / 4294967296) * 2 - 1;
  }

  /** Fill `out` (mono) with the next block. */
  render(out: Float32Array) {
    const p = this.p, sr = this.sampleRate, n = Math.min(p.n, MAX_ROTORS);
    const smooth = 1 - Math.exp(-1 / (0.03 * sr)); // 30 ms parameter smoothing (no zipper noise)
    const washK = 1 - Math.exp(-TAU * 25 / sr);
    for (let i = 0; i < out.length; i++) {
      this.gain += smooth * (p.gain - this.gain);
      // prop wash: low-passed random amplitude modulation (~25 Hz), depth from VRS
      if ((i & 31) === 0) this.washT = this.noise();
      this.wash += washK * (this.washT - this.wash);
      const am = 1 + p.vrs * 1.6 * this.wash;
      let s = 0;
      for (let r = 0; r < n; r++) {
        const R = this.rotors[r];
        const fT = (p.rpm[r] / 60) * p.blades;
        R.f += smooth * (fT - R.f);
        R.load += smooth * (Math.max(0, p.load[r]) - R.load);
        const x = Math.min(1.2, (p.rpm[r] / p.rpmMax));
        R.amp += smooth * (x * x - R.amp);
        if (R.f < 1) continue;
        R.bp = (R.bp + (TAU * R.f) / sr) % TAU;
        R.sh = (R.sh + (TAU * R.f) / (p.blades * sr)) % TAU;
        R.el = (R.el + (TAU * R.f * p.polePairs) / (p.blades * sr)) % TAU;
        // tone: harmonics get louder with load (sharper pressure pulses)
        const bright = 0.35 + 0.65 * Math.min(1, R.load);
        let tone = 0, hk = 1;
        for (let k = 0; k < HARM.length; k++) {
          tone += HARM[k] * hk * Math.sin((k + 1) * R.bp);
          hk *= bright;
        }
        tone *= 1 + 0.12 * Math.sin(R.sh); // slight prop/motor imbalance at the shaft rate
        // blade noise: SVF band-pass at 2 x BPF, Q ~ 1.4
        const fc = Math.min(0.45 * sr, 2 * R.f);
        const g = 2 * Math.sin((Math.PI * fc) / sr), q = 0.7;
        const hp = this.noise() - R.lo - q * R.bd;
        R.bd += g * hp; R.lo += g * R.bd;
        const bnoise = R.bd * (0.25 + 0.75 * Math.min(1.2, R.load));
        // ESC / winding whine (quiet, rises with current)
        const whine = 0.05 * Math.min(1, R.load) * (Math.sin(R.el) + 0.4 * Math.sin(2 * R.el));
        s += R.amp * (0.55 * tone + 0.6 * bnoise + whine);
      }
      s *= (am * this.gain) / Math.max(2, Math.sqrt(n) * 2);
      out[i] = Math.tanh(s); // soft clip
    }
  }
}
