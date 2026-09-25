import { SlashCommandBuilder } from 'discord.js';

export const bridgeCommands = [
  new SlashCommandBuilder()
    .setName('bcl-connect')
    .setDescription('自分のDiscord音声をBetterCrewLinkへ接続します')
    .addStringOption((option) =>
      option.setName('name').setDescription('Among Us内の自分の名前（完全一致）').setRequired(true).setMaxLength(30),
    )
    .addStringOption((option) =>
      option
        .setName('code')
        .setDescription('Among Usのロビーコード')
        .setRequired(true)
        .setMinLength(4)
        .setMaxLength(10),
    ),
  new SlashCommandBuilder().setName('bcl-disconnect').setDescription('BetterCrewLink中継を切断します'),
  new SlashCommandBuilder().setName('bcl-status').setDescription('現在の中継状態を確認します'),
].map((command) => command.toJSON());
