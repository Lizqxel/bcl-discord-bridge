import { randomUUID } from 'node:crypto';
import {
  MediaStream,
  MediaStreamTrack,
  RTCDataChannel,
  RTCIceCandidateInit,
  RTCPeerConnection,
} from 'werift';
import type { Logger } from '../logger.js';

export type SignalData =
  | { type: 'offer'; sdp: string; connectionId?: string }
  | { type: 'answer'; sdp: string; connectionId?: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit; connectionId?: string };

export type PeerOptions = {
  id: string;
  initiator: boolean;
  localTrack: MediaStreamTrack;
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  forceRelayOnly: boolean;
  logger: Logger;
  onSignal: (data: SignalData) => void;
  onRemoteTrack: (track: MediaStreamTrack) => void;
  onData: (data: string | Buffer) => void;
  onClosed: () => void;
};

export class BclPeer {
  // BCL Desktop drops answers/candidates whose connectionId differs from its offer's,
  // so the answering side must adopt the initiator's ID.
  private currentConnectionId: string = randomUUID();
  private readonly pc: RTCPeerConnection;
  private readonly pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private dataChannel?: RTCDataChannel;
  private localDescriptionSent = false;
  private pendingLocalCandidates: RTCIceCandidateInit[] = [];
  private closed = false;

  constructor(private readonly options: PeerOptions) {
    this.pc = new RTCPeerConnection({
      iceServers: options.iceServers,
      iceTransportPolicy: options.forceRelayOnly ? 'relay' : 'all',
    });
    this.pc.addTrack(options.localTrack, new MediaStream([options.localTrack]));
    this.pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      const payload = candidate.toJSON();
      if (this.localDescriptionSent) this.emitSignal({ type: 'candidate', candidate: payload });
      else this.pendingLocalCandidates.push(payload);
    });
    this.pc.onTrack.subscribe((track) => options.onRemoteTrack(track));
    this.pc.onDataChannel.subscribe((channel) => this.bindDataChannel(channel));
    this.pc.connectionStateChange.subscribe(() => {
      const state = this.pc.connectionState;
      options.logger.info({ peerId: options.id, state }, 'BCL peer state changed');
      if (state === 'failed' || state === 'closed') options.onClosed();
    });

    if (options.initiator) {
      this.bindDataChannel(this.pc.createDataChannel('data'));
      void this.createOffer();
    }
  }

  get connectionId(): string {
    return this.currentConnectionId;
  }

  get connectionState(): string {
    return this.pc.connectionState;
  }

  async signal(data: SignalData): Promise<void> {
    if (this.closed) return;
    if (data.type === 'candidate') {
      if (!this.pc.remoteDescription) this.pendingRemoteCandidates.push(data.candidate);
      else await this.pc.addIceCandidate(data.candidate);
      return;
    }

    if (data.type === 'offer' && data.connectionId) this.currentConnectionId = data.connectionId;
    await this.pc.setRemoteDescription({ type: data.type, sdp: data.sdp });
    for (const candidate of this.pendingRemoteCandidates.splice(0)) {
      await this.pc.addIceCandidate(candidate);
    }
    if (data.type === 'offer') {
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.emitLocalDescription('answer');
    }
  }

  sendData(data: string): void {
    if (this.dataChannel?.readyState === 'open') this.dataChannel.send(data);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.dataChannel?.close();
    await this.pc.close();
  }

  private async createOffer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.emitLocalDescription('offer');
  }

  private emitLocalDescription(type: 'offer' | 'answer'): void {
    const local = this.pc.localDescription;
    if (!local) return;
    this.options.onSignal({ type, sdp: local.sdp, connectionId: this.currentConnectionId });
    this.localDescriptionSent = true;
    for (const candidate of this.pendingLocalCandidates.splice(0)) {
      this.emitSignal({ type: 'candidate', candidate });
    }
  }

  private emitSignal(data: SignalData): void {
    this.options.onSignal({ ...data, connectionId: this.currentConnectionId });
  }

  private bindDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    channel.onMessage.subscribe((data) => this.options.onData(data));
  }
}
