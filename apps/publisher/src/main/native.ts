import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export interface NativePipeRequest {
  readonly connectionId: number;
  readonly payload: string;
}

export interface NativePipeServer {
  readonly pipeName: string;
  receive(timeoutMs: number): Promise<NativePipeRequest>;
  respond(connectionId: number, response: string): Promise<void>;
}

export interface NativePublisherInstanceLock {
  readonly isOwner: boolean;
}

interface NativeModule {
  readonly SecurePipeServer: new (pipeName: string) => NativePipeServer;
  readonly PublisherInstanceLock: new (name: string) => NativePublisherInstanceLock;
  defaultPipeName(): string;
  defaultPublisherMutexName(): string;
  protectData(plaintext: Buffer): Buffer;
  unprotectData(protectedData: Buffer): Buffer;
}

const require = createRequire(import.meta.url);

export function loadNativeModule(): NativeModule {
  const override = process.env['AACPIPE_NATIVE_MODULE'];
  const modulePath =
    override ?? fileURLToPath(new URL('../../native/aacpipe_win32_native.node', import.meta.url));
  return require(modulePath) as NativeModule;
}
