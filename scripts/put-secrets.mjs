// Creates or updates the Hub's ONE Secrets Manager secret for a stage.
//
//   node scripts/put-secrets.mjs --stage staging [--rotate-key]
//
// - QBO_CLIENT_ID / QBO_CLIENT_SECRET are read from your local .env (the Intuit app keys for that environment).
// - STATE_SIGNING_KEY and HUB_API_KEYS are generated on first run and then kept.
// - --rotate-key adds a NEW shared key next to the current one (both are accepted, so the web app can switch
//   without downtime). Run it again later with --retire-old to keep only the newest.
// - The shared key is written to .data/hub-key-<stage>.txt (git-ignored), NEVER printed. Copy it from there
//   into the web app's server-side environment (PRIVATE_ERP_HUB_KEY), then delete the file.
//
// Uses your normal AWS credentials (AWS_PROFILE / default profile).
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

loadEnv();
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const stage = args[args.indexOf('--stage') + 1];
if (!stage || stage.startsWith('--')) {
  console.error('Usage: node scripts/put-secrets.mjs --stage <staging|prod> [--rotate-key] [--retire-old]');
  process.exit(1);
}

const name = `biziship-erp-hub/${stage}`;
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });

let current = null;
try {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: name }));
  current = JSON.parse(r.SecretString ?? '{}');
} catch (e) {
  if (!(e instanceof ResourceNotFoundException)) throw e;
}

const clientId = process.env.QBO_CLIENT_ID;
const clientSecret = process.env.QBO_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set in your local .env');
  process.exit(1);
}

const newKey = () => randomBytes(32).toString('base64url');
const next = { ...(current ?? {}), QBO_CLIENT_ID: clientId, QBO_CLIENT_SECRET: clientSecret };
next.STATE_SIGNING_KEY ||= randomBytes(32).toString('base64');

let wroteKey = null;
const existing = (next.HUB_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
if (existing.length === 0) {
  wroteKey = newKey();
  next.HUB_API_KEYS = wroteKey;
} else if (flag('--rotate-key')) {
  if (existing.length >= 2) {
    console.error('Two keys are already active. Run with --retire-old first (after the web app uses the newer key).');
    process.exit(1);
  }
  wroteKey = newKey();
  next.HUB_API_KEYS = `${existing[0]},${wroteKey}`;
} else if (flag('--retire-old')) {
  next.HUB_API_KEYS = existing[existing.length - 1];
}

const body = JSON.stringify(next);
if (current) await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: body }));
else await sm.send(new CreateSecretCommand({ Name: name, SecretString: body, Description: `BiziShip ERP Hub secrets (${stage})` }));

if (wroteKey) {
  mkdirSync('.data', { recursive: true });
  const file = `.data/hub-key-${stage}.txt`;
  writeFileSync(file, wroteKey + '\n', { mode: 0o600 });
  console.log(`Secret ${name}: ${current ? 'updated' : 'created'}. New shared key written to ${file} (not printed).`);
} else {
  console.log(`Secret ${name}: ${current ? 'updated' : 'created'}. Shared key(s) unchanged.`);
}
