# ERP Hub contract v1 (frontend ↔ Hub)

Status: **agreed contract, 2026-11-17.** Supersedes the v0 contract in `FRONTEND_BRIEF_ERP_INTEGRATION.md` §5 wherever they differ. Built from the frontend's feedback (`erp-hub-contract-feedback.md`) and the frontend's answers. The Hub is **not** a proxy: quote, booking, BOL, tracking and document extraction stay between the web app and the core backend.

**Implementation status** is in section 12. Mock from this document; unknown fields must be ignored and unknown enum values must degrade gracefully.

---

## 1. Trust model

The Hub is called **only by the web app's server routes**, never by a browser. It has no connection to the core backend and does not verify the BiziShip JWT. The web app asserts who is calling, using values it took from a core-verified session (`/auth/me`).

Every call except `GET /health` and the browser callback `GET /v1/{p}/callback` carries:

| Header | Meaning |
|---|---|
| `X-ERP-Hub-Key` | Shared secret. The Hub accepts **two active values** at once (rotation). Compared in constant time |
| `X-BiziShip-Company-Id` | The caller's BiziShip company. All data is scoped by this |
| `X-BiziShip-User-Id` | The user. The context handle is bound to it |
| `X-BiziShip-User-Email` | Audit only |
| `X-BiziShip-Role` | `ADMIN`, `SUPER_USER` or `CUSTOMER` (every role that can book a shipment) may connect, disconnect and change setup. Any other value is allowed for read/use calls but gets `403 forbidden` on those three |

Missing or wrong key or headers: `401 unauthorized`. A role outside ADMIN, SUPER_USER and CUSTOMER on a management call: `403 forbidden`. The connection is **one per BiziShip company**, shared by all its users: any of the three roles may disconnect it for the whole company. Enablement per company is enforced by the web app, not the Hub (there is no `not_enabled` error).

The Hub logs company id and user id per call, never headers, tokens, document contents or customer details.

## 2. Conventions

- JSON in and out, `Content-Type: application/json`. `{p}` is the provider id (`quickbooks`; later `sage`).
- Errors: `{ "error": "<code>", "message"?: string, "requestId"?: string, ...extra }`.
- Every call should finish in a few seconds. The web app uses about 10 s timeouts, and 3 s for the version check.
- `id` is always the ERP's own internal id, never the visible document number (not unique in QuickBooks).
- Dates are ISO 8601 strings; timestamps are epoch milliseconds.

### Error codes

| HTTP | `error` | When |
|---|---|---|
| 401 | `unauthorized` | Wrong/missing shared key or required headers |
| 403 | `forbidden` | Role is not ADMIN, SUPER_USER or CUSTOMER, on connect, disconnect or setup change |
| 404 | `unknown_provider` | `{p}` not registered |
| 404 | `not_connected` | The company has no connection to this provider |
| 404 | `document_not_found` | Document id unknown in the ERP |
| 404 | `no_link` | No link exists for that shipment |
| 409 | `reconnect_required` | The ERP connection needs re-authorisation; stop the flow and offer reconnect |
| 409 | `already_connected` | A connection exists; disconnect first (one connection per provider per company) |
| 409 | `handle_invalid` | Context handle unknown, expired, or already bound to a different shipment. Reload the document |
| 400 | `handle_mismatch` | Handle does not belong to the path document, or body disagrees with the handle |
| 400 | `invalid_request` | Malformed input; `details` lists fields |
| 400 | `invalid_state` | OAuth state invalid or reused (callback) |
| 413 | `attachment_too_large` | Attachment above 4 MB |
| 429 | `rate_limited` | ERP throttling; includes `retryAfterSeconds` |
| 502 | `quickbooks_error`, `oauth_error` | ERP failure; `message` is safe to show |
| 500 | `internal_error` | Unexpected |

A failed **link write** is not an HTTP error: it is `200` with `linkStatus: "failed"` (section 7).

---

## 3. Providers and connection

`GET /health` → `{ status: "ok" }` (no auth).

`GET /v1/providers` →
```json
{ "providers": [ { "id": "quickbooks", "displayName": "QuickBooks Online",
    "capabilities": { "documentTypes": ["estimate", "invoice"], "attachments": true,
                      "linkModes": ["memo"], "multipleShipmentsPerDocument": true } } ] }
```

