# Grokbot / Life Admin — human-only Approve widget

Status: **implemented** (host API + widget payload on Money Bot). This is **not** passkey/WebAuthn and does **not** wire Life Admin’s agent code (separate bot).

Date: 2026-09-08  
Related: Fable second audit N-1 (bearer `approveUrl`); Life Admin re-audit.

## Life Admin re-audit priority

| ID | Priority | This PR |
| --- | --- | --- |
| N-1 | Block before Grokbot/public ship | **Host widget path landed:** `widget` on spend tools + `POST /host/widget-decision`. `approveUrl` remains **local smoke only**. Passkey = public Cursor later. **No passkey impl.** |
| N-2 | Must-fix | Same-`merchantDomain` only. Agent `supersedes` of another domain is **rejected**. Host-only override not implemented. |
| N-3 | Must-fix | `ALLOW_TEST_AUTH` impossible/inert on production `wrangler.toml`. |
| N-4 | **P2** (real, overrated) | Minimal: 401 before `McpAgent.serve` so unauth `initialize` / `tools/list` do not allocate DOs. |
| N-5 | Must-fix (with N-2) | Drop `EXPIRED` from the 24h human-deny window. `CANCELLED` (Keep looking) also has **no** deny cooldown. |
| N-6–N-11 | P2 | Out of scope. |

Fable audit PR #9 is the docs archive. Do not merge it into this work.

## Product

Money Bot’s first real use is **Grokbot / Life Admin shopping**, not only the Cursor marketplace.

The agent **may** find products. “The agent must never help find products” is **not** the security control. The control is **segregation of duties on the decision**: only the human’s UI selection may drive Approve / Reject / Keep looking.

**Honest SoD:** Grokbot SoD depends on Life Admin using the widget + `HOST_API_TOKEN` path, **not** the model fetching `approveUrl`. `approveUrl` is still a bearer capability for local smoke. No decide MCP tool ≠ `approveUrl` is human-proof.

## SoD (same as Grokbot question widgets)

| Actor | Allowed | Not allowed |
| --- | --- | --- |
| Agent / model | Find a product, call `request_spend`, poll `get_spend_status`, later `prepare_checkout_handoff` | A decide MCP tool; fetching or POSTing `approveUrl`; synthesizing a host assertion; calling `/host/widget-decision` |
| Life Admin / Grokbot host | Render an Approve / Reject / Keep looking card from `widget`; `POST /host/widget-decision` with `HOST_API_TOKEN` | Treat tool JSON or an agent “I clicked Approve” string as a decision |
| Human | Tap Approve / Reject / Keep looking | Being implied by URL possession |

The host — not the model — submits the decision. The Worker mints and verifies an assertion (`iss=grokbot-widget`, including `lockedCartFingerprint`) before `applyDecision`. `HOST_API_TOKEN` does **not** skip fingerprint or `jti` checks.

## Implemented host API

### Widget payload (PENDING)

`request_spend` and `get_spend_status` (while `PENDING`) return:

```json
{
  "widget": {
    "spendRequestId": "sr_…",
    "merchantName": "Example Shop",
    "amount": 12.5,
    "currency": "GBP",
    "merchantDomain": "shop.example.co.uk",
    "checkoutUrl": "https://shop.example.co.uk/checkout",
    "lockedCartFingerprint": "shop.example.co.uk|GBP|1250|…",
    "options": ["Approve", "Reject", "Keep looking"]
  }
}
```

`approveUrl` is still present for **local HMAC smoke only**, flagged `approveUrlLocalSmokeOnly: true`. The Grokbot path must not open it.

Exactly **three** MCP tools. No decide tool. Agent MCP does not expose widget-decision.

### `POST /host/widget-decision`

- **Auth:** `Authorization: Bearer host:<HOST_API_TOKEN>`
- **Tenant lookup (not authority):** `X-Money-Bot-Tenant` and/or body `tenantId` as a **routing key**. The Worker loads the spend, then binds `tenantId` from the **spend record** into a server-minted assertion. Body `decidedBy` is ignored.
- **Body:** `{ spendRequestId, decision: "approved" | "denied" | "keep_looking", lockedCartFingerprint }`
- **Fail closed:** missing/invalid `HOST_API_TOKEN` → **401**. Production must set the secret (see `.dev.vars.example`).
- **Assertion:** Worker builds the same claim set as OOB (`iss=grokbot-widget`, `aud=money-bot`, `exp`, `iat`, `jti`, `spendRequestId`, `tenantId`, `decision`, `lockedCartFingerprint`) and verifies it before apply. Fingerprint mismatch → 409. Replayed `jti` → 409.

| Human tap | `decision` | Result |
| --- | --- | --- |
| Approve | `approved` | `APPROVED` via `applyDecision({ assertionVerified: true })` → `prepare_checkout_handoff` returns locked `checkoutUrl` |
| Reject | `denied` | `DENIED` + 24h human-deny cooldown |
| Keep looking | `keep_looking` | **`CANCELLED`** — closes `PENDING` **without** deny-cooldown (default; documented). New same-cart `request_spend` is allowed. |

