import {
  buildApprovalClaims,
  requireApprovalSecret,
  signApprovalJwt,
  signApproveTicket,
  verifyApproveTicket,
} from "./assertion.ts";
import { HostDecisionError } from "./errors.ts";
import { lockedCartFingerprint } from "./logic.ts";
import { publicBaseUrl } from "./public-url.ts";
import { spendStoreForTenant } from "./store.ts";
import type { LockedCart, SpendRequest } from "./types.ts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function buildApproveUrl(
  env: Env,
  spendRequestId: string,
  tenantId: string,
): Promise<string> {
  const base = publicBaseUrl(env);
  const url = new URL("/approve", `${base.replace(/\/$/, "")}/`);
  url.searchParams.set("spendRequestId", spendRequestId);
  url.searchParams.set("tenantId", tenantId);
  const secret = env.APPROVAL_HMAC_SECRET?.trim();
  if (secret) {
    url.searchParams.set(
      "mac",
      await signApproveTicket(secret, spendRequestId, tenantId),
    );
  }
  return url.toString();
}

function cartRows(cart: LockedCart): string {
  const shipping = cart.shipping
    ? [
        cart.shipping.name,
        cart.shipping.line1,
        cart.shipping.city,
        cart.shipping.postalCode,
        cart.shipping.country,
      ]
        .filter(Boolean)
        .join(", ")
    : "—";
  const rows: Array<[string, string]> = [
    ["Amount", `${cart.amount} ${cart.currency}`],
    ["Merchant", cart.merchantName],
    ["Domain", cart.merchantDomain],
    ["Checkout URL (money path)", cart.checkoutUrl],
    ["Shipping", shipping],
  ];
  return rows
    .map(
      ([label, value]) =>
        `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join("");
}

function htmlPage(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f4f4f5; color: #18181b; }
    main { max-width: 40rem; margin: 2rem auto; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 1.5rem 1.75rem; }
    h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
    .banner { background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 0.75rem 0.9rem; margin: 1rem 0; font-size: 0.95rem; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    th { text-align: left; width: 11rem; padding: 0.4rem 0.5rem 0.4rem 0; color: #52525b; font-weight: 600; vertical-align: top; }
    td { padding: 0.4rem 0; word-break: break-all; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
    button { font: inherit; font-weight: 650; border: 0; border-radius: 8px; padding: 0.7rem 1.1rem; cursor: pointer; }
    .approve { background: #16a34a; color: #fff; }
    .deny { background: #dc2626; color: #fff; }
    .muted { color: #71717a; font-size: 0.9rem; }
    code { font-size: 0.85em; }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    },
  });
}

function statusOnlyPage(request: SpendRequest): Response {
  return htmlPage(
    `Money Bot — ${request.status}`,
    `<h1>Spend is ${escapeHtml(request.status)}</h1>
     <p class="muted">Approve/Deny is only available while <code>PENDING</code>.</p>
     <table>${cartRows(request.lockedCart)}</table>
     <p class="muted">id <code>${escapeHtml(request.spendRequestId)}</code></p>`,
  );
}

export async function handleApprovePage(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const spendRequestId = url.searchParams.get("spendRequestId")?.trim() ?? "";
    const tenantId = url.searchParams.get("tenantId")?.trim() ?? "";
    const mac = url.searchParams.get("mac") ?? undefined;
    if (!spendRequestId || !tenantId) {
      throw new HostDecisionError(
        "approveUrl must include spendRequestId and tenantId.",
        400,
        "bad_approve_url",
      );
    }
    const secret = requireApprovalSecret(env.APPROVAL_HMAC_SECRET);
    await verifyApproveTicket(secret, spendRequestId, tenantId, mac);

    const store = spendStoreForTenant(env, tenantId);
    const loaded = await store.getForTenant(spendRequestId, tenantId);
    if (!loaded.ok) {
      throw new HostDecisionError(loaded.error, 404, "not_found");
    }
    const spend = loaded.value;
    if (spend.status !== "PENDING") {
      return statusOnlyPage(spend);
    }

    const fingerprint =
      spend.lockedCartFingerprint ?? lockedCartFingerprint(spend.lockedCart);

    const approveClaims = buildApprovalClaims({
      spendRequestId: spend.spendRequestId,
      tenantId: spend.tenantId,
      decision: "approved",
      lockedCartFingerprint: fingerprint,
    });
    const denyClaims = buildApprovalClaims({
      spendRequestId: spend.spendRequestId,
      tenantId: spend.tenantId,
      decision: "denied",
      lockedCartFingerprint: fingerprint,
    });
    const approveJwt = await signApprovalJwt(secret, approveClaims);
    const denyJwt = await signApprovalJwt(secret, denyClaims);

    return htmlPage(
      "Money Bot — Approve spend",
      `<h1>Approve this spend?</h1>
       <p class="banner">This is <strong>local HMAC-signed browser Approve</strong>, not passkey/WebAuthn.
       The shopping agent must not click these buttons. There is no agent decide tool.</p>
       <table>
         <tr><th>Spend id</th><td><code>${escapeHtml(spend.spendRequestId)}</code></td></tr>
         <tr><th>Expires</th><td>${escapeHtml(spend.expiresAt)}</td></tr>
         ${cartRows(spend.lockedCart)}
       </table>
       <div class="actions">
         <form method="post" action="/host/spend-decision">
           <input type="hidden" name="assertion" id="approve-assertion" value="${escapeHtml(approveJwt)}">
           <button class="approve" type="submit" name="decision" value="approved">Approve</button>
         </form>
         <form method="post" action="/host/spend-decision">
           <input type="hidden" name="assertion" id="deny-assertion" value="${escapeHtml(denyJwt)}">
           <button class="deny" type="submit" name="decision" value="denied">Deny</button>
         </form>
       </div>
       <p class="muted">Each button posts a <em>server-minted</em> signed assertion. Body <code>tenantId</code> / <code>decidedBy</code> are ignored.</p>`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load approve page.";
    const status = error instanceof HostDecisionError ? error.status : 400;
    return htmlPage(
      "Money Bot — Approve error",
      `<h1>Cannot open Approve</h1><p>${escapeHtml(message)}</p>`,
      status,
    );
  }
}
