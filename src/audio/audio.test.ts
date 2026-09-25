import { describe, expect, it } from 'vitest';
import { BYTES_PER_FRAME, SAMPLES_PER_FRAME } from './constants.js';
import { PcmFrameQueue } from './frame-queue.js';
import { PcmMixer } from './mixer.js';

function constantFrame(value: number): Buffer {
  const buffer = Buffer.alloc(BYTES_PER_FRAME);
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  samples.fill(value);
  return buffer;
}

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
  it('mixes stereo sources using independent left/right gains', () => {
    const mixer = new PcmMixer();
    mixer.addSource('a', new PcmFrameQueue(10, 1)).push(constantFrame(1000));
    mixer.addSource('b', new PcmFrameQueue(10, 1)).push(constantFrame(2000));
    const output = mixer.mix(
      new Map([
        ['a', { left: 1, right: 0 }],
        ['b', { left: 0, right: 0.5 }],
      ]),
    );
    const samples = new Int16Array(output.buffer, output.byteOffset, SAMPLES_PER_FRAME);
    expect(samples[0]).toBe(1000);
    expect(samples[1]).toBe(1000);
  });

  it('clips instead of wrapping on overflow', () => {
    const mixer = new PcmMixer();
    mixer.addSource('a', new PcmFrameQueue(10, 1)).push(constantFrame(30_000));
    mixer.addSource('b', new PcmFrameQueue(10, 1)).push(constantFrame(30_000));
    const output = mixer.mix(
      new Map([
        ['a', { left: 1, right: 1 }],
        ['b', { left: 1, right: 1 }],
      ]),
    );
    expect(output.readInt16LE(0)).toBe(32767);
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