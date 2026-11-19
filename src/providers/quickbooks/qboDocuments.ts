import {
  AttachmentTooLargeError,
  DocumentNotFoundError,
  InvalidCursorError,
  MAX_ATTACHMENT_BYTES,
  type AccessRunner,
  type Address,
  type AttachmentInfo,
  type DocumentListQuery,
  type DocumentSummaryCore,
  type ErpDocument,
  type ErpDocuments,
} from '../documents.js';
import { QboApiError, type QuickBooksApi } from './api.js';
import {
  entityOf,
  itemIdsOf,
  mapAddress,
  qboLiteral,
  toDocument,
  toSummary,
  type Entity,
  type QDoc,
} from './mapping.js';

const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const ENTITIES: Entity[] = ['Estimate', 'Invoice'];

type Offsets = Record<Entity, number>;

function decodeCursor(cursor: string | undefined): Offsets {
  if (!cursor) return { Estimate: 0, Invoice: 0 };
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Offsets>;
    const ok = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1_000_000;
    if (!ok(o.Estimate) || !ok(o.Invoice)) throw new Error('bad');
    return { Estimate: o.Estimate!, Invoice: o.Invoice! };
  } catch {
    throw new InvalidCursorError();
  }
}
const encodeCursor = (o: Offsets) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

/** Newest first: by date, then by numeric id. */
const newestFirst = (a: DocumentSummaryCore, b: DocumentSummaryCore) =>
  (b.date ?? '').localeCompare(a.date ?? '') || Number(b.id) - Number(a.id) || b.id.localeCompare(a.id);

