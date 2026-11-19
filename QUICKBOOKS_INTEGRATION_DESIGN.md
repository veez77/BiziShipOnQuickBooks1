# BiziShip.ai on QuickBooks Online — Integration Design

Status: **Draft v5** — 2026-11-17
v5 (decided by the product owner, matches the architecture diagram of 2026-11-17): **the ERP Hub has no connection to the core backend and does not use the ERP Gateway.** It connects only to the ERP (QuickBooks, later Sage) and to the frontend. The frontend calls the core backend directly for quote/book/BOL/tracking exactly as it does today. **The only thing written back to QuickBooks is a link to the BiziShip shipment.**
Companion to `ODOO_INTEGRATION_REFERENCE.md` (background on the Odoo integration).

---

## 1. Goal, scope, constraints

Let a customer who runs their books on **QuickBooks Online (QBO)** use BiziShip.ai (LTL/FTL quoting, booking, BOL, tracking) starting from their own QBO documents, with a link to the booked shipment placed on the QBO document. Sage (and other ERPs) must plug in later without redoing the frontend.

**In scope (v1):** connect a QBO company; pick an open **Estimate** or **Invoice**; build a shipment "seed" from the QBO document **plus** a customer-side logistics document parsed by AI; quote and book in BiziShip (frontend ↔ core, as today); write the **link to the BiziShip shipment** onto the QBO document.

**Out of scope (v1):** QuickBooks Desktop; writing freight charges, BOLs or any other data into QBO; payments; carrier-cost Bills; multi-currency; automatic carrier choice without a human; public Intuit App Store listing (later); Sage itself (only the extension points).

**Constraints from the product owner**
- The **core backend** stays the system's brain; no ERP-specific logic is added to it, and the Hub does not call it.
- The **user's environment is the frontend app** (`app.biziship.ai`). The frontend calls the core directly (unchanged) and calls the Hub only for ERP matters.
- **Frontend** (`BiziShipFrontend1`), **backend** (`BiziShipBackend1`) and **ERP Gateway** (`BiziShipERPGateway`) are **read-only** from this project; needed changes are delivered as briefs. The ERP Gateway keeps serving Odoo and is **not** touched.
- The Hub is provider-neutral (QuickBooks now, Sage later).

---

## 2. Verified facts

### 2.1 QuickBooks sandbox (2026-11-15)

| Topic | Finding | Consequence |
|---|---|---|
| Sales Order | **No `SalesOrder` entity** in the QBO Accounting API | Trigger documents are `Estimate` and `Invoice` |
| Document key | `DocNumber` is **not unique** | Key by QBO `Id` + `realmId` |
| Estimate status | `TxnStatus` (`Closed` once converted); `LinkedTxn` → the Invoice | Closed estimate → work on the linked invoice |
| Invoice status | No `TxnStatus`; open ≙ `Balance > 0` | Informational only (we write just a memo link) |
| Line items | `ItemRef`, `Qty`, `UnitPrice`, `Description`. **No weight, dimensions, class, NMFC, packaging** | Cargo comes from the customer document / user |
| Items | `Type` unreliable (physical goods can be `Service`) | Never auto-decide what ships; user ticks lines |
| `ShipAddr` | Structured street/city/state/ZIP; **no name, phone, country** | Contacts from Customer record and/or customer document; country default from `CompanyInfo.Country` |
| `BillAddr` | Free-text blob | Don't parse for logic |
| Address quality | Unvalidated | Validate all addresses (existing BiziShip validation, in the frontend flow) |
| Customers | Sub-customers (`Job:true`, `ParentRef`) | Resolve parent for company name |
| Custom fields | Custom Fields API is **Premium** | Don't depend on it: use `PrivateNote` and own DB |
| Locking | Every entity has `SyncToken` | Read-then-update; handle stale-token errors |
| Company info | `CompanyAddr`, `Country`, `Email`, `OfferingSku` | Default origin; detect plan |

**Verified in Phase 1:** OAuth connect to the sandbox works end to end; access token ~1 h; refresh window ~101 days and slides on every refresh; live `CompanyInfo` call works after refreshes.

