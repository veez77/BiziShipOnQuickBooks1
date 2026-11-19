import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { callerFromHeaders, keyMatches, parseHubKeys } from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { parseKey } from '../src/crypto.js';
import { createQuickBooksProvider } from '../src/providers/quickbooks/index.js';
import { OAuthError, type ErpProvider } from '../src/providers/types.js';
import { buildApp } from '../src/server.js';
import { signState } from '../src/state.js';
import { MemoryConnectionStore } from '../src/store/memoryStore.js';
import type { ProviderId } from '../src/store/types.js';
import { TokenService } from '../src/tokens.js';

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);
const RETURN_URL = 'https://app.biziship.ai/settings/erp';

const config: Config = {
  QBO_CLIENT_ID: 'cid',
  QBO_CLIENT_SECRET: 'csecret',
  QBO_ENVIRONMENT: 'sandbox',
  QBO_REDIRECT_URI: 'http://localhost:3000/callback',
  QBO_MINOR_VERSION: 75,
  PORT: 3000,
  HOST: '127.0.0.1',
  AUTH_MODE: 'shared-secret',
  HUB_API_KEYS: `${KEY_A},${KEY_B}`,
  DEV_BIZISHIP_COMPANY_ID: 'unused',
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  STATE_SIGNING_KEY: randomBytes(32).toString('base64'),
  STORE: 'file',
  APP_BASE_URL: 'https://app.biziship.ai',
  DATA_DIR: '.data',
  FRONTEND_RETURN_URL: RETURN_URL,
};
const stateKey = parseKey(config.STATE_SIGNING_KEY);

