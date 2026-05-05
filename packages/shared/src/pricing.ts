import { z } from 'zod';

export const pricingConfigSchema = z.object({
  asOf: z.string(),
  currency: z.string().default('USD'),
  rates: z.object({
    readUnit: z.number().nonnegative(),
    writeUnit: z.number().nonnegative(),
    storageGBMonth: z.number().nonnegative(),
  }),
  operationCosts: z.object({
    listRUPerCall: z.number().nonnegative(),
    listIdsPerCall: z.number().int().positive(),
    fetchRUPer10Records: z.number().nonnegative(),
    fetchMinRU: z.number().nonnegative(),
    queryMinRU: z.number().nonnegative(),
    queryRUPerGBNamespace: z.number().nonnegative(),
    upsertWUPerKB: z.number().nonnegative(),
    upsertMinWUPerRequest: z.number().nonnegative(),
    updateWUPerKB: z.number().nonnegative(),
    updateMinWUPerRequest: z.number().nonnegative(),
    deleteWUPerKB: z.number().nonnegative(),
    deleteMinWUPerRequest: z.number().nonnegative(),
  }),
  limits: z.object({
    fetchMaxIdsPerRequest: z.number().int().positive(),
    upsertMaxRecordsPerRequest: z.number().int().positive(),
    upsertMaxBytesPerRequest: z.number().int().positive(),
    upsertMaxBytesPerSecondPerNamespace: z.number().int().positive(),
    listIdsMaxPerCall: z.number().int().positive(),
    perNamespaceQPS: z.object({
      query: z.number().int().positive(),
      upsert: z.number().int().positive(),
      update: z.number().int().positive(),
      delete: z.number().int().positive(),
    }),
    perIndexQPS: z.object({
      fetch: z.number().int().positive(),
      list: z.number().int().positive(),
      describeIndexStats: z.number().int().positive(),
    }),
  }),
});

export type PricingConfig = z.infer<typeof pricingConfigSchema>;
