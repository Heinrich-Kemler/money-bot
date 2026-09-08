# Money Bot security

> **Not production.** First testable Approve is **local HMAC-signed browser Approve**, not passkey/WebAuthn. `POST /host/spend-decision` verifies a signed JWT/HMAC and never reads `tenantId` / `decidedBy` from the body. `POST /host/checkout-outcome` is still **501**. Do not process live spend.

Primary name: **Money Bot** (`money-bot`).  
Internal metaphor only: the **Spend Gate** is the state machine below.

v0 is **approval-request + URL handoff**. The agent should never see a raw PAN. Revolut Business is **not connected**. Money Bot **does not hold funds**.

## Production agent tools (complete list)

`request_spend` · `get_spend_status` · `prepare_checkout_handoff`

Not registered (and must stay that way): `edit_spend_cap`, `report_checkout_outcome`, `dev_set_spend_decision`, any decide/approve tool. There is **no** `DEV_MODE` boolean that enables Approve.

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED
               ↘ DENIED | EXPIRED | CANCELLED
               ↘ REAUTH_REQUIRED
```

Tenant connection (day one, unused in v0):

```
NOT_CONNECTED → CONNECTED → REAUTH_REQUIRED → CONNECTED
```

`REAUTH_REQUIRED` is reserved for a future Revolut Business **wizard** (cert + `client_id` + JWT + Enable access — **no public OAuth**) and ~90-day re-consent. v0 handoff does **not** require a connection.

- **`checkoutUrl` is the money path.** Locked to `merchantDomain` at `request_spend`, re-snapshotted at Approve, and the only URL `prepare_checkout_handoff` will return. Host ≠ lock → reject. No `merchantUrl` fallback.
- Approve **locks the cart**: amount + merchant + domain + checkoutUrl + shipping. OOB token **must bind `lockedCartFingerprint`**.
- **Grokbot widget Approve** is `POST /host/widget-decision` (`Authorization: Bearer host:<HOST_API_TOKEN>`). The Worker mints+verifies `iss=grokbot-widget` (same claims as OOB, including `lockedCartFingerprint` + `jti`) and calls `applyDecision` only with `assertionVerified: true`. Body `tenantId` / `decidedBy` are not authority. Keep looking → `CANCELLED` (no deny cooldown). Not an MCP tool. SoD depends on Life Admin using this path, not the model fetching `approveUrl`.
- **Local first-test Approve** is `GET /approve` → `POST /host/spend-decision` (HMAC). `approveUrl` is a **bearer capability**: possession of the URL (human, agent, or smoke script) can complete Approve/Deny by fetching/posting it. Acceptable for local first test only. This does **not** prove a human acted. **TODO:** passkey/WebAuthn for public Cursor marketplace.
- The agent has **no decide MCP tool**. That is **not** the same as “`approveUrl` is human-proof.”
- Host decide verifies a signed assertion (`OOB_ASSERTION_CONTRACT` in `src/types.ts`) and calls `applyDecision` only with `assertionVerified: true`. Outcome remains **501**. No `DEV_MODE` Approve switch.
- `DENIED`, `EXPIRED`, and `CANCELLED` are terminal from `PENDING`. Only a **human Deny** starts the 24h retry cooldown. `EXPIRED` (timeout) and `CANCELLED` (Keep looking) do not.
- If `spendCap` is present, it must be ≥ amount. Cap edits (host-only helper) never grant approval.

## Trust boundaries

```
┌─────────────┐  three tools   ┌──────────────────┐
│ Cursor host │ ◄────────────► │ Money Bot Worker │
│ + agent     │  no decide tool│ MCP + SpendStore │
└──────┬──────┘                └─────────┬────────┘
       │ approveUrl (bearer; local test) │ per-tenant DO
       ▼                                 │
