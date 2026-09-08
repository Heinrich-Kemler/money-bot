# Money Bot

> **SCAFFOLD ONLY — not production.** Out-of-band Approve is **not implemented** (`POST /host/spend-decision` returns **501**). Do not use this Worker to move real money until a signed OOB assertion (passkey/PWA) is wired. The shopping agent cannot Approve or mark `PAID`.

Public Cursor marketplace plugin so any user’s agent can pay for **UK/EU** online checkouts without putting card numbers in the model.

**Package / id:** `money-bot`  
**v0:** approval + checkout handoff only — **never show a raw PAN in chat**. Revolut Business connect is **optional** (not used).  
**v1 (not built):** each tenant’s **own** Revolut Business account — document only; no connect, mint, or PCI PAN handling in this repo.

Money Bot is a **technical agent**. It **never holds customer funds** and is not a card-issuing-as-a-service platform. Seek **FCA / KNF** (and local) advice before v1. This software is not a payment institution, e-money issuer, or regulated wallet.

Stripe Link is region-locked for many EU users. Money Bot is the human-in-the-loop alternative.

The internal “Spend Gate” metaphor is this state machine. The public name is **Money Bot**.

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID
                                              → CHALLENGE → PAID | FAILED
                                              → FAILED
               ↘ DENIED | EXPIRED
               ↘ REAUTH_REQUIRED   (90-day tenant re-consent; v1 Revolut)
