// Drives BclClient's rule plumbing without sockets: peer data (impostor radio, host lobby
// settings), grace period tracking and the params handed to the mixer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import type { VoiceParams } from '../audio/mixer.js';
import { BclClient } from './client.js';
import { LocalAudioBus } from './local-bus.js';
import { CameraLocation, MapType } from './maps/AmongusMap.js';
import { AmongUsState, defaultLobbySettings, GameState, LobbySettings, Player } from './types.js';

function player(overrides: Partial<Player> = {}): Player {
  return {
    id: 0,
    clientId: 0,
    name: 'P',
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

function state(overrides: Partial<AmongUsState> = {}): AmongUsState {
  return {
    gameState: GameState.TASKS,
    oldGameState: GameState.TASKS,
    lobbyCode: 'ABCD',
    players: [],
    hostId: 1,
    comsSabotaged: false,
    currentCamera: CameraLocation.NONE,
    map: MapType.THE_SKELD,
    lightRadius: 1,
    lightRadiusChanged: false,
    closedDoors: [],
    ...overrides,
  };
}

type Internals = {
  clients: Map<string, { playerId: number; clientId: number }>;
  remoteAudio: Map<string, unknown>;
  lobbySettings: LobbySettings;
  impostorRadioClientId: number;
  gracePeriodEndsAt: number;
  handlePeerData(peerId: string, raw: string): void;
  handleGameState(payload: { gameState: AmongUsState; lobbySettings?: Partial<LobbySettings> }): void;
  mixOneFrame(): void;
  mixer: { mix(params: ReadonlyMap<string, VoiceParams>): Buffer };
};

function makeClient(colorId = 0): { client: BclClient; internals: Internals } {
  const client = new BclClient({
    serverUrl: 'http://127.0.0.1:1',
    lobbyCode: 'ABCD',
    username: 'me',
    playerColorId: colorId,
    logger: createLogger('silent'),
  });
  return { client, internals: client as unknown as Internals };
}

/** Registers a remote BCL peer (e.g. someone on BCL Desktop) with audio attached. */
function addRemote(internals: Internals, peerId: string, clientId: number): void {
  internals.clients.set(peerId, { playerId: clientId, clientId });
  internals.remoteAudio.set(peerId, {});
}

function captureParams(internals: Internals): ReadonlyMap<string, VoiceParams> {
  let captured: ReadonlyMap<string, VoiceParams> = new Map();
  vi.spyOn(internals.mixer, 'mix').mockImplementation((params) => {
    captured = params;
    return Buffer.alloc(3840);
  });
  internals.mixOneFrame();
  return captured;
}

afterEach(() => vi.restoreAllMocks());

describe('BclClient peer data', () => {
  it('adopts the first impostorRadio transmitter and ignores a second one until it stops', () => {
    const { internals } = makeClient();
    addRemote(internals, 'a', 2);
    addRemote(internals, 'b', 3);
    internals.handlePeerData('a', JSON.stringify({ impostorRadio: true }));
    expect(internals.impostorRadioClientId).toBe(2);
    internals.handlePeerData('b', JSON.stringify({ impostorRadio: true }));
    expect(internals.impostorRadioClientId).toBe(2);
    internals.handlePeerData('a', JSON.stringify({ impostorRadio: false }));
    expect(internals.impostorRadioClientId).toBe(-1);
  });

  it('accepts lobby settings only from the lobby host', () => {
    const { internals } = makeClient();
    addRemote(internals, 'host', 1);
    addRemote(internals, 'other', 5);
    internals.handleGameState({ gameState: state({ hostId: 1, players: [player({ clientId: 9, colorId: 0 })] }) });

    internals.handlePeerData('other', JSON.stringify({ ...defaultLobbySettings, maxDistance: 99 }));
    expect(internals.lobbySettings.maxDistance).toBe(defaultLobbySettings.maxDistance);
    internals.handlePeerData('host', JSON.stringify({ ...defaultLobbySettings, maxDistance: 3, wallsBlockAudio: true }));
    expect(internals.lobbySettings.maxDistance).toBe(3);
    expect(internals.lobbySettings.wallsBlockAudio).toBe(true);
  });
});

describe('BclClient grace period', () => {
  it('starts when a meeting ends under meetingGhostOnly and clears in the lobby', () => {
    const { internals } = makeClient();
    const lobbySettings = { ...defaultLobbySettings, meetingGhostOnly: true, gracePeriod: 3 };
    const players = [player({ clientId: 9, colorId: 0 })];
    internals.handleGameState({ gameState: state({ gameState: GameState.DISCUSSION, players }), lobbySettings });
    internals.handleGameState({ gameState: state({ gameState: GameState.TASKS, players }), lobbySettings });
    expect(internals.gracePeriodEndsAt).toBeGreaterThan(Date.now() + 2_000);
    internals.handleGameState({ gameState: state({ gameState: GameState.LOBBY, players }), lobbySettings });
    expect(internals.gracePeriodEndsAt).toBe(0);
  });
});

describe('BclClient mixing params', () => {
  const me = player({ clientId: 9, colorId: 0, isImpostor: true });

  it('puts a far impostor on the radio through a highpass for an impostor listener', () => {
    const { internals } = makeClient();
    addRemote(internals, 'radio', 2);
    internals.handleGameState({
      gameState: state({ players: [me, player({ clientId: 2, colorId: 1, isImpostor: true, x: 50 })] }),
      lobbySettings: { ...defaultLobbySettings, impostorRadioEnabled: true },
    });
    internals.handlePeerData('radio', JSON.stringify({ impostorRadio: true }));
    const voice = captureParams(internals).get('radio');
    expect(voice?.left).toBeGreaterThan(0);
    expect(voice?.muffle).toEqual({ type: 'highpass', frequency: 1000, q: 10 });
  });

  it("does not use the host's camera view for a bridged listener", () => {
    const { internals } = makeClient();
    addRemote(internals, 'far', 2);
    internals.handleGameState({
      gameState: state({
        map: MapType.POLUS,
        currentCamera: CameraLocation.East,
        players: [me, player({ clientId: 2, colorId: 1, x: 29.5, y: -15.7 })],
      }),
      lobbySettings: { ...defaultLobbySettings, hearThroughCameras: true },
    });
    const voice = captureParams(internals).get('far');
    expect(voice?.left ?? 0).toBe(0);
    expect(voice?.right ?? 0).toBe(0);
  });

  it('pans a nearby speaker with the BCL panner (right of the listener is louder on the right)', () => {
    const { internals } = makeClient();
    addRemote(internals, 'near', 2);
    internals.handleGameState({
      gameState: state({ players: [player({ clientId: 9, colorId: 0 }), player({ clientId: 2, colorId: 1, x: 1 })] }),
    });
    const voice = captureParams(internals).get('near')!;
    expect(voice.left).toBeCloseTo(0.184945, 4);
    expect(voice.right).toBeCloseTo(0.78344, 4);
    expect(voice.muffle).toBe(false);
  });
});

describe('BclClient impostor radio toggle (Discord button)', () => {
  const radioOn = { ...defaultLobbySettings, impostorRadioEnabled: true };

  function bridged(bus: LocalAudioBus, key: string, colorId: number) {
    const client = new BclClient({
      serverUrl: 'http://127.0.0.1:1',
      lobbyCode: 'ABCD',
      username: key,
      playerColorId: colorId,
      localBus: bus,
      localKey: key,
      logger: createLogger('silent'),
    });
    return { client, internals: client as unknown as Internals };
  }

  it('transmits only when BCL would grant it, and explains why not otherwise', () => {
    const { client, internals } = makeClient();
    const players = [player({ clientId: 9, colorId: 0, isImpostor: true })];
    internals.handleGameState({ gameState: state({ gameState: GameState.TASKS, players }), lobbySettings: defaultLobbySettings });
    expect(client.toggleRadio()).toBe('disabled');
    client.toggleRadio(); // off again

    internals.handleGameState({ gameState: state({ gameState: GameState.TASKS, players }), lobbySettings: radioOn });
    expect(client.toggleRadio()).toBe('transmitting');
    expect(client.toggleRadio()).toBe('off');
  });

  it('refuses crewmates', () => {
    const { client, internals } = makeClient();
    internals.handleGameState({
      gameState: state({ players: [player({ clientId: 9, colorId: 0 })] }),
      lobbySettings: radioOn,
    });
    expect(client.toggleRadio()).toBe('not-impostor');
  });

  it('lets another bridged impostor hear the transmission across the map, and releases it at a meeting', () => {
    const bus = new LocalAudioBus();
    const a = bridged(bus, 'a', 0);
    const b = bridged(bus, 'b', 1);
    const players = [
      player({ clientId: 1, colorId: 0, isImpostor: true }),
      player({ clientId: 2, colorId: 1, isImpostor: true, x: 60 }),
    ];
    const tasks = { gameState: state({ players }), lobbySettings: radioOn };
    a.internals.handleGameState(tasks);
    b.internals.handleGameState(tasks);

    expect(a.client.toggleRadio()).toBe('transmitting');
    expect(bus.radioClientId).toBe(1);
    const heard = captureParams(b.internals).get(LocalAudioBus.sourceId('a'));
    expect(heard?.left).toBeGreaterThan(0);
    expect(heard?.muffle).toEqual({ type: 'highpass', frequency: 1000, q: 10 });

    // B cannot grab the radio while A holds it.
    expect(b.client.toggleRadio()).toBe('busy');

    a.internals.handleGameState({ gameState: state({ gameState: GameState.DISCUSSION, players }), lobbySettings: radioOn });
    expect(a.client.radioStatus()).toBe('off');
    expect(bus.radioClientId).toBe(-1);
  });
});

describe('BclClient review fixes', () => {
  it('keeps a radio press made during a meeting and transmits once tasks resume', () => {
    const { client, internals } = makeClient();
    const players = [player({ clientId: 9, colorId: 0, isImpostor: true })];
    const radioOn = { ...defaultLobbySettings, impostorRadioEnabled: true };
    internals.handleGameState({ gameState: state({ gameState: GameState.DISCUSSION, players }), lobbySettings: radioOn });
    expect(client.toggleRadio()).toBe('not-in-tasks');
    internals.handleGameState({ gameState: state({ gameState: GameState.DISCUSSION, players }), lobbySettings: radioOn });
    internals.handleGameState({ gameState: state({ gameState: GameState.TASKS, players }), lobbySettings: radioOn });
    expect(client.radioStatus()).toBe('transmitting');
  });

  it('ignores non-object peer messages instead of throwing', () => {
    const { internals } = makeClient();
    addRemote(internals, 'a', 2);
    for (const raw of ['null', '5', '"x"', 'true', '[]']) {
      expect(() => internals.handlePeerData('a', raw)).not.toThrow();
    }
    expect(internals.impostorRadioClientId).toBe(-1);
  });
});
