// Reference values rendered by Chromium's real Web Audio (OfflineAudioContext, 48 kHz) with the
// exact node settings BetterCrewLink uses, so the bridge's DSP stays numerically identical.
import { describe, expect, it } from 'vitest';
import { StereoBiquad } from './biquad.js';
import { pannerGains } from './panner.js';

// PannerNode: equalpower, linear, refDistance 0.1, rolloff 1, position (x, y, -0.5).
const PANNER_REFERENCE = [
  { x: 0, y: 0, max: 5.32, L: 0.6529223322868347, R: 0.6529223322868347 },
  { x: 1, y: 0, max: 5.32, L: 0.184945210814476, R: 0.7834404110908508 },
  { x: -2, y: 1, max: 5.32, L: 0.5758658051490784, R: 0.07089238613843918 },
  { x: 3, y: -4, max: 5.32, L: 0.004662230145186186, R: 0.05633275955915451 },
  { x: 0.3, y: 0.2, max: 2.5, L: 0.38667792081832886, R: 0.6829469203948975 },
  { x: 6, y: 0, max: 5.32, L: 0, R: 0 },
  { x: -0.5, y: 0, max: 1, L: 0.3006645143032074, R: 0.124539315700531 },
  { x: 2, y: 2, max: 3, L: 0.005381064955145121, R: 0.04371095076203346 },
];

// BiquadFilterNode.getFrequencyResponse at 100, 500, 1000, 2000, 2300, 4000, 8000 Hz.
const FREQUENCIES = [100, 500, 1000, 2000, 2300, 4000, 8000];
const BIQUAD_REFERENCE = [
  { type: 'lowpass', f: 2000, q: 20, mag: [1.0024652481079102, 1.0655323266983032, 1.3266308307647705, 10, 2.880964517593384, 0.3175678253173828, 0.05483327433466911] },
  { type: 'lowpass', f: 2300, q: -15, mag: [0.9735115766525269, 0.6479321122169495, 0.3902554214000702, 0.2046215683221817, 0.17782793939113617, 0.09844767302274704, 0.03952600061893463] },
  { type: 'highpass', f: 1000, q: 10, mag: [0.01006705779582262, 0.3252577781677246, 3.1622776985168457, 1.3013319969177246, 1.2125917673110962, 1.060060977935791, 1.0123867988586426] },
] as const;

describe('Web Audio parity', () => {
  it.each(PANNER_REFERENCE)('PannerNode gains at ($x, $y), maxDistance $max', ({ x, y, max, L, R }) => {
    const gains = pannerGains([x, y], max);
    expect(gains.left).toBeCloseTo(L, 5);
    expect(gains.right).toBeCloseTo(R, 5);
  });

  it.each(BIQUAD_REFERENCE)('BiquadFilterNode $type $f Hz Q $q magnitude response', ({ type, f, q, mag }) => {
    const filter = new StereoBiquad();
    filter.configure(type, f, q);
    const { b0, b1, b2, a1, a2 } = filter as unknown as Record<string, number>;
    FREQUENCIES.forEach((frequency, index) => {
      const w = (2 * Math.PI * frequency) / 48_000;
      const num = [b0! + b1! * Math.cos(w) + b2! * Math.cos(2 * w), -(b1! * Math.sin(w) + b2! * Math.sin(2 * w))];
      const den = [1 + a1! * Math.cos(w) + a2! * Math.cos(2 * w), -(a1! * Math.sin(w) + a2! * Math.sin(2 * w))];
      const magnitude = Math.hypot(num[0]!, num[1]!) / Math.hypot(den[0]!, den[1]!);
      expect(magnitude / mag[index]!).toBeCloseTo(1, 4);
    });
  });

  it('StereoBiquad passes DC through a lowpass and blocks it with a highpass', () => {
    const low = new StereoBiquad();
    low.configure('lowpass', 2000, 0);
    const high = new StereoBiquad();
    high.configure('highpass', 1000, 0);
    let lowOut = 0;
    let highOut = 0;
    for (let i = 0; i < 4800; i += 1) {
      lowOut = low.process(0, 1);
      highOut = high.process(1, 1);
    }
    expect(lowOut).toBeCloseTo(1, 6);
    expect(highOut).toBeCloseTo(0, 6);
  });
});
