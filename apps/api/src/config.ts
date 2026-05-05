import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { pricingConfigSchema, type PricingConfig } from '@migrator/shared';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().default(4000),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  DATABASE_URL: z.string().default('postgres://migrator:migrator@localhost:5432/migrator'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('pinecone-migrator'),
  MIGRATOR_MASTER_KEY: z.string().min(8).default('dev-master-key-change-me-please-32+'),
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:3000,http://127.0.0.1:3000'),
  PRICING_CONFIG_PATH: z.string().default(''),
});

export const env = envSchema.parse(process.env);

const findPricingConfig = (): string => {
  if (env.PRICING_CONFIG_PATH) return env.PRICING_CONFIG_PATH;
  // Walk up to find config/pricing.json from this file's location.
  const candidates = [
    resolve(process.cwd(), 'config/pricing.json'),
    resolve(process.cwd(), '../../config/pricing.json'),
    resolve(import.meta.dirname ?? '.', '../../../config/pricing.json'),
  ];
  for (const p of candidates) {
    try {
      readFileSync(p, 'utf8');
      return p;
    } catch {
      /* keep looking */
    }
  }
  return candidates[0]!;
};

export function loadPricing(): PricingConfig {
  const path = findPricingConfig();
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return pricingConfigSchema.parse(raw);
}
