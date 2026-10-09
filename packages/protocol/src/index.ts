import { z } from 'zod';

export const protocolMajorVersion = 1 as const;
export type ProtocolVersion = typeof protocolMajorVersion;
export const base62Alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const cidPattern = /^[0-9A-Za-z]{17}$/u;
const b64Pattern = /^[A-Za-z0-9_-]*$/u;
const maxUint64 = 18_446_744_073_709_551_615n;
export const isCanonicalUint64 = (v: string): boolean =>
  /^(?:0|[1-9][0-9]*)$/u.test(v) && BigInt(v) <= maxUint64;
export const uint64Schema = z.string().refine(isCanonicalUint64, 'canonical uint64 required');
export const revisionSchema = uint64Schema;

export function encodeBase62(value: Uint8Array, length = 17): string {
  if (value.length === 0) throw new Error('cannot encode empty value');
  let n = 0n;
  for (const byte of value) n = (n << 8n) | BigInt(byte);
  let result = '';
  while (n > 0n) {
    result = base62Alphabet[Number(n % 62n)]! + result;
    n /= 62n;
  }
  if (result.length > length) throw new Error('value does not fit');
  return result.padStart(length, base62Alphabet[0]);
}
export function decodeBase62(value: string, length = 17): Uint8Array {
  if (value.length !== length || !/^[0-9A-Za-z]+$/u.test(value))
    throw new Error('invalid base62 value');
  let n = 0n;
  for (const char of value) {
    const digit = base62Alphabet.indexOf(char);
    if (digit < 0) throw new Error('invalid base62 value');
    n = n * 62n + BigInt(digit);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array(out);
}
export function randomChannelId(randomBytes: (size: number) => Uint8Array): string {
  // Rejection sampling avoids modulo bias while retaining the fixed 17-char form.
  for (;;) {
    try {
      return encodeBase62(randomBytes(13));
    } catch {
      /* reject the out-of-range sample */
    }
  }
}

export interface PairingFragment {
  flag: 'p' | 'e';
  channelId: string;
  key: string;
}
export function isChannelId(value: string): boolean {
  return cidPattern.test(value);
}
export function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}
export function decodeBase64Url(value: string): Uint8Array {
  if (!b64Pattern.test(value) || value.length % 4 === 1) throw new Error('invalid base64url');
  const bytes = new Uint8Array(Buffer.from(value, 'base64url'));
  if (encodeBase64Url(bytes) !== value) throw new Error('non-canonical base64url');
  return bytes;
}
export function parseFragment(fragment: string): PairingFragment {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const pieces = raw.split(':');
  if (pieces.length !== 3 || !/^[pe]$/u.test(pieces[0] ?? '') || !isChannelId(pieces[1] ?? '')) {
    throw new Error('invalid pairing fragment');
  }
  const key = pieces[2] ?? '';
  const decoded = decodeBase64Url(key);
  if (decoded.length !== 32) throw new Error('pairing key must be 32 bytes');
  return { flag: pieces[0] as 'p' | 'e', channelId: pieces[1]!, key };
}
export function buildFragment(fragment: PairingFragment): string {
  if (!/^[pe]$/u.test(fragment.flag) || !isChannelId(fragment.channelId))
    throw new Error('invalid pairing fragment');
  decodeBase64Url(fragment.key);
  if (decodeBase64Url(fragment.key).length !== 32) throw new Error('pairing key must be 32 bytes');
  return `#${fragment.flag}:${fragment.channelId}:${fragment.key}`;
}

const common = { v: z.literal(1), type: z.string() };
export const challengeSchema = z.object({
  ...common,
  type: z.literal('CHALLENGE'),
  sid: z.string().min(1),
  serverNonce: z.string().min(1),
  capabilities: z.array(z.string()).max(64),
});
export const authResponseSchema = z.object({
  ...common,
  type: z.literal('AUTH_RESPONSE'),
  cid: z.string().refine(isChannelId),
  sid: z.string().min(1),
  clientNonce: z.string().min(1),
  capabilities: z.array(z.string()).max(64),
  proof: z.string().min(1),
});
const eventBase = { v: z.literal(1), ts: z.number().int().nonnegative() };
export const stateUpdateSchema = z.object({
  ...eventBase,
  eventType: z.literal('STATE_UPDATE'),
  revision: revisionSchema,
  state: z.enum(['IDLE', 'COMPOSING', 'SPEAKING']),
  buffer: z.object({ text: z.string(), truncated: z.boolean().optional() }),
  meta: z.record(z.unknown()).optional(),
});
export const clearBufferSchema = z.object({
  ...eventBase,
  eventType: z.literal('CLEAR_BUFFER'),
  reason: z.string().min(1),
  revision: revisionSchema,
  cid: z.string().refine(isChannelId),
});
export const revokedSchema = z.object({
  ...eventBase,
  eventType: z.literal('SYSTEM_REVOKED'),
  reason: z.string().min(1),
});
export const protocolEventSchema = z.discriminatedUnion('eventType', [
  stateUpdateSchema,
  clearBufferSchema,
  revokedSchema,
]);
export type Challenge = z.infer<typeof challengeSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type ProtocolEvent = z.infer<typeof protocolEventSchema>;
export function parseChallenge(value: unknown): Challenge {
  return challengeSchema.parse(value);
}
export function parseAuthResponse(value: unknown): AuthResponse {
  return authResponseSchema.parse(value);
}
export function parseProtocolEvent(value: unknown): ProtocolEvent {
  return protocolEventSchema.parse(value);
}
