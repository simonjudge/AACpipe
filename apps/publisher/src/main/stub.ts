import { appendFileSync, writeFileSync } from 'node:fs';

import { loadNativeModule, type NativePipeRequest } from './native.js';
import { createPublisherRequestHandler } from './request-handler.js';

const native = loadNativeModule();
const handler = createPublisherRequestHandler();
const instanceLock = new native.PublisherInstanceLock(native.defaultPublisherMutexName());
let speakingTimer: NodeJS.Timeout | undefined;

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

  for (;;) {
    if (!instanceLock.isOwner) {
      throw new Error('Publisher instance lock was lost');
    }
    let request: NativePipeRequest;
    try {
      request = await server.receive(30_000);
    } catch (error) {
      if (error instanceof Error && error.message.includes('operation timed out')) {
        continue;
      }
      throw error;
    }
    const response = handler.processPayload(request.payload);
    updateSpeakingTimer(response.ok ? response.state : '');
    await server.respond(request.connectionId, JSON.stringify(response));
  }
}

await main();
