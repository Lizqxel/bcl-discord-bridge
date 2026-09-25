// Port of BetterCrewLink Desktop v3.2.2 src/renderer/voice/spatialAudio.ts (GPL-3.0).
// Keep this line-for-line comparable with upstream so rule changes are easy to carry over.
import { AmongUsMaps, CameraLocation, MapType } from './maps/AmongusMap.js';
import { poseCollide } from './maps/ColliderMap.js';
import { AmongUsState, GameState, LobbySettings, Player } from './types.js';

export type MuffleSetting = {
  type: 'lowpass' | 'highpass';
  frequency: number;
  q: number;
};

/** The per-user BCL settings that affect what a listener hears. Bridged players get BCL's defaults. */
export type ListenerAudioSettings = {
  enableSpatialAudio: boolean;
  ghostVolumeAsImpostor: number;
  crewVolumeAsGhost: number;
  masterVolume: number;
};

export const defaultListenerAudioSettings: ListenerAudioSettings = {
  enableSpatialAudio: true,
  ghostVolumeAsImpostor: 10,
  crewVolumeAsGhost: 100,
  masterVolume: 100,
};

export type VoiceAudioInput = {
  state: AmongUsState;
  settings: ListenerAudioSettings;
  activeLobbySettings: LobbySettings;
  me: Player;
  other: Player;
  maxDistance: number;
  impostorRadioClientId: number;
  inGracePeriod: boolean;
};

/** `null` on an effect field means "leave it as it is"; `false` means "turn it off". */
export type VoiceAudioResult = {
  gain: number;
  panPosition: [number, number] | null;
  muffle: MuffleSetting | false | null;
  reverb: boolean | null;
};

// Wall checks are the costly part (~0.1-0.25 ms each) and are symmetric, while the bridge
// evaluates every listener/speaker pair. Cache by map, closed doors and rounded positions.
const COLLIDE_CACHE_LIMIT = 20_000;
const collideCache = new Map<string, boolean>();

function wallBetween(a: Player, b: Player, map: MapType, closedDoors: number[]): boolean {
  const pa = `${Math.round(a.x * 100)},${Math.round(a.y * 100)}`;
  const pb = `${Math.round(b.x * 100)},${Math.round(b.y * 100)}`;
  const key = `${map}|${closedDoors.join(',')}|${pa < pb ? pa + '|' + pb : pb + '|' + pa}`;
  const cached = collideCache.get(key);
  if (cached !== undefined) return cached;
  // poseCollide mutates its points for the April map, so always pass fresh objects.
  const blocked = poseCollide({ x: a.x, y: a.y }, { x: b.x, y: b.y }, map, closedDoors);
  if (collideCache.size >= COLLIDE_CACHE_LIMIT) collideCache.clear();
  collideCache.set(key, blocked);
  return blocked;
}

function distance(panPos: [number, number]): number {
  return Math.sqrt(panPos[0] * panPos[0] + panPos[1] * panPos[1]);
}

