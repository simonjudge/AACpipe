import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getResponder: vi.fn(),
  createService: vi.fn(),
  advertise: vi.fn<() => Promise<void>>(),
  shutdown: vi.fn<() => Promise<void>>(),
  destroy: vi.fn<() => Promise<void>>(),
}));
vi.mock('@homebridge/ciao', () => ({
  getResponder: mocks.getResponder,
}));

import { pairingLinks, startDiscovery, type PublisherDiscovery } from './discovery.js';

describe('Publisher mDNS discovery', () => {
  let directory: string;
  let service: EventEmitter & { serviceState: string };
  const discoveries: PublisherDiscovery[] = [];

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(path.join(os.tmpdir(), 'aacpipe-mdns-'));
    service = Object.assign(new EventEmitter(), {
      serviceState: 'announced',
      advertise: mocks.advertise.mockResolvedValue(),
      destroy: mocks.destroy.mockResolvedValue(),
    });
    mocks.createService.mockReturnValue(service);
    mocks.shutdown.mockResolvedValue();
    mocks.getResponder.mockReturnValue({
      createService: mocks.createService,
      shutdown: mocks.shutdown,
    });
  });

  afterEach(async () => {
    for (const discovery of discoveries.splice(0)) await discovery.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function start(): PublisherDiscovery {
    const discovery = startDiscovery(directory, 47391, vi.fn());
    discoveries.push(discovery);
    return discovery;
  }

  it('persists a unique hostname, advertises IPv4 only and reuses it on restart', async () => {
    const first = start();
    expect(first.state()).toEqual({ status: 'starting' });
    await vi.waitFor(() => expect(first.state().status).toBe('ready'));
    const identity = JSON.parse(await readFile(path.join(directory, 'discovery.json'), 'utf8')) as {
      hostname: string;
    };
    expect(identity.hostname).toMatch(/^aacpipe-[a-f0-9]{16}$/u);
    expect(first.state()).toEqual({ status: 'ready', hostname: `${identity.hostname}.local` });
    expect(mocks.createService).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: identity.hostname,
        type: 'aacpipe',
        port: 47391,
        disabledIpv6: true,
        txt: { v: '1', path: '/' },
      }),
    );
    await first.close();
    await first.close();
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
    const second = start();
    await vi.waitFor(() => expect(second.state()).toEqual(first.state()));
  });

  it('persists conflict-resolved service and host names together', async () => {
    const first = start();
    await vi.waitFor(() => expect(first.state().status).toBe('ready'));
    const identity = JSON.parse(await readFile(path.join(directory, 'discovery.json'), 'utf8')) as {
      hostname: string;
      name: string;
    };
    service.emit('name-change', `${identity.name} (2)`);
    service.emit('hostname-change', `${identity.hostname}-(2)`);
    await vi.waitFor(() =>
      expect(first.state()).toEqual({
        status: 'ready',
        hostname: `${identity.hostname}-(2).local`,
      }),
    );
    await first.close();
    const second = start();
    await vi.waitFor(() => expect(second.state()).toEqual(first.state()));
    expect(mocks.createService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: `${identity.name} (2)`,
        hostname: `${identity.hostname}-(2)`,
      }),
    );
  });

  it('reports an advertising failure without making IP links unavailable', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.advertise.mockRejectedValue(new Error('Multicast blocked'));
    const discovery = start();
    await vi.waitFor(() => expect(discovery.state()).toEqual({ status: 'unavailable' }));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Multicast blocked'));
    expect(pairingLinks(discovery.state(), ['192.168.137.1'], 3210, 'channel', '#secret')).toEqual([
      {
        label: 'IP-address fallback: 192.168.137.1',
        url: 'http://192.168.137.1:3210/?channel=channel#secret',
      },
    ]);
  });

  it('does not replace unreadable or invalid identity data silently', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const file = path.join(directory, 'discovery.json');
    await writeFile(file, 'invalid json');
    const discovery = start();
    await vi.waitFor(() => expect(discovery.state().status).toBe('unavailable'));
    expect(await readFile(file, 'utf8')).toBe('invalid json');
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it('keeps IP fallbacks while probing is pending and can shut down without waiting for it', async () => {
    mocks.advertise.mockReturnValue(new Promise(() => undefined));
    const discovery = start();
    await vi.waitFor(() => expect(mocks.advertise).toHaveBeenCalled());
    expect(discovery.state()).toEqual({ status: 'starting' });
    expect(pairingLinks(discovery.state(), ['192.168.1.2'], 3210, 'c', '#s')).toHaveLength(1);
    await discovery.close();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
  });

  it('does not start advertising if shutdown happens during identity loading', async () => {
    const discovery = start();
    await discovery.close();
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it('warns after ten seconds without blocking startup and recovers if advertising succeeds later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let resolveAdvertisement: (() => void) | undefined;
    mocks.advertise.mockReturnValue(
      new Promise((resolve) => {
        resolveAdvertisement = resolve;
      }),
    );
    const discovery = start();
    await vi.waitFor(() => expect(mocks.advertise).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(discovery.state()).toEqual({ status: 'unavailable' });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('longer than expected'));
    resolveAdvertisement?.();
    await vi.waitFor(() => expect(discovery.state().status).toBe('ready'));
  });

  it('does not offer an unstable hostname if persisting a collision rename fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let resolveAdvertisement: (() => void) | undefined;
    mocks.advertise.mockReturnValue(
      new Promise((resolve) => {
        resolveAdvertisement = resolve;
      }),
    );
    const discovery = start();
    await vi.waitFor(() => expect(mocks.advertise).toHaveBeenCalled());
    const file = path.join(directory, 'discovery.json');
    const identity = JSON.parse(await readFile(file, 'utf8')) as { hostname: string };
    await rm(file);
    await mkdir(file);
    service.emit('hostname-change', `${identity.hostname}-(2)`);
    await vi.waitFor(() => expect(discovery.state().status).toBe('unavailable'));
    resolveAdvertisement?.();
    await Promise.resolve();
    expect(discovery.state().status).toBe('unavailable');
  });
});

describe('Pairing links', () => {
  it('puts the stable name first and preserves the same credential in all IP fallbacks', () => {
    const links = pairingLinks(
      { status: 'ready', hostname: 'aacpipe-0123456789abcdef.local' },
      ['192.168.1.91', '192.168.137.1'],
      3210,
      'channel',
      '#p:channel:secret',
    );
    expect(links.map((link) => link.url)).toEqual([
      'http://aacpipe-0123456789abcdef.local:3210/?channel=channel#p:channel:secret',
      'http://192.168.1.91:3210/?channel=channel#p:channel:secret',
      'http://192.168.137.1:3210/?channel=channel#p:channel:secret',
    ]);
    expect(links[0]?.label).toContain('Recommended');
    expect(links[1]?.label).toContain('fallback');
  });

  it('labels a loopback-only link clearly when no network address is available', () => {
    expect(pairingLinks({ status: 'unavailable' }, [], 3210, 'c', '#s')).toEqual([
      {
        label: 'This Windows device only (no network address available)',
        url: 'http://127.0.0.1:3210/?channel=c#s',
      },
    ]);
    const readyLinks = pairingLinks(
      { status: 'ready', hostname: 'aacpipe-0123456789abcdef.local' },
      [],
      3210,
      'c',
      '#s',
    );
    expect(readyLinks).toHaveLength(2);
    expect(readyLinks[1]?.url).toBe('http://127.0.0.1:3210/?channel=c#s');
  });
});
