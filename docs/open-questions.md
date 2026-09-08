# Open questions

Tracked decisions for Money Bot (`money-bot`). “Spend Gate” is internal only.

v0 is approval + handoff. Revolut is **optional**. **Do not implement** Revolut Business connect, card minting, or PCI PAN handling.

## Revolut Business connect (v1 — no public OAuth)

Verified:

- There is **no public OAuth** for Revolut Business.
- Connect is a **wizard**, not one-tap: per-tenant **certificate** + **`client_id`** + **JWT** + **Enable access**.
- Access token ~**40 minutes**. Refresh / Enable access needs **~90-day re-consent** → tenant and (v1-bound) spend status `REAUTH_REQUIRED`.
- Revolut is **optional in v0**. The `REAUTH_REQUIRED` state exists from day one so v1 does not retrofit the machine.

Open:

- Exact wizard UX inside Cursor (MCP Apps iframe vs external PWA).
- Where the cert and JWT live (per-tenant vault only — never git).
- Partner / app-review path (UK vs EU entity).

## No card-issuing-as-a-service

Each tenant uses **their** Revolut Business. Money Bot never pools funds or issues cards as a platform. Personal Revolut has no card-issue API. Do not use Revolut Merchant API.

## PCI honesty

- **v0:** never touches PAN → **out of CDE**.
- **v1 PAN fetch:** **SAQ D** unless a PCI vault/iframe (**Basis Theory / VGS / Skyflow**).
- **Never store CVV post-auth.**
- `READ_SENSITIVE_CARD_DATA` + IP allowlist still required for any sensitive retrieve.

Open: which vault/iframe, if any, before attempting Worker-side PAN.

## Out-of-band Approve (Ramp SoD)

Chat may only **initiate** Approve. Completion is **phone passkey / PWA**. The **agent must never press Approve**.

**TODO(host-approval-bridge):** **SCAFFOLD / HTTP 501.** Production must POST a signed OOB JWT/HMAC. Required claims: `iss`, `aud`, `exp`, `iat`, `jti`, `spendRequestId`, `tenantId`, `decision`, **`lockedCartFingerprint`**. Not an agent-clickable chat Approve. Never accept `decidedBy` alone.

Open:

- Passkey / WebAuthn provider and device binding to `tenantId`.
- How MCP Apps (below) starts the OOB flow without giving the model a decide tool in production.

## MCP Apps + marketplace

- Cursor **2.6+**: sandboxed **iframe card** (MCP Apps) is allowed for connect/approve **initiation**.
- **Mandatory plain-text fallback** (tool JSON + skill) for hosts without MCP Apps.
- Cursor marketplace = **manual review**.

Open: listing questionnaire for a payments-adjacent plugin that never holds funds.

## Legal posture

Money Bot is a **technical agent**. It never holds funds, is not an issuer, and is not a payment institution.

- Obtain **FCA** (UK) and **KNF** (PL) advice before v1.
- Disclaimer belongs in README / marketplace copy (already drafted).

Open: whether any EU entity or EMI partnership is required even for “bring your own Business account” v1.

## Checkout UX (v0)

- Apple Pay desktop non-Safari: iPhone QR, iOS 18+, ~30s.
- Revolut Pay: QR + in-app approve, else Apple Pay.
- Never show a raw PAN in chat.
- SCA UK ~£25 / EU ~€30; Amex SafeKey ~4 min; Revolut 3DS ~5 min → `CHALLENGE`.

## Mandate patterns

AP2 Cart Mandate, MCP Agent Pay scoped tokens, Stripe SPT — principles only.

## Branding

- **Primary name:** Money Bot (`money-bot`)
- “Spend Gate” is not marketplace copy.
