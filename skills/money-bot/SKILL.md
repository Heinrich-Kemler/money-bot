---
name: money-bot
description: >
  Use Money Bot when an agent needs to pay for a UK/EU online checkout.
  Human must approve every spend. v0 hands the checkout screen to the human
  for Apple Pay / Revolut Pay / 3DS. Never handle card numbers.
---

# Money Bot

Primary product name is **Money Bot** (package/id: `money-bot`).

## When to use

- The user (or the task) needs to complete a UK or EU **online checkout**.
- Stripe Link is unavailable or region-locked.
- The agent has filled (or is filling) a cart and needs a **human-approved** payment path.

Do **not** use Money Bot for:

- Storing, minting, or typing card numbers (PAN / CVC / expiry).
- Revolut **Merchant** API charges (wrong direction — that collects money as a merchant).
- Personal Revolut card issuance (no card-issue API).
- Retrying a spend the human already **Denied**.

## v0 flow

1. Fill the merchant cart as usual.
2. Call `request_spend` with merchant name, https URL, amount, currency (default GBP), and optional checkout URL / line items.
3. Stop and wait. `autoApproveMax` is **£0**. The host must show **Approve** / **Deny** in chat (Stripe Link parity).
4. Poll `get_spend_status` with `spendRequestId`.
   - `pending_approval` — keep waiting; do not invent approval.
   - `denied` — **stop**. Deny is final for that request. Do not open a new request for the same merchant + amount to bypass the human.
   - `approved` — call `prepare_checkout_handoff`.
   - `expired` / `failed` — report the status; do not retry-spam.
5. `prepare_checkout_handoff` returns a checkout URL and handoff instructions. Open the URL and **hand the screen to the human**.
6. The human completes Apple Pay, Revolut Pay, or 3-D Secure on that screen.

## Deny is final

A `denied` spend request cannot be approved later. Do not call `request_spend` again for the same merchant, amount, and currency after a deny. Tell the user the spend was denied and wait for a new, explicit instruction.

## Never put credentials in chat

Never read, write, remember, or paste:

- Card PAN, CVC/CVV, expiry, PIN
- Virtual-card secrets (v1 is **not implemented**)
- Vault / OAuth client secrets

If a tool result ever looks like it contains a card number, treat it as a bug, discard it, and do not repeat it in chat, memory, or transcripts.

## v1 (do not implement or call)

Future: Revolut **Business Cards** API mints a single-use virtual card with a hard spend cap, reveals PAN only into browser fields, then freezes the card. Personal Revolut has no card-issue API. Do not attempt card minting in v0.
