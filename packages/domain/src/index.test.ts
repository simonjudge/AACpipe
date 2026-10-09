import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  MAX_BUFFER_BYTES,
  MAX_WORD_BYTES,
  CompositionStore,
  createSnapshotScheduler,
} from './index.js';

describe('CompositionStore', () => {
  it('appends words with normalized spacing', () => {
    const store = new CompositionStore();

    expect(store.apply({ kind: 'word', text: '  hello  ' })).toMatchObject({
      type: 'STATE_UPDATE',
      snapshot: { state: 'COMPOSING', text: 'hello', revision: '1' },
    });
    expect(store.apply({ kind: 'word', text: 'world' })).toMatchObject({
      snapshot: { text: 'hello world', revision: '2' },
    });
  });

  it('joins punctuation without an extra space', () => {
    const store = new CompositionStore();
    store.apply({ kind: 'sentence', text: 'Hello' });

    store.apply({ kind: 'word', text: ',' });
    store.apply({ kind: 'word', text: 'world' });
    store.apply({ kind: 'word', text: '!' });

    expect(store.snapshot().text).toBe('Hello, world!');
  });

  it('does not add a space after an opening punctuation mark', () => {
    const store = new CompositionStore();
    store.apply({ kind: 'sentence', text: 'Hello (' });
    store.apply({ kind: 'word', text: 'world' });

    expect(store.snapshot().text).toBe('Hello (world');
  });

  it('replaces and clears the authoritative buffer', () => {
    const store = new CompositionStore();
    store.apply({ kind: 'sentence', text: 'old text' });

    expect(store.apply({ kind: 'sentence', text: 'new text' })).toMatchObject({
      type: 'STATE_UPDATE',
      snapshot: { text: 'new text', state: 'COMPOSING' },
    });
    expect(store.apply({ kind: 'clear' })).toMatchObject({
      type: 'CLEAR_BUFFER',
      snapshot: { text: '', state: 'IDLE' },
    });
  });

  it('treats an empty authoritative sentence as an immediate clear event', () => {
    const store = new CompositionStore();
    store.apply({ kind: 'sentence', text: 'old text' });

    expect(store.apply({ kind: 'sentence', text: '' })).toMatchObject({
      type: 'CLEAR_BUFFER',
      snapshot: { text: '', state: 'IDLE' },
    });
  });

  it('marks a non-empty message as speaking and returns to composing on new content', () => {
    const store = new CompositionStore();
    store.apply({ kind: 'sentence', text: 'Hello' });

    expect(store.apply({ kind: 'speak' })).toMatchObject({
      snapshot: { state: 'SPEAKING', text: 'Hello' },
    });
    expect(store.apply({ kind: 'word', text: 'world' })).toMatchObject({
      snapshot: { state: 'COMPOSING', text: 'Hello world' },
    });
  });

  it('supports speaking as a modifier on content commands', () => {
    const store = new CompositionStore();

    expect(store.apply({ kind: 'sentence', text: 'Hello', speak: true })).toMatchObject({
      snapshot: { state: 'SPEAKING', text: 'Hello' },
    });
  });

  it('finishes the speaking hold and returns to composing', () => {
    const store = new CompositionStore();
    store.apply({ kind: 'sentence', text: 'Hello', speak: true });

    expect(store.finishSpeaking()).toMatchObject({
      snapshot: { state: 'COMPOSING', text: 'Hello', revision: '2' },
    });
    expect(store.finishSpeaking()).toBeUndefined();
  });

  it('rejects words over the documented UTF-8 limit', () => {
    const store = new CompositionStore();

    expect(() => store.apply({ kind: 'word', text: 'x'.repeat(MAX_WORD_BYTES + 1) })).toThrow(
      'Word exceeds',
    );
    expect(store.snapshot().revision).toBe('0');
  });

  it('does not change an empty buffer when speak is requested', () => {
    const store = new CompositionStore();

    expect(store.apply({ kind: 'speak' })).toBeUndefined();
    expect(store.snapshot().revision).toBe('0');
  });

  it('does not change the revision for empty text commands on an empty buffer', () => {
    const store = new CompositionStore();

    expect(store.apply({ kind: 'word', text: ' \n\t ' })).toBeUndefined();
    expect(store.apply({ kind: 'sentence', text: '' })).toBeUndefined();
    expect(store.snapshot()).toEqual({
      state: 'IDLE',
      text: '',
      truncated: false,
      revision: '0',
    });
  });

  it('truncates from a grapheme boundary and retains the newest content', () => {
    const store = new CompositionStore();
    const source = '😀'.repeat(Math.ceil(MAX_BUFFER_BYTES / 4) + 1);

    store.apply({ kind: 'sentence', text: source });

    expect(store.snapshot().truncated).toBe(true);
    expect(new TextEncoder().encode(store.snapshot().text).byteLength).toBe(MAX_BUFFER_BYTES);
    expect(store.snapshot().text).toBe('😀'.repeat(MAX_BUFFER_BYTES / 4));
  });

  it('does not leave leading whitespace after oldest-text truncation', () => {
    const store = new CompositionStore();
    store.apply({ kind: 'sentence', text: `${'x'.repeat(MAX_BUFFER_BYTES)} newest` });

    expect(store.snapshot().truncated).toBe(true);
    expect(store.snapshot().text).not.toMatch(/^\s/u);
    expect(store.snapshot().text.endsWith('newest')).toBe(true);
  });

  it('strips forbidden control characters before publishing text', () => {
    const store = new CompositionStore();
    store.apply({ kind: 'sentence', text: 'hello\u0000\u0007 world' });

    expect(store.snapshot().text).toBe('hello world');
  });

  it('restores a persisted snapshot and rejects revision overflow without mutation', () => {
    const store = new CompositionStore({
      state: 'COMPOSING',
      text: 'persisted',
      truncated: false,
      revision: '18446744073709551615',
    });

    expect(() => store.apply({ kind: 'word', text: 'later' })).toThrow('Revision exhausted');
    expect(store.snapshot()).toEqual({
      state: 'COMPOSING',
      text: 'persisted',
      truncated: false,
      revision: '18446744073709551615',
    });
  });

  it('rejects inconsistent or oversized persisted snapshots', () => {
    expect(
      () =>
        new CompositionStore({
          state: 'IDLE',
          text: 'not empty',
          truncated: false,
          revision: '1',
        }),
    ).toThrow('IDLE requires');
    expect(
      () =>
        new CompositionStore({
          state: 'COMPOSING',
          text: 'x'.repeat(MAX_BUFFER_BYTES + 1),
          truncated: false,
          revision: '1',
        }),
    ).toThrow('Initial buffer exceeds');
  });

  it('coalesces scheduled snapshots and can flush or cancel them', () => {
    const emitted: string[] = [];
    const scheduler = createSnapshotScheduler(50, (value: string) => emitted.push(value));

    scheduler.schedule('first');
    scheduler.schedule('latest');
    expect(emitted).toEqual([]);

    scheduler.flush();
    expect(emitted).toEqual(['latest']);

    scheduler.schedule('discarded');
    scheduler.cancel();
    scheduler.flush();
    expect(emitted).toEqual(['latest']);

    scheduler.schedule('stale');
    scheduler.emitImmediate('clear');
    scheduler.flush();
    expect(emitted).toEqual(['latest', 'clear']);
  });

  it('keeps arbitrary sentence snapshots within the byte limit', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 3000 }), (text) => {
        const store = new CompositionStore();
        store.apply({ kind: 'sentence', text });

        const snapshot = store.snapshot();
        expect(new TextEncoder().encode(snapshot.text).byteLength).toBeLessThanOrEqual(
          MAX_BUFFER_BYTES,
        );
        expect(snapshot.revision).toMatch(/^(?:0|[1-9][0-9]*)$/u);
      }),
      { numRuns: 100 },
    );
  });

  it('accepts or rejects arbitrary words according to the UTF-8 byte limit', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const store = new CompositionStore();
        const bytes = new TextEncoder().encode(text).byteLength;

        if (bytes <= MAX_WORD_BYTES) {
          expect(() => store.apply({ kind: 'word', text })).not.toThrow();
        } else {
          expect(() => store.apply({ kind: 'word', text })).toThrow();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('increases revisions monotonically for successful arbitrary updates', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 100 }), { maxLength: 30 }), (texts) => {
        const store = new CompositionStore();
        let previous = BigInt(store.snapshot().revision);

        for (const text of texts) {
          const event = store.apply({ kind: 'sentence', text });
          if (event === undefined) {
            continue;
          }

          const current = BigInt(event.snapshot.revision);
          expect(current).toBeGreaterThan(previous);
          previous = current;
        }
      }),
      { numRuns: 100 },
    );
  });
});
