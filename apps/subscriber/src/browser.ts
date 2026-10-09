import {
  IndexedDbPairingStore,
  MemoryPairingStore,
  SubscriberController,
  type PairingStore,
  type SubscriberTransport,
  type SubscriberView,
} from './controller.js';
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

const message = requiredElement('message');
const status = requiredElement('status');
const label = requiredElement('channel-label');
const warning = requiredElement('storage-warning');
const controller = new SubscriberController(new FallbackPairingStore(), render);
let pairing: PairingFragment | undefined;
let reconnectAttempt = 0;
let reconnectTimer: number | undefined;

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing required element: ${id}`);
  return element;
}

function showStorageWarning(): void {
  warning.hidden = false;
}

function render(view: SubscriberView): void {
  renderSubscriberView(message, view);
  label.textContent = view.label ?? '';
  const states: Record<SubscriberView['status'], string> = {
    disconnected: 'Disconnected - text cleared',
    connecting: 'Connecting...',
    authenticated: view.state === 'SPEAKING' ? 'Speaking' : 'Connected',
    revoked: 'Pairing revoked',
    incompatible: 'Connection incompatible',
  };
  status.textContent = states[view.status];
  document.body.dataset['connectionState'] = view.status;
  if (view.status === 'authenticated') reconnectAttempt = 0;
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
    connect();
  } catch {
    status.textContent = 'This pairing link is invalid or cannot be stored.';
  }
}

window.addEventListener('online', connect);
window.addEventListener('beforeunload', () => {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
});
void start();
