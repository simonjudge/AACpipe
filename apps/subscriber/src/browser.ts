import {
  IndexedDbPairingStore,
  MemoryPairingStore,
  SubscriberController,
  type PairingStore,
  type SubscriberTransport,
  type SubscriberView,
} from './controller.js';
import {
  loadOptions,
  needsActivation,
  saveOptions,
  speakingAnnouncement,
  type SubscriberOptions,
} from './options.js';
import { removePairingFragment, renderSubscriberView } from './ui.js';
import type { PairingFragment } from '@aacpipe/protocol';

class FallbackPairingStore implements PairingStore {
  readonly #persistent = new IndexedDbPairingStore();
  readonly #memory = new MemoryPairingStore();
  #persistentAvailable = true;

  async load(channelId: string): Promise<PairingFragment | undefined> {
    if (this.#persistentAvailable) {
      try {
        return await this.#persistent.load(channelId);
      } catch {
        this.#persistentAvailable = false;
        showStorageWarning();
      }
    }
    return this.#memory.load(channelId);
  }

  async save(value: PairingFragment): Promise<void> {
    if (this.#persistentAvailable) {
      try {
        await this.#persistent.save(value);
        return;
      } catch {
        this.#persistentAvailable = false;
        showStorageWarning();
      }
    }
    await this.#memory.save(value);
  }

  async delete(channelId: string): Promise<void> {
    await this.#memory.delete(channelId);
    if (!this.#persistentAvailable) return;
    try {
      await this.#persistent.delete(channelId);
    } catch {
      this.#persistentAvailable = false;
    }
  }
}

class BrowserWebSocketTransport implements SubscriberTransport {
  readonly #socket: WebSocket;
  readonly #messageListeners: Array<(value: string) => void> = [];
  readonly #closeListeners: Array<(code: number) => void> = [];

  constructor(url: string) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        this.close(4002);
        return;
      }
      for (const listener of this.#messageListeners) listener(event.data);
    });
    this.#socket.addEventListener('close', (event) => {
      for (const listener of this.#closeListeners) listener(event.code);
    });
  }

  send(value: string): void {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      this.#socket.addEventListener('open', () => this.#socket.send(value), { once: true });
      return;
    }
    this.#socket.send(value);
  }

  close(code: number): void {
    this.#socket.close(code);
  }

  onMessage(listener: (value: string) => void): void {
    this.#messageListeners.push(listener);
  }

  onClose(listener: (code: number) => void): void {
    this.#closeListeners.push(listener);
  }
}

class AttentionTone {
  #context: AudioContext | undefined;

  unlock(): void {
    const AudioContextClass =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass === undefined) return;
    this.#context ??= new AudioContextClass();
    if (this.#context.state === 'suspended') void this.#context.resume();
  }

  play(): void {
    const context = this.#context;
    if (context === undefined) return;
    if (context.state === 'suspended') void context.resume();
    const start = context.currentTime + 0.02;
    for (const [offset, frequency] of [
      [0, 880],
      [0.18, 1175],
    ] as const) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.4, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.18);
    }
  }
}

class MessageSpeech {
  readonly supported = typeof window.speechSynthesis !== 'undefined';

  unlock(): void {
    if (!this.supported) return;
    // iOS only allows speech after a first utterance started by a user gesture.
    const primer = new SpeechSynthesisUtterance(' ');
    primer.volume = 0;
    window.speechSynthesis.speak(primer);
  }

  speak(text: string, delayMs: number): void {
    if (!this.supported || text.trim() === '') return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = document.documentElement.lang || navigator.language;
    window.setTimeout(() => window.speechSynthesis.speak(utterance), delayMs);
  }

  cancel(): void {
    if (this.supported) window.speechSynthesis.cancel();
  }
}

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}

class ScreenKeepAwake {
  readonly #video: HTMLVideoElement;
  #enabled = false;
  #sentinel: WakeLockSentinelLike | undefined;

  constructor(video: HTMLVideoElement) {
    this.#video = video;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.#enabled) void this.#acquire();
    });
  }

  // Returns false when the browser needs a user gesture before it can keep the screen on.
  async enable(): Promise<boolean> {
    this.#enabled = true;
    return this.#acquire();
  }

  disable(): void {
    this.#enabled = false;
    void this.#sentinel?.release().catch(() => undefined);
    this.#sentinel = undefined;
    this.#video.pause();
  }

  async #acquire(): Promise<boolean> {
    const wakeLock = (
      navigator as Navigator & {
        wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
      }
    ).wakeLock;
    // The Screen Wake Lock API only exists on HTTPS or localhost pages.
    if (window.isSecureContext && wakeLock !== undefined) {
      try {
        if (this.#sentinel === undefined || this.#sentinel.released) {
          this.#sentinel = await wakeLock.request('screen');
        }
        return true;
      } catch {
        // Fall through to the video technique.
      }
    }
    // On plain-HTTP local pages, a silently playing inline video keeps the display on.
    try {
      await this.#video.play();
      return true;
    } catch {
      return false;
    }
  }
}

