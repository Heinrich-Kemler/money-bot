---
name: money-bot
description: >
  Use Money Bot when an agent needs a human to approve a UK/EU online checkout.
  v0 is approval request + locked checkout URL handoff only.
  Never show a raw PAN. There is no decide MCP tool.
---

# Money Bot

Primary product name is **Money Bot** (package/id: `money-bot`).  
“Spend Gate” is only an internal name for the state machine.  
**Not production.** Local Approve is an HMAC-signed browser page (`approveUrl` is a bearer capability, not human proof). Grokbot/Life Admin should use a human-only host widget.

## Production tools (complete list)

| Tool | Use |
| --- | --- |
| `request_spend` | Create `PENDING`. Requires UK/EU merchant + https `checkoutUrl` on that domain. Returns `widget` (Approve / Reject / Keep looking) and `approveUrl` (local smoke only). |
| `get_spend_status` | Read status + locked cart + `tenantConnection`. Includes `widget` + `approveUrl` while `PENDING`. |
| `prepare_checkout_handoff` | After `APPROVED`, return the locked `checkoutUrl` (**the money path**). |

You do **not** have `edit_spend_cap`, `report_checkout_outcome`, `dev_set_spend_decision`, or any decide/approve tool. Do not invent them. **No decide MCP tool ≠ approveUrl is human-proof** — do not fetch or POST `approveUrl` yourself.

## When to use

- UK or EU online checkout (GBP/EUR/PLN + UK/EU-looking domain, including `.pl` / Allegro).
- Cart is filled and needs **human-approved** payment.

Do **not**:

- Show, store, mint, or type PAN / CVC / expiry.
- Call a decide/approve tool (none exists). Do not fetch/post `approveUrl`; show it to the human or wait for the host widget.
- Connect Revolut Business or issue cards (not implemented).
- Treat Money Bot as a pooled issuer.
- Retry a human **`DENIED`** spend (24h cooldown). An **`EXPIRED`** timeout may be re-requested.
- Open any URL other than the locked `checkoutUrl` (after Approve).

## State machine

```
IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED
               ↘ DENIED | EXPIRED | CANCELLED
               ↘ REAUTH_REQUIRED
```

- `request_spend` → `PENDING`. Locks proposed cart + checkout URL host to merchant domain. Returns `widget` (Life Admin) and `approveUrl` (local smoke only).
- Human Approve is **out-of-band** (host widget or local browser page). You have no decide tool. Do not fetch `approveUrl`.
- `prepare_checkout_handoff` → `WAITING_FOR_YOU`. Returns `moneyPath: true` and the locked URL only.
- `get_spend_status` also returns `tenantConnection`.
- Payment outcome (`PAID` / `FAILED`) is **host/human only**. Do not claim PAID.

## v0 flow

1. Fill the cart, including the merchant **checkout** URL (this is where the human will pay). Finding products is allowed.
2. `request_spend` → `PENDING` + `widget` + `approveUrl` (local smoke only).
3. Ask the human to Approve via the Life Admin card (`widget` options). Do not complete Approve yourself. Do not fetch `approveUrl`.
4. Poll `get_spend_status`:
   - `PENDING` — wait for the human.
   - `DENIED` — stop (cooldown).
   - `CANCELLED` — Keep looking; you may `request_spend` again (no deny cooldown).
   - `EXPIRED` — you may `request_spend` again for the same cart.
   - `REAUTH_REQUIRED` — tenant re-consent (v1, not built).
   - `APPROVED` — `prepare_checkout_handoff`.
   - `CHALLENGE` / `WAITING_FOR_YOU` — hand the screen to the human. Do not mark PAID.
5. Open **only** `checkoutUrl`. Host must match the locked merchant domain. Never a raw PAN.

Money Bot does not implement wallet or SCA brand flows. If the merchant page shows them, the human completes them there.

## Segregation of duties

You are the requester. The human is the approver. Never call a decide/approve tool. Do not treat `approveUrl` as something you may exercise.

## Never put credentials in chat

Discard PAN-like tool results. No vault secrets, certs, or JWTs in transcripts.

## v1 (do not implement)

No public OAuth. Per-tenant wizard if ever built. Virtual cards only; that tenant’s account only; never pool funds. Any PAN fetch would need a PCI program — not assessed here.
