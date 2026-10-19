import { createRequire } from 'node:module';
import path from 'node:path';

export interface NativePipeRequest {
  readonly connectionId: number;
  readonly payload: string;
}

export interface NativePipeReceiveResult {
  readonly status: string;
  readonly connectionId?: number;
  readonly payload?: string;
  readonly message?: string;
}

export interface NativePipeServer {
  readonly pipeName: string;
  receive(timeoutMs: number): Promise<NativePipeReceiveResult>;
  respond(connectionId: number, response: string): Promise<void>;
}

export interface NativePublisherInstanceLock {
  readonly isOwner: boolean;
}

export function parseNativePipeReceiveResult(
  value: NativePipeReceiveResult,
): NativePipeRequest | undefined {
  if (value.status === 'timeout') {
    return undefined;
  }
  if (value.status === 'error') {
    throw new Error(`Native pipe receive failed: ${value.message ?? 'unknown native error'}`);
  }
  const connectionId = value.connectionId;
  if (
    value.status !== 'request' ||
    connectionId === undefined ||
    !Number.isSafeInteger(connectionId) ||
    connectionId < 1 ||
    typeof value.payload !== 'string'
  ) {
    throw new Error(
      'Native pipe request has an incompatible shape; rebuild the addon with "npm run native:build"',
    );
  }
  return {
    connectionId,
    payload: value.payload,
  };
}

interface NativeModule {
  readonly SecurePipeServer: new (pipeName: string) => NativePipeServer;
  readonly PublisherInstanceLock: new (name: string) => NativePublisherInstanceLock;
  defaultPipeName(): string;
  defaultPublisherMutexName(): string;
  protectData(plaintext: Buffer): Buffer;
  unprotectData(protectedData: Buffer): Buffer;
}

const require = createRequire(path.join(process.cwd(), 'package.json'));

export function loadNativeModule(): NativeModule {
  const override = process.env['AACPIPE_NATIVE_MODULE'];
  const modulePath =
    override ??
    path.join(process.cwd(), 'apps', 'publisher', 'native', 'aacpipe_win32_native.node');
  return require(modulePath) as NativeModule;
}
