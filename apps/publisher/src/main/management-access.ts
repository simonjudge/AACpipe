import { timingSafeEqual } from 'node:crypto';

export const managementCookieName = 'aacpipe_management';

export function hasManagementAccess(cookie: string | undefined, expected: string): boolean {
  const value = cookie
    ?.split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${managementCookieName}=`))
    ?.slice(managementCookieName.length + 1);
  if (value === undefined) return false;
  const received = Buffer.from(value);
  const secret = Buffer.from(expected);
  return received.length === secret.length && timingSafeEqual(received, secret);
}
