# BiziShip on QuickBooks Online: updated design, follow-up questions for the Backend agent

Status: v3, for review by the Backend agent. Please do not write code. This updates the earlier proposals after the product owner's decisions: **the ERP Hub has no connection to the core backend, and the ERP Gateway is not used for QuickBooks.** The frontend calls the core exactly as it does today. Please answer the questions in section 5 and challenge anything you disagree with.

## 1. Purpose

Bring BiziShip into QuickBooks Online (QBO) customers' daily work: a QBO user picks a sales document (Estimate or Invoice) in the BiziShip web app, BiziShip builds the shipment from it, the user quotes and books as today, and **a link to the BiziShip shipment is placed on the QuickBooks document**. The same design must later support other ERPs (Sage, others).

## 2. Components

```
 Browser -> Frontend (app.biziship.ai, server side)
              |  quote / book / BOL / tracking / document extraction: unchanged, direct to the core
              |  ERP matters only (connect, documents, seed, "booked", link status):
              v
           ERP Hub (new service, Lambda) ----> QuickBooks Online API
           (no connection to the core)
```

- **Frontend** stays the user's environment. It calls the core exactly as today, and the Hub only for ERP matters, from its server routes (a shared secret plus the company id taken from a core-verified session).
- **ERP Hub** (new, provider-neutral; QuickBooks now, Sage later) owns: ERP OAuth and tokens, reading ERP documents, building a **ShipmentSeed**, writing the shipment link into the ERP document. It never quotes, books, calls an LLM, or calls the core.
- **Core backend** gets no ERP-specific logic and no new caller from this design.
- **ERP Gateway** continues to serve Odoo and is not involved.

## 3. What QuickBooks gives us (verified in a sandbox)

- No Sales Order entity. Estimate and Invoice are the triggering documents. A converted Estimate is `Closed` and points to its Invoice.
- `DocNumber` is not unique, so a document is keyed by realmId + QBO Id.
- Lines carry no cargo data (no pallets, weight or dimensions). Item types are unreliable.
- Ship-to address is structured but has no contact name, phone or country. Bill-to is free text.
- Custom Fields via API are not available on standard plans. We use the document's internal memo (`PrivateNote`).
- Updates need read-then-update with `SyncToken`.
- OAuth2: access token about 1 hour, refresh token about 101 days and rotating.

## 4. How a shipment is built and linked

QuickBooks supplies customer, partial addresses, document number and references. Origin and destination details (contacts, phones, accessorials) and cargo (pallets per type, weight, W x L x H) are expected to come from a logistics document on the customer's side, parsed by AI. Its format is unknown, so parsing is deferred and the Hub returns mock seeds with a stable shape. The AI parsing lives in the core: the frontend would fetch the customer's attachment from the Hub and send it to the core's existing extraction.

Precedence per field: user edit > customer document > ERP > remembered values/defaults. On a conflict between the document and the ERP, **the document wins and the difference is shown to the user**. The frontend prefills its existing quote/booking screens from the seed.

Flow: pick a QBO document, get the seed from the Hub, review, quote and book against the core as today (carrying the QBO references in `po_number` / `sales_order` / `reference_number`), then the frontend calls the Hub with `booked { shipmentId }` (the shipment UUID, `biziship_id`). The Hub writes **one line into the QBO document's internal memo**: `BiziShip shipment: https://app.biziship.ai/shipments/<UUID>`. Nothing else is written into QuickBooks. It is idempotent, and a failure never affects the booking. Opening the link requires login and the normal company access rules.

## 5. Questions for the Backend agent

1. **Tagging.** How should ERP-originated shipments be tagged: `X-Client-App: QuickBooks`, an explicit source field, or something else? Is there anywhere to store the source document reference beyond `sales_order`, `reference_number` and `additional_references[]`? Does the shipments list render a channel badge from `clientApp`?
2. **Idempotency.** Does booking accept an idempotency or client reference key, so a double click or retry from the frontend cannot create two shipments?
3. **Feature gating.** Is there an existing per-company feature flag mechanism for "ERP mode"? If not, what would you add?
4. **Deep link.** Is `https://app.biziship.ai/shipments/<UUID>` safe to use as a link that is stored inside a third-party system? Any concern about exposing the UUID there, or about access control when a user opens it?
5. **Mandatory fields.** Which shipment fields are mandatory for quote and for booking, so the seed and the frontend's review step can highlight what is missing?
6. **Customer document extraction (later).** Can the existing BOL extractor be reused for a customer's logistics document (origin, destination, contacts, accessorials, pallets per type, weight, dimensions), or would it be a new type?
7. **Chatbot (much later).** If the core's chatbot should answer questions about a customer's QuickBooks data, the core would call the Hub with its own credential. Any objection to that direction, and any identity requirements you would want?
8. **Risks and objections.** What do you see that I haven't considered, and what would you do differently?

Please answer with a short design recommendation and clearly list any open questions for me.
