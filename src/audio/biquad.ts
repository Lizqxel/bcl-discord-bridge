// Web Audio BiquadFilterNode (lowpass / highpass) per the spec's coefficient formulas.
// For these two types the spec interprets Q in dB: alpha = sin(w0) / (2 * 10^(Q/20)).
import { SAMPLE_RATE } from './constants.js';

export type BiquadType = 'lowpass' | 'highpass';

export class StereoBiquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  // Direct form I history per channel: x[n-1], x[n-2], y[n-1], y[n-2]
  private readonly history = [new Float64Array(4), new Float64Array(4)];
  private key = '';

  configure(type: BiquadType, frequency: number, qDb: number, sampleRate = SAMPLE_RATE): void {
    const key = `${type}:${frequency}:${qDb}`;
    if (key === this.key) return;
    this.key = key;
    const nyquist = sampleRate / 2;
    const f = Math.max(0, Math.min(frequency, nyquist)) / nyquist;
    if (f >= 1 || f <= 0) {
      // Degenerate cases from the spec: pass-through (lowpass at nyquist / highpass at 0) or silence.
      const passes = (type === 'lowpass' && f >= 1) || (type === 'highpass' && f <= 0);
      this.setNormalized(passes ? 1 : 0, 0, 0, 1, 0, 0);
      return;
    }
    const w0 = Math.PI * f;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.pow(10, qDb / 20));
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    if (type === 'lowpass') {
      this.setNormalized((1 - cos) / 2, 1 - cos, (1 - cos) / 2, a0, a1, a2);
    } else {
      this.setNormalized((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, a0, a1, a2);
    }
  }

  reset(): void {
    for (const h of this.history) h.fill(0);
  }

  /** Filters one sample of the given channel (0 = left, 1 = right). */
  process(channel: 0 | 1, x: number): number {
    const h = this.history[channel]!;
    const y = this.b0 * x + this.b1 * h[0]! + this.b2 * h[1]! - this.a1 * h[2]! - this.a2 * h[3]!;
    h[1] = h[0]!;
    h[0] = x;
    h[3] = h[2]!;
    h[2] = y;
    return y;
  }

  private setNormalized(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }
}
