import pino from 'pino';
import { env } from './config.js';

const isDev = env.NODE_ENV !== 'production';
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: ['*.apiKey', '*.api_key', 'apiKey'], censor: '[REDACTED]' },
  ...(isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});
