// AudioWorklet wrapper around MotorSynthCore: parameters arrive as port messages (~60 Hz), audio runs here.
import { MotorSynthCore, type SynthParams } from './motorSynth';

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, ctor: unknown): void;

class MotorSynthProcessor extends AudioWorkletProcessor {
  private core = new MotorSynthCore(sampleRate);
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Partial<SynthParams>>) => this.core.set(e.data);
  }
  process(_in: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    this.core.render(out[0]);
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    return true;
  }
}
registerProcessor('motor-synth', MotorSynthProcessor);
