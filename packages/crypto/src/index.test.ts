import { describe, expect, it } from 'vitest';
import { associatedData, deriveKeys, deterministicIv, open, seal } from './index.js';

describe('crypto framing', () => {
  it('separates keys and deterministically derives IVs', () => {
    const keys = deriveKeys(
      new Uint8Array(32).fill(7),
      '0123456789ABCDEFG',
      new Uint8Array(16).fill(3),
    );
    expect(keys.handshakeKey).not.toEqual(keys.publisherToSubscriber);
    expect(deterministicIv(keys.publisherNoncePrefix, 9n)).toHaveLength(12);
    expect(deterministicIv(keys.publisherNoncePrefix, 9n)).toEqual(
      deterministicIv(keys.publisherNoncePrefix, 9n),
    );
  });

  it('authenticates associated data and rejects tampering', () => {
    const key = new Uint8Array(32).fill(1);
    const aad = associatedData(
      1,
      '0123456789ABCDEFG',
      new Uint8Array(16),
      'publisher->subscriber',
      0n,
    );
    const ciphertext = seal(key, new Uint8Array(12), new TextEncoder().encode('hello'), aad);
    expect(new TextDecoder().decode(open(key, new Uint8Array(12), ciphertext, aad))).toBe('hello');
    expect(() =>
      open(
        key,
        new Uint8Array(12),
        ciphertext,
        associatedData(1, '0123456789ABCDEFG', new Uint8Array(16), 'subscriber->publisher', 0n),
      ),
    ).toThrow();
  });
});
