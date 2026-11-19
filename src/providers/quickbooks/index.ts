import type { ErpProvider } from '../types.js';
import { QuickBooksApi, type QuickBooksApiConfig } from './api.js';
import { QuickBooksDocuments } from './qboDocuments.js';
import { QuickBooksOAuth, type QuickBooksOAuthConfig } from './oauth.js';

export interface QuickBooksProvider extends ErpProvider {
  api: QuickBooksApi;
}

export function createQuickBooksProvider(
  oauthCfg: QuickBooksOAuthConfig,
  apiCfg: QuickBooksApiConfig,
  fetchFn: typeof fetch = fetch,
): QuickBooksProvider {
  const api = new QuickBooksApi(apiCfg, fetchFn);
  return {
    id: 'quickbooks',
    displayName: 'QuickBooks Online',
    capabilities: {
      documentTypes: ['estimate', 'invoice'],
      attachments: true,
      linkModes: ['memo'],
      multipleShipmentsPerDocument: true,
    },
    oauth: new QuickBooksOAuth(oauthCfg, fetchFn),
    api,
    documents: (access) => new QuickBooksDocuments(api, access, fetchFn),
    async fetchCompanyName(realmId, accessToken) {
      const info = await api.getCompanyInfo(realmId, accessToken);
      return typeof info.CompanyName === 'string' ? info.CompanyName : undefined;
    },
  };
}
