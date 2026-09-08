# Open questions

Tracked decisions for Money Bot (`money-bot`). The public name is **Money Bot**; “Spend Gate” is only an internal name for the state machine.

v0 is approval + handoff. **Do not implement** Revolut Business connect, card minting, or PCI PAN handling.

## Revolut Business Cards API (v1 — document only)

Verified product facts (not implemented):

- **Virtual cards only** (no physical issue).
- **Single-transaction** limit plus **one periodic** limit.
- **Freeze / terminate** after capture or failure.
- **`TransactionCreated`** webhook for settlement / fail.
- Sensitive data requires **`READ_SENSITIVE_CARD_DATA`** and an **IP allowlist**.
- Reveal PAN only into browser fields — never into chat, MCP tool results, memory, or transcripts.
- **Do not** use Revolut Merchant API (collecting as a merchant — wrong direction).
- Personal Revolut has **no** card-issue API.

Still open:

- Business Cards API partner / app-review path (UK entity vs EU entity).
- Exact scopes to create, retrieve (browser-only channel), freeze, and subscribe to `TransactionCreated`.
- How to inject PAN into checkout fields without the PAN entering the Worker or model.

## UK vs EU legal entity

Stripe Link is region-locked for many EU users; Money Bot is aimed at UK/EU checkouts.

SCA is still live: UK ~**£25**, EU ~**€30**. Amex SafeKey ~**4 min**; Revolut 3DS ~**5 min**. The machine already has **CHALLENGE**.

Open:

- UK Ltd vs EU entity (or both) for Revolut Business + card issuing.
- SCA / PSD2 / consumer-duty when an agent initiates checkout but a human authenticates.
- VAT / merchant-of-record: v0 never in the funds flow; v1 uses the user’s own Business account only.

## Checkout UX (v0 facts to keep)

- Apple Pay on desktop **non-Safari**: QR scan on iPhone (**iOS 18+**), ~**30s**.
- Revolut Pay: QR + in-app approve when the merchant supports it; else Apple Pay fallback.
- Never show a raw PAN in chat.

Open:

- How the host surfaces QR timing (“scan within ~30s”) next to Approve/Deny.
- Whether `CHALLENGE` should page the human or only update `get_spend_status`.

## Cursor marketplace listing for payments plugins

Open:

- Review bar for plugins that can move money even with human-in-the-loop?
- Required security questionnaire, PCI statements, and whether a Worker URL + `${MONEY_BOT_MCP_URL}` variable is acceptable?
- How secret-request / vault env is declared for later Revolut OAuth (per user, never in git)?

## Host Approve / Deny UI

`autoApproveMax` is **0**. `request_spend` only creates `PENDING`. Approve must display the **locked cart** (amount, merchant, domain, shipping).

**TODO(host-approval-bridge):** Cursor (or another host) shows Approve/Deny (Stripe Link parity), then POSTs a signed decision to `/host/spend-decision`.

Open:

- Official host API for payment-style approvals (buttons, locked-cart preview, merchant domain)?
- Binding Cursor user → `tenantId` / OAuth props?
- Timeout UX: `PENDING` expires after 30 minutes; `CHALLENGE` should wait ~4–5 minutes without flipping to `EXPIRED`.
- `DEV_MODE=true` exposes `dev_set_spend_decision` and `POST /dev/spend-decision` only.

## Mandate / token patterns

Money Bot mirrors principles from:

- **AP2 Cart Mandate** — cart frozen at human approval
- **MCP Agent Pay** scoped tokens — least privilege, short-lived
- **Stripe SPT** — constrained, purpose-built credentials (v1 cards, not v0)

Open: whether a future host token should encode the locked cart hash.

## Branding

- **Primary name:** Money Bot
- **Package / plugin id:** `money-bot`
- “Spend Gate” is an internal metaphor for the state machine, not marketplace copy.
