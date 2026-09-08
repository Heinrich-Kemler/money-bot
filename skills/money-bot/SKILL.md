---
name: money-bot
description: >
  Use Money Bot when an agent needs a human to approve a UK/EU online checkout.
  v0 is a scaffold: approval request + locked checkout URL handoff only.
  Never show a raw PAN. The agent must never press Approve.
---

# Money Bot

Primary product name is **Money Bot** (package/id: `money-bot`).  
“Spend Gate” is only an internal name for the state machine.  
**SCAFFOLD ONLY — not production.** Approve is not wired.

## Production tools (complete list)

| Tool | Use |
| --- | --- |
| `request_spend` | Create `PENDING`. Requires UK/EU merchant + https `checkoutUrl` on that domain. |
| `get_spend_status` | Read status + locked cart + `tenantConnection`. |
| `prepare_checkout_handoff` | After `APPROVED`, return the locked `checkoutUrl` (**the money path**). |

You do **not** have `edit_spend_cap`, `report_checkout_outcome`, `dev_set_spend_decision`, or any decide/approve tool. Do not invent them.

## When to use

- UK or EU online checkout (GBP/EUR + UK/EU-looking domain).
- Cart is filled and needs **human-approved** payment.

Do **not**:

- Show, store, mint, or type PAN / CVC / expiry.
- Press or simulate **Approve** (chat or tools). You may only ask the human to confirm **out-of-band**.
- Connect Revolut Business or issue cards (not implemented).
- Treat Money Bot as a pooled issuer.
- Retry `DENIED` / `EXPIRED`.
- Open any URL other than the locked `checkoutUrl`.

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED
               ↘ DENIED | EXPIRED
               ↘ REAUTH_REQUIRED
```

- `request_spend` → `PENDING`. Locks proposed cart + checkout URL host to merchant domain.
- Human Approve is **out-of-band** and **not implemented** in this scaffold. Chat can only *ask* the human to confirm later.
- `prepare_checkout_handoff` → `WAITING_FOR_YOU`. Returns `moneyPath: true` and the locked URL only.
- `get_spend_status` also returns `tenantConnection`.
- Payment outcome (`PAID` / `FAILED`) is **host/human only**. Do not claim PAID.

## v0 flow

1. Fill the cart, including the merchant **checkout** URL (this is where the human will pay).
2. `request_spend` → `PENDING`.
3. Ask the human to Approve out-of-band. **Do not click Approve.** There is no Approve tool.
4. Poll `get_spend_status`:
   - `PENDING` — wait (Approve is not wired in this scaffold).
   - `DENIED` / `EXPIRED` — stop.
   - `REAUTH_REQUIRED` — tenant re-consent (v1, not built).
   - `APPROVED` — `prepare_checkout_handoff`.
   - `CHALLENGE` / `WAITING_FOR_YOU` — hand the screen to the human. Do not mark PAID.
5. Open **only** `checkoutUrl`. Host must match the locked merchant domain. Never a raw PAN.

Money Bot does not implement wallet or SCA brand flows. If the merchant page shows them, the human completes them there.

## Segregation of duties

You are the requester. The human is the approver. Never call a decide/approve tool.

## Never put credentials in chat

Discard PAN-like tool results. No vault secrets, certs, or JWTs in transcripts.

## v1 (do not implement)

No public OAuth. Per-tenant wizard if ever built. Virtual cards only; that tenant’s account only; never pool funds. Any PAN fetch would need a PCI program — not assessed here.
