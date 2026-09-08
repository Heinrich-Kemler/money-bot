# Money Bot security

> **SCAFFOLD ONLY — not production.** There is **no** working production Approve path. `POST /host/spend-decision` and `POST /host/checkout-outcome` return **501** and document the signed OOB contract. They do **not** trust `decidedBy: "human"`. Do not process live spend until passkey/PWA assertions are implemented.

Primary name: **Money Bot** (`money-bot`).  
Internal metaphor only: the **Spend Gate** is the state machine below.

v0 is **approval + handoff only**. The agent never sees a raw PAN. Revolut Business is **optional** and **not connected**. Money Bot **never holds funds** and is not card-issuing-as-a-service.

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED
               ↘ DENIED | EXPIRED
               ↘ REAUTH_REQUIRED
```

Tenant connection (day one, even though v0 does not connect Revolut):

```
NOT_CONNECTED → CONNECTED → REAUTH_REQUIRED → CONNECTED
```

`REAUTH_REQUIRED` applies when a tenant completed the Revolut Business **wizard** (cert + `client_id` + JWT + Enable access — **no public OAuth**) and the **~90-day re-consent** window lapses, or Enable access is revoked. Access tokens last ~**40 minutes** and must not be persisted. v0 checkout handoff does **not** require a connection; only v1-bound spends (`requiresTenantConnection`) pause into `REAUTH_REQUIRED`.

- Approve **locks the cart**: amount + merchant + domain + shipping.
- **Approve is out-of-band** (phone passkey / PWA). A chat button may only *initiate* that flow. **The agent must never be able to press Approve** (Ramp-style segregation of duties).
- The OOB token **must bind `lockedCartFingerprint`** (amount + merchantDomain + currency + shipping). A signed assertion that omits the fingerprint is invalid.
- **SCAFFOLD:** host decide/outcome endpoints are **501 stubs** (see `OOB_ASSERTION_CONTRACT` in `src/types.ts`). No half-wired “trust the string” Approve.
- `DENIED` and `EXPIRED` are terminal from `PENDING`.
- `CHALLENGE` hands SCA/3DS back to the human (UK ~£25, EU ~€30; Amex SafeKey ~4 min; Revolut 3DS ~5 min).

## Trust boundaries

```
┌─────────────┐  tools only   ┌──────────────────┐
│ Cursor host │ ◄────────────► │ Money Bot Worker │
│ + agent     │  never Approve │ MCP + SpendStore │
└──────┬──────┘                └─────────┬────────┘
       │ initiate OOB                    │ per-tenant DO
       ▼                                 │ never pooled funds
