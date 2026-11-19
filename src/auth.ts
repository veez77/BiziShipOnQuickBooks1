import { createHash, timingSafeEqual } from 'node:crypto';

/** Who is calling, as asserted by the BiziShip web app server (contract v1 §1). */
export interface Caller {
  companyId: string;
  userId: string;
  email?: string;
  role: string;
}

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

export const HEADER_KEY = 'x-erp-hub-key';

/**
 * Roles that can book a shipment, and so may connect, disconnect and change setup (product decision:
 * no dependency on an administrator). Any other role gets 403. The web app already gates the feature per company.
 */
const BOOKING_ROLES = new Set(['ADMIN', 'SUPER_USER', 'CUSTOMER']);

export const canManageConnection = (c: Caller) => BOOKING_ROLES.has(c.role);

export function requireBookingRole(c: Caller): void {
  if (!canManageConnection(c)) throw new ForbiddenError('Role may not do this');
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Splits the configured key list. Up to two values may be active at once (rotation). */
export function parseHubKeys(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Constant-time match against every active key (no early exit, so timing does not reveal which one matched). */
export function keyMatches(presented: string, keys: string[]): boolean {
  const p = digest(presented);
  let ok = false;
  for (const k of keys) ok = timingSafeEqual(p, digest(k)) || ok;
  return ok;
}

const ID_RE = /^[\x21-\x7e]{1,128}$/; // printable ASCII, no spaces/control characters

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Validates the shared secret and reads the caller headers.
 * Every failure is the same `unauthorized`, so a probe learns nothing about which part was wrong.
 */
export function callerFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  keys: string[],
): Caller {
  const key = one(headers[HEADER_KEY]);
  if (!key || keys.length === 0 || !keyMatches(key, keys)) throw new UnauthorizedError();

  const companyId = one(headers['x-biziship-company-id']);
  const userId = one(headers['x-biziship-user-id']);
  if (!companyId || !ID_RE.test(companyId) || !userId || !ID_RE.test(userId)) throw new UnauthorizedError();

  const email = one(headers['x-biziship-user-email']);
  const role = (one(headers['x-biziship-role']) ?? '').trim().toUpperCase();
  if (!role) throw new UnauthorizedError();

  return { companyId, userId, email: email && email.length <= 320 ? email : undefined, role };
}
