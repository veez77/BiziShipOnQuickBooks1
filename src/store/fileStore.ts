import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decrypt, encrypt } from '../crypto.js';
import type { Connection, ConnectionStore, ProviderId } from './types.js';

interface FileShape {
  version: 1;
  /** storage key -> encrypted Connection JSON */
  connections: Record<string, string>;
}

/**
 * LOCAL DEVELOPMENT STORE: one encrypted JSON file (default .data/connections.json).
 * Every connection is AES-256-GCM encrypted with its storage key as AAD.
 * Production uses a database implementation of the same ConnectionStore interface
 * (Postgres or DynamoDB — decided in a later phase); the rest of the code does not change.
 */
export class FileConnectionStore implements ConnectionStore {
  private readonly path: string;
  /** Serialises writes so concurrent put() calls cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly key: Buffer,
  ) {
    this.path = join(dataDir, 'connections.json');
  }

  private storageKey = (p: ProviderId, c: string) => `${p}:${c}`;

  private async read(): Promise<FileShape> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as FileShape;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, connections: {} };
      throw err;
    }
  }

  private async write(shape: FileShape): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(shape, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.path); // atomic replace: a crash never leaves a half-written file
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async get(provider: ProviderId, companyId: string): Promise<Connection | null> {
    const k = this.storageKey(provider, companyId);
    const shape = await this.enqueue(() => this.read());
    const blob = shape.connections[k];
    return blob ? (JSON.parse(decrypt(blob, this.key, k)) as Connection) : null;
  }

  async put(connection: Connection): Promise<void> {
    const k = this.storageKey(connection.provider, connection.companyId);
    await this.enqueue(async () => {
      const shape = await this.read();
      shape.connections[k] = encrypt(JSON.stringify(connection), this.key, k);
      await this.write(shape);
    });
  }

  async delete(provider: ProviderId, companyId: string): Promise<void> {
    const k = this.storageKey(provider, companyId);
    await this.enqueue(async () => {
      const shape = await this.read();
      delete shape.connections[k];
      await this.write(shape);
    });
  }
}
