# Money Bot

Public Cursor marketplace plugin so any user’s agent can pay for **UK/EU** online checkouts without putting card numbers in the model.

**Package / id:** `money-bot`  
**v0:** human Approve/Deny → checkout handoff → human completes Apple Pay / Revolut Pay / 3DS  
**v1 (not built):** Revolut **Business Cards** API, single-use amount-capped cards — see [docs/open-questions.md](docs/open-questions.md)

Stripe Link is region-locked for many EU users. Money Bot is the human-in-the-loop alternative.

## Product

| | v0 (this repo) | v1 (docs only) |
| --- | --- | --- |
| Who pays | Human, on the merchant checkout | Human-approved virtual card from **their** Revolut Business |
| What the agent sees | Spend id, amount, merchant, checkout URL | Same — **never** PAN/CVC/expiry |
| Auto-approve | £0 (hardcoded) | Still £0 unless a future, explicit host policy |
| PCI | Prefer handoff; stay out of scope | PAN only into browser fields, then freeze |

**Never use Revolut Merchant API** (wrong direction). Personal Revolut has no card-issue API.

## v0 agent flow

1. Agent fills the cart.
2. `request_spend` → `{ status: "pending_approval", spendRequestId, … }`.
3. Host must show **Approve / Deny** in chat (Stripe Link parity).  
   **TODO(host-approval-bridge):** production UI is not wired; `POST /host/spend-decision` returns 501 unless `DEV_MODE=true`.
4. `get_spend_status` until `approved` or `denied`.
5. On approve, `prepare_checkout_handoff` → open URL, **hand the screen to the human**.
6. Deny is **final** for that request. Same merchant + amount + currency cannot be re-requested for 24 hours.

## Security summary

Hard rules (see [SECURITY.md](SECURITY.md)):

1. Human approves every spend (`AUTO_APPROVE_MAX = 0`).
2. Never put PAN/CVC/expiry in chat, memory, transcripts, or tool results.
3. Secrets only in secret-request / vault env; per-user OAuth (v1).
4. v1 ephemeral cards: amount-capped, time-boxed, freeze on success/fail — **not implemented**.
5. Deny is final; no retry spam.
6. Audit: who approved what, when, merchant, amount, order id.
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
  tools/          # request_spend, get_spend_status, prepare_checkout_handoff
  schemas.ts
  store.ts        # per-tenant Durable Object
  types.ts
skills/money-bot/SKILL.md
plugin/
  .cursor-plugin/plugin.json
  mcp.json
```

Cloudflare’s current authless MCP demo uses `createMcpHandler` (stateless). Money Bot uses **`McpAgent`** plus a `SpendStore` Durable Object so spend state survives across MCP sessions.

Marketplace manifests are also at repo root (`.cursor-plugin/plugin.json`, `mcp.json`) so a single-plugin listing resolves. Set `MONEY_BOT_MCP_URL` in Cursor → Plugins → Configure (no secrets in git).

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
| `request_spend` | Create `pending_approval` (zod-validated; https URLs; amount > 0) |
| `get_spend_status` | Full status + audit fields |
| `prepare_checkout_handoff` | Requires `approved` \| `checkout_ready`; no credentials |
| `dev_set_spend_decision` | **Only when `DEV_MODE=true`** |

### Deploy

```bash
npx wrangler deploy
# Then set MONEY_BOT_MCP_URL to https://<worker>.workers.dev/mcp
```

Do not put Revolut or OAuth secrets in `wrangler.toml`. Use `wrangler secret put` when v1 exists.

## License

MIT
