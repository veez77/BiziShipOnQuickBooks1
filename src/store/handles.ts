import { createHash, randomBytes } from 'node:crypto';
import type { ProviderId } from './types.js';

/**
 * Context handle (contract v1 §6): an opaque 256-bit random token the web app carries from the
 * document seed through quote and booking. Only its SHA-256 hash is stored, so a leaked database
 * does not leak usable handles. The write target (which ERP document) comes only from this record.
 */
export const HANDLE_TTL_MS = 24 * 60 * 60 * 1000;

export interface HandleRecord {
  /** SHA-256 of the handle (hex). The handle itself is never stored. */
  hash: string;
  companyId: string;
  userId: string;
  provider: ProviderId;
  realmId: string;
  docType: string;
  docId: string;
  docNumber?: string;
  /** Document version at seed time. */
  version: string;
  createdAt: number;
  expiresAt: number;
  /** Set by the first booking that uses this handle. */
  shipmentId?: string;
}

export const newHandle = (): string => `hb_${randomBytes(32).toString('base64url')}`;
export const hashHandle = (handle: string): string => createHash('sha256').update(handle, 'utf8').digest('hex');

export type BindResult = 'bound' | 'same' | 'other' | 'missing';

export interface HandleStore {
  put(record: HandleRecord): Promise<void>;
  /** Returns the record, or null if unknown or expired. */
  get(hash: string): Promise<HandleRecord | null>;
  /**
   * Atomically binds the handle to its first shipment. `bound`: first use; `same`: already bound
   * to this shipment (a retry); `other`: bound to a different shipment; `missing`: unknown/expired.
   */
  bindShipment(hash: string, shipmentId: string): Promise<BindResult>;
}

export class MemoryHandleStore implements HandleStore {
  private readonly records = new Map<string, HandleRecord>();
  constructor(private readonly now: () => number = Date.now) {}

  async put(record: HandleRecord): Promise<void> {
    this.sweep();
    this.records.set(record.hash, { ...record });
  }

  async get(hash: string): Promise<HandleRecord | null> {
    const r = this.records.get(hash);
    if (!r || r.expiresAt <= this.now()) return null;
    return { ...r };
  }

  async bindShipment(hash: string, shipmentId: string): Promise<BindResult> {
    const r = this.records.get(hash);
    if (!r || r.expiresAt <= this.now()) return 'missing';
    if (r.shipmentId === undefined) {
      r.shipmentId = shipmentId;
      return 'bound';
    }
    return r.shipmentId === shipmentId ? 'same' : 'other';
  }

  private sweep(): void {
    const t = this.now();
    for (const [h, r] of this.records) if (r.expiresAt <= t) this.records.delete(h);
  }
}
