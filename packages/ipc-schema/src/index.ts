import { z } from 'zod';

export const ipcVersion = 1 as const;

const channelId = z.string().regex(/^[0-9A-Za-z]{17}$/u);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
const maxUnsigned64 = 18_446_744_073_709_551_615n;
const isUnsigned64 = (value: string): boolean =>
  /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= maxUnsigned64;
const revision = z
  .string()
  .refine(isUnsigned64, 'revision must be a canonical unsigned 64-bit decimal string');
const wordText = z
  .string()
  .max(256)
  .refine((value) => utf8ByteLength(value) <= 256, 'text exceeds the 256-byte UTF-8 limit');
const sentenceText = z
  .string()
  .max(64 * 1024)
  .refine((value) => utf8ByteLength(value) <= 64 * 1024, 'text exceeds the 65536-byte UTF-8 limit');
const label = z
  .string()
  .trim()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= 128, 'label exceeds the 128-byte UTF-8 limit');
const boundedCount = z.number().int().nonnegative().max(1024);
const errorMessage = z
  .string()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= 256, 'error exceeds the 256-byte UTF-8 limit');

const baseRequest = z.object({
  v: z.literal(ipcVersion),
  id: requestId,
});

const revokeRequestSchema = baseRequest
  .extend({
    cmd: z.literal('revoke'),
    channelId: channelId.optional(),
    all: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if ((value.channelId === undefined) === (value.all !== true)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Specify exactly one of channelId or all=true',
        path: ['channelId'],
      });
    }
  });

export const ipcRequestSchema = z.union([
  baseRequest.extend({ cmd: z.literal('word'), text: wordText, speak: z.boolean().optional() }),
  baseRequest.extend({
    cmd: z.literal('sentence'),
    text: sentenceText,
    speak: z.boolean().optional(),
  }),
  baseRequest.extend({ cmd: z.literal('clear') }),
  baseRequest.extend({ cmd: z.literal('speak') }),
  baseRequest.extend({
    cmd: z.literal('pair'),
    channelType: z.enum(['persistent', 'ephemeral']).default('ephemeral'),
    label: label.optional(),
  }),
  revokeRequestSchema,
  baseRequest.extend({ cmd: z.literal('status') }),
]);

export type IpcRequest = z.infer<typeof ipcRequestSchema>;

export const ipcResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    v: z.literal(ipcVersion),
    id: requestId,
    ok: z.literal(true),
    state: z.enum(['IDLE', 'COMPOSING', 'SPEAKING']),
    revision,
    channels: boundedCount,
    subscribers: boundedCount,
  }),
  z.object({
    v: z.literal(ipcVersion),
    id: requestId,
    ok: z.literal(false),
    code: z.number().int().min(1).max(255),
    error: errorMessage,
  }),
]);

export type IpcResponse = z.infer<typeof ipcResponseSchema>;

export function parseIpcRequest(value: unknown): IpcRequest {
  return ipcRequestSchema.parse(value);
}

export function parseIpcResponse(value: unknown): IpcResponse {
  return ipcResponseSchema.parse(value);
}
