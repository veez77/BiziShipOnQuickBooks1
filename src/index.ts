import { loadConfig } from './config.js';
import { parseKey } from './crypto.js';
import { buildRuntime } from './runtime.js';
import { FileConnectionStore } from './store/fileStore.js';
import { FileSettingsStore } from './store/settings.js';

/** Local development server. The deployed Hub starts from src/lambda.ts instead. */
async function main() {
  const config = loadConfig();
  if (config.STORE !== 'file' || !config.TOKEN_ENCRYPTION_KEY) {
    throw new Error('The local server uses STORE=file. The DynamoDB store runs only inside the deployed Lambda.');
  }

  // Local run: connections and settings in files; handles and one-time OAuth states in memory (a restart
  // invalidates open handles, which the web app handles by reloading the document).
  const app = buildRuntime(config, {
    connections: new FileConnectionStore(config.DATA_DIR, parseKey(config.TOKEN_ENCRYPTION_KEY)),
    settings: new FileSettingsStore(config.DATA_DIR),
  });
  await app.listen({ port: config.PORT, host: config.HOST });

  app.log.info(`ERP Hub listening on http://${config.HOST}:${config.PORT} (QuickBooks ${config.QBO_ENVIRONMENT})`);
  app.log.info(`To connect the sandbox, open: http://localhost:${config.PORT}/v1/quickbooks/connect?redirect=1`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
