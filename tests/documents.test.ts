import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createQuickBooksProvider } from '../src/providers/quickbooks/index.js';
import {
  documentVersion,
  mapAddress,
  normalizeStatus,
  qboLiteral,
  type QDoc,
} from '../src/providers/quickbooks/mapping.js';
import type { ErpProvider } from '../src/providers/types.js';
import { buildApp } from '../src/server.js';
import { MemoryConnectionStore } from '../src/store/memoryStore.js';
import { MemoryHandleStore } from '../src/store/handles.js';
import { MemorySettingsStore } from '../src/store/settings.js';
import type { ProviderId } from '../src/store/types.js';
import { TokenService } from '../src/tokens.js';

const KEY = 'k'.repeat(40);
const REALM = '9341458704528073';

const config: Config = {
  QBO_CLIENT_ID: 'cid',
  QBO_CLIENT_SECRET: 'csecret',
  QBO_ENVIRONMENT: 'sandbox',
  QBO_REDIRECT_URI: 'http://localhost:3000/callback',
  QBO_MINOR_VERSION: 75,
  PORT: 3000,
  HOST: '127.0.0.1',
  AUTH_MODE: 'shared-secret',
  HUB_API_KEYS: KEY,
  DEV_BIZISHIP_COMPANY_ID: 'unused',
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  STATE_SIGNING_KEY: randomBytes(32).toString('base64'),
  STORE: 'file',
  APP_BASE_URL: 'https://app.biziship.ai',
  DATA_DIR: '.data',
};

const hdr = (over: Record<string, string> = {}) => ({
  'x-erp-hub-key': KEY,
  'x-biziship-company-id': 'co-1',
  'x-biziship-user-id': 'u-1',
  'x-biziship-role': 'ADMIN',
  ...over,
});

// ---- fixtures: a tiny fake QuickBooks ------------------------------------------------------
const estimate100 = (): QDoc & Record<string, unknown> => ({
  Id: '100',
  SyncToken: '3',
  DocNumber: '1001',
  TxnDate: '2026-11-01',
  TxnStatus: 'Closed',
  TotalAmt: 335.25,
  CurrencyRef: { value: 'USD' },
  CustomerRef: { value: '7', name: 'Sonnenschein Family Store' },
  BillEmail: { Address: 'Familiystore@intuit.com' },
  PrivateNote: 'old memo',
  ShipAddr: { Line1: 'Russ Sonnenschein', Line2: '5647 Cypress Hill Ave.', City: 'Middlefield', CountrySubDivisionCode: 'CA', PostalCode: '94303' },
  LinkedTxn: [{ TxnId: '130', TxnType: 'Invoice' }],
  CustomField: [{ Name: 'P.O. Number', StringValue: 'PO-7781' }],
  Line: [
    { Id: '1', DetailType: 'SalesItemLineDetail', Description: 'Rock Fountain', Amount: 275, SalesItemLineDetail: { ItemRef: { value: '5' }, Qty: 1, UnitPrice: 275 } },
    { Id: '2', DetailType: 'SalesItemLineDetail', Description: 'Fountain Pump', Amount: 12.75, SalesItemLineDetail: { ItemRef: { value: '11' }, Qty: 1, UnitPrice: 12.75 } },
    { Id: '3', DetailType: 'SalesItemLineDetail', Description: 'Concrete install', Amount: 47.5, SalesItemLineDetail: { ItemRef: { value: '3' }, Qty: 5, UnitPrice: 9.5 } },
    { DetailType: 'SubTotalLine', Amount: 335.25 },
  ],
});

interface Fake {
  estimates: (QDoc & Record<string, unknown>)[];
  invoices: (QDoc & Record<string, unknown>)[];
  attachables: Record<string, unknown>[];
  fail429: boolean;
  queries: string[];
}

function invoice(n: number, date: string, balance: number, customer = 'Cust A', customerId = '7'): QDoc & Record<string, unknown> {
  return {
    Id: String(n), SyncToken: '0', DocNumber: String(2000 + n), TxnDate: date, TotalAmt: 100, Balance: balance,
    CustomerRef: { value: customerId, name: customer }, Line: [],
  };
}

