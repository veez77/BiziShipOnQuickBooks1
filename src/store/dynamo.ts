import { DecryptCommand, EncryptCommand, type KMSClient } from '@aws-sdk/client-kms';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import type { NonceStore } from '../state.js';
import { DEFAULT_SETUP, type CompanySetup, type SettingsStore } from './settings.js';
import type { BindResult, HandleRecord, HandleStore } from './handles.js';
import type { Connection, ConnectionStore, ProviderId } from './types.js';

/**
 * Production stores on ONE DynamoDB table (on-demand, TTL attribute `ttl`), keys `pk` (hash) and `sk` (range).
 *   CONN#<provider>#<company>   the ERP connection; tokens are encrypted with KMS (never stored in clear)
 *   HANDLE#<sha256>             context handles (24 h)
 *   SETUP#<provider>#<company>  per-company setup
 *   NONCE#<nonce>               one-time OAuth state
 * Writes that must be atomic use conditional expressions, so several Lambda instances can share the table safely.
 */

export interface DynamoDeps {
  ddb: DynamoDBDocumentClient;
  table: string;
  now?: () => number;
}

const SK = '-';
const isConditionFailure = (e: unknown) => e instanceof ConditionalCheckFailedException || (e as { name?: string })?.name === 'ConditionalCheckFailedException';
const epochSeconds = (ms: number) => Math.floor(ms / 1000);
/** DynamoDB deletes expired items lazily (up to ~48 h later), so every read also checks expiry itself. */
const TTL_GRACE_S = 3600;

// ---- Connections (KMS-encrypted) ---------------------------------------------------------------
export class DynamoConnectionStore implements ConnectionStore {
  private readonly now: () => number;
  constructor(
    private readonly d: DynamoDeps,
    private readonly kms: Pick<KMSClient, 'send'>,
    private readonly keyId: string,
  ) {
    this.now = d.now ?? Date.now;
  }

  private pk = (p: ProviderId, c: string) => `CONN#${p}#${c}`;
  /** Binds the ciphertext to this exact connection, so a blob copied to another row cannot be decrypted. */
  private ctx = (p: ProviderId, c: string) => ({ purpose: 'erp-connection', provider: p, companyId: c });

  async get(provider: ProviderId, companyId: string): Promise<Connection | null> {
    const r = await this.d.ddb.send(new GetCommand({ TableName: this.d.table, Key: { pk: this.pk(provider, companyId), sk: SK }, ConsistentRead: true }));
    const blob = r.Item?.['blob'] as string | undefined;
    if (!blob) return null;
    const out = await this.kms.send(
      new DecryptCommand({ CiphertextBlob: Buffer.from(blob, 'base64'), EncryptionContext: this.ctx(provider, companyId), KeyId: this.keyId }),
    );
    return JSON.parse(Buffer.from(out.Plaintext as Uint8Array).toString('utf8')) as Connection;
  }

  async put(c: Connection): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(c), 'utf8');
    if (plaintext.length > 4000) throw new Error('Connection record too large for direct KMS encryption');
    const enc = await this.kms.send(
      new EncryptCommand({ KeyId: this.keyId, Plaintext: plaintext, EncryptionContext: this.ctx(c.provider, c.companyId) }),
    );
    // UPDATE (not put): keeps a refresh lease held by this very call intact.
    await this.d.ddb.send(
      new UpdateCommand({
        TableName: this.d.table,
        Key: { pk: this.pk(c.provider, c.companyId), sk: SK },
        // "blob" and "status" are DynamoDB reserved words, so both go through name aliases.
        UpdateExpression: 'SET #bl = :b, #st = :s, realmId = :r, updatedAt = :u',
        ExpressionAttributeNames: { '#bl': 'blob', '#st': 'status' },
        ExpressionAttributeValues: {
          ':b': Buffer.from(enc.CiphertextBlob as Uint8Array).toString('base64'),
          ':s': c.status,
          ':r': c.realmId,
          ':u': c.updatedAt,
        },
      }),
    );
  }

  async delete(provider: ProviderId, companyId: string): Promise<void> {
    await this.d.ddb.send(new DeleteCommand({ TableName: this.d.table, Key: { pk: this.pk(provider, companyId), sk: SK } }));
  }

  async acquireRefreshLease(provider: ProviderId, companyId: string, ttlMs: number): Promise<string | null> {
    const id = randomUUID();
    const now = this.now();
    try {
      await this.d.ddb.send(
        new UpdateCommand({
          TableName: this.d.table,
          Key: { pk: this.pk(provider, companyId), sk: SK },
          UpdateExpression: 'SET leaseId = :id, leaseUntil = :until',
          // Only an existing connection can be leased, and only if no unexpired lease is held.
          ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
          ExpressionAttributeValues: { ':id': id, ':until': now + ttlMs, ':now': now },
        }),
      );
      return id;
    } catch (e) {
      if (isConditionFailure(e)) return null;
      throw e;
    }
  }

  async releaseRefreshLease(provider: ProviderId, companyId: string, lease: string): Promise<void> {
    try {
      await this.d.ddb.send(
        new UpdateCommand({
          TableName: this.d.table,
          Key: { pk: this.pk(provider, companyId), sk: SK },
          UpdateExpression: 'REMOVE leaseId, leaseUntil',
          ConditionExpression: 'leaseId = :id',
          ExpressionAttributeValues: { ':id': lease },
        }),
      );
    } catch (e) {
      if (!isConditionFailure(e)) throw e; // someone else took over after our lease expired: nothing to release
    }
  }
}

