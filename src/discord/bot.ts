import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  Interaction,
  MessageFlags,
  GatewayIntentBits,
  Guild,
  GuildMember,
  OverwriteType,
  PermissionFlagsBits,
  VoiceBasedChannel,
} from 'discord.js';
import { appendFileSync, statSync, truncateSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { RadioStatus } from '../bcl/client.js';
import { LocalAudioBus } from '../bcl/local-bus.js';
import { BridgeSession } from './session.js';
import type { Logger } from '../logger.js';

export type BridgeBotOptions = { tokens: string[]; bclServer: string; logger: Logger };
export type RoundAssignment = { userId: string; colorId: number; colorName: string };
export type StartRoundInput = {
  guildId: string;
  waitingChannelId: string;
  lobbyCode: string;
  assignments: RoundAssignment[];
};

type Worker = { client: Client; token: string };
type ActiveParticipant = {
  userId: string;
  username: string;
  displayName: string;
  colorId: number;
  colorName: string;
  channelId: string;
  session: BridgeSession;
};
type ActiveRound = {
  guildId: string;
  waitingChannelId: string;
  lobbyCode: string;
  startedAt: number;
  participants: ActiveParticipant[];
};

const AMONG_US_COLORS = [
  '赤', '青', '緑', 'ピンク', 'オレンジ', '黄', '黒', '白', '紫',
  '茶', 'シアン', 'ライム', 'マルーン', 'ローズ', 'バナナ', 'グレー', 'タン', 'コーラル',
] as const;

export type DashboardSnapshot = {
  ready: boolean;
  configuredBots: number;
  onlineBots: number;
  guilds: Array<{
    id: string;
    name: string;
    iconUrl: string | null;
    capacity: number;
    voiceChannels: Array<{
      id: string;
      name: string;
      participantCount: number;
      participants: Array<{
        id: string;
        displayName: string;
        username: string;
        avatarUrl: string | null;
      }>;
    }>;
  }>;
  activeRounds: Array<{
    guildId: string;
    waitingChannelId: string;
    lobbyCode: string;
    startedAt: number;
    participants: Array<{
      userId: string;
      username: string;
      displayName: string;
      colorId: number;
      colorName: string;
      channelId: string;
      status: string;
      radio: RadioStatus;
    }>;
  }>;
};

// Periodic per-player snapshots so post-match audio loss can be diagnosed after the fact.
const DIAGNOSTICS_FILE = new URL('../../diagnostics.jsonl', import.meta.url);
const DIAGNOSTICS_MAX_BYTES = 20 * 1024 * 1024;

const MANAGER_PERMISSIONS = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];
const VOICE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];
// Needed only for the radio button. Discord refuses channel overwrites that grant permissions the
// bot lacks server-wide, so these are added only when the manager already has them.
const RADIO_CHAT_PERMISSIONS = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
const RADIO_BUTTON_PREFIX = 'bcl-radio:';

const RADIO_REPLIES: Record<RadioStatus, string> = {
  transmitting: '📻 無線ON：いまの声はインポスターだけに届きます。もう一度押すとOFFです。',
  off: '🔇 無線OFF：普段の近接ボイスに戻りました。',
  disabled: '⏳ 無線待機中：ロビー設定でインポスター無線が有効になっていません。',
  'not-in-tasks': '⏳ 無線待機中：タスク中になると自動でONになります（会議やロビーでは使えません）。',
  'not-impostor': '⏳ 無線待機中：生きているインポスターだけが使えます。',
  busy: '⏳ 無線待機中：ほかのインポスターが無線を使っています。空いたら自動でONになります。',
};