## Flow

```
agent finds product
        ↓
   request_spend   →  PENDING + widget (+ approveUrl local-smoke-only)
        ↓
Life Admin SendToUser question widget: Approve / Reject / Keep looking
        ↓
only the user’s tap  →  POST /host/widget-decision (HOST_API_TOKEN)
        ↓
   APPROVED | DENIED | CANCELLED
        ↓
prepare_checkout_handoff (if approved) → locked checkoutUrl
```

## Life Admin smoke/demo

Copy-paste path so Life Admin can demo in chat immediately after merge. **Do not** have the model fetch `approveUrl`.

### 0. Secrets

On Money Bot (Worker), set `HOST_API_TOKEN` (and `APPROVAL_HMAC_SECRET`). Local:

```bash
cp .dev.vars.example .dev.vars
# HOST_API_TOKEN=dev-only-host-api-token-change-me
npm start
```

Life Admin holds the same `HOST_API_TOKEN`. Never put it in agent tool results or chat.

### 1. Call `request_spend` (or receive the widget payload)

Agent MCP (three tools only), authenticated tenant `userId`. Example result:

```json
{
  "status": "PENDING",
  "spendRequestId": "sr_…",
  "approveUrlLocalSmokeOnly": true,
  "widget": {
    "spendRequestId": "sr_…",
    "merchantName": "Example Shop",
    "amount": 12.5,
    "currency": "GBP",
    "merchantDomain": "shop.example.co.uk",
    "checkoutUrl": "https://shop.example.co.uk/checkout",
    "lockedCartFingerprint": "…",
    "options": ["Approve", "Reject", "Keep looking"]
  }
}
```

`get_spend_status` returns the same `widget` while `PENDING`.

### 2. `SendToUser` question widget

Render a human-only question with those three options. Bind the card to `widget.spendRequestId` + `widget.lockedCartFingerprint` (show amount, merchant, domain). The model must not tap the card.

### 3. On user reply, `POST /host/widget-decision`

Map the tap: Approve → `approved`, Reject → `denied`, Keep looking → `keep_looking`.

```bash
curl -sS -X POST "$MONEY_BOT_URL/host/widget-decision" \
  -H "Authorization: Bearer host:$HOST_API_TOKEN" \
  -H "X-Money-Bot-Tenant: $TENANT_ID" \
  -H "content-type: application/json" \
  -d '{
    "spendRequestId": "<widget.spendRequestId>",
    "decision": "approved",
    "lockedCartFingerprint": "<widget.lockedCartFingerprint>"
  }'
```

- Use the **authenticated Life Admin user** as `X-Money-Bot-Tenant` (Money Bot `tenantId`). Body `tenantId` is accepted only as the same lookup key; it is **not** `applyDecision` authority.
- Do **not** send `decidedBy`. If sent, it is ignored.
- Local Worker smoke of this path (no `approveUrl`): `./scripts/smoke-widget-approve.sh`

Expected: `{ "status": "APPROVED", "decidedBy": "oob-assertion", … }`.  
Reject → `{ "status": "DENIED", "denyCooldown": true }`.  
Keep looking → `{ "status": "CANCELLED", "keepLooking": true, "denyCooldown": false }`.

### 4. `prepare_checkout_handoff` if approved

Agent tool only after `APPROVED`. Returns locked `checkoutUrl` (`WAITING_FOR_YOU`). Hand that URL to the human. Do not mark `PAID`.

## `approveUrl` vs widget

| Surface | Approve UI | Human proof? |
| --- | --- | --- |
| Local wrangler / `./scripts/smoke-approve.sh` | HMAC `GET /approve` bearer URL | No — URL possession is enough |
| Grokbot / Life Admin (**this PR**) | Human-only chat widget → `POST /host/widget-decision` | Yes **if** Life Admin never lets the model fetch `approveUrl` and only posts after a real tap |
| Public Cursor marketplace (later) | Passkey / WebAuthn (or host session equivalent) | Yes — device/user binding; long-term N-1 fix |

## What this PR does not do

- No passkey / WebAuthn
- No Revolut, no PAN
- No Life Admin agent-code wiring (guide only)
- No claim that “no decide MCP tool” makes `approveUrl` unusable by an agent
- No host-only cross-domain `supersedes` override (optional later)

## Wording

- **True today:** there is no decide MCP tool. Widget decide mints+verifies `iss=grokbot-widget` and calls `applyDecision` only with `assertionVerified: true`. Keep looking → `CANCELLED` without deny cooldown. Agent `supersedes` must be same-domain.
- **Not true:** `approveUrl` is human-proof, or “the agent cannot Approve” in an absolute sense while a bearer URL exists.
- **SoD depends on Life Admin** using the widget + host token path.

Use: *no decide MCP tool ≠ approveUrl is human-proof.*
