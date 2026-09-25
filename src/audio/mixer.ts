import { StereoBiquad } from './biquad.js';
import { BYTES_PER_FRAME, SAMPLES_PER_CHANNEL, SAMPLES_PER_FRAME } from './constants.js';
import { PcmFrameQueue } from './frame-queue.js';
import { Freeverb } from './freeverb.js';

export type StereoGain = {
  left: number;
  right: number;
};

export type MuffleParams = {
  type: 'lowpass' | 'highpass';
  frequency: number;
  q: number;
};

/**
 * What one listener should hear from one source this frame, mirroring BCL's per-peer graph
 * `source → panner → gain → [muffle] → [reverb] → out`.
 * For muffle/reverb, `null`/`undefined` keeps the previous state and `false` turns it off.
 */
export type VoiceParams = StereoGain & {
  muffle?: MuffleParams | false | null;
  reverb?: boolean | null;
};

/** Frames of silence to keep feeding the reverb after a voice stops, so its tail rings out. */
const REVERB_TAIL_FRAMES = 150;

type Channel = {
  queue: PcmFrameQueue;
  left: number;
  right: number;
  muffle: StereoBiquad | null;
  reverb: Freeverb | null;
  reverbTail: number;
};

export class PcmMixer {
  private readonly sources = new Map<string, Channel>();
  private readonly reverbOut: [number, number] = [0, 0];

  addSource(id: string, queue = new PcmFrameQueue()): PcmFrameQueue {
    this.sources.set(id, { queue, left: 0, right: 0, muffle: null, reverb: null, reverbTail: 0 });
    return queue;
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  getSource(id: string): PcmFrameQueue | undefined {
    return this.sources.get(id)?.queue;
  }

  stats(): Record<string, { queued: number; dropped: number }> {
    return Object.fromEntries(
      [...this.sources].map(([id, channel]) => [
        id,
        { queued: channel.queue.queuedFrames, dropped: Math.round(channel.queue.droppedFrames) },
      ]),
    );
  }

  mix(params: ReadonlyMap<string, VoiceParams>): Buffer {
    const accumulator = new Float64Array(SAMPLES_PER_FRAME);

    for (const [id, channel] of this.sources) {
      // Consume every source each tick, audible or not, so nobody's queue fills with stale audio.
      const frame = channel.queue.popFrame();
      const target = params.get(id);
      this.applyEffects(channel, target);
      const targetLeft = target?.left ?? 0;
      const targetRight = target?.right ?? 0;

      const ringing = channel.reverb !== null && channel.reverbTail > 0;
      const audible = frame && (targetLeft > 0 || targetRight > 0 || channel.left > 0 || channel.right > 0);
      if (!audible && !ringing) {
        channel.left = targetLeft;
        channel.right = targetRight;
        continue;
      }

      const samples = frame ? new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2) : undefined;
      if (frame && channel.reverb) channel.reverbTail = REVERB_TAIL_FRAMES;
      else if (channel.reverb) channel.reverbTail -= 1;

      const startLeft = channel.left;
      const startRight = channel.right;
      for (let i = 0; i < SAMPLES_PER_CHANNEL; i += 1) {
        // BCL ramps gain changes over 20 ms (one frame) to avoid clicks.
        const t = (i + 1) / SAMPLES_PER_CHANNEL;
        const gainLeft = startLeft + (targetLeft - startLeft) * t;
        const gainRight = startRight + (targetRight - startRight) * t;
        const mono = samples ? ((samples[i * 2] ?? 0) + (samples[i * 2 + 1] ?? 0)) / 2 : 0;
        let left = mono * gainLeft;
        let right = mono * gainRight;
        if (channel.muffle) {
          left = channel.muffle.process(0, left);
          right = channel.muffle.process(1, right);
        }
        if (channel.reverb) {
          channel.reverb.process((left + right) / 2, this.reverbOut);
          left = this.reverbOut[0];
          right = this.reverbOut[1];
        }
        accumulator[i * 2] = (accumulator[i * 2] ?? 0) + left;
        accumulator[i * 2 + 1] = (accumulator[i * 2 + 1] ?? 0) + right;
      }
      channel.left = targetLeft;
      channel.right = targetRight;
    }

    const output = Buffer.alloc(BYTES_PER_FRAME);
    const out = new Int16Array(output.buffer, output.byteOffset, output.length / 2);
    for (let index = 0; index < out.length; index += 1) {
      out[index] = Math.max(-32768, Math.min(32767, Math.round(accumulator[index] ?? 0)));
    }
    return output;
  }

  private applyEffects(channel: Channel, target: VoiceParams | undefined): void {
    if (!target) return;
    if (target.muffle === false) {
      channel.muffle = null;
    } else if (target.muffle) {
      if (!channel.muffle) channel.muffle = new StereoBiquad();
      channel.muffle.configure(target.muffle.type, target.muffle.frequency, target.muffle.q);
    }
    if (target.reverb === false) {
      channel.reverb = null;
      channel.reverbTail = 0;
    } else if (target.reverb === true && !channel.reverb) {
      channel.reverb = new Freeverb();
    }
  }
}
