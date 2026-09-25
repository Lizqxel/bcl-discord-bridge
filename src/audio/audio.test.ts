import { describe, expect, it } from 'vitest';
import { BYTES_PER_FRAME, SAMPLES_PER_CHANNEL, SAMPLES_PER_FRAME } from './constants.js';
import { PcmFrameQueue } from './frame-queue.js';
import { PcmMixer, VoiceParams } from './mixer.js';

function constantFrame(value: number): Buffer {
  const buffer = Buffer.alloc(BYTES_PER_FRAME);
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  samples.fill(value);
  return buffer;
}

/** A full-scale tone at `frequency` Hz, identical on both channels. */
function toneFrame(frequency: number, frameIndex: number, amplitude = 8000): Buffer {
  const buffer = Buffer.alloc(BYTES_PER_FRAME);
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  for (let i = 0; i < SAMPLES_PER_CHANNEL; i += 1) {
    const t = (frameIndex * SAMPLES_PER_CHANNEL + i) / 48_000;
    const value = Math.round(Math.sin(2 * Math.PI * frequency * t) * amplitude);
    samples[i * 2] = value;
    samples[i * 2 + 1] = value;
  }
  return buffer;
}

function samplesOf(frame: Buffer): Int16Array {
  return new Int16Array(frame.buffer, frame.byteOffset, SAMPLES_PER_FRAME);
}

function rms(frame: Buffer): number {
  const samples = samplesOf(frame);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

const instant = () => new PcmFrameQueue(10, 1);

describe('PcmFrameQueue', () => {
  it('combines partial chunks into a complete 20 ms frame', () => {
    const queue = new PcmFrameQueue(10, 1);
    const frame = constantFrame(1234);
    queue.push(frame.subarray(0, 100));
    queue.push(frame.subarray(100));
    expect(queue.popFrame()).toEqual(frame);
  });
});

describe('PcmMixer', () => {
  it('ramps to new gains over one frame, then holds them (BCL 20 ms gain ramp)', () => {
    const mixer = new PcmMixer();
    const queue = mixer.addSource('a', instant());
    queue.push(constantFrame(1000));
    queue.push(constantFrame(1000));
    const gains = new Map([['a', { left: 1, right: 0.5 }]]);

    const first = samplesOf(mixer.mix(gains));
    expect(first[0]).toBeLessThan(10); // starts near silence
    expect(first[SAMPLES_PER_FRAME - 2]).toBe(1000); // reaches the target at the end
    expect(first[SAMPLES_PER_FRAME - 1]).toBe(500);

    const second = samplesOf(mixer.mix(gains));
    expect(second[0]).toBe(1000);
    expect(second[1]).toBe(500);
  });

  it('mixes the mono downmix of each source into both channels', () => {
    const mixer = new PcmMixer();
    const a = mixer.addSource('a', instant());
    const b = mixer.addSource('b', instant());
    for (let i = 0; i < 2; i += 1) {
      a.push(constantFrame(1000));
      b.push(constantFrame(2000));
    }
    const gains = new Map([
      ['a', { left: 1, right: 0 }],
      ['b', { left: 0, right: 0.5 }],
    ]);
    mixer.mix(gains);
    const settled = samplesOf(mixer.mix(gains));
    expect(settled[0]).toBe(1000);
    expect(settled[1]).toBe(1000);
  });

  it('clips instead of wrapping on overflow', () => {
    const mixer = new PcmMixer();
    const a = mixer.addSource('a', instant());
    const b = mixer.addSource('b', instant());
    for (let i = 0; i < 2; i += 1) {
      a.push(constantFrame(30_000));
      b.push(constantFrame(30_000));
    }
    const gains = new Map([
      ['a', { left: 1, right: 1 }],
      ['b', { left: 1, right: 1 }],
    ]);
    mixer.mix(gains);
    expect(mixer.mix(gains).readInt16LE(0)).toBe(32767);
  });

  it('keeps draining inaudible sources so their audio never goes stale', () => {
    const mixer = new PcmMixer();
    const queue = mixer.addSource('a', instant());
    for (let i = 0; i < 5; i += 1) queue.push(constantFrame(1000));
    for (let i = 0; i < 5; i += 1) mixer.mix(new Map());
    expect(queue.queuedFrames).toBe(0);
  });

  it('applies the BCL vent muffle (2 kHz lowpass) to high frequencies', () => {
    const measure = (muffle: boolean) => {
      const mixer = new PcmMixer();
      const queue = mixer.addSource('a', instant());
      const params = new Map<string, VoiceParams>([
        ['a', { left: 1, right: 1, muffle: muffle ? { type: 'lowpass', frequency: 2000, q: 20 } : false }],
      ]);
      let last: Buffer = Buffer.alloc(0);
      for (let frame = 0; frame < 10; frame += 1) {
        queue.push(toneFrame(8000, frame));
        last = mixer.mix(params);
      }
      return rms(last);
    };
    expect(measure(true)).toBeLessThan(measure(false) * 0.1);
  });

  it('keeps a reverb tail ringing after the voice stops', () => {
    const mixer = new PcmMixer();
    const queue = mixer.addSource('a', instant());
    const params = new Map([['a', { left: 1, right: 1, reverb: true }]]);
    for (let frame = 0; frame < 10; frame += 1) {
      queue.push(toneFrame(440, frame));
      mixer.mix(params);
    }
    const tail = mixer.mix(params);
    expect(rms(tail)).toBeGreaterThan(10);

    const off = new Map([['a', { left: 1, right: 1, reverb: false }]]);
    expect(rms(mixer.mix(off))).toBe(0);
  });
});

describe('PcmFrameQueue jitter buffer', () => {
  it('waits for the start threshold, then plays through, then re-buffers after an underrun', () => {
    const queue = new PcmFrameQueue(10, 3);
    queue.push(constantFrame(1));
    queue.push(constantFrame(2));
    expect(queue.popFrame()).toBeUndefined();
    queue.push(constantFrame(3));
    expect(queue.popFrame()).toEqual(constantFrame(1));
    expect(queue.popFrame()).toEqual(constantFrame(2));
    expect(queue.popFrame()).toEqual(constantFrame(3));
    expect(queue.popFrame()).toBeUndefined();
    queue.push(constantFrame(4));
    expect(queue.popFrame()).toBeUndefined();
  });

  it('drops the oldest audio beyond the cap and counts it', () => {
    const queue = new PcmFrameQueue(2, 1);
    for (let value = 1; value <= 4; value += 1) queue.push(constantFrame(value));
    expect(queue.droppedFrames).toBe(2);
    expect(queue.popFrame()).toEqual(constantFrame(3));
  });
});
