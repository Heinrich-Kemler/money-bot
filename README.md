# Money Bot

Public Cursor marketplace plugin so any user’s agent can pay for **UK/EU** online checkouts without putting card numbers in the model.

**Package / id:** `money-bot`  
**v0:** approval + checkout handoff only — **never show a raw PAN in chat**  
**v1 (not built):** Revolut **Business Cards** API — document only; no connect, mint, or PCI PAN handling in this repo

Stripe Link is region-locked for many EU users. Money Bot is the human-in-the-loop alternative.

The internal “Spend Gate” metaphor is this state machine. The public name is **Money Bot**.

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID
                                              → CHALLENGE → PAID | FAILED
                                              → FAILED
               ↘ DENIED | EXPIRED
```

| Tool / path | Transition |
| --- | --- |
| (no request) | `IDLE` |
| `request_spend` | `IDLE` → `PENDING` (or new `PENDING` + cart diff if the locked cart changed) |
| Host / `dev_set_spend_decision` Approve | `PENDING` → `APPROVED` — **locks** amount + merchant + domain + shipping |
| Host Deny | `PENDING` → `DENIED` (terminal) |
| Pending TTL | `PENDING` → `EXPIRED` (terminal) |
| `prepare_checkout_handoff` | `APPROVED` → `WAITING_FOR_YOU` |
| `report_checkout_outcome` | `WAITING_FOR_YOU` → `PAID` \| `CHALLENGE` \| `FAILED` |
| After 3DS | `CHALLENGE` → `PAID` \| `FAILED` |
| `edit_spend_cap` | Cap only, still `PENDING`, still needs Approve |

Deny and expire are terminal. The agent cannot self-approve. Editing a spend cap never grants approval. After Approve, a cart mismatch (amount, merchant, domain, or shipping) opens a **new PENDING** with a diff — it does not silently update the locked mandate.

Patterns mirrored (principles only): **AP2 Cart Mandate**, **MCP Agent Pay** scoped tokens, **Stripe SPT**.

## Product

| | v0 (this repo) | v1 (docs only) |
| --- | --- | --- |
| Who pays | Human, on the merchant checkout | Human-approved **virtual** card from **their** Revolut Business |
| What the agent sees | Spend id, amount, merchant, checkout URL, state | Same — **never** PAN/CVC/expiry |
| Auto-approve | £0 (hardcoded) | Still £0 unless a future, explicit host policy |
| PCI | Handoff only; stay out of scope | PAN only into browser fields after `READ_SENSITIVE_CARD_DATA` + IP allowlist, then freeze |

**Never use Revolut Merchant API** (wrong direction). Personal Revolut has no card-issue API.

### Checkout handoff (v0)

- **Apple Pay** on desktop Safari: payment sheet. On desktop **non-Safari**: human scans a QR with iPhone (**iOS 18+**), about **30 seconds**.
- **Revolut Pay**: QR + in-app approve when the merchant supports it; otherwise Apple Pay fallback.
- **SCA / 3DS** is still live in the UK (~£25) and EU (~€30). If a challenge appears, move to **CHALLENGE** and hand back to the human. Amex SafeKey ~**4 min**; Revolut 3DS ~**5 min**.

### v1 Revolut Business Cards (do not implement)

Virtual cards only. Single-transaction + one periodic limit. Freeze/terminate after capture or fail. `TransactionCreated` webhook. Sensitive card data requires `READ_SENSITIVE_CARD_DATA` and an IP allowlist. No Worker-side PAN in chat, memory, or tool results.

## v0 agent flow

1. Fill the merchant cart (amount, merchant URL/domain, shipping).
2. `request_spend` → `{ status: "PENDING", spendRequestId, lockedCart, … }`.
3. Host must show **Approve / Deny** in chat (Stripe Link parity).  
   **TODO(host-approval-bridge):** `POST /host/spend-decision` returns 501 unless `DEV_MODE=true`.
4. `get_spend_status` until `APPROVED` or `DENIED` / `EXPIRED`.
5. `prepare_checkout_handoff` → `WAITING_FOR_YOU`. Open the URL and **hand the screen to the human**.
6. If 3DS appears, `report_checkout_outcome` `CHALLENGE` and wait. Then `PAID` or `FAILED`.
7. Deny is **final**. Same merchant + amount + currency cannot be re-requested for 24 hours.

## Security summary

Hard rules (see [SECURITY.md](SECURITY.md)):

1. Human approves every spend (`AUTO_APPROVE_MAX = 0`).
2. Never put PAN/CVC/expiry in chat, memory, transcripts, or tool results.
3. Secrets only in secret-request / vault env; per-user OAuth (v1, not implemented).
4. v1 ephemeral cards: virtual, amount-capped, time-boxed, freeze on success/fail — **not implemented**.
5. Deny / expire are terminal; no retry spam.
6. Audit: who approved what, when, merchant, amount, locked cart, order id.
7. Multi-tenant: each user connects their Revolut Business; never pool funds.
8. PCI: v0 handoff to stay out of scope.

## Layout

```
README.md
SECURITY.md
docs/open-questions.md
package.json
wrangler.toml
src/
  index.ts
  mcp.ts
  tools/
  schemas.ts
  store.ts
  types.ts          # state machine + locked cart
  logic.ts
skills/money-bot/SKILL.md
plugin/
  .cursor-plugin/plugin.json
  mcp.json
```

Cloudflare’s current authless MCP demo uses `createMcpHandler` (stateless). Money Bot uses **`McpAgent`** plus a `SpendStore` Durable Object so spend state survives across MCP sessions.

Marketplace manifests are also at repo root (`.cursor-plugin/plugin.json`, `mcp.json`). Set `MONEY_BOT_MCP_URL` in Cursor → Plugins → Configure (no secrets in git).

## Install / develop

```bash
npm install
cp .dev.vars.example .dev.vars   # DEV_MODE=true for local Approve/Deny
npm run type-check
npm test
npm start                        # wrangler dev — MCP at http://localhost:8787/mcp
```

Inspect with `npx @modelcontextprotocol/inspector@latest` and connect to `/mcp`.

### MCP tools

| Tool | Role |
| --- | --- |
| `request_spend` | `IDLE` → `PENDING` (https URLs; amount > 0; optional shipping) |
| `get_spend_status` | Full machine status + locked cart + audit |
| `prepare_checkout_handoff` | `APPROVED` → `WAITING_FOR_YOU`; no credentials |
| `report_checkout_outcome` | `PAID` \| `CHALLENGE` \| `FAILED` |
| `edit_spend_cap` | Cap only; still needs Approve |
| `dev_set_spend_decision` | **Only when `DEV_MODE=true`** |

### Deploy

```bash
npx wrangler deploy
# Then set MONEY_BOT_MCP_URL to https://<worker>.workers.dev/mcp
```

Do not put Revolut or OAuth secrets in `wrangler.toml`. Use `wrangler secret put` when v1 exists.

## License

MIT
