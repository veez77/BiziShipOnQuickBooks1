import 'dotenv/config';
import { z } from 'zod';

const key32 = z
  .string()
  .min(1)
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64-encoded');

const schema = z.object({
  QBO_CLIENT_ID: z.string().min(1),
  QBO_CLIENT_SECRET: z.string().min(1),
  QBO_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  QBO_REDIRECT_URI: z.string().url(),
  QBO_MINOR_VERSION: z.coerce.number().int().positive().default(75),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  // "shared-secret": the BiziShip web app server sends X-ERP-Hub-Key + caller headers (contract v1 §1).
  // "dev": a fixed company with the ADMIN role and no key. Local development only; never deploy it.
  AUTH_MODE: z.enum(['dev', 'shared-secret']).default('shared-secret'),
  // 1 or 2 comma-separated secrets (2 during rotation), each at least 32 characters.
  HUB_API_KEYS: z.string().optional(),
  DEV_BIZISHIP_COMPANY_ID: z.string().min(1).default('dev-company'),
  // "file": local development (encrypted JSON files in DATA_DIR). "dynamodb": the deployed Hub.
  STORE: z.enum(['file', 'dynamodb']).default('file'),
  // file store: tokens are AES-GCM encrypted with this key. (dynamodb: tokens are encrypted with KMS instead.)
  TOKEN_ENCRYPTION_KEY: key32.optional(),
  TABLE_NAME: z.string().min(1).optional(),
  KMS_KEY_ID: z.string().min(1).optional(),
  STATE_SIGNING_KEY: key32,
  DATA_DIR: z.string().min(1).default('.data'),
  FRONTEND_RETURN_URL: z.string().url().optional(),
  // Base URL of the BiziShip web app; shipment links written into the ERP are built from it.
  APP_BASE_URL: z.string().url().default('https://app.biziship.ai'),
});

export type Config = z.infer<typeof schema>;

function checkAuth(cfg: Config): string[] {
  if (cfg.AUTH_MODE !== 'shared-secret') return [];
  const keys = (cfg.HUB_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length < 1 || keys.length > 2) return ['HUB_API_KEYS: provide 1 or 2 comma-separated secrets when AUTH_MODE=shared-secret'];
  if (keys.some((k) => k.length < 32)) return ['HUB_API_KEYS: each secret must be at least 32 characters'];
  return [];
}

function checkStore(cfg: Config): string[] {
  const problems: string[] = [];
  if (cfg.STORE === 'file' && !cfg.TOKEN_ENCRYPTION_KEY) problems.push('TOKEN_ENCRYPTION_KEY: required when STORE=file');
  if (cfg.STORE === 'dynamodb') {
    if (!cfg.TABLE_NAME) problems.push('TABLE_NAME: required when STORE=dynamodb');
    if (!cfg.KMS_KEY_ID) problems.push('KMS_KEY_ID: required when STORE=dynamodb');
    // A deployed Hub must never run without authentication.
    if (cfg.AUTH_MODE === 'dev') problems.push('AUTH_MODE: "dev" is not allowed when STORE=dynamodb');
  }
  return problems;
}

/** Validates the environment. Error output lists variable names only — never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) cleaned[k] = v === '' ? undefined : v;
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const problems = [...checkAuth(result.data), ...checkStore(result.data)];
  if (problems.length) throw new Error(`Invalid configuration:\n${problems.map((l) => `  - ${l}`).join('\n')}`);
  return result.data;
}
