import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QuickBooksOAuth } from '../src/providers/quickbooks/oauth.js';
import { OAuthError, ReconnectRequiredError } from '../src/providers/types.js';
import { FileConnectionStore } from '../src/store/fileStore.js';
import type { Connection } from '../src/store/types.js';

const cfg = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost:3000/callback' };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('QuickBooksOAuth', () => {
  it('builds the authorize URL with least-privilege scope and our state', () => {
    const url = new URL(new QuickBooksOAuth(cfg).buildAuthUrl('STATE123'));
    expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(url.searchParams.get('state')).toBe('STATE123');
  });

  it('exchanges a code using Basic auth and a form body, and computes expiries', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return jsonResponse(200, {
        access_token: 'A',
        refresh_token: 'R',
        expires_in: 3600,
        x_refresh_token_expires_in: 8726400,
      });
    }) as unknown as typeof fetch;

    const oauth = new QuickBooksOAuth(cfg, fetchFn, () => 1_000_000);
    const t = await oauth.exchangeCode('the-code');

    expect(captured?.url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(captured?.init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(t).toEqual({
      accessToken: 'A',
      refreshToken: 'R',
      accessExpiresAt: 1_000_000 + 3_600_000,
      refreshExpiresAt: 1_000_000 + 8_726_400_000,
    });
  });

  it('maps invalid_grant on refresh to ReconnectRequiredError', async () => {
    const fetchFn = (async () => jsonResponse(400, { error: 'invalid_grant' })) as unknown as typeof fetch;
    await expect(new QuickBooksOAuth(cfg, fetchFn).refresh('old')).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it('other failures become OAuthError carrying the intuit_tid but no secrets', async () => {
    const fetchFn = (async () =>
      jsonResponse(500, { error: 'server_error' }, { intuit_tid: 'tid-9' })) as unknown as typeof fetch;
    const err = await new QuickBooksOAuth(cfg, fetchFn).refresh('old').catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.requestId).toBe('tid-9');
    expect(err.message).not.toContain('csecret');
    expect(err.message).not.toContain('old');
  });
});

describe('FileConnectionStore', () => {
  let dir: string;
  afterEach(async () => dir && (await rm(dir, { recursive: true, force: true })));

  const sample: Connection = {
    provider: 'quickbooks',
    companyId: 'c1',
    realmId: 'r1',
    accessToken: 'PLAINTEXT-ACCESS-TOKEN',
    refreshToken: 'PLAINTEXT-REFRESH-TOKEN',
    accessExpiresAt: 1,
    refreshExpiresAt: 2,
    status: 'connected',
    connectedAt: 0,
    updatedAt: 0,
  };

  it('round-trips and never writes tokens in plaintext', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-'));
    const store = new FileConnectionStore(dir, randomBytes(32));
    await store.put(sample);

    expect(await store.get('quickbooks', 'c1')).toEqual(sample);
    const raw = await readFile(join(dir, 'connections.json'), 'utf8');
    expect(raw).not.toContain('PLAINTEXT-ACCESS-TOKEN');
    expect(raw).not.toContain('PLAINTEXT-REFRESH-TOKEN');
  });

  it('survives many concurrent writes without corrupting the file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-'));
    const store = new FileConnectionStore(dir, randomBytes(32));
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.put({ ...sample, companyId: `c${i}` })));
    for (let i = 0; i < 25; i++) expect((await store.get('quickbooks', `c${i}`))?.companyId).toBe(`c${i}`);
  });

  it('returns null for unknown and supports delete', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-'));
    const store = new FileConnectionStore(dir, randomBytes(32));
    expect(await store.get('quickbooks', 'nope')).toBeNull();
    await store.put(sample);
    await store.delete('quickbooks', 'c1');
    expect(await store.get('quickbooks', 'c1')).toBeNull();
  });

  it('refuses to read with the wrong key', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-'));
    await new FileConnectionStore(dir, randomBytes(32)).put(sample);
    await expect(new FileConnectionStore(dir, randomBytes(32)).get('quickbooks', 'c1')).rejects.toThrow();
  });
});
