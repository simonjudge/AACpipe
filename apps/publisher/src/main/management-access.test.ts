import { describe, expect, it } from 'vitest';
import { hasManagementAccess } from './management-access.js';

describe('Electron management capability', () => {
  it('requires the exact secret cookie, not simply a loopback connection', () => {
    expect(hasManagementAccess(undefined, 'secret')).toBe(false);
    expect(hasManagementAccess('other=secret', 'secret')).toBe(false);
    expect(hasManagementAccess('aacpipe_management=wrong', 'secret')).toBe(false);
    expect(hasManagementAccess('aacpipe_management=secret-extra', 'secret')).toBe(false);
    expect(hasManagementAccess('other=a; aacpipe_management=secret; next=b', 'secret')).toBe(true);
  });
});
