import { OAuthError, ReconnectRequiredError, type OAuthProvider, type TokenSet } from '../types.js';

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
/** Least privilege: accounting only. Payments / OpenID scopes are not requested. */
const SCOPE = 'com.intuit.quickbooks.accounting';

export interface QuickBooksOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
  error?: string;
}

export class QuickBooksOAuth implements OAuthProvider {
  constructor(
    private readonly cfg: QuickBooksOAuthConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  buildAuthUrl(state: string): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  exchangeCode(code: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
    });
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(refreshToken: string): Promise<void> {
    const res = await this.fetchFn(REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: this.basicAuth(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: refreshToken }),
    });
    if (!res.ok) {
      throw new OAuthError(`Token revocation failed (HTTP ${res.status})`, res.status, res.headers.get('intuit_tid') ?? undefined);
    }
  }

  private basicAuth(): string {
    return `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`;
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenSet> {
    const requestedAt = this.now();
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: this.basicAuth(),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
    const tid = res.headers.get('intuit_tid') ?? undefined;
    const json = (await res.json().catch(() => ({}))) as TokenResponse;

    if (!res.ok) {
      // invalid_grant on a refresh = revoked/expired/already-rotated token: the user must reconnect.
      if (json.error === 'invalid_grant') throw new ReconnectRequiredError('Refresh token rejected by Intuit');
      throw new OAuthError(`Intuit token endpoint error (HTTP ${res.status}${json.error ? `, ${json.error}` : ''})`, res.status, tid);
    }
    if (!json.access_token || !json.refresh_token || !json.expires_in) {
      throw new OAuthError('Unexpected token response shape from Intuit', res.status, tid);
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      accessExpiresAt: requestedAt + json.expires_in * 1000,
      // If Intuit omits the refresh lifetime, assume the shortest documented window (~100 days).
      refreshExpiresAt: requestedAt + (json.x_refresh_token_expires_in ?? 100 * 24 * 3600) * 1000,
    };
  }
}
