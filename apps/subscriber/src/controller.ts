import { associatedData, deriveKeys, encodeTranscript, open, proof } from '@aacpipe/crypto';
import {
  authResponseSchema,
  decodeBase64Url,
  encodeBase64Url,
  parseChallenge,
  parseFragment,
  parseProtocolEvent,
  type Challenge,
  type PairingFragment,
  type ProtocolEvent,
} from '@aacpipe/protocol';

export type SubscriberStatus =
  'disconnected' | 'connecting' | 'authenticated' | 'revoked' | 'incompatible';

export interface SubscriberView {
  status: SubscriberStatus;
  text: string;
  state: 'IDLE' | 'COMPOSING' | 'SPEAKING';
  truncated: boolean;
  label?: string;
}

export interface SubscriberTransport {
  send(value: string): void;
  close(code: number): void;
  onMessage(listener: (value: string) => void): void;
  onClose(listener: (code: number) => void): void;
}

export interface PairingStore {
  load(channelId: string): Promise<PairingFragment | undefined>;
  save(value: PairingFragment): Promise<void>;
  delete(channelId: string): Promise<void>;
}

export class MemoryPairingStore implements PairingStore {
  #values = new Map<string, PairingFragment>();

  load(channelId: string): Promise<PairingFragment | undefined> {
    const value = this.#values.get(channelId);
    return Promise.resolve(value === undefined ? undefined : { ...value });
  }

  save(value: PairingFragment): Promise<void> {
    this.#values.set(value.channelId, { ...value });
    return Promise.resolve();
  }

  delete(channelId: string): Promise<void> {
    this.#values.delete(channelId);
    return Promise.resolve();
  }
}

export class IndexedDbPairingStore implements PairingStore {
  #databaseName: string;
  #databaseVersion: number;

  constructor(databaseName = 'aacpipe', databaseVersion = 1) {
    this.#databaseName = databaseName;
    this.#databaseVersion = databaseVersion;
  }

  async load(channelId: string): Promise<PairingFragment | undefined> {
    const database = await this.#open();
    return new Promise((resolve, reject) => {
      const request = database
        .transaction('pairings', 'readonly')
        .objectStore('pairings')
        .get(channelId);
      request.onerror = () => reject(request.error ?? new Error('pairing lookup failed'));
      request.onsuccess = () => resolve(request.result as PairingFragment | undefined);
    });
  }

  async save(value: PairingFragment): Promise<void> {
    const database = await this.#open();
    await this.#write(database, value);
  }

  async delete(channelId: string): Promise<void> {
    const database = await this.#open();
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction('pairings', 'readwrite')
        .objectStore('pairings')
        .delete(channelId);
      request.onerror = () => reject(request.error ?? new Error('pairing deletion failed'));
      request.onsuccess = () => resolve();
    });
  }

  #open(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('persistent pairing storage is unavailable'));
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#databaseName, this.#databaseVersion);
      request.onerror = () => reject(request.error ?? new Error('pairing database failed to open'));
      request.onupgradeneeded = () => {
        request.result.createObjectStore('pairings', { keyPath: 'channelId' });
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  #write(database: IDBDatabase, value: PairingFragment): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = database
        .transaction('pairings', 'readwrite')
        .objectStore('pairings')
        .put(value);
      request.onerror = () => reject(request.error ?? new Error('pairing save failed'));
      request.onsuccess = () => resolve();
    });
  }
}

export class SubscriberController {
  readonly view: SubscriberView = {
    status: 'disconnected',
    text: '',
    state: 'IDLE',
    truncated: false,
  };
  #store: PairingStore;
  #transport?: SubscriberTransport;
  #fragment: PairingFragment | undefined;
  #keys: ReturnType<typeof deriveKeys> | undefined;
  #receiveSequence = 0n;
  #onView: ((view: SubscriberView) => void) | undefined;

  constructor(
    store: PairingStore = new MemoryPairingStore(),
    onView?: (view: SubscriberView) => void,
  ) {
    this.#store = store;
    this.#onView = onView;
  }

  async bootstrap(fragmentText: string): Promise<PairingFragment> {
    const fragment = parseFragment(fragmentText);
    this.#fragment = fragment;
    if (fragment.flag === 'p') await this.#store.save(fragment);
    return fragment;
  }

  async restore(channelId: string): Promise<PairingFragment | undefined> {
    const restored = await this.#store.load(channelId);
    if (restored !== undefined) this.#fragment = restored;
    return restored;
  }

  attach(transport: SubscriberTransport, fragment = this.#fragment): void {
    if (fragment === undefined) throw new Error('pairing is not loaded');
    this.#fragment = fragment;
    this.#transport = transport;
    this.#receiveSequence = 0n;
    this.#setView({ status: 'connecting', text: '', state: 'IDLE', truncated: false });
    transport.onMessage((value) => {
      try {
        this.#handleMessage(value);
      } catch {
        this.#clearContent();
        this.#setView({ status: 'incompatible', text: '', state: 'IDLE', truncated: false });
        transport.close(4002);
      }
    });
    transport.onClose((code) => {
      this.#clearContent();
      if (this.view.status === 'incompatible' || this.view.status === 'revoked') return;
      if (code === 4001) {
        void this.#revokeLocalCredential();
        this.#setView({ status: 'revoked', text: '', state: 'IDLE', truncated: false });
      } else {
        this.#setView({ status: 'disconnected', text: '', state: 'IDLE', truncated: false });
      }
    });
  }

