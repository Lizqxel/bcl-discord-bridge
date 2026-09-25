// Freeverb (Jezar at Dreampoint, public domain) — mono in, stereo wet out.
// BCL Desktop routes haunting ghosts through a ConvolverNode with its bundled impulse
// response (reverb.ogx). That file's licence is unclear and FFT convolution per listener
// is costly, so the bridge uses this algorithmic room of similar size instead.
import { SAMPLE_RATE } from './constants.js';

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];
const STEREO_SPREAD = 23;
const FIXED_GAIN = 0.015;
const SCALE = SAMPLE_RATE / 44_100;

class Comb {
  private readonly buffer: Float32Array;
  private index = 0;
  private store = 0;

  constructor(size: number, private readonly feedback: number, private readonly damp: number) {
    this.buffer = new Float32Array(size);
  }

  process(input: number): number {
    const output = this.buffer[this.index]!;
    this.store = output * (1 - this.damp) + this.store * this.damp;
    this.buffer[this.index] = input + this.store * this.feedback;
    if (++this.index >= this.buffer.length) this.index = 0;
    return output;
  }
}

class Allpass {
  private readonly buffer: Float32Array;
  private index = 0;

  constructor(size: number) {
    this.buffer = new Float32Array(size);
  }

  process(input: number): number {
    const buffered = this.buffer[this.index]!;
    this.buffer[this.index] = input + buffered * 0.5;
    if (++this.index >= this.buffer.length) this.index = 0;
    return buffered - input;
  }
}

export class Freeverb {
  private readonly combs: [Comb[], Comb[]];
  private readonly allpasses: [Allpass[], Allpass[]];
  /** Roughly matches the level of a normalised ConvolverNode on speech. */
  private readonly wet = 3;

  constructor(roomSize = 0.5, damping = 0.5) {
    const feedback = roomSize * 0.28 + 0.7;
    const damp = damping * 0.4;
    const make = (spread: number): Comb[] =>
      COMB_TUNING.map((length) => new Comb(Math.round((length + spread) * SCALE), feedback, damp));
    const makeAllpass = (spread: number): Allpass[] =>
      ALLPASS_TUNING.map((length) => new Allpass(Math.round((length + spread) * SCALE)));
    this.combs = [make(0), make(STEREO_SPREAD)];
    this.allpasses = [makeAllpass(0), makeAllpass(STEREO_SPREAD)];
  }

  /** Returns the wet stereo sample for one mono input sample. */
  process(input: number, out: [number, number]): void {
    const scaled = input * FIXED_GAIN;
    for (let channel = 0; channel < 2; channel += 1) {
      let sum = 0;
      for (const comb of this.combs[channel as 0 | 1]) sum += comb.process(scaled);
      for (const allpass of this.allpasses[channel as 0 | 1]) sum = allpass.process(sum);
      out[channel] = sum * this.wet;
    }
  }
}