function fakeQbo(f: Fake) {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'files.example.com') {
      return new Response(Buffer.alloc(Number(url.searchParams.get('n') ?? 10), 1), { status: 200 });
    }
    if (f.fail429) return new Response('{}', { status: 429 });
    const path = url.pathname.replace(/^\/v3\/company\/[^/]+/, '');

    if (path.startsWith('/companyinfo/')) {
      return json({ CompanyInfo: { CompanyName: 'ACME Warehouse', CompanyAddr: { Line1: '12 Dock St', City: 'Oakland', CountrySubDivisionCode: 'CA', PostalCode: '94607' } } });
    }
    const one = path.match(/^\/(estimate|invoice)\/(\w+)$/);
    if (one) {
      const list = one[1] === 'estimate' ? f.estimates : f.invoices;
      const d = list.find((x) => x.Id === one[2]);
      if (!d) return json({ Fault: { Error: [{ Message: 'Object Not Found', Detail: 'x', code: '610' }] } }, 400);
      return json({ [one[1] === 'estimate' ? 'Estimate' : 'Invoice']: d });
    }
    if (path === '/query') {
      const sql = url.searchParams.get('query')!;
      f.queries.push(sql);
      const entity = sql.match(/from (Estimate|Invoice)\b/)?.[1] as 'Estimate' | 'Invoice' | undefined;
      if (entity) {
        let rows = [...(entity === 'Estimate' ? f.estimates : f.invoices)];
        if (sql.includes(`Balance > '0'`)) rows = rows.filter((r) => (r.Balance ?? 0) > 0);
        if (sql.includes(`Balance = '0'`)) rows = rows.filter((r) => r.Balance === 0);
        // The real QuickBooks rejects this (verified against the sandbox); the fake must too.
        if (sql.includes('TxnStatus')) {
          return json({ Fault: { Error: [{ Message: 'Invalid query', Detail: "QueryValidationError: property 'TxnStatus' is not queryable" }] } }, 400);
        }
        const like = sql.match(/DocNumber like '%([^%]*)%'/);
        if (like) rows = rows.filter((r) => (r.DocNumber ?? '').includes(like[1]!));
        const cust = sql.match(/CustomerRef in \(([^)]*)\)/);
        if (cust) rows = rows.filter((r) => cust[1]!.includes(`'${r.CustomerRef?.value}'`));
        rows.sort((a, b) => (b.TxnDate ?? '').localeCompare(a.TxnDate ?? ''));
        const start = Number(sql.match(/startposition (\d+)/)?.[1] ?? 1);
        const max = Number(sql.match(/maxresults (\d+)/)?.[1] ?? 100);
        return json({ QueryResponse: { [entity]: rows.slice(start - 1, start - 1 + max) } });
      }
      if (sql.includes('from Customer')) return json({ QueryResponse: { Customer: [{ Id: '7' }] } });
      if (sql.includes('from Item')) {
        return json({ QueryResponse: { Item: [{ Id: '5', Type: 'Inventory' }, { Id: '11', Type: 'NonInventory' }, { Id: '3', Type: 'Service' }] } });
      }
      if (sql.includes('from Attachable')) {
        const byId = sql.match(/where Id = '(\w+)'/);
        const byRef = sql.match(/Type = '(\w+)' and .*value = '(\w+)'/);
        const rows = f.attachables.filter((a) => {
          if (byId) return a['Id'] === byId[1];
          const refs = a['AttachableRef'] as { EntityRef: { type: string; value: string } }[];
          return refs.some((r) => r.EntityRef.type === byRef![1] && r.EntityRef.value === byRef![2]);
        });
        return json({ QueryResponse: { Attachable: rows } });
      }
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
}