**Verified in Phase 2a (2026-11-17, sandbox link experiment; test data removed afterwards):**
- `PrivateNote` appears in the QBO UI as **"Memo on statement (hidden)"**: visible to the user on the document's edit screen, **plain text, not clickable** (copy/paste only). Per QBO's own wording it **can print on the customer's statement**, so it is not purely internal.
- A memo write on a **paid** invoice is accepted; existing memo text is preserved; the invoice stays "Paid in full".
- **A memo write can be rejected (HTTP 400)** on legacy documents: QuickBooks re-validates the whole transaction on any update (e.g. "Transaction date is prior to start date for inventory item"). Seen on a closed estimate and one invoice. Real books can have the same.
- `CustomerMemo` ("Note to customer") **prints on the customer's copy**: never used.
- An `Attachable` **note** (no file) is accepted on every document, even those whose memo write is rejected, but it shows in QBO only as an unnamed paperclip with nothing to read or click: **not useful as a visible link**; dropped.
- **"Open in QuickBooks" deep links work in the sandbox:** `https://sandbox.qbo.intuit.com/app/invoice?txnId=<Id>` and `…/app/estimate?txnId=<Id>`. Production host not yet verified.

**Still to confirm:** rate limits; webhook payload/signature; `Attachable` list/download of existing attachments (customer logistics documents); whether a memo write changes an invoice's email status (not testable on the available data).

### 2.2 BiziShip side (read from the repos, 2026-11-15)

| Topic | Finding | Consequence |
|---|---|---|
| Booking result | Success returns `biziship_id` (the shipment **UUID**), `bol_number`, `shipment_id`, `bol_url` | The link uses the UUID |
| Async | `PORTAL_BRIDGE` companies: 202 + `job_id` polled at `/quote/jobs/:id`, `/book/jobs/:id` | Existing frontend patterns; the Hub is not in this path |
| References | Booking accepts `po_number`, `sales_order`, `reference_number`, `additional_references[]` | Frontend carries QBO references there |
| Channel tag | `clientApp` is free text (`X-Client-App`) | Question for Backend: how to tag ERP-originated shipments (§9) |
| Frontend auth | httpOnly JWT cookie; frontend server routes call the core with it | The frontend server is the trusted caller of the Hub (§3.4) |
| AI extraction | Lives in the core (`/bol/extract` + job polling) | The Hub never calls an LLM; the frontend fetches attachments from the Hub and sends them to the core's extraction |

---

## 3. Architecture

QBO cannot embed third-party UI; every integration is a separate app over OAuth2. BiziShip's frontend is the UI. The **ERP Hub** is the only component that talks to QuickBooks.

### 3.1 Components

```
 Customer's browser
        │
        ▼
 ┌─────────────────────────────────────────┐   quote / book / BOL / tracking / extraction
 │ Frontend (app.biziship.ai, server side) │ ─────────────────────────────►  Core backend (unchanged)
 │  provider-neutral "Integrations" UI     │                                 via the load balancer
 └───────────┬─────────────────────────────┘
             │ ERP matters only: connect, documents, seed, "booked", link status
             │ (shared secret + company id; the browser never reaches the Hub)
             ▼
 ┌─────────────────────────────────────────┐
 │ ERP HUB (this repo)                     │   No connection to the core backend.
 │  QuickBooks adapter now / Sage later    │
 └───────────┬─────────────────────────────┘
             │ OAuth + documents + write link
             ▼
     QuickBooks Online API (Intuit)
```

| Component | Owns | Does **not** own |
|---|---|---|
| **Frontend** | All screens, incl. the provider-neutral Integrations UI; calls the core directly for quote/book/BOL/tracking/extraction | ERP tokens, ERP calls |
| **ERP Hub (this repo)** | ERP OAuth + tokens, ERP documents → ShipmentSeed, writing the shipment link into the ERP, webhooks, document↔shipment link store | Quoting, booking, carriers, LLM calls, any call to the core |
| **Core backend** | Quoting, booking, shipments, carriers, AI document extraction | Anything ERP-specific |
| **ERP Gateway** | Odoo's channel — **not involved** | — |

### 3.2 Hub API (provider-neutral; becomes an OpenAPI file at the end of Phase 2)

All calls come from the frontend server and carry the shared secret and the company id (§3.4).

