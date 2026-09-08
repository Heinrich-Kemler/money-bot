import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyCheckoutOutcome,
  applyDecision,
  applyTenantReauth,
  createPendingSpendRequest,
  defaultTenantConnection,
  diffLockedCart,
  editSpendCap,
  findLockedCartMismatch,
  isRetryOfDenied,
  maybeExpire,
  merchantDomainFromUrl,
  prepareHandoff,
  refreshTenantConnection,
  resumeAfterReauth,
  SpendError,
  toRequestSpendResult,
} from "./logic.ts";
import { REVOLUT_RECONSENT_MS } from "./types.ts";
import { redactPaymentSecrets } from "./sanitize.ts";
import type { SpendRequest } from "./types.ts";

const input = {
  merchantName: "Example Shop",
  merchantUrl: "https://shop.example",
  amount: 12.5,
  currency: "GBP" as const,
  checkoutUrl: "https://shop.example/checkout",
  shipping: { country: "GB", postalCode: "SW1A 1AA" },
};

function pending(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    ...createPendingSpendRequest(input, "user-1"),
    ...overrides,
  };
}

describe("request_spend result", () => {
  it("returns PENDING with a locked-cart snapshot and no credentials", () => {
    const created = createPendingSpendRequest(input, "user-1");
    const result = toRequestSpendResult(created);
    assert.equal(result.status, "PENDING");
    assert.equal(result.merchantName, "Example Shop");
    assert.equal(result.amount, 12.5);
    assert.equal(result.currency, "GBP");
    assert.equal(result.lockedCart.merchantDomain, "shop.example");
    assert.equal(result.lockedCart.shipping?.postalCode, "SW1A 1AA");
    assert.ok(result.spendRequestId.startsWith("sr_"));
    assert.equal("checkoutUrl" in result, false);
  });
});

describe("deny is final", () => {
  it("rejects a second decision on a DENIED request", () => {
    const denied = applyDecision(pending(), "denied", {
      decidedBy: "human",
      denyReason: "too expensive",
    });
    assert.equal(denied.status, "DENIED");
    assert.throws(
      () => applyDecision(denied, "approved"),
      (error: unknown) =>
        error instanceof SpendError && /Deny is final/.test(error.message),
    );
  });

  it("blocks retry spam for the same merchant, amount, and currency", () => {
    const denied = applyDecision(pending(), "denied", { decidedBy: "human" });
    const retry = isRetryOfDenied([denied], {
      merchantUrl: input.merchantUrl,
      amount: input.amount,
      currency: input.currency,
    });
    assert.equal(retry?.spendRequestId, denied.spendRequestId);
  });
});

describe("cart lock at approval", () => {
  it("normalizes merchant domain", () => {
    assert.equal(
      merchantDomainFromUrl("https://www.Shop.Example/cart"),
      "shop.example",
    );
  });

  it("treats amount / merchant / domain / shipping mismatch as a new PENDING diff", () => {
    const approved = applyDecision(pending(), "approved", { decidedBy: "human" });
    const nextCart = {
      amount: 18,
      currency: "GBP" as const,
      merchantName: "Example Shop",
      merchantDomain: "shop.example",
      shipping: { country: "GB", postalCode: "EC1A 1BB" },
    };
    const mismatch = findLockedCartMismatch([approved], nextCart);
    assert.ok(mismatch);
    assert.deepEqual(mismatch.diff.fields.sort(), ["amount", "shipping"].sort());
    const replacement = createPendingSpendRequest(
      { ...input, amount: 18, shipping: nextCart.shipping },
      "user-1",
      {
        supersededSpendRequestId: approved.spendRequestId,
        cartDiff: mismatch.diff,
      },
    );
    assert.equal(replacement.status, "PENDING");
    assert.equal(replacement.supersededSpendRequestId, approved.spendRequestId);
    assert.ok(replacement.cartDiff);
  });

  it("does not treat an identical locked cart as a mismatch", () => {
    const approved = applyDecision(pending(), "approved", { decidedBy: "human" });
    assert.equal(
      findLockedCartMismatch([approved], approved.lockedCart),
      undefined,
    );
    assert.equal(
      diffLockedCart(approved.lockedCart, approved.lockedCart),
      undefined,
    );
  });
});

describe("edit spend cap", () => {
  it("updates cap on PENDING and never auto-approves", () => {
    const next = editSpendCap(pending(), 20);
    assert.equal(next.status, "PENDING");
    assert.equal(next.spendCap, 20);
  });

  it("refuses cap edits after APPROVED", () => {
    const approved = applyDecision(pending(), "approved", { decidedBy: "human" });
    assert.throws(
      () => editSpendCap(approved, 5),
      (error: unknown) =>
        error instanceof SpendError && /never grants approval/.test(error.message),
    );
  });
});

