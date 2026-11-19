import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/crypto.js';
import { InvalidStateError, NonceRegistry, STATE_TTL_MS, signState, verifyState } from '../src/state.js';

const key = randomBytes(32);

describe('encryption', () => {
  it('round-trips', () => {
    const blob = encrypt('secret-token', key, 'quickbooks:c1');
    expect(blob).not.toContain('secret-token');
    expect(decrypt(blob, key, 'quickbooks:c1')).toBe('secret-token');
  });

  it('uses a fresh IV each time', () => {
    expect(encrypt('x', key, 'a')).not.toBe(encrypt('x', key, 'a'));
  });

  it('fails with the wrong key', () => {
    const blob = encrypt('x', key, 'a');
    expect(() => decrypt(blob, randomBytes(32), 'a')).toThrow();
  });

  it('fails when moved to another record (AAD mismatch)', () => {
    const blob = encrypt('x', key, 'quickbooks:company-A');
    expect(() => decrypt(blob, key, 'quickbooks:company-B')).toThrow();
  });

  it('detects tampering', () => {
    const [v, iv, tag, ct] = encrypt('hello', key, 'a').split('.');
    const flipped = Buffer.from(ct!, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decrypt([v, iv, tag, flipped.toString('base64')].join('.'), key, 'a')).toThrow();
  });
});

describe('oauth state', () => {
  const input = { provider: 'quickbooks', companyId: 'c1' };

  it('verifies a valid state and returns its payload', () => {
    const s = signState(input, key, 1000);
    expect(verifyState(s, key, 1000)).toMatchObject(input);
  });

  it('rejects a forged signature', () => {
    const s = signState(input, key, 1000);
    expect(() => verifyState(s, randomBytes(32), 1000)).toThrow(InvalidStateError);
  });

  it('rejects an edited payload (cannot swap the company)', () => {
    const [, sig] = signState(input, key, 1000).split('.');
    const forgedBody = Buffer.from(
      JSON.stringify({ ...input, companyId: 'victim', nonce: 'n', exp: 9e15 }),
    ).toString('base64url');
    expect(() => verifyState(`${forgedBody}.${sig}`, key, 1000)).toThrow(InvalidStateError);
  });

  it('rejects an expired state', () => {
    const s = signState(input, key, 1000);
    expect(() => verifyState(s, key, 1000 + STATE_TTL_MS + 1)).toThrow(/expired/);
  });

  it('rejects garbage', () => {
    expect(() => verifyState('nope', key)).toThrow(InvalidStateError);
  });

  it('allows a nonce only once', async () => {
    const r = new NonceRegistry();
    expect(await r.consume('n1', 5000, 1000)).toBe(true);
    expect(await r.consume('n1', 5000, 1001)).toBe(false);
  });
});
