export const MAX_WORD_BYTES = 256;
export const MAX_BUFFER_BYTES = 4096;
export const MAX_SENTENCE_BYTES = 64 * 1024;
export const MAX_REVISION = '18446744073709551615';

export type CompositionState = 'IDLE' | 'COMPOSING' | 'SPEAKING';

export type ContentCommand =
  | { readonly kind: 'word'; readonly text: string; readonly speak?: boolean }
  | { readonly kind: 'sentence'; readonly text: string; readonly speak?: boolean }
  | { readonly kind: 'clear' }
  | { readonly kind: 'speak' };

export type ManagementCommand =
  | {
      readonly kind: 'pair';
      readonly channelType: 'persistent' | 'ephemeral';
      readonly label?: string;
    }
  | { readonly kind: 'revoke'; readonly label?: string; readonly all?: boolean }
  | { readonly kind: 'status' };

export type DomainCommand = ContentCommand | ManagementCommand;

export interface CompositionSnapshot {
  readonly state: CompositionState;
  readonly text: string;
  readonly truncated: boolean;
  readonly revision: string;
}

export type DomainEvent =
  | { readonly type: 'STATE_UPDATE'; readonly snapshot: CompositionSnapshot }
  | { readonly type: 'CLEAR_BUFFER'; readonly snapshot: CompositionSnapshot };

const NO_SPACE_BEFORE = new Set(['.', ',', '!', '?', ';', ':', "'", '’', ')', ']', '}', '%', '”']);
const NO_SPACE_AFTER = new Set(['(', '[', '{', '‘', '“']);

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function removeForbiddenControls(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return (
        (codePoint === undefined ||
          codePoint === 9 ||
          codePoint === 10 ||
          codePoint === 13 ||
          codePoint > 31) &&
        codePoint !== 127
      );
    })
    .join('');
}

function normalizeText(value: string): string {
  return removeForbiddenControls(value).trim().replace(/\s+/gu, ' ');
}

function assertInputSize(value: string, maxBytes: number, name: string): void {
  if (utf8Bytes(value) > maxBytes) {
    throw new Error(`${name} exceeds the ${maxBytes}-byte UTF-8 limit`);
  }
}

function assertSafeRevision(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error('Revision must be a canonical unsigned decimal string');
  }

  const revision = BigInt(value);
  if (revision < 0n || revision > BigInt(MAX_REVISION)) {
    throw new Error('Revision is outside the unsigned 64-bit range');
  }
  return revision;
}

function nextRevision(value: string): string {
  const revision = assertSafeRevision(value);
  if (revision === BigInt(MAX_REVISION)) {
    throw new Error('Revision exhausted');
  }
  return (revision + 1n).toString();
}

function takeLastGraphemes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Bytes(value) <= maxBytes) {
    return { text: value, truncated: false };
  }

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const segments = Array.from(segmenter.segment(value), ({ segment }) => segment);
  const retained: string[] = [];
  let bytes = 0;

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined) {
      continue;
    }
    const segmentBytes = utf8Bytes(segment);
    if (bytes + segmentBytes > maxBytes) {
      break;
    }
    retained.unshift(segment);
    bytes += segmentBytes;
  }

  return { text: retained.join('').trimStart(), truncated: true };
}

function boundedText(value: string): { text: string; truncated: boolean } {
  return takeLastGraphemes(value, MAX_BUFFER_BYTES);
}

function appendWord(buffer: string, word: string): string {
  if (buffer.length === 0) {
    return word;
  }

  const first = Array.from(word)[0];
  const last = Array.from(buffer).at(-1);
  if (first !== undefined && NO_SPACE_BEFORE.has(first)) {
    return `${buffer}${word}`;
  }
  if (last !== undefined && NO_SPACE_AFTER.has(last)) {
    return `${buffer}${word}`;
  }
  return `${buffer} ${word}`;
}

export class CompositionStore {
  #snapshot: CompositionSnapshot;

  constructor(initial?: CompositionSnapshot) {
    if (initial === undefined) {
      this.#snapshot = {
        state: 'IDLE',
        text: '',
        truncated: false,
        revision: '0',
      };
      return;
    }

