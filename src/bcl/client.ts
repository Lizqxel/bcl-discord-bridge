import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import { MediaStreamTrack, RtpHeader, RtpPacket } from 'werift';
import { FRAME_DURATION_MS, SAMPLES_PER_CHANNEL } from '../audio/constants.js';
import { PcmFrameQueue } from '../audio/frame-queue.js';
import { PcmMixer, VoiceParams } from '../audio/mixer.js';
import { pannerGains } from '../audio/panner.js';
import { OpusCodec } from '../audio/opus.js';
import type { Logger } from '../logger.js';
import { LocalAudioBus } from './local-bus.js';
import { BclPeer, SignalData } from './peer.js';
import { findPlayerByColor, findPlayerByName } from './proximity.js';
import {
  applyListenerVolume,
  calculateVoiceAudio,
  defaultListenerAudioSettings,
  listenerMaxDistance,
} from './voice-audio.js';
import {
  AmongUsState,
  CameraLocation,
  GameState,
  ClientIdentity,
  ClientPeerConfig,
  defaultLobbySettings,
  LobbySettings,
  MobileHostPayload,
  Player,
} from './types.js';

const LOBBY_FALLBACK_GAIN = Math.SQRT1_2;

export type RadioStatus = 'off' | 'transmitting' | 'disabled' | 'not-in-tasks' | 'not-impostor' | 'busy';

type ClientEvents = {
  status: [status: string];
  mixedOpus: [packet: Buffer];
  error: [error: Error];
};

type RemoteAudio = {
  decoder: OpusCodec;
  queue: PcmFrameQueue;
};

export type BclClientOptions = {
  serverUrl: string;
  lobbyCode: string;
  username: string;
  playerColorId?: number;
  /** Shared with other sessions in this process; bridged players are mixed locally. */
  localBus?: LocalAudioBus;
  localKey?: string;
  logger: Logger;
};

