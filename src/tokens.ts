import {
  ProviderUnauthorizedError,
  ReconnectRequiredError,
  type OAuthProvider,
} from './providers/types.js';
import type { Connection, ConnectionStore, ProviderId } from './store/types.js';

export class NotConnectedError extends Error {
  constructor() {
    super('No connection for this company');
    this.name = 'NotConnectedError';
  }
}

/** Another instance holds the refresh lease and did not finish in time. Retry shortly. */
export class RefreshBusyError extends Error {
  constructor() {
    super('A token refresh is in progress');
    this.name = 'RefreshBusyError';
  }
}

const LEASE_TTL_MS = 30_000;
const LEASE_WAIT_MS = 15_000;
const LEASE_POLL_MS = 250;

export interface TokenServiceOptions {
  /** Refresh this long before the access token expires. */
  skewMs?: number;
  now?: () => number;
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Access {
  accessToken: string;
  realmId: string;
}

/**
 * Keeps ERP access tokens valid.
 * Rules that matter:
 *  - The refresh token ROTATES: every refresh response is persisted before the new access token is used.
 *  - Single-flight per connection: concurrent callers share one refresh (a second refresh with an
 *    already-rotated token would invalidate the connection).
 *  - Inside a refresh we re-read the store, so a caller holding a stale copy never refreshes twice.
 *  - A rejected/expired refresh token marks the connection `needs_reconnect` (user must re-authorize).
 */
export class TokenService {
  private readonly inflight = new Map<string, Promise<Connection>>();
  private readonly skewMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly store: ConnectionStore,
    private readonly oauthFor: (provider: ProviderId) => OAuthProvider,
    opts: TokenServiceOptions = {},
  ) {
    this.skewMs = opts.skewMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async getAccess(provider: ProviderId, companyId: string, opts: { forceRefresh?: boolean } = {}): Promise<Access> {
    const conn = await this.store.get(provider, companyId);
    if (!conn) throw new NotConnectedError();
    if (conn.status === 'needs_reconnect') throw new ReconnectRequiredError();

    const stillFresh = conn.accessExpiresAt - this.now() > this.skewMs;
    if (stillFresh && !opts.forceRefresh) return { accessToken: conn.accessToken, realmId: conn.realmId };

    const fresh = await this.refresh(provider, companyId, opts.forceRefresh ?? false);
    return { accessToken: fresh.accessToken, realmId: fresh.realmId };
  }

  /** Runs an ERP call; if the ERP says the token is bad, refreshes once and retries once. */
  async withAccess<T>(provider: ProviderId, companyId: string, fn: (a: Access) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.getAccess(provider, companyId));
    } catch (err) {
      if (!(err instanceof ProviderUnauthorizedError)) throw err;
      return fn(await this.getAccess(provider, companyId, { forceRefresh: true }));
    }
  }

  private refresh(provider: ProviderId, companyId: string, force: boolean): Promise<Connection> {
    const key = `${provider}:${companyId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.doRefresh(provider, companyId, force).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /**
   * With a store shared by several instances, only the lease holder may refresh. Everyone else waits for
   * the holder to persist the rotated token, then uses it. Returns a fresh connection (someone else did the
   * work) or the lease to refresh under.
   */
  private async acquireOrWait(provider: ProviderId, companyId: string): Promise<{ lease: string } | { fresh: Connection }> {
    const lease = await this.store.acquireRefreshLease!(provider, companyId, LEASE_TTL_MS);
    if (lease) return { lease };

    const deadline = Date.now() + LEASE_WAIT_MS;
    while (Date.now() < deadline) {
      await this.sleep(LEASE_POLL_MS);
      const c = await this.store.get(provider, companyId);
      if (!c) throw new NotConnectedError();
      if (c.status === 'needs_reconnect') throw new ReconnectRequiredError();
      if (c.accessExpiresAt - this.now() > this.skewMs) return { fresh: c };
      const retry = await this.store.acquireRefreshLease!(provider, companyId, LEASE_TTL_MS);
      if (retry) return { lease: retry };
    }
    throw new RefreshBusyError();
  }

  private async doRefresh(provider: ProviderId, companyId: string, force: boolean): Promise<Connection> {
    if (!this.store.acquireRefreshLease) return this.doRefreshLocked(provider, companyId, force);

    const got = await this.acquireOrWait(provider, companyId);
    if ('fresh' in got) return got.fresh;
    try {
      return await this.doRefreshLocked(provider, companyId, force);
    } finally {
      await this.store.releaseRefreshLease?.(provider, companyId, got.lease).catch(() => undefined);
    }
  }

  private async doRefreshLocked(provider: ProviderId, companyId: string, force: boolean): Promise<Connection> {
    const latest = await this.store.get(provider, companyId);
    if (!latest) throw new NotConnectedError();
    if (latest.status === 'needs_reconnect') throw new ReconnectRequiredError();

    // Someone else already refreshed while we waited.
    if (!force && latest.accessExpiresAt - this.now() > this.skewMs) return latest;

    if (this.now() >= latest.refreshExpiresAt) {
      await this.markNeedsReconnect(latest, 'Refresh token expired');
      throw new ReconnectRequiredError('Refresh token expired');
    }

    let tokens;
    try {
      tokens = await this.oauthFor(provider).refresh(latest.refreshToken);
    } catch (err) {
      if (err instanceof ReconnectRequiredError) await this.markNeedsReconnect(latest, err.message);
      throw err;
    }

    const updated: Connection = {
      ...latest,
      ...tokens, // includes the ROTATED refresh token
      status: 'connected',
      updatedAt: this.now(),
      lastError: undefined,
    };
    await this.store.put(updated);
    return updated;
  }

  private async markNeedsReconnect(conn: Connection, reason: string): Promise<void> {
    await this.store.put({ ...conn, status: 'needs_reconnect', lastError: reason, updatedAt: this.now() });
  }
}
