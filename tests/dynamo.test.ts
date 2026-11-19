import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DecryptCommand, EncryptCommand } from '@aws-sdk/client-kms';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  DynamoConnectionStore,
  DynamoHandleStore,
  DynamoNonceStore,
  DynamoSettingsStore,
} from '../src/store/dynamo.js';
import { hashHandle, type HandleRecord } from '../src/store/handles.js';
import type { Connection } from '../src/store/types.js';
import { TokenService } from '../src/tokens.js';
import type { OAuthProvider, TokenSet } from '../src/providers/types.js';

// ---- A tiny DynamoDB that really evaluates the expressions the stores use ----------------------
type Item = Record<string, unknown>;

function evalCondition(expr: string, item: Item | undefined, names: Record<string, string>, values: Record<string, unknown>): boolean {
  const attr = (a: string) => (a.startsWith('#') ? names[a]! : a);
  const val = (v: string) => (v.startsWith(':') ? values[v] : v);
  // Recursive descent over: OR > AND > ( ... ) | fn(x) | a op :v
  let pos = 0;
  const peek = () => expr.slice(pos).match(/^\s*(AND|OR|\(|\))/i)?.[1]?.toUpperCase();
  const eat = (re: RegExp) => {
    const m = expr.slice(pos).match(re);
    if (!m) throw new Error(`parse error at "${expr.slice(pos)}"`);
    pos += m[0].length;
    return m;
  };
  const parseOr = (): boolean => {
    let r = parseAnd();
    while (peek() === 'OR') {
      eat(/^\s*OR/i);
      const rhs = parseAnd();
      r = r || rhs;
    }
    return r;
  };
  const parseAnd = (): boolean => {
    let r = parseTerm();
    while (peek() === 'AND') {
      eat(/^\s*AND/i);
      const rhs = parseTerm();
      r = r && rhs;
    }
    return r;
  };
  const parseTerm = (): boolean => {
    if (peek() === '(') {
      eat(/^\s*\(/);
      const r = parseOr();
      eat(/^\s*\)/);
      return r;
    }
    const fn = expr.slice(pos).match(/^\s*(attribute_exists|attribute_not_exists)\(\s*([#\w]+)\s*\)/);
    if (fn) {
      pos += fn[0].length;
      const has = item !== undefined && item[attr(fn[2]!)] !== undefined;
      return fn[1] === 'attribute_exists' ? has : !has;
    }
    const m = eat(/^\s*([#\w]+)\s*(=|<|>)\s*(:\w+)/);
    const left = item?.[attr(m[1]!)] as number | string | undefined;
    const right = val(m[3]!) as number | string;
    if (left === undefined) return false;
    return m[2] === '=' ? left === right : m[2] === '<' ? left < right : left > right;
  };
  const r = parseOr();
  if (expr.slice(pos).trim()) throw new Error(`trailing: ${expr.slice(pos)}`);
  return r;
}

/** The subset of DynamoDB reserved words relevant here; the real service rejects them unaliased. */
const RESERVED = new Set(['blob', 'status', 'ttl', 'name', 'data', 'timestamp', 'key', 'value', 'role', 'user', 'type', 'size']);

/** Throws, like DynamoDB, if an expression uses a reserved word as a bare attribute name. */
function rejectReserved(expr: string | undefined): void {
  if (!expr) return;
  for (const word of expr.match(/(?<![#:\w])[A-Za-z_]\w*/g) ?? []) {
    if (RESERVED.has(word.toLowerCase())) {
      throw new Error(`Invalid expression: Attribute name is a reserved keyword; reserved keyword: ${word}`);
    }
  }
}

class FakeDdb {
  readonly rows = new Map<string, Item>();
  private k = (key: { pk: string; sk: string }) => `${key.pk}|${key.sk}`;

  async send(cmd: unknown): Promise<{ Item?: Item }> {
    if (cmd instanceof GetCommand) {
      const it = this.rows.get(this.k(cmd.input.Key as { pk: string; sk: string }));
      return { Item: it ? structuredClone(it) : undefined };
    }
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as Item;
      const key = this.k(item as { pk: string; sk: string });
      this.check(cmd.input.ConditionExpression, this.rows.get(key), cmd.input.ExpressionAttributeNames, cmd.input.ExpressionAttributeValues);
      this.rows.set(key, structuredClone(item));
      return {};
    }
    if (cmd instanceof DeleteCommand) {
      this.rows.delete(this.k(cmd.input.Key as { pk: string; sk: string }));
      return {};
    }
    if (cmd instanceof UpdateCommand) {
      const key = this.k(cmd.input.Key as { pk: string; sk: string });
      const cur = this.rows.get(key);
      const names = cmd.input.ExpressionAttributeNames ?? {};
      const values = cmd.input.ExpressionAttributeValues ?? {};
      rejectReserved(cmd.input.UpdateExpression);
      rejectReserved(cmd.input.ConditionExpression);
      this.check(cmd.input.ConditionExpression, cur, names, values);
      const next: Item = cur ? { ...cur } : { ...(cmd.input.Key as Item) };
      const expr = cmd.input.UpdateExpression!;
      const attr = (a: string) => (a.startsWith('#') ? names[a]! : a);
      if (expr.startsWith('SET ')) {
        for (const part of expr.slice(4).split(',')) {
          const [l, r] = part.split('=').map((s) => s.trim()) as [string, string];
          next[attr(l)] = values[r];
        }
      } else if (expr.startsWith('REMOVE ')) {
        for (const a of expr.slice(7).split(',')) delete next[attr(a.trim())];
      } else throw new Error(`unsupported update: ${expr}`);
      this.rows.set(key, next);
      return {};
    }
    throw new Error('unsupported command');
  }

  private check(cond: string | undefined, cur: Item | undefined, names?: Record<string, string>, values?: Record<string, unknown>) {
    if (cond && !evalCondition(cond, cur, names ?? {}, values ?? {})) {
      throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
    }
  }
}

/** A KMS that only decrypts when the encryption context matches, like the real one. */
class FakeKms {
  encryptCalls = 0;
  async send(cmd: unknown): Promise<unknown> {
    if (cmd instanceof EncryptCommand) {
      this.encryptCalls++;
      const body = JSON.stringify({ ctx: cmd.input.EncryptionContext, pt: Buffer.from(cmd.input.Plaintext as Uint8Array).toString('base64') });
      return { CiphertextBlob: Buffer.from(`enc:${body}`) };
    }
    if (cmd instanceof DecryptCommand) {
      const raw = Buffer.from(cmd.input.CiphertextBlob as Uint8Array).toString('utf8').replace(/^enc:/, '');
      const { ctx, pt } = JSON.parse(raw) as { ctx: unknown; pt: string };
      if (JSON.stringify(ctx) !== JSON.stringify(cmd.input.EncryptionContext)) throw new Error('InvalidCiphertextException');
      return { Plaintext: Buffer.from(pt, 'base64') };
    }
    throw new Error('unsupported kms command');
  }
}

const T0 = 1_000_000_000_000;
function make(now = () => T0) {
  const fake = new FakeDdb();
  const kms = new FakeKms();
  const deps = { ddb: fake as unknown as DynamoDBDocumentClient, table: 'hub', now };
  return { fake, kms, deps, conns: new DynamoConnectionStore(deps, kms as never, 'key-1') };
}

const conn = (over: Partial<Connection> = {}): Connection => ({
  provider: 'quickbooks', companyId: 'c1', realmId: 'r1', accessToken: 'ACCESS-SECRET', refreshToken: 'REFRESH-SECRET',
  accessExpiresAt: T0 + 3_600_000, refreshExpiresAt: T0 + 8_000_000_000, status: 'connected', connectedAt: T0, updatedAt: T0, ...over,
});

describe('DynamoConnectionStore', () => {
  it('round-trips a connection and never stores a token in clear', async () => {
    const { conns, fake } = make();
    await conns.put(conn());
    expect(await conns.get('quickbooks', 'c1')).toEqual(conn());
    const raw = JSON.stringify([...fake.rows.values()]);
    expect(raw).not.toContain('ACCESS-SECRET');
    expect(raw).not.toContain('REFRESH-SECRET');
    expect(await conns.get('quickbooks', 'other')).toBeNull();
  });

  it('a ciphertext copied to another company row cannot be decrypted', async () => {
    const { conns, fake } = make();
    await conns.put(conn());
    const row = fake.rows.get('CONN#quickbooks#c1|-')!;
    fake.rows.set('CONN#quickbooks#c2|-', { ...row, pk: 'CONN#quickbooks#c2' });
    await expect(conns.get('quickbooks', 'c2')).rejects.toThrow('InvalidCiphertextException');
  });

  it('delete removes the row', async () => {
    const { conns } = make();
    await conns.put(conn());
    await conns.delete('quickbooks', 'c1');
    expect(await conns.get('quickbooks', 'c1')).toBeNull();
  });

  it('lease: one holder at a time, expires, and cannot be taken for an unknown connection', async () => {
    let t = T0;
    const { conns } = make(() => t);
    expect(await conns.acquireRefreshLease('quickbooks', 'nobody', 30_000)).toBeNull();

    await conns.put(conn());
    const a = await conns.acquireRefreshLease('quickbooks', 'c1', 30_000);
    expect(a).toBeTruthy();
    expect(await conns.acquireRefreshLease('quickbooks', 'c1', 30_000)).toBeNull();

    await conns.releaseRefreshLease('quickbooks', 'c1', 'not-the-holder'); // must not free someone else's lease
    expect(await conns.acquireRefreshLease('quickbooks', 'c1', 30_000)).toBeNull();

    await conns.releaseRefreshLease('quickbooks', 'c1', a!);
    const b = await conns.acquireRefreshLease('quickbooks', 'c1', 30_000);
    expect(b).toBeTruthy();

    t += 31_000; // b's lease expires
    expect(await conns.acquireRefreshLease('quickbooks', 'c1', 30_000)).toBeTruthy();
  });

  it('saving the refreshed connection keeps the lease held by that very call', async () => {
    const { conns } = make();
    await conns.put(conn());
    await conns.acquireRefreshLease('quickbooks', 'c1', 30_000);
    await conns.put(conn({ accessToken: 'NEW', updatedAt: T0 + 1 }));
    expect(await conns.acquireRefreshLease('quickbooks', 'c1', 30_000)).toBeNull();
  });

  it('TokenService on two instances over this store refreshes the rotating token exactly once', async () => {
    const { conns } = make(() => T0);
    await conns.put(conn({ accessExpiresAt: T0 }));
    let calls = 0;
    const oauth: OAuthProvider = {
      buildAuthUrl: () => '', exchangeCode: async () => { throw new Error('x'); }, revoke: async () => {},
      refresh: async (): Promise<TokenSet> => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return { accessToken: 'ACCESS-2', refreshToken: 'REFRESH-2', accessExpiresAt: T0 + 36_000_000, refreshExpiresAt: T0 + 8_000_000_000 };
      },
    };
    const sleep = () => new Promise<void>((r) => setTimeout(r, 5));
    const a = new TokenService(conns, () => oauth, { now: () => T0, sleep });
    const b = new TokenService(conns, () => oauth, { now: () => T0, sleep });
    const [ra, rb] = await Promise.all([a.getAccess('quickbooks', 'c1'), b.getAccess('quickbooks', 'c1')]);
    expect(calls).toBe(1);
    expect([ra.accessToken, rb.accessToken]).toEqual(['ACCESS-2', 'ACCESS-2']);
    expect((await conns.get('quickbooks', 'c1'))!.refreshToken).toBe('REFRESH-2');
  });
});

const rec = (over: Partial<HandleRecord> = {}): HandleRecord => ({
  hash: hashHandle('hb_x'), companyId: 'c1', userId: 'u1', provider: 'quickbooks', realmId: 'r1', docType: 'invoice', docId: '130',
  version: 'v-1', createdAt: T0, expiresAt: T0 + 86_400_000, ...over,
});

describe('DynamoHandleStore', () => {
  it('stores and returns a record without internal keys; expired handles are gone even before DynamoDB deletes them', async () => {
    let t = T0;
    const { deps } = make(() => t);
    const s = new DynamoHandleStore(deps);
    await s.put(rec());
    expect(await s.get(rec().hash)).toEqual(rec());
    t = T0 + 86_400_001;
    expect(await s.get(rec().hash)).toBeNull();
  });

  it('binds to the FIRST shipment only (atomic), same shipment is a retry, another is refused', async () => {
    const { deps } = make();
    const s = new DynamoHandleStore(deps);
    await s.put(rec());
    expect(await s.bindShipment(rec().hash, 'ship-1')).toBe('bound');
    expect(await s.bindShipment(rec().hash, 'ship-1')).toBe('same');
    expect(await s.bindShipment(rec().hash, 'ship-2')).toBe('other');
    expect(await s.bindShipment('unknown', 'ship-1')).toBe('missing');
  });

  it('two concurrent bookings on one handle: exactly one wins', async () => {
    const { deps } = make();
    const s = new DynamoHandleStore(deps);
    await s.put(rec());
    const r = await Promise.all([s.bindShipment(rec().hash, 'A'), s.bindShipment(rec().hash, 'B')]);
    expect(r.filter((x) => x === 'bound')).toHaveLength(1);
    expect(r.filter((x) => x === 'other')).toHaveLength(1);
  });

  it('an expired handle cannot be bound', async () => {
    let t = T0;
    const { deps } = make(() => t);
    const s = new DynamoHandleStore(deps);
    await s.put(rec());
    t = T0 + 86_400_001;
    expect(await s.bindShipment(rec().hash, 'ship-1')).toBe('missing');
  });
});

describe('DynamoSettingsStore and DynamoNonceStore', () => {
  it('settings default to memo-on and persist per company', async () => {
    const { deps } = make();
    const s = new DynamoSettingsStore(deps);
    expect(await s.get('quickbooks', 'c1')).toEqual({ writeLinkToMemo: true });
    await s.put('quickbooks', 'c1', { writeLinkToMemo: false, defaultOrigin: { city: 'Reno' } });
    expect(await s.get('quickbooks', 'c1')).toEqual({ writeLinkToMemo: false, defaultOrigin: { city: 'Reno' } });
    expect(await s.get('quickbooks', 'c2')).toEqual({ writeLinkToMemo: true });
  });

  it('a nonce can be consumed once, even by concurrent callbacks', async () => {
    const { deps } = make();
    const n = new DynamoNonceStore(deps);
    const r = await Promise.all([n.consume('abc', T0 + 600_000), n.consume('abc', T0 + 600_000)]);
    expect(r.sort()).toEqual([false, true]);
    expect(await n.consume('abc', T0 + 600_000)).toBe(false);
    expect(await n.consume('def', T0 + 600_000)).toBe(true);
  });
});
