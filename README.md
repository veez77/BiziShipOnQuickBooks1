# BiziShip ERP Hub

Provider-neutral integration service between the BiziShip web app and accounting/ERP systems. **QuickBooks Online** is the first provider; Sage and others plug in as additional providers. The Hub talks only to the ERP and to the web app's server routes. It has no connection to the core backend and does not use the ERP Gateway.

- Architecture and decisions: `QUICKBOOKS_INTEGRATION_DESIGN.md`
- The contract with the web app (the source of truth for the HTTP API): `docs/ERP_HUB_CONTRACT_V1.md`

## Status
Built and tested: shared-secret auth and roles, connect/callback (`returnTo`, `already_connected`, `realm_mismatch`), token storage with rotation-safe refresh, documents list/search/paging, shipment seed with context handle, version check, attachments, setup, and the DynamoDB stores and Lambda entry point. Not built yet: `booked`, link lookup and retry (the memo write). See section 12 of the contract.

## Requirements
Node.js **20+** (developed on 22). The system default on some machines is Node 18; switch first (`nvm use 22`).

## Run locally
```bash
npm install
cp .env.example .env     # fill in QBO_CLIENT_ID / QBO_CLIENT_SECRET, HUB_API_KEYS and the two keys
npm run dev              # http://127.0.0.1:3000
npm test                 # unit + HTTP tests, no network and no real Intuit calls
npm run typecheck
```
`.env` is git-ignored. Never commit it; never paste the client secret into chat or tickets.

Local runs use `STORE=file` (encrypted JSON files in `.data/`). For quick experiments without headers set `AUTH_MODE=dev` (a fixed company with the ADMIN role). To test the real header rules, use `AUTH_MODE=shared-secret` and send `X-ERP-Hub-Key` plus the `X-BiziShip-*` headers from the contract.

### Connect a QuickBooks sandbox (local)
1. In the Intuit developer portal, the app's Redirect URIs (Development) must include `http://localhost:3000/callback`.
2. Start the Hub and open `http://localhost:3000/v1/quickbooks/connect?redirect=1` (`AUTH_MODE=dev`).
3. Approve the sandbox company on the Intuit screen.
4. `GET /v1/quickbooks/connection` shows the status (never any token).

## Deploy to AWS (Lambda + API Gateway HTTP API + DynamoDB + KMS)
Same tooling as the ERP Gateway: Serverless Framework 3 + esbuild. Region `us-east-1`.

1. **Secrets, once per stage.** `npm run secrets -- --stage staging` reads `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` from your local `.env`, generates the state-signing key and the shared key, and stores them in ONE Secrets Manager secret `biziship-erp-hub/<stage>`. The shared key is written to `.data/hub-key-<stage>.txt` and never printed: copy it into the web app's server environment as `PRIVATE_ERP_HUB_KEY`, then delete the file.
2. **Deploy.** Set `FRONTEND_RETURN_URL`, `APP_BASE_URL` and `ALERT_EMAIL`, then `npm run deploy` (stage `staging`, QuickBooks sandbox) or `npm run deploy:prod`. `npm run build:check` builds the package and template without touching AWS.
3. **Register the callback in Intuit.** The deploy prints `IntuitRedirectUri`; add it exactly to the Intuit app's Redirect URIs. Set the web app's `PRIVATE_ERP_HUB_URL` to the printed `HubUrl`.
4. Confirm the alarm-email subscription AWS sends to `ALERT_EMAIL`.

What it creates: one Lambda (arm64, Node 22), an HTTP API with throttling (5 requests/s), one DynamoDB table (on-demand, TTL, point-in-time recovery), one KMS key (yearly rotation) that encrypts the ERP tokens, three CloudWatch alarms and an SNS topic. The table and key are kept if the stack is removed. The Lambda role can only touch its own table, key and secret.

**Account limit:** a new AWS account allows only 10 concurrent Lambda executions in total, shared with the ERP Gateway. The Hub's throttle is deliberately low for that reason; request a higher quota in Service Quotas before raising it.

## Layout
```
src/
  config.ts            validated environment (errors list names, never values)
  auth.ts              shared-secret check, caller headers, roles
  crypto.ts, state.ts  AES-GCM/HMAC helpers; signed single-use OAuth state
  tokens.ts            TokenService: refresh with rotation, single-flight + cross-instance lease, 401 retry
  server.ts            HTTP API: errors, auth, connect/callback/connection
  routes/documents.ts  documents, seed, version, attachments, setup
  seed.ts              ShipmentSeed builder
  providers/           neutral interfaces + quickbooks/ (oauth, api, mapping, documents, memo-line rules)
  store/               interfaces; file (local), memory (tests), dynamo (deployed)
  runtime.ts           wiring shared by index.ts (local) and lambda.ts (AWS)
serverless.yml         the AWS deployment
scripts/put-secrets.mjs
tests/
```
