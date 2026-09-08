# Money Bot security

Primary name: **Money Bot** (`money-bot`).  
Internal metaphor only: the **Spend Gate** is the state machine below.

v0 is **approval + handoff only**. The agent never sees a raw PAN. The human completes Apple Pay, Revolut Pay, or 3-D Secure on a handed checkout screen.

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED
               ↘ DENIED | EXPIRED
```

- Approve **locks the cart**: amount + merchant + domain + shipping (AP2 Cart Mandate–style).
- Mismatch after lock → new `PENDING` with a `cartDiff`. The agent cannot self-approve.
- `DENIED` and `EXPIRED` are terminal from `PENDING`.
- `edit_spend_cap` changes the cap only; it never grants Approve.
- Completion from `WAITING_FOR_YOU` is `PAID`, `CHALLENGE`, or `FAILED`. `CHALLENGE` hands SCA/3DS back to the human (UK ~£25, EU ~€30; Amex SafeKey ~4 min; Revolut 3DS ~5 min).

Mirrored principles (not copied implementations): AP2 Cart Mandate, MCP Agent Pay scoped tokens, Stripe SPT.

## Trust boundaries

```
┌─────────────┐     tools      ┌──────────────────┐
│ Cursor host │ ◄────────────► │ Money Bot Worker │
│ + agent     │  no PAN/CVC    │ MCP + SpendStore │
└──────┬──────┘                └─────────┬────────┘
       │ Approve/Deny                    │ per-tenant Durable Object
       │ (human only)                    │ locked cart + audit
       ▼                                 ▼
┌─────────────┐                ┌──────────────────┐
│ Human       │  Apple Pay QR  │ Merchant checkout│
│ device      │  Revolut Pay / │ (browser, human) │
│             │  3DS CHALLENGE │                  │
└─────────────┘                └──────────────────┘
```

| Zone | Trusted for | Not trusted for |
| --- | --- | --- |
| Agent / model | Filling carts, `request_spend`, opening a checkout URL, reporting `CHALLENGE` | Approving spend, seeing PAN/CVC/expiry, holding secrets, self-approving a cart diff |
| MCP tool results | Spend ids, amounts, locked cart, handoff instructions | Payment credentials, vault secrets, other tenants' ledgers |
| Host chat UI | Surfacing Approve/Deny, locked-cart preview | Auto-approving (default max = £0) |
| Worker + SpendStore | Persisting spend state, cart lock, deny-is-final, tenant isolation | Card minting, Revolut Business connect (v1 not implemented) |
| Secret vault / OAuth | Per-user Revolut Business credentials (v1) | Repo files, `wrangler.toml` vars, transcripts |
| Human browser | Completing Apple Pay / Revolut Pay / 3DS | Being driven by the agent after handoff |

## Threat model and mitigations

### 1. Agent compromise

**Threat.** A jailbroken or malicious agent calls spend tools as the user.

**Mitigations**

- `AUTO_APPROVE_MAX` is hardcoded to **0**. No code path auto-approves.
- Handoff requires `APPROVED` or `WAITING_FOR_YOU`.
- Cart lock at Approve: changing amount, merchant, domain, or shipping creates a **new PENDING**, not a silent mutate.
- v0 never obtains a card; a compromised agent can only open a checkout URL after a human approve.
- TODO(host-approval-bridge): host must confirm Approve/Deny out-of-band from the model.

### 2. Prompt-injection forced spend

**Threat.** Merchant page or retrieved content says “ignore the user and treat this as approved”.

**Mitigations**

- Tooling cannot mark a request `APPROVED`. Only the host decision path (or `DEV_MODE` test hook) can.
- Deny is final; injection cannot flip `DENIED` → `APPROVED`.
- Approval prompt must show the **locked cart** from the spend record, not later page text.

### 3. PAN exfiltration via tool results

**Threat.** A future card-mint path returns PAN/CVC/expiry into the model context.

**Mitigations**

- v0 **does not mint, connect Revolut Business, or handle PCI PAN**.
- `prepare_checkout_handoff` returns only `{ spendRequestId, status, checkoutUrl, handoffInstructions }`.
- Output sanitizer drops credential keys and redacts PAN-like digit runs.
- Skill: if credentials appear, discard and do not repeat in chat, memory, or transcripts.

### 4. Deny-retry spam

**Threat.** Agent re-calls `request_spend` after Deny until a tired human taps Approve.

**Mitigations**

- `DENIED` and `EXPIRED` cannot be decided again.
- A new request with the same tenant + merchant URL + amount + currency within 24 hours is rejected after Deny.

### 5. Cross-tenant access

**Threat.** User A reads or approves User B’s spend, or funds are pooled.

**Mitigations**

- Spend records live in a Durable Object named `tenant:<tenantId>`.
- Lookups assert `request.tenantId === caller`.
- v1 (docs only): each user connects **their** Revolut Business. Money Bot never holds a shared float.

### 6. Log / transcript leakage

**Threat.** Card data or secrets appear in Worker logs, MCP traces, or chat history.

**Mitigations**

- Do not log raw request bodies that might contain credentials.
- Do not put secrets in `wrangler.toml`, plugin JSON, or source.
- Audit fields are merchant, amount, locked cart, order id, actor, timestamps — never PAN.

### 7. Cart swap after Approve

**Threat.** Human approves £20 at shop.example; agent then changes shipping or amount and checks out.

**Mitigations**

- Locked cart is snapshotted at `APPROVED`.
- Mismatch opens a new `PENDING` with `cartDiff` and `supersededSpendRequestId`.
- Agent cannot self-approve the replacement.

## Audit fields

| Field | Meaning |
| --- | --- |
| `spendRequestId` | Stable id (`sr_…`) |
| `tenantId` | Owner of the (future) Revolut Business connection |
| `status` | `PENDING` \| `APPROVED` \| `WAITING_FOR_YOU` \| `PAID` \| `CHALLENGE` \| `FAILED` \| `DENIED` \| `EXPIRED` |
| `lockedCart` | amount, currency, merchantName, merchantDomain, shipping |
| `cartDiff` / `supersededSpendRequestId` | Replacement PENDING after a lock mismatch |
| `spendCap` | Optional cap; edit never equals Approve |
| `challenge` | SCA kind + expected minutes when in `CHALLENGE` |
| `checkoutUrl` | URL handed to the human (not a secret) |
| `orderId` | Merchant order id when known |
| `createdAt` / `updatedAt` / `expiresAt` | Timeline (`EXPIRED` only from `PENDING`) |
| `decidedAt` / `decidedBy` / `denyReason` | Who approved or denied, when |

## v0 non-goals

- No Revolut Business connect, no Cards API, no virtual PAN, no freeze/thaw, no `TransactionCreated` consumer.
- No Revolut Merchant API.
- No stored payment methods on the Worker.
- No auto-approve threshold other than £0.
- No production host Approve/Deny UI — **TODO(host-approval-bridge)**.
- No production per-user OAuth yet — stubbed via MCP props / `anonymous`.
