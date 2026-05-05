import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('postgres://migrator:migrator@localhost:5432/migrator'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('pinecone-migrator-worker'),
  MIGRATOR_MASTER_KEY: z.string().min(8).default('dev-master-key-change-me-please-32+'),
  WORKER_COPY_CONCURRENCY: z.coerce.number().int().default(8),
  WORKER_VERIFY_CONCURRENCY: z.coerce.number().int().default(2),
  WORKER_SYNC_POLL_CONCURRENCY: z.coerce.number().int().default(4),
  /**
   * Hard cap on concurrent in-flight fetch+upsert batches per namespace, regardless of what
   * a job's stored config says. Protects against legacy jobs that were saved with very high
   * `maxRequestsPerNamespace` (default used to be 30, which can trigger sustained 429s).
   */
  WORKER_MAX_INFLIGHT_PER_NS: z.coerce.number().int().min(1).max(64).default(8),
});

export const env = envSchema.parse(process.env);
