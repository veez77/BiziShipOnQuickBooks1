import { describe, expect, it, vi } from 'vitest';
import {
  ProviderUnauthorizedError,
  ReconnectRequiredError,
  type OAuthProvider,
  type TokenSet,
} from '../src/providers/types.js';
import { MemoryConnectionStore } from '../src/store/memoryStore.js';
import type { Connection } from '../src/store/types.js';
import { NotConnectedError, TokenService } from '../src/tokens.js';

const HOUR = 3600_000;
const T0 = 1_000_000_000_000;

function conn(over: Partial<Connection> = {}): Connection {
  return {
    provider: 'quickbooks',
    companyId: 'c1',
    realmId: 'realm-1',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessExpiresAt: T0 + HOUR,
    refreshExpiresAt: T0 + 100 * 24 * HOUR,
    status: 'connected',
    connectedAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function fakeOAuth(impl: (rt: string) => Promise<TokenSet>) {
  const refresh = vi.fn(impl);
  const oauth: OAuthProvider = {
    buildAuthUrl: () => '',
    exchangeCode: async () => {
      throw new Error('unused');
    },
    refresh,
    revoke: async () => {},
  };
  return { oauth, refresh };
}

const rotated = (n: number): TokenSet => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  accessExpiresAt: T0 + 10 * HOUR,
  refreshExpiresAt: T0 + 100 * 24 * HOUR,
});

