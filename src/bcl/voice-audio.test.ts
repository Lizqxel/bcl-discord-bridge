// Cases ported from BetterCrewlink-mobile src/app/voice/spatialAudio.spec.ts, plus the
// Desktop-only rules (ghostsCanTalkIngame, grace period, vent/camera muffle, haunting).
import { describe, expect, it } from 'vitest';
import { CameraLocation, MapType } from './maps/AmongusMap.js';
import { AmongUsState, defaultLobbySettings, GameState, LobbySettings, Player } from './types.js';
import {
  applyListenerVolume,
  calculateVoiceAudio,
  defaultListenerAudioSettings,
  listenerMaxDistance,
  ListenerAudioSettings,
  VoiceAudioInput,
} from './voice-audio.js';

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 0,
    clientId: 0,
    name: 'Player',
    nameHash: 0,
    colorId: 0,
    disconnected: false,
    isImpostor: false,
    isDead: false,
    bugged: false,
    x: 0,
    y: 0,
    inVent: false,
    isDummy: false,
    ...overrides,
  };
}

function makeState(overrides: Partial<AmongUsState> = {}): AmongUsState {
  return {
    gameState: GameState.TASKS,
    oldGameState: GameState.TASKS,
    lobbyCode: 'ABCD',
    players: [],
    hostId: 0,
    comsSabotaged: false,
    currentCamera: CameraLocation.NONE,
    map: MapType.THE_SKELD,
    lightRadius: 1,
    lightRadiusChanged: false,
    closedDoors: [],
    ...overrides,
  };
}

const settings = (overrides: Partial<ListenerAudioSettings> = {}) => ({ ...defaultListenerAudioSettings, ...overrides });
const lobby = (overrides: Partial<LobbySettings> = {}) => ({ ...defaultLobbySettings, ...overrides });

/** `me` is id/clientId 1 (alive, crew); `other` is id/clientId 2, 1 unit away. */
function run(overrides: Partial<VoiceAudioInput> = {}) {
  return calculateVoiceAudio({
    state: makeState(),
    settings: settings(),
    activeLobbySettings: lobby(),
    me: makePlayer({ id: 1, clientId: 1 }),
    other: makePlayer({ id: 2, clientId: 2, x: 1, y: 0 }),
    maxDistance: 5.32,
    impostorRadioClientId: -1,
    inGracePeriod: false,
    ...overrides,
  });
}

