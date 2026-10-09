import { z } from 'zod';

export const configVersion = 1 as const;

const networkConfigSchema = z
  .object({
    bindAddress: z.string().ip().default('0.0.0.0'),
    port: z.number().int().min(1).max(65_535).default(8080),
    mdnsEnabled: z.boolean().default(true),
  })
  .strict()
  .default({});

const timingConfigSchema = z
  .object({
    bridgeTimeoutMs: z.number().int().min(100).max(30_000).default(1500),
    handshakeTimeoutMs: z.number().int().min(1000).max(30_000).default(5000),
    heartbeatIntervalMs: z.number().int().min(1000).max(300_000).default(15_000),
    heartbeatResponseTimeoutMs: z.number().int().min(500).max(300_000).default(5000),
    ephemeralInactivityMs: z.number().int().min(60_000).max(86_400_000).default(1_800_000),
    speakHoldMs: z.number().int().min(250).max(60_000).default(4000),
    updateIntervalMs: z.number().int().min(0).max(1000).default(50),
  })
  .strict()
  .default({});

const capacityConfigSchema = z
  .object({
    maxChannels: z.number().int().min(1).max(1024).default(32),
    maxPendingHandshakes: z.number().int().min(1).max(1024).default(32),
    maxFailedAuthPerMinute: z.number().int().min(1).max(10_000).default(30),
  })
  .strict()
  .default({});

const loggingConfigSchema = z
  .object({
    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    retentionDays: z.number().int().min(1).max(90).default(7),
  })
  .strict()
  .default({});

export const publisherConfigSchema = z
  .object({
    v: z.literal(configVersion).default(configVersion),
    network: networkConfigSchema,
    timing: timingConfigSchema,
    capacity: capacityConfigSchema,
    logging: loggingConfigSchema,
  })
  .strict()
  .superRefine((config, context) => {
    if (config.timing.heartbeatResponseTimeoutMs >= config.timing.heartbeatIntervalMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'heartbeatResponseTimeoutMs must be less than heartbeatIntervalMs',
        path: ['timing', 'heartbeatResponseTimeoutMs'],
      });
    }

    if (config.timing.ephemeralInactivityMs < config.timing.heartbeatIntervalMs * 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ephemeralInactivityMs must allow at least two heartbeat intervals',
        path: ['timing', 'ephemeralInactivityMs'],
      });
    }

    if (config.timing.updateIntervalMs > config.timing.speakHoldMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'updateIntervalMs must not exceed speakHoldMs',
        path: ['timing', 'updateIntervalMs'],
      });
    }
  });

export type PublisherConfig = z.infer<typeof publisherConfigSchema>;
export type PublisherConfigInput = z.input<typeof publisherConfigSchema>;

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (typeof nested === 'object' && nested !== null) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

export const defaultPublisherConfig: PublisherConfig = deepFreeze(publisherConfigSchema.parse({}));

export function parsePublisherConfig(value: unknown = {}): PublisherConfig {
  return publisherConfigSchema.parse(value);
}
