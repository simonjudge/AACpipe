import { createReadStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { arch, networkInterfaces, platform, release } from 'node:os';
import path from 'node:path';

import QRCode from 'qrcode';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import { pairingLinks, startDiscovery, type DiscoveryState } from './discovery.js';
import { appInfo } from './app-info.js';
import { Diagnostics } from './diagnostics.js';
import { hasManagementAccess } from './management-access.js';
import { createMvpRequestHandler } from './mvp-handler.js';
import {
  loadNativeModule,
  parseNativePipeReceiveResult,
  type NativePipeRequest,
} from './native.js';
import {
  DuplicateLabelError,
  PublisherCore,
  type ChannelRecord,
  type PublisherConnection,
} from './publisher.js';

const native = loadNativeModule();
const instanceLock = new native.PublisherInstanceLock(native.defaultPublisherMutexName());
const port = parsePort(process.env['AACPIPE_PORT']);
const host = '0.0.0.0';
const root = process.env['AACPIPE_APP_ROOT'] ?? process.cwd();
const subscriberPublic = path.join(root, 'apps', 'subscriber', 'public');
const subscriberBundle = path.join(root, 'apps', 'subscriber', 'dist', 'subscriber.js');
const dataDirectory =
  process.env['AACPIPE_DATA_DIR'] ??
  path.join(
    process.env['LOCALAPPDATA'] ?? path.join(process.env['USERPROFILE'] ?? '.', 'AppData', 'Local'),
    'AACpipe',
  );
const channelFile = path.join(dataDirectory, 'channels.json');
const sockets = new Set<WebSocket>();
const socketAlive = new WeakMap<WebSocket, boolean>();
const socketChannels = new WeakMap<WebSocket, string>();
const managementToken = randomBytes(32).toString('base64url');
const managementAccess = randomBytes(32).toString('base64url');
const diagnostics = new Diagnostics();
const managementErrors = new Map([
  ['label-in-use', 'A pairing with that name already exists. Choose a different name.'],
  ['label-invalid', 'Enter a name of 1 to 128 characters for the permanent pairing.'],
]);
let speakingTimer: NodeJS.Timeout | undefined;

export type ChannelChange = 'paired' | 'changed';
export type WindowRequest = 'show' | 'hide';

export interface MvpPublisher {
  readonly port: number;
  readonly managementAccess: string;
  createOneTimePairing(): Promise<void>;
  onChannelsChanged(listener: (change: ChannelChange) => void): void;
  onWindowRequest(listener: (request: WindowRequest) => void): void;
  close(): Promise<void>;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3210;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    throw new Error('AACPIPE_PORT must be an integer from 1024 to 65535');
  }
  return parsed;
}

function commandSummary(payload: string): { command: string; window?: WindowRequest } {
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value === 'object' &&
      value !== null &&
      'cmd' in value &&
      typeof value.cmd === 'string'
    ) {
      const window =
        'window' in value && (value.window === 'show' || value.window === 'hide')
          ? value.window
          : undefined;
      return window === undefined ? { command: value.cmd } : { command: value.cmd, window };
    }
  } catch {
    // The handler reports malformed payloads without logging their contents.
  }
  return { command: 'invalid' };
}