  clearLocalContent(): void {
    this.#clearContent();
    this.#publish();
  }

  async #revokeLocalCredential(): Promise<void> {
    if (this.#fragment !== undefined) await this.#store.delete(this.#fragment.channelId);
    this.#fragment = undefined;
    this.#keys = undefined;
  }

  #handleMessage(raw: string): void {
    const value = JSON.parse(raw) as { type?: string; v?: number };
    if (value.type === 'CHALLENGE') {
      this.#handleChallenge(parseChallenge(value));
      return;
    }
    if (this.#fragment === undefined || this.#keys === undefined) {
      throw new Error('unexpected unauthenticated message');
    }
    const envelope = value as {
      v: number;
      cid: string;
      sid: string;
      seq: string;
      payload: string;
      tag: string;
    };
    if (envelope.v !== 1 || envelope.cid !== this.#fragment.channelId || envelope.sid === '') {
      throw new Error('invalid encrypted envelope');
    }
    if (envelope.seq !== this.#receiveSequence.toString()) throw new Error('unexpected sequence');
    const sid = decodeBase64Url(envelope.sid);
    const ciphertext = new Uint8Array([
      ...decodeBase64Url(envelope.payload),
      ...decodeBase64Url(envelope.tag),
    ]);
    const iv = new Uint8Array(12);
    iv.set(this.#keys.publisherNoncePrefix);
    new DataView(iv.buffer).setBigUint64(4, this.#receiveSequence);
    const plaintext = open(
      this.#keys.publisherToSubscriber,
      iv,
      ciphertext,
      associatedData(
        1,
        this.#fragment.channelId,
        sid,
        'publisher->subscriber',
        this.#receiveSequence,
      ),
    );
    this.#receiveSequence += 1n;
    const event = parseProtocolEvent(JSON.parse(new TextDecoder().decode(plaintext)));
    this.#applyEvent(event);
  }

  #handleChallenge(challenge: Challenge): void {
    if (this.#fragment === undefined || this.#transport === undefined)
      throw new Error('pairing is not loaded');
    const sid = decodeBase64Url(challenge.sid);
    const serverNonce = decodeBase64Url(challenge.serverNonce);
    const clientNonce = cryptoRandom(16);
    const selected = challenge.capabilities.filter(
      (capability) =>
        capability === 'content.clear' ||
        capability === 'state.text' ||
        capability === 'state.speaking',
    );
    if (!selected.includes('content.clear') || !selected.includes('state.text')) {
      throw new Error('mandatory capabilities unavailable');
    }
    this.#keys = deriveKeys(decodeBase64Url(this.#fragment.key), this.#fragment.channelId, sid);
    const transcript = encodeTranscript([
      'AACpipe-auth-v1',
      sid,
      serverNonce,
      clientNonce,
      this.#fragment.channelId,
      ...[...challenge.capabilities].sort(),
      ...[...selected].sort(),
    ]);
    const response = authResponseSchema.parse({
      v: 1,
      type: 'AUTH_RESPONSE',
      cid: this.#fragment.channelId,
      sid: challenge.sid,
      clientNonce: encodeBase64Url(clientNonce),
      capabilities: selected,
      proof: encodeBase64Url(proof(this.#keys.handshakeKey, transcript)),
    });
    this.#transport.send(JSON.stringify(response));
  }

  #applyEvent(event: ProtocolEvent): void {
    if (event.eventType === 'SYSTEM_REVOKED') {
      void this.#revokeLocalCredential();
      this.#clearContent();
      this.#setView({ status: 'revoked', text: '', state: 'IDLE', truncated: false });
      this.#transport?.close(4001);
    } else if (event.eventType === 'CLEAR_BUFFER') {
      this.#setView({ status: 'authenticated', text: '', state: 'IDLE', truncated: false });
    } else {
      this.#setView({
        status: 'authenticated',
        text: event.buffer.text,
        state: event.state,
        truncated: event.buffer.truncated ?? false,
        ...(typeof event.meta?.channelLabel === 'string' ? { label: event.meta.channelLabel } : {}),
      });
    }
  }

  #clearContent(): void {
    this.view.text = '';
    this.view.state = 'IDLE';
    this.view.truncated = false;
  }

  #setView(view: SubscriberView): void {
    Object.assign(this.view, view);
    this.#publish();
  }

  #publish(): void {
    this.#onView?.({ ...this.view });
  }
}

function cryptoRandom(size: number): Uint8Array {
  const value = new Uint8Array(size);
  globalThis.crypto?.getRandomValues(value);
  if (value.every((byte) => byte === 0)) {
    throw new Error('secure random source unavailable');
  }
  return value;
}
