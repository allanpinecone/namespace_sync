import type { FastifyInstance } from 'fastify';

/**
 * Route plugins receive this instead of default FastifyInstance — otherwise TypeScript
 * mismatches `loggerInstance: Pino` against Fastify's default FastifyBaseLogger generic.
 */
export type AppInstance = FastifyInstance<any, any, any, any, any>;