function fakeIntuit(opts: { rejectCode?: boolean; rejectRevoke?: boolean } = {}) {
  let tokenCalls = 0;
  const revoked: string[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/oauth2/tokens/revoke')) {
      if (opts.rejectRevoke) return new Response('{}', { status: 400 });
      revoked.push((JSON.parse(String(init?.body)) as { token: string }).token);
      return new Response('{}', { status: 200 });
    }
    if (url.includes('/oauth2/v1/tokens/bearer')) {
      tokenCalls++;
      if (opts.rejectCode) return new Response('{"error":"invalid_grant"}', { status: 400 });
      return new Response(
        JSON.stringify({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600, x_refresh_token_expires_in: 8726400 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/companyinfo/')) {
      return new Response(JSON.stringify({ CompanyInfo: { CompanyName: 'Sandbox Co' } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, tokenCalls: () => tokenCalls, revoked };
}

function setup(opts: { rejectCode?: boolean; rejectRevoke?: boolean } = {}) {
  const intuit = fakeIntuit(opts);
  const store = new MemoryConnectionStore();
  const qb = createQuickBooksProvider(
    { clientId: 'cid', clientSecret: 'csecret', redirectUri: config.QBO_REDIRECT_URI },
    { environment: 'sandbox', minorVersion: 75 },
    intuit.fetchFn,
  );
  const providers = new Map<ProviderId, ErpProvider>([['quickbooks', qb]]);
  const tokens = new TokenService(store, () => qb.oauth);
  const app = buildApp({ config, store, providers, tokens, logger: false });
  return { app, store, intuit };
}

const hdr = (over: Record<string, string> = {}) => ({
  'x-erp-hub-key': KEY_A,
  'x-biziship-company-id': 'co-1',
  'x-biziship-user-id': 'u-1',
  'x-biziship-user-email': 'dana@example.com',
  'x-biziship-role': 'ADMIN',
  ...over,
});

const stateFor = (companyId: string, returnTo?: string) =>
  encodeURIComponent(signState({ provider: 'quickbooks', companyId, returnTo }, stateKey));

describe('shared-secret auth', () => {
  it('rejects missing and wrong keys with the same 401', async () => {
    const { app } = setup();
    const none = await app.inject('/v1/providers');
    const wrong = await app.inject({ url: '/v1/providers', headers: hdr({ 'x-erp-hub-key': 'x'.repeat(40) }) });
    expect(none.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(none.json()).toEqual(wrong.json());
  });

  it('rejects a valid key with missing caller headers', async () => {
    const { app } = setup();
    for (const missing of ['x-biziship-company-id', 'x-biziship-user-id', 'x-biziship-role']) {
      const headers: Record<string, string> = hdr();
      delete headers[missing];
      expect((await app.inject({ url: '/v1/providers', headers })).statusCode).toBe(401);
    }
  });

  it('accepts either of the two active keys (rotation)', async () => {
    const { app } = setup();
    for (const k of [KEY_A, KEY_B]) {
      expect((await app.inject({ url: '/v1/providers', headers: hdr({ 'x-erp-hub-key': k }) })).statusCode).toBe(200);
    }
  });

  it('health and the callback need no key', async () => {
    const { app } = setup();
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/callback?error=access_denied')).statusCode).toBe(302);
  });

  it('parses and matches keys in constant time form', () => {
    expect(parseHubKeys(' a , b ,')).toEqual(['a', 'b']);
    expect(keyMatches('b', ['a', 'b'])).toBe(true);
    expect(keyMatches('c', ['a', 'b'])).toBe(false);
    expect(() => callerFromHeaders({}, [])).toThrow();
  });

  it('refuses to start in shared-secret mode without strong keys', () => {
    const base = {
      QBO_CLIENT_ID: 'x', QBO_CLIENT_SECRET: 'x', QBO_REDIRECT_URI: 'http://localhost/callback',
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), STATE_SIGNING_KEY: randomBytes(32).toString('base64'),
    };
    expect(() => loadConfig(base)).toThrow(/HUB_API_KEYS/);
    expect(() => loadConfig({ ...base, HUB_API_KEYS: 'short' })).toThrow(/32 characters/);
    expect(loadConfig({ ...base, HUB_API_KEYS: KEY_A }).AUTH_MODE).toBe('shared-secret');
  });
});

describe('roles', () => {
  it('every role that can book (ADMIN, SUPER_USER, CUSTOMER) may connect and disconnect; any other role gets 403', async () => {
    const { app } = setup();
    for (const role of ['ADMIN', 'SUPER_USER', 'CUSTOMER']) {
      const r = await app.inject({ method: 'POST', url: '/v1/quickbooks/connect', headers: hdr({ 'x-biziship-role': role }) });
      expect(r.statusCode).toBe(200);
      const d = await app.inject({ method: 'DELETE', url: '/v1/quickbooks/connection', headers: hdr({ 'x-biziship-role': role }) });
      expect(d.statusCode).toBe(200);
    }
    for (const role of ['USER', 'VIEWER', 'GUEST']) {
      const c = await app.inject({ method: 'POST', url: '/v1/quickbooks/connect', headers: hdr({ 'x-biziship-role': role }) });
      const d = await app.inject({ method: 'DELETE', url: '/v1/quickbooks/connection', headers: hdr({ 'x-biziship-role': role }) });
      expect(c.statusCode).toBe(403);
      expect(d.statusCode).toBe(403);
    }
  });

  it('a CUSTOMER connects; a different user of the company sees it, gets 409 on a second connect, and may disconnect it for everyone (tokens revoked at Intuit)', async () => {
    const { app, store, intuit } = setup();
    const start = await app.inject({ method: 'POST', url: '/v1/quickbooks/connect', headers: hdr({ 'x-biziship-role': 'CUSTOMER', 'x-biziship-user-id': 'u-cust' }) });
    const state = new URL(start.json().authUrl).searchParams.get('state')!;
    const cb = await app.inject(`/callback?code=abc&realmId=111&state=${encodeURIComponent(state)}`);
    expect(new URL(cb.headers.location as string).searchParams.get('connected')).toBe('quickbooks');

    const other = hdr({ 'x-biziship-role': 'SUPER_USER', 'x-biziship-user-id': 'u-other' });
    expect((await app.inject({ url: '/v1/quickbooks/connection', headers: other })).json()).toMatchObject({ connected: true });
    const again = await app.inject({ method: 'POST', url: '/v1/quickbooks/connect', headers: hdr({ 'x-biziship-role': 'CUSTOMER', 'x-biziship-user-id': 'u-third' }) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_connected');

    const del = await app.inject({ method: 'DELETE', url: '/v1/quickbooks/connection', headers: other });
    expect(del.json()).toEqual({ disconnected: true, revoked: true });
    expect(intuit.revoked).toEqual(['R1']);
    expect(await store.get('quickbooks', 'co-1')).toBeNull();
    expect((await app.inject({ url: '/v1/quickbooks/connection', headers: other })).json()).toMatchObject({ connected: false, status: 'not_connected' });
  });

  it('still removes the connection when Intuit rejects the revoke, and says so', async () => {
    const { app, store } = setup({ rejectRevoke: true });
    const start = await app.inject({ method: 'POST', url: '/v1/quickbooks/connect', headers: hdr() });
    const state = new URL(start.json().authUrl).searchParams.get('state')!;
    await app.inject(`/callback?code=abc&realmId=111&state=${encodeURIComponent(state)}`);
    const del = await app.inject({ method: 'DELETE', url: '/v1/quickbooks/connection', headers: hdr() });
    expect(del.json()).toEqual({ disconnected: true, revoked: false });
    expect(await store.get('quickbooks', 'co-1')).toBeNull();
  });

  it('any role may read the connection status', async () => {
    const { app } = setup();
    const r = await app.inject({ url: '/v1/quickbooks/connection', headers: hdr({ 'x-biziship-role': 'USER' }) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ connected: false, status: 'not_connected' });
  });
});

describe('connect, callback and returnTo', () => {
  it('echoes returnTo through the signed state to the final redirect', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/quickbooks/connect', headers: hdr(), payload: { returnTo: '/shipments/new?doc=5' },
    });
    const state = new URL(res.json().authUrl).searchParams.get('state')!;
    const cb = await app.inject(`/callback?code=abc&realmId=111&state=${encodeURIComponent(state)}`);
    expect(cb.statusCode).toBe(302);
    const loc = new URL(cb.headers.location as string);
    expect(loc.origin + loc.pathname).toBe(RETURN_URL);
    expect(loc.searchParams.get('connected')).toBe('quickbooks');
    expect(loc.searchParams.get('returnTo')).toBe('/shipments/new?doc=5');
  });

  it('rejects an oversized returnTo', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'POST', url: '/v1/quickbooks/connect', headers: hdr(), payload: { returnTo: 'x'.repeat(501) } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_request');
  });

  it('a second connect while connected is 409 already_connected', async () => {
    const { app } = setup();
    await app.inject(`/callback?code=abc&realmId=111&state=${stateFor('co-1')}`);
    const r = await app.inject({ method: 'POST', url: '/v1/quickbooks/connect', headers: hdr() });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('already_connected');
  });

  it('every failure redirects with an error code and echoes returnTo when the state is valid', async () => {
    const { app } = setup();
    const denied = await app.inject(`/callback?error=access_denied&state=${stateFor('co-1', '/back')}`);
    const l1 = new URL(denied.headers.location as string);
    expect(denied.statusCode).toBe(302);
    expect(l1.searchParams.get('error')).toBe('authorization_denied');
    expect(l1.searchParams.get('returnTo')).toBe('/back');

    const forged = encodeURIComponent(signState({ provider: 'quickbooks', companyId: 'co-1', returnTo: '/evil' }, randomBytes(32)));
    const bad = await app.inject(`/callback?code=abc&realmId=1&state=${forged}`);
    const l2 = new URL(bad.headers.location as string);
    expect(l2.searchParams.get('error')).toBe('invalid_state');
    expect(l2.searchParams.has('returnTo')).toBe(false); // an untrusted state never supplies returnTo

    const noParams = await app.inject('/callback');
    expect(new URL(noParams.headers.location as string).searchParams.get('error')).toBe('invalid_state');
  });

  it('a rejected code exchange redirects with oauth_error and stores nothing', async () => {
    const { app, store } = setup({ rejectCode: true });
    const res = await app.inject(`/callback?code=bad&realmId=1&state=${stateFor('co-1')}`);
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe('oauth_error');
    expect(await store.get('quickbooks', 'co-1')).toBeNull();
    expect(OAuthError).toBeDefined();
  });

  it('reconnecting after needs_reconnect works for the same QuickBooks company and keeps connectedAt', async () => {
    const { app, store } = setup();
    await app.inject(`/callback?code=abc&realmId=111&state=${stateFor('co-1')}`);
    const first = (await store.get('quickbooks', 'co-1'))!;
    await store.put({ ...first, status: 'needs_reconnect' });

    const ok = await app.inject(`/callback?code=abc&realmId=111&state=${stateFor('co-1')}`);
    expect(new URL(ok.headers.location as string).searchParams.get('connected')).toBe('quickbooks');
    const again = (await store.get('quickbooks', 'co-1'))!;
    expect(again.status).toBe('connected');
    expect(again.connectedAt).toBe(first.connectedAt);
  });

  it('reconnecting to a different QuickBooks company is realm_mismatch and changes nothing', async () => {
    const { app, store, intuit } = setup();
    await app.inject(`/callback?code=abc&realmId=111&state=${stateFor('co-1')}`);
    const first = (await store.get('quickbooks', 'co-1'))!;
    await store.put({ ...first, status: 'needs_reconnect' });
    const callsBefore = intuit.tokenCalls();

    const res = await app.inject(`/callback?code=abc&realmId=222&state=${stateFor('co-1')}`);
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe('realm_mismatch');
    expect(intuit.tokenCalls()).toBe(callsBefore); // no code exchange
    expect((await store.get('quickbooks', 'co-1'))!.realmId).toBe('111');
  });

  it('companies are isolated: one company never sees another one’s connection', async () => {
    const { app } = setup();
    await app.inject(`/callback?code=abc&realmId=111&state=${stateFor('co-1')}`);
    const other = await app.inject({ url: '/v1/quickbooks/connection', headers: hdr({ 'x-biziship-company-id': 'co-2' }) });
    expect(other.json()).toMatchObject({ connected: false });
    const mine = await app.inject({ url: '/v1/quickbooks/connection', headers: hdr() });
    expect(mine.json()).toMatchObject({ connected: true, realmId: '111' });
  });
});