┌─────────────┐                          ▼
│ Human phone │  passkey / PWA    ┌──────────────────┐
│ (Approve)   │                   │ Merchant checkout│
│ Apple Pay / │  QR / 3DS         │ (human browser)  │
│ Revolut Pay │                   └──────────────────┘
└─────────────┘
```

| Zone | Trusted for | Not trusted for |
| --- | --- | --- |
| Agent / model | `request_spend`, `get_spend_status`, opening a checkout URL | **Pressing Approve**, PAN/CVC/expiry, secrets, self-approving a cart diff |
| Chat UI | *Initiating* OOB Approve, locked-cart preview, plain-text fallback | Completing Approve in-chat; agent-clickable Approve |
| Human device (OOB) | Passkey/PWA Approve, Apple Pay / Revolut Pay / 3DS | Being driven by the agent |
| Worker + SpendStore | Spend state, cart lock, tenant connection **metadata** (no tokens) | Card minting, PAN, CVV, access JWTs |
| Per-tenant Revolut (v1) | That tenant’s Business account only | Shared/pooled issuer, public OAuth |

## PCI honesty

| Version | PAN | CDE | Notes |
| --- | --- | --- | --- |
| **v0** | Never touched | **Out of CDE** | Handoff only. Sanitizer redacts PAN-like strings if they appear. |
| **v1** | Fetch into a browser field | **SAQ D** unless a PCI vault / iframe (Basis Theory, VGS, Skyflow) | `READ_SENSITIVE_CARD_DATA` + IP allowlist. **Never store CVV post-auth.** Prefer vault/iframe over Worker-side PAN. |

## Threat model and mitigations

### 1. Agent compromise / agent-clickable Approve

**Threat.** The model or a prompt-injected page “clicks Approve” in chat (or calls a decide tool).

**Mitigations**

- `AUTO_APPROVE_MAX = 0`.
- `decidedBy: "agent"` is rejected. Raw `decidedBy: "human"` is **not** a valid production signal.
- Agent MCP tools are only `request_spend`, `get_spend_status`, `prepare_checkout_handoff`. The agent **cannot** call `report_checkout_outcome` or mark `PAID`.
- Missing `props.userId` **fails closed** (no `"anonymous"` Durable Object).
- **TODO(host-approval-bridge):** signed OOB JWT/HMAC with `tenantId`, `spendRequestId`, `decision`, `lockedCartFingerprint`. Endpoint is **501** until that exists.
- Ramp-style **segregation of duties**: requester (agent) ≠ approver (human device).

### 2. Prompt-injection forced spend

**Threat.** Page text says the spend is already approved.

**Mitigations**

- Only the OOB host path can set `APPROVED`.
- Deny is final.
- Approval UI must show the **locked cart** from the spend record.

### 3. PAN exfiltration

**Threat.** Tool results or chat leak PAN/CVC.

**Mitigations**

- v0 never fetches PAN (out of CDE).
- Handoff returns URL + instructions only.
- Output sanitizer; skill forbids repeating credentials.

### 4. Deny-retry spam

**Threat.** Agent re-requests after Deny.

**Mitigations**

- `DENIED` / `EXPIRED` are terminal. Retry window (24h) matches **merchantDomain + currency + amount within £/€0.50**, plus locked-cart fingerprint and spend-request **lineage** (blocks ±£0.01 and cart-hash retries).

### 5. Cross-tenant / pooled funds

**Threat.** Shared issuer or User A seeing User B’s ledger.

**Mitigations**

- Durable Object `tenant:<tenantId>`.
- **No card-issuing-as-a-service.** Each tenant’s own Revolut Business only. Never pool funds.

### 6. Fake “OAuth connect”

**Threat.** Shipping a one-tap OAuth for Revolut that does not exist.

**Mitigations**

- Documented: **no public OAuth**. v1 connect is a **wizard** (cert + client_id + JWT + Enable access). Access token ~40m; **90-day re-consent** → `REAUTH_REQUIRED`. Tokens are not stored on the spend record.

### 7. Cart swap after Approve

**Threat.** Amount/shipping changes after the human approved.

**Mitigations**

- Locked cart at `APPROVED`; mismatch → new `PENDING` with `cartDiff` and the previous lock is **cancelled** (`FAILED` + `supersededBySpendRequestId`). Agent cannot approve the replacement.

### 8. Log / transcript leakage

**Mitigations**

- No secrets in git or `wrangler.toml`.
- Do not persist Revolut access tokens or CVV.
- Audit: who approved (OOB actor), when, merchant, amount, locked cart, order id — never PAN.

## Audit fields

| Field | Meaning |
| --- | --- |
| `spendRequestId` | `sr_…` |
| `tenantId` | Tenant; never a shared float |
| `status` | Includes `REAUTH_REQUIRED` |
| `tenantConnection` | `NOT_CONNECTED` \| `CONNECTED` \| `REAUTH_REQUIRED` + 90-day `consentExpiresAt` |
| `requiresTenantConnection` | `false` in v0; v1 card path only |
| `lockedCart` | amount, merchant, domain, shipping |
| `decidedBy` | OOB human / device — never `agent` |

## v0 non-goals

- No Revolut Business connect, Cards API, virtual PAN, freeze/thaw, or `TransactionCreated` consumer.
- No Revolut Merchant API. No card-issuing-as-a-service.
- No in-chat / agent-clickable Approve — **TODO(host-approval-bridge) is a 501 signed-OOB contract**, not a chat Approve button and not a `decidedBy` string.
- No agent-callable payment outcome. PAN sanitizer skips `orderId` (Luhn-only redaction for digit runs).
- No production per-user public OAuth (it does not exist for Revolut Business).