function setup() {
  const f: Fake = { estimates: [estimate100()], invoices: [], attachables: [], fail429: false, queries: [] };
  const store = new MemoryConnectionStore();
  const qb = createQuickBooksProvider(
    { clientId: 'cid', clientSecret: 'csecret', redirectUri: config.QBO_REDIRECT_URI },
    { environment: 'sandbox', minorVersion: 75 },
    fakeQbo(f),
  );
  const providers = new Map<ProviderId, ErpProvider>([['quickbooks', qb]]);
  const tokens = new TokenService(store, () => qb.oauth);
  const handles = new MemoryHandleStore();
  const settings = new MemorySettingsStore();
  const app = buildApp({ config, store, providers, tokens, handles, settings, logger: false });
  const connect = async (companyId = 'co-1') =>
    store.put({
      provider: 'quickbooks', companyId, realmId: REALM, accessToken: 'A', refreshToken: 'R',
      accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 86_400_000_00,
      status: 'connected', connectedAt: 1, updatedAt: 1,
    });
  return { app, f, connect, handles };
}

// ---- pure mapping ------------------------------------------------------------------------------
describe('QuickBooks mapping', () => {
  it('normalises estimate and invoice status', () => {
    expect(normalizeStatus('Estimate', { Id: '1', TxnStatus: 'Pending' })).toBe('open');
    expect(normalizeStatus('Estimate', { Id: '1', TxnStatus: 'Accepted' })).toBe('open');
    expect(normalizeStatus('Estimate', { Id: '1', TxnStatus: 'Closed' })).toBe('closed');
    expect(normalizeStatus('Invoice', { Id: '1', TotalAmt: 100, Balance: 0 })).toBe('paid');
    expect(normalizeStatus('Invoice', { Id: '1', TotalAmt: 100, Balance: 40 })).toBe('partial');
    expect(normalizeStatus('Invoice', { Id: '1', TotalAmt: 100, Balance: 100 })).toBe('open');
    expect(normalizeStatus('Invoice', { Id: '1' })).toBe('unknown');
  });

  it('reads a leading name line as the company, not the street', () => {
    expect(mapAddress({ Line1: 'Russ S', Line2: '5647 Cypress Hill Ave.', City: 'M', CountrySubDivisionCode: 'CA', PostalCode: '94303' })).toEqual({
      company: 'Russ S', line1: '5647 Cypress Hill Ave.', city: 'M', state: 'CA', zip: '94303', country: 'US',
    });
    expect(mapAddress({ Line1: '12 Dock St', City: 'Oakland' })).toEqual({ line1: '12 Dock St', city: 'Oakland' });
    expect(mapAddress(undefined)).toBeUndefined();
  });

  it('version ignores memo and sync token but changes with the ship-to', () => {
    const a = estimate100();
    const same = { ...estimate100(), SyncToken: '99', PrivateNote: 'BiziShip shipment: https://x/y' };
    const moved = { ...estimate100(), ShipAddr: { ...a.ShipAddr, PostalCode: '94309' } };
    expect(documentVersion('Estimate', same)).toBe(documentVersion('Estimate', a));
    expect(documentVersion('Estimate', moved)).not.toBe(documentVersion('Estimate', a));
  });

  it('escapes query literals', () => {
    expect(qboLiteral("O'Brien\\")).toBe("O\\'Brien\\\\");
    expect(qboLiteral("a\nb")).toBe('a b');
  });
});

