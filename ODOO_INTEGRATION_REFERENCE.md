# BiziShip.ai on Odoo — Reference for the QuickBooks Integration

This document briefs a coding agent starting the **BiziShip on QuickBooks** project with no
prior context. It explains what BiziShip.ai does, how the existing Odoo integration works end to
end, and — critically — where QuickBooks Online's platform differs from Odoo's in ways that
change the architecture. Read the last section before writing any code: the Odoo approach
(embedding UI directly into the host ERP's native screens) is **not available on QuickBooks
Online**, so this isn't a straight port.

---

## 1. What BiziShip.ai Is

BiziShip.ai is a freight brokerage platform. It gets LTL (less-than-truckload) and FTL
(full-truckload) carrier quotes at enterprise rates (typically ~15% below published prices),
lets a user compare and book a shipment in one click, and automates the paperwork around that
(BOL extraction, tracking, documents, shipment photos).

The **product** is `app.biziship.ai` — a mature, standalone web app that already does all of
this on its own. The **Odoo integration** is a thin client: a custom Odoo module
(`biziship`) that lets an Odoo user do the same quoting/booking workflow without leaving their
Sales Order screen, by calling the same backend the standalone app calls.

**For the QuickBooks project: the standalone web app is almost certainly the right UI to reuse
or extend**, not something to rebuild. See §5.

---

## 2. Use Cases Covered Today (on Odoo)

These are the functional capabilities the Odoo module exposes, each backed by the ERP Gateway
(§4). Any ERP integration — Odoo, QuickBooks, NetSuite — needs to answer the same underlying
job-to-be-done; only the UI plumbing changes per host.

1. **LTL/FTL quoting** — user enters origin/destination addresses, pickup/delivery contacts,
   cargo details (packaging, pieces, weight, dimensions, freight class, NMFC code, hazmat/
   stackable/used/machinery flags) and accessorial services (residential pickup/delivery,
   liftgate, limited access, appointment, notify-before-delivery, hazmat), then fetches live
   carrier quotes.
2. **Quote comparison & booking** — compare carriers, transit days, and total charges;
   select a quote and confirm/book with one action.
3. **AI-powered BOL extraction** — upload a Bill of Lading PDF; the backend parses it and
   auto-populates freight details. This is async: the gateway returns `202 + jobId`, the client
   polls (15s timeout) until the job resolves.
4. **Saved freight templates** — save the current freight configuration to the user's company
   pool in BiziShip's cloud, and reload a saved template later to speed up repeat shipments.
   Includes address history (reuse previous origin/destination addresses).
5. **Shipment tracking** — after booking, refresh and display carrier tracking status,
   PRO number, and shipment documents (BOL, labels, etc.) inline.
6. **Shipment photos** — attach photos to free-form "pallet" labels on a *booked* shipment
   (not derived from cargo lines — a pallet here is just a name the user assigns, up to 3
   photos each). Upload/view/delete/download, single-image or ZIP download. This is a
   post-booking, documentation-only feature (claims support, proof of condition, etc.).
7. **Company account balance** — a read-only, once-daily snapshot of the company's BiziShip
   account balance, shown with its "as of" date (never implied real-time). No polling, no
   history/trend — just the latest number with its date, shown only where quoting/booking
   happens, not globally.
8. **Account linking / auth** — a user connects their Odoo session to a BiziShip account via
   email + one-time PIN (not the Odoo login — BiziShip's own identity, which may differ from
   the Odoo user's login email). This produces a JWT used for all subsequent calls.
9. **AI carrier recommendation, quote markup/margin pricing, quotes report export/email** —
   secondary features layered on top of the core quoting flow; markup config is fetched
   per-company from the gateway and applied client-side when generating reports/emails.

**What makes the Odoo version valuable to a customer specifically:** the customer never leaves
their ERP. Cargo details, addresses, PO numbers, and (where relevant) warehouse data already
live in Odoo's own Sales Order / Partner / Stock models, so BiziShip's quoting UI can read them
directly instead of asking the user to re-type everything. This is the value prop to try to
preserve on any new ERP — see §5 for why it doesn't transfer cleanly to QuickBooks.

---

## 3. How the Odoo Integration Is Built

High-level structure of the `biziship` Odoo module (for context on *what* the Odoo side looks
like — not something to replicate structurally on QuickBooks, since Odoo's module system has no
QuickBooks equivalent):

```
biziship/
├── __manifest__.py              # module metadata
├── api_utils.py                 # API URL resolver, ERP API key resolution, constants
├── models/
│   ├── sale_order.py            # ~50 extra fields on Sale Order: addresses, cargo refs,
│   │                             #   quotes, booking IDs, connection status, etc.
│   ├── biziship_cargo_line.py   # cargo line model (packaging, weight, dims, class, NMFC)
│   ├── biziship_quote.py        # fetched carrier quote model
│   ├── biziship_accessorial.py  # accessorial service codes
│   ├── company_balance.py       # plain helper (not an Odoo model) wrapping the balance call
│   ├── quotes_markup.py         # plain helper wrapping the markup-config call
│   └── res_users.py             # BiziShip auth fields on the Odoo user (token, email, name)
├── wizards/                     # TransientModels backing popup dialogs: auth (PIN login),
│   │                             #   fetch-quotes, confirm-booking, BOL upload, save/load
│   │                             #   freight, tracking, shipment photos, etc.
├── views/
│   └── sale_order_views.xml     # inherits & extends the native Sale Order form — new tabs,
│                                 #   buttons, inline quote lists, status badges
├── controllers/main.py          # HTTP routes for things that need raw binary responses
│                                 #   (ZIP downloads, image proxying) rather than JSON-RPC
└── static/src/{js,css}/         # client-side JS for tab switching, autocomplete, click
                                  #   handlers on dynamically-rendered HTML fields
```

**The key mechanism that makes Odoo's deep integration possible and has no QuickBooks
equivalent:** `views/sale_order_views.xml` uses Odoo's *view inheritance* — it takes Odoo's own
native Sale Order form (`sale.view_order_form`) and patches new tabs, fields, and buttons
directly into it via XML `xpath`. The customer's Sale Order screen *is* BiziShip's UI; there's
no separate app to open. Every other ERP-specific detail in this codebase (field names, Python
model structure, XML view syntax) is Odoo plumbing — skip it unless you're specifically trying
to understand how a given use case's data model was shaped, and look at §4 instead for the part
that actually matters to a new integration: the gateway contract.

---

## 4. The ERP Gateway — What Actually Needs Porting

This is the part of the architecture that **is** reusable across ERPs: the Odoo module is a
thin client over BiziShip's **ERP Gateway**, a backend layer that sits in front of BiziShip's
core platform and speaks a stable HTTP/JSON contract. A QuickBooks integration should talk to
this same gateway, the same way the Odoo module does and the way `app.biziship.ai` itself does.

### Base URL & environment
Resolved via `api_utils.get_biziship_api_url(env)` on the Odoo side — in practice this is an
environment-configurable base (dev vs. prod gateway host), stored as an Odoo system parameter
with a fallback chain (system param → config file → OS env var → local secrets file for dev
only). On QuickBooks there's no Odoo system-parameter store, so this just becomes an app-level
config value (env var / secrets manager), same idea.

### Authentication — three headers on every `/erp/*` call
```
X-ERP-API-Key: <tenant-level key, server-to-server>     # required on every call
X-User-Email: <the BiziShip-registered email for this user>
Authorization: Bearer <JWT>                               # present once the user has linked
                                                            #   their BiziShip account
```
- `X-ERP-API-Key` identifies *which ERP integration* is calling (Odoo vs. QuickBooks vs. the
  web app would each get their own key) — this is a tenant/app-level secret, never per-user.
- `X-User-Email` / the Bearer JWT scope the request to a specific BiziShip company/user. The
  gateway resolves "which company" from these, the same way it would for any client.
- **Important bug class to avoid (hit twice in the Odoo codebase):** always send the
  *BiziShip-registered* email, not the host ERP's own login email — these can differ when a
  user authenticates to BiziShip with a different address than they use to log into the host
  app. Store BiziShip's email/token separately from whatever identity QuickBooks itself uses.
- The BiziShip login flow itself (independent of which ERP it's embedded in): user requests a
  PIN to their email (`POST /erp/auth/login`), submits it (`POST /erp/auth/verify-pin`), gets
  back a JWT + display name + environment flag, which the client stores and attaches to all
  subsequent calls. This flow is ERP-agnostic and should be reusable as-is for QuickBooks —
  it's just "connect your BiziShip account," independent of QuickBooks' own OAuth.

### Known endpoints (what the Odoo module actually calls)
| Endpoint | Purpose |
|---|---|
| `POST /erp/quote` | Fetch LTL/FTL carrier quotes |
| `POST /erp/book` | Book a shipment / confirm a selected quote |
| `POST /erp/bol/extract` | Submit a BOL PDF for AI extraction — returns `202 + jobId`; poll for completion (observed 15s client-side timeout) |
| `GET /erp/saved-freights` | List saved freight templates for the company |
| `POST /erp/auth/login` | Request a login PIN by email |
| `POST /erp/auth/verify-pin` | Verify PIN, receive JWT + user info |
| `POST /erp/validate-address` | Smarty residential address validation |
| `GET /erp/company/markup-config` | Per-company quote markup/margin rules |
| `GET /erp/company/balance` | Daily account-balance snapshot (`{balance, asOfDate}`, both `null` together when nothing to show — don't try to distinguish *why*; never show a balance without its "as of" date; no polling, no history) |
| `GET/POST /erp/shipments/:id/pallets` | List/create free-form pallet labels on a booked shipment |
| `PATCH/DELETE /erp/shipments/:id/pallets/:palletId` | Rename/delete a pallet |
| `POST /erp/shipments/:id/pallets/:palletId/images` | Upload a photo (multipart, field name `file`; max 3 photos/pallet, JPEG/PNG/WebP only, ~1600px/JPEG-q85 downscale recommended, <4.5MB after downscale) |
| `DELETE /erp/shipments/:id/images/:imageId` | Delete a single photo |
| `GET /erp/shipments/:id/images/zip` (optional `?palletId=`) | Download all/one-pallet's photos as a ZIP |

**Known gateway quirk to design around:** the `/images/zip` endpoint has been observed returning
a base64-encoded body while still claiming `Content-Type: application/zip` (an API
Gateway/Lambda binary-media-type misconfiguration on the backend). The Odoo client works around
this by detecting non-`PK`-prefixed content and base64-decoding before serving to the browser.
Worth checking whether this is still present when building the QuickBooks client, and worth
raising with the BiziShip backend team regardless since it affects every consumer of that route.

### Error handling convention
- `400` / `409` responses carry a `detail` field with a human-readable message — pass it
  through verbatim to the end user rather than showing a generic error (e.g. the 3-photo-max
  and unsupported-format cases on the pallet-photos endpoints).
- Non-fatal lookups (markup config, account balance) are designed to be swallowed silently on
  any non-200 response — treat "no data" and "the call failed" identically; never surface a raw
  exception for these, just omit the UI element.
- `/erp/shipments/:id/...` routes need the shipment's **UUID**, not a display/reference number
  — on the Odoo side this tripped up implementation twice (the field that *looks* like the
  shipment ID actually isn't the UUID). Confirm which field in whatever `/erp/book` response
  you store actually holds the UUID before wiring any shipment-scoped call.

### Shipment ID resolution fallback
If an ERP integration doesn't already have a shipment's UUID stored locally, it can be resolved
from a known BOL number: `GET /erp/shipments?bolNumber=<BOL>&limit=1`.

---

## 5. Why This Doesn't Port Directly to QuickBooks — Read Before Designing

Researched directly against Intuit's QuickBooks Online platform before this project started.
Key findings, so you don't re-derive them:

1. **No UI-embedding mechanism exists on QBO.** Odoo's integration works by literally patching
   new tabs/fields/buttons into the native Sale Order screen. QuickBooks Online has nothing
   equivalent — every third-party QBO app is a fully separate standalone web app connected via
   OAuth2, with its own UI living outside QuickBooks' own screens entirely.
2. **No true multi-warehouse inventory, even on QBO Advanced.** What QBO calls "Locations" is,
   at the API level, the `Department` resource — a transaction-tagging dimension for
   sales/expense *reporting* only, explicitly not extended to inventory. `Item.QtyOnHand` is a
   single global number, not broken out per warehouse. If a customer has real multiple physical
   warehouses, that data lives in a separate bolt-on tool, not in QBO.
3. **Unconfirmed whether a true `SalesOrder` API entity exists** distinct from `Estimate` — this
   needs direct verification in a QBO sandbox (API Explorer or a raw query against
   `/v3/company/{id}/query?query=SELECT * FROM SalesOrder`) before any design assumes it.
4. **Custom fields via the API are capped at 3 string fields**, regardless of plan tier — not
   enough to hold cargo-line-level detail. Store that detail in BiziShip's own system (same as
   today), link it to the QBO Invoice/Estimate by ID in one of those 3 fields.
5. **Market reality:** QBO is near-universally treated as the accounting system of record only.
   Even QBO customers with heavy inventory usage don't get real per-warehouse stock data out of
   it (per point 2) — operational detail for manufacturers/wholesalers/forwarders typically
   lives in a separate OMS/WMS/TMS that syncs a finished transaction into QBO afterward.

**Practical implication:** the pragmatic design is *not* "build inside QuickBooks" but "connect
`app.biziship.ai` (or a dedicated QBO-facing variant of it) to QuickBooks via OAuth2, use it as
the actual UI for quoting/booking/shipment management, and sync the minimum necessary data back
into QuickBooks as an Invoice/Estimate line item + the 3 available custom fields" — the same
pattern established shipping-app integrations (ShipStation, StarShip) already use successfully
with QuickBooks. Confirm this framing is still the intended approach before building; if the
product direction has since changed, this document's §5 is the part most likely to be
out of date.

---

## 6. Suggested First Steps for This Repo

1. Confirm with the user which of the architecture options in §5 is the actual target (thin
   sync layer off the existing web app vs. something deeper) before writing code.
2. Register an Intuit Developer account + sandbox company; verify the open questions in §5
   (true `SalesOrder` entity, current custom-field limits) directly against the sandbox/API
   Explorer rather than assuming.
3. Build the OAuth2 "Connect to QuickBooks" flow first, independent of BiziShip's own
   email+PIN login (§4) — these are two separate identity layers that both need to exist.
4. Reuse the ERP Gateway contract in §4 as-is; this backend layer is already ERP-agnostic.