export class BclClient extends EventEmitter<ClientEvents> {
  private stateSocket?: Socket;
  private voiceSocket?: Socket;
  private readonly localTrack = new MediaStreamTrack({ kind: 'audio' });
  private readonly peers = new Map<string, BclPeer>();
  private readonly clients = new Map<string, ClientIdentity>();
  private readonly remoteAudio = new Map<string, RemoteAudio>();
  private readonly mixer = new PcmMixer();
  private readonly outputEncoder = new OpusCodec();
  private readonly micDecoder = new OpusCodec();
  private state?: AmongUsState;
  private lobbySettings: LobbySettings = { ...defaultLobbySettings };
  private localPlayer?: Player;
  private currentHost?: string;
  private joinedGameRoom = false;
  private mixTimer?: NodeJS.Timeout;
  private nextMixAt = 0;
  private lastStateAt = 0;
  private watchdogTimer?: NodeJS.Timeout;
  private lastGains = new Map<string, number>();
  private trackedClientId?: number;
  /** clientId of the impostor currently talking on the radio (-1 = nobody), as in BCL. */
  private impostorRadioClientId = -1;
  private gracePeriodEndsAt = 0;
  /** The phone player's radio toggle (Discord button) and whether BCL's rules grant it. */
  private radioPressed = false;
  private radioTransmitting = false;
  /** Bumped whenever the inputs to the voice rules change, so params are rebuilt only then. */
  private stateVersion = 0;
  private cachedParams = new Map<string, VoiceParams>();
  private cachedParamsKey = '';
  private announcedClientId?: number;
  private colorId?: number;
  private mixStats = { catchUpFrames: 0, resyncs: 0, maxTickGapMs: 0 };
  private lastTickAt = 0;
  private sequenceNumber = randomInt(0, 65_536);
  private timestamp = randomInt(0, 0x1_0000_0000);
  private readonly ssrc = randomInt(1, 0x1_0000_0000);
  private peerConfig: ClientPeerConfig = {
    forceRelayOnly: false,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  constructor(private readonly options: BclClientOptions) {
    super();
    this.colorId = options.playerColorId;
    this.localBus?.register(this.localKey, this.mixer);
  }

  private get localBus(): LocalAudioBus | undefined {
    return this.options.localBus;
  }

  private get localKey(): string {
    return this.options.localKey ?? this.options.username;
  }

  private isLocalPeer(id: string): boolean {
    return Boolean(this.localBus?.isLocal(id, this.clients.get(id)?.clientId));
  }

  connect(): void {
    if (this.stateSocket || this.voiceSocket) return;
    this.emit('status', 'voice-server-connecting');
    this.connectStateSocket();
    this.connectVoiceSocket();
  }

  private connectStateSocket(): void {
    const socket = io(this.options.serverUrl, { transports: ['websocket'] });
    this.stateSocket = socket;

    socket.on('connect', () => {
      this.options.logger.info(
        { lobby: this.options.lobbyCode, username: this.options.username },
        'BCL state socket connected',
      );
      socket.emit('join', `${this.options.lobbyCode}_mobile`, Date.now(), Date.now());
      this.emitGameInfo(socket);
      this.emit('status', 'waiting-for-mobile-host');
    });

    socket.on('clientPeerConfig', (config: ClientPeerConfig) => {
      if (Array.isArray(config?.iceServers)) this.peerConfig = config;
    });
    socket.on('signal', (payload: { from: string; data: Record<string, unknown> }) => {
      this.handleStateSignal(payload.from, payload.data);
    });
    socket.on('disconnect', () => this.emit('status', 'state-feed-disconnected'));
    socket.on('connect_error', (error: Error) => this.handleError(error));
  }

  private connectVoiceSocket(): void {
    const socket = io(this.options.serverUrl, { transports: ['websocket'] });
    this.voiceSocket = socket;

    socket.on('connect', () => {
      this.options.logger.info(
        { lobby: this.options.lobbyCode, username: this.options.username },
        'BCL voice socket connected',
      );
      this.localBus?.setSocketId(this.localKey, socket.id);
      this.emitGameInfo(socket);
      if (this.localPlayer) this.joinGameRoom(this.localPlayer);
    });
    socket.on('clientPeerConfig', (config: ClientPeerConfig) => {
      if (Array.isArray(config?.iceServers)) this.peerConfig = config;
    });
    socket.on('setClients', (clients: Record<string, ClientIdentity>) => this.replaceClients(clients));
    socket.on('setClient', (id: string, client: ClientIdentity) => this.clients.set(id, client));
    socket.on('join', (id: string, client: ClientIdentity) => {
      this.clients.set(id, client);
      // A rejoin (e.g. BCL Desktop returning to the lobby) needs a fresh connection.
      if (this.joinedGameRoom && id !== socket.id && !this.isLocalPeer(id)) this.createPeer(id, true, true);
    });
    socket.on('signal', (payload: { from: string; data: Record<string, unknown> }) => {
      void this.handleVoiceSignal(payload.from, payload.data).catch((error: unknown) => this.handleError(error));
    });
    socket.on('disconnect', () => {
      this.joinedGameRoom = false;
      this.clients.clear();
      this.emit('status', 'voice-disconnected');
      void this.destroyPeers();
    });
    socket.on('connect_error', (error: Error) => this.handleError(error));
  }

  pushMicrophoneOpus(packet: Buffer): void {
    if (!this.joinedGameRoom || packet.length === 0) return;
    const rtp = new RtpPacket(
      new RtpHeader({
        payloadType: 96,
        sequenceNumber: this.sequenceNumber,
        timestamp: this.timestamp,
        ssrc: this.ssrc,
      }),
      packet,
    );
    this.localTrack.writeRtp(rtp);
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    this.timestamp = (this.timestamp + SAMPLES_PER_CHANNEL) >>> 0;
    if (this.localBus) {
      try {
        this.localBus.publish(this.localKey, this.micDecoder.decode(packet));
      } catch (error) {
        this.options.logger.debug({ error }, 'Dropped invalid Discord Opus packet');
      }
    }
  }

  setSpeaking(speaking: boolean): void {
    this.voiceSocket?.emit('VAD', speaking);
  }

  async disconnect(): Promise<void> {
    if (this.mixTimer) clearTimeout(this.mixTimer);
    this.mixTimer = undefined;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
    this.stateSocket?.emit('leave');
    this.stateSocket?.disconnect();
    this.stateSocket = undefined;
    this.voiceSocket?.emit('leave');
    this.voiceSocket?.disconnect();
    this.voiceSocket = undefined;
    await this.destroyPeers();
    for (const remote of this.remoteAudio.values()) remote.decoder.close();
    this.remoteAudio.clear();
    this.localBus?.setRadioTransmitter(this.localKey, undefined);
    this.localBus?.unregister(this.localKey);
    this.outputEncoder.close();
    this.micDecoder.close();
    this.localTrack.stop();
  }

  private handleStateSignal(from: string, data: Record<string, unknown>): void {
    if ('mobileHostInfo' in data) {
      const info = data.mobileHostInfo as { isHostingMobile: boolean; isGameHost: boolean };
      if (!info.isHostingMobile) return;
      // Answer every beacon from our host: BCL Desktop stops streaming game state when a
      // match ends and only resumes after it receives mobilePlayerInfo again.
      if (!this.currentHost || info.isGameHost || from === this.currentHost) {
        this.currentHost = from;
        this.stateSocket?.emit('signal', {
          to: from,
          data: { mobilePlayerInfo: { code: this.options.lobbyCode, askingForHost: true } },
        });
      }
      return;
    }

    if ('gameState' in data) {
      if (this.currentHost && from !== this.currentHost) return;
      this.currentHost = from;
      this.handleGameState(data as unknown as MobileHostPayload);
    }
  }

  private async handleVoiceSignal(from: string, data: Record<string, unknown>): Promise<void> {
    if (!('type' in data)) return;
    const signal = data as SignalData;
    if (this.isLocalPeer(from)) return;
    let peer = this.peers.get(from);
    if (signal.type === 'offer' && (!peer || peer.connectionId !== signal.connectionId)) {
      peer = this.createPeer(from, false, true);
    }
    if (peer) await peer.signal(signal);
  }

  /** Re-targets this bridge to another in-game color without restarting the round. */
  setPlayerColor(colorId: number): void {
    this.colorId = colorId;
    this.trackedClientId = undefined;
    this.localPlayer = undefined;
    this.localBus?.setClientId(this.localKey, undefined);
    this.emit('status', 'waiting-for-player-color');
  }

  private handleGameState(payload: MobileHostPayload): void {
    this.lastStateAt = Date.now();
    if (this.state?.gameState !== payload.gameState.gameState) {
      this.options.logger.info(
        { username: this.options.username, from: this.state ? GameState[this.state.gameState] : null, to: GameState[payload.gameState.gameState] },
        'BCL game state changed',
      );
    }
    this.stateVersion += 1;
    const previousGameState = this.state?.gameState;
    this.state = payload.gameState;
    // The mobile feed carries BCL Desktop's active (host) lobby settings.
    if (payload.lobbySettings) this.lobbySettings = { ...defaultLobbySettings, ...payload.lobbySettings };
    if (previousGameState !== payload.gameState.gameState) this.updateGracePeriod(payload.gameState.gameState, previousGameState);
    this.cleanupImpostorRadio(payload.gameState);
    // A toggle, unlike BCL's held hotkey, would otherwise carry over into the next round.
    if (payload.gameState.gameState !== GameState.TASKS) this.radioPressed = false;
    // Follow the matched player by clientId so a color change in the lobby does not lose them.
    const tracked = this.trackedClientId === undefined
      ? undefined
      : payload.gameState.players.find((candidate) => candidate.clientId === this.trackedClientId && !candidate.disconnected);
    const player = tracked ?? (this.colorId === undefined
      ? findPlayerByName(payload.gameState.players, this.options.username)
      : findPlayerByColor(
          payload.gameState.players.filter((candidate) => !this.localBus?.isClaimedByOther(this.localKey, candidate.clientId)),
          this.colorId,
        ));
    if (!player) {
      this.localPlayer = undefined;
      this.applyImpostorRadio(); // a vanished transmitter must release the radio
      this.emit('status', this.colorId === undefined ? 'waiting-for-player-name' : 'waiting-for-player-color');
      return;
    }
    const wasMissing = !this.localPlayer;
    this.localPlayer = player;
    this.trackedClientId = player.clientId;
    this.localBus?.setClientId(this.localKey, player.clientId);
    this.applyImpostorRadio();
    if (!this.joinedGameRoom) this.joinGameRoom(player);
    else {
      // Tell BCL Desktop which player this voice now belongs to (e.g. after a color fix).
      if (player.clientId !== this.announcedClientId) this.announceIdentity(player);
      if (wasMissing) this.emit('status', 'connected');
    }
  }

  private announceIdentity(player: Player): void {
    this.announcedClientId = player.clientId;
    this.voiceSocket?.emit(
      'id',
      player.id,
      player.clientId,
      player.friendCode ?? '',
      player.playerUid ?? '',
      player.playerIdentifier ?? '',
    );
  }

  private joinGameRoom(player: Player): void {
    if (!this.voiceSocket?.connected || this.joinedGameRoom) return;
    this.joinedGameRoom = true;
    this.voiceSocket.emit('join', this.options.lobbyCode, player.id, player.clientId);
    this.announceIdentity(player);
    this.startMixClock();
    this.startStateWatchdog();
    this.emit('status', 'connected');
  }

  /**
   * setInterval(20) drifts badly on Windows, which starves or floods Discord's player.
   * Schedule against a wall clock and catch up on missed frames instead.
   */
  private startMixClock(): void {
    if (this.mixTimer) return;
    this.nextMixAt = performance.now();
    const tick = () => {
      const now = performance.now();
      if (this.lastTickAt) this.mixStats.maxTickGapMs = Math.max(this.mixStats.maxTickGapMs, Math.round(now - this.lastTickAt));
      this.lastTickAt = now;
      if (now - this.nextMixAt > 200) {
        this.nextMixAt = now; // resync after a long stall
        this.mixStats.resyncs += 1;
      }
      for (let frames = 0; this.nextMixAt <= now && frames < 5; frames += 1) {
        if (frames > 0) this.mixStats.catchUpFrames += 1;
        this.mixOneFrame();
        this.nextMixAt += FRAME_DURATION_MS;
      }
      this.mixTimer = setTimeout(tick, Math.max(1, this.nextMixAt - performance.now()));
    };
    tick();
  }

  /** Re-request the state feed if BCL Desktop stops sending it (it pauses after each match). */
  private startStateWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      const silentFor = Date.now() - this.lastStateAt;
      if (silentFor < 3_000) return;
      if (silentFor > 6_000) this.currentHost = undefined; // accept whichever host beacons next
      if (!this.currentHost) return;
      this.options.logger.info({ username: this.options.username, silentFor }, 'BCL state feed stalled; re-requesting');
      this.stateSocket?.emit('signal', {
        to: this.currentHost,
        data: { mobilePlayerInfo: { code: this.options.lobbyCode, askingForHost: true } },
      });
    }, 2_000);
  }

  private createPeer(id: string, initiator: boolean, replace = false): BclPeer {
    const existing = this.peers.get(id);
    if (existing && !replace) return existing;
    if (existing) {
      this.peers.delete(id);
      this.removeRemoteAudio(id);
      void existing.close();
    }
    const peer: BclPeer = new BclPeer({
      id,
      initiator,
      localTrack: this.localTrack,
      iceServers: this.peerConfig.iceServers,
      forceRelayOnly: this.peerConfig.forceRelayOnly,
      logger: this.options.logger,
      onSignal: (data) => this.voiceSocket?.emit('signal', { to: id, data }),
      onRemoteTrack: (track) => this.attachRemoteTrack(id, track),
      onData: (data) => this.handlePeerData(id, data),
      onClosed: () => {
        if (this.peers.get(id) === peer) this.removePeer(id);
      },
    });
    this.peers.set(id, peer);
    return peer;
  }

  private attachRemoteTrack(id: string, track: MediaStreamTrack): void {
    this.removeRemoteAudio(id);
    const decoder = new OpusCodec();
    const queue = this.mixer.addSource(id);
    this.remoteAudio.set(id, { decoder, queue });
    track.onReceiveRtp.subscribe((rtp) => {
      try {
        queue.push(decoder.decode(rtp.payload));
      } catch (error) {
        this.options.logger.debug({ peerId: id, error }, 'Dropped invalid BCL Opus packet');
      }
    });
  }

  /** BCL VoiceController.onPeerData: impostor radio toggles and the host's lobby settings. */
  private handlePeerData(peerId: string, raw: string | Buffer): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return; // Peer data is optional; ignore malformed or unrelated messages.
    }
    const clientId = this.clients.get(peerId)?.clientId;
    this.stateVersion += 1;
    if ('impostorRadio' in data && clientId !== undefined) {
      if (this.impostorRadioClientId === -1 && data.impostorRadio) this.impostorRadioClientId = clientId;
      else if (this.impostorRadioClientId === clientId && !data.impostorRadio) this.impostorRadioClientId = -1;
    }
    // Only the lobby host's settings count; other peers may broadcast stale ones.
    if ('maxDistance' in data && clientId !== undefined && clientId === this.state?.hostId) {
      this.lobbySettings = { ...defaultLobbySettings, ...(data as Partial<LobbySettings>) };
    }
  }

  /** Whoever is on the impostor radio: a bridged player (shared in-process) or a BCL peer. */
  private get effectiveRadioClientId(): number {
    const local = this.localBus?.radioClientId ?? -1;
    return local !== -1 ? local : this.impostorRadioClientId;
  }

  /** Toggles this player's impostor radio (the Discord button). Returns the resulting state. */
  toggleRadio(): RadioStatus {
    this.radioPressed = !this.radioPressed;
    this.applyImpostorRadio();
    return this.radioStatus();
  }

  radioStatus(): RadioStatus {
    if (this.radioTransmitting) return 'transmitting';
    if (!this.radioPressed) return 'off';
    const me = this.localPlayer;
    if (!this.lobbySettings.impostorRadioEnabled) return 'disabled';
    if (this.state?.gameState !== GameState.TASKS) return 'not-in-tasks';
    if (!me?.isImpostor || me.isDead) return 'not-impostor';
    return 'busy';
  }

  /** BCL VoiceController.applyImpostorRadio, with the Discord toggle standing in for the hotkey. */
  private applyImpostorRadio(): void {
    const me = this.localPlayer;
    const current = this.effectiveRadioClientId;
    const granted =
      this.radioPressed &&
      this.state?.gameState === GameState.TASKS &&
      me !== undefined &&
      me.isImpostor &&
      !me.isDead &&
      (current === -1 || current === me.clientId) &&
      this.lobbySettings.impostorRadioEnabled;
    if (granted === this.radioTransmitting) return;
    this.radioTransmitting = granted;
    this.localBus?.setRadioTransmitter(this.localKey, granted && me ? me.clientId : undefined);
    this.stateVersion += 1;
    const message = JSON.stringify({ impostorRadio: granted });
    for (const peer of this.peers.values()) peer.sendData(message);
    this.options.logger.info({ username: this.options.username, granted }, 'Impostor radio changed');
  }

  /** BCL VoiceController.updateGracePeriod: keep voices on briefly after a meeting (meetingGhostOnly). */
  private updateGracePeriod(current: GameState, previous: GameState | undefined): void {
    if (current === GameState.LOBBY || current === GameState.MENU || current === GameState.UNKNOWN) {
      this.gracePeriodEndsAt = 0;
      return;
    }
    if (current !== GameState.TASKS) return;
    if (previous !== GameState.LOBBY && previous !== GameState.DISCUSSION) return;
    const gracePeriod = Math.min(Math.max(Number(this.lobbySettings.gracePeriod) || 0, 0), 10);
    if (!this.lobbySettings.meetingGhostOnly || gracePeriod <= 0) return;
    this.gracePeriodEndsAt = Date.now() + gracePeriod * 1000;
  }

  /** BCL VoiceController.cleanupImpostorRadio: drop a transmitter that can no longer be on the radio. */
  private cleanupImpostorRadio(state: AmongUsState): void {
    if (this.impostorRadioClientId === -1) return;
    const stillActive =
      state.gameState === GameState.TASKS &&
      [...this.clients.entries()].some(
        ([peerId, identity]) => identity.clientId === this.impostorRadioClientId && this.remoteAudio.has(peerId),
      ) &&
      state.players.some(
        (player) =>
          player.clientId === this.impostorRadioClientId &&
          player.isImpostor &&
          !player.isDead &&
          !player.disconnected &&
          !player.bugged,
      );
    if (!stillActive) this.impostorRadioClientId = -1;
  }

  private takeMixStats(): Record<string, number> {
    const stats = { ...this.mixStats };
    this.mixStats.maxTickGapMs = 0; // per-sample peak
    return stats;
  }

  getDiagnostics(): Record<string, unknown> {
    const brief = (player?: Player) =>
      player && {
        name: player.name,
        colorId: player.colorId,
        clientId: player.clientId,
        x: Math.round(player.x * 100) / 100,
        y: Math.round(player.y * 100) / 100,
        isDead: player.isDead,
        disconnected: player.disconnected,
        isDummy: player.isDummy,
      };
    return {
      joinedGameRoom: this.joinedGameRoom,
      stateAgeMs: this.lastStateAt ? Date.now() - this.lastStateAt : null,
      gameState: this.state === undefined ? null : GameState[this.state.gameState],
      currentHost: this.currentHost ?? null,
      voiceSocketId: this.voiceSocket?.id ?? null,
      localPlayer: brief(this.localPlayer) ?? null,
      players: this.state?.players.map(brief) ?? [],
      peers: [...this.peers.entries()].map(([id, peer]) => ({
        id,
        state: peer.connectionState,
        clientId: this.clients.get(id)?.clientId ?? null,
        hasAudio: this.remoteAudio.has(id),
      })),
      clients: Object.fromEntries(this.clients),
      localSpeakers: this.localBus?.speakersFor(this.localKey) ?? [],
      lastGains: Object.fromEntries(this.lastGains),
      impostorRadioClientId: this.effectiveRadioClientId,
      radio: this.radioStatus(),
      inGracePeriod: this.gracePeriodEndsAt > Date.now(),
      lobbySettings: this.lobbySettings,
      queues: this.mixer.stats(),
      mix: this.takeMixStats(),
    };
  }

  private mixOneFrame(): void {
    const state = this.state;
    const listener = this.localPlayer;
    if (!state) return;
    // Right after a match, players reappear in the lobby one by one as each phone loads.
    // Everyone is standing together there, so play unplaced voices flat instead of muting.
    const inLobby = state.gameState === GameState.LOBBY;
    if (!listener && !inLobby) return;

    // state.currentCamera is the host's own camera view; a bridged phone player is never on cams.
    const listenerState: AmongUsState = { ...state, currentCamera: CameraLocation.NONE };
    const maxDistance = listener ? listenerMaxDistance(state, this.lobbySettings, listener) : this.lobbySettings.maxDistance;
    const inGracePeriod = this.gracePeriodEndsAt > Date.now();
    const settings = defaultListenerAudioSettings;

    const paramsFor = (clientId: number | undefined): VoiceParams | undefined => {
      const speaker = clientId === undefined
        ? undefined
        : state.players.find((candidate) => candidate.clientId === clientId);
      if (!listener || !speaker) {
        return inLobby ? { left: LOBBY_FALLBACK_GAIN, right: LOBBY_FALLBACK_GAIN, muffle: false, reverb: false } : undefined;
      }
      if (speaker.clientId === listener.clientId) return undefined;
      const result = calculateVoiceAudio({
        state: listenerState,
        settings,
        activeLobbySettings: this.lobbySettings,
        me: listener,
        other: speaker,
        maxDistance,
        impostorRadioClientId: this.effectiveRadioClientId,
        inGracePeriod,
      });
      const gain = applyListenerVolume(result.gain, settings, listener, speaker);
      const pan = result.panPosition ? pannerGains(result.panPosition, maxDistance) : { left: 0, right: 0 };
      return { left: pan.left * gain, right: pan.right * gain, muffle: result.muffle, reverb: result.reverb };
    };

    // Like BCL Desktop, evaluate the rules when the game state changes, not every 20 ms frame.
    const remotes = [...this.clients].filter(([peerId]) => this.remoteAudio.has(peerId));
    const locals = this.localBus?.speakersFor(this.localKey, true) ?? [];
    const key = [
      this.stateVersion,
      this.effectiveRadioClientId,
      inGracePeriod,
      listener?.clientId,
      remotes.map(([peerId, identity]) => `${peerId}:${identity.clientId}`).join(','),
      locals.map((local) => `${local.sourceId}:${local.clientId}`).join(','),
    ].join('|');
    if (key !== this.cachedParamsKey) {
      const params = new Map<string, VoiceParams>();
      for (const [peerId, identity] of remotes) {
        const voice = paramsFor(identity.clientId);
        if (voice) params.set(peerId, voice);
      }
      for (const local of locals) {
        const voice = paramsFor(local.clientId);
        if (voice) params.set(local.sourceId, voice);
      }
      this.cachedParams = params;
      this.cachedParamsKey = key;
    }
    const params = this.cachedParams;
    this.lastGains = new Map(
      [...params].map(([id, voice]) => [id, Math.round(Math.max(voice.left, voice.right) * 1000) / 1000]),
    );
    try {
      this.emit('mixedOpus', this.outputEncoder.encode(this.mixer.mix(params)));
    } catch (error) {
      this.handleError(error);
    }
  }
  private replaceClients(clients: Record<string, ClientIdentity>): void {
    const next = new Set(Object.keys(clients));
    for (const id of this.clients.keys()) {
      if (!next.has(id)) this.removePeer(id);
    }
    this.clients.clear();
    for (const [id, client] of Object.entries(clients)) this.clients.set(id, client);
  }

  private removeRemoteAudio(id: string): void {
    const remote = this.remoteAudio.get(id);
    remote?.decoder.close();
    this.remoteAudio.delete(id);
    this.mixer.removeSource(id);
  }

  private removePeer(id: string): void {
    const peer = this.peers.get(id);
    this.peers.delete(id);
    this.clients.delete(id);
    this.removeRemoteAudio(id);
    if (peer) void peer.close();
  }

  private async destroyPeers(): Promise<void> {
    const peers = [...this.peers.values()];
    this.peers.clear();
    await Promise.allSettled(peers.map((peer) => peer.close()));
    for (const id of [...this.remoteAudio.keys()]) this.removeRemoteAudio(id);
  }

  private handleError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.options.logger.error({ error: normalized }, 'BCL bridge error');
    this.emit('error', normalized);
  }

  private emitGameInfo(socket: Socket): void {
    socket.emit('gameinfo', {
      appVersion: '3.2.2-discord-bridge',
      broadcastVersion: -1,
      offsetsVersion: -1,
      is64bit: true,
      platform: 'web',
      mod: 'NONE',
      mods: [],
    });
  }
}
