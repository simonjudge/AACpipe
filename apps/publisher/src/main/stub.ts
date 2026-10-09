import { appendFileSync, writeFileSync } from 'node:fs';

import {
  loadNativeModule,
  parseNativePipeReceiveResult,
  type NativePipeRequest,
} from './native.js';
import { createPublisherRequestHandler } from './request-handler.js';

const native = loadNativeModule();
const handler = createPublisherRequestHandler();
const instanceLock = new native.PublisherInstanceLock(native.defaultPublisherMutexName());
let speakingTimer: NodeJS.Timeout | undefined;

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
    // The request handler reports malformed payloads; logging only the category is sufficient.
  }
  return 'invalid';
}

function updateSpeakingTimer(state: string): void {
  if (speakingTimer !== undefined) {
    clearTimeout(speakingTimer);
    speakingTimer = undefined;
  }
  if (state === 'SPEAKING') {
    speakingTimer = setTimeout(() => {
      handler.finishSpeaking();
      speakingTimer = undefined;
    }, 4000);
  }
}

async function main(): Promise<void> {
  if (!instanceLock.isOwner) {
    console.log('AACpipe Publisher stub: another Publisher instance is already running');
    return;
  }
  const launchFile = process.env['AACPIPE_STUB_LAUNCH_FILE'];
  if (launchFile !== undefined) {
    appendFileSync(launchFile, `${String(process.pid)}\n`, 'utf8');
  }
  const pipeName = native.defaultPipeName();
  const server = new native.SecurePipeServer(pipeName);
  const readyFile = process.env['AACPIPE_STUB_READY_FILE'];
  if (readyFile !== undefined) {
    writeFileSync(readyFile, pipeName, 'utf8');
  }
  console.log('AACpipe Publisher stub: listening for bridge commands');

  for (;;) {
    if (!instanceLock.isOwner) {
      throw new Error('Publisher instance lock was lost');
    }
    const receiveResult = await server.receive(30_000);
    const request: NativePipeRequest | undefined = parseNativePipeReceiveResult(receiveResult);
    if (request === undefined) continue;
    const command = commandName(request.payload);
    const response = handler.processPayload(request.payload);
    updateSpeakingTimer(response.ok ? response.state : '');
    await server.respond(request.connectionId, JSON.stringify(response));
    if (response.ok) {
      console.log(
        `AACpipe Publisher stub: command=${command} state=${response.state} revision=${response.revision} channels=${response.channels} subscribers=${response.subscribers}`,
      );
    } else {
      console.log(`AACpipe Publisher stub: command=${command} rejected code=${response.code}`);
    }
  }
}

await main();
