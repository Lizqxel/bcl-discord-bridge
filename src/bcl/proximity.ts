import { AmongUsState, GameState, LobbySettings, Player } from './types.js';

export type SpatialMix = {
  gain: number;
  leftGain: number;
  rightGain: number;
  audible: boolean;
};

function distanceBetween(a: Player, b: Player): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function inverseDistanceGain(distance: number): number {
  if (distance <= 1) return 1;
  return 1 / distance;
}

function stereoPan(dx: number, maxDistance: number): [number, number] {
  if (maxDistance <= 0) return [Math.SQRT1_2, Math.SQRT1_2];
  const pan = Math.max(-1, Math.min(1, dx / maxDistance));
  const angle = ((pan + 1) * Math.PI) / 4;
  return [Math.cos(angle), Math.sin(angle)];
}

export function calculateSpatialMix(
  state: AmongUsState,
  settings: LobbySettings,
  listener: Player,
  speaker: Player,
): SpatialMix {
  const silent: SpatialMix = { gain: 0, leftGain: 0, rightGain: 0, audible: false };
  if (speaker.disconnected || speaker.isDummy || speaker.bugged) return silent;

  let baseGain = 1;
  let skipDistance = false;

  switch (state.gameState) {
    case GameState.MENU:
    case GameState.UNKNOWN:
      return silent;
    case GameState.LOBBY:
      break;
    case GameState.DISCUSSION:
      if (!listener.isDead && speaker.isDead) return silent;
      skipDistance = true;
      break;
    case GameState.TASKS:
      if (settings.meetingGhostOnly) return silent;
      if (!listener.isDead && settings.commsSabotage && state.comsSabotaged && !listener.isImpostor) return silent;
      if (
        speaker.inVent &&
        !(settings.hearImpostorsInVents || (settings.impostersHearImpostersInvent && listener.inVent))
      ) {
        return silent;
      }
      if (!listener.isDead && speaker.isDead) {
        if (!(listener.isImpostor && settings.haunting)) return silent;
        baseGain = 0.1;
      }
      break;
  }

  if (settings.deadOnly) {
    if (!listener.isDead || !speaker.isDead) return silent;
    skipDistance = true;
  }

  let maxDistance = settings.maxDistance;
  if (settings.visionHearing && !listener.isImpostor) maxDistance = state.lightRadius + 0.5;
  if (maxDistance <= 0.6) maxDistance = 1;

  const distance = distanceBetween(listener, speaker);
  if (!skipDistance && distance > maxDistance) return silent;

  const attenuation = skipDistance ? 1 : inverseDistanceGain(distance);
  const [leftPan, rightPan] = skipDistance
    ? [Math.SQRT1_2, Math.SQRT1_2]
    : stereoPan(speaker.x - listener.x, maxDistance);
  const gain = baseGain * attenuation;

  return {
    gain,
    leftGain: gain * leftPan,
    rightGain: gain * rightPan,
    audible: gain > 0,
  };
}

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
