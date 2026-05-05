import pino from 'pino';
import { env } from './config.js';

const isDev = env.NODE_ENV !== 'production';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Always redact API keys defensively.
  redact: {
    paths: ['*.apiKey', '*.api_key', 'apiKey', 'authorization', 'headers.authorization'],
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});
