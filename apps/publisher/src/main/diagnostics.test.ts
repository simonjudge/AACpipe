import { describe, expect, it } from 'vitest';
import { Diagnostics } from './diagnostics.js';

describe('safe diagnostics', () => {
  it('only includes allowlisted values and retains at most 20 error codes', () => {
    const diagnostics = new Diagnostics();
    for (let i = 0; i < 25; i++) diagnostics.record('ipc-rejected');
    const state = {
      version: '0.1.0-preview.1',
      platform: 'win32',
      release: '10.0',
      architecture: 'x64',
      discovery: { status: 'ready' as const, hostname: 'private-host.local' },
      adapterCount: 2,
      channelCount: 1,
      subscriberCount: 1,
      port: 3210,
      text: 'private conversation',
      secret: 'secret-value',
      label: 'private label',
    };
    const report = diagnostics.report(state);
    expect(report.match(/ipc-rejected/gu)).toHaveLength(20);
    expect(report).toContain('Discovery: ready');
    for (const value of [state.text, state.secret, state.label, state.discovery.hostname]) {
      expect(report).not.toContain(value);
    }
  });
});
