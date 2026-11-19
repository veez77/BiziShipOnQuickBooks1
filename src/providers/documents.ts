/**
 * Provider-neutral view of an ERP document (contract v1 §5, §8). Every ERP provider
 * (QuickBooks now, Sage later) maps its own entities into these shapes; the seed builder,
 * the handle logic and the HTTP routes only ever see these.
 */

export interface Address {
  company?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  residential?: boolean;
}

export interface LinkedDocument {
  type: string;
  id: string;
}

export interface DocLine {
  id: string;
  itemId?: string;
  description?: string;
  qty?: number;
  unitPrice?: number;
  amount?: number;
  physicalHint: 'likely' | 'unlikely' | 'unknown';
}

/** What a document list row carries (the route adds the shipment links). */
export interface DocumentSummaryCore {
  id: string;
  type: string;
  number?: string;
  date?: string;
  customerName?: string;
  total?: number;
  currency?: string;
  /** Normalised: open | partial | paid | closed | unknown */
  status: string;
  /** Opaque; changes only when something that matters for a shipment changes. */
  version: string;
  linkedDocuments: LinkedDocument[];
}

/** A full document: everything needed to build a shipment seed. */
export interface ErpDocument extends DocumentSummaryCore {
  realmId: string;
  customerEmail?: string;
  customerPhone?: string;
  shipTo?: Address;
  poNumber?: string;
  lines: DocLine[];
}

export interface AttachmentInfo {
  id: string;
  name: string;
  contentType?: string;
  size?: number;
}

export interface DocumentListQuery {
  /** Provider document type, or undefined for all supported types. */
  type?: string;
  status: 'open' | 'paid' | 'closed' | 'all';
  q?: string;
  cursor?: string;
  limit: number;
}

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export class DocumentNotFoundError extends Error {
  constructor() {
    super('Document not found in the ERP');
    this.name = 'DocumentNotFoundError';
  }
}
export class AttachmentTooLargeError extends Error {
  constructor() {
    super('Attachment is larger than the 4 MB limit');
    this.name = 'AttachmentTooLargeError';
  }
}
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

/** Runs an ERP call with a valid access token for the company (refreshing it when needed). */
export type AccessRunner = <T>(
  companyId: string,
  fn: (a: { accessToken: string; realmId: string }) => Promise<T>,
) => Promise<T>;

export interface ErpDocuments {
  list(companyId: string, q: DocumentListQuery): Promise<{ items: DocumentSummaryCore[]; nextCursor: string | null }>;
  get(companyId: string, type: string, id: string): Promise<ErpDocument>;
  attachments(companyId: string, type: string, id: string): Promise<AttachmentInfo[]>;
  attachment(
    companyId: string,
    type: string,
    id: string,
    attachmentId: string,
  ): Promise<{ name: string; contentType: string; data: Buffer }>;
  /** The company's own address in the ERP, used to prefill the default pickup address. */
  companyAddress(companyId: string): Promise<Address | undefined>;
}
