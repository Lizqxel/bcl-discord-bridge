import { readConfig } from './config.js';
import { BridgeBot } from './discord/bot.js';
import { createLogger } from './logger.js';
import { DashboardServer } from './ui/server.js';

const config = readConfig();
const logger = createLogger(config.logLevel);
const bot = new BridgeBot({
  tokens: [config.discordBotToken, ...config.discordVoiceBotTokens],
  bclServer: config.betterCrewLinkServer,
  logger,
});
const dashboard = new DashboardServer(bot, config.uiPort, logger, () => shutdown('dashboard'));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down bridge');
  // Rounds first: members go back to the waiting VC and temp VCs are deleted.
  await bot.stop();
  await dashboard.stop();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  await bot.start();
  await dashboard.start(true);
}

main().catch((error) => {
  logger.fatal({ error }, 'Bridge failed to start');
  process.exitCode = 1;
});
