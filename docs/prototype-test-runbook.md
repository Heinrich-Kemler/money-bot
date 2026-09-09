# Money Bot — real-money prototype test runbook

Date: 2026-09-09
Applies to: `main` at `7b90572` plus the MCP auth-header change in this PR.
Audience: whoever runs the first real purchase through the Cursor plugin.

---

## 1. What you are actually testing

Money Bot v0 **does not pay for anything.** It does three things:

1. Takes a spend request from the agent (`request_spend`) and locks the cart: amount, merchant, domain, checkout URL, shipping.
2. Waits for a human to Approve or Deny on a page the agent cannot legitimately press (`/approve`).
3. After Approve, hands the agent the locked checkout URL (`prepare_checkout_handoff`). **You** open that URL and pay with your own card, Apple Pay, or whatever the merchant offers.

So the real-money test is: agent requests, you approve, you pay on the merchant's own checkout, and Money Bot's record shows `WAITING_FOR_YOU`. That is the whole v0 loop. There is no virtual card, no Revolut, and no `PAID` record yet (`POST /host/checkout-outcome` is still 501, tracked in issue #5).

If the goal tonight was "the plugin pays with its own card", that is v1 and is not built. Nothing in the repo can do it, and it should not be attempted before the passkey approve path exists.

---

## 2. Readiness: what was verified today

On a clean Linux checkout of `main` at `7b90572`:

| Check | Result |
| --- | --- |
| `npm ci` / `npm run type-check` | pass |
| `npm test` | 67/67 pass |
| `wrangler deploy --dry-run` | bundles, bindings resolve |
| `./scripts/smoke-approve.sh` (browser approve path) | `PENDING` → `APPROVED` → `WAITING_FOR_YOU` |
| `./scripts/smoke-widget-approve.sh` (Life Admin host path) | `PENDING` → `APPROVED` → `WAITING_FOR_YOU` |
| Unauthenticated MCP `initialize` | 401 (fixed since audit 2) |
| Real merchant URLs through `request_spend` | see table below |

Merchant URL probe (live, against the dev server):

| Merchant | `merchantUrl` host | `checkoutUrl` host | Result |
| --- | --- | --- | --- |
| Amazon UK | `www.amazon.co.uk` | `www.amazon.co.uk` | **accepted** |
| Argos | `www.argos.co.uk` | `www.argos.co.uk` | **accepted** |
| Amazon DE (EUR) | `www.amazon.de` | `www.amazon.de` | **accepted** |
| Shopify store on own domain | `myshop.co.uk` | `myshop.co.uk/checkouts/…` | **accepted** |
| Shopify hosted checkout | `myshop.co.uk` | `checkout.shopify.com` | rejected (host mismatch) |
| eBay UK | `www.ebay.co.uk` | `pay.ebay.co.uk` | rejected (host mismatch) |
| Amazon US (USD) | `www.amazon.com` | | rejected (currency) |
| Allegro (PLN) | `allegro.pl` | | rejected until PR #12 merges |

**Pick a merchant from the accepted rows.** Amazon UK is the safest first test: cart and checkout stay on `www.amazon.co.uk`, GBP, and you can buy something for a few pounds.

---

## 3. The one configuration that works today

**Run the Worker locally on the same machine as Cursor.** A deployed Worker cannot serve the plugin yet: production has no identity provider, so every MCP call fails closed with 401 (issue #4). Do not deploy for this test.

Locally, identity comes from `ALLOW_TEST_AUTH=true` plus `ENVIRONMENT=development` in `.dev.vars`, and the client sends `Authorization: Bearer test:<your-user-id>`. Before this PR the plugin's `mcp.json` sent no header at all, so the plugin could not connect even locally. This PR adds a `MONEY_BOT_MCP_AUTH` variable that becomes that header.

---

## 4. Setup (about 15 minutes)

Prerequisites: Node 22.6 or newer (the test runner uses `--experimental-strip-types`), npm, Cursor 2.x, a browser logged in to the merchant, and a card you are willing to use.

```bash
git clone https://github.com/Heinrich-Kemler/money-bot
cd money-bot
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and replace the two placeholder secrets with random values (the placeholders pass the length check, so nothing forces you to, but do it anyway):

```bash
# generate two random secrets
openssl rand -hex 32   # -> APPROVAL_HMAC_SECRET
openssl rand -hex 32   # -> HOST_API_TOKEN
```

Leave `ALLOW_TEST_AUTH=true`, `ENVIRONMENT=development`, and `PUBLIC_BASE_URL=http://localhost:8787` as they are.

Start the Worker and keep this terminal open:

```bash
npm start
```

Sanity check in a second terminal:

```bash
curl -s http://localhost:8787/ | head -5      # JSON with "name": "Money Bot"
./scripts/smoke-approve.sh                     # ends with "smoke-approve: ok"
```

If the smoke passes, the Worker, the approve page, and the handoff all work on your machine.

### Connect Cursor

Option A, install the plugin from the repo folder and fill in the two variables when Cursor asks:

| Variable | Value |
| --- | --- |
| `MONEY_BOT_MCP_URL` | `http://localhost:8787/mcp` |
| `MONEY_BOT_MCP_AUTH` | `Bearer test:stas` (any id matching `[A-Za-z0-9_.:@-]`, not `anonymous`) |

Option B, skip the plugin and add the server to `~/.cursor/mcp.json` directly:

```json
{
  "mcpServers": {
    "money-bot": {
      "url": "http://localhost:8787/mcp",
      "headers": {
        "Authorization": "Bearer test:stas"
      }
    }
  }
}
```

Then open Cursor's MCP settings and confirm `money-bot` shows exactly three tools: `request_spend`, `get_spend_status`, `prepare_checkout_handoff`. If it shows an error, see Troubleshooting.

Also paste the contents of `skills/money-bot/SKILL.md` into the agent's rules for the session (or install the plugin, which ships the skill). The skill is what tells the agent not to fetch `approveUrl` itself.

---

## 5. The purchase (about 10 minutes)

1. **Build the cart yourself** in your browser. For Amazon UK: add a cheap item, open the cart at `https://www.amazon.co.uk/gp/cart/view.html`, click "Proceed to checkout", and copy the checkout page URL (it starts with `https://www.amazon.co.uk/gp/buy/…`). Note the order total.

2. **Ask the agent** in Cursor. A prompt that works with the current skill:

   > Use Money Bot to request approval for a purchase.
   > merchantName: Amazon.co.uk
   > merchantUrl: https://www.amazon.co.uk/gp/cart/view.html
   > checkoutUrl: <paste the checkout URL>
   > amount: <total>  currency: GBP
   > After request_spend, show me the approveUrl and wait. Do not open it yourself. Poll get_spend_status every 20 seconds until it is APPROVED, then call prepare_checkout_handoff and give me the checkoutUrl.

3. **Open `approveUrl`** in your browser (it points at `http://localhost:8787/approve?…`). Check the locked cart: amount, merchant, domain, checkout URL. Click **Approve**. Do not click Deny unless you mean it (see Troubleshooting).

4. The agent's next `get_spend_status` returns `APPROVED`. It calls `prepare_checkout_handoff` and returns the locked `checkoutUrl` with `moneyPath: true`.

5. **Open that URL and pay** on Amazon with your own card or Apple Pay. If 3-D Secure appears, complete it in the browser. Money Bot is not involved in this step at all.

6. Money Bot's record stays `WAITING_FOR_YOU`. That is expected: there is no outcome path yet. Note the order id yourself.

What "success" looks like:

| Step | Expected |
| --- | --- |
| `request_spend` | `status: "PENDING"`, `approveUrl` present, `lockedCart.merchantDomain: "amazon.co.uk"` |
| `/approve` page | shows the same amount and checkout URL you gave |
| after Approve | `get_spend_status` → `APPROVED`, `decidedBy: "oob-assertion"` |
| `prepare_checkout_handoff` | `status: "WAITING_FOR_YOU"`, `checkoutUrl` identical to what you gave |
| merchant | order placed with your own payment method |

---

## 6. Things to watch during the test

- **The agent can technically open `approveUrl` itself** (audit 2, N-1, still open). If the status jumps to `APPROVED` before you clicked anything, the agent did it. Stop and report that; it is the P0 the passkey work is meant to close.
- **Deny is expensive.** Clicking Deny puts that merchant domain plus any amount within 0.50 into a 24-hour cooldown. To retry after a Deny, change the amount by more than 0.50 or wait.
- **Pending expires after 30 minutes.** Expiry no longer triggers the cooldown; just ask the agent to `request_spend` again.
- **The approve page does not show line items or description**, only amount, merchant, domain, checkout URL, and shipping. Check the amount against your cart yourself.
- **Two spends at the same merchant** replace each other; a second request at a different merchant now leaves the first alone (fixed since audit 2).

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Cursor shows the server but tool calls return `401 unauthenticated` | no `Authorization` header reaching the Worker | set `MONEY_BOT_MCP_AUTH` or the `headers` block; value must start with `Bearer test:` |
| Worker returns 500 `allow_test_auth_forbidden_in_production` | `.dev.vars` missing `ENVIRONMENT=development` | copy `.dev.vars.example` again |
| `Unsupported merchant domain` | TLD not in the UK/EU allowlist (`.com` fails) | use a `.co.uk`, `.de`, `.fr`, … merchant |
| `checkoutUrl host … must match locked merchantDomain` | checkout on a different host (Shopify, eBay, PSP) | pick a merchant whose checkout stays on its own host |
| `Invalid option: expected one of "GBP"\|"EUR"` | currency not supported | GBP or EUR; PLN needs PR #12 |
| `Deny is final for sr_…` | cooldown from an earlier Deny | change amount by more than 0.50 or wait 24h |
| `approveUrl` opens a 403 `bad_approve_ticket` | `APPROVAL_HMAC_SECRET` changed after the spend was created | restart and request again |
| `APPROVAL_HMAC_SECRET is not configured` | secret shorter than 16 chars | use the `openssl` command above |
| Cursor cannot reach `localhost:8787` | Worker not running, or Cursor on another machine | `npm start` on the same machine |

---

## 8. Costs

### Tonight

| Item | Cost |
| --- | --- |
| Infrastructure | £0. Everything runs on your laptop under `wrangler dev`. |
| Cloudflare account | Not needed for the local test. |
| The purchase | Whatever you buy. Suggest £2 to £5. Money Bot adds no fee and never touches the payment. |

### Running a deployed prototype later

Cloudflare Workers plus two SQLite-backed Durable Objects is the whole stack. Figures below are from Cloudflare's published pricing as summarised at the time of writing; confirm on the linked pages before relying on them.

| Plan | Price | Included | Verdict for Money Bot |
| --- | --- | --- | --- |
| Workers Free | $0 | 100,000 requests/day, 10 ms CPU per invocation; SQLite Durable Objects: 100,000 requests/day, 13,000 GB-s/day, 5 M rows read/day, 100,000 rows written/day, 5 GB storage | Enough for personal use and a small group. A spend flow is roughly 10 to 20 requests. |
| Workers Paid | $5/month | 10 M requests/month, 30 M CPU-ms; Durable Objects: 1 M requests/month then $0.15 per M, 400,000 GB-s then $12.50 per M GB-s; SQLite rows: 25 B read and 50 M written included | Only needed for headroom, or if you want the key-value Durable Object backend. |
| `workers.dev` subdomain | $0 | | Fine for a prototype. |
| Custom domain | ~£10/year from a registrar | | Optional. |

Realistic monthly bill for a handful of users: **$0 on Free, $5 on Paid.** Durable Object storage will not become a cost until issue #6 (pruning) matters at scale.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

### Not needed now

- **Revolut Business** (v1 virtual cards): not built, not required for this test. Do not open an account for it yet.
- **Cursor marketplace listing**: free, manual review. Not required for a local test.
- **Passkey / WebAuthn provider**: not built. Cloudflare's own WebAuthn support inside a Worker needs no third-party service, so expect $0 in infrastructure when it is.

### Development spend so far

Not visible from the repository. The work landed through Cursor background agents and Claude Code sessions; those bills sit in the respective accounts, not here.

---

## 9. After the test

Record, for each run: spend id, merchant, amount, who clicked Approve, order id, and whether the agent ever touched `approveUrl`. That is the audit trail the repo does not keep yet. Then the next engineering steps, in order, are unchanged from audit 2: passkey approve (N-1), production identity (#4), outcome path (#5), CI.