function localAddresses(): Array<{ address: string; adapter: string }> {
  const addresses = new Map<string, string>();
  for (const [adapter, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.set(entry.address, adapter);
    }
  }
  return [...addresses].map(([address, adapter]) => ({ address, adapter }));
}

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function securityHeaders(response: ServerResponse, formAction = "'none'"): void {
  response.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`,
  );
  // no-referrer would make Chromium send "Origin: null" on the pairing window's own form posts.
  response.setHeader('Referrer-Policy', formAction === "'none'" ? 'no-referrer' : 'same-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cache-Control', 'no-store');
}

function streamFile(response: ServerResponse, filePath: string, contentType: string): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType);
  const stream = createReadStream(filePath);
  stream.on('error', (error) => {
    console.error(`AACpipe Publisher: static asset read failed: ${error.message}`);
    if (!response.headersSent) response.statusCode = 500;
    response.end('Asset unavailable');
  });
  stream.pipe(response);
}

// iOS Safari only plays video from servers that honour byte-range requests.
async function serveMedia(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> {
  const body = await readFile(filePath);
  response.setHeader('Content-Type', contentType);
  response.setHeader('Accept-Ranges', 'bytes');
  const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range ?? '');
  if (range === null) {
    response.statusCode = 200;
    response.setHeader('Content-Length', String(body.length));
    response.end(body);
    return;
  }
  const [, startText = '', endText = ''] = range;
  let start = startText === '' ? body.length - Number(endText) : Number(startText);
  let end = startText === '' || endText === '' ? body.length - 1 : Number(endText);
  start = Math.max(0, start);
  end = Math.min(body.length - 1, end);
  if (start > end || (startText === '' && endText === '')) {
    response.statusCode = 416;
    response.setHeader('Content-Range', `bytes */${String(body.length)}`);
    response.end();
    return;
  }
  response.statusCode = 206;
  response.setHeader(
    'Content-Range',
    `bytes ${String(start)}-${String(end)}/${String(body.length)}`,
  );
  response.setHeader('Content-Length', String(end - start + 1));
  response.end(body.subarray(start, end + 1));
}

function readSmallBody(request: IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function tokenMatches(value: string | null): boolean {
  if (value === null) return false;
  const expected = Buffer.from(managementToken);
  const received = Buffer.from(value);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// Management actions are accepted only from the local pairing window, never from other sites.
function trustedManagementOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return (
    origin === `http://127.0.0.1:${String(port)}` || origin === `http://localhost:${String(port)}`
  );
}

async function pairingOptionsHtml(
  core: PublisherCore,
  channel: ChannelRecord,
  discovery: DiscoveryState,
): Promise<string> {
  const addresses = localAddresses();
  const fragment = core.pairingFragment(channel);
  const options = await Promise.all(
    pairingLinks(
      discovery,
      addresses.map(({ address }) => address),
      port,
      channel.channelId,
      fragment,
    ).map(async (link) => ({
      ...link,
      qr: await QRCode.toDataURL(link.url, { errorCorrectionLevel: 'M', margin: 2, width: 320 }),
    })),
  );
  const rendered = options.map(({ label, url, qr }) => {
    const adapter = addresses.find(({ address }) => new URL(url).hostname === address)?.adapter;
    return `<div class="pairing-option">
        <h3>${html(label)}${adapter === undefined ? '' : ` (${html(adapter)})`}</h3>
        <img src="${qr}" alt="Pairing QR code for ${html(channel.label ?? 'Partner')}" />
        <p><a href="${html(url)}">${html(url)}</a></p>
        <button type="button" data-copy-link>Copy link</button>
      </div>`;
  });
  if (discovery.status !== 'ready') return rendered.join('');
  return `${rendered[0] ?? ''}
    <details class="fallbacks"><summary>IP-address fallbacks (if .local does not open)</summary>
    <p>Choose the adapter on your shared network, not a VPN. These links contain the same secret.</p>
    ${rendered.slice(1).join('')}</details>`;
}

function tokenField(): string {
  return `<input type="hidden" name="token" value="${html(managementToken)}">`;
}

function channelLabel(channel: ChannelRecord): string {
  return channel.label ?? 'Partner';
}

