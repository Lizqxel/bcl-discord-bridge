import { BYTES_PER_FRAME, SAMPLES_PER_FRAME } from './constants.js';
import { PcmFrameQueue } from './frame-queue.js';

export type StereoGain = {
  left: number;
  right: number;
};

export class PcmMixer {
  private readonly sources = new Map<string, PcmFrameQueue>();

  addSource(id: string, queue = new PcmFrameQueue()): PcmFrameQueue {
    this.sources.set(id, queue);
    return queue;
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  stats(): Record<string, { queued: number; dropped: number }> {
    return Object.fromEntries(
      [...this.sources].map(([id, queue]) => [id, { queued: queue.queuedFrames, dropped: Math.round(queue.droppedFrames) }]),
    );
  }

  getSource(id: string): PcmFrameQueue | undefined {
    return this.sources.get(id);
  }

  mix(gains: ReadonlyMap<string, StereoGain>): Buffer {
    const accumulator = new Float64Array(SAMPLES_PER_FRAME);

    for (const [id, gain] of gains) {
      if (gain.left <= 0 && gain.right <= 0) continue;
      const frame = this.sources.get(id)?.popFrame();
      if (!frame) continue;
      const samples = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);
      for (let index = 0; index < samples.length; index += 2) {
        accumulator[index] = (accumulator[index] ?? 0) + (samples[index] ?? 0) * gain.left;
        accumulator[index + 1] = (accumulator[index + 1] ?? 0) + (samples[index + 1] ?? 0) * gain.right;
      }
    }

    const output = Buffer.alloc(BYTES_PER_FRAME);
    const samples = new Int16Array(output.buffer, output.byteOffset, output.length / 2);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.max(-32768, Math.min(32767, Math.round(accumulator[index] ?? 0)));
    }
    return output;
  }
}
