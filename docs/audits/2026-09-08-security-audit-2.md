# Money Bot — second audit (adversarial security review)

Date: 2026-09-08 (afternoon)
Repo: `Heinrich-Kemler/money-bot`, `main` at `683fc4e` ("First testable Approve: HMAC-signed browser page")
Scope: full read of `main`, re-check of every finding from the first audit (`docs/audits/2026-09-08-repo-audit.md`), and a live adversarial pass against a local `wrangler dev` instance using only what an agent, an unauthenticated internet caller, or a second tenant would hold.
Mode: read-only. No source, config, or repo settings were changed. Nothing was posted to GitHub.

---

## 1. Executive summary

**Is it all good and secure? No, not yet. The first audit's P0 items were engaged seriously and most of the cheap defects were fixed, but the central invariant, "the agent must never press Approve", is still not enforced by the code.**

- **The agent can approve its own spend using only what the tools return.** `request_spend` hands the agent an `approveUrl` that is a bearer capability. Fetching that URL returns a page containing server-minted Approve and Deny tokens, and posting one of them back completes the decision. I did exactly this against the dev server, holding nothing but the MCP bearer token and tool output: `PENDING` to `APPROVED` to `WAITING_FOR_YOU` with no human in the loop. The PR that landed this path says so in its description. This audit confirms it and rates it P0, because every other control (HS256, `jti` replay protection, fingerprint binding, `decidedBy` rejection) hangs off a token the agent can mint on demand.
- **A new request cancels a human-approved spend.** Any `request_spend` while another spend is `APPROVED`, `WAITING_FOR_YOU`, or `CHALLENGE` marks that earlier spend `FAILED`, whatever the merchant. Live test: after the human's spend at shop 1 was handed off, one unrelated request for shop 2 flipped shop 1 to `FAILED` and handoff for it was refused. A prompt-injected page can do this to a checkout the human is in the middle of paying.
- **The signing and verification code itself held up.** `alg=none`, payload edits with a kept signature, unsigned JSON bodies, missing or wrong `mac`, cross-tenant `tenantId` in the URL, and replayed `jti` were all rejected with the right status codes. Cross-tenant reads returned "not found". Fail-closed without identity works.
- **Production identity still does not exist.** Every production tool call fails closed, which is honest, but `ALLOW_TEST_AUTH=true` is a single environment string that grants any caller any tenant. That is the same class of switch the team removed when it deleted `DEV_MODE`.
- **Docs are now accurate about what shipped**, and issues #3 to #6 track real follow-ups. CI, lint, Node pin, branch protection, and store-level tests are still absent, so none of the above was caught by automation.

Verified on a clean checkout: `npm ci`, `npm run type-check`, `npm test` (40/40), and `wrangler deploy --dry-run` all pass.

---

## 2. What changed since the first audit

