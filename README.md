# Red Cedar Electric — CRM and field app

The business system for Red Cedar Electric, an electrical contractor: a CRM for the office (leads, estimates, jobs, invoices, purchasing, price book) and a separate field app for technicians on site.

## Stack

- Backend: Node and TypeScript, Express 5, Prisma 5 on PostgreSQL (`npm run dev` runs `tsx src/server.ts`).
- CRM (office): `client/`, a Vite single-page app.
- Field app (technicians): `field/`, a separate Vite PWA.
- `shared/`: the contract between the backend and both front ends (checklist, NEC load calculation, estimating rules, agent scopes and events). A change to a data shape that crosses client/server or field/server is made here and on both sides together.
- Database shape: `prisma/schema.prisma` is the single source of truth.
- Deploy: Railway. `npm start` runs `prisma migrate deploy`, a seed script, then the compiled server.

## Commands (run from this folder)

| Command | What it does |
|---|---|
| `npm run dev` | Run the API server (`tsx src/server.ts`) |
| `npm run dev:client` | Run the CRM front end |
| `npm run dev:field` | Run the field app |
| `npm run build` | Full production build: both front ends, `prisma generate`, then `tsc` |
| `npm test` | Root test suite (`vitest run`); needs a local PostgreSQL with an `rce_crm_test` database |
| `npm run test:watch` | Root suite in watch mode |
| `npm --prefix field run test` | The field app's own suite (not covered by `npm test`) |
| `npm --prefix client run test` | The CRM client's own suite (not covered by `npm test`) |
| `npm run prisma:generate` | Regenerate the Prisma client after a schema change |

Configuration (database, payment, email, SMS and other credentials) comes from environment variables and is never committed.

## Agent price-book API

AI agents reach the price book through an agent key, over REST or as tools on the `/mcp` endpoint. Both run the same code (`src/agentApi/priceBookDoor.ts`), so a request means the same thing either way. An agent can read the book, add NEW items, and PROPOSE changes to existing ones. It can never edit, delete, retire or archive an existing item.

### Authentication

Send the agent key as a bearer token:

```
Authorization: Bearer <agent key>
```

Agent keys are issued and revoked by the owner in the CRM (Settings → Agent keys) and are a separate credential from every human login: a CRM session token, a technician token or no credential at all is refused 401. A real key never appears in this repository, in logs or in an answer. These routes are not public and are listed only in the agent-key route table (`src/middleware/publicRoutes.ts`, `AGENT_KEY_ROUTES`).

Every request is checked in this order: key shape and validity (401), the Agent access kill switch (503 `agents_off`; 503 `agents_read_only` refuses writes), the 60-calls-a-minute per-key limit (429), the route's scope (403 `scope_denied`), and for a write the key's "Allow writes" switch (403 `writes_disabled`). Every call is audited under the key's name.

### Scopes

