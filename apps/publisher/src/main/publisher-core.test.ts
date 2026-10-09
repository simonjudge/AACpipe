import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PublisherCore, type SecretProtector } from './publisher.js';

const testProtector: SecretProtector = {
  protect(value) {
    return Promise.resolve(`protected:${Buffer.from(value, 'utf8').toString('base64url')}`);
  },
  unprotect(value) {
    return Promise.resolve(
      Buffer.from(value.replace(/^protected:/u, ''), 'base64url').toString('utf8'),
    );
  },
};

describe('Publisher channel persistence', () => {
  it('persists encrypted channel metadata and revision but not composition text', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aacpipe-'));
    const filePath = path.join(directory, 'channels.json');
    try {
      const first = await PublisherCore.create(filePath, testProtector);
      const channel = await first.pair('persistent', 'Partner');
      await first.apply(channel.channelId, { kind: 'sentence', text: 'private message' });
      const stored = await readFile(filePath, 'utf8');
      expect(stored).toContain('protected:');
      expect(stored).not.toContain('private message');

      const second = await PublisherCore.create(filePath, testProtector);
      expect(second.registry.get(channel.channelId)?.revision).toBe('1');
      const restored = second.registry.get(channel.channelId);
      expect(restored?.secret).toBe(channel.secret);
      await second.apply(channel.channelId, { kind: 'clear' });
      expect(second.registry.get(channel.channelId)?.revision).toBe('2');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a revocation tombstone while removing the secret-bearing record', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aacpipe-'));
    try {
      const publisher = await PublisherCore.create(
        path.join(directory, 'channels.json'),
        testProtector,
      );
      const channel = await publisher.pair('ephemeral');
      await publisher.revoke(channel.channelId);
      expect(publisher.registry.get(channel.channelId)).toBeUndefined();
      expect(publisher.registry.tombstoneExists(channel.channelId)).toBe(true);
      await expect(
        PublisherCore.create(path.join(directory, 'channels.json'), testProtector),
      ).resolves.toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
