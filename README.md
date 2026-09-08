# Money Bot

> **Not production.** First testable Approve is **local HMAC-signed browser Approve**, not passkey/WebAuthn. Do not use this Worker to move real money. The shopping agent cannot Approve or mark `PAID`.

Public Cursor marketplace plugin so an agent can request human approval for a **UK/EU** online checkout without putting card numbers in the model.

**Package / id:** `money-bot`  
**v0 (this repo):** approval-request + checkout **URL handoff** only. Revolut Business connect is **not implemented**.  
**v1 (not built):** optional per-tenant Revolut Business virtual cards — document only; no connect, mint, or PAN handling here.

Money Bot is **software that requests approval and returns a URL**. It does not hold funds, issue cards, or provide regulated payment services. This is not a legal or PCI assessment.

The internal “Spend Gate” metaphor is the state machine. The public name is **Money Bot**.

## Production agent tools (complete list)

These are the **only** MCP tools registered in production. There is no `DEV_MODE` Approve tool.

| Tool | Role |
| --- | --- |
| `request_spend` | `IDLE` → `PENDING`. Requires UK/EU merchant + https `checkoutUrl` on that domain. Returns `approveUrl`. |
| `get_spend_status` | Machine status + locked cart + `tenantConnection`. Includes `approveUrl` while `PENDING`. |
| `prepare_checkout_handoff` | `APPROVED` → `WAITING_FOR_YOU`. Returns the locked `checkoutUrl` (**the money path**). |

There is **no** `edit_spend_cap`, `report_checkout_outcome`, or `dev_set_spend_decision` tool.

## First testable Approve (local HMAC)

This is a **browser page** that posts a **server-minted** HS256 JWT / HMAC assertion to `POST /host/spend-decision`. It is **not** passkey/WebAuthn and **not** a real card charge.

1. Copy env and start wrangler:

   ```bash
   npm install
   cp .dev.vars.example .dev.vars
   npm start                        # wrangler dev — http://localhost:8787
   ```

2. Local MCP identity (`ALLOW_TEST_AUTH=true` in `.dev.vars` only): send  
   `Authorization: Bearer test:<userId>`  
   Production `wrangler.toml` leaves `ALLOW_TEST_AUTH` **unset** (default false). Missing `userId` **fails closed**.

3. Call `request_spend` for a fake UK/EU merchant (GBP + allowlisted domain + `https` `checkoutUrl` on that host).

4. Open the returned `approveUrl` in a **browser**. The agent must not complete Approve.

5. Click **Approve**. Spend becomes `APPROVED` with a locked-cart re-snapshot.

6. Call `prepare_checkout_handoff` → locked `checkoutUrl` only.

7. **Deny** uses the same page / assertion path.

Or run the smoke (wrangler already up):

```bash
./scripts/smoke-approve.sh
```

`POST /host/checkout-outcome` stays **501**. No Revolut, no PAN, no marketplace, no real card charge.

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID
                                              → CHALLENGE → PAID | FAILED
                                              → FAILED
               ↘ DENIED | EXPIRED
               ↘ REAUTH_REQUIRED   (planned v1 tenant re-consent)
