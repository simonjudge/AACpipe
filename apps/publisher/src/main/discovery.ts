import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getResponder, type CiaoService, type Responder } from '@homebridge/ciao';
import { z } from 'zod';

const identitySchema = z.object({
  hostname: z
    .string()
    .regex(/^aacpipe-[a-f0-9]{16}(?:-\(\d+\))?$/u)
    .max(63),
  name: z.string().min(1).max(63),
});
type Identity = z.infer<typeof identitySchema>;

export type DiscoveryState =
  { status: 'starting' } | { status: 'ready'; hostname: string } | { status: 'unavailable' };

export interface PublisherDiscovery {
  state(): DiscoveryState;
  close(): Promise<void>;
}

export interface PairingLink {
  label: string;
  url: string;
}

export function pairingLinks(
  discovery: DiscoveryState,
  addresses: readonly string[],
  port: number,
  channelId: string,
  fragment: string,
): PairingLink[] {
  const suffix = `:${String(port)}/?channel=${encodeURIComponent(channelId)}${fragment}`;
  const links: PairingLink[] =
    discovery.status === 'ready'
      ? [
          {
            label: 'Recommended: stable .local address',
            url: `http://${discovery.hostname}${suffix}`,
          },
        ]
      : [];
  for (const address of addresses) {
    links.push({ label: `IP-address fallback: ${address}`, url: `http://${address}${suffix}` });
  }
  if (addresses.length === 0) {
    links.push({
      label: 'This Windows device only (no network address available)',
      url: `http://127.0.0.1${suffix}`,
    });
  }
  return links;
}

async function loadIdentity(file: string): Promise<Identity> {
  try {
    return identitySchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const id = randomBytes(8).toString('hex');
  const identity = { hostname: `aacpipe-${id}`, name: `AACpipe ${id}` };
  await saveIdentity(file, identity);
  return identity;
}

async function saveIdentity(file: string, identity: Identity): Promise<void> {
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(identity)}\n`, 'utf8');
  await rename(temporary, file);
}

export function startDiscovery(
  directory: string,
  port: number,
  onChange: () => void,
): PublisherDiscovery {
  const file = path.join(directory, 'discovery.json');
  let state: DiscoveryState = { status: 'starting' };
  let closed = false;
  let responder: Responder | undefined;
  let service: CiaoService | undefined;
  let writes = Promise.resolve();
  let persistenceFailed = false;
  let advertised = false;

  const update = (next: DiscoveryState): void => {
    if (closed) return;
    state = next;
    onChange();
  };
  const warn = (error: unknown): void => {
    console.warn(
      `AACpipe Publisher: .local discovery unavailable; use an IP-address fallback. ${error instanceof Error ? error.message : String(error)}`,
    );
    update({ status: 'unavailable' });
  };
  // Probing must never delay Grid commands, including on networks that block multicast.
  const timeout = setTimeout(() => {
    warn(new Error('mDNS startup is taking longer than expected'));
  }, 10_000);
  timeout.unref();

  const started = (async (): Promise<void> => {
    const identity = await loadIdentity(file);
    if (closed) return;
    responder = getResponder({ disableIpv6: true });
    service = responder.createService({
      name: identity.name,
      hostname: identity.hostname,
      type: 'aacpipe',
      port,
      disabledIpv6: true,
      txt: { v: '1', path: '/' },
    });

    const persistChange = (change: Partial<Identity>): void => {
      Object.assign(identity, change);
      const snapshot = { ...identity };
      update({ status: 'starting' });
      writes = writes
        .then(async () => {
          await saveIdentity(file, identitySchema.parse(snapshot));
          if (
            !persistenceFailed &&
            advertised &&
            snapshot.hostname === identity.hostname &&
            snapshot.name === identity.name
          ) {
            update({ status: 'ready', hostname: `${snapshot.hostname}.local` });
          }
        })
        .catch((error: unknown) => {
          persistenceFailed = true;
          warn(error);
        });
    };
    service.on('name-change', (name) => persistChange({ name }));
    service.on('hostname-change', (hostname) => persistChange({ hostname }));
    // The library monitors interfaces and re-advertises after network/address changes.
    void service
      .advertise()
      .then(async () => {
        clearTimeout(timeout);
        advertised = true;
        await writes;
        if (persistenceFailed) return;
        update({ status: 'ready', hostname: `${identity.hostname}.local` });
        if (!closed) console.log(`AACpipe Publisher: .local hostname ${identity.hostname}.local`);
      })
      .catch((error: unknown) => {
        clearTimeout(timeout);
        warn(error);
      });
  })().catch((error: unknown) => {
    clearTimeout(timeout);
    warn(error);
  });

  return {
    state: () => state,
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      await started;
      await writes;
      try {
        await service?.destroy();
      } finally {
        await responder?.shutdown();
      }
    },
  };
}
