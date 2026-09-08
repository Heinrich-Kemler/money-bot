# Money Bot — repository and project audit

Date: 2026-09-08
Repo: `Heinrich-Kemler/money-bot`
Scope: everything on `main`, everything on PR #1 (`cursor/scaffold-money-bot-ac52`, head `b51cb9f`), repo settings visible via the API.
Mode: read-only. No files were changed, no commits made, nothing was posted to GitHub.

Line references below point at files on the PR #1 branch, since `main` contains only a README.

---

## 1. Executive summary

- **`main` is empty.** It has one commit and a two-line README. All real work lives in draft PR #1 (4 commits, 31 files, ~2,500 lines excluding the lockfile), authored by a Cursor background agent.
- **The scaffold is coherent and its self-reported verification is true.** `npm ci`, `npm run type-check`, `npm test` (19/19) and `wrangler deploy --dry-run` all pass on a clean Linux checkout with Node 22.
- **It is not deployable as a public plugin in its current form.** The MCP endpoint has no authentication and every caller collapses into the single tenant `"anonymous"`, so the "per-tenant Durable Object" isolation described in SECURITY.md does not exist in practice. The checkout URL handed to the human is never bound to the merchant domain that the human approved. The production approval path returns HTTP 501.
- **Several state-machine rules are implemented loosely.** Cart supersession compares against whichever spend was updated last regardless of merchant, superseded approvals stay usable, the deny-retry guard is bypassed by a query string, `spendCap` is stored but never enforced, and `AUTO_APPROVE_MAX` in `wrangler.toml` is never read.
- **Docs have already drifted from code.** README, SKILL.md and the `/` route advertise 3 tools; the server registers 5 (plus a dev tool). Two files still mention "Revolut OAuth" while every other doc insists no such OAuth exists.
- **Project hygiene is absent.** No CI, no lint/format, no Node version pin, no branch protection, no disclosure contact, no issue/PR templates.

Recommended path: land PR #1 as the baseline scaffold, then work the P0 and P1 items below before any `wrangler deploy` to a public URL. Details and a suggested order are in section 6.

---

## 2. Current state snapshot

| Item | State |
| --- | --- |
| Default branch `main` | 1 commit (`bff7f6e`), README only |
| Open PRs | #1 (draft), base `main`, mergeable, 0 reviews, 0 comments, 0 check runs |
| Open issues | 0 |
| Branches | `main`, `cursor/scaffold-money-bot-ac52` |
| Tags / releases | none |
| Branch protection | none on `main` |
| CI | none (`.github/` does not exist) |
| Deployed instance | none found; plugin config expects `MONEY_BOT_MCP_URL` to be supplied |
| Runtime | Cloudflare Worker + two SQLite Durable Objects (`MoneyBotMCP` via `agents` McpAgent, `SpendStore`) |
| Deps | `@modelcontextprotocol/sdk` 1.30.0 (pinned), `agents` ^0.20.1, `zod` ^4.4.3, `wrangler` ^4.105.0, `typescript` ^5.8.3 |

### Verification performed

```
node v22.22.2 / npm 10.9.7
npm ci                      -> ok
npm run type-check          -> ok (tsc --noEmit, no errors)
npm test                    -> 19 tests, 10 suites, 0 failures
wrangler deploy --dry-run   -> ok, bundle 2954 KiB (gzip 545 KiB), bindings resolve
```

Note: the first dry run failed because `@cloudflare/workerd-linux-64` was not fetched by `npm ci` in this sandbox. The lockfile does contain that entry, so this is an environment quirk, not a repo defect. Worth a CI run to confirm on GitHub-hosted runners.

### What the scaffold implements

- Pure state-machine logic in `src/logic.ts` (no I/O), wrapped by a Durable Object in `src/store.ts` that returns `{ ok, value | error }` so error text survives DO RPC. This is a sound structure.
- Six MCP tools registered in `src/mcp.ts`: `request_spend`, `get_spend_status`, `prepare_checkout_handoff`, `report_checkout_outcome`, `edit_spend_cap`, and `dev_set_spend_decision` (DEV_MODE only).
- HTTP routes in `src/index.ts`: `/mcp`, `/sse`, `POST /host/spend-decision` (501 unless DEV_MODE), `POST /dev/spend-decision` (DEV_MODE), `GET /`.
- Output sanitizer (`src/sanitize.ts`) applied to every tool result and JSON response.
- Docs: README, SECURITY.md (threat model), `docs/open-questions.md`, a Cursor skill, `.cursor-plugin/plugin.json`.