| Item | State |
| --- | --- |
| `main` | 4 commits: initial, squashed scaffold (PR #1), first audit (PR #2), HMAC Approve (PR #7) |
| Open PRs | none |
| Open issues | #3 integer minor units, #4 production `userId`, #5 host checkout-outcome, #6 DO pruning |
| Agent MCP tools | exactly 3: `request_spend`, `get_spend_status`, `prepare_checkout_handoff` |
| Removed | `dev_set_spend_decision`, `edit_spend_cap`, `report_checkout_outcome`, `DEV_MODE`, `/dev/spend-decision` (now 410) |
| Added | `GET /approve` page, `POST /host/spend-decision` with HS256 JWT or compact HMAC, `ALLOW_TEST_AUTH` bearer identity, region allowlist, checkout URL binding, sanitize-on-write, smoke script |
| CI / lint / branch protection | still none |

### Status of first-audit findings

| # | Finding | Status on `main` |
| --- | --- | --- |
| P0-1 | No auth, shared `anonymous` tenant | **Partly fixed.** Fails closed without `userId`. No production identity yet (#4). New risk: `ALLOW_TEST_AUTH` (see N-3). |
| P0-2 | Checkout URL not bound to merchant | **Fixed.** Host must equal `merchantDomain` at request, at Approve, and at handoff. No `merchantUrl` fallback. |
| P0-3 | No production approval path | **Replaced by a bearer-URL path.** See N-1. |
| P0-4 | Agent-asserted `PAID` | **Fixed.** Tool removed; host route is 501 (#5). |
| P1-1 | Supersession picks wrong spend, old lock survives | **Half-fixed, net worse.** Old lock is now cancelled, but the wrong-spend selection remains, so unrelated requests cancel approved spends. See N-2. |
| P1-2 | Deny-retry bypass via query string | **Fixed.** Domain-normalised, amount within 0.50, `EXPIRED` included. Introduces N-5. |
| P1-3 | Money as floats | **Partly fixed.** Fingerprints use minor units; diffs and epsilon still float. Tracked in #3. |
| P1-4 | `spendCap` unenforced | **Fixed.** `spendCap >= amount` enforced; tool removed. |
| P1-5 | `AUTO_APPROVE_MAX` env var never read | **Open.** Still declared in `wrangler.toml`, still unread. |
| P1-6 | Line items and country unvalidated | **Open.** |
| P1-7 | Sanitizer false positives | **Mostly fixed.** Luhn gate and identifier-key skip. Still drops `exp`, `card`, `pin`, `cid` keys silently; identifier keys are now never scanned (N-9). |
| P1-8 | Unbounded DO growth | **Open** (#6). Now also `jti:*` keys. |
| P1-9 / P1-10 | `decidedBy` and `tenantId` from body | **Fixed.** Claims only. |
| P1-11 | Reauth resume unreachable | **Open** (accepted as v1). |
| P2-1 | Tool list drift | **Fixed.** |
| P2-2 | Duplicate `plugin/` tree | **Open.** Still byte-identical copies. |
| P2-3 | "Revolut OAuth" comments | **Fixed.** |
| P2-4 | Repo description wording | **Open.** Still "safu" and "ephemeral cards". |
| P2-5 | `cf-typegen` clobbers hand-written types | **Open.** |
| P2-6 | Tests excluded from type-check | **Open.** Both test files excluded. |
| P2-7 | Unused exports | **Partly.** `cartFromRequest`, `SCA_THRESHOLD_*`, `REVOLUT_ACCESS_TOKEN_TTL_MS` still unused. |
| P2-8 | Double DO round-trip in status | **Open.** |
| P2-9 | Legal placeholders, no disclosure contact | **Open.** |
| P2-10 | MCP annotations / output schema | **Open.** |
| P3-1 to P3-8 | CI, lint, Node pin, Dependabot, branch protection, store tests, audit log, error logging | **All open.** Observability is now fully disabled (N-8). |

---

## 3. New findings

Severity: **P0** breaks the product's core security claim. **P1** exploitable defect or integrity loss. **P2** hardening and drift.

### N-1 (P0). The agent can complete Approve with nothing but tool output

**Where.** `src/tools/request_spend.ts:38-45` and `src/tools/get_spend_status.ts:32-39` return `approveUrl`; `src/approve-page.ts:23-40` builds it as `spendRequestId + tenantId + mac`; `src/approve-page.ts:120-188` serves a page whose only gate is that `mac`, and embeds freshly signed Approve and Deny assertions; `src/host-decision.ts:136-186` accepts any such assertion.

**Reproduction (live, dev server).** As "the agent" with only `Authorization: Bearer test:tenant-a`:

```
request_spend                  -> PENDING, approveUrl=http://localhost:8787/approve?spendRequestId=sr_…&tenantId=tenant-a&mac=…
GET approveUrl                 -> 200, page contains <input id="approve-assertion" value="eyJhbGciOiJIUzI1NiJ9…">
POST /host/spend-decision      -> 200 {"status":"APPROVED","decidedBy":"oob-assertion"}
get_spend_status               -> APPROVED
prepare_checkout_handoff       -> WAITING_FOR_YOU, checkoutUrl=https://…/checkout
```

`scripts/smoke-approve.mjs` performs the same sequence. Any agent host with an HTTP fetch tool or a terminal can do it. The record then says `decidedBy: "oob-assertion"`, which is indistinguishable from a real human decision.

**Why the surrounding controls do not help.** The HS256 signature, `iss`/`aud`/`exp`/`iat`, `jti` replay store, `lockedCartFingerprint` binding, and rejection of body `decidedBy` all prove that *the Worker* minted the token. They do not prove a human did anything, because the Worker mints for anyone who presents the `mac`, and the `mac` is handed to the agent. The `mac` itself is a permanent HMAC of `tenant|spendId` with no expiry, no single-use, and no binding to a browser or person.

**Suggested change.** Separate "the agent may point the human at a page" from "the holder of this page may decide":

1. Do not return the capability to the agent. Return an `approveUrl` that identifies the spend (id only, or a short opaque code) but cannot open the decision page on its own.
2. Require an approver credential the agent never sees. Minimum viable for local testing: an `APPROVER_SESSION` cookie set by a separate `/approver/login` page that takes a secret from `.dev.vars` the smoke script is not given, with `SameSite=Strict` and `HttpOnly`. Target for production: WebAuthn/passkey, or the host's own user session, bound to `tenantId`.
3. Bind the minted assertion to that approver credential (include a hash of the session or the credential id in the claims and verify it on POST), so a leaked page cannot be replayed from elsewhere.
4. Make the `mac`, if it survives, short-lived and single-use, and never emit it into a tool result.
5. Change `SECURITY.md` threat #1 to describe the residual until this is done. Today the doc reads as if the agent is technically prevented; it is prevented by the skill's instructions only.
6. Rewrite the smoke script so it requires the approver credential explicitly; the current one is a working exploit and should not be the reference flow.

### N-2 (P1). Any new request cancels a human-approved or in-progress spend

**Where.** `src/logic.ts:336-351` (`findLockedCartMismatch`) still selects the most recently updated spend in `APPROVED`, `WAITING_FOR_YOU`, or `CHALLENGE` regardless of merchant; `src/store.ts:97-115` then calls `supersedeLockedRequest`, which sets it to `FAILED`.

**Reproduction (live).** Spend 1 approved and handed off (`WAITING_FOR_YOU`). One `request_spend` for a different domain and amount:

```
7a second unrelated request -> PENDING, supersededSpendRequestId=<spend 1>, cartDiff.fields=["amount","merchantDomain"]
7b spend 1 status           -> FAILED
7c handoff of spend 1       -> error: requires APPROVED or WAITING_FOR_YOU (got "FAILED")
```

**Impact.** A prompt-injected page, a second conversation, or an honest agent buying two things can silently void the approval the human just gave, and the human may still be paying on the merchant page while Money Bot records `FAILED`. It also converts every multi-item shopping session into a chain of re-approvals.

**Suggested change.** Scope the mismatch check to the same `merchantDomain` (the fingerprint already normalises it), and require an explicit `supersedesSpendRequestId` input for intentional replacement. Never move a `WAITING_FOR_YOU` or `CHALLENGE` spend to `FAILED` from the agent path; the human has the URL. Add a store-level test for two concurrent spends at different merchants.

### N-3 (P1). `ALLOW_TEST_AUTH` is a one-string production takeover

**Where.** `src/test-auth.ts:5-9` and `src/index.ts:29,34`.

If the variable is ever set to `"true"` on a deployed Worker (a pasted `.dev.vars`, a wrong `wrangler secret put`, a copied environment block), any internet caller becomes any tenant with `Authorization: Bearer test:<id>`. Nothing checks the request host, `PUBLIC_BASE_URL`, or the presence of a real identity provider. The team removed `DEV_MODE` for exactly this reason and then reintroduced the pattern under a new name.

**Suggested change.** Refuse test auth unless the request's `Host` is `localhost` or `127.0.0.1` and `PUBLIC_BASE_URL` starts with `http://localhost`. Log a startup warning when enabled. Longer term, replace with the real identity layer from issue #4 and delete this file.

### N-4 (P1). Unauthenticated callers can create MCP sessions and Durable Objects

**Where.** `src/index.ts:28-36`. Identity is only checked inside tool handlers (`toolContext()`), so `initialize`, `notifications/initialized`, and `tools/list` succeed with no credentials, and each session instantiates a `MoneyBotMCP` Durable Object.

**Reproduction (live).** Without any header: `initialize` 200, `tools/list` 200 with three tools, `tools/call` returns the fail-closed error. Only the last step is gated.

**Impact.** Free DO instantiation and storage per anonymous session; tool metadata disclosed. No rate limit exists.

**Suggested change.** Resolve identity in the top-level `fetch()` and return 401 before routing to `McpAgent.serve` when none is present. Add a Cloudflare rate-limit binding or WAF rule on `/mcp`, `/sse`, `/approve`, and `/host/*`.

### N-5 (P1). Cooldown poisoning: an agent can lock a merchant and amount for 24 hours

**Where.** `src/logic.ts:249-315`. `EXPIRED` spends now count toward the 24-hour cooldown, and any `DENIED`/`EXPIRED` spend at the same domain blocks amounts within 0.50.

**Reproduction (logic-level).** An agent-created spend for £10 at `a.co.uk` that simply expires after 30 minutes blocks a legitimate £10.40 request at `a.co.uk` for 24 hours. No human action is needed; the agent (or a page it read) only has to call `request_spend`.

**Impact.** Denial of service against the user's own purchases, triggered by the least-trusted party.

**Suggested change.** Only human `DENIED` decisions should start a cooldown. `EXPIRED` should at most rate-limit re-requests for a few minutes. Let the human override the cooldown from the approve page ("approve anyway").

### N-6 (P2). Approve page is framable and leaks its URL

**Where.** `src/approve-page.ts:99-107`. CSP is present but has no `frame-ancestors`; there is no `X-Frame-Options` and no `Referrer-Policy`. The result page from `src/host-decision.ts:118-124` has no CSP at all.

**Impact.** The page can be embedded in an iframe, including by a chat UI, which is precisely the in-chat Approve the docs forbid. The URL carries `mac` and `tenantId` in the query string, so it lands in browser history, proxies, and any Referer if a link is ever added.

**Suggested change.** Add `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` to both pages. Consider moving the capability out of the query string once N-1 is addressed.

### N-7 (P2). No bounds on `amount`; merchant name is free text

**Where.** `src/schemas.ts:27` accepts any positive finite number; `src/logic.ts:112-114` rounds to minor units.

**Reproduction (live).** `amount: 1e300` and `amount: 0.001` both created `PENDING` spends. `merchantName: "Amazon.co.uk"` with `merchantUrl: https://amazon-uk-official-deals.co.uk` was accepted and would be shown to the human as "Amazon.co.uk" on the approve page.

**Suggested change.** Enforce `0.01 <= amount <= <configurable cap>` with at most two decimals (or move to integer minor units, #3). On the approve page, show the domain first and larger than the merchant name, or derive the displayed name from the domain. Show `description` and `lineItems` on the approve page; today the human approves an amount without seeing what is being bought.

### N-8 (P2). Observability fully disabled

**Where.** `wrangler.toml:10-18` sets `observability.enabled = false`.

**Impact.** No logs, metrics, or errors from a payments-adjacent service. Attacks such as N-1 and N-5 leave no trace. The stated reason (request bodies) is only partly right: Workers invocation logs do not include bodies, but they do include request URLs, and `approveUrl` carries `mac` in the query string.

**Suggested change.** Keep `invocation_logs = false`, enable `observability` with head sampling, and emit explicit structured `console.log` events (decision applied, jti replayed, fingerprint mismatch, unauthenticated tool call) that never include tokens or URLs with query strings.

### N-9 (P2). Sanitizer gaps in both directions

**Where.** `src/sanitize.ts:1-34, 81-102`.

Identifier keys (`orderId`, `id`, `jti`, …) are now never scanned, so a Luhn-valid PAN placed in one passes through unredacted (verified: `orderId: "4111111111111111"` survived). Meanwhile the key blocklist still deletes `exp`, `card`, `pin`, `cid` wholesale; a `cid: "customer-1"` field vanished silently. `errorToolResult` no longer sanitises at all, and tool error strings embed caller input (domain, host).

**Suggested change.** Scan identifier keys with the Luhn gate too (a real order id will almost never be Luhn-valid at 13 to 19 digits). Narrow the key blocklist to unambiguous card fields. Sanitise error text. Log when a redaction fires.

### N-10 (P2). Region and checkout-host rules will reject most real merchants

**Where.** `src/region.ts:19-60, 76-95`.

The suffix allowlist accepts any registrable `.co.uk` (so lookalike domains pass) and rejects most large EU retailers on `.com` (`zalando.com` rejected, live). The checkout host must equal the merchant host, so Shopify (`checkout.shopify.com`), Stripe Checkout, PayPal, and even the merchant's own `checkout.` subdomain are rejected (`checkout.shop.co.uk` rejected, live). These are product decisions, not vulnerabilities, but they mean the v0 flow will fail on the first real checkout.

**Suggested change.** Treat region as a warning shown to the human rather than a hard block, or allowlist by explicit merchant rather than TLD. Allow subdomains of the merchant domain for `checkoutUrl`, and maintain a short allowlist of known PSP checkout hosts that the human sees named on the approve page.

### N-11 (P2). Small correctness and hygiene items

- `src/store.ts:179-183` burns the `jti` before `applyDecision` can fail, so a failed decision consumes a token. Harmless today (the page re-mints), but reorder or wrap in one storage transaction.
- `src/approve-page.ts:32-38` silently omits `mac` when the secret is missing; `src/public-url.ts` defaults to `http://localhost:8787`. A production deploy without either variable emits localhost approve URLs with no capability. Fail loudly when `PUBLIC_BASE_URL` is unset or not `https`.
- `.dev.vars.example` ships `APPROVAL_HMAC_SECRET=dev-only-hmac-secret-change-me`, which passes the 16-character minimum. Reject known example values and require 32 or more characters.
- `AGENT_MCP_TOOLS` is asserted in tests but not used to drive registration (`void AGENT_MCP_TOOLS`). A tool could be registered without the constant or the test changing. Register from the constant, or test the live `McpServer` tool list.
- `diffLockedCart` ignores `checkoutUrl` even though the lock includes it, so a "same cart, different path" request reports no diff (it is correctly refused as "already locked", but the diff type is misleading).
- Two copies of `escapeHtml`; `plugin/` still duplicates root files byte-for-byte; both test files still excluded from `tsc`; `worker-configuration.d.ts` still hand-written under a `cf-typegen` script that would overwrite it.
- `AUTO_APPROVE_MAX` remains a declared-but-unread variable.

---

## 4. Adversarial test matrix

All against `wrangler dev` with `.dev.vars` from the example file, using a throwaway script. "Held" means the control worked.

| Attack | Result |
| --- | --- |
| Agent fetches `approveUrl` and posts the embedded JWT | **Approved.** No human involved. (N-1) |
| Replay the same approve JWT | Held: 409 `replayed_jti` |
| Use the Deny JWT after Approve | Held: 409 (not `PENDING`) |
| JWT with `alg: none` | Held: 401 `bad_assertion` |
| Edit JWT payload, keep signature | Held: 401 `bad_signature` |
| Unsigned JSON body with `decision`, `tenantId`, `decidedBy` | Held: 401 `missing_assertion` |
| `GET /approve` without `mac`, with wrong `mac`, with another tenant's id | Held: 403 in all three cases |
| Tenant B reads tenant A's spend | Held: "not found" |
| `Bearer test:anonymous` | Held: fail closed |
| Unauthenticated `initialize` and `tools/list` | **Allowed** (DO created). `tools/call` fails closed. (N-4) |
| Unrelated `request_spend` while a spend is `WAITING_FOR_YOU` | **Approved spend set to `FAILED`.** (N-2) |
| Expired agent spend blocks human's later request at same domain | **Blocked for 24h.** (N-5) |
| `amount: 1e300`, `amount: 0.001` | **Accepted.** (N-7) |
| `merchantName: "Amazon.co.uk"` on lookalike `.co.uk` | **Accepted.** (N-7) |
| `https://shop.co.uk@evil.com/` as merchant | Held: host parsed as `evil.com`, rejected |
| `https://evil.co.uk#@shop.co.uk` | Passes allowlist as `evil.co.uk` (heuristic, expected) |
| Punycode host `xn--…co.uk` | Passes allowlist; shown to human in punycode |
| PAN in `orderId` field through sanitizer | **Not redacted.** (N-9) |
| Framing the approve page | No `frame-ancestors` or `X-Frame-Options`. (N-6) |
| `/dev/spend-decision`, `/host/checkout-outcome` | 410 and 501 as documented |

---

## 5. What is in good shape

- The assertion code is careful: constant-time comparison, `HS256` pinned, `iss`/`aud`/`exp`/`iat` checked with skew, `jti` persisted per tenant, fingerprint bound to amount, domain, currency, shipping, and checkout URL. It is a solid base once a human factor is added.
- Fail-closed identity, tenant isolation, and the removal of every agent-callable decide, outcome, and cap tool were done cleanly and are tested.
- Checkout URL binding is enforced in three places and refuses `merchantUrl` fallback.
- HTML output is escaped everywhere I looked; CSP on the approve page blocks scripts and off-site form posts.
- Docs now say what the code does, including the bearer-URL residual, and the four open issues are the right follow-ups.

---

## 6. Recommended order of work

1. **N-1** first. Nothing else matters for the product's claim until the agent cannot decide. Even the local-test version should require a credential the smoke script has to be given explicitly.
2. **N-2** and **N-5** next; both are small changes in `logic.ts` and `store.ts` with clear tests, and both let the least-trusted party damage the human's state.
3. **N-3** and **N-4**: gate test auth by host, and reject unauthenticated MCP at the edge. Then issue #4 for real identity.
4. **CI, lint, Node pin, branch protection** (first audit P3-1 to P3-5). Every finding above was reachable by a test that does not exist yet; store-level tests with `@cloudflare/vitest-pool-workers` would have caught N-2 and N-4 outright.
5. **N-6, N-7, N-8, N-9** as one hardening pass.
6. **N-10** is a product decision to make before the first real merchant is tried.

Nothing above touches the v1 Revolut path, which should stay documentation-only.
