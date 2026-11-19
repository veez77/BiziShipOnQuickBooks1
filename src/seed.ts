import type { Address, AttachmentInfo, ErpDocument, LinkedDocument } from './providers/documents.js';

/** The shipment seed the web app pre-fills the quote form from (contract v1 §8). */

export type Origin = 'erp' | 'document-ai' | 'memory' | 'default' | 'user';

export interface Field<T> {
  value: T | null;
  origin: Origin;
  confidence?: number;
  /** Present when the customer's document overrode the ERP value. */
  conflict?: { erpValue: T | null; reason?: string };
}

export interface CargoLine {
  packagingType?: string;
  pallets?: number;
  weightPerPallet?: number;
  length?: number;
  width?: number;
  height?: number;
  description?: string;
  freightClass?: string;
  nmfc?: string;
  hazmat?: boolean;
}

export interface ShipmentLinkRef {
  shipmentId: string;
  linkStatus: string;
}

export interface ShipmentSeed {
  contextHandle: string;
  source: {
    provider: string;
    docType: string;
    id: string;
    number?: string;
    /** "<realmId>:<docType>:<docId>"; sent to the core as source_ref exactly as given. */
    ref: string;
    version: string;
    status: string;
    linkedDocuments?: LinkedDocument[];
  };
  customer: { name?: string; email?: string; phone?: string };
  origin: Field<Address>;
  destination: Field<Address>;
  cargo: Field<CargoLine[]>;
  accessorials: Field<string[]>;
  instructions: Field<string>;
  references: { po?: Field<string>; salesOrder?: Field<string>; reference?: Field<string> };
  lines: {
    id: string;
    itemId?: string;
    description?: string;
    qty?: number;
    unitPrice?: number;
    amount?: number;
    physicalHint: 'likely' | 'unlikely' | 'unknown';
    ship: boolean;
  }[];
  shipmentLinks: ShipmentLinkRef[];
  shipmentCount: number;
  attachments: AttachmentInfo[];
  warnings: { code: string; message: string }[];
}

export interface SeedInput {
  provider: string;
  doc: ErpDocument;
  attachments: AttachmentInfo[];
  /** Pickup address from the company's setup (origin "default") or, failing that, the ERP company address (origin "erp"). */
  origin: { address?: Address; origin: 'default' | 'erp' };
  handle: string;
  shipmentLinks: ShipmentLinkRef[];
}

/**
 * Until customer-document parsing exists the seed carries ERP data plus the default origin;
 * fields that only the document can fill (cargo, accessorials, instructions) are empty with origin "default".
 */
export function buildSeed(i: SeedInput): ShipmentSeed {
  const { doc } = i;
  const warnings: ShipmentSeed['warnings'] = [];

  if (!doc.shipTo) warnings.push({ code: 'missing_ship_to', message: 'The document has no ship-to address.' });
  if (doc.status === 'closed') warnings.push({ code: 'document_closed', message: 'This document is closed in the ERP.' });
  if (!doc.lines.some((l) => l.physicalHint === 'likely')) {
    warnings.push({ code: 'no_physical_lines', message: 'No line looks like physical goods; check what ships.' });
  }

  return {
    contextHandle: i.handle,
    source: {
      provider: i.provider,
      docType: doc.type,
      id: doc.id,
      number: doc.number,
      ref: `${doc.realmId}:${doc.type}:${doc.id}`,
      version: doc.version,
      status: doc.status,
      linkedDocuments: doc.linkedDocuments.length ? doc.linkedDocuments : undefined,
    },
    customer: { name: doc.customerName, email: doc.customerEmail, phone: doc.customerPhone },
    origin: { value: i.origin.address ?? null, origin: i.origin.address ? i.origin.origin : 'default' },
    destination: { value: doc.shipTo ?? null, origin: doc.shipTo ? 'erp' : 'default' },
    cargo: { value: null, origin: 'default' },
    accessorials: { value: null, origin: 'default' },
    instructions: { value: null, origin: 'default' },
    references: {
      ...(doc.poNumber ? { po: { value: doc.poNumber, origin: 'erp' as const } } : {}),
      ...(doc.number ? { salesOrder: { value: doc.number, origin: 'erp' as const } } : {}),
    },
    lines: doc.lines.map((l) => ({ ...l, ship: l.physicalHint === 'likely' })),
    shipmentLinks: i.shipmentLinks,
    shipmentCount: i.shipmentLinks.length,
    attachments: i.attachments,
    warnings,
  };
}