// ---- Context handles ---------------------------------------------------------------------------------
export class DynamoHandleStore implements HandleStore {
  private readonly now: () => number;
  constructor(private readonly d: DynamoDeps) {
    this.now = d.now ?? Date.now;
  }
  private key = (hash: string) => ({ pk: `HANDLE#${hash}`, sk: SK });

  async put(r: HandleRecord): Promise<void> {
    await this.d.ddb.send(
      new PutCommand({ TableName: this.d.table, Item: { ...this.key(r.hash), ...r, ttl: epochSeconds(r.expiresAt) + TTL_GRACE_S } }),
    );
  }

  async get(hash: string): Promise<HandleRecord | null> {
    const r = await this.d.ddb.send(new GetCommand({ TableName: this.d.table, Key: this.key(hash), ConsistentRead: true }));
    const it = r.Item as (HandleRecord & { pk?: string; sk?: string; ttl?: number }) | undefined;
    if (!it || it.expiresAt <= this.now()) return null;
    const { pk: _pk, sk: _sk, ttl: _ttl, ...rec } = it;
    return rec;
  }

  async bindShipment(hash: string, shipmentId: string): Promise<BindResult> {
    try {
      await this.d.ddb.send(
        new UpdateCommand({
          TableName: this.d.table,
          Key: this.key(hash),
          UpdateExpression: 'SET shipmentId = :s',
          // First use wins, atomically; an expired handle can no longer be bound.
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(shipmentId) AND expiresAt > :now',
          ExpressionAttributeValues: { ':s': shipmentId, ':now': this.now() },
        }),
      );
      return 'bound';
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      const cur = await this.get(hash);
      if (!cur) return 'missing';
      return cur.shipmentId === shipmentId ? 'same' : 'other';
    }
  }
}

// ---- Setup ---------------------------------------------------------------------------------------------
export class DynamoSettingsStore implements SettingsStore {
  constructor(private readonly d: DynamoDeps) {}
  private key = (p: ProviderId, c: string) => ({ pk: `SETUP#${p}#${c}`, sk: SK });

  async get(provider: ProviderId, companyId: string): Promise<CompanySetup> {
    const r = await this.d.ddb.send(new GetCommand({ TableName: this.d.table, Key: this.key(provider, companyId), ConsistentRead: true }));
    return { ...DEFAULT_SETUP, ...((r.Item?.['setup'] as Partial<CompanySetup> | undefined) ?? {}) };
  }

  async put(provider: ProviderId, companyId: string, setup: CompanySetup): Promise<void> {
    await this.d.ddb.send(new PutCommand({ TableName: this.d.table, Item: { ...this.key(provider, companyId), setup } }));
  }
}

// ---- One-time OAuth state ---------------------------------------------------------------------------------
export class DynamoNonceStore implements NonceStore {
  constructor(private readonly d: DynamoDeps) {}

  async consume(nonce: string, exp: number): Promise<boolean> {
    try {
      await this.d.ddb.send(
        new PutCommand({
          TableName: this.d.table,
          Item: { pk: `NONCE#${nonce}`, sk: SK, ttl: epochSeconds(exp) + TTL_GRACE_S },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }
}
