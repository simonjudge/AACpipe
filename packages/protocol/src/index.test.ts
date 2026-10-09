import { describe, expect, it } from 'vitest';
import { buildFragment, parseFragment, parseProtocolEvent, uint64Schema } from './index.js';

describe('protocol codecs and schemas', () => {
  it('round-trips and strictly validates pairing fragments', () => {
    const fragment = {
      flag: 'p' as const,
      channelId: '0123456789ABCDEFG',
      key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    expect(parseFragment(buildFragment(fragment))).toEqual(fragment);
    expect(() => parseFragment('#p:0123456789ABCDEFG:AA==')).toThrow();
  });
  it('rejects non-canonical uint64 and malformed events', () => {
    expect(() => uint64Schema.parse('01')).toThrow();
    expect(() => uint64Schema.parse('18446744073709551616')).toThrow();
    expect(
      parseProtocolEvent({ v: 1, ts: 1, eventType: 'SYSTEM_REVOKED', reason: 'USER_MANUAL_REVOKE' })
        .eventType,
    ).toBe('SYSTEM_REVOKED');
  });
});