    assertSafeRevision(initial.revision);
    assertInputSize(initial.text, MAX_BUFFER_BYTES, 'Initial buffer');
    if ((initial.state === 'IDLE') !== (initial.text.length === 0)) {
      throw new Error('IDLE requires an empty buffer and active states require content');
    }
    this.#snapshot = { ...initial };
  }

  snapshot(): CompositionSnapshot {
    return { ...this.#snapshot };
  }

  apply(command: ContentCommand): DomainEvent | undefined {
    switch (command.kind) {
      case 'word':
        assertInputSize(command.text, MAX_WORD_BYTES, 'Word');
        return this.applyTextCommand(appendWord, command.text, command.speak === true, false);
      case 'sentence':
        assertInputSize(command.text, MAX_SENTENCE_BYTES, 'Sentence');
        return this.applyTextCommand(
          (_buffer, text) => text,
          command.text,
          command.speak === true,
          true,
        );
      case 'clear':
        return this.clear();
      case 'speak':
        return this.speak();
    }
  }

  finishSpeaking(): DomainEvent | undefined {
    if (this.#snapshot.state !== 'SPEAKING') {
      return undefined;
    }
    this.#snapshot = {
      ...this.#snapshot,
      state: this.#snapshot.text.length === 0 ? 'IDLE' : 'COMPOSING',
      revision: nextRevision(this.#snapshot.revision),
    };
    return { type: 'STATE_UPDATE', snapshot: this.snapshot() };
  }

  private applyTextCommand(
    join: (buffer: string, text: string) => string,
    rawText: string,
    speakAfterUpdate: boolean,
    replaceWithEmpty: boolean,
  ): DomainEvent | undefined {
    const text = normalizeText(rawText);
    if (text.length === 0 && (!replaceWithEmpty || this.#snapshot.text.length === 0)) {
      return undefined;
    }

    const bounded = boundedText(join(this.#snapshot.text, text));
    const nextState: CompositionState =
      bounded.text.length === 0 ? 'IDLE' : speakAfterUpdate ? 'SPEAKING' : 'COMPOSING';
    this.#snapshot = {
      state: nextState,
      text: bounded.text,
      truncated: bounded.truncated,
      revision: nextRevision(this.#snapshot.revision),
    };
    return {
      type: replaceWithEmpty && bounded.text.length === 0 ? 'CLEAR_BUFFER' : 'STATE_UPDATE',
      snapshot: this.snapshot(),
    };
  }

  private clear(): DomainEvent {
    this.#snapshot = {
      state: 'IDLE',
      text: '',
      truncated: false,
      revision: nextRevision(this.#snapshot.revision),
    };
    return { type: 'CLEAR_BUFFER', snapshot: this.snapshot() };
  }

  private speak(): DomainEvent | undefined {
    if (this.#snapshot.text.length === 0) {
      return undefined;
    }
    this.#snapshot = {
      ...this.#snapshot,
      state: 'SPEAKING',
      revision: nextRevision(this.#snapshot.revision),
    };
    return { type: 'STATE_UPDATE', snapshot: this.snapshot() };
  }
}

export interface SnapshotScheduler<T> {
  schedule(value: T): void;
  emitImmediate(value: T): void;
  flush(): void;
  cancel(): void;
}

export function createSnapshotScheduler<T>(
  delayMs: number,
  emit: (value: T) => void,
  scheduleTimeout: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout> = setTimeout,
  clearScheduledTimeout: (handle: ReturnType<typeof setTimeout>) => void = clearTimeout,
): SnapshotScheduler<T> {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error('Snapshot delay must be a non-negative finite number');
  }

  let pending: T | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    if (timer !== undefined) {
      clearScheduledTimeout(timer);
      timer = undefined;
    }
    if (pending !== undefined) {
      const value = pending;
      pending = undefined;
      emit(value);
    }
  };

  return {
    schedule(value) {
      pending = value;
      if (timer === undefined) {
        timer = scheduleTimeout(flush, delayMs);
      }
    },
    emitImmediate(value) {
      if (timer !== undefined) {
        clearScheduledTimeout(timer);
        timer = undefined;
      }
      pending = undefined;
      emit(value);
    },
    flush,
    cancel() {
      if (timer !== undefined) {
        clearScheduledTimeout(timer);
        timer = undefined;
      }
      pending = undefined;
    },
  };
}
