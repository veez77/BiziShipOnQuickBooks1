import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { parseKey } from '../src/crypto.js';
import { createQuickBooksProvider } from '../src/providers/quickbooks/index.js';
import type { ErpProvider } from '../src/providers/types.js';
import { buildApp } from '../src/server.js';
import { signState } from '../src/state.js';
import { MemoryConnectionStore } from '../src/store/memoryStore.js';
import type { ProviderId } from '../src/store/types.js';
import { TokenService } from '../src/tokens.js';

const config: Config = {
  QBO_CLIENT_ID: 'cid',
  QBO_CLIENT_SECRET: 'csecret',
  QBO_ENVIRONMENT: 'sandbox',
  QBO_REDIRECT_URI: 'http://localhost:3000/callback',
  QBO_MINOR_VERSION: 75,
  PORT: 3000,
  HOST: '127.0.0.1',
  AUTH_MODE: 'dev',
  DEV_BIZISHIP_COMPANY_ID: 'company-1',
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  STATE_SIGNING_KEY: randomBytes(32).toString('base64'),
  STORE: 'file',
  APP_BASE_URL: 'https://app.biziship.ai',
  DATA_DIR: '.data',
};

/** Fake Intuit: token endpoint + CompanyInfo. */
function fakeIntuit() {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/oauth2/v1/tokens/bearer')) {
      return new Response(
        JSON.stringify({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600, x_refresh_token_expires_in: 8726400 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/companyinfo/')) {
      expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer A1');
      return new Response(JSON.stringify({ CompanyInfo: { CompanyName: 'Sandbox <Co>', Country: 'US' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function setup() {
  const { fetchFn, calls } = fakeIntuit();
  const store = new MemoryConnectionStore();
  const qb = createQuickBooksProvider(
    { clientId: 'cid', clientSecret: 'csecret', redirectUri: config.QBO_REDIRECT_URI },
    { environment: 'sandbox', minorVersion: 75 },
    fetchFn,
  );
  const providers = new Map<ProviderId, ErpProvider>([['quickbooks', qb]]);
  const tokens = new TokenService(store, () => qb.oauth);
  const app = buildApp({ config, store, providers, tokens, logger: false });
  return { app, store, calls };
}

const stateKey = parseKey(config.STATE_SIGNING_KEY);

describe('ERP Hub HTTP API', () => {
  it('lists providers with capabilities', async () => {
    const { app } = setup();
    const res = await app.inject('/v1/providers');
    expect(res.statusCode).toBe(200);
    expect(res.json().providers[0]).toMatchObject({ id: 'quickbooks', capabilities: { documentTypes: ['estimate', 'invoice'] } });
  });

  it('connect returns an Intuit URL whose state is signed for the calling company', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/quickbooks/connect' });
    const url = new URL(res.json().authUrl);
    expect(url.hostname).toBe('appcenter.intuit.com');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('unknown provider is a 404', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/v1/sage/connect' })).statusCode).toBe(404);
  });

  it('full connect flow: callback stores an encrypted-at-rest connection and status never leaks tokens', async () => {
    const { app, store } = setup();
    const state = signState({ provider: 'quickbooks', companyId: 'company-1' }, stateKey);

    const cb = await app.inject(`/callback?code=abc&realmId=9341458704528073&state=${encodeURIComponent(state)}`);
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain('Sandbox &lt;Co&gt;'); // HTML-escaped company name

    const saved = await store.get('quickbooks', 'company-1');
    expect(saved).toMatchObject({ realmId: '9341458704528073', status: 'connected', companyName: 'Sandbox <Co>' });

    const status = (await app.inject('/v1/quickbooks/connection')).json();
    expect(status).toMatchObject({ connected: true, realmId: '9341458704528073' });
    expect(JSON.stringify(status)).not.toMatch(/A1|R1|accessToken|refreshToken/);
  });

  it('rejects a replayed state (single use)', async () => {
    const { app } = setup();
    const state = encodeURIComponent(signState({ provider: 'quickbooks', companyId: 'company-1' }, stateKey));
    const url = `/callback?code=abc&realmId=1&state=${state}`;
    expect((await app.inject(url)).statusCode).toBe(200);
    expect((await app.inject(url)).statusCode).toBe(400);
  });

  it('rejects a forged state without calling Intuit', async () => {
    const { app, calls } = setup();
    const forged = encodeURIComponent(signState({ provider: 'quickbooks', companyId: 'victim' }, randomBytes(32)));
    const res = await app.inject(`/callback?code=abc&realmId=1&state=${forged}`);
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('reports user denial cleanly', async () => {
    const { app } = setup();
    const res = await app.inject('/callback?error=access_denied');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('authorization_denied');
  });

  it('dev company-info works after connecting', async () => {
    const { app } = setup();
    const state = encodeURIComponent(signState({ provider: 'quickbooks', companyId: 'company-1' }, stateKey));
    await app.inject(`/callback?code=abc&realmId=1&state=${state}`);
    const res = await app.inject('/v1/quickbooks/dev/company-info');
    expect(res.json()).toMatchObject({ companyName: 'Sandbox <Co>', country: 'US' });
  });

  it('company-info before connecting is a clean 404', async () => {
    const { app } = setup();
    const res = await app.inject('/v1/quickbooks/dev/company-info');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_connected');
  });

  it('disconnect removes the connection', async () => {
    const { app, store } = setup();
    const state = encodeURIComponent(signState({ provider: 'quickbooks', companyId: 'company-1' }, stateKey));
    await app.inject(`/callback?code=abc&realmId=1&state=${state}`);
    const res = await app.inject({ method: 'DELETE', url: '/v1/quickbooks/connection' });
    expect(res.json()).toMatchObject({ disconnected: true });
    expect(await store.get('quickbooks', 'company-1')).toBeNull();
  });
});
