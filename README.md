# Money Bot

> **Not production.** First testable Approve is **local HMAC-signed browser Approve**, not passkey/WebAuthn. Do not use this Worker to move real money. The agent has **no decide MCP tool** and cannot mark `PAID`. `approveUrl` is a **bearer capability** for this local first test: whoever possesses the URL (human, agent, or smoke script) can complete Approve/Deny by fetching/posting it. That does **not** prove a human acted.

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
| `request_spend` | `IDLE` → `PENDING`. Requires UK/EU merchant + https `checkoutUrl` on that domain. Returns `widget` (Approve / Reject / Keep looking) plus `approveUrl` (**local smoke only**). |
| `get_spend_status` | Machine status + locked cart + `tenantConnection`. Includes `widget` + `approveUrl` while `PENDING`. |
| `prepare_checkout_handoff` | `APPROVED` → `WAITING_FOR_YOU`. Returns the locked `checkoutUrl` (**the money path**). |

There is **no** `edit_spend_cap`, `report_checkout_outcome`, or `dev_set_spend_decision` tool.

## First testable Approve (local HMAC)

This is a **browser page** that posts a **server-minted** HS256 JWT / HMAC assertion to `POST /host/spend-decision`. It is **not** passkey/WebAuthn and **not** a real card charge.

`approveUrl` is a **bearer capability** for this local first test only. Possession of the URL — including by the agent or `./scripts/smoke-approve.sh` — is enough to complete Approve or Deny (GET the page, POST the minted assertion). That is acceptable for local first test. **TODO:** true human proof (passkey/WebAuthn / out-of-band device auth). Do not claim Approve proves a human today.

1. Copy env and start wrangler:

   ```bash
   npm install
   cp .dev.vars.example .dev.vars
   npm start                        # wrangler dev — http://localhost:8787
   ```

2. Local MCP identity (`ALLOW_TEST_AUTH=true` **and** `ENVIRONMENT=development` in `.dev.vars` only): send  
   `Authorization: Bearer test:<userId>`  
   Production `wrangler.toml` sets `ENVIRONMENT=production` and **must not** set `ALLOW_TEST_AUTH`. If `ALLOW_TEST_AUTH=true` is ever present on that production path, the Worker **refuses to start serving** (HTTP 500). Even in development, test auth is honored only on `localhost` / `127.0.0.1`. Missing `userId` **fails closed** (MCP `initialize` / `tools/list` / `tools/call` are **401** and do not allocate tenant Durable Objects).

3. Call `request_spend` for a fake UK/EU merchant (GBP + allowlisted domain + `https` `checkoutUrl` on that host).

4. Open the returned `approveUrl` in a **browser** (or let the smoke script fetch/post it — same bearer URL).

5. Click **Approve**. Spend becomes `APPROVED` with a locked-cart re-snapshot.

6. Call `prepare_checkout_handoff` → locked `checkoutUrl` only.

7. **Deny** uses the same page / assertion path.

Or run the **local** `approveUrl` smoke (wrangler already up):

```bash
./scripts/smoke-approve.sh
```

### Grokbot / Life Admin widget (human-only)

Grokbot SoD depends on Life Admin rendering `widget` and posting `POST /host/widget-decision` with `HOST_API_TOKEN` — **not** the model fetching `approveUrl`. See [docs/design/grokbot-widget-approve.md](docs/design/grokbot-widget-approve.md).

```bash
# .dev.vars must include HOST_API_TOKEN (see .dev.vars.example)
./scripts/smoke-widget-approve.sh
```

`Authorization: Bearer host:<HOST_API_TOKEN>`. Body `{ spendRequestId, decision: "approved"|"denied"|"keep_looking", lockedCartFingerprint }`. Tenant from `X-Money-Bot-Tenant` (lookup only). Worker mints+verifies `iss=grokbot-widget` before `applyDecision`. Keep looking → `CANCELLED` (no 24h deny cooldown). Missing token → 401. Not an MCP tool.

