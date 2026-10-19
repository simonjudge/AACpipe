import { CompositionStore, type ContentCommand } from '@aacpipe/domain';
import {
  ipcResponseSchema,
  type IpcRequest,
  type IpcResponse,
  parseIpcRequest,
} from '@aacpipe/ipc-schema';

export interface PublisherRequestHandler {
  processPayload(payload: string): IpcResponse;
  finishSpeaking(): void;
}

export function createPublisherRequestHandler(): PublisherRequestHandler {
  const store = new CompositionStore();
  const channels = new Set<string>();
  let channelSequence = 0;

  function success(id: string): IpcResponse {
    const snapshot = store.snapshot();
    return {
      v: 1,
      id,
      ok: true,
      state: snapshot.state,
      revision: snapshot.revision,
      channels: channels.size,
      subscribers: 0,
    };
  }

  function failure(id: string, code: number, error: string): IpcResponse {
    return ipcResponseSchema.parse({ v: 1, id, ok: false, code, error });
  }

  function applyContent(request: IpcRequest): IpcResponse {
    let command: ContentCommand;
    switch (request.cmd) {
      case 'word':
        command = {
          kind: 'word',
          text: request.text,
          ...(request.speak === undefined ? {} : { speak: request.speak }),
        };
        break;
      case 'sentence':
        command = {
          kind: 'sentence',
          text: request.text,
          ...(request.speak === undefined ? {} : { speak: request.speak }),
        };
        break;
      case 'clear':
        command = { kind: 'clear' };
        break;
      case 'speak':
        command = { kind: 'speak' };
        break;
      default:
        return failure(request.id, 1, 'Not a content command');
    }
    store.apply(command);
    return success(request.id);
  }

  function handle(request: IpcRequest): IpcResponse {
    switch (request.cmd) {
      case 'word':
      case 'sentence':
      case 'clear':
      case 'speak':
        return applyContent(request);
      case 'pair': {
        channelSequence += 1;
        const label = request.label ?? `Partner ${String(channelSequence)}`;
        const key = label.toLocaleLowerCase('en-GB');
        if (channels.has(key)) return failure(request.id, 6, 'Label already in use');
        channels.add(key);
        return success(request.id);
      }
      case 'revoke': {
        if (request.all === true) {
          channels.clear();
          return success(request.id);
        }
        if (
          request.label !== undefined &&
          channels.delete(request.label.toLocaleLowerCase('en-GB'))
        ) {
          return success(request.id);
        }
        return failure(request.id, 6, 'Unknown channel label');
      }
      case 'status':
        return success(request.id);
    }
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
    processPayload(payload): IpcResponse {
      let decoded: unknown;
      try {
        decoded = JSON.parse(payload) as unknown;
      } catch {
        return failure('invalid', 5, 'Malformed JSON request');
      }

      try {
        return handle(parseIpcRequest(decoded));
      } catch {
        return failure(requestIdFromUnknown(decoded), 5, 'Invalid IPC request');
      }
    },
    finishSpeaking(): void {
      store.finishSpeaking();
    },
  };
}