| Endpoint | Purpose |
|---|---|
| `GET /v1/providers` | Providers + **capabilities** |
| `POST /v1/{p}/connect` → `{authUrl}` · `GET /v1/{p}/callback` | Start / finish ERP OAuth |
| `GET/DELETE /v1/{p}/connection` | Status (`connected` / `needs_reconnect` / `not_connected`), disconnect |
| `GET/PUT /v1/{p}/setup` | One-time setup: default origin (prefilled from the ERP company address) |
| `GET /v1/{p}/documents?type&status&q&cursor` | Paged, normalised candidate documents |
| `GET /v1/{p}/documents/{id}?type=` | **ShipmentSeed** |
| `GET /v1/{p}/documents/{id}/attachments` · `…/{attId}` | ERP-side attachments (customer-side logistics documents), so the frontend can feed them to the core's extraction |
| `POST /v1/{p}/documents/{id}/booked` | Frontend reports a booking: `{ type, shipmentId, idempotencyKey }`. Hub stores the document↔shipment link and **writes the link into the ERP document** (idempotent). Returns link state |
| `GET /v1/{p}/documents/{id}/link?type=` | `{ shipmentId?, linkStatus }` |
| `POST /v1/{p}/documents/{id}/link/retry` | Retry the link write |
| `POST /v1/{p}/webhooks` | Inbound from the ERP (signature-verified) — Phase 5 |

There are no `quote`, `book`, `jobs` or pass-through endpoints: those are the core's.

**ShipmentSeed** (ERP-neutral; every field carries provenance):
```
{ source: {provider, docType, id, number, status, linkedDocuments},
  customer: {...}, lines: [{id, itemId, description, qty, unitPrice, physicalHint, ship}],
  origin / destination / cargo / accessorials / instructions / references: each Field<T> =
        { value, origin: "erp"|"document-ai"|"memory"|"default"|"user", confidence?,
          conflict?: { erpValue, reason } },      // set when the document overrode the ERP
  cargo value = [{ packagingType, pallets, weight, length, width, height, ... }],   // pallets per type
  attachments: [...], warnings: [...] }
```

### 3.3 Frontend: a flexible ERP layer (delivered as a brief; I do not edit the frontend)
- One server-only Hub client (`PRIVATE_ERP_HUB_URL` + `PRIVATE_ERP_HUB_KEY`), same pattern as `PRIVATE_API_URL`.
- Provider registry + capability flags from `GET /v1/providers`; no `if (provider === 'quickbooks')`.
- Reuse existing quote/booking/BOL components, prefilled from the seed; they keep calling the core as today. After a successful booking, the frontend calls the Hub's `booked`.
- Routes under `/integrations/[provider]/…`; a route `/shipments/<uuid>` that the QBO link opens (login, then return to the shipment); per-company gating.

### 3.4 Trust between the frontend and the Hub (no Hub → core connection)
- The Hub is called **only by the frontend's server routes**, never by the browser. Each call carries a **shared secret** (`X-ERP-Hub-Key`, compared in constant time; stored in the Hub's Secrets Manager and in the frontend's private environment; rotated periodically) and the **BiziShip company id** (`X-BiziShip-Company-Id`) plus the user's email for audit (`X-BiziShip-User-Email`).
- The frontend must take the company id from a **core-verified session** (for example the result of the `/auth/me` it already calls), never from anything the browser sends.
- The Hub scopes everything (the ERP connection, documents, links) by that company id. It does not verify the user's JWT and does not call the core.
- Why this is acceptable: the frontend server already holds every user's session, so it is the same trust boundary. The link written to QuickBooks contains only a shipment UUID, and access control happens when the link is opened in the app.
- **Later (chatbot):** if the core's chatbot needs ERP data, the core would call the Hub with its own credential. That is a new, reverse connection, added only when needed.

### 3.5 Production hosting and storage

**Language:** Node.js / TypeScript (developed on Node 22).

**Hosting: AWS Lambda behind the existing load balancer** (matches the diagram and how the ERP Gateway is deployed; recommended). With the Hub no longer proxying 20–90 s bookings, every operation is short (OAuth, document reads, one memo write, webhook ack), traffic is low and spiky, and Lambda costs almost nothing. The same Fastify code runs locally and on Lambda through an adapter. ECS Fargate remains the fallback if volume, long-running jobs or in-memory state ever require it; storage sits behind an interface and the HTTP code does not change. *Pending final confirmation by the product owner.*

