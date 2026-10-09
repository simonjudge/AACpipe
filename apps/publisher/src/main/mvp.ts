import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import QRCode from 'qrcode';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import { createMvpRequestHandler } from './mvp-handler.js';
import {
  loadNativeModule,
  parseNativePipeReceiveResult,
  type NativePipeRequest,
} from './native.js';
import { PublisherCore, type PublisherConnection } from './publisher.js';

const native = loadNativeModule();
const instanceLock = new native.PublisherInstanceLock(native.defaultPublisherMutexName());
const port = parsePort(process.env['AACPIPE_PORT']);
const host = '0.0.0.0';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
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
let speakingTimer: NodeJS.Timeout | undefined;

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3210;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    throw new Error('AACPIPE_PORT must be an integer from 1024 to 65535');
  }
  return parsed;
}

function commandName(payload: string): string {
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value === 'object' &&
      value !== null &&
      'cmd' in value &&
      typeof value.cmd === 'string'
    ) {
      return value.cmd;
    }
  } catch {
    // The handler reports malformed payloads without logging their contents.
  }
  return 'invalid';
}

function localAddresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.add(entry.address);
    }
  }
  return [...addresses];
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

function securityHeaders(response: ServerResponse): void {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  response.setHeader('Referrer-Policy', 'no-referrer');
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

async function managementPage(core: PublisherCore): Promise<string> {
  const addresses = localAddresses();
  const channelSections = await Promise.all(
    core.registry.list().map(async (channel) => {
      const fragment = core.pairingFragment(channel);
      const urls = (addresses.length === 0 ? ['127.0.0.1'] : addresses).map(
        (address) =>
          `http://${address}:${String(port)}/?channel=${encodeURIComponent(channel.channelId)}${fragment}`,
      );
      const pairingOptions = await Promise.all(
        urls.map(async (url) => ({
          url,
          qr: await QRCode.toDataURL(url, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 320,
          }),
        })),
      );
      return `<section>
        <h2>${html(channel.label ?? 'Partner')}</h2>
        <p>Channel <code>${html(channel.channelId)}</code> (${html(channel.channelType)})</p>
        <p>Scan the QR code for the network used by both devices.</p>
        ${pairingOptions
          .map(
            ({ url, qr }) => `<div class="pairing-option">
              <img src="${qr}" alt="Pairing QR code for ${html(channel.label ?? 'Partner')}" />
              <p><a href="${html(url)}">${html(url)}</a></p>
            </div>`,
          )
          .join('')}
      </section>`;
    }),
  );
  return `<!doctype html>
  <html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
  <title>AACpipe Pairing</title><link rel="stylesheet" href="/manage.css"></head>
  <body><h1>AACpipe partner pairing</h1>
  <p>This page is available only on this Windows device. Pairing links contain a secret; do not share them with anyone other than the intended partner.</p>
  ${channelSections.join('') || '<p>No channels exist. Run the bridge with <code>--pair --persistent</code>.</p>'}
  </body></html>`;
}

async function main(): Promise<void> {
  if (!instanceLock.isOwner) {
    console.log('AACpipe Publisher: another Publisher instance is already running');
    return;
  }
  await mkdir(dataDirectory, { recursive: true });
  const core = await PublisherCore.create(channelFile);
  if (core.registry.list().length === 0) await core.pair('persistent', 'Partner');
  const handler = createMvpRequestHandler(core);
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  const server = createServer((request, response) => {
    securityHeaders(response);
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
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
      void managementPage(core)
        .then((page) => {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(page);
        })
        .catch((error: unknown) => {
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
    if (url.pathname === '/manage.css') {
      streamFile(response, path.join(subscriberPublic, 'manage.css'), 'text/css; charset=utf-8');
      return;
    }
    if (url.pathname === '/subscriber.js') {
      streamFile(response, subscriberBundle, 'text/javascript; charset=utf-8');
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
  console.log(`AACpipe Publisher: partner screen listening on port ${String(port)}`);
  console.log(`AACpipe Publisher: pairing management http://127.0.0.1:${String(port)}/manage`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    if (speakingTimer !== undefined) clearTimeout(speakingTimer);
    for (const socket of sockets) socket.close(1001);
    webSocketServer.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  for (;;) {
    const received = await pipe.receive(30_000);
    const request: NativePipeRequest | undefined = parseNativePipeReceiveResult(received);
    if (request === undefined) continue;
    const command = commandName(request.payload);
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
    if (response.ok) {
      console.log(
        `AACpipe Publisher: command=${command} state=${response.state} revision=${response.revision} channels=${response.channels} subscribers=${response.subscribers}`,
      );
    } else {
      console.log(`AACpipe Publisher: command=${command} rejected code=${response.code}`);
    }
  }
}

await main();
