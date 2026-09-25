import { BYTES_PER_FRAME } from './constants.js';

export class PcmFrameQueue {
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  /** Frames discarded because the source ran ahead of the mixer (heard as a skip). */
  droppedFrames = 0;
  private readonly maxBufferedBytes: number;
  private primed = false;

  /**
   * A small jitter buffer: playback starts once startFrames are queued and, after an
   * underrun, waits to refill instead of stuttering frame by frame on bursty networks.
   */
  constructor(maxFrames = 10, private readonly startFrames = 3) {
    this.maxBufferedBytes = maxFrames * BYTES_PER_FRAME;
  }

  push(pcm: Buffer): void {
    if (pcm.length === 0) return;
    this.chunks.push(Buffer.from(pcm));
    this.bufferedBytes += pcm.length;
    this.trimOverflow();
  }

  popFrame(): Buffer | undefined {
    if (!this.primed && this.bufferedBytes < this.startFrames * BYTES_PER_FRAME) return undefined;
    if (this.bufferedBytes < BYTES_PER_FRAME) {
      this.primed = false;
      return undefined;
    }
    this.primed = true;
    const output = Buffer.allocUnsafe(BYTES_PER_FRAME);
    let written = 0;

    while (written < BYTES_PER_FRAME) {
      const chunk = this.chunks[0];
      if (!chunk) break;
      const count = Math.min(chunk.length, BYTES_PER_FRAME - written);
      chunk.copy(output, written, 0, count);
      written += count;
      this.bufferedBytes -= count;
      if (count === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(count);
    }
    return output;
  }

  clear(): void {
    this.chunks = [];
    this.bufferedBytes = 0;
    this.primed = false;
  }

  get queuedFrames(): number {
    return Math.floor(this.bufferedBytes / BYTES_PER_FRAME);
  }

  private trimOverflow(): void {
    while (this.bufferedBytes > this.maxBufferedBytes && this.chunks.length > 0) {
      const removed = this.chunks.shift();
      if (removed) {
        this.bufferedBytes -= removed.length;
        this.droppedFrames += removed.length / BYTES_PER_FRAME;
      }
    }
  }
}