What Lambda requires of the design:
- **Token refresh is lease-based, not in-process:** QuickBooks rotates refresh tokens, so concurrent refreshes from two instances could invalidate each other. A short DynamoDB lease (conditional write), re-read after acquiring it, replaces the in-process single-flight lock.
- **Single-use OAuth state and webhook de-dup** live in DynamoDB items with TTL.
- **Link-write retries** run through SQS or an EventBridge schedule, not an in-process timer.
- Cache is warm-instance only; acceptable.

**Storage: DynamoDB — no relational database.** The Hub keeps only what it cannot get back from anywhere else:
- the **connection record per company** (`realmId`, KMS-encrypted access/refresh tokens, status) — the refresh token is the only copy;
- the **document ↔ shipment link and link-write state** (idempotency, "written / failed");
- short-TTL items (OAuth state, webhook de-dup, refresh lease).

Not stored: shipments, quotes, BOLs (BiziShip owns them), customer documents (read live from QuickBooks).

**Secrets and encryption:** Intuit client secret and the frontend shared secret in Secrets Manager; KMS for token encryption (replaces the local key in `.env`). Production adds a DynamoDB implementation of `ConnectionStore` (Phase 6).

---

## 4. Shipment data sources and merging

QBO alone is not enough (no cargo data, thin addresses, no contacts).

| Source | Typically provides |
|---|---|
| **ERP document** (QBO Estimate/Invoice + Customer + CompanyInfo) | Customer, lines/amounts, references, `ShipAddr`, company default address |
| **Customer-side logistics document, parsed by AI** | Origin, destination, contacts, phones, instructions/accessorials, **cargo: pallets per type, weight, W×L×H** |
| **BiziShip memory** | Address history, saved freights |
| **User** | Final say on every field |

**Rules** *(decided 2026-11-15)*
1. **The document wins, and disagreements are never silent.** Precedence: **user edit > customer document > ERP > memory/defaults.** A conflicting field is flagged "differs from QuickBooks", showing the ERP value, switchable in one click.
2. **Human review before quoting:** provenance on every field, confidence indicators, missing required fields highlighted.
3. **AI lives in the core.** The Hub never calls an LLM. The frontend fetches the attachment from the Hub, sends it to the core's extraction, and merges the result into the seed on its side (the Hub's seed already has the right slots).
4. **Validate** every address with BiziShip's existing validation; normalise accessorials to BiziShip codes.
5. **Remember** confirmed values using BiziShip's existing mechanisms.

**Working assumption:** the customer document supplies origin, destination and cargo. Its layout/format/location are **not known yet**, so parsing is stubbed (mock seeds); the Hub contract, frontend, and merge rules don't depend on it.

---

## 5. Customer journey

### 5.1 One-time: connect
1. **Integrations → QuickBooks → Connect** (Frontend → Hub).
2. Intuit consent (scope `com.intuit.quickbooks.accounting`); a QBO admin approves and picks the company.
3. Callback to the Hub: exchange code, store tokens encrypted, link `realmId` ↔ the BiziShip company id carried in the signed OAuth state (set when the frontend started the connection).
4. Optional setup: default origin (prefilled from `CompanyInfo.CompanyAddr`).

### 5.2 Per shipment
1. **Pick a document** (open Estimates / Invoices; a `Closed` estimate → its linked invoice).
2. **Seed** from the Hub: ERP data + customer document (§4) + memory; user ticks which lines ship.
3. **Review** (provenance chips, conflicts, address validation, accessorials, cargo).
4. **Quote and book** through the existing flow (frontend ↔ core), carrying the QBO references.
5. Frontend calls Hub `booked` → Hub writes the **BiziShip shipment link** onto the QBO document → frontend shows "linked in QuickBooks" (or retry).

---

## 6. Field mapping (QuickBooks adapter → ShipmentSeed → BiziShip)

