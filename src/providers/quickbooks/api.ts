import { ProviderUnauthorizedError } from '../types.js';

const BASE_URLS = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
} as const;

export class QboApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'QboApiError';
  }
}

export type DocumentEntity = 'Invoice' | 'Estimate';

/** A QuickBooks document as returned by the API (only the fields we touch are typed). */
export type QboDocument = Record<string, unknown> & {
  Id: string;
  SyncToken: string;
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
};

export interface QuickBooksApiConfig {
  environment: 'sandbox' | 'production';
  minorVersion: number;
}

/** Thin, typed-by-need wrapper over the QuickBooks Online Accounting REST API. */
export class QuickBooksApi {
  constructor(
    private readonly cfg: QuickBooksApiConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request<T>(
    realmId: string,
    accessToken: string,
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${BASE_URLS[this.cfg.environment]}/v3/company/${encodeURIComponent(realmId)}${path}`);
    url.searchParams.set('minorversion', String(this.cfg.minorVersion));
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    const res = await this.fetchFn(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const tid = res.headers.get('intuit_tid') ?? undefined;

    if (res.status === 401) throw new ProviderUnauthorizedError();
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as {
        Fault?: { Error?: { Message?: string; Detail?: string; code?: string }[] };
      } | null;
      const first = json?.Fault?.Error?.[0];
      const msg = first ? `${first.Message ?? 'QuickBooks error'}${first.Detail ? `: ${first.Detail}` : ''}` : `HTTP ${res.status}`;
      throw new QboApiError(msg, res.status, tid);
    }
    return (await res.json()) as T;
  }

  /** QuickBooks SQL-like query, e.g. `select * from Invoice maxresults 10`. */
  async query<T>(realmId: string, accessToken: string, sql: string): Promise<T> {
    return this.request<T>(realmId, accessToken, 'GET', '/query', { query: { query: sql } });
  }

  async getDocument(realmId: string, accessToken: string, entity: DocumentEntity, id: string) {
    const r = await this.request<Record<string, QboDocument>>(
      realmId,
      accessToken,
      'GET',
      `/${entity.toLowerCase()}/${encodeURIComponent(id)}`,
    );
    return r[entity] as QboDocument;
  }

  /** Sparse update: only the given fields change. `Id` and the current `SyncToken` are required by QuickBooks. */
  async updateDocumentSparse(
    realmId: string,
    accessToken: string,
    entity: DocumentEntity,
    doc: { Id: string; SyncToken: string } & Record<string, unknown>,
  ) {
    const r = await this.request<Record<string, QboDocument>>(realmId, accessToken, 'POST', `/${entity.toLowerCase()}`, {
      body: { ...doc, sparse: true },
    });
    return r[entity] as QboDocument;
  }

  /** A note-only attachment (no file) linked to a document. */
  async createAttachableNote(realmId: string, accessToken: string, entity: DocumentEntity, docId: string, note: string) {
    const r = await this.request<{ Attachable: QboDocument }>(realmId, accessToken, 'POST', '/attachable', {
      body: { Note: note, AttachableRef: [{ EntityRef: { type: entity, value: docId }, IncludeOnSend: false }] },
    });
    return r.Attachable;
  }

  async deleteAttachable(realmId: string, accessToken: string, att: { Id: string; SyncToken: string }) {
    await this.request(realmId, accessToken, 'POST', '/attachable', { query: { operation: 'delete' }, body: att });
  }

  async getCompanyInfo(realmId: string, accessToken: string) {
    const r = await this.request<{ CompanyInfo: Record<string, unknown> & { CompanyName?: string } }>(
      realmId,
      accessToken,
      'GET',
      `/companyinfo/${encodeURIComponent(realmId)}`,
    );
    return r.CompanyInfo;
  }
}