---

## 3. Findings

Severity key: **P0** blocks any public deployment. **P1** logic or security defect to fix before real users. **P2** drift, dead code, config. **P3** hygiene and process.

### P0 — blockers before any public deployment

**P0-1. No authentication; all users share one tenant.**
`src/mcp.ts:34` sets `tenantId: this.props?.userId ?? "anonymous"`. Nothing ever populates `props` (that requires an OAuth provider or a custom fetch wrapper in front of `McpAgent.serve`), and `src/index.ts:9-10` mounts `/mcp` and `/sse` with no auth check. Result: every client on the internet shares Durable Object `tenant:anonymous`, can list nothing but can read, hand off, cap-edit, and mark `PAID`/`FAILED` on any spend whose id they hold, and can fill the DO's storage without limit. SECURITY.md threat #5 ("Durable Object `tenant:<tenantId>`") and the audit-field table are therefore not true today.
Suggested change: require identity. Wire `@cloudflare/workers-oauth-provider` (which `agents` is designed for) or at minimum a per-user bearer token validated in `fetch()` that sets `ctx.props.userId`. Remove the `"anonymous"` fallback and fail closed when no identity is present. Add a rate-limit binding or WAF rule on `/mcp`.

**P0-2. Checkout URL is not bound to the approved merchant.**
`src/schemas.ts:29` accepts any `https://` `checkoutUrl`; `src/logic.ts:310` and `:326` hand `checkoutUrl ?? merchantUrl` straight to the human. The locked cart (`src/types.ts:98-104`) records `merchantDomain` but not the URL the human will actually be sent to. Probe: `merchantUrl=https://a.example`, `checkoutUrl=https://evil.example/pay` is accepted, approved with `lockedCart.merchantDomain = a.example`, and `prepare_checkout_handoff` returns `https://evil.example/pay`. This is the prompt-injection case SECURITY.md threat #2 and #7 are meant to cover.
Suggested change: validate at request time that `checkoutUrl` host equals `merchantDomain` (or a subdomain of it), include `checkoutUrl` in `LockedCart`, and re-validate at handoff. If third-party PSP hosts must be allowed, keep an explicit allowlist.

**P0-3. The production approval path does not exist.**
`src/index.ts:81-100` returns 501 for `/host/spend-decision` unless DEV_MODE. That is documented honestly, but it means the whole product loop is untestable end to end outside DEV_MODE, and `docs/open-questions.md` still lists passkey provider, device binding, and MCP Apps initiation as open. Not a bug, but it is the critical-path item and every security claim depends on its design.
Suggested change: write a short design doc for the bridge (WebAuthn assertion format, what is signed, replay protection, how `tenantId` is bound to the device, what the chat card may and may not do) before writing code. Track it as an issue rather than a `TODO` comment in three files.

**P0-4. `PAID` is agent-asserted.**
`report_checkout_outcome` (`src/tools/report_checkout_outcome.ts`) lets the model move a spend to `PAID`, `FAILED` or `CHALLENGE` with no evidence. There is no reconciliation source in v0 (no PSP webhook, no order confirmation). The status name implies settlement.
Suggested change: either rename to make provenance explicit (`REPORTED_PAID`) and store `outcomeReportedBy`, or keep `PAID` reserved for a future verified source and have the tool set `HUMAN_REPORTED_*`. Document in SKILL.md that the agent must only report what the human confirms.

### P1 — logic and security defects

**P1-1. Cart supersession compares against the wrong spend and never invalidates the old one.**
`src/logic.ts:208-223` picks the single most-recently-updated locked spend (APPROVED / WAITING_FOR_YOU / CHALLENGE) and diffs the new cart against it, ignoring merchant. Probe: an approved spend for Shop A (GBP 10) followed by `request_spend` for Shop B (EUR 99) produces a "cart diff" with all four fields and marks B as superseding A. Meanwhile `src/store.ts:76-94` leaves A in `APPROVED`, so A can still be handed off after being "superseded". The README's mitigation ("mismatch opens a new PENDING with a diff") is therefore only half implemented, and two concurrent legitimate spends are not supported at all.
Suggested change: scope the mismatch check to the same `merchantDomain` (or take an explicit `supersedesSpendRequestId` input), and move the superseded record to a terminal `SUPERSEDED` state (or `EXPIRED`) in the same DO transaction. Add a store-level test for both.

