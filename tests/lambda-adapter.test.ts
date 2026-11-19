import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { wrapForLambda, normalizeEvent } from '../src/lambdaAdapter.js';
import { buildRuntime } from '../src/runtime.js';
import { MemoryConnectionStore } from '../src/store/memoryStore.js';
import { MemorySettingsStore } from '../src/store/settings.js';

/** What API Gateway (HTTP API, payload v2) sends to the Lambda. */
function event(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; query?: string } = {}) {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: opts.query ?? '',
    // API Gateway also sends a pre-parsed copy. Here deliberately left URL-ENCODED to prove the Hub ignores it.
    queryStringParameters: opts.query ? Object.fromEntries(opts.query.split('&').map((kv) => kv.split('=') as [string, string])) : undefined,
    headers: { host: 'abc.execute-api.us-east-1.amazonaws.com', ...(body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
    requestContext: {
      accountId: '1', apiId: 'abc', domainName: 'abc.execute-api.us-east-1.amazonaws.com', domainPrefix: 'abc', requestId: 'r', routeKey: '$default', stage: '$default', time: 'now', timeEpoch: 0,
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.9', userAgent: 'node' },
    },
    body,
    isBase64Encoded: false,
  } as never;
}

const KEY = 'k'.repeat(40);
const config: Config = {
  QBO_CLIENT_ID: 'cid', QBO_CLIENT_SECRET: 'csecret', QBO_ENVIRONMENT: 'sandbox',
  QBO_REDIRECT_URI: 'https://abc.execute-api.us-east-1.amazonaws.com/callback', QBO_MINOR_VERSION: 75,
  PORT: 3000, HOST: '127.0.0.1', AUTH_MODE: 'shared-secret', HUB_API_KEYS: KEY, DEV_BIZISHIP_COMPANY_ID: 'x',
  STORE: 'file', APP_BASE_URL: 'https://app.biziship.ai', STATE_SIGNING_KEY: randomBytes(32).toString('base64'),
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), DATA_DIR: '.data',
};

const callerHeaders = { 'x-erp-hub-key': KEY, 'x-biziship-company-id': 'co-1', 'x-biziship-user-id': 'u-1', 'x-biziship-role': 'ADMIN' };

describe('Lambda adapter (API Gateway HTTP API v2 events)', () => {
  const app = buildRuntime(config, { connections: new MemoryConnectionStore(), settings: new MemorySettingsStore() });
  const invoke = wrapForLambda(app);
  const call = (e: unknown) => invoke(e as never, {} as never) as Promise<{ statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded?: boolean }>;

  it('health needs no key', async () => {
    const r = await call(event('GET', '/health'));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ status: 'ok' });
  });

  it('a missing or wrong key is 401, a right key with headers works', async () => {
    expect((await call(event('GET', '/v1/providers'))).statusCode).toBe(401);
    expect((await call(event('GET', '/v1/providers', { headers: { ...callerHeaders, 'x-erp-hub-key': 'z'.repeat(40) } }))).statusCode).toBe(401);
    const ok = await call(event('GET', '/v1/providers', { headers: callerHeaders }));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).providers[0].id).toBe('quickbooks');
  });

  it('passes JSON bodies and query strings through (connect with returnTo; document list validation)', async () => {
    const c = await call(event('POST', '/v1/quickbooks/connect', { headers: callerHeaders, body: { returnTo: '/shipments/new' } }));
    expect(c.statusCode).toBe(200);
    expect(JSON.parse(c.body).authUrl).toContain('appcenter.intuit.com');

    const bad = await call(event('GET', '/v1/quickbooks/documents', { headers: callerHeaders, query: 'limit=1000' }));
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('invalid_request');
  });

  it('rebuilds the query from rawQueryString: decoded, repeated keys kept, the encoded pre-parsed copy ignored', () => {
    const e = normalizeEvent({ rawQueryString: 'q=Family%20Store&type=invoice&x=1&x=2&e=a%2Bb', queryStringParameters: { q: 'Family%20Store' } });
    expect(e.queryStringParameters).toEqual({ q: 'Family Store', type: 'invoice', x: ['1', '2'], e: 'a+b' });
    expect(normalizeEvent({ rawQueryString: '' }).queryStringParameters).toEqual({});
    const noQuery = { version: '2.0' };
    expect(normalizeEvent(noQuery)).toBe(noQuery);
  });

  it('the OAuth callback answers with a redirect', async () => {
    const r = await call(event('GET', '/callback', { query: 'error=access_denied' }));
    expect([302, 400]).toContain(r.statusCode); // 302 when FRONTEND_RETURN_URL is set (deployed), JSON 400 otherwise
  });

  it('binary files (PDF/JPEG/PNG) come back base64-encoded with their content type', async () => {
    const f = Fastify();
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80]); // "%PDF" + non-UTF8 bytes
    f.get('/file', async (_req, reply) => reply.header('content-type', 'application/pdf').send(bytes));
    const h = wrapForLambda(f);
    const r = (await h(event('GET', '/file') as never, {} as never)) as { isBase64Encoded?: boolean; body: string; headers: Record<string, string> };
    expect(r.isBase64Encoded).toBe(true);
    expect(Buffer.from(r.body, 'base64').equals(bytes)).toBe(true);
    expect(r.headers['content-type']).toBe('application/pdf');
  });
});