┌─────────────┐                          ▼
│ Browser /   │  local HMAC page  ┌──────────────────┐
│ smoke client│  (not passkey)    │ Merchant checkout│
│             │  locked URL only  │ (intended human) │
└─────────────┘                   └──────────────────┘
```

| Zone | Trusted for | Not trusted for |
| --- | --- | --- |
| Agent / model | The three tools above; **finding products** | A **decide MCP tool**, PAN/CVC/expiry, secrets, cancelling another shop’s approved lock, marking `PAID`. (It *can* fetch/post `approveUrl` today — that is a local bearer gap, not human proof.) |
| Chat / tool JSON | Returning `approveUrl` (bearer capability, local first test) | Claiming the click was a verified human |
| Human device (OOB) | **TODO** passkey/WebAuthn / device auth; paying on the merchant page | Being implied by HMAC URL possession |
| Worker + SpendStore | Spend state, cart lock, tenant **metadata** (no tokens) | Card minting, PAN, CVV, access JWTs |
| Per-tenant Revolut (v1, not built) | That tenant’s Business account only | Shared/pooled issuer, public OAuth |

## Card-data posture (not a certification)

v0 **does not implement** PAN fetch or storage. That is a design goal. It is **not** a QSA assessment and we do **not** claim “out of CDE” as a legal status.

A future v1 PAN fetch would need its own PCI program (often SAQ D unless a vault/iframe). **Never store CVV.** No vault is integrated.

## Threat model and mitigations

### 1. Agent compromise / agent-clickable Approve

**Threat.** The model “clicks Approve” or calls a decide tool.

**What is true today**

- There is **no decide MCP tool**. `DEV_MODE` does not exist as an Approve switch. `AUTO_APPROVE_MAX = 0`.
- `applyDecision` requires `assertionVerified`. Raw `decidedBy: "human"` is rejected. `decidedBy: "agent"` is rejected. Client-supplied actor strings are not stored.
- Host decide verifies JWT/HMAC claims (`iss`, `aud`, `exp`, `iat`, `jti`, `spendRequestId`, `tenantId`, `decision`, `lockedCartFingerprint`). Body `tenantId` / `decidedBy` are ignored.
- Missing/bad signature, expiry, fingerprint mismatch, and replayed `jti` are rejected.
- Missing `props.userId` **fails closed** at the MCP edge: `initialize` / `tools/list` / `tools/call` are 401 and do **not** allocate tenant Durable Objects (no `"anonymous"` ledger).
- `ALLOW_TEST_AUTH=true` is **impossible or inert** on the production `wrangler.toml` path (`ENVIRONMENT=production`). If the flag is set there, the Worker returns 500 and never honors `Bearer test:…`. Local `.dev.vars` must set `ENVIRONMENT=development`; test auth is then honored only on loopback Host.

**Grokbot widget.** `POST /host/widget-decision` requires `Bearer host:<HOST_API_TOKEN>` (401 if missing/invalid). The Worker still mints+verifies `iss=grokbot-widget` claims and does not skip fingerprint/`jti` checks. SoD depends on Life Admin posting only after a human tap — not on the model fetching `approveUrl`.

**Residual (local first test only).** `approveUrl` is a **bearer capability**. Possession of the URL — including by the agent or the smoke script — can complete Approve/Deny by fetching the page and posting the server-minted assertion. That is acceptable for local first test. It does **not** prove a human acted. **TODO:** passkey/WebAuthn / out-of-band device auth.

### 2. Prompt-injection forced spend

**Threat.** Page text says the spend is already approved.

**Mitigations**

- Only `POST /host/spend-decision` with a verified assertion can set `APPROVED`.
- Human Deny is terminal and has a 24h cooldown. `EXPIRED` is terminal without that cooldown.
- Approval UI (when built) must show the **locked cart** from the spend record.

### 3. PAN exfiltration

**Threat.** Tool results, logs, or chat leak PAN/CVC.

**Mitigations**

- v0 does not fetch PAN.
- Handoff returns the locked URL + instructions only.
- Output sanitizer (Luhn-only on free text; identifier keys such as `orderId` skipped).
- Sanitize-on-write before Durable Object persistence.
- Workers Logs **invocation logs and traces are disabled** so request bodies are not persisted to Cloudflare observability.

### 4. Deny-retry spam (not expire-poisoning)

**Threat.** Agent re-requests after a human Deny. (An agent-created spend that merely expires must not lock the human out for 24h.)

**Mitigations**

- `DENIED` is terminal. 24h cooldown matches **normalized merchantDomain + currency + amount within £/€0.50**, plus locked-cart fingerprint and spend-request **lineage**.
- `EXPIRED` is terminal but **does not** enter that cooldown. A new same-cart `request_spend` after TTL is allowed.

### 5. Cross-tenant / pooled funds

**Threat.** Shared issuer or User A seeing User B’s ledger.

**Mitigations**

- Durable Object `tenant:<tenantId>` from authenticated `props.userId` only.
- No card-issuing-as-a-service. Never pool funds.

### 6. Fake “OAuth connect”

**Threat.** Shipping a one-tap OAuth for Revolut that does not exist.

**Mitigations**

- Documented: **no public OAuth**. v1 connect, if built, is a **wizard**. Tokens are not stored on the spend record.

### 7. Cart / checkoutUrl swap after Approve

**Threat.** Amount, shipping, or **checkout host** changes after the human approved.

**Mitigations**

- Locked cart includes `checkoutUrl`. Handoff refuses a swapped URL or a host ≠ `merchantDomain`.
- Same-`merchantDomain` mismatch (or explicit same-domain `supersedes`) → new `PENDING` with `cartDiff`; that lock **cancelled** (`FAILED` + `supersededBySpendRequestId`). Agent `supersedes` of another merchant is **rejected**. A different merchant’s lock is left intact.

### 8. Log / transcript leakage

**Mitigations**

- No secrets in git or `wrangler.toml`.
- Observability invocation logs / traces off.
- Do not persist access tokens or CVV.
- Audit: when, merchant, amount, locked cart, order id — never PAN.

## Audit fields

| Field | Meaning |
| --- | --- |
| `spendRequestId` | `sr_…` |
| `tenantId` | From authenticated host props — never a request-body field |
| `status` | Includes `REAUTH_REQUIRED` |
| `tenantConnection` | `NOT_CONNECTED` \| `CONNECTED` \| `REAUTH_REQUIRED` |
| `requiresTenantConnection` | `false` in v0 |
| `lockedCart` | amount, merchant, domain, **checkoutUrl**, shipping |
| `decidedBy` | Recorded as `oob-assertion` after a verified assertion — never a client string |

## v0 non-goals

- No Revolut Business connect, Cards API, virtual PAN, or payment-brand integrations.
- No decide MCP tool. Local `/approve` is a bearer URL + signed assertion (not passkey; not human proof).
- No agent-callable payment outcome.
- No production per-user public OAuth (it does not exist for Revolut Business).
- No claim of FCA / KNF authorisation or PCI certification.