**P1-2. Deny-retry guard is trivially bypassed.**
`src/logic.ts:195` compares raw `merchantUrl` strings. Probe: after a deny on `https://a.example`, `https://a.example?x=1` with the same amount and currency is not blocked. Use the normalized `merchantDomain` (already computed) plus amount and currency, consistent with the cart lock.

**P1-3. Money is stored as floating point.**
`amount`, `unitAmount`, `spendCap` are `number` (e.g. `12.5`). Cart diff uses `!==` (`src/logic.ts:79`), so `0.1 + 0.2` vs `0.3` is a mismatch. Use integer minor units (pence/cents) with the currency's exponent, or a decimal string, and compare accordingly.

**P1-4. `spendCap` is never enforced.**
`spendCap` is written in `createPendingSpendRequest` and `editSpendCap` but nothing compares it to `amount`; `requestSpendInputSchema` accepts `spendCap < amount`. `edit_spend_cap` is therefore a no-op feature exposed to the model. Either enforce (`amount <= spendCap` at request, at approve, and on cart diff) or delete the field and tool until v1 needs it.

**P1-5. `AUTO_APPROVE_MAX` env var is dead.**
`wrangler.toml:18` and `.dev.vars.example` set `AUTO_APPROVE_MAX="0"`; `worker-configuration.d.ts` types it; nothing reads `env.AUTO_APPROVE_MAX`. The only check is `if (AUTO_APPROVE_MAX !== 0)` against a `const 0` in `src/types.ts:184`, which can never fail, and `void AUTO_APPROVE_MAX` in `src/tools/request_spend.ts:28` is a no-op. The wrangler comment "ignored if raised" is accidentally true. Either remove the env var and the comment, or read it and assert it is `0` at startup so a misconfiguration fails loudly.

**P1-6. Input schema does not reconcile the cart.**
`lineItems` totals are never compared with `amount` (probe: 1 × 999 with `amount: 10` accepted). `shipping.country` is `max(2)` but not validated as ISO 3166-1 alpha-2 (`"zz"` accepted). Consider `z.enum` of supported countries (the product is UK/EU only) and a `sum(lineItems) === amount` refinement when line items are supplied.

**P1-7. Sanitizer has damaging false positives.**
`src/sanitize.ts:25` redacts any 13–19 digit run, and the key blocklist (`:1-23`) silently drops whole keys including `exp`, `card`, `pin`, `cid`. Probe output: `orderId: "ORD-1234567890123"` became `"ORD-[REDACTED]"`, a phone number was redacted, and `exp: "2026-09-08"` and `card: "Gift card note"` vanished from the payload. Order ids are audit data the docs promise to keep. Suggested change: Luhn-check digit runs before redacting, narrow the key list to unambiguous names (`pan`, `cardNumber`, `cvv`, `cvc`, `expiryMonth`, ...), and emit a log line when a redaction fires so leaks are noticed rather than hidden.

**P1-8. Unbounded storage growth and O(n) reads.**
`SpendStore.createFromInput` calls `listAll()` (`src/store.ts:203-213`), which reads every record ever created, on every `request_spend`. The index is never pruned. Combined with P0-1 this is a free storage-fill and latency-degradation vector. The DO is already declared as `new_sqlite_classes`; use `ctx.storage.sql` with a proper table and indexes, and prune terminal records after a retention window.

**P1-9. `decidedBy === "agent"` is a string check, not a control.**
`src/logic.ts:245` rejects the literal `"agent"`; `src/index.ts:43` copies `decidedBy` from the untrusted request body and `src/tools/dev_set_spend_decision.ts:37` defaults to `"dev"`. Any other string passes. That is fine for DEV_MODE, but SECURITY.md threat #1 lists it as a mitigation. Reword the docs: the real control is that no production decide path is exposed to the model, and the bridge (P0-3) must set `decidedBy` server-side from the authenticated device, never from the body.

**P1-10. Body-supplied `tenantId` on the decision endpoints.**
`src/index.ts:33` takes `tenantId` from the JSON body. In DEV_MODE this lets any caller decide any tenant's spend. Acceptable locally, but the same `applyHostDecision` function is what the production bridge will call, so it should take `tenantId` from the authenticated context only. Also `/host/spend-decision` and `/dev/spend-decision` are identical in DEV_MODE; collapse to one.

