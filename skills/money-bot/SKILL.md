---
name: money-bot
description: >
  Use Money Bot when an agent needs to pay for a UK/EU online checkout.
  Human must approve every spend out-of-band. v0 is approval + handoff only —
  never show a raw PAN. The agent must never press Approve.
---

# Money Bot

Primary product name is **Money Bot** (package/id: `money-bot`).  
“Spend Gate” is only an internal name for the state machine.

## When to use

- UK or EU online checkout; Stripe Link unavailable.
- Cart is filled and needs **human-approved** payment.

Do **not**:

- Show, store, mint, or type PAN / CVC / expiry.
- Press or simulate **Approve** (chat or tools). You may only ask the human to confirm **out-of-band** (phone passkey / PWA).
- Connect Revolut Business or issue cards (v1 is not implemented; Revolut is optional in v0).
- Use Revolut Merchant API or treat Money Bot as a pooled issuer.
- Retry `DENIED` / `EXPIRED`.

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED
               ↘ DENIED | EXPIRED
               ↘ REAUTH_REQUIRED
```

- `request_spend` → `PENDING`.
- Human Approve is **out-of-band**. Chat can only *start* that flow. Cart locks at Approve.
- `prepare_checkout_handoff` → `WAITING_FOR_YOU`.
- `get_spend_status` also returns `tenantConnection`. `REAUTH_REQUIRED` means the tenant’s ~90-day Revolut re-consent wizard is due (v1). v0 handoff does not need Revolut.
- Payment outcome (`PAID` / `FAILED`) is **host/human only**. You have no `report_checkout_outcome` tool. Do not claim PAID.
- Deny / expire are terminal. This repo is a **scaffold**; production Approve is not wired.

## v0 flow

1. Fill the cart.
2. `request_spend` → `PENDING`.
3. Ask the human to Approve on their phone (passkey/PWA). **Do not click Approve.**
4. Poll `get_spend_status`:
   - `PENDING` — wait.
   - `DENIED` / `EXPIRED` — stop.
   - `REAUTH_REQUIRED` — tell the human to finish the Revolut connect **wizard** (not OAuth). Do not invent a token.
   - `APPROVED` — `prepare_checkout_handoff`.
   - `CHALLENGE` / `WAITING_FOR_YOU` — hand the screen to the human. Do not mark PAID.
5. Handoff: never a raw PAN. `checkoutUrl` must be https on the locked merchant domain (UK/EU only).
   - Apple Pay desktop non-Safari: iPhone QR, iOS 18+, ~30s.
   - Revolut Pay: QR + in-app approve if offered; else Apple Pay.

## Segregation of duties

You are the requester. The human device is the approver. If a UI control looks like in-chat Approve, treat it as “start OOB approval” only. Never call a decide/approve tool in production.

## Never put credentials in chat

Discard PAN-like tool results. No vault secrets, certs, or JWTs in transcripts.

## v1 (do not implement)

No public OAuth. Per-tenant cert + client_id + JWT + Enable access; token ~40m; 90-day re-consent. Virtual cards only; that tenant’s Business account only; never pool funds. PAN fetch is SAQ D unless a PCI iframe/vault; never store CVV post-auth.