/** Reads a response body but gives up as soon as it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new AttachmentTooLargeError();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export class QuickBooksDocuments implements ErpDocuments {
  constructor(
    private readonly api: QuickBooksApi,
    private readonly access: AccessRunner,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  // ---- list ------------------------------------------------------------------------------
  /**
   * What QuickBooks can filter itself: invoices by Balance. Estimates cannot be filtered by status in a
   * query ("TxnStatus is not queryable"), so for them `keeps` filters after the fetch.
   * `null` means the entity can never match (estimates are never "paid").
   */
  private where(entity: Entity, status: DocumentListQuery['status']): string[] | null {
    if (status === 'all') return [];
    if (entity === 'Invoice') return status === 'open' ? [`Balance > '0'`] : [`Balance = '0'`]; // paid | closed
    return status === 'paid' ? null : [];
  }

  private keeps(entity: Entity, status: DocumentListQuery['status'], s: DocumentSummaryCore): boolean {
    if (entity === 'Invoice' || status === 'all') return true;
    return status === 'open' ? s.status === 'open' : s.status === 'closed';
  }

  /**
   * Fetches summaries newest first, starting after `offset` raw rows, until `need` rows that pass the
   * status filter are found or the data runs out. `raw` is each row's position, so the cursor can resume exactly there.
   */
  private async scan(
    a: { realmId: string; accessToken: string },
    entity: Entity,
    q: DocumentListQuery,
    offset: number,
    need: number,
  ): Promise<{ rows: { s: DocumentSummaryCore; raw: number }[]; more: boolean; scannedTo: number }> {
    const w = this.where(entity, q.status);
    if (w === null) return { rows: [], more: false, scannedTo: offset };
    const batch = Math.min(200, Math.max(need, 50));
    const rows: { s: DocumentSummaryCore; raw: number }[] = [];
    let pos = offset;
    for (let round = 0; round < 10; round++) {
      const sql =
        `select * from ${entity}${w.length ? ` where ${w.join(' and ')}` : ''} ` +
        `orderby TxnDate desc startposition ${pos + 1} maxresults ${batch}`;
      const r = await this.api.query<{ QueryResponse: Record<string, QDoc[]> }>(a.realmId, a.accessToken, sql);
      const got = r.QueryResponse[entity] ?? [];
      for (let i = 0; i < got.length; i++) {
        const s = toSummary(entity, got[i]!);
        if (this.keeps(entity, q.status, s)) rows.push({ s, raw: pos + i });
        if (rows.length >= need) return { rows, more: true, scannedTo: pos + i + 1 };
      }
      pos += got.length;
      if (got.length < batch) return { rows, more: false, scannedTo: pos };
    }
    return { rows, more: true, scannedTo: pos }; // scanned a lot without filling the page; there may be more further on
  }

  async list(companyId: string, q: DocumentListQuery) {
    const entities = q.type ? [entityOf(q.type)].filter((e): e is Entity => !!e) : ENTITIES;
    if (q.q?.trim()) return this.search(companyId, entities, q);

    const offsets = decodeCursor(q.cursor);
    const fetched = await this.access(companyId, async (a) => {
      const out: Partial<Record<Entity, Awaited<ReturnType<QuickBooksDocuments['scan']>>>> = {};
      for (const entity of entities) out[entity] = await this.scan(a, entity, q, offsets[entity], q.limit + 1);
      return out;
    });

    const candidates = entities.flatMap((e) => (fetched[e]?.rows ?? []).map((r) => ({ e, ...r })));
    candidates.sort((x, y) => newestFirst(x.s, y.s));
    const page = candidates.slice(0, q.limit);
    // Resume each entity exactly where this page stopped. If every row it fetched was handed out, it has
    // been scanned up to `scannedTo` (which also skips estimates the status filter rejected, so a cursor always advances).
    const next: Offsets = { ...offsets };
    for (const e of entities) {
      const f = fetched[e];
      if (!f) continue;
      const handedOut = page.filter((c) => c.e === e);
      if (handedOut.length === f.rows.length) next[e] = f.scannedTo;
      else if (handedOut.length) next[e] = Math.max(...handedOut.map((c) => c.raw)) + 1;
    }
    const more = candidates.length > q.limit || entities.some((e) => fetched[e]?.more && (fetched[e]?.rows.length ?? 0) < q.limit + 1);
    return {
      items: page.map((c) => c.s),
      nextCursor: more ? encodeCursor(next) : null,
    };
  }

  /** Search by document number or customer name. QuickBooks queries have no OR, so this is a union of two queries; no further pages. */
  private async search(companyId: string, entities: Entity[], q: DocumentListQuery) {
    const term = qboLiteral(q.q!.trim().slice(0, 64));
    const found = await this.access(companyId, async (a) => {
      const customers = await this.api.query<{ QueryResponse: { Customer?: { Id: string }[] } }>(
        a.realmId,
        a.accessToken,
        `select Id from Customer where DisplayName like '%${term}%' maxresults 20`,
      );
      const customerIds = (customers.QueryResponse.Customer ?? []).map((c) => c.Id).filter((id) => ID_RE.test(id));

      const all = new Map<string, DocumentSummaryCore>();
      for (const entity of entities) {
        const w = this.where(entity, q.status);
        if (w === null) continue;
        const base = w.length ? ` and ${w.join(' and ')}` : '';
        const queries = [`select * from ${entity} where DocNumber like '%${term}%'${base} orderby TxnDate desc maxresults ${q.limit}`];
        if (customerIds.length) {
          queries.push(
            `select * from ${entity} where CustomerRef in (${customerIds.map((i) => `'${i}'`).join(',')})${base} orderby TxnDate desc maxresults ${q.limit}`,
          );
        }
        for (const sql of queries) {
          const r = await this.api.query<{ QueryResponse: Record<string, QDoc[]> }>(a.realmId, a.accessToken, sql);
          for (const d of r.QueryResponse[entity] ?? []) {
            const s = toSummary(entity, d);
            if (this.keeps(entity, q.status, s)) all.set(`${s.type}:${s.id}`, s);
          }
        }
      }
      return [...all.values()];
    });
    found.sort(newestFirst);
    return { items: found.slice(0, q.limit), nextCursor: null };
  }

  // ---- one document -------------------------------------------------------------------------
  async get(companyId: string, type: string, id: string): Promise<ErpDocument> {
    const entity = entityOf(type);
    if (!entity || !ID_RE.test(id)) throw new DocumentNotFoundError();
    return this.access(companyId, async (a) => {
      let doc: QDoc;
      try {
        doc = (await this.api.getDocument(a.realmId, a.accessToken, entity, id)) as unknown as QDoc;
      } catch (err) {
        if (err instanceof QboApiError && (err.status === 404 || /not found/i.test(err.message))) throw new DocumentNotFoundError();
        throw err;
      }
      return toDocument(entity, doc, a.realmId, await this.itemTypes(a.realmId, a.accessToken, itemIdsOf(doc)));
    });
  }

  private async itemTypes(realmId: string, accessToken: string, ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const safe = ids.filter((i) => ID_RE.test(i));
    for (let i = 0; i < safe.length; i += 50) {
      const chunk = safe.slice(i, i + 50);
      const r = await this.api.query<{ QueryResponse: { Item?: { Id: string; Type?: string }[] } }>(
        realmId,
        accessToken,
        `select Id, Type from Item where Id in (${chunk.map((c) => `'${c}'`).join(',')})`,
      );
      for (const it of r.QueryResponse.Item ?? []) if (it.Type) out.set(it.Id, it.Type);
    }
    return out;
  }

  // ---- attachments ----------------------------------------------------------------------------
  async attachments(companyId: string, type: string, id: string): Promise<AttachmentInfo[]> {
    const entity = entityOf(type);
    if (!entity || !ID_RE.test(id)) throw new DocumentNotFoundError();
    return this.access(companyId, async (a) => {
      const r = await this.api.query<{ QueryResponse: { Attachable?: Record<string, unknown>[] } }>(
        a.realmId,
        a.accessToken,
        `select * from Attachable where AttachableRef.EntityRef.Type = '${entity}' and AttachableRef.EntityRef.value = '${id}'`,
      );
      return (r.QueryResponse.Attachable ?? [])
        .filter((x) => typeof x['FileName'] === 'string') // note-only attachables have no file
        .map((x) => ({
          id: String(x['Id']),
          name: String(x['FileName']),
          contentType: typeof x['ContentType'] === 'string' ? (x['ContentType'] as string) : undefined,
          size: typeof x['Size'] === 'number' ? (x['Size'] as number) : undefined,
        }));
    });
  }

  async attachment(companyId: string, type: string, id: string, attachmentId: string) {
    const entity = entityOf(type);
    if (!entity || !ID_RE.test(id) || !ID_RE.test(attachmentId)) throw new DocumentNotFoundError();
    return this.access(companyId, async (a) => {
      const r = await this.api.query<{ QueryResponse: { Attachable?: Record<string, unknown>[] } }>(
        a.realmId,
        a.accessToken,
        `select * from Attachable where Id = '${attachmentId}'`,
      );
      const att = r.QueryResponse.Attachable?.[0];
      // The attachment must really belong to this document: never serve another document's file.
      const refs = (att?.['AttachableRef'] as { EntityRef?: { type?: string; value?: string } }[] | undefined) ?? [];
      const belongs = refs.some((x) => x.EntityRef?.type === entity && x.EntityRef?.value === id);
      const uri = att?.['TempDownloadUri'];
      if (!att || !belongs || typeof att['FileName'] !== 'string' || typeof uri !== 'string') throw new DocumentNotFoundError();
      if (typeof att['Size'] === 'number' && att['Size'] > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError();
      if (!uri.startsWith('https://')) throw new DocumentNotFoundError();

      const res = await this.fetchFn(uri); // a pre-signed URL: no Authorization header
      if (!res.ok) throw new DocumentNotFoundError();
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError();
      const data = await readCapped(res, MAX_ATTACHMENT_BYTES);
      const contentType =
        typeof att['ContentType'] === 'string' ? (att['ContentType'] as string) : res.headers.get('content-type') ?? 'application/octet-stream';
      return { name: String(att['FileName']), contentType, data };
    });
  }

  // ---- company ----------------------------------------------------------------------------------
  async companyAddress(companyId: string): Promise<Address | undefined> {
    return this.access(companyId, async (a) => {
      const info = (await this.api.getCompanyInfo(a.realmId, a.accessToken)) as Record<string, unknown>;
      const addr = mapAddress((info['CompanyAddr'] ?? info['LegalAddr']) as Parameters<typeof mapAddress>[0]);
      if (!addr) return undefined;
      const name = typeof info['CompanyName'] === 'string' ? (info['CompanyName'] as string) : undefined;
      return name && !addr.company ? { company: name, ...addr } : addr;
    });
  }
}
