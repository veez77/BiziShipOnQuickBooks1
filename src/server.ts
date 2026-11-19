import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  ForbiddenError,
  UnauthorizedError,
  callerFromHeaders,
  parseHubKeys,
  requireBookingRole,
  type Caller,
} from './auth.js';
import type { Config } from './config.js';
import { parseKey } from './crypto.js';
import { AlreadyConnectedError, BadRequestError, HandleInvalidError, HandleMismatchError } from './errors.js';
import {
  AttachmentTooLargeError,
  DocumentNotFoundError,
  InvalidCursorError,
} from './providers/documents.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { MemoryHandleStore, type HandleStore } from './store/handles.js';
import { MemorySettingsStore, type SettingsStore } from './store/settings.js';
import { QboApiError, type DocumentEntity, type QboDocument } from './providers/quickbooks/api.js';
import { hasLinkLine, linkLine, removeLinkLines, upsertLinkLine } from './providers/quickbooks/link.js';
import type { QuickBooksProvider } from './providers/quickbooks/index.js';
import { OAuthError, ReconnectRequiredError, type ErpProvider } from './providers/types.js';
import { InvalidStateError, NonceRegistry, signState, verifyState, type NonceStore } from './state.js';
import type { Connection, ConnectionStore, ProviderId } from './store/types.js';
import { NotConnectedError, type TokenService } from './tokens.js';

export interface AppDeps {
  config: Config;
  store: ConnectionStore;
  providers: Map<ProviderId, ErpProvider>;
  tokens: TokenService;
  nonces?: NonceStore;
  /** Context handles (24 h). Defaults to an in-memory store, fine for one local process. */
  handles?: HandleStore;
  /** Per-company setup. Defaults to an in-memory store. */
  settings?: SettingsStore;
  /** Set false in tests. */
  logger?: boolean;
  now?: () => number;
}

