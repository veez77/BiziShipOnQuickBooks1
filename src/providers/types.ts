import type { ProviderId } from '../store/types.js';
import type { AccessRunner, ErpDocuments } from './documents.js';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // epoch ms
  refreshExpiresAt: number; // epoch ms
}

/** Thrown when the user must authorize again (refresh token revoked, expired or rejected). */
export class ReconnectRequiredError extends Error {
  constructor(message = 'Reconnect required') {
    super(message);
    this.name = 'ReconnectRequiredError';
  }
}

/** An ERP API call was rejected because the access token is expired/revoked. Callers refresh once and retry. */
export class ProviderUnauthorizedError extends Error {
  constructor() {
    super('The ERP rejected the access token');
    this.name = 'ProviderUnauthorizedError';
  }
}

/** Thrown for unexpected failures talking to the ERP's OAuth endpoints. Never contains tokens. */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

/** What every ERP provider must be able to do to connect and stay connected. */
export interface OAuthProvider {
  buildAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  revoke(refreshToken: string): Promise<void>;
}

/** Declares what a provider supports; the frontend renders from this, so a new ERP needs no new screens by default. */
export interface ProviderCapabilities {
  documentTypes: string[];
  attachments: boolean;
  /** How the shipment link is stored in the ERP. QuickBooks: "memo". */
  linkModes: string[];
  multipleShipmentsPerDocument: boolean;
}

export interface ErpProvider {
  id: ProviderId;
  displayName: string;
  capabilities: ProviderCapabilities;
  oauth: OAuthProvider;
  /** Document operations; `access` runs an ERP call with a valid token for the company. */
  documents(access: AccessRunner): ErpDocuments;
  /** Fetches a human-readable company name to show after connecting; best effort. */
  fetchCompanyName(realmId: string, accessToken: string): Promise<string | undefined>;
}
