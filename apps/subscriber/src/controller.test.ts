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

  it('forgets a persistent pairing locally and does not reconnect', async () => {
    const store = new MemoryPairingStore();
    const controller = new SubscriberController(store);
    const pairing = await controller.bootstrap(
      buildFragment({
        flag: 'p',
        channelId: '0123456789ABCDEFG',
        key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    );
    const closeListeners: Array<(code: number) => void> = [];
    const closed: number[] = [];
    controller.attach(
      {
        send: () => undefined,
        close: (code) => {
          closed.push(code);
          for (const listener of closeListeners) listener(code);
        },
        onMessage: () => undefined,
        onClose: (listener) => closeListeners.push(listener),
      },
      pairing,
    );
    await controller.forget();
    expect(closed).toEqual([1000]);
    expect(controller.view.status).toBe('forgotten');
    expect(await store.load('0123456789ABCDEFG')).toBeUndefined();
    expect(await controller.restore('0123456789ABCDEFG')).toBeUndefined();
  });

  it('wipes an ephemeral credential when its connection drops', async () => {
    const controller = new SubscriberController(new MemoryPairingStore());
    const pairing = await controller.bootstrap(
      buildFragment({
        flag: 'e',
        channelId: '0123456789ABCDEFG',
        key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    );
    let closeListener: ((code: number) => void) | undefined;
    controller.attach(
      {
        send: () => undefined,
        close: () => undefined,
        onMessage: () => undefined,
        onClose: (listener) => {
          closeListener = listener;
        },
      },
      pairing,
    );
    closeListener?.(1006);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.view.status).toBe('disconnected');
    expect(() =>
      controller.attach({
        send: () => undefined,
        close: () => undefined,
        onMessage: () => undefined,
        onClose: () => undefined,
      }),
    ).toThrow('pairing is not loaded');
  });
});