describe('calculateVoiceAudio (BCL mobile spec)', () => {
  it('mutes a disconnected player regardless of state', () => {
    expect(run({ other: makePlayer({ disconnected: true }) }).gain).toBe(0);
  });

  it('mutes a dummy player regardless of state', () => {
    expect(run({ other: makePlayer({ isDummy: true }) }).gain).toBe(0);
  });

  it('mutes everyone in MENU', () => {
    expect(run({ state: makeState({ gameState: GameState.MENU }) }).gain).toBe(0);
  });

  it('hears a nearby player in TASKS at full gain', () => {
    expect(run().gain).toBe(1);
  });

  it('mutes players beyond maxDistance when cameras are disabled', () => {
    const result = run({
      other: makePlayer({ id: 2, clientId: 2, x: 100, y: 0 }),
      activeLobbySettings: lobby({ hearThroughCameras: false }),
    });
    expect(result.gain).toBe(0);
  });

  it('mutes non-impostor crew when comms sabotage is active and enabled', () => {
    const result = run({
      state: makeState({ comsSabotaged: true }),
      activeLobbySettings: lobby({ commsSabotage: true }),
    });
    expect(result.gain).toBe(0);
  });

  it('does not mute crew for comms sabotage when the setting is disabled', () => {
    const result = run({ state: makeState({ comsSabotaged: true }), activeLobbySettings: lobby({ commsSabotage: false }) });
    expect(result.gain).toBe(1);
  });

  it('mutes players in vents unless hearImpostorsInVents is enabled', () => {
    const muted = run({ other: makePlayer({ id: 2, clientId: 2, x: 1, y: 0, inVent: true }) });
    expect(muted.gain).toBe(0);

    const heard = run({
      other: makePlayer({ id: 2, clientId: 2, x: 1, y: 0, inVent: true }),
      activeLobbySettings: lobby({ hearImpostorsInVents: true }),
    });
    expect(heard.gain).not.toBe(0);
  });

  it('applies haunting reverb and ghostVolumeAsImpostor gain for a dead player heard by a living impostor', () => {
    const result = run({
      other: makePlayer({ id: 2, clientId: 2, x: 1, y: 0, isDead: true }),
      me: makePlayer({ id: 1, clientId: 1, isImpostor: true }),
      activeLobbySettings: lobby({ haunting: true }),
      settings: settings({ ghostVolumeAsImpostor: 25 }),
    });
    expect(result.gain).toBeCloseTo(0.25);
    expect(result.reverb).toBe(true);
  });

  it('mutes a dead player heard by a living player when haunting is off', () => {
    expect(run({ other: makePlayer({ id: 2, clientId: 2, x: 1, y: 0, isDead: true }) }).gain).toBe(0);
  });

  it('in DISCUSSION, centers panning and only lets like hear like', () => {
    const deadHearsLiving = run({
      state: makeState({ gameState: GameState.DISCUSSION }),
      me: makePlayer({ id: 1, clientId: 1, isDead: true }),
      other: makePlayer({ id: 2, clientId: 2, x: 1, y: 0 }),
    });
    expect(deadHearsLiving.gain).toBe(1);
    expect(deadHearsLiving.panPosition).toEqual([0, 0]);

    const livingHearsDead = run({
      state: makeState({ gameState: GameState.DISCUSSION }),
      other: makePlayer({ id: 2, clientId: 2, x: 1, y: 0, isDead: true }),
    });
    expect(livingHearsDead.gain).toBe(0);
  });

  it('restricts to dead-only pairs and centers panning when deadOnly is enabled', () => {
    const result = run({
      me: makePlayer({ id: 1, clientId: 1, isDead: true }),
      other: makePlayer({ id: 2, clientId: 2, x: 1, y: 0, isDead: true }),
      activeLobbySettings: lobby({ deadOnly: true }),
    });
    expect(result.gain).toBe(1);
    expect(result.panPosition).toEqual([0, 0]);
  });

  describe('impostor radio', () => {
    it('lets a living impostor hear the transmitting impostor regardless of distance', () => {
      const result = run({
        other: makePlayer({ id: 2, clientId: 2, x: 999, y: 999, isImpostor: true }),
        me: makePlayer({ id: 1, clientId: 1, isImpostor: true }),
        activeLobbySettings: lobby({ impostorRadioEnabled: true }),
        impostorRadioClientId: 2,
      });
      expect(result.gain).toBe(1);
      expect(result.muffle).toEqual({ type: 'highpass', frequency: 1000, q: 10 });
      expect(result.panPosition).toEqual([0, 0]);
    });

    it('mutes the transmission for living crew when impostorRadioPrivate is enabled', () => {
      const result = run({
        other: makePlayer({ id: 2, clientId: 2, x: 1, y: 0, isImpostor: true }),
        activeLobbySettings: lobby({ impostorRadioEnabled: true, impostorRadioPrivate: true }),
        impostorRadioClientId: 2,
      });
      expect(result.gain).toBe(0);
    });

    it('does not grant radio range when impostorRadioEnabled is off', () => {
      const result = run({
        other: makePlayer({ id: 2, clientId: 2, x: 999, y: 999, isImpostor: true }),
        me: makePlayer({ id: 1, clientId: 1, isImpostor: true }),
        activeLobbySettings: lobby({ impostorRadioEnabled: false }),
        impostorRadioClientId: 2,
      });
      expect(result.gain).toBe(0);
    });
  });

  describe('walls block audio', () => {
    // MIRA_HQ door 0 is 'M 44.942 37.086 H 47.27' in SVG space (svgX = x + 40, svgY = 40 - y),
    // so the game-space segment (5, 2)-(5, 4) crosses it.
    const wallBlockedMe = () => makePlayer({ id: 1, clientId: 1, x: 5, y: 2 });
    const wallBlockedOther = () => makePlayer({ id: 2, clientId: 2, x: 5, y: 4 });

    it('mutes a within-range player when a closed door blocks the path and wallsBlockAudio is enabled', () => {
      const result = run({
        state: makeState({ map: MapType.MIRA_HQ, closedDoors: [0] }),
        me: wallBlockedMe(),
        other: wallBlockedOther(),
        activeLobbySettings: lobby({ wallsBlockAudio: true }),
      });
      expect(result.gain).toBe(0);
    });

    it('ignores the same closed door when wallsBlockAudio is disabled', () => {
      const result = run({
        state: makeState({ map: MapType.MIRA_HQ, closedDoors: [0] }),
        me: wallBlockedMe(),
        other: wallBlockedOther(),
        activeLobbySettings: lobby({ wallsBlockAudio: false }),
      });
      expect(result.gain).toBe(1);
    });

    it('does not block on a door that is not in the closed-doors list', () => {
      const result = run({
        state: makeState({ map: MapType.MIRA_HQ, closedDoors: [] }),
        me: wallBlockedMe(),
        other: wallBlockedOther(),
        activeLobbySettings: lobby({ wallsBlockAudio: true }),
      });
      expect(result.gain).toBe(1);
    });

    it('does not wall-check for a dead listener (ghosts hear through walls)', () => {
      const result = run({
        state: makeState({ map: MapType.MIRA_HQ, closedDoors: [0] }),
        me: makePlayer({ id: 1, clientId: 1, isDead: true, x: 5, y: 2 }),
        other: makePlayer({ id: 2, clientId: 2, isDead: true, x: 5, y: 4 }),
        activeLobbySettings: lobby({ wallsBlockAudio: true, deadOnly: true }),
      });
      expect(result.gain).toBe(1);
    });
  });
});

