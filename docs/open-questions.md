# Open questions

Tracked decisions for Money Bot (`money-bot`). “Spend Gate” is internal only.

v0 is a **scaffold**: approval-request + locked checkout URL handoff. **Do not implement** Revolut Business connect, card minting, or PAN handling.

## Revolut Business connect (v1 — no public OAuth)

Verified:

- There is **no public OAuth** for Revolut Business.
- Connect would be a **wizard**, not one-tap: per-tenant **certificate** + **`client_id`** + **JWT** + **Enable access**.
- Access token ~**40 minutes**. Refresh / Enable access needs **~90-day re-consent** → `REAUTH_REQUIRED`.
- Revolut is **not connected in v0**. The `REAUTH_REQUIRED` state exists so v1 does not retrofit the machine.

Open:

- Exact wizard UX inside Cursor (MCP Apps iframe vs external PWA).
- Where the cert and JWT live (per-tenant vault only — never git).
- Partner / app-review path (UK vs EU entity).
- **Currency (v1 follow-up, not this PR):** do not hard-lock Revolut Business spend to v0’s 2–3 currencies forever. Design toward **EU currencies that tenant’s Revolut can hold/spend** (at least PLN + major EU), not “GBP/EUR only forever.” v0 stays `GBP | EUR | PLN` + UK/EU suffix heuristic.

## No card-issuing-as-a-service

If v1 is ever built, each tenant uses **their** Revolut Business. Money Bot never pools funds or issues cards as a platform. Personal Revolut has no card-issue API. Do not use Revolut Merchant API.

## Card-data posture (not a certification)

- **v0:** does not fetch or store PAN. Design goal only — **not** a QSA “out of CDE” claim.
- **v1 PAN fetch (if ever):** would need a PCI program (often discussed as SAQ D unless a vault/iframe). Not assessed.
- **Never store CVV.**
- No vault (Basis Theory / VGS / Skyflow) is integrated.

Open: whether a vault/iframe is a prerequisite before any Worker-side PAN is even considered.

## Out-of-band Approve (SoD)

There is **no decide MCP tool**. That is not the same as “`approveUrl` is human-proof.”

**First testable Approve (landed):** local HMAC-signed `GET /approve` page posts a server-minted JWT/HMAC to `POST /host/spend-decision`. Required claims: `iss`, `aud`, `exp`, `iat`, `jti`, `spendRequestId`, `tenantId`, `decision`, **`lockedCartFingerprint`**. `tenantId` comes from the assertion — **never** from a JSON body field. Never accept `decidedBy` alone. No `DEV_MODE` Approve switch. `approveUrl` is a bearer capability for local smoke / non-Grokbot only.

**Grokbot widget (implemented):** `widget` on spend tools + `POST /host/widget-decision` (`Bearer host:<HOST_API_TOKEN>`). Keep looking → `CANCELLED` without deny cooldown. SoD depends on Life Admin using that path, not the model fetching `approveUrl`. See [docs/design/grokbot-widget-approve.md](design/grokbot-widget-approve.md).

**Long-term Cursor marketplace:** passkey / WebAuthn (or equivalent device binding) for bearer-URL N-1. Not implemented in this repo yet.

Open:

- Life Admin agent-code wiring (host API + smoke guide are ready; they are a separate bot).
- Passkey / WebAuthn provider and device binding to `tenantId`.
- How MCP Apps starts the OOB flow without giving the model a decide tool.
- Production host identity (`props.userId`) — see issue #4. Local tests use `ALLOW_TEST_AUTH` only when `ENVIRONMENT=development` on loopback.

## MCP Apps + marketplace

- Cursor **2.6+**: sandboxed **iframe card** (MCP Apps) is allowed for connect/approve **initiation**.
- **Mandatory plain-text fallback** (tool JSON + skill) for hosts without MCP Apps.
- Cursor marketplace = **manual review**.

Open: listing questionnaire for a payments-adjacent plugin that never holds funds.

## Region / currency (v0)

v0 currencies are **GBP, EUR, PLN**. The merchant host must still match the UK/EU public-suffix allowlist in `src/region.ts` (already includes `.pl`). That unblocks Allegro (`allegro.pl` + PLN) on the Grokbot widget Approve path without opening arbitrary global FX.

PLN on a clearly non-UK/EU domain (e.g. `.com`) is still rejected. USD / CZK / other currencies stay rejected even on EU suffixes. PLN is allowed on any already-allowlisted UK/EU suffix, not only `.pl`. **Do not add every EU currency in v0.**

Open:

- Whether a later v0 pass should pair currency to suffix (PLN-only-on-`.pl`) instead of allowing PLN on any UK/EU host.
- **v1 Revolut Business (follow-up):** the Worker must not treat `GBP | EUR | PLN` as a forever product cap. When a tenant connects their Revolut Business, spend currency should follow **what that account can hold/spend** (PLN + major EU at minimum). Do not implement that here — no Revolut connect, no extra ISO codes in this PR.

## Legal posture

Money Bot is software. It does not hold funds and is not an issuer or payment institution.

- Obtain local regulatory advice (UK / EU / PL as applicable) before v1 or any production use.
- Mentions of FCA / KNF are reminders to seek advice, not authorisation claims.

Open: whether any EU entity or EMI partnership is required even for “bring your own Business account” v1.

## Checkout UX (v0)

- Money Bot returns a **locked https checkoutUrl** (host = merchant domain). That is the money path.
- Wallet / SCA UI, if any, belongs to the **merchant page**. Money Bot does not implement those brand flows.
- Never show a raw PAN in chat.

## Mandate patterns

AP2 Cart Mandate, MCP Agent Pay scoped tokens — principles only; not implemented.

## Branding

- **Primary name:** Money Bot (`money-bot`)
- “Spend Gate” is not marketplace copy.