```

Tenant connection (exists from day one, unused in v0):

```
NOT_CONNECTED → CONNECTED → REAUTH_REQUIRED → CONNECTED
```

| Path | Transition |
| --- | --- |
| (no request) | `IDLE` |
| `request_spend` | `IDLE` → `PENDING` + `approveUrl` |
| **Signed OOB** Approve (`GET /approve` → `POST /host/spend-decision`) | `PENDING` → `APPROVED` — re-snapshots amount + merchant + domain + **checkoutUrl** + shipping. Token **must bind `lockedCartFingerprint`**. Raw `decidedBy` is rejected. `tenantId` is never taken from a request body. |
| Human Deny (same signed assertion) | `PENDING` → `DENIED` (terminal) |
| Pending TTL | `PENDING` → `EXPIRED` (terminal; also enters the retry cooldown) |
| `prepare_checkout_handoff` | `APPROVED` → `WAITING_FOR_YOU` — opens **only** the locked https `checkoutUrl` (host = `merchantDomain`) |
| `get_spend_status` | Full status + `tenantConnection` |
| Host/OOB checkout outcome — **not an agent tool, HTTP 501** | `WAITING_FOR_YOU` → `PAID` / `CHALLENGE` / `FAILED` |

A chat control may only **initiate** Approve (`approveUrl`). The **agent must never press Approve**.

`checkoutUrl` is the **money path**. It is locked to `merchantDomain` at request time, re-validated at Approve, and the only URL handoff will open. Never fall back to `merchantUrl`. A cart mismatch opens a **new PENDING** and **cancels** the previous `APPROVED` lock (`FAILED` + `supersededBySpendRequestId`).

Deny/expire retries match merchant domain (www-normalized) + currency + amount within £/€0.50 for 24h, plus cart fingerprint and lineage.

v0 merchants must be **UK/EU-looking domains** (public-suffix allowlist) and **GBP/EUR**. Other regions return a clear error. This is a heuristic, not a legal geo check.

If a `spendCap` is set, it must be **≥ amount**.

## Product (intent — not shipped)

| | v0 (this repo) | v1 (docs only) |
| --- | --- | --- |
| Who pays | Human, on the merchant’s own checkout page | Planned: human-approved virtual card from **their** Revolut Business — never a pooled float |
| Revolut | Not connected | Planned wizard (cert + `client_id` + JWT + Enable access). **No public OAuth.** Token ~40m; **~90-day re-consent** |
| What the agent sees | Spend id, amount, merchant, locked checkout URL, `approveUrl`, state | Same — never PAN/CVC/expiry |
| Approve | Local HMAC-signed browser page (not passkey yet) | Planned phone passkey / PWA |
| Card data | v0 does not fetch or store PAN. That is a **design goal**, not a QSA “out of CDE” certification. | Any future PAN fetch would need a PCI program (likely SAQ D unless a vault/iframe). Not assessed. |

Money Bot does not implement Apple Pay, Revolut Pay, or 3-D Secure. Those, if they appear, are the **merchant page’s** UI after the human opens the locked URL.

### v1 Revolut Business (do not implement)

Virtual cards only. Single-transaction + one periodic limit. Freeze/terminate after capture or fail. Never store CVV. Prefer a PCI vault/iframe over Worker-side PAN if that path is ever built.

## Cursor / MCP Apps

Cursor **2.6+** can render an **MCP Apps** sandboxed iframe card. Money Bot must also ship a **mandatory plain-text fallback** (tool results + this skill). Cursor marketplace listing is **manual review**.

## v0 agent flow

1. Fill the merchant cart (amount, merchant URL/domain, shipping, **checkout URL**).
2. `request_spend` → `{ status: "PENDING", spendRequestId, lockedCart, approveUrl, … }`.
3. Tell the human to open `approveUrl` in a browser. **Do not click Approve yourself.**
4. `get_spend_status` until `APPROVED`, `DENIED`, `EXPIRED`, or `REAUTH_REQUIRED`.
5. `prepare_checkout_handoff` → `WAITING_FOR_YOU`. Hand the human the locked `checkoutUrl` only. Never show a raw PAN. Do **not** mark `PAID`.

## Security summary

See [SECURITY.md](SECURITY.md):

1. Human OOB approval every spend (`AUTO_APPROVE_MAX = 0`). Agent cannot Approve. No decide tool.
2. `POST /host/spend-decision` verifies a signed JWT/HMAC (`iss`, `aud`, `exp`, `iat`, `jti`, `spendRequestId`, `tenantId`, `decision`, `lockedCartFingerprint`) and calls `applyDecision` only with `assertionVerified: true`.
3. Never put PAN/CVC/expiry in chat, memory, transcripts, or tool results.
4. No public Revolut OAuth. No pooled funds.
5. Deny / expire are terminal and share a retry cooldown.
6. Observability invocation logs / traces are **off** so request bodies are not shipped to Workers Logs.
7. Production MCP without `props.userId` fails closed. `ALLOW_TEST_AUTH` is local-only.

## Layout

```
README.md
SECURITY.md
docs/open-questions.md
src/   # request_spend, get_spend_status, prepare_checkout_handoff
scripts/smoke-approve.sh
skills/money-bot/SKILL.md
plugin/
```

## Install / develop

```bash
npm install
cp .dev.vars.example .dev.vars
npm run type-check
npm test
npm start                        # wrangler dev — MCP at http://localhost:8787/mcp
./scripts/smoke-approve.sh       # optional e2e (server already running)
```

There is no `DEV_MODE` Approve switch. Local Approve is the HMAC-signed `/approve` page only.

## Disclaimer

Money Bot is a scaffold. It does not hold funds, issue cards, or provide regulated payment services. Obtain local regulatory advice before any production or v1 work. Mention of FCA / KNF is a reminder to seek advice — not a claim that this software is authorised or assessed.

## License

MIT