function sectionHeading(channel: ChannelRecord): string {
  const badge =
    channel.channelType === 'ephemeral'
      ? ' <span class="badge">One-time</span>'
      : ' <span class="badge permanent">Permanent</span>';
  return `<div class="section-heading">
    <h2>${html(channelLabel(channel))}${badge}</h2>
    <form method="post" action="/manage/revoke">
      ${tokenField()}
      <input type="hidden" name="channel" value="${html(channel.channelId)}">
      <button type="submit" class="danger">Revoke</button>
    </form>
  </div>`;
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
  <html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
  <title>${html(title)}</title><link rel="stylesheet" href="/manage/style.css"><script type="module" src="/manage/script.js"></script></head>
  <body>${body}</body></html>`;
}

function revokeConfirmationPage(channel: ChannelRecord): string {
  const label = html(channelLabel(channel));
  const consequence =
    channel.channelType === 'ephemeral'
      ? 'The partner screen will stop showing messages immediately.'
      : 'The partner screen will stop showing messages immediately, and they will need to scan a new QR code to pair again.';
  return pageShell(
    'Revoke pairing - AACpipe',
    `<h1>Revoke &ldquo;${label}&rdquo;?</h1>
    <p>${consequence}</p>
    <div class="toolbar">
      <form method="post" action="/manage/revoke">
        ${tokenField()}
        <input type="hidden" name="channel" value="${html(channel.channelId)}">
        <input type="hidden" name="confirm" value="yes">
        <button type="submit" class="danger">Revoke &ldquo;${label}&rdquo;</button>
      </form>
      <a class="button-link" href="/manage">Cancel</a>
    </div>`,
  );
}

async function managementPage(
  core: PublisherCore,
  discovery: DiscoveryState,
  error?: string,
): Promise<string> {
  const channels = core.registry.list();
  const oneTime = channels.filter((channel) => channel.channelType === 'ephemeral').reverse();
  const persistent = channels.filter((channel) => channel.channelType === 'persistent');

  const oneTimeSections = await Promise.all(
    oneTime.map(async (channel) => {
      const connected = core.subscriberCount(channel.channelId) > 0;
      const body = connected
        ? '<p class="connected">Partner connected. This pairing ends when they close the page or lose connection.</p>'
        : `<p><strong>Waiting for partner.</strong> Ask the partner to scan this QR code. It works once and ends when they disconnect.</p>
           ${await pairingOptionsHtml(core, channel, discovery)}`;
      return `<section class="one-time">
        ${sectionHeading(channel)}
        ${body}
      </section>`;
    }),
  );

  const persistentSections = await Promise.all(
    persistent.map(
      async (channel) => `<section>
        ${sectionHeading(channel)}
        <p>${
          core.subscriberCount(channel.channelId) > 0
            ? '<span class="connected">Partner connected.</span> '
            : '<strong>Waiting for partner.</strong> '
        }Scan the QR code for the network used by both devices. This pairing is remembered until it is revoked.</p>
        ${await pairingOptionsHtml(core, channel, discovery)}
      </section>`,
    ),
  );

  const errorMessage = error === undefined ? undefined : managementErrors.get(error);
  return pageShell(
    'AACpipe Pairing',
    `<h1>AACpipe partner pairing</h1>
  <p>This page is available only on this Windows device. Pairing links contain a secret; do not share them with anyone other than the intended partner.</p>
  <p class="preview">Experimental preview ${html(appInfo.version)}. Trusted private networks only. An active attacker on the network could access conversation text.</p>
  <p><a class="button-link" href="/manage">Refresh network information</a></p>
  <p id="copy-status" role="status" aria-live="polite"></p>
  ${
    discovery.status === 'ready'
      ? `<p>Try the recommended <strong>${html(discovery.hostname)}</strong> QR code first. If it does not open on your partner device, use an IP-address fallback for your shared network. IP-address links can change when you switch networks.</p>`
      : `<p class="notice" role="status">${
          discovery.status === 'starting'
            ? 'Setting up the .local address. You can use an IP-address fallback now.'
            : '.local discovery is unavailable. Use an IP-address fallback below. Check that your trusted network allows mDNS (UDP 5353), then restart AACpipe to retry.'
        }</p>`
  }
  ${errorMessage === undefined ? '' : `<p class="notice" role="alert">${html(errorMessage)}</p>`}
  <div class="toolbar">
    <form method="post" action="/manage/one-time">
      ${tokenField()}
      <button type="submit">New one-time pairing</button>
    </form>
    <form method="post" action="/manage/permanent" class="permanent-form">
      ${tokenField()}
      <label for="permanent-label">Partner name</label>
      <input id="permanent-label" name="label" type="text" required maxlength="128" autocomplete="off" placeholder="e.g. Mum">
      <button type="submit">New permanent pairing</button>
    </form>
  </div>
  ${oneTimeSections.join('')}
  ${persistentSections.join('') || '<p>No permanent pairings exist. Enter a partner name above and select <strong>New permanent pairing</strong>.</p>'}
  <footer>
    <details><summary>About AACpipe ${html(appInfo.version)}</summary>
    <p>By ${html(appInfo.author)}. ${html(appInfo.license)} licence. Unsigned experimental Windows preview.</p>
    <p>An additional communication display, not a replacement for your AAC app or speech output. No cloud service or analytics. Trusted local networks only.</p>
    <p>Third-party notices and the licence are included with the installation.</p>
    </details>
    <details><summary>Diagnostics (safe to review and share)</summary>
    <p>No conversation text, pairing links, names, network addresses or secrets are included.</p>
    <pre id="diagnostics-text">${html(
      diagnostics.report({
        version: appInfo.version,
        platform: platform(),
        release: release(),
        architecture: arch(),
        discovery,
        adapterCount: localAddresses().length,
        channelCount: channels.length,
        subscriberCount: core.subscriberCount(),
        port,
      }),
    )}</pre>
    <button type="button" id="copy-diagnostics">Copy diagnostics</button>
    </details>
  </footer>`,
  );
}

export async function startMvp(
  onFatalError?: (error: Error) => void,
): Promise<MvpPublisher | undefined> {
  if (!instanceLock.isOwner) {
    console.log('AACpipe Publisher: another Publisher instance is already running');
    return undefined;
  }
  await mkdir(dataDirectory, { recursive: true });
  const core = await PublisherCore.create(channelFile);
  if (core.registry.list().length === 0) await core.pair('persistent');
  const handler = createMvpRequestHandler(core);
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const changeListeners: Array<(change: ChannelChange) => void> = [];
  const notifyChannels = (change: ChannelChange): void => {
    for (const listener of changeListeners) {
      try {
        listener(change);
      } catch (error) {
        console.error(
          `AACpipe Publisher: channel listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  const windowListeners: Array<(request: WindowRequest) => void> = [];
  const requestWindow = (request: WindowRequest): void => {
    for (const listener of windowListeners) {
      try {
        listener(request);
      } catch (error) {
        console.error(
          `AACpipe Publisher: window listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  const endOneTimePairing = async (channelId: string): Promise<boolean> => {
    const channel = core.registry.get(channelId);
    if (channel?.channelType !== 'ephemeral') return false;
    await core.revoke(channelId);
    console.log('AACpipe Publisher: one-time pairing ended');
    return true;
  };

  const handleManagementPost = async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> => {
    const forbidden = (): void => {
      diagnostics.record('management-rejected');
      response.statusCode = 403;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        pageShell(
          'Not allowed - AACpipe',
          '<h1>That action was not allowed</h1><p><a class="button-link" href="/manage">Back to pairing</a></p>',
        ),
      );
    };
    if (!isLoopback(request) || !trustedManagementOrigin(request)) {
      forbidden();
      return;
    }
    const form = new URLSearchParams(await readSmallBody(request));
    if (!tokenMatches(form.get('token'))) {
      forbidden();
      return;
    }
    const redirect = (location: string): void => {
      response.statusCode = 303;
      response.setHeader('Location', location);
      response.end();
    };
    if (pathname === '/manage/one-time') {
      await handler.pair('ephemeral');
      redirect('/manage');
      return;
    }
    if (pathname === '/manage/permanent') {
      const label = (form.get('label') ?? '').trim();
      if (label === '' || Buffer.byteLength(label, 'utf8') > 128) {
        redirect('/manage?error=label-invalid');
        return;
      }
      try {
        await handler.pair('persistent', label);
      } catch (error) {
        if (error instanceof DuplicateLabelError) {
          redirect('/manage?error=label-in-use');
          return;
        }
        throw error;
      }
      console.log('AACpipe Publisher: permanent pairing created from the pairing window');
      redirect('/manage');
      return;
    }
    const channel = core.registry.get(form.get('channel') ?? '');
    if (channel === undefined) {
      redirect('/manage');
      return;
    }
    if (form.get('confirm') !== 'yes') {
      securityHeaders(response, "'self'");
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(revokeConfirmationPage(channel));
      return;
    }
    await core.revoke(channel.channelId);
    console.log('AACpipe Publisher: pairing revoked from the pairing window');
    redirect('/manage');
  };

  const server = createServer((request, response) => {
    securityHeaders(response);
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (
      url.pathname.startsWith('/manage') &&
      (!isLoopback(request) || !hasManagementAccess(request.headers.cookie, managementAccess))
    ) {
      diagnostics.record('management-rejected');
      response.statusCode = 403;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        pageShell(
          'Open AACpipe',
          '<h1>Open the AACpipe pairing window</h1><p>Pairing management is available only inside the AACpipe app. Open it from the Windows tray or shortcut.</p>',
        ),
      );
      return;
    }
    if (
      request.method === 'POST' &&
      (url.pathname === '/manage/one-time' ||
        url.pathname === '/manage/permanent' ||
        url.pathname === '/manage/revoke')
    ) {
      void handleManagementPost(request, response, url.pathname).catch((error: unknown) => {
        diagnostics.record('management-failed');
        console.error(
          `AACpipe Publisher: management action failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!response.headersSent) {
          response.statusCode = 400;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
        }
        response.end(
          pageShell(
            'Action failed - AACpipe',
            '<h1>That action failed</h1><p><a class="button-link" href="/manage">Back to pairing</a></p>',
          ),
        );
      });
      return;
    }
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.end('Method not allowed');
      return;
    }
    if (url.pathname === '/manage') {
      if (!isLoopback(request)) {
        response.statusCode = 403;
        response.end('Pairing management is available only on the Publisher device');
        return;
      }
      securityHeaders(response, "'self'");
      void managementPage(core, discovery.state(), url.searchParams.get('error') ?? undefined)
        .then((page) => {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(page);
        })
        .catch((error: unknown) => {
          diagnostics.record('page-failed');
          console.error(
            `AACpipe Publisher: pairing page failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          response.statusCode = 500;
          response.end('Pairing page unavailable');
        });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      streamFile(response, path.join(subscriberPublic, 'index.html'), 'text/html; charset=utf-8');
      return;
    }
    if (url.pathname === '/subscriber.css') {
      streamFile(
        response,
        path.join(subscriberPublic, 'subscriber.css'),
        'text/css; charset=utf-8',
      );
      return;
    }
    if (url.pathname === '/manage/style.css') {
      streamFile(response, path.join(subscriberPublic, 'manage.css'), 'text/css; charset=utf-8');
      return;
    }
    if (url.pathname === '/manage/script.js') {
      streamFile(
        response,
        path.join(root, 'apps', 'subscriber', 'dist', 'manage.js'),
        'text/javascript; charset=utf-8',
      );
      return;
    }
    if (url.pathname === '/subscriber.js') {
      streamFile(response, subscriberBundle, 'text/javascript; charset=utf-8');
      return;
    }
    if (url.pathname === '/keep-awake.mp4') {
      void serveMedia(
        request,
        response,
        path.join(subscriberPublic, 'keep-awake.mp4'),
        'video/mp4',
      ).catch((error: unknown) => {
        console.error(
          `AACpipe Publisher: media read failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!response.headersSent) response.statusCode = 500;
        response.end();
      });
      return;
    }
    response.statusCode = 404;
    response.end('Not found');
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const channelId = url.searchParams.get('channel');
    if (
      url.pathname !== '/ws' ||
      channelId === null ||
      core.registry.get(channelId) === undefined
    ) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      socketChannels.set(webSocket, channelId);
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (socket: WebSocket) => {
    const channelId = socketChannels.get(socket);
    if (channelId === undefined) {
      socket.close(4003);
      return;
    }
    sockets.add(socket);
    socketAlive.set(socket, true);
    let connection: PublisherConnection;
    let authenticated = false;
    if (core.subscriberCount(channelId) >= 1) {
      socket.close(4003);
      return;
    }
    try {
      connection = core.connect(channelId, {
        send(value) {
          if (socket.readyState === WebSocket.OPEN) socket.send(value);
        },
        close(code) {
          socket.close(code);
        },
      });
    } catch {
      socket.close(4003);
      return;
    }
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) socket.close(4003);
    }, 10_000);
    socket.on('pong', () => socketAlive.set(socket, true));
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary || authenticated) {
        socket.close(4002);
        return;
      }
      try {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : data;
        connection.authenticate(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
        authenticated = true;
        clearTimeout(handshakeTimer);
        if (core.registry.get(channelId)?.channelType === 'ephemeral') notifyChannels('changed');
      } catch (error) {
        console.warn(
          `AACpipe Publisher: subscriber authentication failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      sockets.delete(socket);
      core.disconnect(channelId, connection);
      // Only an authenticated session ends a one-time pairing, so unauthenticated probes cannot cancel it.
      if (authenticated && !shuttingDown) {
        void endOneTimePairing(channelId)
          .then((ended) => {
            if (ended) notifyChannels('changed');
          })
          .catch((error: unknown) => {
            console.error(
              `AACpipe Publisher: ending one-time pairing failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
    });
    socket.on('error', (error: Error) => {
      console.warn(`AACpipe Publisher: subscriber socket error: ${error.message}`);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets) {
      if (socketAlive.get(socket) !== true) {
        socket.terminate();
        continue;
      }
      socketAlive.set(socket, false);
      socket.ping();
    }
  }, 20_000);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const pipe = new native.SecurePipeServer(native.defaultPipeName());
  const discovery = startDiscovery(dataDirectory, port, () => {
    if (discovery.state().status === 'unavailable') diagnostics.record('discovery-unavailable');
    notifyChannels('changed');
  });
  console.log(`AACpipe Publisher: partner screen listening on port ${String(port)}`);
  console.log(`AACpipe Publisher: pairing management http://127.0.0.1:${String(port)}/manage`);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    if (speakingTimer !== undefined) clearTimeout(speakingTimer);
    for (const socket of sockets) socket.close(1001);
    webSocketServer.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 1000).unref();
    });
    await discovery.close().catch((error: unknown) => {
      console.warn(
        `AACpipe Publisher: mDNS shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const receiveCommands = async (): Promise<void> => {
    try {
      while (!shuttingDown) {
        const received = await pipe.receive(30_000);
        const request: NativePipeRequest | undefined = parseNativePipeReceiveResult(received);
        if (request === undefined) continue;
        const { command, window } = commandSummary(request.payload);
        const response = await handler.processPayload(request.payload);
        if (response.ok && response.state === 'SPEAKING') {
          if (speakingTimer !== undefined) clearTimeout(speakingTimer);
          speakingTimer = setTimeout(() => {
            void handler.finishSpeaking().catch((error: unknown) => {
              console.error(
                `AACpipe Publisher: speaking timer failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          }, 4000);
        }
        await pipe.respond(request.connectionId, JSON.stringify(response));
        // An explicit --hide on pair refreshes the window without bringing it forward.
        if (response.ok && command === 'pair') {
          notifyChannels(window === 'hide' ? 'changed' : 'paired');
        }
        if (response.ok && command === 'revoke') notifyChannels('changed');
        if (window !== undefined) requestWindow(window);
        if (response.ok) {
          console.log(
            `AACpipe Publisher: command=${command} state=${response.state} revision=${response.revision} channels=${response.channels} subscribers=${response.subscribers}`,
          );
        } else {
          diagnostics.record('ipc-rejected');
          console.log(`AACpipe Publisher: command=${command} rejected code=${response.code}`);
        }
      }
    } catch (error) {
      if (shuttingDown) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      console.error(`AACpipe Publisher: named-pipe command loop failed: ${failure.message}`);
      await shutdown();
      onFatalError?.(failure);
    }
  };
  void receiveCommands();
  return {
    port,
    managementAccess,
    async createOneTimePairing() {
      await handler.pair('ephemeral');
      notifyChannels('paired');
    },
    onChannelsChanged(listener) {
      changeListeners.push(listener);
    },
    onWindowRequest(listener) {
      windowListeners.push(listener);
    },
    close: shutdown,
  };
}
