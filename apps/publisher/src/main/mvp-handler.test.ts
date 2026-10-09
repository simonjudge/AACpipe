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
          channelId: '00000000000000001',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: 6, error: 'Unknown channel' });
  });
});
