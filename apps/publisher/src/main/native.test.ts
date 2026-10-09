import { describe, expect, it } from 'vitest';

import { parseNativePipeReceiveResult } from './native.js';

describe('native pipe request boundary', () => {
  it('accepts the JavaScript shape exported by the current native addon', () => {
    expect(
      parseNativePipeReceiveResult({
        status: 'request',
        connectionId: 1,
        payload: '{"v":1}',
      }),
    ).toEqual({
      connectionId: 1,
      payload: '{"v":1}',
    });
  });

  it('returns no request for an idle timeout', () => {
    expect(parseNativePipeReceiveResult({ status: 'timeout' })).toBeUndefined();
  });

  it('surfaces native receive failures', () => {
    expect(() =>
      parseNativePipeReceiveResult({
        status: 'error',
        message: 'pipe failed',
      }),
    ).toThrow('Native pipe receive failed: pipe failed');
  });

  it('reports a stale native addon shape before responding', () => {
    expect(() =>
      parseNativePipeReceiveResult({
        status: 'request',
        connection_id: 1,
        payload: '{"v":1}',
      } as never),
    ).toThrow(/npm run native:build/);
  });
});
