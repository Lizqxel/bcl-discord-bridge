import { PassThrough } from 'node:stream';
import {
  AudioPlayer,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { VoiceBasedChannel } from 'discord.js';
import { BclClient } from '../bcl/client.js';
import type { LocalAudioBus } from '../bcl/local-bus.js';
import type { Logger } from '../logger.js';

export type SessionOptions = {
  channel: VoiceBasedChannel;
  userId: string;
  username: string;
  playerColorId?: number;
  lobbyCode: string;
  connectionGroup?: string;
  bclServer: string;
  localBus?: LocalAudioBus;
  logger: Logger;
};

export class BridgeSession {
  readonly guildId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly username: string;
  readonly lobbyCode: string;
  private readonly connection: VoiceConnection;
  private readonly player: AudioPlayer;
  private readonly output = new PassThrough({ objectMode: true, highWaterMark: 100 });
  private readonly bcl: BclClient;
  private status = 'starting';
  private closed = false;
  private outputDrops = 0;
  private receiving = false;

  private constructor(private readonly options: SessionOptions) {
    this.guildId = options.channel.guild.id;
    this.channelId = options.channel.id;
    this.userId = options.userId;
    this.username = options.username;
    this.lobbyCode = options.lobbyCode;

    this.connection = joinVoiceChannel({
      channelId: options.channel.id,
      guildId: options.channel.guild.id,
      adapterCreator: options.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      group: options.connectionGroup,
    });
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.connection.subscribe(this.player);
    this.player.play(createAudioResource(this.output, { inputType: StreamType.Opus }));

    this.bcl = new BclClient({
      serverUrl: options.bclServer,
      lobbyCode: options.lobbyCode,
      username: options.username,
      playerColorId: options.playerColorId,
      localBus: options.localBus,
      localKey: options.userId,
      logger: options.logger.child({ guildId: this.guildId, userId: this.userId }),
    });
    this.bcl.on('status', (status) => {
      this.status = status;
    });
    this.bcl.on('mixedOpus', (packet) => {
      // Drop instead of queueing so delay never accumulates behind a slow reader.
      if (this.closed) return;
      if (this.output.readableLength < 10) this.output.write(packet);
      else this.outputDrops += 1;
    });
    this.bcl.on('error', (error) => {
      this.status = `error: ${error.message}`;
    });

    this.connection.receiver.speaking.on('start', (userId) => {
      if (userId !== this.userId || this.closed) return;
      this.bcl.setSpeaking(true);
      // receiver.subscribe() returns the live stream if one exists; attaching again
      // would push every packet twice (robotic, choppy audio).
      if (this.receiving) return;
      this.receiving = true;
      const stream = this.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1_000 },
      });
      stream.once('close', () => {
        this.receiving = false;
      });
      stream.on('data', (packet: Buffer) => this.bcl.pushMicrophoneOpus(packet));
      stream.on('error', (error) => options.logger.warn({ error, userId }, 'Discord receive stream failed'));
    });
    this.connection.receiver.speaking.on('end', (userId) => {
      if (userId === this.userId) this.bcl.setSpeaking(false);
    });
  }

  static async create(options: SessionOptions): Promise<BridgeSession> {
    const session = new BridgeSession(options);
    await entersState(session.connection, VoiceConnectionStatus.Ready, 20_000);
    session.bcl.connect();
    return session;
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      username: this.username,
      status: this.status,
      outputBacklog: this.output.readableLength,
      outputDrops: this.outputDrops,
      ...this.bcl.getDiagnostics(),
    };
  }

  setPlayerColor(colorId: number): void {
    this.bcl.setPlayerColor(colorId);
  }

  getStatus(): string {
    return this.status;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.output.end();
    this.player.stop(true);
    await this.bcl.disconnect();
    this.connection.destroy();
    this.status = 'disconnected';
  }
}