// ---- routes -----------------------------------------------------------------------------------------
describe('documents: seed', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.connect();
  });

  it('builds the seed from the ERP document with a handle', async () => {
    const res = await t.app.inject({ url: '/v1/quickbooks/documents/100?type=estimate', headers: hdr() });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.contextHandle).toMatch(/^hb_[A-Za-z0-9_-]{43}$/);
    expect(s.source).toMatchObject({
      provider: 'quickbooks', docType: 'estimate', id: '100', number: '1001', status: 'closed',
      ref: `${REALM}:estimate:100`, linkedDocuments: [{ type: 'invoice', id: '130' }],
    });
    expect(s.customer).toEqual({ name: 'Sonnenschein Family Store', email: 'Familiystore@intuit.com' });
    expect(s.destination).toEqual({
      value: { company: 'Russ Sonnenschein', line1: '5647 Cypress Hill Ave.', city: 'Middlefield', state: 'CA', zip: '94303', country: 'US' },
      origin: 'erp',
    });
    expect(s.origin).toMatchObject({ origin: 'erp', value: { company: 'ACME Warehouse', line1: '12 Dock St', city: 'Oakland' } });
    expect(s.references).toEqual({ po: { value: 'PO-7781', origin: 'erp' }, salesOrder: { value: '1001', origin: 'erp' } });
    expect(s.lines.map((l: { id: string; physicalHint: string; ship: boolean }) => [l.id, l.physicalHint, l.ship])).toEqual([
      ['1', 'likely', true], ['2', 'likely', true], ['3', 'unlikely', false],
    ]);
    expect(s.cargo).toEqual({ value: null, origin: 'default' });
    expect(s.shipmentLinks).toEqual([]);
    expect(s.shipmentCount).toBe(0);
    expect(s.warnings.map((w: { code: string }) => w.code)).toEqual(['document_closed']);
  });

  it('stores only the hash of the handle and a fresh handle per load', async () => {
    const a = (await t.app.inject({ url: '/v1/quickbooks/documents/100?type=estimate', headers: hdr() })).json();
    const b = (await t.app.inject({ url: '/v1/quickbooks/documents/100?type=estimate', headers: hdr() })).json();
    expect(a.contextHandle).not.toBe(b.contextHandle);
    expect(JSON.stringify([...(t.handles as unknown as { records: Map<string, unknown> }).records.values()])).not.toContain(a.contextHandle);
  });

  it('uses the saved default origin when the company set one', async () => {
    await t.app.inject({
      method: 'PUT', url: '/v1/quickbooks/setup', headers: hdr(),
      payload: { values: { defaultOrigin: { line1: '1 Main', city: 'Reno', state: 'NV', zip: '89501', country: 'US' } } },
    });
    const s = (await t.app.inject({ url: '/v1/quickbooks/documents/100?type=estimate', headers: hdr() })).json();
    expect(s.origin).toMatchObject({ origin: 'default', value: { line1: '1 Main', city: 'Reno' } });
  });

  it('unknown document is 404 document_not_found; bad input is 400 with details', async () => {
    const nf = await t.app.inject({ url: '/v1/quickbooks/documents/999?type=estimate', headers: hdr() });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error).toBe('document_not_found');

    const noType = await t.app.inject({ url: '/v1/quickbooks/documents/100', headers: hdr() });
    expect(noType.statusCode).toBe(400);
    expect(noType.json()).toMatchObject({ error: 'invalid_request', details: [{ field: 'type' }] });

    const badType = await t.app.inject({ url: '/v1/quickbooks/documents/100?type=salesorder', headers: hdr() });
    expect(badType.statusCode).toBe(400);

    const badId = await t.app.inject({ url: `/v1/quickbooks/documents/${encodeURIComponent("1' or 1=1")}?type=estimate`, headers: hdr() });
    expect(badId.statusCode).toBe(400);
  });

  it('an unconnected company gets 404 not_connected', async () => {
    const res = await t.app.inject({ url: '/v1/quickbooks/documents/100?type=estimate', headers: hdr({ 'x-biziship-company-id': 'co-2' }) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_connected');
  });

  it('maps QuickBooks throttling to 429 rate_limited', async () => {
    t.f.fail429 = true;
    const res = await t.app.inject({ url: '/v1/quickbooks/documents/100?type=estimate', headers: hdr() });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'rate_limited', retryAfterSeconds: 30 });
  });
});

