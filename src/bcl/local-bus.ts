import type { PcmMixer } from '../audio/mixer.js';

type Member = {
  mixer: PcmMixer;
  socketId?: string;
  clientId?: number;
};

export type LocalSpeaker = {
  sourceId: string;
  clientId?: number;
};

/**
 * Shares decoded microphone audio between bridge sessions running in this process,
 * so bridged players hear each other without WebRTC. Only players that are not
 * bridged (e.g. the host's BetterCrewLink Desktop) still need a peer connection.
 */
export class LocalAudioBus {
  private readonly members = new Map<string, Member>();

  register(key: string, mixer: PcmMixer): void {
    this.members.set(key, { mixer });
  }

  unregister(key: string): void {
    this.members.delete(key);
    const sourceId = LocalAudioBus.sourceId(key);
    for (const member of this.members.values()) member.mixer.removeSource(sourceId);
  }

  setSocketId(key: string, socketId: string | undefined): void {
    const member = this.members.get(key);
    if (member) member.socketId = socketId;
  }

  setClientId(key: string, clientId: number | undefined): void {
    const member = this.members.get(key);
    if (member) member.clientId = clientId;
  }

  isLocal(socketId: string, clientId?: number): boolean {
    for (const member of this.members.values()) {
      if (member.socketId === socketId) return true;
      if (clientId !== undefined && member.clientId === clientId) return true;
    }
    return false;
  }

  isClaimedByOther(key: string, clientId: number): boolean {
    for (const [otherKey, member] of this.members) {
      if (otherKey !== key && member.clientId === clientId) return true;
    }
    return false;
  }

  publish(fromKey: string, pcm: Buffer): void {
    const sourceId = LocalAudioBus.sourceId(fromKey);
    for (const [key, member] of this.members) {
      if (key === fromKey) continue;
      const queue = member.mixer.getSource(sourceId) ?? member.mixer.addSource(sourceId);
      queue.push(pcm);
    }
  }

  /** @param includeUnplaced also list speakers not yet matched to an in-game player. */
  speakersFor(listenerKey: string, includeUnplaced = false): LocalSpeaker[] {
    const speakers: LocalSpeaker[] = [];
    for (const [key, member] of this.members) {
      if (key === listenerKey || (member.clientId === undefined && !includeUnplaced)) continue;
      speakers.push({ sourceId: LocalAudioBus.sourceId(key), clientId: member.clientId });
    }
    return speakers;
  }

  static sourceId(key: string): string {
    return `local:${key}`;
  }
}
