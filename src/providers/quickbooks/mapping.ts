import { createHash } from 'node:crypto';
import type { Address, DocLine, DocumentSummaryCore, ErpDocument, LinkedDocument } from '../documents.js';

/** Pure mapping from QuickBooks JSON to the provider-neutral document shapes. */

interface QAddr {
  Line1?: string;
  Line2?: string;
  Line3?: string;
  Line4?: string;
  Line5?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
}

interface QLine {
  Id?: string;
  Description?: string;
  Amount?: number;
  DetailType?: string;
  SalesItemLineDetail?: { ItemRef?: { value?: string }; Qty?: number; UnitPrice?: number };
}

export interface QDoc {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TxnStatus?: string;
  TotalAmt?: number;
  Balance?: number;
  CurrencyRef?: { value?: string };
  CustomerRef?: { value?: string; name?: string };
  BillEmail?: { Address?: string };
  ShipAddr?: QAddr;
  Line?: QLine[];
  LinkedTxn?: { TxnId?: string; TxnType?: string }[];
  CustomField?: { Name?: string; StringValue?: string }[];
}

export type Entity = 'Estimate' | 'Invoice';

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export const typeOf = (e: Entity): string => e.toLowerCase();
export const entityOf = (t: string): Entity | null => (t === 'estimate' ? 'Estimate' : t === 'invoice' ? 'Invoice' : null);

export function normalizeStatus(entity: Entity, d: QDoc): string {
  if (entity === 'Estimate') {
    switch (d.TxnStatus) {
      case 'Pending':
      case 'Accepted':
        return 'open';
      case 'Closed':
      case 'Rejected':
        return 'closed';
      default:
        return 'unknown';
    }
  }
  const total = num(d.TotalAmt);
  const balance = num(d.Balance);
  if (total === undefined || balance === undefined) return 'unknown';
  if (total > 0 && balance === 0) return 'paid';
  if (balance > 0 && balance < total) return 'partial';
  if (balance > 0) return 'open';
  return 'unknown';
}

/** QuickBooks ship-to is free-text lines. A first line without digits followed by more lines is a name, not a street. */
export function mapAddress(a: QAddr | undefined): Address | undefined {
  if (!a) return undefined;
  const lines = [a.Line1, a.Line2, a.Line3, a.Line4, a.Line5].map(str).filter((l): l is string => !!l);
  const out: Address = {};
  if (lines.length >= 2 && !/\d/.test(lines[0]!)) {
    out.company = lines[0];
    out.line1 = lines[1];
    if (lines[2]) out.line2 = lines.slice(2).join(', ');
  } else {
    out.line1 = lines[0];
    if (lines[1]) out.line2 = lines.slice(1).join(', ');
  }
  out.city = str(a.City);
  out.state = str(a.CountrySubDivisionCode);
  out.zip = str(a.PostalCode);
  out.country = str(a.Country) ?? (out.zip && /^\d{5}(-\d{4})?$/.test(out.zip) ? 'US' : undefined);
  const cleaned = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Address;
  return Object.keys(cleaned).length ? cleaned : undefined;
}

export function mapLinked(entity: Entity, d: QDoc): LinkedDocument[] {
  const out: LinkedDocument[] = [];
  for (const l of d.LinkedTxn ?? []) {
    const t = str(l.TxnType)?.toLowerCase();
    const id = str(l.TxnId);
    if (id && (t === 'invoice' || t === 'estimate') && t !== typeOf(entity)) out.push({ type: t, id });
  }
  return out;
}

export function poNumber(d: QDoc): string | undefined {
  for (const f of d.CustomField ?? []) {
    if (f.Name && /^(p\.?\s?o\.?(\s|$)|purchase order)/i.test(f.Name.trim())) return str(f.StringValue);
  }
  return undefined;
}

/** Items of these QuickBooks types are physical goods. */
export const physicalHintFor = (itemType: string | undefined): DocLine['physicalHint'] =>
  itemType === 'Inventory' || itemType === 'NonInventory'
    ? 'likely'
    : itemType === 'Service'
      ? 'unlikely'
      : 'unknown';

export function mapLines(d: QDoc, itemTypes: Map<string, string> = new Map()): DocLine[] {
  const out: DocLine[] = [];
  (d.Line ?? []).forEach((l, i) => {
    if (l.DetailType !== 'SalesItemLineDetail') return; // skip subtotal, discount and description-only lines
    const itemId = str(l.SalesItemLineDetail?.ItemRef?.value);
    out.push({
      id: str(l.Id) ?? String(i + 1),
      itemId,
      description: str(l.Description),
      qty: num(l.SalesItemLineDetail?.Qty),
      unitPrice: num(l.SalesItemLineDetail?.UnitPrice),
      amount: num(l.Amount),
      physicalHint: physicalHintFor(itemId ? itemTypes.get(itemId) : undefined),
    });
  });
  return out;
}

export function itemIdsOf(d: QDoc): string[] {
  const ids = new Set<string>();
  for (const l of d.Line ?? []) {
    const id = str(l.SalesItemLineDetail?.ItemRef?.value);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * The version covers only what matters for a shipment (number, status, ship-to, goods, links,
 * PO). It deliberately ignores SyncToken, memo and timestamps, so the Hub's own memo write
 * never makes a document look "changed".
 */
export function documentVersion(entity: Entity, d: QDoc): string {
  const material = {
    t: entity,
    n: d.DocNumber ?? null,
    s: normalizeStatus(entity, d),
    to: mapAddress(d.ShipAddr) ?? null,
    l: (d.Line ?? [])
      .filter((l) => l.DetailType === 'SalesItemLineDetail')
      .map((l) => [l.Id ?? null, l.SalesItemLineDetail?.ItemRef?.value ?? null, l.Description ?? null, l.SalesItemLineDetail?.Qty ?? null, l.Amount ?? null]),
    k: mapLinked(entity, d).map((x) => `${x.type}:${x.id}`).sort(),
    po: poNumber(d) ?? null,
  };
  return `v-${createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16)}`;
}

export function toSummary(entity: Entity, d: QDoc): DocumentSummaryCore {
  return {
    id: d.Id,
    type: typeOf(entity),
    number: str(d.DocNumber),
    date: str(d.TxnDate),
    customerName: str(d.CustomerRef?.name),
    total: num(d.TotalAmt),
    currency: str(d.CurrencyRef?.value),
    status: normalizeStatus(entity, d),
    version: documentVersion(entity, d),
    linkedDocuments: mapLinked(entity, d),
  };
}

export function toDocument(entity: Entity, d: QDoc, realmId: string, itemTypes: Map<string, string>): ErpDocument {
  return {
    ...toSummary(entity, d),
    realmId,
    customerEmail: str(d.BillEmail?.Address),
    shipTo: mapAddress(d.ShipAddr),
    poNumber: poNumber(d),
    lines: mapLines(d, itemTypes),
  };
}

/** Escapes a value for use inside a QuickBooks query string literal. */
export const qboLiteral = (s: string): string => s.replace(/[\u0000-\u001f]/g, ' ').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
