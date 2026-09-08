# Open questions

Tracked decisions for Money Bot (`money-bot`). Nothing here is implemented as card minting.

## Revolut Business Cards API and app review

v1 (docs/stubs only) should mint **single-use virtual cards** via the Revolut **Business Cards** API, amount-capped and time-boxed, then freeze after capture or failure.

Open:

- What is the current Business Cards API partner / app-review path (UK entity vs EU entity)?
- Which scopes are required to create, retrieve (into a browser-only channel), and freeze cards?
- Can PAN be injected into checkout fields without the PAN ever entering MCP tool results or Worker logs?
- Rate limits, webhook events (`card.transaction.*`), and 3DS challenges on virtual cards?
- Confirm again: **do not** use Revolut Merchant API (that is for accepting payments, the wrong direction).
- Confirm again: personal Revolut has **no** card-issue API.

## UK vs EU legal entity

Stripe Link is region-locked for many EU users; Money Bot is aimed at UK/EU checkouts.

Open:

- Does v1 need a UK Ltd, an EU entity, or both for Revolut Business + card issuing?
- SCA / PSD2 / consumer-duty implications when an agent initiates checkout but a human authenticates?
- VAT, merchant-of-record, and whether Money Bot is ever in the funds flow (v0: no; v1: user's own Business account only).

## Cursor marketplace listing for payments plugins

Open:

- Review bar for plugins that can move money even with human-in-the-loop?
- Required security questionnaire, PCI statements, and whether a Worker URL + `${MONEY_BOT_MCP_URL}` variable is acceptable?
- How secret-request / vault env is declared for later Revolut OAuth (per user, never in git)?
- Dual layout: this repo is a single plugin (`name`: `money-bot`) with manifests at repo root and a copy under `plugin/` as specified by the scaffold.

## Host Approve / Deny UI

`autoApproveMax` is fixed at **0**. `request_spend` only creates `pending_approval`.

**TODO(host-approval-bridge):** Cursor (or another host) must show Approve/Deny in chat, Stripe Link parity, then POST a signed decision to `/host/spend-decision`.

Open:

- Official host API for payment-style approvals (buttons, amount preview, merchant URL)?
- How the host authenticates to the Worker and binds Cursor user → `tenantId` / OAuth props?
- Timeout / expiry UX when the human never decides (v0 expires pending requests after 30 minutes)?
- Until that lands: `DEV_MODE=true` exposes `dev_set_spend_decision` and `POST /dev/spend-decision` for local tests only.

## Branding

- **Primary name:** Money Bot
- **Package / plugin id:** `money-bot`
- Avoid shipping alternate product names in marketplace copy; “safu agent payments” is descriptive, not the title.