**P1-11. Tenant-connection resume path is unreachable.**
`resumeAfterReauth` (`src/logic.ts:469`) is exported and tested but no tool or route calls it, and nothing can ever set `CONNECTED`. Fine for v0 by design, but mark it clearly as v1-only or move it under a `v1/` namespace so reviewers do not assume it is wired.

### P2 — drift, dead code, configuration

**P2-1. Tool list drift.** README ("MCP tools (v0)" table and "Layout" comment), `skills/money-bot/SKILL.md`, and the `GET /` response (`src/index.ts:117-121`) list three tools. The server registers `report_checkout_outcome` and `edit_spend_cap` as well. Neither is mentioned in any doc, so the skill never tells the agent to call `report_checkout_outcome`, which is the only way to reach `PAID`/`CHALLENGE`/`FAILED`. Generate the tool list from code or add a test that asserts docs and registrations match.

**P2-2. Duplicate plugin layout.** `plugin/.cursor-plugin/plugin.json`, `plugin/mcp.json`, `plugin/skills/money-bot/SKILL.md` are byte-identical copies of the root versions. They will drift. Keep one (root-level `.cursor-plugin/` is the conventional location) and delete the other.

**P2-3. "Revolut OAuth" contradiction.** `.dev.vars.example:7-9` (`REVOLUT_CLIENT_SECRET`, "per-user Revolut Business OAuth") and `wrangler.toml:14` ("Secrets (Revolut OAuth, etc.)") contradict README, SECURITY.md, SKILL.md and open-questions, which all state there is no public OAuth and v1 uses cert + client_id + JWT. Fix the two comments.

**P2-4. Marketplace copy mismatch.** The GitHub repo description says "safu agent payments" and "v1 Revolut Business ephemeral cards"; README says "virtual cards" and avoids slang. Align before marketplace submission (manual review is noted in the docs).

**P2-5. `worker-configuration.d.ts` will be clobbered.** It is hand-written (typed `DurableObjectNamespace<SpendStore>`), but the `cf-typegen` script runs `wrangler types`, which overwrites it and would drop that generic. Either remove the script, or let wrangler generate it and put the typed helper in `src/`.

**P2-6. Tests are not type-checked.** `tsconfig.json` excludes `src/logic.test.ts` (and `types` is only workers-types, so `node:test` would not resolve). Add a `tsconfig.test.json` with `@types/node` and include it in `type-check`. Also drop `jsx: react-jsx` and `allowJs`; nothing uses them.

**P2-7. Unused exports.** `SpendStatusResult`, `cartFromRequest`, `PERSISTED_SPEND_STATUSES`, `TERMINAL_FROM_PENDING`, `SCA_THRESHOLD_GBP/EUR`, `REVOLUT_ACCESS_TOKEN_TTL_MS` are exported and referenced nowhere outside their definition (and in some cases the test). Remove or use them (e.g. use `COMPLETION_FROM_HANDOFF` to derive the zod enum in `reportCheckoutOutcomeInputSchema` instead of repeating the literals).

**P2-8. Two DO round-trips in `get_spend_status`.** `src/tools/get_spend_status.ts:25-30` calls `getForTenant` (which already loads and refreshes the tenant connection) and then `getTenantConnection` again. Return the connection from `getForTenant`.

**P2-9. Legal placeholders.** `LICENSE` copyright holder and `plugin.json` author are both the string "Money Bot" with no entity or contact. `SECURITY.md` is a threat model but has no vulnerability-reporting channel, which is what GitHub surfaces under "Security policy". Add a contact and a disclosure window; consider moving the threat model to `docs/threat-model.md`.

**P2-10. MCP surface polish.** No `outputSchema`/`structuredContent`, no tool annotations (`readOnlyHint` for `get_spend_status`, `destructiveHint: false`, `openWorldHint: false`). The README promises an MCP Apps iframe card plus mandatory plain-text fallback; only the plain-text side exists, and there is no resource or UI stub. Either add a tracked issue or soften the README.

**P2-11. `CHALLENGE → CHALLENGE` drops new info.** `src/logic.ts:386-388` returns the unchanged record when a second `CHALLENGE` is reported, so a corrected `challengeKind` or `orderId` is ignored silently.

### P3 — hygiene and process

**P3-1. No CI.** Add a workflow running `npm ci`, `npm run type-check`, `npm test`, and `wrangler deploy --dry-run` on PRs and `main`. PR #1 currently has zero checks.

