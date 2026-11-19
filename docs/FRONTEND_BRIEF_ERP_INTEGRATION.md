# Frontend brief — ERP integration layer (QuickBooks Online first, Sage later)

You are the coding agent for the BiziShip frontend (`BiziShipFrontend1`, SvelteKit). This brief asks you to add a **provider-neutral ERP integration capability**. The first provider is **QuickBooks Online (QBO)**; **Sage** comes later and must not require redesign.

You decide *how* it looks and how it fits your existing screens, components and conventions. This brief defines **what must be possible, what the contract is, and which rules must hold.**

---

## 1. Background

BiziShip customers who run their books in QuickBooks want to ship freight **starting from a QuickBooks Estimate or Invoice**, using BiziShip's existing quote → book → BOL → tracking flow, and have a **link to the booked shipment placed on the QuickBooks document**. QuickBooks cannot embed third-party UI, so **this app is the UI**.

A new backend service, the **ERP Hub**, owns the ERP-specific side: OAuth with the ERP, tokens, reading ERP documents, building a prefilled **ShipmentSeed**, and writing the shipment link into the ERP document. It lives in a separate repo and exposes a **provider-neutral HTTP API**.

Decisions already taken (do not re-open):
- **Quote, booking, BOL, tracking, address validation, saved freights etc. keep going to the core backend exactly as they do today**, including for ERP-originated shipments. The Hub is **not** a proxy for them, and the ERP Gateway is **not** involved.
- You talk to the **Hub only for ERP matters**: connections, documents, the seed, reporting a booking, link status.
- The frontend must **never** call QuickBooks/Intuit directly. Browser → this app's server routes → Hub (ERP matters) or core (as today).
- The core backend is not extended with ERP logic. Any core change you need (e.g. a company flag) is requested through a backend brief (§8).
- The frontend has **no** ERP integration today; you are creating the layer. It must be **flexible**: adding a second provider (Sage) should be mostly registering a provider and honouring its capability flags, **not** new screens or forks.
- **The only thing written into QuickBooks is a link** to the BiziShip shipment. No freight charges, no line items, no BOL attachments.

---

## 2. What must be possible (capabilities, not screens)

