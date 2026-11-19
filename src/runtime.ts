import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { createQuickBooksProvider } from './providers/quickbooks/index.js';
import type { ErpProvider } from './providers/types.js';
import { buildApp } from './server.js';
import type { NonceStore } from './state.js';
import type { HandleStore } from './store/handles.js';
import type { SettingsStore } from './store/settings.js';
import type { ConnectionStore, ProviderId } from './store/types.js';
import { TokenService } from './tokens.js';

export interface Stores {
  connections: ConnectionStore;
  settings: SettingsStore;
  /** Omit for the in-memory defaults (one local process). */
  handles?: HandleStore;
  nonces?: NonceStore;
}

/** Wires providers, token service and HTTP app. Shared by the local server and the Lambda entry point. */
export function buildRuntime(config: Config, stores: Stores): FastifyInstance {
  const quickbooks = createQuickBooksProvider(
    {
      clientId: config.QBO_CLIENT_ID,
      clientSecret: config.QBO_CLIENT_SECRET,
      redirectUri: config.QBO_REDIRECT_URI,
    },
    { environment: config.QBO_ENVIRONMENT, minorVersion: config.QBO_MINOR_VERSION },
  );

  // Adding Sage later = create its provider here and register it. Nothing else changes.
  const providers = new Map<ProviderId, ErpProvider>([[quickbooks.id, quickbooks]]);

  const tokens = new TokenService(stores.connections, (id) => {
    const p = providers.get(id);
    if (!p) throw new Error(`Unknown provider ${id}`);
    return p.oauth;
  });

  return buildApp({
    config,
    store: stores.connections,
    providers,
    tokens,
    settings: stores.settings,
    handles: stores.handles,
    nonces: stores.nonces,
  });
}
