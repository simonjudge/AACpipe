import { describe, expect, it } from 'vitest';

import { parseIpcRequest, parseIpcResponse } from './index.js';

describe('IPC request schema', () => {
  it('parses content commands', () => {
    expect(parseIpcRequest({ v: 1, id: 'request-1', cmd: 'word', text: 'water' })).toEqual({
      v: 1,
      id: 'request-1',
      cmd: 'word',
      text: 'water',
    });
    expect(
      parseIpcRequest({
        v: 1,
        id: 'request-speak',
        cmd: 'sentence',
        text: 'water',
        speak: true,
      }),
    ).toMatchObject({ cmd: 'sentence', speak: true });
    expect(parseIpcRequest({ v: 1, id: 'request-2', cmd: 'pair' })).toMatchObject({
      cmd: 'pair',
      channelType: 'ephemeral',
    });
  });

  it('requires exactly one revoke target', () => {
    expect(
      parseIpcRequest({
        v: 1,
        id: 'request-3',
        cmd: 'revoke',
        label: '  Mum  ',
      }),
    ).toMatchObject({ cmd: 'revoke', label: 'Mum' });

    expect(
      parseIpcRequest({
        v: 1,
        id: 'request-4',
        cmd: 'revoke',
        all: true,
      }),
    ).toMatchObject({ cmd: 'revoke', all: true });

    expect(() =>
      parseIpcRequest({
        v: 1,
        id: 'request-5',
        cmd: 'revoke',
      }),
    ).toThrow();
    expect(() =>
      parseIpcRequest({
        v: 1,
        id: 'request-6',
        cmd: 'revoke',
        label: 'Mum',
        all: true,
      }),
    ).toThrow();
  });

  it('rejects invalid versions, IDs, and oversized text', () => {
    expect(() => parseIpcRequest({ v: 2, id: 'request-7', cmd: 'clear' })).toThrow();
    expect(() => parseIpcRequest({ v: 1, id: 'bad id', cmd: 'clear' })).toThrow();
    expect(() =>
      parseIpcRequest({ v: 1, id: 'request-8', cmd: 'sentence', text: 'x'.repeat(65537) }),
    ).toThrow();
    expect(() =>
      parseIpcRequest({ v: 1, id: 'request-9', cmd: 'word', text: 'x'.repeat(257) }),
    ).toThrow();
    expect(() =>
      parseIpcRequest({ v: 1, id: 'request-10', cmd: 'word', text: '😀'.repeat(65) }),
    ).toThrow();
    expect(() =>
      parseIpcRequest({ v: 1, id: 'request-11', cmd: 'sentence', text: '😀'.repeat(16385) }),
    ).toThrow();
  });
});

describe('IPC response schema', () => {
  it('parses success and failure responses', () => {
    expect(
      parseIpcResponse({
        v: 1,
        id: 'request-1',
        ok: true,
        state: 'COMPOSING',
        revision: '12',
        channels: 1,
        subscribers: 1,
      }),
    ).toMatchObject({ ok: true, revision: '12' });

    expect(
      parseIpcResponse({
        v: 1,
        id: 'request-2',
        ok: false,
        code: 3,
        error: 'Clipboard is unavailable',
      }),
    ).toMatchObject({ ok: false, code: 3 });
  });
});
