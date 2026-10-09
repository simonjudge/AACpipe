import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';

export const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;
export type Bytes = Uint8Array;

export function canonicalUint64(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error('invalid canonical uint64');
  const n = BigInt(value);
  if (n > MAX_UINT64) throw new Error('uint64 out of range');
  return n;
}

export function u64(value: bigint): Bytes {
  if (value < 0n || value > MAX_UINT64) throw new Error('uint64 out of range');
  const out = new Uint8Array(8);
  let n = value;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Bytes[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Length-prefixed byte strings use an unsigned 32-bit network-order length. */
export function lengthPrefix(value: string | Bytes): Bytes {
  const bytes = typeof value === 'string' ? utf8(value) : value;
  if (bytes.length > 0xffff_ffff) throw new Error('field too large');
  return concat(
    new Uint8Array([bytes.length >>> 24, bytes.length >>> 16, bytes.length >>> 8, bytes.length]),
    bytes,
  );
}

export function encodeTranscript(fields: readonly (string | Bytes)[]): Bytes {
  return concat(...fields.map(lengthPrefix));
}

export function deriveKeys(
  secret: Bytes,
  channelId: string,
  connectionId: Bytes | string,
): {
  handshakeKey: Bytes;
  publisherToSubscriber: Bytes;
  subscriberToPublisher: Bytes;
  publisherNoncePrefix: Bytes;
  subscriberNoncePrefix: Bytes;
} {
  const cid = utf8(channelId);
  const conn = typeof connectionId === 'string' ? utf8(connectionId) : connectionId;
  const salt = sha256(concat(utf8('AACpipe'), cid, conn));
  const info = (name: string) =>
    concat(utf8('AACpipe\0v1\0'), lengthPrefix(cid), lengthPrefix(conn), utf8(name));
  const expand = (name: string, size: number) => hkdf(sha256, secret, salt, info(name), size);
  return {
    handshakeKey: expand('handshake', 32),
    publisherToSubscriber: expand('publisher->subscriber', 32),
    subscriberToPublisher: expand('subscriber->publisher', 32),
    publisherNoncePrefix: expand('publisher->subscriber iv', 4),
    subscriberNoncePrefix: expand('subscriber->publisher iv', 4),
  };
}

export function hmacSha256(key: Bytes, data: Bytes): Bytes {
  return hmac(sha256, key, data);
}
export function proof(key: Bytes, transcript: Bytes): Bytes {
  return hmacSha256(key, transcript);
}
export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
}

export function deterministicIv(prefix: Bytes, sequence: bigint): Bytes {
  if (prefix.length !== 4) throw new Error('nonce prefix must be 4 bytes');
  return concat(prefix, u64(sequence));
}

export function associatedData(
  v: number,
  cid: string,
  connectionId: Bytes | string,
  direction: string,
  sequence: bigint,
): Bytes {
  return encodeTranscript([
    new Uint8Array([v]),
    cid,
    typeof connectionId === 'string' ? utf8(connectionId) : connectionId,
    direction,
    u64(sequence),
  ]);
}

export function seal(key: Bytes, iv: Bytes, plaintext: Bytes, aad: Bytes): Bytes {
  return gcm(key, iv, aad).encrypt(plaintext);
}
export function open(key: Bytes, iv: Bytes, ciphertextAndTag: Bytes, aad: Bytes): Bytes {
  if (ciphertextAndTag.length < 16) throw new Error('ciphertext is missing authentication tag');
  return gcm(key, iv, aad).decrypt(ciphertextAndTag);
}

export const encrypt = seal;
export const decrypt = open;
