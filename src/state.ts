import { randomBytes } from 'node:crypto';
import { hmacSha256, safeEqual } from './crypto.js';

/**
 * OAuth `state`: signed, short-lived, single-use. It carries which BiziShip company
 * started the connect, and protects the callback against forged/replayed requests (CSRF).
 */
export interface StatePayload {
  provider: string;
  companyId: string;
  /** The BiziShip user who started the connect (audit only; the callback runs in a browser without headers). */
  userId?: string;
  /** Opaque value from the web app, echoed back unchanged on the final redirect. The web app validates it. */
  returnTo?: string;
  nonce: string;
  exp: number; // epoch ms
}

export const STATE_TTL_MS = 10 * 60 * 1000;

const b64url = (b: Buffer) => b.toString('base64url');

export function signState(
  input: { provider: string; companyId: string; userId?: string; returnTo?: string },
  key: Buffer,
  now = Date.now(),
): string {
  const payload: StatePayload = {
    ...input,
    nonce: randomBytes(16).toString('base64url'),
    exp: now + STATE_TTL_MS,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${b64url(hmacSha256(body, key))}`;
}

export class InvalidStateError extends Error {}

export function verifyState(state: string, key: Buffer, now = Date.now()): StatePayload {
  const [body, sig] = state.split('.');
  if (!body || !sig) throw new InvalidStateError('Malformed state');
  if (!safeEqual(Buffer.from(sig, 'base64url'), hmacSha256(body, key))) {
    throw new InvalidStateError('Bad state signature');
  }
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    throw new InvalidStateError('Malformed state');
  }
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new InvalidStateError('State expired');
  return payload;
}

/** Remembers used nonces so a state can only be redeemed once. Must be shared across instances (DynamoDB) when more than one can run. */
export interface NonceStore {
  /** Returns false if the nonce was already used. Must be atomic. */
  consume(nonce: string, exp: number, now?: number): Promise<boolean>;
}

/** In-memory implementation: correct for one local process only. */
export class NonceRegistry implements NonceStore {
  private used = new Map<string, number>();

  async consume(nonce: string, exp: number, now = Date.now()): Promise<boolean> {
    for (const [n, e] of this.used) if (e < now) this.used.delete(n);
    if (this.used.has(nonce)) return false;
    this.used.set(nonce, exp);
    return true;
  }
}