const message = requiredElement('message');
const status = requiredElement('status');
const label = requiredElement('channel-label');
const warning = requiredElement('storage-warning');
const optionsButton = requiredElement('options-button') as HTMLButtonElement;
const optionsDialog = requiredElement('options-dialog') as HTMLDialogElement;
const speakOption = requiredElement('option-speak') as HTMLInputElement;
const toneOption = requiredElement('option-tone') as HTMLInputElement;
const awakeOption = requiredElement('option-awake') as HTMLInputElement;
const speakUnavailable = requiredElement('speak-unavailable');
const forgetButton = requiredElement('forget-button') as HTMLButtonElement;
const activateButton = requiredElement('activate-button') as HTMLButtonElement;
const tone = new AttentionTone();
const speech = new MessageSpeech();
const keepAwake = new ScreenKeepAwake(requiredElement('keep-awake-video') as HTMLVideoElement);
const options: SubscriberOptions = loadOptions(safeLocalStorage());
let activated = false;
let previousView: SubscriberView | undefined;
const controller = new SubscriberController(new FallbackPairingStore(), render);
let pairing: PairingFragment | undefined;
let ephemeralSession = false;
let reconnectAttempt = 0;
let reconnectTimer: number | undefined;

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing required element: ${id}`);
  return element;
}

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function showStorageWarning(): void {
  warning.hidden = false;
}

function render(view: SubscriberView): void {
  renderSubscriberView(message, view);
  label.textContent = view.label ?? '';
  const ephemeral = ephemeralSession;
  const states: Record<SubscriberView['status'], string> = {
    disconnected: ephemeral
      ? 'One-time pairing ended - scan a new QR code'
      : 'Disconnected - text cleared',
    connecting: 'Connecting...',
    authenticated: view.state === 'SPEAKING' ? 'Speaking' : 'Connected',
    revoked: 'Pairing revoked',
    incompatible: 'Connection incompatible',
    forgotten: 'Pairing forgotten on this phone',
  };
  status.textContent = states[view.status];
  document.body.dataset['connectionState'] = view.status;
  if (view.status === 'authenticated') reconnectAttempt = 0;
  forgetButton.disabled = pairing === undefined || view.status === 'forgotten';

  const announcement = speakingAnnouncement(previousView, view);
  if (announcement !== undefined) {
    if (options.alertTone) tone.play();
    if (options.speakAloud) speech.speak(announcement, options.alertTone ? 450 : 0);
  }
  if (view.status !== 'authenticated') speech.cancel();
  previousView = view;
}

function updateActivationPrompt(): void {
  activateButton.hidden = !needsActivation(options, activated);
}

function activate(): void {
  if (options.alertTone) tone.unlock();
  if (options.speakAloud) speech.unlock();
  activated = true;
  if (options.keepAwake) {
    void keepAwake.enable().then((ok) => {
      if (!ok) activated = false;
      updateActivationPrompt();
    });
  }
  updateActivationPrompt();
}

function applyOptionChange(): void {
  options.speakAloud = speakOption.checked;
  options.alertTone = toneOption.checked;
  options.keepAwake = awakeOption.checked;
  saveOptions(safeLocalStorage(), options);
  if (!options.keepAwake) keepAwake.disable();
  if (!options.speakAloud) speech.cancel();
  // A checkbox change is a user gesture, so sound and keep-awake can start now.
  activate();
}

function initialiseOptions(): void {
  speakOption.checked = options.speakAloud;
  toneOption.checked = options.alertTone;
  awakeOption.checked = options.keepAwake;
  speakOption.disabled = !speech.supported;
  speakUnavailable.hidden = speech.supported;
  for (const input of [speakOption, toneOption, awakeOption]) {
    input.addEventListener('change', applyOptionChange);
  }
  optionsButton.addEventListener('click', () => optionsDialog.showModal());
  activateButton.addEventListener('click', activate);
  forgetButton.addEventListener('click', () => {
    if (!window.confirm('Forget this pairing on this phone? You will need a new QR code.')) return;
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    void controller.forget().then(() => {
      pairing = undefined;
      optionsDialog.close();
      render(controller.view);
    });
  });
  if (options.keepAwake) {
    // Wake Lock may work without a gesture; video playback usually needs one.
    void keepAwake.enable().then((ok) => {
      if (ok && !options.speakAloud && !options.alertTone) activated = true;
      updateActivationPrompt();
    });
  }
  updateActivationPrompt();
}

function websocketUrl(channelId: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${location.host}/ws`);
  url.searchParams.set('channel', channelId);
  return url.toString();
}

function connect(): void {
  if (pairing === undefined) return;
  if (controller.view.status === 'connecting' || controller.view.status === 'authenticated') return;
  if (reconnectTimer !== undefined) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const transport = new BrowserWebSocketTransport(websocketUrl(pairing.channelId));
  controller.attach(transport, pairing);
  transport.onClose(() => {
    if (pairing?.flag === 'e') {
      // One-time pairings end on disconnect; the credential is not kept for reconnection.
      pairing = undefined;
      render(controller.view);
      return;
    }
    if (
      pairing?.flag !== 'p' ||
      controller.view.status === 'revoked' ||
      controller.view.status === 'incompatible'
    ) {
      return;
    }
    const delay = Math.min(10_000, 500 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(connect, delay + Math.floor(Math.random() * 250));
  });
}

async function start(): Promise<void> {
  const channelId = new URL(location.href).searchParams.get('channel');
  try {
    if (location.hash !== '') {
      pairing = await controller.bootstrap(location.hash);
      removePairingFragment(location, history);
    } else if (channelId !== null) {
      pairing = await controller.restore(channelId);
    }
    if (pairing === undefined || pairing.channelId !== channelId) {
      status.textContent = 'Pairing information is missing. Scan the QR code again.';
      return;
    }
    ephemeralSession = pairing.flag === 'e';
    connect();
  } catch {
    status.textContent = 'This pairing link is invalid or cannot be stored.';
  }
}

window.addEventListener('online', connect);
window.addEventListener('beforeunload', () => {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
});
initialiseOptions();
void start();
