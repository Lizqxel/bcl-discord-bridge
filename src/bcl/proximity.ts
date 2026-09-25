import { Player } from './types.js';

// Matching a bridged Discord member to their in-game player. Audio rules live in voice-audio.ts.
export function normalizeUsername(name: string): string {
  return name.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

export function findPlayerByName(players: Player[], username: string): Player | undefined {
  const normalized = normalizeUsername(username);
  return players.find((player) => normalizeUsername(player.name) === normalized);
}

export function findPlayerByColor(players: Player[], colorId: number): Player | undefined {
  // After a match the state can still list the previous game's entry for a color;
  // prefer the live one so the listener position is not stale.
  const matches = players.filter((player) => player.colorId === colorId);
  return matches.find((player) => !player.disconnected && !player.isDummy) ?? matches[0];
}