describe('TokenService', () => {
  it('returns the stored token without calling Intuit while it is fresh', async () => {
    const store = new MemoryConnectionStore();
    await store.put(conn());
    const { oauth, refresh } = fakeOAuth(async () => rotated(2));
    const svc = new TokenService(store, () => oauth, { now: () => T0 });

    expect(await svc.getAccess('quickbooks', 'c1')).toEqual({ accessToken: 'access-1', realmId: 'realm-1' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes inside the skew window and PERSISTS the rotated refresh token', async () => {
    const store = new MemoryConnectionStore();
    await store.put(conn({ accessExpiresAt: T0 + 60_000 })); // 1 min left < 5 min skew
    const { oauth, refresh } = fakeOAuth(async () => rotated(2));
    const svc = new TokenService(store, () => oauth, { now: () => T0 });

    const a = await svc.getAccess('quickbooks', 'c1');
    expect(a.accessToken).toBe('access-2');
    expect(refresh).toHaveBeenCalledWith('refresh-1');
    expect((await store.get('quickbooks', 'c1'))?.refreshToken).toBe('refresh-2');
  });

  it('shares ONE refresh between concurrent callers', async () => {
    const store = new MemoryConnectionStore();
    await store.put(conn({ accessExpiresAt: T0 })); // already expired
    const { oauth, refresh } = fakeOAuth(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return rotated(2);
    });
    const svc = new TokenService(store, () => oauth, { now: () => T0 });

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => svc.getAccess('quickbooks', 'c1')));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.accessToken))).toEqual(new Set(['access-2']));
  });

  it('does not refresh again when a stale caller arrives after another already refreshed', async () => {
    const store = new MemoryConnectionStore();
    await store.put(conn({ accessExpiresAt: T0 })); // expired
    const { oauth, refresh } = fakeOAuth(async () => rotated(2));
    const svc = new TokenService(store, () => oauth, { now: () => T0 });

    await svc.getAccess('quickbooks', 'c1');
    await svc.getAccess('quickbooks', 'c1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('marks the connection needs_reconnect when Intuit rejects the refresh token', async () => {
    const store = new MemoryConnectionStore();
    await store.put(conn({ accessExpiresAt: T0 }));
    const { oauth } = fakeOAuth(async () => {
      throw new ReconnectRequiredError('invalid_grant');
    });
    const svc = new TokenService(store, () => oauth, { now: () => T0 });

    await expect(svc.getAccess('quickbooks', 'c1')).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect((await store.get('quickbooks', 'c1'))?.status).toBe('needs_reconnect');
    // and stops trying
    await expect(svc.getAccess('quickbooks', 'c1')).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it('does not even call Intuit when the refresh token has expired', async () => {
    const store = new MemoryConnectionStore();
    await store.put(conn({ accessExpiresAt: T0, refreshExpiresAt: T0 - 1 }));
    const { oauth, refresh } = fakeOAuth(async () => rotated(2));
    const svc = new TokenService(store, () => oauth, { now: () => T0 });

    await expect(svc.getAccess('quickbooks', 'c1')).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('throws NotConnectedError when there is no connection', async () => {
    const svc = new TokenService(new MemoryConnectionStore(), () => fakeOAuth(async () => rotated(2)).oauth);
    await expect(svc.getAccess('quickbooks', 'nobody')).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('withAccess refreshes once and retries once on a 401-style rejection', async () => {
    const store = new MemoryConnectionStore();
    await store.put(conn()); // looks fresh locally, but Intuit will say it is not
    const { oauth, refresh } = fakeOAuth(async () => rotated(2));
    const svc = new TokenService(store, () => oauth, { now: () => T0 });

    const seen: string[] = [];
    const result = await svc.withAccess('quickbooks', 'c1', async (a) => {
      seen.push(a.accessToken);
      if (a.accessToken === 'access-1') throw new ProviderUnauthorizedError();
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(seen).toEqual(['access-1', 'access-2']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('two instances sharing a store refresh ONCE (cross-instance lease)', async () => {
    const store = new MemoryConnectionStore({ leases: true });
    await store.put(conn({ accessExpiresAt: T0 })); // expired
    const { oauth, refresh } = fakeOAuth(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return rotated(2);
    });
    const sleep = () => new Promise<void>((r) => setTimeout(r, 5));
    // Two separate TokenService objects = two Lambda instances: no shared in-process single-flight.
    const a = new TokenService(store, () => oauth, { now: () => T0, sleep });
    const b = new TokenService(store, () => oauth, { now: () => T0, sleep });

    const [ra, rb] = await Promise.all([a.getAccess('quickbooks', 'c1'), b.getAccess('quickbooks', 'c1')]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(ra.accessToken).toBe('access-2');
    expect(rb.accessToken).toBe('access-2');
  });

  it('releases the lease after a failed refresh so the next caller can proceed', async () => {
    const store = new MemoryConnectionStore({ leases: true });
    await store.put(conn({ accessExpiresAt: T0 }));
    let n = 0;
    const { oauth } = fakeOAuth(async () => {
      if (++n === 1) throw new Error('network down');
      return rotated(2);
    });
    const svc = new TokenService(store, () => oauth, { now: () => T0, sleep: async () => {} });

    await expect(svc.getAccess('quickbooks', 'c1')).rejects.toThrow('network down');
    expect((await svc.getAccess('quickbooks', 'c1')).accessToken).toBe('access-2'); // not stuck behind a dead lease
  });

  it('a waiting instance gives up with RefreshBusyError if the holder never finishes', async () => {
    const store = new MemoryConnectionStore({ leases: true });
    await store.put(conn({ accessExpiresAt: T0 }));
    await store.acquireRefreshLease!('quickbooks', 'c1', 60_000); // someone else holds it, and never finishes
    const { oauth, refresh } = fakeOAuth(async () => rotated(2));
    let clock = 0;
    const svc = new TokenService(store, () => oauth, { now: () => T0, sleep: async () => { clock += 5000; } });
    const realNow = Date.now;
    Date.now = () => realNow() + clock; // let the 15 s wait elapse instantly
    try {
      await expect(svc.getAccess('quickbooks', 'c1')).rejects.toThrow('A token refresh is in progress');
    } finally {
      Date.now = realNow;
    }
    expect(refresh).not.toHaveBeenCalled();
  });

  it('withAccess does not loop forever if the retry is also rejected', async () => {
    const store = new MemoryConnectionStore();
    await store.put(conn());
    const { oauth } = fakeOAuth(async () => rotated(2));
    const svc = new TokenService(store, () => oauth, { now: () => T0 });

    await expect(
      svc.withAccess('quickbooks', 'c1', async () => {
        throw new ProviderUnauthorizedError();
      }),
    ).rejects.toBeInstanceOf(ProviderUnauthorizedError);
  });
});
