import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

describe('readConfig', () => {
  it('loads unique worker bot tokens and excludes the manager token', () => {
    const config = readConfig({
      DISCORD_BOT_TOKEN: 'manager',
      DISCORD_VOICE_BOT_TOKENS: 'worker-a, worker-b\nworker-a manager',
      DISCORD_APPLICATION_ID: '1553088810504691722',
      BETTERCREWLINK_SERVER: 'https://bettercrewl.ink',
      UI_PORT: '38472',
      LOG_LEVEL: 'info',
    });
    expect(config.discordVoiceBotTokens).toEqual(['worker-a', 'worker-b']);
  });
});