```

Tenant connection (exists from day one, unused in v0):

```
NOT_CONNECTED → CONNECTED → REAUTH_REQUIRED → CONNECTED
```

| Tool / path | Transition |
| --- | --- |
| (no request) | `IDLE` |
| `request_spend` | `IDLE` → `PENDING` |
| **Signed OOB** Approve (passkey/PWA) — **not implemented, HTTP 501** | `PENDING` → `APPROVED` — locks amount + merchant + domain + shipping. Token **must bind `lockedCartFingerprint`**. Raw `decidedBy` is rejected. |
| Human Deny (same signed assertion) | `PENDING` → `DENIED` (terminal) |
| Pending TTL | `PENDING` → `EXPIRED` (terminal) |
| `prepare_checkout_handoff` | `APPROVED` → `WAITING_FOR_YOU` — requires https `checkoutUrl` on the locked merchant domain |
| `get_spend_status` | Full status + `tenantConnection` |
| Host/OOB checkout outcome — **not an agent tool** | `WAITING_FOR_YOU` → `PAID` / `CHALLENGE` / `FAILED` |
| 90-day Revolut re-consent (v1-bound only) | → `REAUTH_REQUIRED` until the connect **wizard** completes |

A chat control may only **initiate** Approve. The **agent must never press Approve** (Ramp-style segregation of duties). `report_checkout_outcome` and `edit_spend_cap` are **not** on the agent MCP surface.

Deny and expire are terminal. A cart mismatch opens a **new PENDING** and **cancels** the previous `APPROVED` lock (`FAILED` + `supersededBySpendRequestId`). Deny retries match merchant domain + currency + amount within £/€0.50 (blocks ±£0.01).

v0 merchants must be **UK/EU domains** and **GBP/EUR**. Other regions return a clear error.

## Product

| | v0 (this repo) | v1 (docs only) |
| --- | --- | --- |
| Who pays | Human, on the merchant checkout | Human-approved **virtual** card from **their** Revolut Business — never a pooled float |
| Revolut | Optional; not required | Per-tenant cert + `client_id` + JWT + Enable access. **No public OAuth.** Wizard, not one-tap. Access token ~40m; **90-day re-consent** → `REAUTH_REQUIRED` |
| What the agent sees | Spend id, amount, merchant, checkout URL, state | Same — **never** PAN/CVC/expiry |
| Approve | Out-of-band only | Same |
| PCI | Never touches PAN → **out of CDE** | PAN fetch = **SAQ D** unless a PCI vault/iframe (Basis Theory / VGS / Skyflow). **Never store CVV post-auth.** |

**Never use Revolut Merchant API** (wrong direction). Personal Revolut has no card-issue API. There is **no card-issuing-as-a-service**.

### Checkout handoff (v0)

- **Apple Pay** on desktop Safari: payment sheet. On desktop **non-Safari**: human scans a QR with iPhone (**iOS 18+**), about **30 seconds**.
- **Revolut Pay**: QR + in-app approve when the merchant supports it; otherwise Apple Pay fallback.
- **SCA / 3DS** is still live in the UK (~£25) and EU (~€30). If a challenge appears, move to **CHALLENGE**. Amex SafeKey ~**4 min**; Revolut 3DS ~**5 min**.

### v1 Revolut Business (do not implement)

Virtual cards only. Single-transaction + one periodic limit. Freeze/terminate after capture or fail. `TransactionCreated` webhook. Sensitive data: `READ_SENSITIVE_CARD_DATA` + IP allowlist. Prefer a PCI vault/iframe over Worker-side PAN.

## Cursor / MCP Apps

Cursor **2.6+** can render an **MCP Apps** sandboxed iframe card. Money Bot must also ship a **mandatory plain-text fallback** (tool results + this skill) so hosts without MCP Apps still work. Cursor marketplace listing is **manual review**.

## v0 agent flow

1. Fill the merchant cart (amount, merchant URL/domain, shipping).
2. `request_spend` → `{ status: "PENDING", spendRequestId, lockedCart, … }`.
3. Tell the human to Approve **out-of-band** (phone passkey/PWA). A chat button only starts that flow. **Do not click Approve yourself.**  
   **TODO(host-approval-bridge):** signed OOB JWT/HMAC → `POST /host/spend-decision` (**501**, contract on `/`). Claims must include `tenantId`, `spendRequestId`, `decision`, and **`lockedCartFingerprint`**. Never `decidedBy: "human"` alone.
4. `get_spend_status` until `APPROVED`, `DENIED`, `EXPIRED`, or `REAUTH_REQUIRED`.
5. `prepare_checkout_handoff` → `WAITING_FOR_YOU`. Hand the screen to the human. Never show a raw PAN. Do **not** mark `PAID`.

## Security summary

See [SECURITY.md](SECURITY.md):

1. Human OOB approval every spend (`AUTO_APPROVE_MAX = 0`). Agent cannot Approve.
2. Never put PAN/CVC/expiry in chat, memory, transcripts, or tool results.
3. Secrets only in vault / per-tenant cert+JWT (v1). **No public Revolut OAuth.**
4. No pooled funds; no card-issuing-as-a-service.
5. Deny / expire are terminal; `REAUTH_REQUIRED` after 90 days on a connected tenant.
6. v0 out of CDE; v1 SAQ D unless vault/iframe; never store CVV post-auth.

## Layout

```
README.md
SECURITY.md
docs/open-questions.md
src/   # request_spend, get_spend_status, prepare_checkout_handoff
skills/money-bot/SKILL.md
plugin/
```

## Install / develop

```bash
npm install
cp .dev.vars.example .dev.vars   # DEV_MODE=true is a local test hook only
npm run type-check
npm test
npm start                        # wrangler dev — MCP at http://localhost:8787/mcp
```

### MCP tools (v0 agent surface)

| Tool | Role |
| --- | --- |
| `request_spend` | `IDLE` → `PENDING` (UK/EU + https checkout URL on the same domain) |
| `get_spend_status` | Machine status + locked cart + `tenantConnection` |
| `prepare_checkout_handoff` | `APPROVED` → `WAITING_FOR_YOU`; no credentials |

`dev_set_spend_decision` exists only when `DEV_MODE=true` (local scaffold hook). Production Approve is **501** until a signed OOB assertion exists.

## Disclaimer

Money Bot is software that helps an agent request human approval and hand off a merchant checkout. It does not hold funds, issue cards, or provide regulated payment services. Obtain FCA (UK), KNF (PL), and other local advice before v1.

## License

MIT
