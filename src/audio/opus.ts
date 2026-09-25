import opus from '@discordjs/opus';
import { CHANNELS, SAMPLE_RATE } from './constants.js';

// Native libopus. opusscript's WASM build passes wrong heap offsets once many
// instances exist ("memory access out of bounds" with ~6 bridged players).
export class OpusCodec {
  private readonly codec = new opus.OpusEncoder(SAMPLE_RATE, CHANNELS);

  decode(packet: Buffer): Buffer {
    return this.codec.decode(packet);
  }

  encode(pcm: Buffer): Buffer {
    return this.codec.encode(pcm);
  }

  close(): void {
    // Native handle is released by GC.
  }
}
