import { describe, expect, it } from 'vitest';

import { MemoryPairingStore, SubscriberController } from './controller.js';
import { buildFragment } from '@aacpipe/protocol';

describe('Subscriber lifecycle', () => {
  it('keeps persistent credentials while clearing content on disconnect', async () => {
    const store = new MemoryPairingStore();
    const controller = new SubscriberController(store);
    const fragment = buildFragment({
      flag: 'p',
      channelId: '0123456789ABCDEFG',
      key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    await controller.bootstrap(fragment);
    expect(await controller.restore('0123456789ABCDEFG')).toEqual({
      flag: 'p',
      channelId: '0123456789ABCDEFG',
      key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
  });

  it('does not retain ephemeral credentials after local revocation', async () => {
    const store = new MemoryPairingStore();
    const controller = new SubscriberController(store);
    await controller.bootstrap(
      buildFragment({
        flag: 'e',
        channelId: '0123456789ABCDEFG',
        key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    );
    expect(await store.load('0123456789ABCDEFG')).toBeUndefined();
  });
});
