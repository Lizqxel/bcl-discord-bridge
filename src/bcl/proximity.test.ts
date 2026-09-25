import { describe, expect, it } from 'vitest';
import { findPlayerByColor, findPlayerByName } from './proximity.js';
import { Player } from './types.js';

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
