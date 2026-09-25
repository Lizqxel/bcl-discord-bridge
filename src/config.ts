import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';

loadDotEnv();

const environmentSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
  DISCORD_VOICE_BOT_TOKENS: z.string().optional().default(''),
  DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/, 'DISCORD_APPLICATION_ID must be a Discord snowflake'),
  BETTERCREWLINK_SERVER: z.url().default('https://bettercrewl.ink'),
  UI_PORT: z.coerce.number().int().min(1024).max(65535).default(38472),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type BridgeConfig = {
  discordBotToken: string;
  discordVoiceBotTokens: string[];
  discordApplicationId: string;
  betterCrewLinkServer: string;
  uiPort: number;
  logLevel: z.infer<typeof environmentSchema>['LOG_LEVEL'];
};

export function readConfig(environment: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = environmentSchema.parse(environment);
  const discordVoiceBotTokens = parsed.DISCORD_VOICE_BOT_TOKENS
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && token !== parsed.DISCORD_BOT_TOKEN);
  return {
    discordBotToken: parsed.DISCORD_BOT_TOKEN,
    discordVoiceBotTokens: [...new Set(discordVoiceBotTokens)],
    discordApplicationId: parsed.DISCORD_APPLICATION_ID,
    betterCrewLinkServer: parsed.BETTERCREWLINK_SERVER,
    uiPort: parsed.UI_PORT,
    logLevel: parsed.LOG_LEVEL,
  };
}