describe('documents: version check', () => {
  let t: ReturnType<typeof setup>;
  let handle: string;
  beforeEach(async () => {
    t = setup();
    await t.connect();
    handle = (await t.app.inject({ url: '/v1/quickbooks/documents/100?type=estimate', headers: hdr() })).json().contextHandle;
  });
  const url = (h?: string, id = '100') => `/v1/quickbooks/documents/${id}/version?type=estimate${h ? `&handle=${h}` : ''}`;

  it('unchanged document: changed=false, and closed is reported', async () => {
    const r = (await t.app.inject({ url: url(handle), headers: hdr() })).json();
    expect(r).toMatchObject({ changed: false, closed: true, status: 'closed' });
    expect(r.version).toMatch(/^v-/);
  });

  it('our own memo write does not count as a change', async () => {
    t.f.estimates[0]!.PrivateNote = 'old memo\nBiziShip shipment: https://app.biziship.ai/shipments/x';
    t.f.estimates[0]!.SyncToken = '4';
    expect((await t.app.inject({ url: url(handle), headers: hdr() })).json().changed).toBe(false);
  });

  it('a changed ship-to is reported as changed', async () => {
    t.f.estimates[0]!.ShipAddr = { ...t.f.estimates[0]!.ShipAddr!, PostalCode: '94309' };
    expect((await t.app.inject({ url: url(handle), headers: hdr() })).json().changed).toBe(true);
  });

  it('without a handle only version and status are meaningful', async () => {
    expect((await t.app.inject({ url: url(), headers: hdr() })).json()).toMatchObject({ changed: false, status: 'closed' });
  });

  it('rejects another user, another company, an unknown handle (409) and another document (400)', async () => {
    const otherUser = await t.app.inject({ url: url(handle), headers: hdr({ 'x-biziship-user-id': 'u-2' }) });
    const otherCo = await t.app.inject({ url: url(handle), headers: hdr({ 'x-biziship-company-id': 'co-2' }) });
    const unknown = await t.app.inject({ url: url('hb_nope'), headers: hdr() });
    expect([otherUser.statusCode, otherCo.statusCode, unknown.statusCode]).toEqual([409, 409, 409]);
    expect(otherUser.json().error).toBe('handle_invalid');

    t.f.estimates.push({ ...estimate100(), Id: '101' });
    const wrongDoc = await t.app.inject({ url: url(handle, '101'), headers: hdr() });
    expect(wrongDoc.statusCode).toBe(400);
    expect(wrongDoc.json().error).toBe('handle_mismatch');
  });
});

