import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { KMSClient } from '@aws-sdk/client-kms';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { loadConfig } from './config.js';
import { wrapForLambda } from './lambdaAdapter.js';
import { buildRuntime } from './runtime.js';
import { DynamoConnectionStore, DynamoHandleStore, DynamoNonceStore, DynamoSettingsStore } from './store/dynamo.js';

/**
 * AWS Lambda entry point (API Gateway HTTP API, payload v2).
 * Secrets (Intuit client secret, the web app's shared key(s), the OAuth state signing key) come from ONE
 * Secrets Manager secret, read once per cold start; everything else is plain environment configuration.
 */
type Handler = (event: APIGatewayProxyEventV2, context: Context) => Promise<APIGatewayProxyStructuredResultV2>;

async function init(): Promise<Handler> {
  const secretId = process.env['HUB_SECRET_ID'];
  if (!secretId) throw new Error('HUB_SECRET_ID is not set');
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!secret.SecretString) throw new Error('The Hub secret is empty');
  const secrets = JSON.parse(secret.SecretString) as Record<string, string>;

  // Secrets win over plain environment values of the same name.
  const config = loadConfig({ ...process.env, ...secrets });
  if (config.STORE !== 'dynamodb') throw new Error('The Lambda must run with STORE=dynamodb');

  const deps = { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }), table: config.TABLE_NAME! };
  const app = buildRuntime(config, {
    connections: new DynamoConnectionStore(deps, new KMSClient({}), config.KMS_KEY_ID!),
    settings: new DynamoSettingsStore(deps),
    handles: new DynamoHandleStore(deps),
    nonces: new DynamoNonceStore(deps),
  });
  return wrapForLambda(app) as unknown as Handler;
}

let ready: Promise<Handler> | undefined;

export const handler: Handler = async (event, context) => {
  // A failed cold start must not be cached forever: reset so the next invocation retries.
  ready ??= init().catch((err) => {
    ready = undefined;
    throw err;
  });
  return (await ready)(event, context);
};
