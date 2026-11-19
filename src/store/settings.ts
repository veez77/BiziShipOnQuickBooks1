import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Address } from '../providers/documents.js';
import type { ProviderId } from './types.js';

/** Per-company, per-provider setup (contract v1 §4). */
export interface CompanySetup {
  defaultOrigin?: Address;
  writeLinkToMemo: boolean;
}

export const DEFAULT_SETUP: CompanySetup = { writeLinkToMemo: true };

const short = (n: number) => z.string().trim().max(n).optional();
const addressSchema = z
  .object({
    company: short(120),
    line1: short(120),
    line2: short(120),
    city: short(80),
    state: short(40),
    zip: short(20),
    country: short(2),
    contactName: short(120),
    phone: short(40),
    email: short(200),
    residential: z.boolean().optional(),
  })
  .strict();

/** The values a PUT may carry. Unknown keys are rejected so a typo never silently does nothing. */
export const setupUpdateSchema = z
  .object({
    values: z
      .object({
        defaultOrigin: addressSchema.nullable().optional(),
        writeLinkToMemo: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export interface SettingsStore {
  get(provider: ProviderId, companyId: string): Promise<CompanySetup>;
  put(provider: ProviderId, companyId: string, setup: CompanySetup): Promise<void>;
}

export class MemorySettingsStore implements SettingsStore {
  private readonly m = new Map<string, CompanySetup>();
  async get(provider: ProviderId, companyId: string) {
    return { ...DEFAULT_SETUP, ...(this.m.get(`${provider}:${companyId}`) ?? {}) };
  }
  async put(provider: ProviderId, companyId: string, setup: CompanySetup) {
    this.m.set(`${provider}:${companyId}`, { ...setup });
  }
}

/** LOCAL DEVELOPMENT: a JSON file (.data/settings.json). Production uses a DynamoDB implementation. */
export class FileSettingsStore implements SettingsStore {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) {
    this.path = join(dataDir, 'settings.json');
  }

  private async read(): Promise<Record<string, CompanySetup>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, CompanySetup>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  async get(provider: ProviderId, companyId: string): Promise<CompanySetup> {
    const all = await this.read();
    return { ...DEFAULT_SETUP, ...(all[`${provider}:${companyId}`] ?? {}) };
  }

  async put(provider: ProviderId, companyId: string, setup: CompanySetup): Promise<void> {
    const run = this.queue.then(async () => {
      const all = await this.read();
      all[`${provider}:${companyId}`] = setup;
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.queue = run.catch(() => undefined);
    await run;
  }
}
