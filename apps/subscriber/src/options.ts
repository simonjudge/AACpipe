import type { SubscriberView } from './controller.js';

export interface SubscriberOptions {
  speakAloud: boolean;
  alertTone: boolean;
  keepAwake: boolean;
}

export const defaultOptions: Readonly<SubscriberOptions> = {
  speakAloud: false,
  alertTone: false,
  keepAwake: false,
};

const storageKey = 'aacpipe.subscriber.options.v1';

export function parseOptions(raw: string | null): SubscriberOptions {
  if (raw === null) return { ...defaultOptions };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return { ...defaultOptions };
    const record = value as Record<string, unknown>;
    return {
      speakAloud: record['speakAloud'] === true,
      alertTone: record['alertTone'] === true,
      keepAwake: record['keepAwake'] === true,
    };
  } catch {
    return { ...defaultOptions };
  }
}

// Options are device preferences only; message content is never stored.
export function loadOptions(storage: Pick<Storage, 'getItem'> | undefined): SubscriberOptions {
  try {
    return parseOptions(storage?.getItem(storageKey) ?? null);
  } catch {
    return { ...defaultOptions };
  }
}

export function saveOptions(
  storage: Pick<Storage, 'setItem'> | undefined,
  options: SubscriberOptions,
): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(options));
  } catch {
    // Storage can be unavailable in private browsing; options then last for this page only.
  }
}

/**
 * Returns the text to announce when the AAC user starts speaking a message, or
 * undefined when no announcement is due. Snapshots received while (re)connecting
 * are never announced, so reloading the page does not repeat old speech.
 */
export function speakingAnnouncement(
  previous: SubscriberView | undefined,
  next: SubscriberView,
): string | undefined {
  if (next.status !== 'authenticated' || next.state !== 'SPEAKING') return undefined;
  if (previous?.status !== 'authenticated') return undefined;
  if (previous.state === 'SPEAKING' && previous.text === next.text) return undefined;
  return next.text;
}

export function needsActivation(options: SubscriberOptions, activated: boolean): boolean {
  return !activated && (options.speakAloud || options.alertTone || options.keepAwake);
}