| BiziShip field | Primary source | Fallbacks |
|---|---|---|
| Destination street/city/state/ZIP | Customer document (AI); if `ShipAddr` differs, document wins and the difference is flagged | `ShipAddr` → structured `BillAddr` → user types |
| Destination country | `CompanyInfo.Country` default | document |
| Destination company / contact / phone / email | Customer document (AI) | Customer record (parent's `CompanyName` if `Job:true`, names, phones, email) |
| Origin | Customer document (AI) | Setup default (`CompanyInfo.CompanyAddr`); BiziShip address history |
| Accessorials / instructions | Customer document (AI) | user |
| Cargo lines | Customer document (AI) | user |
| `po_number` | Document (AI) or user | `DocNumber` if the customer uses it that way |
| `reference_number` | `<DocType> <DocNumber>` (display only) | stored link uses QBO `Id` |
| `sales_order` | Estimate `DocNumber` | |

---

## 7. Hub design essentials

### 7.1 Write-back: the shipment link only — *never surprise the customer's books*
1. **Read before write**: fetch the document, check `SyncToken`, update; on a stale token re-read and retry once, else report to the user.
2. **What is written:** one line in `PrivateNote` (shown in QBO as "Memo on statement (hidden)"; not on the invoice or estimate itself, but it **can print on the customer's statement**): `BiziShip shipment: https://app.biziship.ai/shipments/<UUID>`. Existing memo text is preserved; one line per shipment; an identical line is never duplicated (`src/providers/quickbooks/link.ts`, unit-tested). The line is plain text in QuickBooks (not clickable; the user copies it).
3. **Never written:** `CustomerMemo` (prints on the customer's copy), line items, amounts, attachments (including note-only `Attachable`, which is invisible to users), tax, status.
4. **Allowed on any document status** (verified on a paid invoice). **If QuickBooks rejects the update** (legacy-data validation, HTTP 400), the link state is `failed` with the reason shown to the user; the link remains in BiziShip. There is no fallback place that is both visible and safe.
4a. **Per-company switch `writeLinkToMemo`** in the provider's self-describing setup, **on by default**, with a note shown when connecting ("BiziShip adds one line to the document's Memo on statement, which can appear on customer statements"). Off = the Hub keeps the link in its own store only.
5. **Idempotency:** `(realmId, docType, docId) → shipmentUuid` + state; re-running never adds a second line.
6. **Failure isolation:** a link-write failure never affects a booking; it is shown as "not yet linked" with a retry.
7. **Security:** the URL carries only the shipment UUID; the frontend requires login and enforces company access when the link is opened. The Hub writes the link only into the connected company's own QuickBooks document.
8. **Reverse link (frontend feature):** "Open in QuickBooks" via `<host>/app/invoice?txnId=<Id>` and `<host>/app/estimate?txnId=<Id>`. **Verified in the sandbox** with host `https://sandbox.qbo.intuit.com`; the production host (`https://qbo.intuit.com`) is to be verified. The Hub returns the finished `erpUrl`, so the frontend never builds it.

### 7.2 Authentication and tokens
OAuth2 authorization-code flow; per company store `realmId`, access/refresh tokens (KMS-encrypted), expiries, BiziShip company id. Refresh early, **persist every new refresh token**, per-connection lease/single-flight. On failure → `needs_reconnect`, banner in BiziShip. Two separate layers: the frontend↔Hub shared secret (§3.4) and the ERP's OAuth.

### 7.3 Storage
See §3.5. `connections` (tokens, status) and `document_links` (document ↔ shipment UUID, link state), keyed per BiziShip company.

### 7.4 Webhooks, jobs, limits, security
Verify the ERP's webhook signature, ack fast, dedupe by event id; retry jobs for link writes and token refresh. Back off on 429; page and limit queries; logs carry realm/request ids, never tokens or document contents; secrets only in Secrets Manager; minimum scopes; strict per-company isolation.

---

## 8. Changes needed in other repos (briefs only)

| Repo | Change | Size |
|---|---|---|
| **ERP Gateway** | None | — |
| **Core backend** | None required by the Hub. Possible small items, to be answered by the Backend agent (§9): tagging ERP-originated shipments, booking idempotency, per-company feature flag, extraction of customer-document types | Small / depends |
| **Frontend** | Provider-neutral ERP layer (§3.3): Hub client, registry/capabilities, `/integrations/[provider]` pages, prefill review with provenance chips, existing quote/booking/BOL components prefilled from the seed, extraction call for the customer document, `booked` call after booking, `/shipments/<uuid>` deep link, ERP channel badge | Medium; brief (`docs/FRONTEND_BRIEF_ERP_INTEGRATION.md`) |

---

## 9. Questions for the Backend agent (see `docs/DESIGN_FOR_BACKEND_REVIEW.md`)
1. How should ERP-originated shipments be tagged (`X-Client-App`, an explicit source field)? Any place for the source document reference beyond `sales_order` / `reference_number` / `additional_references[]`?
2. Does booking accept an idempotency or client reference key?
3. Is there a per-company feature flag mechanism for "ERP mode"?
4. Is `https://app.biziship.ai/shipments/<UUID>` safe as a link stored in a third-party system?
5. Which shipment fields are mandatory for quote and booking?
6. Can the BOL extractor be reused for the customer's logistics document, or is it a new type?
7. Risks and objections.

---

## 10. Phased plan

| Phase | Deliverable | Exit test |
|---|---|---|
| 0 | Intuit sandbox verified (§2.1) | Done |
| 1 | Hub skeleton + QuickBooks OAuth connect, encrypted tokens, refresh | **Done 2026-11-15** |
| 2a | **Sandbox link experiment** | **Done 2026-11-17** — link goes in `PrivateNote` only (§2.1, §7.1) |
| 2b | **Frontend-to-Hub auth** (shared secret + company id; replaces the dev auth); QuickBooks read side: list documents, ShipmentSeed with mock document seeds, attachments; setup; OpenAPI contract; revised briefs | Seed for sandbox docs matches §6; wrong secret rejected |
| 3 | `booked` + link write (idempotent, stale-token); frontend builds against a mock Hub in parallel | Re-run twice → exactly one link line; unknown company rejected |
| 4 | Frontend applied; end-to-end with a BiziShip sandbox account | Estimate → review → quote → book → link on the QBO document |
| 5 | Webhooks, reconnect UX, monitoring, "ugly data" cases; customer-document extraction when the sample exists | Edit in QBO → list updates; ugly docs don't crash |
| 6 | Production hosting (Lambda behind the load balancer, DynamoDB store with refresh lease, retries via SQS/EventBridge, KMS, Secrets Manager); Intuit production keys (privacy policy, terms, security questionnaire, branding); pilot with one real customer | Intuit approval; pilot ships |
| later | Sage adapter; **AI chatbot tools** (read-only, tenant-scoped; writes need user confirmation; core → Hub credential) | |

---

## 11. Real-customer data readiness
The sandbox is clean; real books are not. Design for: missing `ShipAddr`/phone/email, empty `DocNumber`, typos and non-US addresses, nested sub-customers, inactive customers, discount / subtotal / description-only / grouped lines, part-paid invoices, multi-currency, plan-dependent features (`OfferingSku`), large volumes (paged queries). Every mapping is optional with a "user fixes it" fallback. Before Phase 5, create deliberately ugly sandbox documents.

---

## 12. Decisions and open items

**Decided:** Hub (this repo) connects only to the ERP and the frontend; the frontend calls the core directly for quote/book/BOL/tracking and the Hub for ERP matters only; **no Hub ↔ core connection and no ERP Gateway** for QuickBooks; frontend↔Hub trust by shared secret + company id; document wins on conflict with a visible flag; document supplies origin/destination/cargo (parsing deferred); Estimate + Invoice; private/sandbox first; **the only write to QuickBooks is the BiziShip shipment link**; Node/TypeScript; DynamoDB (no relational DB).

**Open:**
- Hosting: Lambda (recommended, shown in the diagram) vs ECS Fargate — pending final confirmation.
- Backend answers (§9).
- Contract v1 details agreed with the frontend (handle bound to the first shipment, `shipmentLinks[]`, version check, 4 MB attachment cap, shared-secret auth with two active values) — to be written into the contract document and OpenAPI file.
- Customer document: type, format, location; extraction approach (deferred).
- Move the Intuit developer account to a company mailbox before production; rotate the sandbox client secret (it was shown in a session transcript).
- Packaging/pricing; which QBO plan tiers to support.
