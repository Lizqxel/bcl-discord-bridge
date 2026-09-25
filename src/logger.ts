import pino from 'pino';

export function createLogger(level: pino.LevelWithSilent = 'info') {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
