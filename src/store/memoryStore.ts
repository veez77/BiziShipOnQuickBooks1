import { randomUUID } from 'node:crypto';
import type { Connection, ConnectionStore, ProviderId } from './types.js';

/** For tests. Not durable. With `leases: true` it also behaves like a store shared by several instances. */
export class MemoryConnectionStore implements ConnectionStore {
  private data = new Map<string, Connection>();
  private leases = new Map<string, { id: string; until: number }>();
  private k = (p: ProviderId, c: string) => `${p}:${c}`;

  constructor(opts: { leases?: boolean } = {}) {
    if (opts.leases) {
      this.acquireRefreshLease = async (provider, companyId, ttlMs) => {
        const key = this.k(provider, companyId);
        const held = this.leases.get(key);
        if (held && held.until > Date.now()) return null;
        const id = randomUUID();
        this.leases.set(key, { id, until: Date.now() + ttlMs });
        return id;
      };
      this.releaseRefreshLease = async (provider, companyId, lease) => {
        const key = this.k(provider, companyId);
        if (this.leases.get(key)?.id === lease) this.leases.delete(key);
      };
    }
  }

  acquireRefreshLease?: ConnectionStore['acquireRefreshLease'];
  releaseRefreshLease?: ConnectionStore['releaseRefreshLease'];

  async get(provider: ProviderId, companyId: string) {
    const c = this.data.get(this.k(provider, companyId));
    return c ? { ...c } : null;
  }
  async put(connection: Connection) {
    this.data.set(this.k(connection.provider, connection.companyId), { ...connection });
  }
  async delete(provider: ProviderId, companyId: string) {
    this.data.delete(this.k(provider, companyId));
  }
}