| Scope | Opens |
|---|---|
| `pricebook:read` | the three GET routes and the three read tools |
| `pricebook:write` | the two POST routes and the two write tools (also needs the key's "Allow writes" switch) |

Defaults by key role (editable per key by the owner): the Inventory key holds read and write; the Admin, Outreach, Research, CFO, Facebook, Scout, NEC Coach and Claude Code keys hold read only; the "Other" role holds neither. The scope table is `shared/agentScopes.ts`.

### Routes

All paths are under `/api`. Every write requires `idempotency_key` (8 to 128 characters) in the JSON body. A body field the route does not take is refused 400 and named.

| Method and path | Scope | Purpose |
|---|---|---|
| `GET /api/agent/price-book/categories` | read | Categories with item counts and sub-categories |
| `GET /api/agent/price-book/items?search=&category=&limit=` | read | Search live items (retired items are never listed) |
| `GET /api/agent/price-book/items/:id` | read | One item; an assembly includes its parts |
| `POST /api/agent/price-book/items` | write | Create a NEW item |
| `POST /api/agent/price-book/items/:id/proposals` | write | Propose a change to an existing item |

There is no `DELETE`, `PATCH`, `PUT`, retire, archive or restore route for an agent, and the CRM's own price-book routes refuse an agent key.

**Categories** — 200: `{ "categories": [ { "name", "count", "sub_categories": [ { "name", "count" } ] } ] }`

**Search** — `search` matches an item id or name; `category` narrows to items whose category contains the text (case-insensitive substring, not an exact match: `Panel` also returns "Panels" and "Panel Accessories", so read each item's own `category`); `limit` is 1 to 200 (default 50). 200: `{ "items": [Item], "count", "total", "truncated" }`

**Item** (every read, and the 201 of a create):

```json
{
  "item_id": "A016",
  "name": "string",
  "category": "string",
  "sub_category": "string | null",
  "type": "labor | material | assembly",
  "row_type": "LABOR ONLY | MATERIAL ONLY | MATERIAL + LABOR | ASSEMBLY",
  "unit": "string | null",
  "hours": { "normal": 0.5, "difficult": 0.75, "very_difficult": 1 },
  "cost": 10.0,
  "cost_with_tax": 10.98,
  "sell": { "normal": 64.27, "difficult": 89.27, "very_difficult": 114.27 },
  "labour_source": "string | null",
  "notes": "string | null",
  "retired": false,
  "components": [ { "item_id": "A016", "name": "string", "quantity": 2 } ]
}
```

`hours` are per ONE unit; a null tier is blank and that difficulty cannot be quoted. `cost` is the pre-tax cost. `cost_with_tax` is null for an item with no cost, one not yet repriced for sales tax, and an item whose price was set by hand (the tax reprice leaves those alone), so a null on an item that has a cost is not a fault to correct. `components` appears on an assembly only.

**Create** — `POST /api/agent/price-book/items`

| Field | Type | Required | Notes |
|---|---|---|---|
| `idempotency_key` | string, 8 to 128 | yes | |
| `name` | string, up to 200 | yes | |
| `category` | string, up to 120 | yes | Matches an existing category ignoring case; a new name makes a new category |
| `unit` | string, 1 to 24 characters | yes | What ONE unit of the item is, e.g. `"each"`, `"ft"`, `"box of 25"`. `material_cost` and `hours` are PER THAT UNIT. No control characters; missing or blank is 400. See "Unit" below |
| `type` | `labor` \| `material` \| `assembly` | yes | |
| `subcategory_or_brand` | string, up to 120 | no | |
| `hours` | number, or `{ normal, difficult, very_difficult }` | `labor`: yes | A number is the Normal tier; a tier left out stays blank. Each given tier must be above 0 and at most 100 hours per unit |
| `neca_reference` | string, up to 300 | no | Edition, page, table, row. Only with `hours`. Shown in the CRM as "Labour source" |
| `material_cost` | number | `material`: yes | PRE-TAX cost of one unit. Not allowed on `labor` |
| `notes` | string, up to 2000 | no | |
| `components` | `[ { item_id, quantity } ]`, 1 to 100 | `assembly`: yes | Assembly only. See below |

**Unit** — required on every create and stored as the item's unit label (the CRM's "Unit label"); reads return it as `unit`. The estimate multiplies `material_cost` and `hours` by the quantity in that unit. A unit of `ft`, `lf`, `foot`, `feet`, `per foot`, `per ft` or `linear feet` (any capitals) groups the item with the continuous-length material the job-level material cap works on; wire, cable and conduit are also recognised by name. So send one of those spellings for wire, cable and conduit sold by the foot, and put `material_cost` and `hours` per ONE foot. A proposal cannot change the unit (`unit` is refused as an unknown field there).

Example body: `{ "idempotency_key": "wire-12-2-0001", "name": "12/2 NM-B Cable", "category": "Wire", "unit": "ft", "type": "material", "material_cost": 0.62, "hours": 0.012 }`

`labor` makes a labor-only item; `material` without hours makes a material-only item, with hours a material-plus-labor item; `assembly` makes an assembly of existing items. Response 201 is the Item. A replay of the same `idempotency_key` and request answers 200 with the first answer and creates nothing. The same key with a different request is 409 `idempotency_conflict`; the same request while the first is in flight is 409 `in_progress`.

A new item whose name is the same name said differently in the same category (same words, same sizes and amps; case, spacing, punctuation and word order ignored; items naming different brands are not twins) is refused 409 `duplicate_item` with the existing item in `existing_item`. A name that merely contains another ("20A Breaker GFCI" beside "20A Breaker") is accepted.

**Assemblies** — `components` lists live, priced, non-assembly items, each once, each `quantity` above 0. Cost and hours roll up from the parts, so an assembly takes no `material_cost`, `hours` or `neca_reference`. A labor-only item has no material cost and cannot be a component; a retired or unknown item is refused.

**Propose** — `POST /api/agent/price-book/items/:id/proposals`, body: `idempotency_key` plus any of `name`, `material_cost` (pre-tax), `hours` (a number, or tiers as above); `neca_reference` is not a proposal field and is refused 400 as unknown, and approving new hours clears the item's existing "Labour source". A tier left out is left as it is. For an assembly only `name` may be proposed. 201: `{ "proposal_id", "item_id", "status": "pending_approval", "waiting_for", "changes": [ { "field", "before", "after" } ] }`. The proposal is a "Price book change" card in the CRM (Messages → Waiting for approval) showing the before and after, the new sell prices and every assembly the change moves. Nothing in the book changes until a person holding the CRM power "Change price book prices, hours and names" approves it; reject closes it. Both decisions are recorded in the item's history.

### Errors

Every refusal is `{ "code", "reason", "retryable" }` (plus `retry_after` seconds, and `existing_item` on a duplicate).

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | A field is missing, unknown or out of range; `reason` says which and why |
| 401 | `unauthenticated`, `key_revoked`, `key_expired`, `key_retired`, `key_wrong_environment` | The credential is not a live agent key |
| 403 | `scope_denied`, `writes_disabled` | The key lacks the scope, or its "Allow writes" switch is off |
| 404 | `not_found` | No such item |
| 409 | `duplicate_item`, `idempotency_conflict`, `in_progress` | See above |
| 429 | `rate_limited` | More than 60 calls a minute for the key |
| 503 | `agents_off`, `agents_read_only`, `not_configured` | Agent access is off, read-only for writes, or not configured |

### MCP tools

`POST /mcp` takes one JSON-RPC call per request (stateless; GET and DELETE are 405). The price-book tools call the same cores as the routes:

| Tool | Scope | Equivalent route |
|---|---|---|
| `list_price_book_categories` | read | `GET /api/agent/price-book/categories` |
| `search_price_book` | read | `GET /api/agent/price-book/items` |
| `get_price_book_item` | read | `GET /api/agent/price-book/items/:id` |
| `create_price_book_item` | write | `POST /api/agent/price-book/items` |
| `propose_price_book_change` | write | `POST /api/agent/price-book/items/:id/proposals` |

There is no delete, retire, archive or edit tool.

### Pricing

Agents send the PRE-TAX material cost. The server computes everything else, in one place (`computePricing` in `src/services/priceBookCatalog.ts`):

```
cost_with_tax  = round2(cost × (1 + sales tax rate))
material price = round2(cost × (1 + sales tax rate) × markup multiplier)   rounded once
sell (tier)    = round2(hours(tier) × shop rate + material price)
```

- The sales tax rate is the company setting Settings → Purchasing (default 9.75%). The shop rate is Settings → Billed labor rate. Both are read at the time of the write; saving a different tax rate reprices the book, leaving hand-priced items alone. Issued and signed estimates and invoices are never changed.
- The markup multiplier is chosen from the PRE-TAX cost: under 1, 1 to under 10, 10 to under 50, 50 to under 200, 200 and over (the multiplier is 1.30 for each today).
- A material-only item sells at the material price. A labor-only item sells at hours × shop rate. A tier with no hours has no sell.
- An assembly is taxed once, on its rolled-up pre-tax cost.
- Worked example (tax 9.75%, shop rate $100, multiplier 1.30): cost $10.00 → cost with tax $10.98 → material price $14.27; 0.5 h → sell $64.27 (0.75 h → $89.27; 1 h → $114.27). Pinned in `tests/priceBookTaxInSell.test.ts`.

### Hours

Hours are typed by the agent from its own NECA labor-unit library, as three tiers (Normal, Difficult, Very difficult) in hours for ONE unit; the agent converts per-100 or per-1000 values. The server does not look hours up and does not check them against NECA.

### Events

When an agent adds an item or proposes a change, signed webhook events go to every agent role that is a webhook target (`admin`, `inventory`, `facebook`, `outreach`, `scout`, `research`, `cfo`, `nec_coach`) and has a live key holding `pricebook:read`, except the role of the key that acted. The `claude_code` and `other` roles are not webhook targets: a Claude Code key can read the price book but never receives these events. Addresses are set per agent role by the owner in the CRM (Settings → Agent webhooks). The body is JSON with `timestamp` and `signature` as its last two members; the signature is `sha256=` plus the hex HMAC-SHA256, keyed with that agent's signing secret, over `<timestamp>.<payload>` (the body without those two members). The same values are sent in the `X-RCE-Timestamp` and `X-RCE-Signature` headers. Reject a timestamp more than 5 minutes old. Failed deliveries are retried.

| Event | Fields besides `timestamp` and `signature` |
|---|---|
| `pricebook.item_created` | `event_id`, `type`, `occurred_at`, `item_id`, `name`, `category`, `unit`, `item_type` (labor, material or assembly), `cost`, `cost_with_tax`, `sell` (`normal`, `difficult`, `very_difficult`), `summary` |
| `pricebook.change_proposed` | `event_id`, `type`, `occurred_at`, `proposal_id`, `proposed_by`, the item fields above (as the item stands now), `before` and `after` (only the proposed fields: `name`, `cost`, `hours_normal`, `hours_difficult`, `hours_very_difficult`), `summary` |

Events carry the item's own name and numbers and no customer data. A repeated `event_id` is a repeat.

### Audit

Every agent create and proposal is recorded three ways: the item's price-book edit history (with the key's name), the agent audit log (key, time, result) and the CRM's message audit log.