export class BridgeBot {
  private readonly workers: Worker[];
  private readonly activeRounds = new Map<string, ActiveRound>();
  private started = false;
  private diagnosticsTimer?: NodeJS.Timeout;
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 10 });

  constructor(private readonly options: BridgeBotOptions) {
    this.workers = options.tokens.map((token, index) => {
      const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
      client.once(Events.ClientReady, (readyClient) => {
        options.logger.info({ index: index + 1, bot: readyClient.user.tag }, 'Discord voice bot ready');
        if (index === 0) {
          void Promise.allSettled(
            readyClient.guilds.cache.map((guild) => guild.commands.set([])),
          );
        }
      });
      if (index === 0) {
        client.on(Events.InteractionCreate, (interaction) => void this.handleInteraction(interaction));
      }
      client.on(Events.Error, (error) => {
        options.logger.error({ index: index + 1, error }, 'Discord client error');
      });
      return { client, token };
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.loopDelay.enable();
    this.diagnosticsTimer = setInterval(() => this.writeDiagnostics(), 5_000);
    const results = await Promise.allSettled(this.workers.map((worker) => worker.client.login(worker.token)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length === this.workers.length) {
      this.started = false;
      throw new Error('Discord Botへログインできませんでした。トークンを確認してください。');
    }
    for (const failure of failures) {
      this.options.logger.error({ error: failure.reason }, 'A Discord voice bot failed to login');
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.activeRounds.keys()].map((guildId) => this.stopRound(guildId)));
    if (this.diagnosticsTimer) clearInterval(this.diagnosticsTimer);
    for (const worker of this.workers) worker.client.destroy();
    this.started = false;
  }

  getSnapshot(): DashboardSnapshot {
    const manager = this.manager;
    return {
      ready: Boolean(manager?.isReady()),
      configuredBots: this.workers.length,
      onlineBots: this.workers.filter((worker) => worker.client.isReady()).length,
      guilds: manager?.isReady() ? manager.guilds.cache.map((guild) => this.guildSnapshot(guild)) : [],
      activeRounds: [...this.activeRounds.values()].map((round) => ({
        guildId: round.guildId,
        waitingChannelId: round.waitingChannelId,
        lobbyCode: round.lobbyCode,
        startedAt: round.startedAt,
        participants: round.participants.map((participant) => ({
          userId: participant.userId,
          username: participant.username,
          displayName: participant.displayName,
          colorId: participant.colorId,
          colorName: participant.colorName,
          channelId: participant.channelId,
          status: participant.session.getStatus(),
          radio: participant.session.radioStatus(),
        })),
      })),
    };
  }

  private writeDiagnostics(): void {
    if (this.activeRounds.size === 0) return;
    try {
      if ((statSync(DIAGNOSTICS_FILE, { throwIfNoEntry: false })?.size ?? 0) > DIAGNOSTICS_MAX_BYTES) truncateSync(DIAGNOSTICS_FILE);
      const eventLoop = {
        p99Ms: Math.round(this.loopDelay.percentile(99) / 1e6),
        maxMs: Math.round(this.loopDelay.max / 1e6),
      };
      this.loopDelay.reset();
      appendFileSync(DIAGNOSTICS_FILE, JSON.stringify({ time: new Date().toISOString(), eventLoop, rounds: this.getDiagnostics() }) + '\n');
    } catch (error) {
      this.options.logger.warn({ error }, 'Failed to write diagnostics');
    }
  }

  getDiagnostics(): unknown {
    return [...this.activeRounds.values()].map((round) => ({
      lobbyCode: round.lobbyCode,
      participants: round.participants.map((participant) => participant.session.getDiagnostics()),
    }));
  }

  async startRound(input: StartRoundInput): Promise<void> {
    if (!/^\d+$/.test(input.guildId) || !/^\d+$/.test(input.waitingChannelId)) {
      throw new Error('Discordサーバーまたは待機VCが正しくありません。');
    }
    if (this.activeRounds.has(input.guildId)) throw new Error('このサーバーでは既にゲームを開始しています。');
    if (!/^[A-Z]{4,8}$/.test(input.lobbyCode)) throw new Error('Among Usのロビーコードを確認してください。');
    if (input.assignments.length === 0) throw new Error('中継する人を1人以上選んでください。');
    if (new Set(input.assignments.map((item) => item.userId)).size !== input.assignments.length) {
      throw new Error('同じDiscordメンバーが重複しています。');
    }
    if (new Set(input.assignments.map((item) => item.colorId)).size !== input.assignments.length) {
      throw new Error('Among Usの色が重複しています。');
    }
    for (const assignment of input.assignments) {
      if (!/^\d+$/.test(assignment.userId)) throw new Error('Discordメンバーが正しくありません。');
      const colorName = AMONG_US_COLORS[assignment.colorId];
      if (!Number.isInteger(assignment.colorId) || !colorName) {
        throw new Error('Among Usの色が正しくありません。');
      }
      assignment.colorName = colorName;
    }

    const manager = this.manager;
    if (!manager?.isReady()) throw new Error('管理BotがまだDiscordへ接続していません。');
    const guild = await manager.guilds.fetch(input.guildId);
    const waitingChannel = await guild.channels.fetch(input.waitingChannelId);
    if (!waitingChannel?.isVoiceBased()) throw new Error('待機ボイスチャンネルが見つかりません。');
    this.assertManagerPermissions(guild);

    const availableWorkers = this.workers.filter(
      (worker) => worker.client.isReady() && worker.client.guilds.cache.has(input.guildId),
    );
    if (input.assignments.length > availableWorkers.length) {
      throw new Error(`Botが足りません。選択は${input.assignments.length}人、使用可能なBotは${availableWorkers.length}体です。`);
    }

    const selected: Array<{ assignment: RoundAssignment; member: GuildMember }> = [];
    for (const assignment of input.assignments) {
      const member = await guild.members.fetch(assignment.userId);
      if (member.user.bot) throw new Error(`${member.displayName}はBotのため選択できません。`);
      if (member.voice.channelId !== waitingChannel.id) {
        throw new Error(`${member.displayName}が待機VCにいません。画面を更新してやり直してください。`);
      }
      selected.push({ assignment, member });
    }

    const round: ActiveRound = {
      guildId: guild.id,
      waitingChannelId: waitingChannel.id,
      lobbyCode: input.lobbyCode,
      startedAt: Date.now(),
      participants: [],
    };
    this.activeRounds.set(guild.id, round);
    const createdChannelIds: string[] = [];
    const localBus = new LocalAudioBus();
    const radioChat = Boolean(guild.members.me?.permissions.has(RADIO_CHAT_PERMISSIONS));
    if (!radioChat) {
      this.options.logger.warn(
        { guildId: guild.id },
        'Manager bot lacks Send Messages / Read Message History; the impostor radio button is disabled',
      );
    }

    try {
      for (let index = 0; index < selected.length; index += 1) {
        const item = selected[index]!;
        const worker = availableWorkers[index]!;
        const botId = worker.client.user!.id;
        const safeName = item.member.displayName.replace(/[\r\n]/g, ' ').slice(0, 32);
        const channel = await guild.channels.create({
          name: `🚀 ${item.assignment.colorName}・${safeName}`,
          type: ChannelType.GuildVoice,
          parent: waitingChannel.parentId,
          userLimit: 2,
          reason: 'BCL Bridgeのゲーム開始',
          permissionOverwrites: [
            // Explicit types: worker bots are not in the manager's member cache.
            { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
            {
              id: item.member.id,
              type: OverwriteType.Member,
              allow: radioChat ? [...VOICE_PERMISSIONS, PermissionFlagsBits.ReadMessageHistory] : VOICE_PERMISSIONS,
            },
            { id: botId, type: OverwriteType.Member, allow: VOICE_PERMISSIONS },
            {
              id: manager.user!.id,
              type: OverwriteType.Member,
              allow: radioChat ? [...MANAGER_PERMISSIONS, ...RADIO_CHAT_PERMISSIONS] : MANAGER_PERMISSIONS,
            },
          ],
        });
        createdChannelIds.push(channel.id);
        const workerGuild = await worker.client.guilds.fetch(guild.id);
        const workerChannel = await workerGuild.channels.fetch(channel.id);
        if (!workerChannel?.isVoiceBased()) throw new Error('作成した専用VCをBotが開けませんでした。');

        const session = await BridgeSession.create({
          channel: workerChannel,
          userId: item.member.id,
          username: item.member.displayName,
          playerColorId: item.assignment.colorId,
          lobbyCode: input.lobbyCode,
          connectionGroup: `bcl-${worker.client.user!.id}`,
          bclServer: this.options.bclServer,
          localBus,
          logger: this.options.logger.child({ guildId: guild.id, userId: item.member.id }),
        });
        round.participants.push({
          userId: item.member.id,
          username: item.member.user.username,
          displayName: item.member.displayName,
          colorId: item.assignment.colorId,
          colorName: item.assignment.colorName,
          channelId: channel.id,
          session,
        });
        if (radioChat) await this.postRadioButton(channel, item.member.id);
        await item.member.voice.setChannel(channel, 'BCL Bridgeのゲーム開始');
      }
      this.options.logger.info(
        { guildId: guild.id, players: round.participants.length, lobby: input.lobbyCode },
        'BCL round started',
      );
    } catch (error) {
      await this.stopRound(guild.id);
      for (const channelId of createdChannelIds) {
        const orphan = await guild.channels.fetch(channelId).catch(() => null);
        if (orphan) await orphan.delete('BCL Bridgeの開始失敗をロールバック').catch(() => undefined);
      }
      throw error;
    }
  }

  /** Fixes one player's in-game color mid-round; everyone else keeps talking. */
  async recolor(guildId: string, userId: string, colorId: number): Promise<void> {
    const round = this.activeRounds.get(guildId);
    if (!round) throw new Error('このサーバーではゲームが始まっていません。');
    const participant = round.participants.find((item) => item.userId === userId);
    if (!participant) throw new Error('その人は中継されていません。');
    const colorName = AMONG_US_COLORS[colorId];
    if (!Number.isInteger(colorId) || !colorName) throw new Error('Among Usの色が正しくありません。');
    if (participant.colorId === colorId) return;
    participant.colorId = colorId;
    participant.colorName = colorName;
    participant.session.setPlayerColor(colorId);
    this.options.logger.info({ guildId, userId, colorName }, 'Bridge player color changed');
    // Cosmetic; Discord rate-limits renames, so never block or fail on it.
    const channel = this.manager?.guilds.cache.get(guildId)?.channels.cache.get(participant.channelId);
    const safeName = participant.displayName.replace(/[\r\n]/g, ' ').slice(0, 32);
    void channel?.setName(`🚀 ${colorName}・${safeName}`).catch(() => undefined);
  }

  /** Posts the impostor radio toggle in the private VC's text chat (phones cannot press a hotkey). */
  private async postRadioButton(channel: VoiceBasedChannel, userId: string): Promise<void> {
    try {
      const button = new ButtonBuilder()
        .setCustomId(RADIO_BUTTON_PREFIX + userId)
        .setLabel('📻 インポスター無線 ON / OFF')
        .setStyle(ButtonStyle.Danger);
      await channel.send({
        content:
          'インポスターのときは、このボタンで**インポスター無線**をON/OFFできます（BetterCrewLinkのロビー設定で無線が有効な場合のみ）。\n' +
          '会議やロビーに入ると自動でOFFになります。',
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
      });
    } catch (error) {
      // The radio is optional; never fail a round because the chat message could not be posted.
      this.options.logger.warn({ error, channelId: channel.id }, 'Could not post the radio button');
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() || !interaction.customId.startsWith(RADIO_BUTTON_PREFIX)) return;
    try {
      await this.handleRadioButton(interaction);
    } catch (error) {
      this.options.logger.warn({ error }, 'Radio button failed');
    }
  }

  private async handleRadioButton(interaction: ButtonInteraction): Promise<void> {
    const userId = interaction.customId.slice(RADIO_BUTTON_PREFIX.length);
    const participant = interaction.guildId
      ? this.activeRounds.get(interaction.guildId)?.participants.find((item) => item.userId === userId)
      : undefined;
    const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    if (!participant) return void (await reply('このゲームはもう終了しています。'));
    if (interaction.user.id !== userId) {
      return void (await reply(`これは ${participant.displayName} さん用のボタンです。`));
    }
    await reply(RADIO_REPLIES[participant.session.toggleRadio()]);
  }

  async stopRound(guildId: string): Promise<void> {
    const round = this.activeRounds.get(guildId);
    if (!round) return;
    this.activeRounds.delete(guildId);
    const guild = this.manager?.guilds.cache.get(guildId);
    const waitingChannel = guild
      ? await guild.channels.fetch(round.waitingChannelId).catch(() => null)
      : null;

    for (const participant of round.participants) {
      await participant.session.close().catch((error: unknown) => {
        this.options.logger.warn({ error, userId: participant.userId }, 'Failed to close a bridge session');
      });
      if (guild && waitingChannel?.isVoiceBased()) {
        const member = await guild.members.fetch(participant.userId).catch(() => null);
        if (member?.voice.channelId === participant.channelId) {
          await member.voice.setChannel(waitingChannel, 'BCL Bridgeのゲーム終了').catch((error: unknown) => {
            this.options.logger.warn({ error, userId: participant.userId }, 'Failed to return member to waiting VC');
          });
        }
      }
      if (guild) {
        const channel = await guild.channels.fetch(participant.channelId).catch(() => null);
        if (channel) {
          await channel.delete('BCL Bridgeのゲーム終了').catch((error: unknown) => {
            this.options.logger.warn({ error, channelId: participant.channelId }, 'Failed to delete temporary VC');
          });
        }
      }
    }
    this.options.logger.info({ guildId }, 'BCL round stopped');
  }

  private get manager(): Client | undefined {
    return this.workers[0]?.client;
  }

  private guildSnapshot(guild: Guild): DashboardSnapshot['guilds'][number] {
    const capacity = this.workers.filter(
      (worker) => worker.client.isReady() && worker.client.guilds.cache.has(guild.id),
    ).length;
    const voiceChannels = guild.channels.cache
      .filter((channel): channel is VoiceBasedChannel => channel.isVoiceBased() && channel.type !== ChannelType.GuildStageVoice)
      .map((channel) => {
        const participants = channel.members
          .filter((member) => !member.user.bot)
          .map((member) => ({
            id: member.id,
            displayName: member.displayName,
            username: member.user.username,
            avatarUrl: member.displayAvatarURL({ size: 64 }),
          }));
        return { id: channel.id, name: channel.name, participantCount: participants.length, participants };
      })
      .filter((channel) => channel.participantCount > 0)
      .sort((left, right) => left.name.localeCompare(right.name, 'ja'));
    return { id: guild.id, name: guild.name, iconUrl: guild.iconURL({ size: 64 }), capacity, voiceChannels };
  }

  private assertManagerPermissions(guild: Guild): void {
    if (!guild.members.me?.permissions.has(MANAGER_PERMISSIONS)) {
      throw new Error('管理Botに「チャンネルの管理・メンバーを移動・VC接続・発言」の権限が必要です。');
    }
  }
}
