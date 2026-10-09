import { CompositionStore, type ContentCommand } from '@aacpipe/domain';
import {
  ipcResponseSchema,
  parseIpcRequest,
  type IpcRequest,
  type IpcResponse,
} from '@aacpipe/ipc-schema';

import type { PublisherCore } from './publisher.js';

export interface MvpRequestHandler {
  processPayload(payload: string): Promise<IpcResponse>;
  finishSpeaking(): Promise<void>;
}

export function createMvpRequestHandler(core: PublisherCore): MvpRequestHandler {
  const restoredRevision = core.registry
    .list()
    .reduce(
      (highest, channel) =>
        BigInt(channel.revision) > BigInt(highest) ? channel.revision : highest,
      '0',
    );
  const store = new CompositionStore({
    state: 'IDLE',
    text: '',
    truncated: false,
    revision: restoredRevision,
  });

  function success(id: string): IpcResponse {
    const snapshot = store.snapshot();
    return {
      v: 1,
      id,
      ok: true,
      state: snapshot.state,
      revision: snapshot.revision,
      channels: core.registry.list().length,
      subscribers: core.subscriberCount(),
    };
  }

  function failure(id: string, code: number, error: string): IpcResponse {
    return ipcResponseSchema.parse({ v: 1, id, ok: false, code, error });
  }

  function contentCommand(request: IpcRequest): ContentCommand | undefined {
    switch (request.cmd) {
      case 'word':
        return {
          kind: 'word',
          text: request.text,
          ...(request.speak === undefined ? {} : { speak: request.speak }),
        };
      case 'sentence':
        return {
          kind: 'sentence',
          text: request.text,
          ...(request.speak === undefined ? {} : { speak: request.speak }),
        };
      case 'clear':
        return { kind: 'clear' };
      case 'speak':
        return { kind: 'speak' };
      default:
        return undefined;
    }
  }

  async function handle(request: IpcRequest): Promise<IpcResponse> {
    const command = contentCommand(request);
    if (command !== undefined) {
      store.apply(command);
      await core.applyAll(command);
      return success(request.id);
    }

    switch (request.cmd) {
      case 'pair': {
        const channel = await core.pair(request.channelType, request.label);
        const snapshot = store.snapshot();
        if (snapshot.text !== '') {
          await core.apply(channel.channelId, {
            kind: 'sentence',
            text: snapshot.text,
            speak: snapshot.state === 'SPEAKING',
          });
        }
        return success(request.id);
      }
      case 'revoke':
        if (request.all === true) {
          await core.revokeAll();
          return success(request.id);
        }
        if (request.channelId !== undefined && core.registry.get(request.channelId) !== undefined) {
          await core.revoke(request.channelId);
          return success(request.id);
        }
        return failure(request.id, 6, 'Unknown channel');
      case 'status':
        return success(request.id);
    }
    throw new Error('Unsupported IPC command');
  }

  function requestIdFromUnknown(value: unknown): string {
    if (
      typeof value === 'object' &&
      value !== null &&
      'id' in value &&
      typeof value.id === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/u.test(value.id)
    ) {
      return value.id;
    }
    return 'invalid';
  }

  return {
    async processPayload(payload): Promise<IpcResponse> {
      let decoded: unknown;
      try {
        decoded = JSON.parse(payload) as unknown;
      } catch {
        return failure('invalid', 5, 'Malformed JSON request');
      }
      let request: IpcRequest;
      try {
        request = parseIpcRequest(decoded);
      } catch {
        return failure(requestIdFromUnknown(decoded), 5, 'Invalid IPC request');
      }
      try {
        return await handle(request);
      } catch (error) {
        console.error(
          `AACpipe Publisher: command=${request.cmd} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return failure(request.id, 1, 'Publisher command failed');
      }
    },

    async finishSpeaking(): Promise<void> {
      const event = store.finishSpeaking();
      if (event === undefined) return;
      await core.applyAll({ kind: 'sentence', text: event.snapshot.text });
    },
  };
}