const MAX_RETURN_TO = 500;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, store, providers, tokens } = deps;
  const nonces = deps.nonces ?? new NonceRegistry();
  const now = deps.now ?? Date.now;
  const stateKey = parseKey(config.STATE_SIGNING_KEY);

  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : {
            level: 'info',
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            serializers: {
              // Never log the query string: the OAuth callback carries a one-time authorization code.
              req: (req: FastifyRequest) => ({ method: req.method, url: req.url.split('?')[0], host: req.hostname }),
            },
          },
  });

  // ---- Who is calling? ---------------------------------------------------------------------
  // shared-secret: the web app server proves itself with X-ERP-Hub-Key and says who the user is
  // (contract v1 §1). dev: a fixed company with the ADMIN role, for local development only.
  const hubKeys = parseHubKeys(config.HUB_API_KEYS);
  function authenticate(req: FastifyRequest): Caller {
    if (config.AUTH_MODE === 'dev') {
      return { companyId: config.DEV_BIZISHIP_COMPANY_ID, userId: 'dev-user', role: 'ADMIN' };
    }
    return callerFromHeaders(req.headers, hubKeys);
  }

  function getProvider(name: string): ErpProvider | undefined {
    return providers.get(name as ProviderId);
  }

  // ---- Errors ------------------------------------------------------------------------------
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof UnauthorizedError) return reply.code(401).send({ error: 'unauthorized' });
    if (err instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
    if (err instanceof AlreadyConnectedError) return reply.code(409).send({ error: 'already_connected' });
    if (err instanceof BadRequestError) {
      return reply.code(400).send({ error: 'invalid_request', message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    if (err instanceof InvalidCursorError) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Invalid cursor', details: [{ field: 'cursor', message: 'invalid' }] });
    }
    if (err instanceof HandleInvalidError) return reply.code(409).send({ error: 'handle_invalid' });
    if (err instanceof HandleMismatchError) return reply.code(400).send({ error: 'handle_mismatch' });
    if (err instanceof DocumentNotFoundError) return reply.code(404).send({ error: 'document_not_found' });
    if (err instanceof AttachmentTooLargeError) return reply.code(413).send({ error: 'attachment_too_large' });
    if (err instanceof QboApiError && err.status === 429) {
      return reply.code(429).send({ error: 'rate_limited', retryAfterSeconds: 30, requestId: err.requestId });
    }
    const sc = (err as { statusCode?: number }).statusCode;
    if (typeof sc === 'number' && sc >= 400 && sc < 500) return reply.code(400).send({ error: 'invalid_request' });
    if (err instanceof ReconnectRequiredError) return reply.code(409).send({ error: 'reconnect_required' });
    if (err instanceof NotConnectedError) return reply.code(404).send({ error: 'not_connected' });
    if (err instanceof InvalidStateError) return reply.code(400).send({ error: 'invalid_state' });
    if (err instanceof QboApiError) {
      req.log.warn({ status: err.status, intuit_tid: err.requestId }, 'QuickBooks API error');
      return reply.code(502).send({ error: 'quickbooks_error', message: err.message, requestId: err.requestId });
    }
    if (err instanceof OAuthError) {
      req.log.warn({ status: err.status, intuit_tid: err.requestId }, 'OAuth error');
      return reply.code(502).send({ error: 'oauth_error', message: err.message, requestId: err.requestId });
    }
    req.log.error({ err }, 'Unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  // ---- Basics ------------------------------------------------------------------------------
  app.get('/health', async () => ({ status: 'ok', service: 'BiziShip ERP Hub' }));

  app.get('/v1/providers', async (req) => {
    authenticate(req);
    return listProviders();
  });
  const listProviders = () => ({
    providers: [...providers.values()].map((p) => ({
      id: p.id,
      displayName: p.displayName,
      capabilities: p.capabilities,
    })),
  });

  // ---- Connect -----------------------------------------------------------------------------
  const connectHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const provider = getProvider((req.params as { provider: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
    const caller = authenticate(req);
    requireBookingRole(caller);

    const returnTo = (req.body as { returnTo?: unknown } | null | undefined)?.returnTo;
    if (returnTo !== undefined && (typeof returnTo !== 'string' || returnTo.length > MAX_RETURN_TO)) {
      throw new BadRequestError(`returnTo must be a string of at most ${MAX_RETURN_TO} characters`);
    }

    // One connection per provider per company: disconnect first to switch (a connection that
    // needs re-authorisation may be reconnected; the callback checks it is the same ERP company).
    const existing = await store.get(provider.id, caller.companyId);
    if (existing?.status === 'connected') throw new AlreadyConnectedError();

    const state = signState({ provider: provider.id, companyId: caller.companyId, userId: caller.userId, returnTo }, stateKey, now());
    req.log.info({ audit: 'connect_started', provider: provider.id, companyId: caller.companyId, userId: caller.userId }, 'Audit');
    const authUrl = provider.oauth.buildAuthUrl(state);
    // Dev convenience: open this URL in a browser and it forwards you straight to Intuit.
    if ((req.query as { redirect?: string }).redirect === '1') return reply.redirect(authUrl);
    return { authUrl };
  };
  app.post('/v1/:provider/connect', connectHandler);
  app.get('/v1/:provider/connect', connectHandler);

  // ---- OAuth callback ----------------------------------------------------------------------
  // The callback is opened by the user's browser, so it never answers with JSON errors: every outcome
  // is a redirect back to the web app (contract v1 §3). Without FRONTEND_RETURN_URL (local dev) a
  // plain page is shown instead.
  async function callbackFor(providerName: string, req: FastifyRequest, reply: FastifyReply) {
    const provider = getProvider(providerName);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });

    const q = req.query as { code?: string; state?: string; realmId?: string; error?: string };
    let returnTo: string | undefined;

    const fail = (code: string, message: string) => {
      req.log.info({ provider: provider.id, code }, 'OAuth callback failed');
      if (config.FRONTEND_RETURN_URL) {
        const url = new URL(config.FRONTEND_RETURN_URL);
        url.searchParams.set('error', code);
        url.searchParams.set('message', message);
        if (returnTo !== undefined) url.searchParams.set('returnTo', returnTo);
        return reply.redirect(url.toString());
      }
      return reply.code(400).send({ error: code, message });
    };

    // Only a validly signed state is trusted for returnTo. A denial carries the state too, so use it.
    let st: ReturnType<typeof verifyState> | undefined;
    if (q.state) {
      try {
        st = verifyState(q.state, stateKey, now());
        if (st.provider === provider.id) returnTo = st.returnTo;
      } catch {
        st = undefined;
      }
    }

    if (q.error) return fail('authorization_denied', 'The QuickBooks authorization was cancelled or denied.');
    if (!q.code || !q.realmId) return fail('invalid_state', 'The authorization response was incomplete.');
    if (!st || st.provider !== provider.id) return fail('invalid_state', 'The authorization request is invalid or expired.');
    if (!(await nonces.consume(st.nonce, st.exp, now()))) return fail('invalid_state', 'The authorization request was already used.');

    // Same-ERP-company rule: a connection that needs re-authorisation may only be re-linked to the same company file.
    const existing = await store.get(provider.id, st.companyId);
    if (existing?.status === 'connected') return fail('already_connected', 'A connection already exists. Disconnect it first.');
    if (existing && existing.realmId !== q.realmId) {
      return fail('realm_mismatch', 'This is a different QuickBooks company than the one originally connected.');
    }

    let tokenSet;
    try {
      tokenSet = await provider.oauth.exchangeCode(q.code);
    } catch (err) {
      // An invalid or already-used authorization code is "invalid_grant", which the token client reports as ReconnectRequiredError.
      if (err instanceof OAuthError || err instanceof ReconnectRequiredError) {
        req.log.warn({ status: (err as OAuthError).status, intuit_tid: (err as OAuthError).requestId }, 'OAuth code exchange failed');
        return fail('oauth_error', 'QuickBooks did not accept the authorization. Please try again.');
      }
      throw err;
    }

    let companyName: string | undefined;
    try {
      companyName = await provider.fetchCompanyName(q.realmId, tokenSet.accessToken);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'Could not fetch company name (continuing)');
    }

    const conn: Connection = {
      provider: provider.id,
      companyId: st.companyId,
      realmId: q.realmId,
      ...tokenSet,
      status: 'connected',
      connectedAt: existing?.connectedAt ?? now(),
      updatedAt: now(),
      companyName,
    };
    await store.put(conn);
    req.log.info(
      { audit: 'connected', provider: provider.id, companyId: st.companyId, userId: st.userId, realmId: q.realmId },
      'Audit: connection stored',
    );

    if (config.FRONTEND_RETURN_URL) {
      const url = new URL(config.FRONTEND_RETURN_URL);
      url.searchParams.set('connected', provider.id);
      if (returnTo !== undefined) url.searchParams.set('returnTo', returnTo);
      return reply.redirect(url.toString());
    }
    return reply
      .type('text/html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Connected</title>` +
          `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto">` +
          `<h2>Connected to ${escapeHtml(provider.displayName)}</h2>` +
          `<p>${companyName ? escapeHtml(companyName) : 'Your company'} is now linked to BiziShip. You can close this tab.</p></body>`,
      );
  }
  app.get('/v1/:provider/callback', (req, reply) =>
    callbackFor((req.params as { provider: string }).provider, req, reply),
  );
  // Alias: the redirect URI registered in the Intuit app for local development is /callback.
  app.get('/callback', (req, reply) => callbackFor('quickbooks', req, reply));

  // ---- Status / disconnect (never returns tokens) -----------------------------------------
  app.get('/v1/:provider/connection', async (req, reply) => {
    const provider = getProvider((req.params as { provider: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
    const { companyId } = authenticate(req);
    const c = await store.get(provider.id, companyId);
    if (!c) return { connected: false, status: 'not_connected' };
    return {
      connected: c.status === 'connected',
      status: c.status,
      realmId: c.realmId,
      companyName: c.companyName,
      connectedAt: c.connectedAt,
      accessExpiresAt: c.accessExpiresAt,
      refreshExpiresAt: c.refreshExpiresAt,
      lastError: c.lastError,
    };
  });

  app.delete('/v1/:provider/connection', async (req, reply) => {
    const provider = getProvider((req.params as { provider: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
    const caller = authenticate(req);
    requireBookingRole(caller);
    const { companyId } = caller;
    const c = await store.get(provider.id, companyId);
    if (!c) return { disconnected: false };
    // Revoke at the provider first, then delete locally. If the provider cannot be reached or rejects the
    // token (for example it already expired), the local connection is removed anyway and `revoked` is false.
    let revoked = true;
    try {
      await provider.oauth.revoke(c.refreshToken);
    } catch (err) {
      revoked = false;
      req.log.warn({ err: (err as Error).message }, 'Revoke failed; removing local connection anyway');
    }
    await store.delete(provider.id, companyId);
    req.log.info(
      { audit: 'disconnected', provider: provider.id, companyId, userId: caller.userId, revoked },
      'Audit: connection removed',
    );
    return { disconnected: true, revoked };
  });

  // ---- Documents, seed, version, attachments, setup (contract v1 §4-§6) --------------------------
  registerDocumentRoutes(app, {
    providers,
    tokens,
    handles: deps.handles ?? new MemoryHandleStore(now),
    settings: deps.settings ?? new MemorySettingsStore(),
    authenticate,
    now,
  });

  // ---- Dev-only helpers to prove the plumbing works (Phase 1 exit test) --------------------
  if (config.AUTH_MODE === 'dev') {
    const qb = providers.get('quickbooks') as QuickBooksProvider | undefined;
    if (qb) {
      app.get('/v1/quickbooks/dev/company-info', async (req) => {
        const { companyId } = authenticate(req);
        const info = await tokens.withAccess('quickbooks', companyId, (a) =>
          qb.api.getCompanyInfo(a.realmId, a.accessToken),
        );
        return { companyName: info.CompanyName, country: info['Country'], companyAddr: info['CompanyAddr'] };
      });

      app.post('/v1/quickbooks/dev/force-refresh', async (req) => {
        const { companyId } = authenticate(req);
        const before = await store.get('quickbooks', companyId);
        await tokens.getAccess('quickbooks', companyId, { forceRefresh: true });
        const after = await store.get('quickbooks', companyId);
        return {
          refreshed: true,
          refreshTokenRotated: !!before && !!after && before.refreshToken !== after.refreshToken,
          accessExpiresAt: after?.accessExpiresAt,
          refreshExpiresAt: after?.refreshExpiresAt,
        };
      });

      // ---- Phase 2a: where can the shipment link live in QuickBooks? (sandbox experiment) ----
      const entityOf = (v: unknown): DocumentEntity | null =>
        v === 'invoice' ? 'Invoice' : v === 'estimate' ? 'Estimate' : null;
      type Target = 'privateNote' | 'customerMemo' | 'attachableNote';
      const ALL_TARGETS: Target[] = ['privateNote', 'customerMemo', 'attachableNote'];

      app.get('/v1/quickbooks/dev/documents', async (req, reply) => {
        const { companyId } = authenticate(req);
        const entity = entityOf((req.query as { type?: string }).type ?? 'invoice');
        if (!entity) return reply.code(400).send({ error: 'bad_type', message: 'type must be invoice or estimate' });
        const r = await tokens.withAccess('quickbooks', companyId, (a) =>
          qb.api.query<{ QueryResponse: Record<string, QboDocument[]> }>(
            a.realmId,
            a.accessToken,
            `select * from ${entity} maxresults 25`,
          ),
        );
        return {
          items: (r.QueryResponse[entity] ?? []).map((d) => ({
            id: d.Id,
            docNumber: d['DocNumber'],
            total: d['TotalAmt'],
            balance: d['Balance'],
            txnStatus: d['TxnStatus'],
            emailStatus: d['EmailStatus'],
            privateNote: d.PrivateNote,
            customerMemo: d.CustomerMemo?.value,
          })),
        };
      });

      app.post('/v1/quickbooks/dev/link-experiment', async (req, reply) => {
        const { companyId } = authenticate(req);
        const body = (req.body ?? {}) as { docType?: string; docId?: string; targets?: Target[]; appBaseUrl?: string };
        const entity = entityOf(body.docType);
        if (!entity || !body.docId) return reply.code(400).send({ error: 'bad_request', message: 'docType and docId required' });
        const targets = (body.targets ?? ALL_TARGETS).filter((t) => ALL_TARGETS.includes(t));
        // A random UUID: this is a sandbox experiment, not a real shipment.
        const line = linkLine(body.appBaseUrl ?? 'https://app.biziship.ai', randomUUID());
        const docId = body.docId;

        const results: Record<string, unknown> = {};
        for (const target of targets) {
          try {
            results[target] = await tokens.withAccess('quickbooks', companyId, async (a) => {
              if (target === 'attachableNote') {
                const att = await qb.api.createAttachableNote(a.realmId, a.accessToken, entity, docId, line);
                return { ok: true, attachableId: att.Id };
              }
              const doc = await qb.api.getDocument(a.realmId, a.accessToken, entity, docId); // fresh SyncToken each time
              if (target === 'privateNote') {
                const next = upsertLinkLine(doc.PrivateNote, line);
                const out = await qb.api.updateDocumentSparse(a.realmId, a.accessToken, entity, {
                  Id: doc.Id,
                  SyncToken: doc.SyncToken,
                  PrivateNote: next,
                });
                return { ok: true, value: out.PrivateNote };
              }
              const next = upsertLinkLine(doc.CustomerMemo?.value, line, 1000);
              const out = await qb.api.updateDocumentSparse(a.realmId, a.accessToken, entity, {
                Id: doc.Id,
                SyncToken: doc.SyncToken,
                CustomerMemo: { value: next },
              });
              return { ok: true, value: out.CustomerMemo?.value };
            });
          } catch (err) {
            if (err instanceof QboApiError) results[target] = { ok: false, status: err.status, error: err.message };
            else throw err;
          }
        }
        return { docType: entity, docId, line, results };
      });

      app.post('/v1/quickbooks/dev/link-experiment/cleanup', async (req, reply) => {
        const { companyId } = authenticate(req);
        const body = (req.body ?? {}) as { docType?: string; docId?: string };
        const entity = entityOf(body.docType);
        if (!entity || !body.docId) return reply.code(400).send({ error: 'bad_request', message: 'docType and docId required' });
        const docId = body.docId;

        return tokens.withAccess('quickbooks', companyId, async (a) => {
          const doc = await qb.api.getDocument(a.realmId, a.accessToken, entity, docId);
          const patch: Record<string, unknown> = {};
          if (hasLinkLine(doc.PrivateNote)) patch['PrivateNote'] = removeLinkLines(doc.PrivateNote);
          if (hasLinkLine(doc.CustomerMemo?.value)) patch['CustomerMemo'] = { value: removeLinkLines(doc.CustomerMemo?.value) };
          if (Object.keys(patch).length) {
            await qb.api.updateDocumentSparse(a.realmId, a.accessToken, entity, {
              Id: doc.Id,
              SyncToken: doc.SyncToken,
              ...patch,
            });
          }
          const atts = await qb.api.query<{ QueryResponse: { Attachable?: QboDocument[] } }>(
            a.realmId,
            a.accessToken,
            `select * from Attachable where AttachableRef.EntityRef.Type = '${entity}' and AttachableRef.EntityRef.value = '${docId.replace(/[^0-9A-Za-z_-]/g, '')}'`,
          );
          let deleted = 0;
          for (const att of atts.QueryResponse.Attachable ?? []) {
            if (typeof att['Note'] === 'string' && hasLinkLine(att['Note'])) {
              await qb.api.deleteAttachable(a.realmId, a.accessToken, { Id: att.Id, SyncToken: att.SyncToken });
              deleted++;
            }
          }
          return { cleaned: Object.keys(patch), attachablesDeleted: deleted };
        });
      });
    }
  }

  return app;
}
