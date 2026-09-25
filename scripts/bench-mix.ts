// Worst-case cost of the bridge's audio work for a full lobby. Run: npx tsx scripts/bench-mix.ts
import { BYTES_PER_FRAME } from '../src/audio/constants.js';
import { PcmFrameQueue } from '../src/audio/frame-queue.js';
import { PcmMixer, VoiceParams } from '../src/audio/mixer.js';
import { MapType } from '../src/bcl/maps/AmongusMap.js';
import { defaultLobbySettings, GameState, Player } from '../src/bcl/types.js';
import { calculateVoiceAudio, defaultListenerAudioSettings } from '../src/bcl/voice-audio.js';

const LISTENERS = 10;
const SOURCES = 10;
const FRAMES = 500;

const frame = Buffer.alloc(BYTES_PER_FRAME);
for (let i = 0; i < frame.length / 2; i += 1) frame.writeInt16LE(Math.round(Math.sin(i / 7) * 6000), i * 2);

const mixers = Array.from({ length: LISTENERS }, () => {
  const mixer = new PcmMixer();
  const queues = Array.from({ length: SOURCES }, (_, s) => mixer.addSource(`s${s}`, new PcmFrameQueue(10, 1)));
  const params = new Map<string, VoiceParams>(
    Array.from({ length: SOURCES }, (_, s) => [
      `s${s}`,
      {
        left: 0.4,
        right: 0.6,
        muffle: s % 2 === 0 ? { type: 'lowpass', frequency: 2000, q: 20 } : false,
        reverb: s < 2,
      },
    ]),
  );
  return { mixer, queues, params };
});

let start = performance.now();
for (let f = 0; f < FRAMES; f += 1) {
  for (const { mixer, queues, params } of mixers) {
    for (const queue of queues) queue.push(frame);
    mixer.mix(params);
  }
}
const mixMs = (performance.now() - start) / FRAMES;

// Rule evaluation with walls on Airship, every pair, positions changing each update (no cache hits).
const players: Player[] = Array.from({ length: LISTENERS }, (_, i) => ({
  id: i, clientId: i, name: `p${i}`, nameHash: 0, disconnected: false, isImpostor: i < 2, isDead: false,
  bugged: false, x: 0, y: 0, inVent: false, isDummy: false,
}));
const lobby = { ...defaultLobbySettings, wallsBlockAudio: true, maxDistance: 6 };
const UPDATES = 100;
start = performance.now();
for (let u = 0; u < UPDATES; u += 1) {
  for (const p of players) {
    p.x = 10 + Math.random() * 4;
    p.y = Math.random() * 4;
  }
  const state = {
    gameState: GameState.TASKS, oldGameState: GameState.TASKS, lobbyCode: 'X', players, hostId: 0,
    comsSabotaged: false, lightRadius: 1, lightRadiusChanged: false, map: MapType.AIRSHIP, closedDoors: [],
  };
  for (const me of players) {
    for (const other of players) {
      if (me === other) continue;
      calculateVoiceAudio({
        state, settings: defaultListenerAudioSettings, activeLobbySettings: lobby, me, other,
        maxDistance: 6, impostorRadioClientId: -1, inGracePeriod: false,
      });
    }
  }
}
const rulesMs = (performance.now() - start) / UPDATES;

console.log(`mix: ${mixMs.toFixed(2)} ms per 20 ms frame for ${LISTENERS} listeners x ${SOURCES} sources`);
console.log(`rules: ${rulesMs.toFixed(2)} ms per state update for ${LISTENERS * (LISTENERS - 1)} pairs (Airship walls, no cache hits)`);
