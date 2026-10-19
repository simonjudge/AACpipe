import { describe, expect, it } from 'vitest';

import type { SubscriberView } from './controller.js';
import {
  defaultOptions,
  loadOptions,
  needsActivation,
  parseOptions,
  saveOptions,
  speakingAnnouncement,
} from './options.js';

function view(overrides: Partial<SubscriberView>): SubscriberView {
  return { status: 'authenticated', text: '', state: 'IDLE', truncated: false, ...overrides };
}

describe('Subscriber options', () => {
  it('defaults every option to off and ignores malformed storage', () => {
    expect(parseOptions(null)).toEqual(defaultOptions);
    expect(parseOptions('not json')).toEqual(defaultOptions);
    expect(parseOptions('{"speakAloud":"yes","alertTone":true}')).toEqual({
      speakAloud: false,
      alertTone: true,
      keepAwake: false,
    });
  });

  it('round-trips options through storage and tolerates unavailable storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    saveOptions(storage, { speakAloud: true, alertTone: false, keepAwake: true });
    expect(loadOptions(storage)).toEqual({ speakAloud: true, alertTone: false, keepAwake: true });
    expect([...values.values()].join('')).not.toContain('text');
    const throwing = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
    };
    expect(loadOptions(throwing)).toEqual(defaultOptions);
    expect(() => saveOptions(throwing, defaultOptions)).not.toThrow();
  });

  it('announces only a newly spoken message on a live connection', () => {
    const composing = view({ state: 'COMPOSING', text: 'Hello' });
    const speaking = view({ state: 'SPEAKING', text: 'Hello' });
    expect(speakingAnnouncement(composing, speaking)).toBe('Hello');
    expect(speakingAnnouncement(speaking, speaking)).toBeUndefined();
    expect(speakingAnnouncement(speaking, view({ state: 'SPEAKING', text: 'Bye' }))).toBe('Bye');
    expect(speakingAnnouncement(view({ status: 'connecting' }), speaking)).toBeUndefined();
    expect(speakingAnnouncement(undefined, speaking)).toBeUndefined();
    expect(speakingAnnouncement(composing, composing)).toBeUndefined();
  });

  it('asks for a tap only when an enabled option needs one', () => {
    expect(needsActivation(defaultOptions, false)).toBe(false);
    expect(needsActivation({ ...defaultOptions, alertTone: true }, false)).toBe(true);
    expect(needsActivation({ ...defaultOptions, keepAwake: true }, true)).toBe(false);
  });
});
