import { describe, expect, it } from 'vitest';
import { calculateSpatialMix, findPlayerByColor, findPlayerByName } from './proximity.js';
import { AmongUsState, defaultLobbySettings, GameState, Player } from './types.js';

function player(overrides: Partial<Player> = {}): Player {
  return {
    id: 1,
    clientId: 1,
    name: 'Player',
    nameHash: 1,
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
    oldGameState: GameState.LOBBY,
    lobbyCode: 'ABCDEF',
    players: [],
    hostId: 1,
    comsSabotaged: false,
    lightRadius: 2,
    lightRadiusChanged: false,
    ...overrides,
  };
}

describe('calculateSpatialMix', () => {
  it('hears a nearby living player', () => {
    const mix = calculateSpatialMix(
      state(),
      { ...defaultLobbySettings, maxDistance: 5 },
      player(),
      player({ clientId: 2, x: 2 }),
    );
    expect(mix.audible).toBe(true);
    expect(mix.gain).toBeCloseTo(0.5);
    expect(mix.rightGain).toBeGreaterThan(mix.leftGain);
  });

  it('mutes a player beyond max distance', () => {
    const mix = calculateSpatialMix(
      state(),
      { ...defaultLobbySettings, maxDistance: 5 },
      player(),
      player({ clientId: 2, x: 6 }),
    );
    expect(mix.audible).toBe(false);
  });

  it('does not let living players hear ghosts', () => {
    const mix = calculateSpatialMix(
      state(),
      defaultLobbySettings,
      player(),
      player({ clientId: 2, isDead: true }),
    );
    expect(mix.audible).toBe(false);
  });

  it('allows dead-only global ghost chat', () => {
    const mix = calculateSpatialMix(
      state(),
      { ...defaultLobbySettings, deadOnly: true },
      player({ isDead: true }),
      player({ clientId: 2, isDead: true, x: 100 }),
    );
    expect(mix.audible).toBe(true);
    expect(mix.gain).toBe(1);
  });

  it('uses global audio during discussion', () => {
    const mix = calculateSpatialMix(
      state({ gameState: GameState.DISCUSSION }),
      defaultLobbySettings,
      player(),
      player({ clientId: 2, x: 100 }),
    );
    expect(mix.audible).toBe(true);
  });
});

describe('findPlayerByName', () => {
  it('normalizes rich text, whitespace, and case', () => {
    const match = findPlayerByName([player({ name: '<color=red>Foo   Bar</color>' })], 'foo bar');
    expect(match?.clientId).toBe(1);
  });
});

describe('findPlayerByColor', () => {
  it('matches the current Among Us color id', () => {
    const players = [player({ clientId: 2, colorId: 4 }), player({ clientId: 3, colorId: 7 })];
    expect(findPlayerByColor(players, 7)?.clientId).toBe(3);
  });
});

describe('findPlayerByColor after a match', () => {
  it('prefers the live entry over a stale disconnected one with the same color', () => {
    const stale = player({ clientId: 5, colorId: 3, disconnected: true, x: 40 });
    const live = player({ clientId: 9, colorId: 3, x: 1 });
    expect(findPlayerByColor([stale, live], 3)).toBe(live);
  });
});