describe('calculateVoiceAudio (Desktop-only rules)', () => {
  it('lets ghosts talk across the map in TASKS when meetingGhostOnly + ghostsCanTalkIngame', () => {
    const result = run({
      me: makePlayer({ id: 1, clientId: 1, isDead: true }),
      other: makePlayer({ id: 2, clientId: 2, isDead: true, x: 200 }),
      activeLobbySettings: lobby({ meetingGhostOnly: true, ghostsCanTalkIngame: true }),
    });
    expect(result.gain).toBe(1);
    expect(result.panPosition).toEqual([0, 0]);
  });

  it('keeps the living silent in TASKS under meetingGhostOnly, except during the grace period', () => {
    const silenced = run({ activeLobbySettings: lobby({ meetingGhostOnly: true }) });
    expect(silenced.gain).toBe(0);
    const grace = run({ activeLobbySettings: lobby({ meetingGhostOnly: true }), inGracePeriod: true });
    expect(grace.gain).toBe(1);
  });

  it('muffles and halves a voice when the listener is in a vent', () => {
    const result = run({
      me: makePlayer({ id: 1, clientId: 1, inVent: true, isImpostor: true }),
    });
    expect(result.muffle).toEqual({ type: 'lowpass', frequency: 2000, q: 20 });
    expect(result.gain).toBe(0.5);
  });

  it('hears a far player through the host camera position with camera muffle', () => {
    const result = run({
      state: makeState({ map: MapType.POLUS, currentCamera: CameraLocation.East }),
      other: makePlayer({ id: 2, clientId: 2, x: 29.5, y: -15.7 }),
      activeLobbySettings: lobby({ hearThroughCameras: true }),
    });
    expect(result.gain).toBeCloseTo(0.8);
    expect(result.muffle).toEqual({ type: 'lowpass', frequency: 2300, q: -15 });
    expect(result.panPosition?.[0]).toBeCloseTo(0.5);
  });

  it('turns reverb off for anything that is not a ghost heard by a living impostor', () => {
    expect(run().reverb).toBe(false);
  });

  it('allows lobby chat at full gain', () => {
    expect(run({ state: makeState({ gameState: GameState.LOBBY }) }).gain).toBe(1);
  });
});

describe('listenerMaxDistance', () => {
  const me = makePlayer();
  it('uses the lobby maxDistance by default', () => {
    expect(listenerMaxDistance(makeState(), lobby({ maxDistance: 3 }), me)).toBe(3);
  });
  it('uses the light radius for crew with visionHearing, and maxDistance for impostors', () => {
    const state = makeState({ lightRadius: 2 });
    expect(listenerMaxDistance(state, lobby({ visionHearing: true }), me)).toBe(2.5);
    expect(listenerMaxDistance(state, lobby({ visionHearing: true, maxDistance: 4 }), makePlayer({ isImpostor: true }))).toBe(4);
  });
  it('never goes below 1 unit', () => {
    expect(listenerMaxDistance(makeState({ lightRadius: 0 }), lobby({ visionHearing: true }), me)).toBe(1);
  });
});

describe('applyListenerVolume', () => {
  it('scales crew heard by a ghost and applies master volume', () => {
    const ghost = makePlayer({ isDead: true });
    const alive = makePlayer();
    const custom = settings({ crewVolumeAsGhost: 50, masterVolume: 80 });
    expect(applyListenerVolume(1, custom, ghost, alive)).toBeCloseTo(0.4);
    expect(applyListenerVolume(1, custom, alive, alive)).toBeCloseTo(0.8);
    expect(applyListenerVolume(0, custom, alive, alive)).toBe(0);
  });
});
