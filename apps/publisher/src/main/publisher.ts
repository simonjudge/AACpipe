import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  associatedData,
  deriveKeys,
  encodeTranscript,
  equalBytes,
  proof,
  seal,
} from '@aacpipe/crypto';
import { CompositionStore, type ContentCommand } from '@aacpipe/domain';
import {
  buildFragment,
  challengeSchema,
  decodeBase64Url,
  encodeBase64Url,
  parseAuthResponse,
  protocolMajorVersion,
  type Challenge,
  type ProtocolEvent,
} from '@aacpipe/protocol';
import { randomChannelId } from '@aacpipe/protocol';
import { loadNativeModule } from './native.js';

const OFFERED_CAPABILITIES = ['content.clear', 'state.speaking', 'state.text'] as const;
const REQUIRED_CAPABILITIES = new Set(['content.clear', 'state.text']);

export interface ChannelRecord {
  readonly channelId: string;
  readonly channelType: 'persistent' | 'ephemeral';
  readonly secret: string;
  readonly label?: string;
  readonly revision: string;
  readonly revoked?: boolean;
}

export interface SecretProtector {
  protect(value: string): Promise<string>;
  unprotect(value: string): Promise<string>;
}

const plainProtector: SecretProtector = {
  protect(value) {
    return Promise.resolve(value);
  },
  unprotect(value) {
    return Promise.resolve(value);
  },
};

function defaultProtector(): SecretProtector {
  const native = loadNativeModule();
  return {
    protect(value) {
      return Promise.resolve(native.protectData(Buffer.from(value, 'utf8')).toString('base64url'));
    },
    unprotect(value) {
      return Promise.resolve(
        native.unprotectData(Buffer.from(value, 'base64url')).toString('utf8'),
      );
    },
  };
}

export class DuplicateLabelError extends Error {
  constructor(label: string) {
    super(`A pairing named "${label}" already exists`);
    this.name = 'DuplicateLabelError';
  }
}

// Labels identify channels for revocation, so comparison ignores case and Unicode composition.
function labelKey(label: string): string {
  return label.trim().normalize('NFC').toLocaleLowerCase('en-GB');
}

export class ChannelRegistry {
  #records = new Map<string, ChannelRecord>();
  #tombstones = new Set<string>();
  #filePath: string | undefined;
  #protector: SecretProtector;
  #persistQueue: Promise<void> = Promise.resolve();

  private constructor(filePath: string | undefined, protector: SecretProtector) {
    this.#filePath = filePath;
    this.#protector = protector;
  }

  static async open(
    filePath?: string,
    protector: SecretProtector = plainProtector,
  ): Promise<ChannelRegistry> {
    const registry = new ChannelRegistry(filePath, protector);
    if (filePath === undefined) return registry;
    try {
      const stored = JSON.parse(await readFile(filePath, 'utf8')) as {
        channels?: Array<Omit<ChannelRecord, 'secret'> & { secret: string }>;
        tombstones?: string[];
      };
      for (const record of stored.channels ?? []) {
        registry.#records.set(record.channelId, {
          ...record,
          secret: await protector.unprotect(record.secret),
        });
      }
      for (const tombstone of stored.tombstones ?? []) registry.#tombstones.add(tombstone);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return registry;
  }

  get(channelId: string): ChannelRecord | undefined {
    const record = this.#records.get(channelId);
    return record === undefined ? undefined : { ...record };
  }

  list(): ChannelRecord[] {
    return [...this.#records.values()]
      .filter((record) => !record.revoked)
      .map((record) => ({ ...record }));
  }

  tombstoneExists(channelId: string): boolean {
    return this.#tombstones.has(channelId);
  }

  findByLabel(label: string): ChannelRecord[] {
    const key = labelKey(label);
    return this.list().filter(
      (record) => record.label !== undefined && labelKey(record.label) === key,
    );
  }

  #nextLabel(channelType: 'persistent' | 'ephemeral'): string {
    const prefix = channelType === 'persistent' ? 'Partner' : 'One-time';
    for (let number = 1; ; number += 1) {
      const candidate = `${prefix} ${String(number)}`;
      if (this.findByLabel(candidate).length === 0) return candidate;
    }
  }

  async create(channelType: 'persistent' | 'ephemeral', label?: string): Promise<ChannelRecord> {
    const trimmed = label?.trim();
    const chosen = trimmed === undefined || trimmed === '' ? this.#nextLabel(channelType) : trimmed;
    if (this.findByLabel(chosen).length > 0) throw new DuplicateLabelError(chosen);
    const channelId = randomChannelId((size) => randomBytes(size));
    const record: ChannelRecord = {
      channelId,
      channelType,
      secret: encodeBase64Url(randomBytes(32)),
      label: chosen,
      revision: '0',
    };
    this.#records.set(channelId, record);
    await this.#persist();
    return { ...record };
  }

  async revoke(channelId: string): Promise<void> {
    this.#records.delete(channelId);
    this.#tombstones.add(channelId);
    await this.#persist();
  }

  async revokeAll(): Promise<void> {
    for (const channelId of this.#records.keys()) this.#tombstones.add(channelId);
    this.#records.clear();
    await this.#persist();
  }

  async update(record: ChannelRecord): Promise<void> {
    this.#records.set(record.channelId, { ...record });
    await this.#persist();
  }

  // Writes share one temporary file, so they must not overlap.
  #persist(): Promise<void> {
    const write = this.#persistQueue.then(() => this.#write());
    this.#persistQueue = write.catch(() => undefined);
    return write;
  }

  async #write(): Promise<void> {
    if (this.#filePath === undefined) return;
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true });
    const payload = JSON.stringify({
      version: 1,
      channels: await Promise.all(
        [...this.#records.values()]
          .filter((record) => record.channelType === 'persistent')
          .map(async (record) => ({
            ...record,
            secret: await this.#protector.protect(record.secret),
          })),
      ),
      tombstones: [...this.#tombstones],
    });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.#filePath);
  }
}

