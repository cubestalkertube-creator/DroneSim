// Rotor synth DSP: the blade-pass frequency dominates, loudness follows rpm, output stays bounded.
import { describe, expect, it } from 'vitest';
import { MotorSynthCore } from '../src/audio/motorSynth';

const SR = 48000;
/** Goertzel power of `f` in the block */
function power(x: Float32Array, f: number) {
  const k = 2 * Math.cos((2 * Math.PI * f) / SR);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { const s0 = x[i] + k * s1 - s2; s2 = s1; s1 = s0; }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / x.length;
}
function render(rpm: number, load = 0.5, n = 4, sec = 0.5) {
  const c = new MotorSynthCore(SR);
  c.set({ n, blades: 3, polePairs: 7, rpmMax: 30000, vrs: 0, gain: 1 });
  for (let i = 0; i < n; i++) { c.p.rpm[i] = rpm * (1 + i * 0.004); c.p.load[i] = load; }
  const warm = new Float32Array(SR * 0.2); c.render(warm); // let the 30 ms smoothing settle
  const out = new Float32Array(SR * sec); c.render(out);
  return out;
}
const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

describe('motor synth', () => {
  it('blade-pass frequency rpm/60*blades dominates its neighbourhood', () => {
    const x = render(18000); // BPF = 900 Hz
    const bpf = power(x, 900);
    expect(bpf).toBeGreaterThan(5 * power(x, 700));
    expect(bpf).toBeGreaterThan(5 * power(x, 1150));
    expect(power(x, 1800)).toBeGreaterThan(power(x, 1500)); // 2nd harmonic present
  });
  it('louder with rpm, silent when stopped, bounded', () => {
    const lo = rms(render(8000)), hi = rms(render(26000)), off = rms(render(0));
    expect(hi).toBeGreaterThan(2 * lo);
    expect(off).toBeLessThan(1e-6);
    const x = render(36000, 1.2, 8);
    expect(Math.max(...x.map(Math.abs))).toBeLessThanOrEqual(1);
  });
});