`POST /host/checkout-outcome` stays **501**. No Revolut, no PAN, no marketplace, no real card charge.

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID
                                              → CHALLENGE → PAID | FAILED
                                              → FAILED
               ↘ DENIED | EXPIRED | CANCELLED
               ↘ REAUTH_REQUIRED   (planned v1 tenant re-consent)
```

Tenant connection (exists from day one, unused in v0):

```
NOT_CONNECTED → CONNECTED → REAUTH_REQUIRED → CONNECTED
```

| Path | Transition |
| --- | --- |
| (no request) | `IDLE` |
| `request_spend` | `IDLE` → `PENDING` + `widget` + `approveUrl` (local smoke only) |
| **Grokbot widget** (`POST /host/widget-decision`) | Human tap → `APPROVED` / `DENIED` / `CANCELLED`. Server-minted `iss=grokbot-widget` assertion (`lockedCartFingerprint` + `jti`). Body `tenantId` / `decidedBy` are not authority. |
| **Signed OOB** Approve (`GET /approve` → `POST /host/spend-decision`) | Local smoke: `PENDING` → `APPROVED`. Bearer `approveUrl`, not human proof. |
| Human Deny (widget Reject or OOB Deny) | `PENDING` → `DENIED` (terminal; 24h same-domain cooldown) |
| Keep looking (widget) | `PENDING` → `CANCELLED` (terminal; **no** deny cooldown) |
| Pending TTL | `PENDING` → `EXPIRED` (terminal; **no** human-deny cooldown — a new same-cart request is allowed) |
| `prepare_checkout_handoff` | `APPROVED` → `WAITING_FOR_YOU` — opens **only** the locked https `checkoutUrl` (host = `merchantDomain`) |
| `get_spend_status` | Full status + `tenantConnection` |
| Host/OOB checkout outcome — **not an agent tool, HTTP 501** | `WAITING_FOR_YOU` → `PAID` / `CHALLENGE` / `FAILED` |

Tool results return a `widget` for Life Admin and `approveUrl` for local smoke. That URL is a bearer capability, not human proof. **No decide MCP tool ≠ approveUrl is human-proof.** Grokbot SoD depends on the widget + `HOST_API_TOKEN` path ([implemented design](docs/design/grokbot-widget-approve.md)).

`checkoutUrl` is the **money path**. It is locked to `merchantDomain` at request time, re-validated at Approve, and the only URL handoff will open. Never fall back to `merchantUrl`. A **same-merchant** cart mismatch (or explicit same-domain `supersedes`) opens a **new PENDING** and **cancels** that shop’s previous lock (`FAILED` + `supersededBySpendRequestId`). Agent `supersedes` of a **different** merchant is **rejected**. A request at a different merchant without `supersedes` leaves the other shop’s lock intact.

Human **Deny** retries match merchant domain (www-normalized) + currency + amount within £/€0.50 for 24h, plus cart fingerprint and lineage. **`EXPIRED` (timeout) does not** start that cooldown.

v0 merchants must be **UK/EU-looking domains** (public-suffix allowlist) and **GBP/EUR**. Other regions return a clear error. This is a heuristic, not a legal geo check.

If a `spendCap` is set, it must be **≥ amount**.

## Product (intent — not shipped)

| | v0 (this repo) | v1 (docs only) |
| --- | --- | --- |
| Who pays | Human, on the merchant’s own checkout page | Planned: human-approved virtual card from **their** Revolut Business — never a pooled float |
| Revolut | Not connected | Planned wizard (cert + `client_id` + JWT + Enable access). **No public OAuth.** Token ~40m; **~90-day re-consent** |
| What the agent sees | Spend id, amount, merchant, locked checkout URL, `approveUrl`, state | Same — never PAN/CVC/expiry |
| Approve | Grokbot widget (`POST /host/widget-decision`) + local HMAC `approveUrl` (bearer; smoke only) | **TODO** phone passkey / WebAuthn |
| Card data | v0 does not fetch or store PAN. That is a **design goal**, not a QSA “out of CDE” certification. | Any future PAN fetch would need a PCI program (likely SAQ D unless a vault/iframe). Not assessed. |

Money Bot does not implement Apple Pay, Revolut Pay, or 3-D Secure. Those, if they appear, are the **merchant page’s** UI after the human opens the locked URL.

### v1 Revolut Business (do not implement)

Virtual cards only. Single-transaction + one periodic limit. Freeze/terminate after capture or fail. Never store CVV. Prefer a PCI vault/iframe over Worker-side PAN if that path is ever built.

## Cursor / MCP Apps

Cursor **2.6+** can render an **MCP Apps** sandboxed iframe card. Money Bot must also ship a **mandatory plain-text fallback** (tool results + this skill). Cursor marketplace listing is **manual review**.

## v0 agent flow

1. Fill the merchant cart (amount, merchant URL/domain, shipping, **checkout URL**).
2. `request_spend` → `{ status: "PENDING", spendRequestId, lockedCart, widget, approveUrl, … }`.
3. Life Admin: show `widget` (Approve / Reject / Keep looking). Local: give the human `approveUrl`. The agent must not fetch `approveUrl`. **No decide MCP tool ≠ approveUrl is human-proof.**
4. `get_spend_status` until `APPROVED`, `DENIED`, `EXPIRED`, or `REAUTH_REQUIRED`.
5. `prepare_checkout_handoff` → `WAITING_FOR_YOU`. Hand the human the locked `checkoutUrl` only. Never show a raw PAN. Do **not** mark `PAID`.

## Security summary

See [SECURITY.md](SECURITY.md):

1. `AUTO_APPROVE_MAX = 0`. No decide MCP tool. Local `approveUrl` is a bearer capability (not human proof). Grokbot uses `POST /host/widget-decision` + `HOST_API_TOKEN`. Passkey/WebAuthn remains TODO.
2. `POST /host/widget-decision` and `POST /host/spend-decision` verify a signed JWT/HMAC (`iss` = `grokbot-widget` or `money-bot-oob`, plus `aud`, `exp`, `iat`, `jti`, `spendRequestId`, `tenantId`, `decision`, `lockedCartFingerprint`) and call `applyDecision` only with `assertionVerified: true`. `HOST_API_TOKEN` does not skip fingerprint/`jti` checks.
3. Never put PAN/CVC/expiry in chat, memory, transcripts, or tool results.
4. No public Revolut OAuth. No pooled funds.
5. Human Deny is terminal and has a 24h cooldown. `EXPIRED` and `CANCELLED` (Keep looking) do **not** share that cooldown.
6. Observability invocation logs / traces are **off** so request bodies are not shipped to Workers Logs.
7. Production MCP without `props.userId` fails closed at the edge (no tenant DO). `ALLOW_TEST_AUTH` is impossible/inert on the production `wrangler.toml` path.

## Layout

```
README.md
SECURITY.md
docs/open-questions.md
docs/design/grokbot-widget-approve.md
src/   # request_spend, get_spend_status, prepare_checkout_handoff
scripts/smoke-approve.sh
scripts/smoke-widget-approve.sh
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
./scripts/smoke-approve.sh       # optional e2e approveUrl (server already running)
./scripts/smoke-widget-approve.sh  # host widget path (no approveUrl)
```

There is no `DEV_MODE` Approve switch. Local Approve is the HMAC-signed `/approve` page or `POST /host/widget-decision`.

## Disclaimer

Money Bot is a scaffold. It does not hold funds, issue cards, or provide regulated payment services. Obtain local regulatory advice before any production or v1 work. Mention of FCA / KNF is a reminder to seek advice — not a claim that this software is authorised or assessed.

## License

MIT
