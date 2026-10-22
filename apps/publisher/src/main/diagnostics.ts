import type { DiscoveryState } from './discovery.js';

export type DiagnosticCode =
  | 'management-rejected'
  | 'management-failed'
  | 'page-failed'
  | 'ipc-rejected'
  | 'discovery-unavailable';

export class Diagnostics {
  readonly #errors: Array<{ code: DiagnosticCode; time: string }> = [];

  record(code: DiagnosticCode): void {
    this.#errors.push({ code, time: new Date().toISOString() });
    if (this.#errors.length > 20) this.#errors.shift();
  }

  report(input: {
    version: string;
    platform: string;
    release: string;
    architecture: string;
    discovery: DiscoveryState;
    adapterCount: number;
    channelCount: number;
    subscriberCount: number;
    port: number;
  }): string {
    // Deliberately allowlisted: never serialize app state, raw errors, names, URLs or credentials.
    return [
      'AACpipe diagnostics (review before sharing)',
      `Version: ${input.version}`,
      `OS: ${input.platform} ${input.release} ${input.architecture}`,
      `Discovery: ${input.discovery.status}`,
      `IPv4 network adapters: ${String(input.adapterCount)}`,
      `Listening port: ${String(input.port)}`,
      `Pairings: ${String(input.channelCount)}`,
      `Subscribers: ${String(input.subscriberCount)}`,
      'Recent error codes:',
      ...this.#errors.map(({ time, code }) => `${time} ${code}`),
      '',
      'No conversation text, labels, addresses, pairing links, tokens or secrets are included.',
    ].join('\n');
  }
}
