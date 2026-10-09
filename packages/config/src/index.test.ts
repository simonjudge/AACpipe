import { describe, expect, it } from 'vitest';

import { defaultPublisherConfig, parsePublisherConfig, publisherConfigSchema } from './index.js';

describe('Publisher configuration', () => {
  it('provides the documented defaults', () => {
    expect(defaultPublisherConfig).toEqual({
      v: 1,
      network: {
        bindAddress: '0.0.0.0',
        port: 8080,
        mdnsEnabled: true,
      },
      timing: {
        bridgeTimeoutMs: 1500,
        handshakeTimeoutMs: 5000,
        heartbeatIntervalMs: 15_000,
        heartbeatResponseTimeoutMs: 5000,
        ephemeralInactivityMs: 1_800_000,
        speakHoldMs: 4000,
        updateIntervalMs: 50,
      },
      capacity: {
        maxChannels: 32,
        maxPendingHandshakes: 32,
        maxFailedAuthPerMinute: 30,
      },
      logging: {
        level: 'info',
        retentionDays: 7,
      },
    });
  });

  it('applies nested defaults around explicit overrides', () => {
    expect(
      parsePublisherConfig({
        network: { port: 9090 },
        timing: { speakHoldMs: 6000 },
        logging: { level: 'debug' },
      }),
    ).toMatchObject({
      v: 1,
      network: { bindAddress: '0.0.0.0', port: 9090, mdnsEnabled: true },
      timing: { speakHoldMs: 6000, updateIntervalMs: 50 },
      logging: { level: 'debug', retentionDays: 7 },
    });
  });

  it('rejects unknown keys and invalid scalar values', () => {
    expect(() => parsePublisherConfig({ unknown: true })).toThrow();
    expect(() => parsePublisherConfig({ network: { port: 0 } })).toThrow();
    expect(() => parsePublisherConfig({ network: { bindAddress: 'localhost' } })).toThrow();
    expect(() => parsePublisherConfig({ logging: { retentionDays: 0 } })).toThrow();
  });

  it('rejects inconsistent timing relationships', () => {
    expect(() =>
      parsePublisherConfig({
        timing: { heartbeatIntervalMs: 5000, heartbeatResponseTimeoutMs: 5000 },
      }),
    ).toThrow('heartbeatResponseTimeoutMs');

    expect(() =>
      parsePublisherConfig({
        timing: { heartbeatIntervalMs: 40_000, ephemeralInactivityMs: 60_000 },
      }),
    ).toThrow('ephemeralInactivityMs');

    expect(() =>
      parsePublisherConfig({
        timing: { speakHoldMs: 500, updateIntervalMs: 501 },
      }),
    ).toThrow('updateIntervalMs');
  });

  it('does not mutate the exported defaults when parsing overrides', () => {
    const before = structuredClone(defaultPublisherConfig);
    parsePublisherConfig({ network: { port: 9090 } });

    expect(defaultPublisherConfig).toEqual(before);
    expect(Object.isFrozen(defaultPublisherConfig.timing)).toBe(true);
  });

  it('exports a schema suitable for safeParse at persistence boundaries', () => {
    expect(publisherConfigSchema.safeParse({}).success).toBe(true);
    expect(publisherConfigSchema.safeParse({ v: 2 }).success).toBe(false);
  });
});
