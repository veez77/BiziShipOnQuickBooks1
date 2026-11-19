export type ProviderId = 'quickbooks';
export type ConnectionStatus = 'connected' | 'needs_reconnect';

/** One ERP connection, owned by one BiziShip company. Tokens are encrypted at rest by the store. */
export interface Connection {
  provider: ProviderId;
  /** The BiziShip company this connection belongs to (never the ERP's own identity). */
  companyId: string;
  /** The ERP's company identifier (QuickBooks: realmId). */
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // epoch ms
  refreshExpiresAt: number; // epoch ms
  status: ConnectionStatus;
  connectedAt: number;
  updatedAt: number;
  companyName?: string;
  lastError?: string;
}

export interface ConnectionStore {
  get(provider: ProviderId, companyId: string): Promise<Connection | null>;
  put(connection: Connection): Promise<void>;
  delete(provider: ProviderId, companyId: string): Promise<void>;

  /**
   * Cross-instance refresh lease. QuickBooks rotates the refresh token on every refresh, so two instances
   * refreshing at the same time would invalidate the connection. A store shared by several instances
   * (DynamoDB) implements these; single-process stores (file, memory) leave them out and rely on the
   * in-process single-flight in TokenService.
   * `acquireRefreshLease` returns a lease id, or null if another instance holds an unexpired lease.
   */
  acquireRefreshLease?(provider: ProviderId, companyId: string, ttlMs: number): Promise<string | null>;
  releaseRefreshLease?(provider: ProviderId, companyId: string, lease: string): Promise<void>;
}