1. **See and manage ERP connections** for the user's company: which providers exist, whether each is connected, connect, reconnect (when re-authorisation is needed), disconnect.
2. **Optional one-time setup per connected ERP**, driven by what the Hub returns (QuickBooks: default origin address).
3. **Start a shipment from an ERP document**: browse/search open documents (QBO: Estimates and Invoices), pick one, and arrive at the **existing** quote/booking flow **prefilled** from the Hub's seed.
4. **Review the prefilled data with provenance**: every prefilled field shows where it came from, and disagreements between sources are visible (rules in §4).
5. **Choose which document lines are physical goods to ship** (the ERP cannot reliably tell).
6. **Quote and book with the existing core flow**, carrying the document's references (§3).
7. **Report the booking to the Hub** (`booked`) right after a successful booking. The Hub writes the shipment link into the ERP document; you show the link state (`linked` / `queued` / `failed`) and offer retry. A failed link write must **never** block, undo or hide the booking.
8. **Deep link into a shipment.** The ERP document will contain `https://app.biziship.ai/shipments/<shipment UUID>` (exact route is yours to define; tell us if it must differ). Opening it must require login and, after login, land on that shipment. Enforce the normal company access rules; a shipment of another company must not be revealed.
9. **"Open in QuickBooks"** from a shipment that came from an ERP document (the Hub's `link` endpoint returns the ERP document reference; if it returns an `erpUrl`, use it; if it does not, omit the button).
10. **Remember** confirmed values where the existing app already has a mechanism (saved freights, address history); don't invent parallel storage.
11. **Roll out per company** (feature flag / company-level switch), consistent with how you gate other company-level features today. If this needs a backend flag, say so in your plan (§8).

Everything user-facing must be **provider-neutral in naming** except where it displays the provider's `displayName` from the registry.

---

## 3. Architecture requirements

- **Server-only Hub client module** (your choice of path), configured by **two private env vars**, e.g. `PRIVATE_ERP_HUB_URL` and `PRIVATE_ERP_HUB_KEY`, mirroring `PRIVATE_API_URL`. Never exposed to the browser; the browser never calls the Hub.
- **Auth to the Hub:** the Hub does **not** talk to the core and does not verify the user's JWT. Every call from your server routes carries `X-ERP-Hub-Key: <shared secret>`, `X-BiziShip-Company-Id: <company id>` and `X-BiziShip-User-Email: <user email>` (audit only). **The company id must come from a core-verified session** (for example the `/auth/me` result you already obtain), never from anything the browser sends. The Hub scopes all data by that company id.
- **Provider registry driven by `GET /v1/providers`.** UI behaviour (document types, attachments, link modes) must come from `capabilities`, not from `if (provider === 'quickbooks')`.
- **Reuse** existing screens/components (quote form, booking dialog, upload/BOL extraction, saved freights, address history, validation). The integration **prefills and annotates** them; it does not fork them. Their data calls stay as they are.
- **References and channel tag.** When booking an ERP-originated shipment, carry the references from the seed (`po`, `salesOrder`, `reference`) into the booking's `po_number` / `sales_order` / `reference_number`. How ERP-originated shipments are tagged (the `X-Client-App` / `clientApp` value, e.g. `QuickBooks`, or another field) is **being settled with the backend**; build it so the tag is one configurable value. The booking result's `biziship_id` is the shipment **UUID**; use it (not the BOL number) as the `shipmentId` you report to the Hub.
- **Bookings can be slow** (up to ~90 s; some companies asynchronous with job polling). Keep your existing patterns. Report to the Hub only after the booking has succeeded.
- **Mock Hub for development:** build and test against a **local mock of the Hub** (switchable by env/config) so your work does not wait on the real service. The mock should serve the shapes in §5, including the conflict example in §5.5 and error cases. Keep it in dev tooling, not production code paths.
- Do not log document contents, customer details or tokens.

---

## 4. Behavioural rules that must hold

1. **Sources and precedence.** A shipment's data can come from: (a) the ERP document, (b) a **customer-side logistics document parsed by AI**, (c) BiziShip memory/defaults (address history, default origin), (d) the user. Precedence: **user edit > customer document > ERP > memory/defaults.** Memory/defaults only fill what is still empty.
2. **The customer document wins on conflict, and the conflict is never silent.** When the document-derived value differs from the ERP value, use the document value **and** make the difference clearly visible to the user, showing the ERP value, with an easy way to switch to it. Applies to any field that can conflict (addresses, contacts, references, cargo).
3. **Provenance on every prefilled field** (`origin`: `erp` | `document-ai` | `memory` | `default` | `user`) and **confidence** where provided; low-confidence and missing *required* fields must stand out before quoting. Once the user edits a value it becomes `user` and is never overwritten by a refresh.
4. **The ERP cannot supply cargo data** (weight, dimensions, class, packaging). It comes from the customer document or the user. Cargo is **per type of pallet** (e.g. 3 pallets of type A at X lb and W×L×H, 2 of type B …). Make this natural in the review step and map it onto the existing quote cargo model.
5. **Customer-document parsing does not exist yet** (its form is unknown; it will be built later in the core). Until then the Hub returns seeds where those fields are absent or mocked. Build the review experience so it works with **any subset of fields present**, so that when parsing arrives nothing in the UI contract changes.
6. **Lines are not auto-classified.** Each document line has a `physicalHint` (`likely` / `unlikely` / `unknown`) — pre-select by it, but the user decides what ships. Services must not silently become cargo.
7. **Addresses from the ERP are unvalidated free text.** Run your existing address validation/residential detection on prefilled addresses before quoting.
8. **Documents can be stale or already used.** A document may be closed/converted, already linked to a shipment, or changed in the ERP since it was listed. Surface `status`, `linkedDocuments` and `shipmentLink` and handle: "already has a shipment" (offer to open it), "closed — use the linked invoice", and a re-load if the seed changed.
9. **Link states** come from the Hub: `linked`, `queued`, `failed`. Show them wherever the shipment is shown and offer retry (`link/retry`) when `failed`. Never make a link failure look like a booking failure.
10. **Connection health:** if the Hub returns `409 reconnect_required` on any call, stop the flow gracefully and offer reconnect; do not show a generic error.

---

## 5. The Hub contract (v0 — partly implemented, rest mocked)

Base URL = `PRIVATE_ERP_HUB_URL`. All calls: JSON, with `X-ERP-Hub-Key`, `X-BiziShip-Company-Id` and `X-BiziShip-User-Email` (§3). `{p}` = provider id (e.g. `quickbooks`). Unknown fields must be ignored; unknown enum values must degrade gracefully (the contract may grow).

**Errors:** `{ "error": "<code>", "message"?: string, "requestId"?: string }`. Codes to handle: `not_connected` (404), `reconnect_required` (409), `unknown_provider` (404), `quickbooks_error`/`oauth_error` (502, show `message`), `invalid_state` (400), `unauthorized` (401, wrong or missing shared secret or company id: a configuration problem, log it server-side and show a generic error), `internal_error` (500).

### 5.1 Already implemented in the Hub
| Call | Response |
|---|---|
| `GET /v1/providers` | `{ providers: [{ id, displayName, capabilities: { documentTypes: string[], attachments: boolean, linkModes: string[] } }] }` (today the Hub returns `writeBack` in place of `linkModes`; treat both as optional) |
| `POST /v1/{p}/connect` | `{ authUrl }` — send the browser to `authUrl`. After the ERP's consent the Hub redirects the browser to the configured frontend return URL with `?connected={p}` (and `?error=…` on denial/failure — currently JSON for errors; it will redirect with `error` and `message` params; handle both). |
| `GET /v1/{p}/connection` | `{ connected: boolean, status: "not_connected"\|"connected"\|"needs_reconnect", realmId?, companyName?, connectedAt?, accessExpiresAt?, refreshExpiresAt?, lastError? }` — never contains tokens |
| `DELETE /v1/{p}/connection` | `{ disconnected: boolean }` |

### 5.2 To be built (code against the mock; shapes are the contract)
| Call | Purpose |
|---|---|
| `GET /v1/{p}/setup` / `PUT /v1/{p}/setup` | `{ defaultOrigin: Address \| null }` (render from what is returned; other providers may return more) |
| `GET /v1/{p}/documents?type=&status=&q=&cursor=` | `{ items: DocumentSummary[], nextCursor: string \| null }` (paged; never assume all documents fit one page) |
| `GET /v1/{p}/documents/{id}?type=` | `ShipmentSeed` (§5.3) |
| `GET /v1/{p}/documents/{id}/attachments` | `[{ id, name, contentType, size }]` |
| `GET /v1/{p}/documents/{id}/attachments/{attId}` | The file bytes (feed them to your **existing** upload/extraction flow) |
| `POST /v1/{p}/documents/{id}/booked` | Body: `{ type, shipmentId /*UUID*/, idempotencyKey }`. The Hub does not call the core; it trusts that you report only a shipment you just booked. It stores the link and writes it into the ERP document. Response: `{ shipmentId, linkStatus: "linked"\|"queued"\|"failed", reason?, erpUrl? }`. Idempotent: a repeat with the same key returns the stored state |
| `GET /v1/{p}/documents/{id}/link?type=` | `{ shipmentId?, linkStatus, reason?, updatedAt?, erpUrl? }` |
| `POST /v1/{p}/documents/{id}/link/retry` | Body `{ type, idempotencyKey }` → same shape as `booked` |

There is **no** Hub quote, book, jobs or pass-through endpoint: those stay with the core.

### 5.3 Shapes
```ts
type Origin = 'erp' | 'document-ai' | 'memory' | 'default' | 'user';
interface Field<T> { value: T | null; origin: Origin; confidence?: number /*0..1*/;
                     conflict?: { erpValue: T | null; reason?: string } }   // present when the document value overrode the ERP

interface Address { company?: string; line1?: string; line2?: string; city?: string; state?: string;
                    zip?: string; country?: string; contactName?: string; phone?: string; email?: string;
                    residential?: boolean }

interface CargoLine { packagingType?: string; pallets?: number; weight?: number /*lb*/;
                      length?: number; width?: number; height?: number /*in*/;
                      description?: string; freightClass?: string; nmfc?: string; hazmat?: boolean }

interface DocumentSummary { id: string; type: 'estimate' | 'invoice' | string; number?: string; date?: string;
                            customerName?: string; total?: number; currency?: string;
                            status: string;                       // provider-normalised: open | closed | paid | ...
                            linkedDocuments?: { type: string; id: string }[];
                            shipmentLink?: { shipmentId: string; linkStatus?: string } }

interface ShipmentSeed {
  source: { provider: string; docType: string; id: string; number?: string; status: string;
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
  attachments: { id: string; name: string; contentType?: string; size?: number }[];
  warnings: { code: string; message: string }[];
}
```
**Key point:** the identifier you pass back (`id`) is the **ERP's own internal id** — never use the visible document number as a key (it is not unique in QuickBooks).

### 5.4 Setup is provider-shaped
Render setup from what `GET /setup` returns, so another provider can offer different options without a new screen.

### 5.5 Example seed with a conflict (use in the mock)
```json
{
  "source": { "provider": "quickbooks", "docType": "estimate", "id": "100", "number": "1001", "status": "open",
              "linkedDocuments": [] },
  "customer": { "name": "Sonnenschein Family Store", "email": "family@example.com" },
  "origin": { "value": { "company": "ACME Warehouse", "line1": "12 Dock St", "city": "Oakland", "state": "CA",
                         "zip": "94607", "country": "US", "contactName": "Dana", "phone": "5105550100" },
              "origin": "document-ai", "confidence": 0.93 },
  "destination": { "value": { "line1": "5647 Cypress Hill Ave.", "city": "Middlefield", "state": "CA",
                              "zip": "94303", "country": "US", "contactName": "Russ Sonnenschein", "phone": "6505550123" },
                   "origin": "document-ai", "confidence": 0.81,
                   "conflict": { "erpValue": { "line1": "5647 Cypress Hill Ave", "city": "Middlefield", "state": "CA", "zip": "94309" },
                                 "reason": "ZIP differs from QuickBooks ship-to" } },
  "cargo": { "value": [
      { "packagingType": "Pallet", "pallets": 3, "weight": 450, "length": 48, "width": 40, "height": 52 },
      { "packagingType": "Pallet", "pallets": 2, "weight": 300, "length": 48, "width": 40, "height": 36 } ],
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
  "attachments": [], "warnings": []
}
```
Also mock these cases: a seed with **no** document data (everything from the ERP or empty), a **closed** estimate with a linked invoice, a document that already has `shipmentLink`, `booked` returning `queued` then `linked`, `booked` returning `failed` (with retry succeeding), and `reconnect_required`.

---

## 6. What not to do
- Don't talk to QuickBooks/Intuit or any ERP directly, and don't store ERP tokens or secrets. Never expose the Hub URL or its shared secret to the browser, and never take the company id from the browser.
- Don't route quote/book/BOL/tracking through the Hub, and don't use the ERP Gateway.
- Don't fork the quote/booking screens; prefill them.
- Don't hard-code QuickBooks into logic or copy (use the registry), and don't assume document-number uniqueness.
- Don't make link failures visible as booking failures.
- Don't depend on how the customer document will eventually be parsed.

## 7. Definition of done
- With the mock Hub: connect/reconnect/disconnect, document browse/search/paging, prefill review with provenance and visible conflicts, line selection, booking through the existing core flow with references, the `booked` report and link-state display, the deep link `/shipments/<uuid>` (including login redirect), and every error case in §5.5/§4.10 behave sensibly.
- Switching `PRIVATE_ERP_HUB_URL` (and the key) from the mock to the real Hub requires **no code change** beyond configuration.
- A second provider can be added by registry data + capability flags without new screens in the common case.
- `npm run check` passes.

## 8. First, reply with a short plan
Before building, post a brief plan: how you'll structure the provider-neutral layer, where the integration lives in your navigation/routes, how you'll gate it per company (and whether that needs a **backend flag** — if so, write it as a `docs/*-backend-brief.md` in your usual style), how you'll tag ERP-originated shipments at booking, how the `/shipments/<uuid>` deep link will behave for a logged-out user, and **any objection or gap you see in the contract in §5** (we would rather fix the contract now than after the Hub is built).
