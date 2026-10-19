import { describe, expect, it } from 'vitest';

import { createMvpRequestHandler } from './mvp-handler.js';
import { PublisherCore } from './publisher.js';

function payload(value: unknown): string {
  return JSON.stringify(value);
}

describe('MVP bridge request handler', () => {
  it('fans content out while managing persistent channels', async () => {
    const core = await PublisherCore.create();
    const handler = createMvpRequestHandler(core);

    await expect(
      handler.processPayload(
        payload({
          v: 1,
          id: 'pair',
          cmd: 'pair',
          channelType: 'persistent',
          label: 'Partner',
        }),
      ),
    ).resolves.toMatchObject({ ok: true, channels: 1, revision: '0' });

    await expect(
      handler.processPayload(
        payload({ v: 1, id: 'sentence', cmd: 'sentence', text: 'Hello partner' }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      state: 'COMPOSING',
      revision: '1',
      channels: 1,
    });

    await expect(
      handler.processPayload(payload({ v: 1, id: 'revoke', cmd: 'revoke', all: true })),
    ).resolves.toMatchObject({ ok: true, channels: 0 });
  });

  it('returns protocol failures for malformed and unknown requests', async () => {
    const handler = createMvpRequestHandler(await PublisherCore.create());

    await expect(handler.processPayload('{')).resolves.toMatchObject({
      ok: false,
      code: 5,
      error: 'Malformed JSON request',
    });
    await expect(
      handler.processPayload(
        payload({
          v: 1,
          id: 'missing',
          cmd: 'revoke',
          label: 'Nobody',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 6, error: 'Unknown channel label' });
  });

  it('identifies channels by unique labels and names unlabelled channels automatically', async () => {
    const core = await PublisherCore.create();
    const handler = createMvpRequestHandler(core);
    const pair = (id: string, channelType: string, label?: string): Promise<unknown> =>
      handler.processPayload(
        payload({ v: 1, id, cmd: 'pair', channelType, ...(label === undefined ? {} : { label }) }),
      );

    await expect(pair('mum', 'persistent', 'Mum')).resolves.toMatchObject({ ok: true });
    await expect(pair('mum-again', 'persistent', ' mum ')).resolves.toMatchObject({
      ok: false,
      code: 6,
      error: 'Label already in use',
    });
    await expect(pair('auto-1', 'persistent')).resolves.toMatchObject({ ok: true });
    await expect(pair('auto-2', 'persistent')).resolves.toMatchObject({ ok: true });
    await expect(pair('one-time', 'ephemeral')).resolves.toMatchObject({ ok: true });
    expect(core.registry.list().map((channel) => channel.label)).toEqual([
      'Mum',
      'Partner 1',
      'Partner 2',
      'One-time 1',
    ]);

    await expect(
      handler.processPayload(payload({ v: 1, id: 'revoke', cmd: 'revoke', label: 'MUM' })),
    ).resolves.toMatchObject({ ok: true, channels: 3 });
    await expect(
      handler.processPayload(
        payload({ v: 1, id: 'revoke-ot', cmd: 'revoke', label: 'One-time 1' }),
      ),
    ).resolves.toMatchObject({ ok: true, channels: 2 });
    expect(core.registry.findByLabel('mum')).toEqual([]);
    await expect(pair('mum-reuse', 'persistent', 'Mum')).resolves.toMatchObject({ ok: true });
  });
});
