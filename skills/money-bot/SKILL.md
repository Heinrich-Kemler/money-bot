---
name: money-bot
description: >
  Use Money Bot when an agent needs to pay for a UK/EU online checkout.
  Human must approve every spend. v0 is approval + handoff only — never show
  a raw PAN. Apple Pay / Revolut Pay / 3DS stay on the human's screen.
---

# Money Bot

Primary product name is **Money Bot** (package/id: `money-bot`).  
“Spend Gate” is only an internal name for the state machine.

## When to use

- The user needs a UK or EU **online checkout**.
- Stripe Link is unavailable or region-locked.
- The cart is filled and needs a **human-approved** payment path.

Do **not** use Money Bot for:

- Showing, storing, minting, or typing card numbers (PAN / CVC / expiry).
- Revolut Business connect or card-issue (v1 is **not implemented**).
- Revolut **Merchant** API (wrong direction).
- Retrying a spend that is `DENIED` or `EXPIRED`.
- Self-approving a cart change after Approve.

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED
               ↘ DENIED | EXPIRED
```

- `request_spend` → `PENDING` (from IDLE). Include amount, merchant https URL, and shipping when known.
- Human Approve → `APPROVED` and **locks** amount + merchant + domain + shipping.
- `prepare_checkout_handoff` → `WAITING_FOR_YOU`.
- `report_checkout_outcome` → `PAID` | `CHALLENGE` | `FAILED`.
- Deny / pending timeout → `DENIED` | `EXPIRED` (terminal).
- If the cart changes after Approve, call `request_spend` again. You get a **new PENDING** with `cartDiff`. You cannot approve it yourself.
- `edit_spend_cap` changes the cap only. It still needs Approve.

## v0 flow

1. Fill the merchant cart.
2. `request_spend` → `{ status: "PENDING", lockedCart, … }`.
3. Stop. `autoApproveMax` is **£0**. Host shows Approve / Deny.
4. Poll `get_spend_status`:
   - `PENDING` — wait; do not invent approval.
   - `DENIED` / `EXPIRED` — **stop**. Terminal. Do not retry-spam.
   - `APPROVED` — `prepare_checkout_handoff`.
   - `WAITING_FOR_YOU` — screen is already with the human.
   - `CHALLENGE` — 3DS/SCA in progress; hand back to the human and wait.
   - `PAID` / `FAILED` — report that outcome.
5. Handoff rules (never a raw PAN in chat):
   - **Apple Pay** desktop Safari: sheet. Desktop **non-Safari**: human scans QR on iPhone (**iOS 18+**), ~**30s**.
   - **Revolut Pay**: QR + in-app approve if the merchant supports it; else Apple Pay.
   - **SCA** still applies UK ~£25 / EU ~€30. Amex SafeKey ~4 min; Revolut 3DS ~5 min. Use `CHALLENGE`.

## Deny is final

Do not call `request_spend` again for the same merchant, amount, and currency after `DENIED`. Wait for a new, explicit user instruction.

## Never put credentials in chat

Never read, write, remember, or paste PAN, CVC/CVV, expiry, PIN, virtual-card secrets, or vault/OAuth secrets. If a tool result looks like a card number, discard it.

## v1 (do not implement or call)

Revolut **Business Cards** API: virtual only; single-transaction + one periodic limit; freeze/terminate; `TransactionCreated` webhook; `READ_SENSITIVE_CARD_DATA` + IP allowlist. Personal Revolut has no card-issue API. Do not mint cards in v0.