export function calculateVoiceAudio(input: VoiceAudioInput): VoiceAudioResult {
  const { state, settings, activeLobbySettings, me, other, maxDistance, impostorRadioClientId, inGracePeriod } = input;
  const map = state.map ?? MapType.UNKNOWN;
  const currentCamera = state.currentCamera ?? CameraLocation.NONE;

  const result: VoiceAudioResult = { gain: 0, panPosition: null, muffle: null, reverb: null };

  if (other.disconnected || other.isDummy) return result;

  let panPos: [number, number] = [other.x - me.x, other.y - me.y];
  let endGain = 0;
  let wallCheckEnabled = false;
  let skipDistanceCheck = false;
  let muffleEnabled = false;
  const onImpostorRadio =
    activeLobbySettings.impostorRadioEnabled &&
    other.isImpostor &&
    impostorRadioClientId !== -1 &&
    other.clientId === impostorRadioClientId;

  switch (state.gameState) {
    case GameState.MENU:
      return result;

    case GameState.LOBBY:
      endGain = 1;
      break;

    case GameState.TASKS:
      endGain = 1;

      if (activeLobbySettings.meetingGhostOnly) {
        if (activeLobbySettings.ghostsCanTalkIngame && me.isDead && other.isDead) {
          // Ghosts reach each other across the whole map, the way everyone does in a meeting.
          skipDistanceCheck = true;
        } else if (!inGracePeriod) {
          endGain = 0;
        }
      }
      if (!me.isDead && activeLobbySettings.commsSabotage && state.comsSabotaged && !me.isImpostor) {
        endGain = 0;
      }

      if (
        other.inVent &&
        !(activeLobbySettings.hearImpostorsInVents || (activeLobbySettings.impostersHearImpostersInvent && me.inVent))
      ) {
        endGain = 0;
      }
      wallCheckEnabled = activeLobbySettings.wallsBlockAudio && !me.isDead;
      if (onImpostorRadio && me.isImpostor) {
        skipDistanceCheck = true;
        muffleEnabled = true;
        result.muffle = { type: 'highpass', frequency: 1000, q: 10 };
      } else if (onImpostorRadio && !me.isDead && activeLobbySettings.impostorRadioPrivate) {
        endGain = 0;
      }

      if (!me.isDead && other.isDead && me.isImpostor && activeLobbySettings.haunting) {
        result.reverb = true;
        wallCheckEnabled = false;
        endGain = settings.ghostVolumeAsImpostor / 100;
      } else if (other.isDead && !me.isDead) {
        endGain = 0;
      }
      break;

    case GameState.DISCUSSION:
      panPos = [0, 0];
      endGain = 1;
      if (!me.isDead && other.isDead) endGain = 0;
      break;

    case GameState.UNKNOWN:
    default:
      endGain = 0;
      break;
  }

  if (!other.isDead || state.gameState !== GameState.TASKS || !me.isImpostor || me.isDead) {
    result.reverb = false;
  }

  if (activeLobbySettings.deadOnly) {
    panPos = [0, 0];
    if (!me.isDead || !other.isDead) endGain = 0;
  }

  let isOnCamera = currentCamera !== CameraLocation.NONE;
  if (!skipDistanceCheck && distance(panPos) > maxDistance) {
    if (!activeLobbySettings.hearThroughCameras || state.gameState !== GameState.TASKS) return result;

    const cameras = AmongUsMaps[map]?.cameras ?? {};
    if (currentCamera !== CameraLocation.NONE && currentCamera !== CameraLocation.Skeld) {
      const cameraPos = cameras[currentCamera];
      if (cameraPos) panPos = [other.x - cameraPos.x, other.y - cameraPos.y];
    } else if (currentCamera === CameraLocation.Skeld) {
      let closest = 999;
      let cameraPos = { x: 999, y: 999 };
      for (const camera of Object.values(cameras)) {
        const cameraDist = Math.sqrt(Math.pow(other.x - camera.x, 2) + Math.pow(other.y - camera.y, 2));
        if (closest > cameraDist) {
          closest = cameraDist;
          cameraPos = camera;
        }
      }
      if (closest !== 999) panPos = [other.x - cameraPos.x, other.y - cameraPos.y];
    }

    if (distance(panPos) > maxDistance) return result;
  } else {
    if (
      !skipDistanceCheck &&
      wallCheckEnabled &&
      wallBetween(me, other, map, state.closedDoors ?? [])
    ) {
      return result;
    }
    isOnCamera = false;
  }

  const inVentMuffle = (me.inVent && !me.isDead) || (other.inVent && !other.isDead);
  if ((inVentMuffle || isOnCamera) && state.gameState === GameState.TASKS) {
    result.muffle = {
      type: 'lowpass',
      frequency: isOnCamera ? 2300 : 2000,
      q: isOnCamera ? -15 : 20,
    };
    if (endGain === 1) endGain = isOnCamera ? 0.8 : 0.5;
  } else if (!muffleEnabled) {
    result.muffle = false;
  }

  if (!settings.enableSpatialAudio || skipDistanceCheck) panPos = [0, 0];

  result.panPosition = panPos;
  result.gain = endGain;
  return result;
}

/** BCL Desktop VoiceController: the listener's audible radius. */
export function listenerMaxDistance(state: AmongUsState, settings: LobbySettings, me: Player): number {
  let maxDistance = settings.visionHearing
    ? me.isImpostor
      ? settings.maxDistance
      : state.lightRadius + 0.5
    : settings.maxDistance;
  if (maxDistance <= 0.6) maxDistance = 1;
  return maxDistance;
}

/** BCL Desktop VoiceController.updatePeerAudio: volume settings applied on top of the rule gain. */
export function applyListenerVolume(gain: number, settings: ListenerAudioSettings, me: Player, other: Player): number {
  if (gain <= 0) return gain;
  if (me.isDead && !other.isDead) gain *= settings.crewVolumeAsGhost / 100;
  return gain * (settings.masterVolume / 100);
}
