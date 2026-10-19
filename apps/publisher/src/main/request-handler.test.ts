import { describe, expect, it } from 'vitest';

import { createPublisherRequestHandler } from './request-handler.js';

function request(handler: ReturnType<typeof createPublisherRequestHandler>, value: unknown) {
  return handler.processPayload(JSON.stringify(value));
}

describe('Publisher request handler', () => {
  it('applies content commands and reports revisions and state', () => {
    const handler = createPublisherRequestHandler();

    expect(request(handler, { v: 1, id: '1', cmd: 'word', text: 'Hello' })).toMatchObject({
      ok: true,
      state: 'COMPOSING',
      revision: '1',
    });
    expect(
      request(handler, { v: 1, id: '2', cmd: 'sentence', text: 'Hello world', speak: true }),
    ).toMatchObject({ ok: true, state: 'SPEAKING', revision: '2' });

    handler.finishSpeaking();
    expect(request(handler, { v: 1, id: '3', cmd: 'status' })).toMatchObject({
      ok: true,
      state: 'COMPOSING',
      revision: '3',
    });
    expect(request(handler, { v: 1, id: '4', cmd: 'clear' })).toMatchObject({
      ok: true,
      state: 'IDLE',
      revision: '4',
    });
  });

  it('tracks pair and revoke commands without coupling them to content', () => {
    const handler = createPublisherRequestHandler();

    expect(request(handler, { v: 1, id: '1', cmd: 'pair' })).toMatchObject({
      ok: true,
      channels: 1,
    });
    expect(
      request(handler, { v: 1, id: '2', cmd: 'pair', channelType: 'persistent' }),
    ).toMatchObject({ ok: true, channels: 2 });
    expect(request(handler, { v: 1, id: '3', cmd: 'revoke', all: true })).toMatchObject({
      ok: true,
      channels: 0,
    });
  });

  it('rejects malformed JSON, invalid requests, and unknown channels', () => {
    const handler = createPublisherRequestHandler();

    expect(handler.processPayload('{')).toEqual({
      v: 1,
      id: 'invalid',
      ok: false,
      code: 5,
      error: 'Malformed JSON request',
    });
    expect(request(handler, { v: 1, id: 'kept-id', cmd: 'word' })).toMatchObject({
      id: 'kept-id',
      ok: false,
      code: 5,
    });
    expect(
      request(handler, {
        v: 1,
        id: 'unknown',
        cmd: 'revoke',
        label: 'Nobody',
      }),
    ).toMatchObject({ id: 'unknown', ok: false, code: 6 });
  });
});
