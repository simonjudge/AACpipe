import { describe, expect, it } from 'vitest';

import { MemoryPairingStore, SubscriberController } from '@aacpipe/subscriber';

import { PublisherCore } from './publisher.js';

class Endpoint {
  #peer?: Endpoint;
  #messages: string[] = [];
  #messageListeners: Array<(value: string) => void> = [];
  #closeListeners: Array<(code: number) => void> = [];

  connect(peer: Endpoint): void {
    this.#peer = peer;
    peer.#peer = this;
  }

  send(value: string): void {
    const peer = this.#peer;
    if (peer === undefined) throw new Error('transport is not connected');
    if (peer.#messageListeners.length === 0) peer.#messages.push(value);
    else for (const listener of peer.#messageListeners) listener(value);
  }

  close(code: number): void {
    for (const listener of this.#closeListeners) listener(code);
    const peer = this.#peer;
    if (peer !== undefined) for (const listener of peer.#closeListeners) listener(code);
  }

  onMessage(listener: (value: string) => void): void {
    this.#messageListeners.push(listener);
    for (const message of this.#messages.splice(0)) listener(message);
  }

  onClose(listener: (code: number) => void): void {
    this.#closeListeners.push(listener);
  }
}

describe('Milestone 4-7 vertical slice', () => {
  it('pairs, authenticates, encrypts state, clears, reconnects, and revokes', async () => {
    const publisher = await PublisherCore.create();
    const channel = await publisher.pair('persistent', 'Partner');
    const fragment = publisher.pairingFragment(channel);
    const store = new MemoryPairingStore();
    const views: string[] = [];
    const subscriber = new SubscriberController(store, (view) =>
      views.push(`${view.status}:${view.text}`),
    );
    await subscriber.bootstrap(fragment);

    const firstClient = new Endpoint();
    const firstServer = new Endpoint();
    firstClient.connect(firstServer);
    subscriber.attach(firstClient);
    const firstConnection = publisher.connect(channel.channelId, firstServer);
    firstServer.onMessage((message) => {
      const value = JSON.parse(message) as { type?: string };
      if (value.type === 'AUTH_RESPONSE') firstConnection.authenticate(value);
    });

    await publisher.apply(channel.channelId, { kind: 'sentence', text: 'Hello partner' });
    expect(subscriber.view).toMatchObject({
      status: 'authenticated',
      text: 'Hello partner',
      state: 'COMPOSING',
    });

    await publisher.apply(channel.channelId, { kind: 'clear' });
    expect(subscriber.view).toMatchObject({ status: 'authenticated', text: '', state: 'IDLE' });

    const secondClient = new Endpoint();
    const secondServer = new Endpoint();
    secondClient.connect(secondServer);
    const secondSubscriber = new SubscriberController(store);
    await secondSubscriber.restore(channel.channelId);
    secondSubscriber.attach(secondClient);
    const secondConnection = publisher.connect(channel.channelId, secondServer);
    secondServer.onMessage((message) => {
      const value = JSON.parse(message) as { type?: string };
      if (value.type === 'AUTH_RESPONSE') secondConnection.authenticate(value);
    });
    await publisher.apply(channel.channelId, { kind: 'sentence', text: 'After reconnect' });
    expect(secondSubscriber.view.text).toBe('After reconnect');

    await publisher.revoke(channel.channelId);
    expect(subscriber.view.status).toBe('revoked');
    expect(await store.load(channel.channelId)).toBeUndefined();
    expect(views.some((view) => view === 'authenticated:Hello partner')).toBe(true);
  });
});