interface SubscriberTransport {
  send(value: string): void;
  close(code: number): void;
}

export class PublisherConnection {
  readonly challenge: Challenge;
  #transport: SubscriberTransport;
  #channel: ChannelRecord;
  #store: CompositionStore;
  #authenticated = false;
  #keys?: ReturnType<typeof deriveKeys>;
  #sendSequence = 0n;

  constructor(channel: ChannelRecord, store: CompositionStore, transport: SubscriberTransport) {
    this.#channel = channel;
    this.#store = store;
    this.#transport = transport;
    this.challenge = challengeSchema.parse({
      v: protocolMajorVersion,
      type: 'CHALLENGE',
      sid: encodeBase64Url(randomBytes(16)),
      serverNonce: encodeBase64Url(randomBytes(16)),
      capabilities: [...OFFERED_CAPABILITIES],
    });
    this.#transport.send(JSON.stringify(this.challenge));
  }

  authenticate(raw: unknown): void {
    const response = parseAuthResponse(raw);
    if (response.cid !== this.#channel.channelId || response.sid !== this.challenge.sid) {
      this.#transport.close(4003);
      throw new Error('challenge identity mismatch');
    }
    const selected = [...response.capabilities].filter((capability) =>
      this.challenge.capabilities.includes(capability as (typeof OFFERED_CAPABILITIES)[number]),
    );
    if (![...REQUIRED_CAPABILITIES].every((capability) => selected.includes(capability))) {
      this.#transport.close(4002);
      throw new Error('mandatory capability missing');
    }
    const keys = deriveKeys(
      decodeBase64Url(this.#channel.secret),
      this.#channel.channelId,
      decodeBase64Url(this.challenge.sid),
    );
    const transcript = encodeTranscript([
      'AACpipe-auth-v1',
      decodeBase64Url(this.challenge.sid),
      decodeBase64Url(this.challenge.serverNonce),
      decodeBase64Url(response.clientNonce),
      this.#channel.channelId,
      ...[...this.challenge.capabilities].sort(),
      ...[...selected].sort(),
    ]);
    const expected = proof(keys.handshakeKey, transcript);
    if (!equalBytes(expected, decodeBase64Url(response.proof))) {
      this.#transport.close(4003);
      throw new Error('invalid proof');
    }
    this.#keys = keys;
    this.#authenticated = true;
    this.#sendSnapshot();
  }

  sendEvent(event: ProtocolEvent): void {
    if (!this.#authenticated || this.#keys === undefined) return;
    const plaintext = new TextEncoder().encode(JSON.stringify(event));
    const sequence = this.#sendSequence;
    const aad = associatedData(
      1,
      this.#channel.channelId,
      decodeBase64Url(this.challenge.sid),
      'publisher->subscriber',
      sequence,
    );
    const iv = new Uint8Array(12);
    iv.set(this.#keys.publisherNoncePrefix);
    new DataView(iv.buffer).setBigUint64(4, sequence);
    const encrypted = seal(this.#keys.publisherToSubscriber, iv, plaintext, aad);
    this.#transport.send(
      JSON.stringify({
        v: 1,
        cid: this.#channel.channelId,
        sid: this.challenge.sid,
        seq: sequence.toString(),
        payload: encodeBase64Url(encrypted.slice(0, -16)),
        tag: encodeBase64Url(encrypted.slice(-16)),
      }),
    );
    this.#sendSequence += 1n;
  }

  revoke(): void {
    if (this.#authenticated) {
      this.sendEvent({
        v: 1,
        ts: Date.now(),
        eventType: 'SYSTEM_REVOKED',
        reason: 'USER_MANUAL_REVOKE',
      });
    }
    this.#transport.close(4001);
  }

  #sendSnapshot(): void {
    const snapshot = this.#store.snapshot();
    this.sendEvent({
      v: 1,
      ts: Date.now(),
      eventType: 'STATE_UPDATE',
      revision: snapshot.revision,
      state: snapshot.state,
      buffer: { text: snapshot.text, truncated: snapshot.truncated },
      ...(this.#channel.label === undefined ? {} : { meta: { channelLabel: this.#channel.label } }),
    });
  }
}

export class PublisherCore {
  readonly registry: ChannelRegistry;
  #stores = new Map<string, CompositionStore>();
  #connections = new Map<string, Set<PublisherConnection>>();

  private constructor(registry: ChannelRegistry) {
    this.registry = registry;
    for (const record of registry.list()) {
      this.#stores.set(
        record.channelId,
        new CompositionStore({
          state: 'IDLE',
          text: '',
          truncated: false,
          revision: record.revision,
        }),
      );
      this.#connections.set(record.channelId, new Set());
    }
  }

  static async create(filePath?: string, protector?: SecretProtector): Promise<PublisherCore> {
    const selectedProtector =
      protector ?? (filePath === undefined ? plainProtector : defaultProtector());
    return new PublisherCore(await ChannelRegistry.open(filePath, selectedProtector));
  }

  async pair(channelType: 'persistent' | 'ephemeral', label?: string): Promise<ChannelRecord> {
    const channel = await this.registry.create(channelType, label);
    this.#stores.set(channel.channelId, new CompositionStore());
    this.#connections.set(channel.channelId, new Set());
    return channel;
  }

  pairingFragment(channel: ChannelRecord): string {
    return buildFragment({
      flag: channel.channelType === 'persistent' ? 'p' : 'e',
      channelId: channel.channelId,
      key: channel.secret,
    });
  }

  connect(channelId: string, transport: SubscriberTransport): PublisherConnection {
    const channel = this.registry.get(channelId);
    if (channel === undefined || channel.revoked === true)
      throw new Error('channel revoked or unknown');
    const store = this.#stores.get(channelId) ?? new CompositionStore();
    this.#stores.set(channelId, store);
    const connections = this.#connections.get(channelId) ?? new Set<PublisherConnection>();
    const connection = new PublisherConnection(channel, store, transport);
    connections.add(connection);
    this.#connections.set(channelId, connections);
    return connection;
  }

  async apply(channelId: string, command: ContentCommand): Promise<void> {
    const store = this.#stores.get(channelId);
    if (store === undefined) throw new Error('channel is not active');
    const event = store.apply(command);
    const record = this.registry.get(channelId);
    if (record === undefined || event === undefined) return;
    await this.registry.update({ ...record, revision: event.snapshot.revision });
    const protocolEvent: ProtocolEvent =
      event.type === 'CLEAR_BUFFER'
        ? {
            v: 1,
            ts: Date.now(),
            eventType: 'CLEAR_BUFFER',
            reason: 'USER_CLEARED_MESSAGE_BAR',
            revision: event.snapshot.revision,
            cid: channelId,
          }
        : {
            v: 1,
            ts: Date.now(),
            eventType: 'STATE_UPDATE',
            revision: event.snapshot.revision,
            state: event.snapshot.state,
            buffer: { text: event.snapshot.text, truncated: event.snapshot.truncated },
            ...(record.label === undefined ? {} : { meta: { channelLabel: record.label } }),
          };
    for (const connection of this.#connections.get(channelId) ?? [])
      connection.sendEvent(protocolEvent);
  }

  async revoke(channelId: string): Promise<void> {
    for (const connection of this.#connections.get(channelId) ?? []) connection.revoke();
    this.#connections.delete(channelId);
    this.#stores.delete(channelId);
    await this.registry.revoke(channelId);
  }

  async revokeAll(): Promise<void> {
    for (const record of this.registry.list()) {
      for (const connection of this.#connections.get(record.channelId) ?? []) connection.revoke();
    }
    this.#connections.clear();
    this.#stores.clear();
    await this.registry.revokeAll();
  }

  disconnect(channelId: string, connection: PublisherConnection): void {
    this.#connections.get(channelId)?.delete(connection);
  }

  subscriberCount(channelId?: string): number {
    if (channelId !== undefined) return this.#connections.get(channelId)?.size ?? 0;
    let count = 0;
    for (const connections of this.#connections.values()) count += connections.size;
    return count;
  }

  async applyAll(command: ContentCommand): Promise<void> {
    await Promise.all(this.registry.list().map((record) => this.apply(record.channelId, command)));
  }
}
