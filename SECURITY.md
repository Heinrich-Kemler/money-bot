# Money Bot security

> **SCAFFOLD ONLY — not production.** There is **no** working Approve path. `POST /host/spend-decision` and `POST /host/checkout-outcome` return **501** and document the signed OOB contract. They do **not** read `tenantId` or `decidedBy` from the body. Do not process live spend.

Primary name: **Money Bot** (`money-bot`).  
Internal metaphor only: the **Spend Gate** is the state machine below.

v0 is **approval-request + URL handoff**. The agent should never see a raw PAN. Revolut Business is **not connected**. Money Bot **does not hold funds**.

## Production agent tools (complete list)

`request_spend` · `get_spend_status` · `prepare_checkout_handoff`

Not registered (and must stay that way): `edit_spend_cap`, `report_checkout_outcome`, `dev_set_spend_decision`, any decide/approve tool. There is **no** `DEV_MODE` boolean that enables Approve.

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED
               ↘ DENIED | EXPIRED
               ↘ REAUTH_REQUIRED
```

Tenant connection (day one, unused in v0):

```
NOT_CONNECTED → CONNECTED → REAUTH_REQUIRED → CONNECTED
```

`REAUTH_REQUIRED` is reserved for a future Revolut Business **wizard** (cert + `client_id` + JWT + Enable access — **no public OAuth**) and ~90-day re-consent. v0 handoff does **not** require a connection.

- **`checkoutUrl` is the money path.** Locked to `merchantDomain` at `request_spend`, re-snapshotted at Approve, and the only URL `prepare_checkout_handoff` will return. Host ≠ lock → reject. No `merchantUrl` fallback.
- Approve **locks the cart**: amount + merchant + domain + checkoutUrl + shipping. OOB token **must bind `lockedCartFingerprint`**.
- **Approve is out-of-band** (planned phone passkey / PWA). A chat button may only *initiate* that flow. **The agent must never press Approve.**
- **SCAFFOLD:** host decide/outcome endpoints are **501 stubs** (`OOB_ASSERTION_CONTRACT` in `src/types.ts`). No half-wired “trust the string” Approve. No unauthenticated `applyHostDecision` behind a config flag.
- `DENIED` and `EXPIRED` are terminal from `PENDING` and share the retry cooldown.
- If `spendCap` is present, it must be ≥ amount. Cap edits (host-only helper) never grant approval.

## Trust boundaries

```
┌─────────────┐  three tools   ┌──────────────────┐
│ Cursor host │ ◄────────────► │ Money Bot Worker │
│ + agent     │  never Approve │ MCP + SpendStore │
└──────┬──────┘                └─────────┬────────┘
       │ initiate OOB (planned)          │ per-tenant DO
       ▼                                 │
┌─────────────┐                          ▼
│ Human device│  planned passkey  ┌──────────────────┐
│ (Approve)   │                   │ Merchant checkout│
│             │  locked URL only  │ (human browser)  │
└─────────────┘                   └──────────────────┘
```

| Zone | Trusted for | Not trusted for |
| --- | --- | --- |
| Agent / model | The three tools above | **Pressing Approve**, PAN/CVC/expiry, secrets, self-approving a cart diff, marking `PAID` |
| Chat UI | *Initiating* OOB Approve (when built) | Completing Approve in-chat |
| Human device (OOB) | Planned passkey/PWA Approve; paying on the merchant page | Being driven by the agent |
| Worker + SpendStore | Spend state, cart lock, tenant **metadata** (no tokens) | Card minting, PAN, CVV, access JWTs |
| Per-tenant Revolut (v1, not built) | That tenant’s Business account only | Shared/pooled issuer, public OAuth |

## Card-data posture (not a certification)

v0 **does not implement** PAN fetch or storage. That is a design goal. It is **not** a QSA assessment and we do **not** claim “out of CDE” as a legal status.

A future v1 PAN fetch would need its own PCI program (often SAQ D unless a vault/iframe). **Never store CVV.** No vault is integrated.

## Threat model and mitigations

### 1. Agent compromise / agent-clickable Approve

**Threat.** The model “clicks Approve” or calls a decide tool.

**Mitigations**

- `AUTO_APPROVE_MAX = 0`.
- No decide tool on the agent MCP surface. `DEV_MODE` does not exist as an Approve switch.
- `applyDecision` requires `assertionVerified`. Raw `decidedBy: "human"` is rejected. `decidedBy: "agent"` is rejected. Client-supplied actor strings are not stored.
- Host decide does not parse the body (`tenantId` / `decidedBy` ignored). Always 501.
- Missing `props.userId` **fails closed** (no `"anonymous"` Durable Object).
- **TODO(host-approval-bridge):** signed OOB JWT/HMAC with `tenantId`, `spendRequestId`, `decision`, `lockedCartFingerprint`.

### 2. Prompt-injection forced spend

**Threat.** Page text says the spend is already approved.

**Mitigations**

- Only a future verified OOB host path can set `APPROVED` (not wired).
- Deny/expire are terminal and share a cooldown.
- Approval UI (when built) must show the **locked cart** from the spend record.

### 3. PAN exfiltration

**Threat.** Tool results, logs, or chat leak PAN/CVC.

**Mitigations**

- v0 does not fetch PAN.
- Handoff returns the locked URL + instructions only.
- Output sanitizer (Luhn-only on free text; identifier keys such as `orderId` skipped).
- Sanitize-on-write before Durable Object persistence.
- Workers Logs **invocation logs and traces are disabled** so request bodies are not persisted to Cloudflare observability.

### 4. Deny/expire-retry spam

**Threat.** Agent re-requests after Deny or after TTL.

**Mitigations**

- `DENIED` / `EXPIRED` are terminal. 24h cooldown matches **normalized merchantDomain + currency + amount within £/€0.50**, plus locked-cart fingerprint and spend-request **lineage**.

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
- Mismatch → new `PENDING` with `cartDiff`; previous lock **cancelled** (`FAILED` + `supersededBySpendRequestId`).

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
- No in-chat / agent-clickable Approve — **501 signed-OOB contract** only.
- No agent-callable payment outcome.
- No production per-user public OAuth (it does not exist for Revolut Business).
- No claim of FCA / KNF authorisation or PCI certification.