**P3-2. No lint or format.** Add Biome (single tool, fast) or ESLint + Prettier, with a `lint` script wired into CI.

**P3-3. No Node version pin.** `npm test` relies on `--experimental-strip-types`, which needs Node 22.6+ (and the flag is unnecessary from 23.6). Add `"engines": { "node": ">=22.6" }` and an `.nvmrc` / `.node-version`.

**P3-4. No dependency automation.** Add Dependabot or Renovate for npm and GitHub Actions. `@cloudflare/workers-types` and `wrangler` move weekly.

**P3-5. Repository controls.** Enable branch protection on `main` (require CI, require PR), add `CODEOWNERS`, issue and PR templates, and a `CONTRIBUTING.md` that states the "never" rules from SECURITY.md so external contributors see them.

**P3-6. Test coverage gaps.** Tests cover only `logic.ts` and one sanitizer case. Untested: `SpendStore` (where P1-1 lives), every route in `index.ts`, tool registration and DEV_MODE gating, sanitizer false positives, expiry inside the store, tenant isolation. Use `@cloudflare/vitest-pool-workers` to test the DO and routes in workerd, and add the probe cases from this audit as regression tests.

**P3-7. Audit trail.** SECURITY.md promises an audit of who approved, when, merchant, amount, locked cart and order id. Today that is only the mutable spend record. Add an append-only per-tenant audit table (SQLite DO) and consider Workers Analytics Engine or Logpush for off-box retention.

**P3-8. Observability of redaction and errors.** Non-`SpendError` exceptions are swallowed into generic strings (e.g. `src/tools/request_spend.ts:38-41`) with no `console.error`, so a real bug in the DO would be invisible in Cloudflare logs even though `observability.enabled = true`.

---

## 4. Things that are in good shape

- Clear separation of pure state-machine logic from I/O; the `StoreResult` wrapper for DO RPC errors is a thoughtful touch and the commit history shows it was added deliberately.
- The security posture is stated consistently across README, SECURITY.md, SKILL.md and open-questions: human out-of-band approval, no PAN in the model, no pooled funds, no fake OAuth, PCI scope honesty. That is unusually clear for a scaffold.
- `AUTO_APPROVE_MAX = 0`, terminal deny/expire, and the cart-lock concept are the right primitives.
- Sanitizer sits at the output boundary for both tool results and HTTP responses.
- No secrets in the repo; `.gitignore` covers `.dev.vars` and `.env*`; SQLite-backed DOs and observability are enabled from day one.
- The 19 existing tests are meaningful invariants, not smoke tests.

---

## 5. Open product questions the code cannot answer

These are already partly captured in `docs/open-questions.md`; listing them here because several findings above depend on the answer.

1. Identity model: what is a "tenant"? A Cursor user, a workspace, a Revolut Business entity? P0-1 needs this decided.
2. Who is the approver device bound to, and how is that binding established the first time?
3. Is a 24-hour hard block after a deny the desired UX, or should a human be able to re-open a denied spend explicitly?
4. Is multi-spend concurrency in scope for v0? P1-1 assumes yes; if no, reject a new `request_spend` while any spend is locked.
5. What is the source of truth for `PAID`? If none in v0, say so in the status name.

---

## 6. Suggested order of work

1. **Land PR #1** as the baseline (it is a draft; it builds and tests green). Convert each P0/P1 finding into a GitHub issue so the follow-ups are tracked instead of living in `TODO` comments.
2. **CI + hygiene first** (P3-1, P3-2, P3-3, P3-5). Cheap, and everything after benefits.
3. **Fix the pure-logic defects** (P1-1, P1-2, P1-3, P1-4, P1-5, P1-6, P1-7, P2-11) with regression tests; these are self-contained changes in `logic.ts`, `schemas.ts`, `sanitize.ts`.
4. **Bind the checkout URL** (P0-2) and add store-level tests with vitest-pool-workers (P3-6).
5. **Identity and auth** (P0-1, P1-8, P1-10): pick the tenant model, add the OAuth or token layer, remove the anonymous fallback, add rate limiting.
6. **Design the approval bridge** (P0-3) as a document, then implement; decide the `PAID` provenance question (P0-4) at the same time.
7. **Docs pass** (P2-1 through P2-4, P2-9) once the tool surface is stable, before any marketplace submission.

Nothing above requires touching the v1 Revolut path; that should remain documentation-only as the repo already states.