`POST /v1/{p}/connect` (ADMIN/SUPER_USER/CUSTOMER). Body `{ "returnTo"?: string }` (opaque; the Hub stores it in the signed OAuth state and echoes it unchanged; **the web app validates it**). Response `{ "authUrl": string }`. `409 already_connected` if a connection with status `connected` exists. If the status is `needs_reconnect`, connecting again is allowed and must be for the **same** ERP company (otherwise the callback redirects with `error=realm_mismatch`).

`GET /v1/{p}/callback` (called by the browser after the ERP consent; no headers). Always **redirects** to the configured frontend return URL:
- success: `?connected={p}&returnTo=<echoed>`
- failure or denial: `?error=<code>&message=<text>&returnTo=<echoed>` (codes include `authorization_denied`, `invalid_state`, `realm_mismatch`, `oauth_error`)

`GET /v1/{p}/connection` →
`{ connected, status: "not_connected"|"connected"|"needs_reconnect", realmId?, companyName?, connectedAt?, accessExpiresAt?, refreshExpiresAt?, lastError? }` (never any token).

`DELETE /v1/{p}/connection` (ADMIN/SUPER_USER/CUSTOMER) → `{ disconnected: boolean, revoked?: boolean }`. The Hub **revokes the tokens with the ERP** (for QuickBooks: Intuit's revoke endpoint) and then deletes them. `revoked` is `false` if the ERP could not be reached or rejected the token (for example it had already expired); the local connection is removed either way. Afterwards `GET /connection` returns `not_connected`. Shipment links and context-handle data are **not** touched. `disconnected: false` means there was no connection.

The Hub records who connected, disconnected or changed setup (`X-BiziShip-User-Id` with the company id) as structured audit log lines. They are not returned by the API.

## 4. Setup (self-describing)

`GET /v1/{p}/setup` →
```json
{ "fields": [
    { "key": "defaultOrigin", "label": "Default pickup address", "type": "address", "required": false },
    { "key": "writeLinkToMemo", "label": "Add the BiziShip shipment link to the QuickBooks document",
      "type": "boolean", "required": true,
      "help": "Adds one line to the document's \"Memo on statement\", which can appear on customer statements." } ],
  "values": { "defaultOrigin": { "line1": "123 Sierra Way", "city": "San Pablo", "state": "CA", "zip": "87999", "country": "US" },
              "writeLinkToMemo": true } }
```
Field `type` is one of `address`, `text`, `select` (with `options: [{value,label}]`), `boolean`; unknown types render read-only. `PUT /v1/{p}/setup` (ADMIN/SUPER_USER/CUSTOMER), body `{ "values": { ... } }` → same shape as GET. Defaults: `defaultOrigin` prefilled from the ERP company address; `writeLinkToMemo` is `true`.

## 5. Documents

`GET /v1/{p}/documents?type=&status=&q=&cursor=&limit=` → `{ items: DocumentSummary[], nextCursor: string | null }`. `type` is `estimate`, `invoice` or omitted for both (newest first, merged); `status` is the **filter** `open` (default; includes partially paid invoices), `paid`, `closed` or `all` (estimates are never "paid"; `closed` returns closed or rejected estimates and fully paid invoices). The `status` on each returned item is richer: `open | partial | paid | closed | unknown`. `q` searches document number and customer name and returns up to `limit` matches in **one page** (`nextCursor: null`). `limit` default 25, maximum 100; `cursor` is opaque, may only be used with the same filters, and a page can be shorter than `limit` (even empty) while `nextCursor` is still set, so keep following it until it is `null`. Bad `status`, `limit`, `cursor` or `type`: `400 invalid_request` with `details`.

`GET /v1/{p}/documents/{id}?type=` → `ShipmentSeed` (section 8), including `contextHandle`. `type` is **required**. Every call returns a fresh handle. Until group 2 ships, `shipmentLinks` is `[]` and `shipmentCount` is `0`. Until customer-document parsing exists, `cargo`, `accessorials` and `instructions` are `{ value: null, origin: "default" }`; `origin` is the company's saved default pickup address (origin `"default"`) or, if none is saved, the ERP company address (origin `"erp"`). A line's `ship` is `true` only when `physicalHint` is `likely`.

`GET /v1/{p}/documents/{id}/version?type=&handle=` → `{ version, status, changed, closed, linkedDocuments? }`. `changed` is true when the document's current version differs from the version stored with the handle (without `handle`, only `version` and `status` are meaningful). Call it just before booking. Target response time under 2 s.

`GET /v1/{p}/documents/{id}/attachments?type=` → `[{ id, name, contentType, size }]`.
`GET /v1/{p}/documents/{id}/attachments/{attId}?type=` → the file bytes with the original `Content-Type`; at most **4 MB**, otherwise `413 attachment_too_large`. The web app only extracts PDF, JPEG and PNG and greys out the rest.

## 6. The context handle

`contextHandle` is returned with every seed. It is an opaque random token (256 bit). The Hub stores only its hash, with a TTL of **24 hours**, bound to: company id, user id, provider, document type, ERP document id, and the document **version** at seed time.

- The web app carries it through quote → booking (URL parameter, then hidden field).
- It is **not single-use**: it binds to the **first** `shipmentId` that uses it (atomically, when the link is stored). The same shipment with the same `idempotencyKey` returns the stored state. A **different** shipment gets `409 handle_invalid`; load a fresh seed and handle for the same document (this is how several shipments per document work).
- The Hub chooses the write target (document type, id) **only** from its own stored record, never from the request body.
- Unknown, expired, or other-company/other-user handle: `409 handle_invalid`.

## 7. Booking hand-off and links

`POST /v1/{p}/documents/{id}/booked` — called by the web app only **after** the booking succeeded.
```json
{ "contextHandle": "<opaque>", "shipmentId": "<uuid>", "idempotencyKey": "<string>",
  "bolNumber": "...", "receipt": "<opaque, ignored in v1>",
  "sourceRef": "<realmId>:<docType>:<docId>", "documentNumber": "1001" }
```
`sourceRef`, `documentNumber` and `bolNumber` are only consistency/log values: a mismatch with the stored handle returns `400 handle_mismatch`. The Hub does not call the core and does not verify the shipment.

Response `200`:
```json
{ "shipmentId": "<uuid>", "linkStatus": "linked", "reason": null,
  "erpUrl": "https://sandbox.qbo.intuit.com/app/invoice?txnId=130",
  "warnings": [ { "code": "document_changed", "message": "..." },
                { "code": "document_closed", "message": "...", "linkedDocuments": [ { "type": "invoice", "id": "130" } ] } ] }
```
- `linkStatus`: `linked` (memo line written), `queued` (write in progress or waiting for retry), `failed` (see `reason`), `skipped` (`reason: "memo_disabled"`; the link is kept in the Hub only).
- `reason` values: `erp_rejected_update` (QuickBooks rejected the update, e.g. legacy data), `rate_limited`, `reconnect_required`, `memo_too_long`, `document_not_found`, `memo_disabled`, `internal`.
- **`booked` never rejects a booking because the document changed or is closed**: the shipment already exists. Those are `warnings`; the link is still written. Idempotent per `idempotencyKey` (records kept 7 days, longer than the handle).
- What is written into QuickBooks: **one line** in the document's memo: `BiziShip shipment: https://app.biziship.ai/shipments/<uuid>`. Existing memo text is kept, one line per shipment, no duplicates on retry. Nothing else is ever written (no amounts, lines, BOL, customer message).

**Link lookup by shipment**

```
Link = { shipmentId, provider, documentType, documentId, documentNumber?, linkStatus, reason?, updatedAt, erpUrl? }
```
- `GET /v1/links?shipmentId=<uuid>` → `Link`, or `404 no_link`.
- `POST /v1/links/lookup` body `{ "shipmentIds": [..up to 100..] }` → `{ "links": { "<shipmentId>": Link } }` (shipments without a link are omitted).
- `POST /v1/links/{shipmentId}/retry` body `{ "idempotencyKey": string }` → same response as `booked` (no handle needed; uses the stored link). Retrying after `failed` re-attempts the memo write.

All link calls are scoped to the company id header.

## 8. Shapes

```ts
type Origin = 'erp' | 'document-ai' | 'memory' | 'default' | 'user';
interface Field<T> { value: T | null; origin: Origin; confidence?: number /*0..1*/;
                     conflict?: { erpValue: T | null; reason?: string } }   // present when the document overrode the ERP

interface Address { company?: string; line1?: string; line2?: string; city?: string; state?: string;
                    zip?: string; country?: string; contactName?: string; phone?: string; email?: string;
                    residential?: boolean }

interface CargoLine { packagingType?: string;
                      pallets?: number;            // number of handling units
                      weightPerPallet?: number;    // lb, per handling unit
                      length?: number; width?: number; height?: number;   // in, per handling unit
                      description?: string; freightClass?: string; nmfc?: string; hazmat?: boolean }

interface ShipmentLinkRef { shipmentId: string; linkStatus: 'linked'|'queued'|'failed'|'skipped'|string }

interface DocumentSummary {
  id: string; type: 'estimate' | 'invoice' | string; number?: string; date?: string;
  customerName?: string; total?: number; currency?: string;
  status: string;                 // normalised: open | partial | paid | closed | unknown ...
  version: string;                // opaque; hash of the fields that matter for a shipment
  linkedDocuments?: { type: string; id: string }[];
  shipmentLinks: ShipmentLinkRef[]; shipmentCount: number;
}

interface ShipmentSeed {
  contextHandle: string;
  source: { provider: string; docType: string; id: string; number?: string;
            ref: string;          // "<realmId>:<docType>:<docId>"; send as source_ref to the core, exactly as given
            version: string; status: string;
            linkedDocuments?: { type: string; id: string }[] };
  customer: { name?: string; email?: string; phone?: string };
  origin: Field<Address>;
  destination: Field<Address>;
  cargo: Field<CargoLine[]>;
  accessorials: Field<string[]>;           // BiziShip accessorial codes (LGDEL, RESDEL, APPT, ...)
  instructions: Field<string>;
  references: { po?: Field<string>; salesOrder?: Field<string>; reference?: Field<string> };
  lines: { id: string; itemId?: string; description?: string; qty?: number; unitPrice?: number; amount?: number;
           physicalHint: 'likely' | 'unlikely' | 'unknown'; ship: boolean }[];
  shipmentLinks: ShipmentLinkRef[]; shipmentCount: number;
  attachments: { id: string; name: string; contentType?: string; size?: number }[];
  warnings: { code: string; message: string }[];
}
```
Provenance, precedence (user edit > customer document > ERP > memory/defaults) and the "document wins, difference visible" rule are as in the v0 brief §4. Until customer-document parsing exists, the seed carries ERP data plus the default origin; fields from the document are absent or mocked.

---

## 9. Example seed with a conflict (use in the mock)

```json
{
  "contextHandle": "hb_3f9c2a7e5d1b4c80a6e2f1d09b7c4a55",
  "source": { "provider": "quickbooks", "docType": "estimate", "id": "100", "number": "1001",
              "ref": "9341458704528073:estimate:100", "version": "v-7b1c", "status": "closed",
              "linkedDocuments": [ { "type": "invoice", "id": "130" } ] },
  "customer": { "name": "Sonnenschein Family Store", "email": "Familiystore@intuit.com" },
  "origin": { "value": { "company": "ACME Warehouse", "line1": "12 Dock St", "city": "Oakland", "state": "CA",
                         "zip": "94607", "country": "US", "contactName": "Dana", "phone": "5105550100" },
              "origin": "document-ai", "confidence": 0.93 },
  "destination": { "value": { "line1": "5647 Cypress Hill Ave.", "city": "Middlefield", "state": "CA",
                              "zip": "94303", "country": "US", "contactName": "Russ Sonnenschein", "phone": "6505550123" },
                   "origin": "document-ai", "confidence": 0.81,
                   "conflict": { "erpValue": { "line1": "5647 Cypress Hill Ave", "city": "Middlefield", "state": "CA", "zip": "94309" },
                                 "reason": "ZIP differs from QuickBooks ship-to" } },
  "cargo": { "value": [
      { "packagingType": "Pallet", "pallets": 3, "weightPerPallet": 450, "length": 48, "width": 40, "height": 52 },
      { "packagingType": "Pallet", "pallets": 2, "weightPerPallet": 300, "length": 48, "width": 40, "height": 36 } ],
    "origin": "document-ai", "confidence": 0.74 },
  "accessorials": { "value": ["LGDEL", "APPT"], "origin": "document-ai", "confidence": 0.7 },
  "instructions": { "value": null, "origin": "default" },
  "references": { "po": { "value": "PO-7781", "origin": "document-ai", "confidence": 0.95 },
                  "salesOrder": { "value": "1001", "origin": "erp" } },
  "lines": [
    { "id": "1", "itemId": "5", "description": "Rock Fountain", "qty": 1, "unitPrice": 275, "amount": 275, "physicalHint": "likely", "ship": true },
    { "id": "2", "itemId": "11", "description": "Fountain Pump", "qty": 1, "unitPrice": 12.75, "amount": 12.75, "physicalHint": "likely", "ship": true },
    { "id": "3", "itemId": "3", "description": "Concrete for fountain installation", "qty": 5, "unitPrice": 9.5, "amount": 47.5, "physicalHint": "unknown", "ship": false }
  ],
  "shipmentLinks": [ { "shipmentId": "8c1f0a52-3d5e-4a57-9a53-2b1a7a3c0001", "linkStatus": "linked" } ],
  "shipmentCount": 1,
  "attachments": [ { "id": "att-1", "name": "customer-order.pdf", "contentType": "application/pdf", "size": 182044 } ],
  "warnings": []
}
```

## 10. Mock cases the frontend should cover

- Connection: `not_connected`, `connected`, `needs_reconnect`, `409 reconnect_required` on any call, `409 already_connected`, `403 forbidden` for a connect, disconnect or setup change by a role outside ADMIN, SUPER_USER and CUSTOMER (for example `USER`), a connect by CUSTOMER that succeeds, a disconnect by a different user of the same company that succeeds and returns `not_connected` afterwards, callback redirect with `error` (each code) and `returnTo` echoed.
- Setup: the self-describing shape above; `writeLinkToMemo` false.
- Documents: several pages with `nextCursor`; a **closed estimate** with a linked invoice; an invoice with **two** shipment links (`shipmentCount: 2`); a paid invoice.
- Seeds: the conflict example; a seed with **no** document data (ERP data and default origin only); a seed with missing required fields.
- `version`: `changed: false`, `changed: true`, `closed: true`; also a call that takes longer than 3 s (frontend proceeds).
- Attachments: PDF, JPEG, PNG, a `.docx` (grey out), 413 `attachment_too_large`.
- `booked`: `linked`; `queued` then `linked` on a later lookup; `failed` with `erp_rejected_update` and a successful retry; `skipped` with `memo_disabled`; with `warnings` `document_changed` and `document_closed`; `409 handle_invalid` (different shipment, then success after reload); `400 handle_mismatch`; `429 rate_limited` with `retryAfterSeconds`; a repeat with the same key returning the stored state.
- Link lookup: single (200 and 404 `no_link`) and a batch of 100 with some shipments missing.

## 11. What the web app must do (summary)

1. Send the five headers on every call; take company id, user id, email and role from the core-verified session.
2. Validate `returnTo` as a relative path of your own app before use.
3. Pass the handle seed → quote → booking; call `GET …/version` just before booking (3 s timeout, proceed on failure).
4. Call `booked` only after a successful booking; on `handle_invalid`, reload the document and call `booked` again with the same shipment id and idempotency key.
5. Send `source_provider` (registry id), `source_ref` (`seed.source.ref`) and `erp_document_number` (`seed.source.number`) to the core when booking.
6. Treat `linkStatus` other than `linked` as a note on the shipment, never as a booking failure.

## 12. Implementation status

| Part | Status |
|---|---|
| Connect/callback, tokens (encrypted, refresh, rotation), `connection`, `providers` | **Built, tested** (sandbox) |
| Memo-line rules (`BiziShip shipment: <url>`, no duplicates, preserve text) | **Built, tested**; verified against the QuickBooks sandbox |
| Shared-secret auth and headers (two active keys), role checks | **Built, tested** (group 1a) |
| Redirect-on-error callback, `returnTo` in signed state, `already_connected`, `realm_mismatch` | **Built, tested** (group 1a) |
| Documents list/search/paging, seed with handle, version check, attachments list and download, setup GET/PUT | **Built, tested; verified against the QuickBooks sandbox** except downloading a real attachment file (the sandbox has none yet; covered by a fake only) (group 1b) |
| `booked`, link lookup, retry | Next (group 2) |
| DynamoDB stores (connections encrypted with KMS, handles, setup, one-time states), cross-instance refresh lease, Lambda entry point, deployment definition | **Built and tested locally; not deployed yet** (waiting for the go-ahead) |
| Attachment download content type | PDF, JPEG and PNG keep their type; any other type is served as `application/octet-stream` with the original in `X-Original-Content-Type` |

Until those parts are built, develop against a mock built from sections 9 and 10. Local end-to-end (web app dev server → local Hub → QuickBooks sandbox) becomes possible group by group; the Hub will announce each group.
