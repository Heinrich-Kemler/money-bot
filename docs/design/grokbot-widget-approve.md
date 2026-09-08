# Grokbot / Life Admin — human-only Approve widget

Status: **design note only**. This document does **not** implement the widget, passkey/WebAuthn, or a Life Admin integration.

Date: 2026-09-08  
Related: Fable second audit N-1 (bearer `approveUrl`); Life Admin re-audit priority below.

## Life Admin re-audit priority

| ID | Priority | This PR |
| --- | --- | --- |
| N-1 | Block before Grokbot/public ship (design) | Design note only: **human widget** on Grokbot; `approveUrl` = local smoke; passkey = public Cursor later. **No passkey impl.** |
| N-2 | Must-fix | Same-`merchantDomain` (or explicit `supersedes`) only. |
| N-3 | Must-fix | `ALLOW_TEST_AUTH` impossible/inert on production `wrangler.toml`. |
| N-4 | **P2** (real, overrated) | Minimal: 401 before `McpAgent.serve` so unauth `initialize` / `tools/list` do not allocate DOs. |
| N-5 | Must-fix (with N-2) | Drop `EXPIRED` from the 24h human-deny window. |
| N-6–N-11 | P2 | Out of scope. |

Fable audit PR #9 is the docs archive. Do not merge it into this work.

## Product

Money Bot’s first real use is **Grokbot / Life Admin shopping**, not only the Cursor marketplace.

The agent **may** find products. “The agent must never help find products” is **not** the security control. The control is **segregation of duties on the decision**: only the human’s UI selection may drive Approve / Reject.

## SoD (same as Grokbot question widgets)

Grokbot already has human-only question widgets: the model can ask; only the user can tap.

Approve should be the same kind of control:

| Actor | Allowed | Not allowed |
| --- | --- | --- |
| Agent / model | Find a product, call `request_spend`, poll `get_spend_status`, later `prepare_checkout_handoff` | A decide MCP tool; fetching or POSTing `approveUrl`; synthesizing a host assertion |
| Life Admin / Grokbot host | Render an Approve / Reject (maybe “keep looking”) card bound to `spendRequestId` + locked cart | Treat tool JSON or an agent “I clicked Approve” string as a decision |
| Human | Tap Approve / Reject / keep looking | Being implied by URL possession |

The host — not the model — submits the decision with a **verified assertion** (signed by the host session, not minted solely because someone GETs a bearer URL).

## Flow

```
agent finds product
        ↓
   request_spend   →  PENDING + locked cart
        ↓
Life Admin shows Approve / Reject [/ keep looking] card
        ↓
only the user’s tap  →  host decide with verified assertion
        ↓
   APPROVED | DENIED
        ↓
prepare_checkout_handoff (if approved) → locked checkoutUrl
```

`keep looking` is a product affordance (continue shopping). It is **not** a spend-state Approve. Prefer mapping it to no decision, or to an explicit human Deny if the product owner wants the 24h deny cooldown.

## `approveUrl` vs widget

`approveUrl` **may remain** for local smoke and non-Grokbot hosts. It is a **bearer capability**: whoever fetches/posts it can complete Approve/Deny. That is **not** human proof (audit N-1).

The Grokbot path **must not** rely on the agent opening or fetching `approveUrl`. The host widget is the decision UI.

| Surface | Approve UI | Human proof? |
| --- | --- | --- |
| Local wrangler / smoke | HMAC `GET /approve` bearer URL | No — URL possession is enough |
| Grokbot / Life Admin (this design) | Human-only chat widget | Yes — only the user’s tap, host-verified |
| Public Cursor marketplace (later) | Passkey / WebAuthn (or host session equivalent) | Yes — device/user binding; long-term N-1 fix |

## What this PR does not do

- No Grokbot widget implementation
- No passkey / WebAuthn
- No Revolut, no PAN
- No claim that “no decide MCP tool” makes `approveUrl` unusable by an agent

## Wording

- **True today:** there is no decide MCP tool. `applyDecision` requires `assertionVerified`. Raw `decidedBy` is rejected.
- **Not true:** `approveUrl` is human-proof, or “the agent cannot Approve” in an absolute sense while a bearer URL exists.

Use: *no decide MCP tool ≠ approveUrl is human-proof.*