describe('documents: list', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.connect();
    t.f.invoices = [
      invoice(1, '2026-10-01', 100), invoice(2, '2026-10-02', 0), invoice(3, '2026-10-03', 100),
      invoice(4, '2026-10-04', 40), invoice(5, '2026-10-05', 100),
    ];
  });
  const get = async (qs: string) => (await t.app.inject({ url: `/v1/quickbooks/documents?${qs}`, headers: hdr() })).json();

  it('lists open invoices newest first with status and version', async () => {
    const r = await get('type=invoice');
    expect(r.items.map((i: { id: string }) => i.id)).toEqual(['5', '4', '3', '1']); // paid #2 excluded
    expect(r.items[1]).toMatchObject({ status: 'partial', type: 'invoice', shipmentCount: 0, shipmentLinks: [] });
    expect(r.items[0].version).toMatch(/^v-/);
    expect(r.nextCursor).toBeNull();
  });

  it('pages with an opaque cursor without gaps or repeats', async () => {
    const p1 = await get('type=invoice&status=all&limit=2');
    expect(p1.items.map((i: { id: string }) => i.id)).toEqual(['5', '4']);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await get(`type=invoice&status=all&limit=2&cursor=${p1.nextCursor}`);
    expect(p2.items.map((i: { id: string }) => i.id)).toEqual(['3', '2']);
    const p3 = await get(`type=invoice&status=all&limit=2&cursor=${p2.nextCursor}`);
    expect(p3.items.map((i: { id: string }) => i.id)).toEqual(['1']);
    expect(p3.nextCursor).toBeNull();
  });

  it('merges estimates and invoices when no type is given', async () => {
    const r = await get('status=all&limit=100');
    expect(r.items.map((i: { type: string; id: string }) => `${i.type}:${i.id}`)).toEqual([
      'estimate:100', 'invoice:5', 'invoice:4', 'invoice:3', 'invoice:2', 'invoice:1',
    ]);
  });

  it('closed filter returns the closed estimate and paid invoice only', async () => {
    const r = await get('status=closed');
    expect(r.items.map((i: { type: string; id: string }) => `${i.type}:${i.id}`)).toEqual(['estimate:100', 'invoice:2']);
  });

  it('filters estimates by status in code and still pages without gaps, loops or repeats', async () => {
    // 120 closed estimates (newer) with 3 pending ones scattered among them.
    t.f.estimates = Array.from({ length: 120 }, (_, i) => ({
      ...estimate100(), Id: String(1000 + i), DocNumber: String(3000 + i),
      TxnDate: `2026-${String(12 - Math.floor(i / 30)).padStart(2, '0')}-${String(28 - (i % 28)).padStart(2, '0')}`,
      TxnStatus: [7, 61, 118].includes(i) ? 'Pending' : 'Closed',
    }));
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const r = await get(`type=estimate&status=open&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.items.map((i: { id: string }) => i.id));
      if (!r.nextCursor) break;
      expect(r.nextCursor).not.toBe(cursor); // the cursor always advances
      cursor = r.nextCursor;
    }
    expect([...seen].sort()).toEqual(['1007', '1061', '1118']);
    expect(new Set(seen).size).toBe(seen.length);
    expect(t.f.queries.some((s) => s.includes('TxnStatus'))).toBe(false); // never asks QuickBooks to filter by TxnStatus
  });

  it('searches by number or customer name (single page)', async () => {
    t.f.invoices.push(invoice(9, '2026-09-01', 100, 'Other Co', '8'));
    const byNumber = await get('type=invoice&status=all&q=2009');
    expect(byNumber.items.map((i: { id: string }) => i.id)).toContain('9');
    const byCustomer = await get('type=invoice&status=all&q=Cust');
    expect(byCustomer.items.every((i: { customerName: string }) => i.customerName === 'Cust A')).toBe(true);
    expect(byCustomer.nextCursor).toBeNull();
  });

  it('puts user text in escaped literals only', async () => {
    await get(`type=invoice&status=all&q=${encodeURIComponent("x' or Balance > '0")}`);
    const q = t.f.queries.find((s) => s.includes('DocNumber like'))!;
    expect(q).toContain("x\\' or Balance > \\'0");
  });

  it('rejects a bad cursor, an unknown status and an oversize limit', async () => {
    for (const qs of ['cursor=garbage', 'status=weird', 'limit=1000', 'limit=0']) {
      const res = await t.app.inject({ url: `/v1/quickbooks/documents?${qs}`, headers: hdr() });
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    }
  });
});

describe('documents: attachments', () => {
  let t: ReturnType<typeof setup>;
  const ref = (type: string, value: string) => [{ EntityRef: { type, value } }];
  beforeEach(async () => {
    t = setup();
    await t.connect();
    t.f.attachables = [
      { Id: 'a1', FileName: 'order.pdf', ContentType: 'application/pdf', Size: 20, AttachableRef: ref('Estimate', '100'), TempDownloadUri: 'https://files.example.com/a?n=20' },
      { Id: 'a2', Note: 'just a note', AttachableRef: ref('Estimate', '100') },
      { Id: 'a3', FileName: 'big.pdf', ContentType: 'application/pdf', Size: 5 * 1024 * 1024, AttachableRef: ref('Estimate', '100'), TempDownloadUri: 'https://files.example.com/b?n=10' },
      { Id: 'a4', FileName: 'other.pdf', ContentType: 'application/pdf', Size: 10, AttachableRef: ref('Invoice', '55'), TempDownloadUri: 'https://files.example.com/c?n=10' },
      { Id: 'a5', FileName: 'liar.pdf', ContentType: 'application/pdf', Size: 10, AttachableRef: ref('Estimate', '100'), TempDownloadUri: 'http://files.example.com/d?n=10' },
    ];
  });

  it('lists files only (notes are skipped)', async () => {
    const r = await t.app.inject({ url: '/v1/quickbooks/documents/100/attachments?type=estimate', headers: hdr() });
    expect(r.json().map((a: { id: string }) => a.id)).toEqual(['a1', 'a3', 'a5']);
    expect(r.json()[0]).toEqual({ id: 'a1', name: 'order.pdf', contentType: 'application/pdf', size: 20 });
  });

  it('downloads the bytes with the original content type', async () => {
    const r = await t.app.inject({ url: '/v1/quickbooks/documents/100/attachments/a1?type=estimate', headers: hdr() });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.rawPayload.length).toBe(20);
    expect(r.headers['content-disposition']).toContain("filename*=UTF-8''order.pdf");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves a type the web app cannot read as an opaque download, keeping the original type in a header', async () => {
    t.f.attachables.push({
      Id: 'a6', FileName: 'order.docx', ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      Size: 10, AttachableRef: ref('Estimate', '100'), TempDownloadUri: 'https://files.example.com/e?n=10',
    });
    const r = await t.app.inject({ url: '/v1/quickbooks/documents/100/attachments/a6?type=estimate', headers: hdr() });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['x-original-content-type']).toContain('wordprocessingml');
  });

  it('refuses files above 4 MB with 413', async () => {
    const r = await t.app.inject({ url: '/v1/quickbooks/documents/100/attachments/a3?type=estimate', headers: hdr() });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toBe('attachment_too_large');
  });

  it("never serves another document's file, and never fetches a non-https URL", async () => {
    const other = await t.app.inject({ url: '/v1/quickbooks/documents/100/attachments/a4?type=estimate', headers: hdr() });
    const http = await t.app.inject({ url: '/v1/quickbooks/documents/100/attachments/a5?type=estimate', headers: hdr() });
    expect(other.statusCode).toBe(404);
    expect(http.statusCode).toBe(404);
  });
});

describe('setup', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.connect();
  });

  it('is self-describing, with the origin prefilled from the ERP company address and the memo switch on', async () => {
    const r = (await t.app.inject({ url: '/v1/quickbooks/setup', headers: hdr({ 'x-biziship-role': 'USER' }) })).json();
    expect(r.fields.map((f: { key: string; type: string }) => [f.key, f.type])).toEqual([['defaultOrigin', 'address'], ['writeLinkToMemo', 'boolean']]);
    expect(r.values.writeLinkToMemo).toBe(true);
    expect(r.values.defaultOrigin).toMatchObject({ company: 'ACME Warehouse', line1: '12 Dock St' });
  });

  it('any booking role may change it, other roles get 403; changes persist and merge', async () => {
    const denied = await t.app.inject({ method: 'PUT', url: '/v1/quickbooks/setup', headers: hdr({ 'x-biziship-role': 'USER' }), payload: { values: { writeLinkToMemo: false } } });
    expect(denied.statusCode).toBe(403);
    const customer = await t.app.inject({ method: 'PUT', url: '/v1/quickbooks/setup', headers: hdr({ 'x-biziship-role': 'CUSTOMER' }), payload: { values: { writeLinkToMemo: true } } });
    expect(customer.statusCode).toBe(200);

    const ok = await t.app.inject({ method: 'PUT', url: '/v1/quickbooks/setup', headers: hdr(), payload: { values: { writeLinkToMemo: false } } });
    expect(ok.json().values.writeLinkToMemo).toBe(false);
    expect((await t.app.inject({ url: '/v1/quickbooks/setup', headers: hdr() })).json().values.writeLinkToMemo).toBe(false);
  });

  it('rejects unknown keys and keeps companies separate', async () => {
    const bad = await t.app.inject({ method: 'PUT', url: '/v1/quickbooks/setup', headers: hdr(), payload: { values: { writeLinkToMemoo: false } } });
    expect(bad.statusCode).toBe(400);

    await t.app.inject({ method: 'PUT', url: '/v1/quickbooks/setup', headers: hdr(), payload: { values: { writeLinkToMemo: false } } });
    const other = (await t.app.inject({ url: '/v1/quickbooks/setup', headers: hdr({ 'x-biziship-company-id': 'co-2' }) })).json();
    expect(other.values.writeLinkToMemo).toBe(true);
  });
});