describe("prepare_checkout_handoff", () => {
  it("requires APPROVED or WAITING_FOR_YOU", () => {
    assert.throws(
      () => prepareHandoff(pending()),
      (error: unknown) =>
        error instanceof SpendError &&
        /APPROVED or WAITING_FOR_YOU/.test(error.message),
    );
  });

  it("moves APPROVED to WAITING_FOR_YOU with human handoff instructions", () => {
    const approved = applyDecision(pending(), "approved", { decidedBy: "human" });
    const { result } = prepareHandoff(approved);
    assert.equal(result.status, "WAITING_FOR_YOU");
    assert.equal(result.checkoutUrl, "https://shop.example/checkout");
    assert.match(result.handoffInstructions, /Apple Pay/);
    assert.match(result.handoffInstructions, /iOS 18/);
    assert.match(result.handoffInstructions, /Revolut Pay/);
    assert.equal("pan" in result, false);
    assert.equal("cvc" in result, false);
  });
});

describe("completion paths", () => {
  it("WAITING_FOR_YOU → CHALLENGE → PAID", () => {
    const approved = applyDecision(pending(), "approved", { decidedBy: "human" });
    const waiting = prepareHandoff(approved).request;
    const challenge = applyCheckoutOutcome(waiting, "CHALLENGE", {
      challengeKind: "revolut_3ds",
    });
    assert.equal(challenge.status, "CHALLENGE");
    assert.equal(challenge.challenge?.expectedMinutes, 5);
    const paid = applyCheckoutOutcome(challenge, "PAID", { orderId: "ord_1" });
    assert.equal(paid.status, "PAID");
    assert.equal(paid.orderId, "ord_1");
  });

  it("WAITING_FOR_YOU → FAILED", () => {
    const approved = applyDecision(pending(), "approved", { decidedBy: "human" });
    const waiting = prepareHandoff(approved).request;
    assert.equal(applyCheckoutOutcome(waiting, "FAILED").status, "FAILED");
  });
});

describe("expiry", () => {
  it("marks PENDING requests EXPIRED after expiresAt", () => {
    const request = pending({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(maybeExpire(request).status, "EXPIRED");
  });

  it("does not expire APPROVED on the pending TTL", () => {
    const approved = applyDecision(pending(), "approved", { decidedBy: "human" });
    const aged = { ...approved, expiresAt: new Date(Date.now() - 1000).toISOString() };
    assert.equal(maybeExpire(aged).status, "APPROVED");
  });
});

describe("out-of-band approve", () => {
  it("rejects decidedBy=agent", () => {
    assert.throws(
      () => applyDecision(pending(), "approved", { decidedBy: "agent" }),
      (error: unknown) =>
        error instanceof SpendError && /cannot Approve/.test(error.message),
    );
  });
});

describe("REAUTH_REQUIRED", () => {
  it("defaults v0 tenants to NOT_CONNECTED (Revolut optional)", () => {
    const tenant = defaultTenantConnection("user-1");
    assert.equal(tenant.status, "NOT_CONNECTED");
    assert.equal(tenant.revolutConnected, false);
    assert.equal(pending().requiresTenantConnection, false);
  });

  it("marks CONNECTED tenants REAUTH_REQUIRED after 90 days", () => {
    const connected = refreshTenantConnection({
      tenantId: "user-1",
      status: "CONNECTED",
      revolutConnected: true,
      connectedAt: new Date(Date.now() - REVOLUT_RECONSENT_MS - 1000).toISOString(),
      consentExpiresAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.equal(connected.status, "REAUTH_REQUIRED");
  });

  it("pauses only v1-bound spends when the tenant needs re-consent", () => {
    const tenant: ReturnType<typeof defaultTenantConnection> = {
      ...defaultTenantConnection("user-1"),
      status: "REAUTH_REQUIRED",
      revolutConnected: true,
      consentExpiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    const v0 = applyTenantReauth(pending(), tenant);
    assert.equal(v0.status, "PENDING");
    const v1 = applyTenantReauth(
      { ...pending(), requiresTenantConnection: true },
      tenant,
    );
    assert.equal(v1.status, "REAUTH_REQUIRED");
    assert.equal(v1.statusBeforeReauth, "PENDING");
    assert.throws(
      () => resumeAfterReauth(v1, tenant),
      (error: unknown) =>
        error instanceof SpendError && /wizard/.test(error.message),
    );
  });
});

describe("sanitizer", () => {
  it("strips PAN-like fields from tool payloads", () => {
    const redacted = redactPaymentSecrets({
      status: "WAITING_FOR_YOU",
      pan: "4111111111111111",
      cvc: "123",
      note: "card 4111111111111111 leaked",
    });
    assert.equal("pan" in redacted, false);
    assert.equal("cvc" in redacted, false);
    assert.match(redacted.note, /REDACTED/);
  });
});
